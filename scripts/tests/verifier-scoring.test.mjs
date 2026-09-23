// The verifier prompt protocol, score-tag parsing over a mocked provider, effort
// fields, feedback gating math, the durable feedback counter, and the divergence
// guard.
//
// Part of the offline regression suite: `npm test` runs every scripts/tests/*.test.mjs
// in its own process; this file also runs alone with `node --test scripts/tests/verifier-scoring.test.mjs`.

import test from "node:test"
import assert from "node:assert/strict"
import { feedbackSentCount } from "../../lib/index.js"
import { buildVerifierPrompt, verifyRoute, verifierEffortFields, shouldRequestFeedback, decideFeedback } from "../../lib/verifier.js"
import { LF } from "./helpers/harness.mjs"
import { scorePositions, testConfig, testCredentials } from "./helpers/provider.mjs"

function mockFetch(body) {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => body })
  return () => { globalThis.fetch = original }
}

const guardConfig = Object.assign({}, testConfig, { divergenceGuard: true, divergenceGuardMedian: 0.75 })

function aggregateOf(pairs) {
  const valid = pairs.map(([score, finding], i) => ({ ok: true, route: i + 1, score, baseline: 0.1, finding }))
  const sorted = valid.map(v => v.score).sort((a, b) => a - b)
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length
  const median = sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
  const dispersion = Math.sqrt(sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / sorted.length)
  return { results: [], valid, mean, median, dispersion, score: mean, baseline: 0.1, confidence: "low" }
}

const c1Outlier = [
  [1, "no concrete defect found"],
  [0.6, "No concrete evidence that fetchJSON implements exponential backoff."],
  [1, "no concrete defect found"],
  [1, "no concrete defect found"],
  [1, "no concrete defect found"],
]

// ---------- verifier prompt protocol ----------

test("prompt pins the single-letter protocol and rejects the literal placeholder", () => {
  const prompt = buildVerifierPrompt("task", "trace", "criterion")
  assert.ok(prompt.includes("never output the literal placeholder"))
  assert.ok(prompt.includes("<score_A> X </score_A>"))
  assert.ok(prompt.includes("<score_B> X </score_B>"))
  assert.ok(prompt.includes("untrusted evidence"), "trajectory must be marked untrusted")
  // 2026-08-28 实测 lane 幻觉：trace 尾部明明有最终答复/工具结果，lane 仍声称缺失。
  assert.ok(prompt.includes("never claim the agent used no tools"), "tool presence must block absence claims")
  assert.ok(prompt.includes("[... trajectory tail ...]"), "absence claims must require a tail scan")
})

test("overlong traces are clamped with an explicit truncation marker", () => {
  const prompt = buildVerifierPrompt("task", "t".repeat(20000), "criterion")
  assert.ok(prompt.includes("[truncated]"))
  assert.ok(prompt.length < 30000)
})

// ---------- score protocol parsing (mocked provider) ----------

test("well-formed route parses score labels, lane, and finding from logprobs", async () => {
  const restore = mockFetch({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: ["Analysis.", "finding: tests were never run", "<score_A> K </score_A>", "<score_B> M </score_B>"].join(LF) }, logprobs: { content: scorePositions() } }] })
  try {
    const result = await verifyRoute(testConfig, testCredentials, "prompt", 1)
    assert.equal(result.ok, true)
    assert.ok(result.score > 0 && result.score < 1)
    assert.equal(result.scoreALabel, "K")
    assert.equal(result.scoreBLabel, "M")
    assert.equal(result.lane, "completion")
    assert.equal(result.finding, "tests were never run")
    assert.equal(result.reasoningSource, "content")
  } finally { restore() }
})

test("literal A-T placeholder tags are rejected as malformed, never scored", async () => {
  const restore = mockFetch({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: ["<score_A> A-T </score_A>", "<score_B> A-T </score_B>"].join(LF) }, logprobs: { content: scorePositions() } }] })
  try {
    const result = await verifyRoute(testConfig, testCredentials, "prompt", 2)
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, "malformed_score_tags")
  } finally { restore() }
})

test("truncated score tags are rejected as malformed", async () => {
  const restore = mockFetch({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: ["analysis <score_A> K </score_A>", "<score_B> M"].join(LF) }, logprobs: { content: [] } }] })
  try {
    const result = await verifyRoute(testConfig, testCredentials, "prompt", 3)
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, "malformed_score_tags")
  } finally { restore() }
})

test("non-stop finishes remain invalid (incomplete_response)", async () => {
  const restore = mockFetch({ choices: [{ finish_reason: "length", message: { role: "assistant", content: "<score_A> K </score_A>" + LF + "<score_B> M </score_B>" }, logprobs: { content: scorePositions() } }] })
  try {
    const result = await verifyRoute(testConfig, testCredentials, "prompt", 4)
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, "incomplete_response")
  } finally { restore() }
})

test("tags parsed without token logprobs are rejected by default (missing_score_logprobs)", async () => {
  const restore = mockFetch({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "<score_A> K </score_A>" + LF + "<score_B> M </score_B>" } }] })
  try {
    const result = await verifyRoute(testConfig, testCredentials, "prompt", 5)
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, "missing_score_logprobs")
  } finally { restore() }
})

