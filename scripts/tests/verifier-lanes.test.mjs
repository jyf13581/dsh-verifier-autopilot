// Lane execution policy: transient-error retry taxonomy, secret redaction on
// egress, unusable base URLs, worker counts, layered small-model lanes, and
// dispatch smoothing.
//
// Part of the offline regression suite: `npm test` runs every scripts/tests/*.test.mjs
// in its own process; this file also runs alone with `node --test scripts/tests/verifier-lanes.test.mjs`.

import test from "node:test"
import assert from "node:assert/strict"
import { verifyRoute } from "../../lib/verifier.js"
import { scorePositions, successBody, testConfig, testCredentials } from "./helpers/provider.mjs"
import { LF } from "./helpers/harness.mjs"

function mockFetchSequence(responses) {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    const response = responses[Math.min(calls, responses.length - 1)]
    calls += 1
    if (response instanceof Error) throw response
    if (typeof response === "number") return { ok: false, status: response, json: async () => ({ error: { message: "relay hiccup " + response } }) }
    return { ok: true, status: 200, json: async () => response }
  }
  return { restore: () => { globalThis.fetch = original }, get calls() { return calls } }
}

function laneSuccessResponseBody() {
  return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: ["Analysis.", "finding: no concrete defect found", "<score_A> K </score_A>", "<score_B> M </score_B>"].join(LF) }, logprobs: { content: scorePositions() } }] }
}

// ---------- single transient-error retry per lane (direction F) ----------

test("a lane that hits a transient provider error is retried once and recovers", async () => {
  const mock = mockFetchSequence([502, successBody])
  try {
    const result = await verifyRoute(testConfig, testCredentials, "prompt", 2)
    assert.equal(result.ok, true)
    assert.equal(result.retried, true)
    assert.equal(mock.calls, 2, "exactly one follow-up request after the transient failure")
  } finally { mock.restore() }
})

test("a lane that fails twice keeps its final error and marks retried", async () => {
  const mock = mockFetchSequence([502, 503])
  try {
    const result = await verifyRoute(testConfig, testCredentials, "prompt", 3)
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, "provider_error")
    assert.equal(result.retried, true)
    assert.equal(mock.calls, 2)
  } finally { mock.restore() }
})

test("protocol failures are not retried", async () => {
  const malformed = { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "<score_A> K </score_A>" + LF + "<score_B> M" }, logprobs: { content: [] } }] }
  const mock = mockFetchSequence([malformed])
  try {
    const result = await verifyRoute(testConfig, testCredentials, "prompt", 4)
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, "malformed_score_tags")
    assert.equal(result.retried, undefined)
    assert.equal(mock.calls, 1, "same-seed resample would reproduce a protocol failure; never retry it")
  } finally { mock.restore() }
})

test("timeouts count as transient and are retried once", async () => {
  const mock = mockFetchSequence([new Error("The operation was aborted due to timeout"), successBody])
  try {
    const result = await verifyRoute(testConfig, testCredentials, "prompt", 5)
    assert.equal(result.ok, true)
    assert.equal(result.retried, true)
    assert.equal(mock.calls, 2)
  } finally { mock.restore() }
})

test("phase0: permanent 4xx provider answers are not retried", async () => {
  const mock = mockFetchSequence([400, successBody])
  try {
    const result = await verifyRoute(testConfig, testCredentials, "prompt", 2)
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, "http_rejected", "permanent client errors need their own code outside the transient set")
    assert.equal(result.retried, undefined)
    assert.equal(mock.calls, 1, "same-request retries cannot fix a rejected model or auth")
  } finally { mock.restore() }
})

test("phase0: 429 rate limits stay transient and retry once", async () => {
  const mock = mockFetchSequence([429, successBody])
  try {
    const result = await verifyRoute(testConfig, testCredentials, "prompt", 3)
    assert.equal(result.ok, true)
    assert.equal(result.retried, true)
    assert.equal(mock.calls, 2)
  } finally { mock.restore() }
})

test("phase1: redactSecrets strips credentials from provider-bound text without touching normal lines", async () => {
  const { redactSecrets } = await import("../../lib/verifier.js")
  const literal = "sk-live-9f8e7d6c5b4a3210fedcba"
  const out = redactSecrets("export KIMI_API_KEY=" + literal + LF + "[E03] TOOL RESULT: pwsh npm test -> tests 5 passed", [literal])
  assert.ok(!out.includes(literal), "explicit credential literals must vanish")
  assert.ok(out.includes("[REDACTED]"))
  assert.ok(out.includes("[E03] TOOL RESULT: pwsh npm test -> tests 5 passed"), "normal trajectory lines survive verbatim")

  assert.ok(!redactSecrets("key sk-abcdef1234567890abcdef12").includes("sk-abcdef1234567890"), "openai-style keys are pattern-redacted")
  assert.ok(!redactSecrets("key sk-proj-9f8e7d6c5b4a3210").includes("sk-proj-"), "hyphenated key shapes are pattern-redacted too")
  assert.ok(redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4").includes("[REDACTED-JWT]"), "JWT bearers are redacted")
  assert.ok(redactSecrets("token=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6").endsWith("token=[REDACTED]"), "hex assignments are redacted with the label kept")
  assert.equal(redactSecrets('password="abcdefghijklmnop"'), 'password="[REDACTED]"', "quoted assignments redact the whole value without leaking its first character")
  assert.equal(redactSecrets('password="abcdefghijklmnop'), 'password="[REDACTED]', "an unterminated quote cannot bypass assignment redaction")
  assert.equal(redactSecrets("Bearer abcdefghijklmnop"), "Bearer [REDACTED]", "opaque bearer tokens are redacted even when they are not JWTs")
  assert.equal(redactSecrets("build: complete exit=0"), "build: complete exit=0", "benign operational text is untouched")
  assert.equal(redactSecrets("[EXTRACTED TOOL EVIDENCE] none"), "[EXTRACTED TOOL EVIDENCE] none")
})

test("phase1: lane requests leave the process without raw secrets in the outgoing body", async () => {
  const { verifyRoute } = await import("../../lib/verifier.js")
  const original = globalThis.fetch
  let captured = null
  globalThis.fetch = async (url, init) => {
    captured = init
    return { ok: true, status: 200, json: async () => successBody }
  }
  try {
    const secret = "sk-abcdef1234567890abcdef12"
    const result = await verifyRoute(testConfig, testCredentials, "trajectory mentions " + secret + " inline", 1)
    assert.equal(result.ok, true)
    assert.ok(captured && captured.body, "request body captured")
    const bodyText = String(captured.body)
    assert.ok(!bodyText.includes(secret), "raw secret must not reach the wire")
    assert.ok(bodyText.includes("[REDACTED-KEY]"), "redaction marker replaces it at the egress boundary")
  } finally { globalThis.fetch = original }
})

test("phase1: lanes fail fast with a non-transient error when the configured baseURL is unusable", async () => {
  const { verifyRoute } = await import("../../lib/verifier.js")
  const original = globalThis.fetch
  let fetchCalled = 0
  globalThis.fetch = async () => { fetchCalled += 1; throw new Error("fetch must not run") }
  try {
    const result = await verifyRoute({ ...testConfig, baseURL: "ftp://bad.example.com" }, testCredentials, "prompt", 1)
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, "invalid_base_url", "unusable egress target is its own non-transient code")
    assert.equal(result.retried, undefined)
    assert.equal(fetchCalled, 0, "no network attempt against an invalid scheme")
  } finally { globalThis.fetch = original }
})