test("scores embedded only in reasoning_content are recovered with its logprobs", async () => {
  const restore = mockFetch({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "", reasoning_content: "<score_A> K </score_A>" + LF + "<score_B> M </score_B>" }, logprobs: { content: [], reasoning_content: scorePositions() } }] })
  try {
    const result = await verifyRoute(testConfig, testCredentials, "prompt", 1)
    assert.equal(result.ok, true)
    assert.equal(result.reasoningSource, "reasoning_content")
  } finally { restore() }
})

test("allowLabelFallback accepts explicit letters with degraded scoreSource", async () => {
  const restore = mockFetch({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "<score_A> K </score_A>" + LF + "<score_B> M </score_B>" } }] })
  try {
    const result = await verifyRoute(Object.assign({}, testConfig, { allowLabelFallback: true }), testCredentials, "prompt", 1)
    assert.equal(result.ok, true)
    assert.equal(result.scoreSource, "label")
    assert.equal(result.logprobs, false)
    assert.equal(result.scoreALabel, "K")
    assert.ok(result.score > 0 && result.score < 1)
  } finally { restore() }
})

test("allowLabelFallback still rejects malformed tags", async () => {
  const restore = mockFetch({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "<score_A> A-T </score_A>" + LF + "<score_B> A-T </score_B>" } }] })
  try {
    const result = await verifyRoute(Object.assign({}, testConfig, { allowLabelFallback: true }), testCredentials, "prompt", 2)
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, "malformed_score_tags")
  } finally { restore() }
})

test("verifier effort fields: off disables thinking, levels pass reasoning_effort, unset adds nothing", () => {
  assert.deepEqual(verifierEffortFields(undefined), {})
  assert.deepEqual(verifierEffortFields(null), {})
  assert.deepEqual(verifierEffortFields("bogus"), {}, "unknown efforts fall back to the historic payload")
  assert.deepEqual(verifierEffortFields("off"), { thinking: { type: "disabled" } })
  assert.deepEqual(verifierEffortFields("low"), { thinking: { type: "enabled" }, reasoning_effort: "low" })
  assert.deepEqual(verifierEffortFields("high"), { thinking: { type: "enabled" }, reasoning_effort: "high" })
  assert.deepEqual(verifierEffortFields("max"), { thinking: { type: "enabled" }, reasoning_effort: "max" })
})

test("over the wire: configured thinking effort reaches the lane request body", async () => {
  const bodies = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body))
    return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: ["analysis", "finding: probe", "<score_A> K </score_A>", "<score_B> M </score_B>"].join(LF) }, logprobs: { content: scorePositions() } }] }) }
  }
  try {
    const maxed = await verifyRoute(Object.assign({}, testConfig, { verifierEffort: "max" }), testCredentials, "prompt", 1)
    assert.equal(maxed.ok, true)
    assert.equal(bodies.at(-1).thinking.type, "enabled")
    assert.equal(bodies.at(-1).reasoning_effort, "max")
    const plain = await verifyRoute(Object.assign({}, testConfig), testCredentials, "prompt", 1)
    assert.equal(plain.ok, true)
    assert.ok(!("thinking" in bodies.at(-1)) && !("reasoning_effort" in bodies.at(-1)), "unset effort keeps the historic lane payload")
    const off = await verifyRoute(Object.assign({}, testConfig, { verifierEffort: "off" }), testCredentials, "prompt", 1)
    assert.equal(off.ok, true)
    assert.equal(bodies.at(-1).thinking.type, "disabled", "off IS a statement: thinking is explicitly disabled")
    assert.equal(bodies.at(-1).reasoning_effort, undefined)
  } finally { globalThis.fetch = original }
})

// ---------- feedback gating math ----------

test("shouldRequestFeedback requires enough valid routes, low score or high disagreement", () => {
  const base = { results: [], confidence: "low" }
  const validOf = scores => scores.map(score => ({ ok: true, score, baseline: 0.1 }))
  assert.equal(shouldRequestFeedback(Object.assign({}, base, { valid: validOf([0.3, 0.35]), score: 0.32, dispersion: 0.03 }), testConfig), false, "too few valid routes")
  assert.equal(shouldRequestFeedback(Object.assign({}, base, { valid: [], score: null, dispersion: null }), testConfig), false, "no usable score")
  assert.equal(shouldRequestFeedback(Object.assign({}, base, { valid: validOf([0.4, 0.41, 0.39]), score: 0.4, dispersion: 0.01 }), testConfig), true, "low mean triggers")
  assert.equal(shouldRequestFeedback(Object.assign({}, base, { valid: validOf([0.95, 0.55, 0.9]), score: 0.8, dispersion: 0.22 }), testConfig), true, "high dispersion triggers")
  assert.equal(shouldRequestFeedback(Object.assign({}, base, { valid: validOf([0.9, 0.92, 0.88]), score: 0.9, dispersion: 0.02 }), testConfig), false, "healthy result stays quiet")
})

// ---------- durable feedback counter (direction C) ----------