// ---------- relay account-pool execution: concurrency, smoothing, tiering ----------

test("effectiveVerifierWorkers: 0=auto(4), explicit pass-through, clamp at 16", async () => {
  const { effectiveVerifierWorkers, AUTO_VERIFIER_WORKERS } = await import("../../lib/selection/host.js")
  assert.equal(AUTO_VERIFIER_WORKERS, 4)
  assert.equal(effectiveVerifierWorkers(undefined), 4, "undefined -> auto")
  assert.equal(effectiveVerifierWorkers(null), 4, "null -> auto")
  assert.equal(effectiveVerifierWorkers(0), 4, "0 -> auto")
  assert.equal(effectiveVerifierWorkers(-3), 4, "negative -> auto")
  assert.equal(effectiveVerifierWorkers(Number.NaN), 4, "NaN -> auto")
  assert.equal(effectiveVerifierWorkers(1), 1)
  assert.equal(effectiveVerifierWorkers(7), 7)
  assert.equal(effectiveVerifierWorkers(99), 16, "clamped to 16")
})

test("verifyFive: layered small model drives only the mechanical lanes (completion/evidence)", async () => {
  const { verifyFive } = await import("../../lib/verifier.js")
  const seen = []
  const original = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    seen.push(JSON.parse(String(init.body)).model)
    return { ok: true, status: 200, json: async () => laneSuccessResponseBody() }
  }
  try {
    const aggregate = await verifyFive(Object.assign({}, testConfig, { routes: 5, verifierSmallModel: "small/mock" }), testCredentials, "prompt")
    assert.equal(aggregate.valid.length, 5)
    assert.deepEqual(seen, ["small/mock", "mock", "mock", "small/mock", "mock"],
      "lane1 completion + lane4 evidence use the cheap tier; requirements/adversarial/repair stay on the main model")
  } finally { globalThis.fetch = original }
})

test("verifyFive: without verifierSmallModel every lane keeps the main model", async () => {
  const { verifyFive } = await import("../../lib/verifier.js")
  const seen = []
  const original = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    seen.push(JSON.parse(String(init.body)).model)
    return { ok: true, status: 200, json: async () => laneSuccessResponseBody() }
  }
  try {
    const aggregate = await verifyFive(Object.assign({}, testConfig, { routes: 5 }), testCredentials, "prompt")
    assert.equal(aggregate.valid.length, 5)
    assert.ok(seen.every(model => model === "mock"), "tiering is opt-in: no small model configured means no lane changes")
  } finally { globalThis.fetch = original }
})

test("verifyFive: token-bucket smoother spaces concurrent lane dispatches", async () => {
  const { verifyFive } = await import("../../lib/verifier.js")
  const stamps = []
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    stamps.push(Date.now())
    return { ok: true, status: 200, json: async () => laneSuccessResponseBody() }
  }
  try {
    const aggregate = await verifyFive(Object.assign({}, testConfig, { routes: 5, verifierMinIntervalMs: 40 }), testCredentials, "prompt")
    assert.equal(aggregate.valid.length, 5, "smoothing never drops lanes")
    stamps.sort((a, b) => a - b)
    const spread = stamps[4] - stamps[0]
    assert.ok(spread >= 120, `five dispatches spread >=4x40ms apart (measured ${spread}ms)`)
  } finally { globalThis.fetch = original }
})

test("createRequestSmoother: min-interval serializes acquires; 0 is a no-op", async () => {
  const { createRequestSmoother } = await import("../../lib/verifier.js")
  const noop = createRequestSmoother(0)
  const t0 = Date.now()
  await noop.acquire()
  await noop.acquire()
  assert.ok(Date.now() - t0 < 30, "zero interval never delays")
  const smoother = createRequestSmoother(50)
  const t1 = Date.now()
  await smoother.acquire()
  await smoother.acquire()
  await smoother.acquire()
  const spread = Date.now() - t1
  assert.ok(spread >= 90, `three acquires spaced >=2x50ms apart (measured ${spread}ms)`)
})