test("feedbackSentCount derives the delivered-feedback count from session events", () => {
  const events = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: { content: "do the thing" } },
    { type: "turn/end", seq: 9, data: { turn: 1 } },
    { type: "user/message", seq: 10, data: { content: [{ type: "text", text: "[Verifier feedback] 平均完成度 0.40, 分歧 0.49。" }] } },
    { type: "tool/result", seq: 11, data: { message: "[Verifier feedback] lookalike inside a tool output" } },
    { type: "assistant/message", seq: 12, data: { message: { content: "[Verifier feedback] quoted in prose" } } },
    { type: "turn/end", seq: 20, data: { turn: 2 } },
  ]
  assert.equal(feedbackSentCount(events), 1, "only real feedback user-messages count")
  assert.equal(feedbackSentCount(events.slice()), feedbackSentCount(events), "pure function of the durable log: same events, same count after reload")
})

// ---------- divergence-trigger guard (2026-08-25 eight-round eval baseline) ----------

test("divergence guard blocks a single-lane outlier when median is perfect and majority findings are no-defect", () => {
  // mirrors the observed C1 pattern (labels A M A A A): dispersion branch fires, but
  // the median holds at 1.0 and 4/5 lanes report no defect -> pure sampling noise.
  const r = aggregateOf(c1Outlier)
  assert.ok(r.dispersion > 0.12, "fixture must actually trip the disagreement branch")
  assert.equal(decideFeedback(r, guardConfig).feedback, false, "guard must suppress single-lane noise")
  assert.equal(decideFeedback(r, guardConfig).guarded, true, "suppression must be visible as guarded")
})

test("guard does not fire when a majority of findings report real defects", () => {
  const r = aggregateOf([
    [1, "tests were never run"],
    [0.6, "build output was fabricated"],
    [1, "requirements only partially met"],
    [1, "no concrete defect found"],
    [1, "no concrete defect found"],
  ])
  const d = decideFeedback(r, guardConfig)
  assert.equal(d.feedback, true)
  assert.equal(d.guarded, false)
})

test("guard does not fire when the median sits below the configured threshold", () => {
  const r = aggregateOf([
    [0.9, "no concrete defect found"],
    [0.4, "broken edge case"],
    [0.5, "no concrete defect found"],
    [0.55, "missing input validation"],
    [0.45, "no concrete defect found"],
  ])
  assert.ok(r.median < 0.75 && shouldRequestFeedback(r, guardConfig), "genuinely mixed verdicts still trigger")
})

test("low-mean branch is also subject to the guard when the consensus median stays high", () => {
  // T T A A A style polarization: two strong outliers drag the mean under the
  // threshold while the median holds at 1.0 and the majority stays clean.
  const r = aggregateOf([
    [0, "No evidence of retry logic."],
    [0, "No evidence of retry logic."],
    [1, "no concrete defect found"],
    [1, "no concrete defect found"],
    [1, "no concrete defect found"],
  ])
  assert.ok(r.mean < 0.62, "fixture must trip the low-mean branch")
  assert.equal(decideFeedback(r, guardConfig).guarded, true)
})

test("disabling the guard restores raw trigger behavior", () => {
  const r = aggregateOf(c1Outlier)
  assert.equal(decideFeedback(r, Object.assign({}, testConfig, { divergenceGuard: false })).feedback, true)
})

test("quiet results never report guarded", () => {
  const d = decideFeedback(aggregateOf([[1, "no concrete defect found"], [1, "no concrete defect found"], [1, "no concrete defect found"]]), guardConfig)
  assert.deepEqual(d, { feedback: false, guarded: false })
})

test("legacy configs without guard keys keep the old predicate (guard off)", () => {
  const r = aggregateOf(c1Outlier)
  assert.equal(shouldRequestFeedback(r, testConfig), true, "missing divergenceGuard must not silently enable the guard")
})

test("phase0: score tags recovered from reasoning_content use reasoning positions even when content logprobs exist", async () => {
  const prosePositions = ["Reason", "ing", " about", " evidence"].map(token => ({ token, top_logprobs: [{ token: token.trim(), logprob: Math.log(0.9) }] }))
  const restore = mockFetch({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Reasoning about evidence.", reasoning_content: "<score_A> K </score_A>" + LF + "<score_B> M </score_B>" }, logprobs: { content: prosePositions, reasoning_content: scorePositions() } }] })
  try {
    const result = await verifyRoute(testConfig, testCredentials, "prompt", 1)
    assert.equal(result.ok, true, "a valid strict route must not be rejected because content logprobs shadowed reasoning positions")
    assert.equal(result.reasoningSource, "reasoning_content")
    assert.equal(result.scoreSource, "logprobs")
  } finally { restore() }
})

test("settlement notices never consume the session's verifier feedback quota", async () => {
  const ev = [{ type: "user/message", data: { source: { kind: "plugin", plugin: "@dsh-external/dsh-verifier-autopilot/selection", form: "notice" }, content: [{ type: "text", text: "[Selection 结算] sel-x 已完成" }] } }]
  assert.equal(feedbackSentCount(ev), 0, "selection notices are not verifier feedback")
})
