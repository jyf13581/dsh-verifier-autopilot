// Trace rendering, evidence ids, citation auditing, task/turn gating, and
// payload serialization: the pure functions that turn session events into what
// the verifier sees.
//
// Part of the offline regression suite: `npm test` runs every scripts/tests/*.test.mjs
// in its own process; this file also runs alone with `node --test scripts/tests/evidence.test.mjs`.

import test from "node:test"
import assert from "node:assert/strict"
import { compactTrace, auditFindingCitation, traceFor, renderEventTexts, turnGateDecision, isBareContinuationPrompt, auditAggregateCitations, feedbackSentCount } from "../../lib/index.js"
import { buildVerifierPrompt } from "../../lib/verifier.js"
import { LF } from "./helpers/harness.mjs"

// ---------- trace compaction keeps late evidence ----------

test("compactTrace preserves a late build-complete tool result under compression", () => {
  const rendered = []
  for (let i = 0; i < 300; i += 1) rendered.push("TOOL CALL pwsh" + i + ": command-" + i + " " + "x".repeat(80))
  for (let i = 0; i < 300; i += 1) rendered.push("TOOL RESULT: output " + "y".repeat(80) + " " + i)
  rendered.push("TOOL RESULT: pwsh bash scripts/build.sh -> build: complete exit=0")
  const inputChars = rendered.join(LF).length
  const stats = compactTrace(rendered)
  assert.ok(stats.trace.includes("[... tool evidence ...]"), "compression branch must engage")
  assert.ok(stats.traceChars < inputChars, "compacted trace must be smaller than the raw input")
  assert.ok(stats.trace.includes("build: complete"), "late build evidence must survive compaction")
  assert.ok(stats.evidenceSignalCount >= 1, "build line counts as an evidence signal")
})

test("compactTrace always prepends the extracted-evidence summary block", () => {
  const withSignals = compactTrace(["TOOL RESULT: vitest 12 passed"])
  assert.ok(withSignals.trace.startsWith("[EXTRACTED TOOL EVIDENCE]"))
  assert.ok(withSignals.trace.includes("vitest 12 passed"))
  const empty = compactTrace(["USER: hello"])
  assert.ok(empty.trace.startsWith("[EXTRACTED TOOL EVIDENCE] none"))
})

test("compactTrace: dropped middle evidence must not pass citation audit (ruling J.4-E)", () => {
  // 400 numbered lines, far over the 16000 budget: [E150] is a plain tool
  // result with NO signal keywords, so neither the summary nor the tail
  // excerpts keep it. Auditing against pre-compaction ids called this
  // "supported"; against the visible set it is correctly unknown.
  const rendered = []
  for (let i = 1; i <= 400; i += 1) {
    if (i === 150) rendered.push("[E150] TOOL RESULT: plain nondescript output no1 " + "z".repeat(90))
    else if (i % 2 === 0) rendered.push("[E" + String(i).padStart(2, "0") + "] ASSISTANT: talking point " + i + " " + "x".repeat(90))
    else rendered.push("[E" + String(i).padStart(2, "0") + "] TOOL CALL quiet_tool: args " + "y".repeat(90))
  }
  const stats = compactTrace(rendered)
  assert.ok(stats.trace.length <= 16000, "single unified budget: prompt never re-truncates the trace")
  assert.ok(stats.droppedRanges.length > 0, "compaction must disclose what it dropped")
  assert.ok(!stats.visibleIds.includes(150), "dropped middle evidence leaves the visible id set")
  assert.ok(stats.visibleIds.includes(400), "the final line id always survives")
  const kinds = new Map([[150, "tool-result"]])
  const audit = auditFindingCitation("seeing odd behavior [E150]", stats.visibleIds, [], kinds)
  assert.ok(audit.unknownIds.includes(150), "citing invisible evidence is unknown, not supported")
  assert.equal(audit.independentCitation, false, "dropped evidence never earns independent-citation credit")
})

test("buildVerifierPrompt keeps the final numbered line under a long trace (J.4-E-3)", () => {
  const events = [{ type: "user/message", seq: 0, data: { turn: 1, content: [{ type: "text", text: "do the task" }], source: { kind: "user" } } },
    { type: "turn/start", seq: 1, data: { turn: 1 } }]
  for (let i = 2; i < 460; i += 1) {
    events.push({ type: "assistant/message", seq: i, data: { turn: 1, message: { role: "assistant", content: [{ type: "text", text: "musing " + i + " " + "m".repeat(90) }] } } })
  }
  events.push(
    { type: "assistant/message", seq: 460, data: { turn: 1, message: { role: "assistant", content: [{ type: "text", text: "FINAL ANSWER MARKER: delivered" }] } } },
    { type: "turn/end", seq: 461, data: { turn: 1, reason: { kind: "completed" } } },
  )
  const { trace } = traceFor(events, { start: events[1], end: events.at(-1), turn: 1 })
  const prompt = buildVerifierPrompt("task", trace, "criterion")
  assert.ok(prompt.includes("FINAL ANSWER MARKER"), "the final answer line survives prompt assembly")
  assert.ok(trace.length <= 16000 + 1000, "trace is bounded by the shared budget")
})

// ---------- de-anchoring: historical verdicts and noise stay out ----------

test("verifier feedback text is replaced by a marker, never echoed into the trace", () => {
  const events = [
    { type: "user/message", data: { content: [{ type: "text", text: "[Verifier feedback] 平均完成度 0.40, 分歧 0.49。请检查证据并修复。" }] } },
    { type: "user/message", data: { content: "real task: fix the bug" } },
  ]
  const rendered = renderEventTexts(events)
  assert.ok(!rendered.some(line => line.includes("平均完成度")), "historical verdict text must be omitted")
  assert.ok(rendered.some(line => line.includes("[VERIFIER FEEDBACK RECEIVED")), "a one-line marker remains")
  assert.ok(rendered.some(line => line === "USER: real task: fix the bug"))
})

test("known noise events are excluded entirely from the trace", () => {
  const events = [
    { type: "assistant/chunk", data: { text: "chunk-noise" } },
    { type: "step/start", data: {} },
    { type: "step/end", data: {} },
    { type: "agent/inbox/spliced", data: { cards: "memory-card-noise" } },
    // Turn-bookkeeping pollution measured in live journals (2026-08-28): the
    // request header embeds the whole system prompt + tool schemas, title and
    // retry events are turn bookkeeping. None of them is task evidence.
    { type: "request/header", data: { header: { system: "SYSTEM-PROMPT-LEAK" } } },
    { type: "request/context", data: { contextWindow: 262144 } },
    { type: "session/title", data: { title: "title-noise" } },
    { type: "session/title-llm-request", data: { system: "title-llm-noise" } },
    { type: "llm/retry", data: { retry: 1, failure: { message: "RATE_LIMIT" } } },
    { type: "llm/retry-started", data: { retry: 1 } },
    { type: "tool/result", data: { message: "kept" } },
  ]
  const rendered = renderEventTexts(events)
  assert.equal(rendered.length, 1)
  assert.ok(rendered[0].includes("kept"))
})

test("injected user messages never render; direct tasks and feedback markers survive", () => {
  const events = [
    { type: "user/message", data: { source: { kind: "plugin", plugin: "dsh-system-prompt" }, content: "Current runtime context snapshot RUNTIME-NOISE" } },
    { type: "user/message", data: { source: { kind: "plugin", plugin: "user-approval" }, content: "approval policy changed APPROVAL-NOISE" } },
    { type: "user/message", data: { source: { kind: "skill" }, content: "<system-reminder> SKILL-NOISE" } },
    { type: "user/message", data: { source: { kind: "plugin", plugin: "@dsh-external/dsh-verifier-autopilot" }, content: "[Verifier feedback] hidden" } },
    { type: "user/message", data: { source: { kind: "user" }, content: "direct task stays" } },
    { type: "user/message", data: { content: "legacy source-less task stays" } },
  ]
  const rendered = renderEventTexts(events)
  assert.equal(rendered.length, 3, "only feedback marker + two direct user lines survive")
  assert.ok(rendered[0].includes("[VERIFIER FEEDBACK RECEIVED"), "marker stays first-rendered")
  assert.ok(rendered[1] === "USER: direct task stays")
  assert.ok(rendered[2] === "USER: legacy source-less task stays")
  assert.ok(!rendered.some(line => /RUNTIME-NOISE|APPROVAL-NOISE|SKILL-NOISE/.test(line)), "injected plumbing must leave the evidence window")
})

test("traceFor chooses the direct human task over injected user messages", () => {
  const start = { type: "turn/start", seq: 1, data: { turn: 1 } }
  const end = { type: "turn/end", seq: 5, data: { turn: 1 } }
  const result = traceFor([
    start,
    { type: "user/message", seq: 2, data: { source: { kind: "plugin", plugin: "user-approval" }, content: "The approval policy changed from ask to never." } },
    { type: "user/message", seq: 3, data: { source: { kind: "plugin", plugin: "dsh-system-prompt" }, content: "runtime context" } },
    { type: "user/message", seq: 4, data: { source: { kind: "user" }, content: "Fix the OX model." } },
    end,
  ], { start, end, turn: 1 })
  assert.equal(result.problem, "Fix the OX model.")
})

test("traceFor prefers the current direct task over an earlier turn task", () => {
  const start = { type: "turn/start", seq: 10, data: { turn: 2 } }
  const end = { type: "turn/end", seq: 14, data: { turn: 2 } }
  const result = traceFor([
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: { source: { kind: "user" }, content: "Old task." } },
    { type: "turn/end", seq: 9, data: { turn: 1 } },
    start,
    { type: "user/message", seq: 11, data: { source: { kind: "plugin", plugin: "user-approval" }, content: "approval notice" } },
    { type: "user/message", seq: 12, data: { source: { kind: "user" }, content: "Current task." } },
    { type: "assistant/message", seq: 13, data: { content: "done" } },
    end,
  ], { start, end, turn: 2 })
  assert.equal(result.problem, "Current task.")
})

// ---------- task-type fixtures: attribution + no-op gating semantics ----------
//
// Legacy task-attribution contract (HANDOFF.md §7.1): every fixture pins which problem traceFor
// selects, whether the turn may be auto-verified, and therefore whether the
// session's feedback quota can ever be consumed — feedback only flows through
// turns where gate.verify === true.

test("fixture: verifier-feedback repair turn falls back to the previous task and stays verifiable", () => {
  const start = { type: "turn/start", seq: 8, data: { turn: 2 } }
  const end = { type: "turn/end", seq: 11, data: { turn: 2 } }
  const events = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: { source: { kind: "user" }, turn: 1, content: "Add a single retry for transient provider errors." } },
    { type: "tool/call", seq: 3, data: { name: "pwsh", arguments: "npm test", turn: 1 } },
    { type: "tool/result", seq: 4, data: { message: "30/30 pass", turn: 1 } },
    { type: "assistant/message", seq: 5, data: { turn: 1, content: "Retry shipped behind TRANSIENT_ERROR_CODES." } },
    { type: "turn/end", seq: 6, data: { turn: 1 } },
    // The followup lands between turns and carries no task text of its own.
    { type: "user/message", seq: 7, data: { source: { kind: "user" }, content: "[Verifier feedback] 平均完成度 0.40。请复查证据。" } },
    start,
    { type: "assistant/message", seq: 9, data: { turn: 2, content: "Re-checked the retry lane; behavior unchanged and correct." } },
    end,
  ]
  const result = traceFor(events, { start, end, turn: 2 })
  assert.equal(result.problem, "Add a single retry for transient provider errors.")
  assert.equal(result.hasCurrentDirectTask, false)
  const gate = turnGateDecision({ problem: result.problem, hasCurrentDirectTask: result.hasCurrentDirectTask, toolEventCount: result.stats.toolEventCount })
  assert.equal(gate.kind, "repair-followup")
  assert.equal(gate.verify, false, "tool-free repair claims cannot demonstrate anything — recorded as skipped")
  assert.equal(gate.skipReason, "evidence-free-repair-followup")
})

test("fixture: repair turn WITH real tool work stays verifiable against the previous task", () => {
  const start = { type: "turn/start", seq: 8, data: { turn: 2 } }
  const end = { type: "turn/end", seq: 12, data: { turn: 2 } }
  const events = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: { source: { kind: "user" }, turn: 1, content: "Add a single retry for transient provider errors." } },
    { type: "turn/end", seq: 6, data: { turn: 1 } },
    { type: "user/message", seq: 7, data: { source: { kind: "user" }, content: "[Verifier feedback] 平均完成度 0.40。请复查证据。" } },
    start,
    { type: "tool/call", seq: 9, data: { name: "pwsh", arguments: "npm test", turn: 2 } },
    { type: "tool/result", seq: 10, data: { message: "41/41 pass", turn: 2 } },
    { type: "assistant/message", seq: 11, data: { turn: 2, content: "Re-ran the full suite; behavior unchanged and correct." } },
    end,
  ]
  const result = traceFor(events, { start, end, turn: 2 })
  assert.equal(result.problem, "Add a single retry for transient provider errors.", "fallback keeps the previous task under review")
  assert.ok(result.stats.toolEventCount >= 1)
  const gate = turnGateDecision({ problem: result.problem, hasCurrentDirectTask: result.hasCurrentDirectTask, toolEventCount: result.stats.toolEventCount })
  assert.equal(gate.kind, "repair-followup")
  assert.equal(gate.verify, true, "real repair work keeps being verified")
  assert.equal(gate.skipReason, undefined)
})

test("fixture: bare status continuation with zero tools is gated off instead of burning feedback quota", () => {
  const start = { type: "turn/start", seq: 20, data: { turn: 3 } }
  const end = { type: "turn/end", seq: 23, data: { turn: 3 } }
  const events = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: { source: { kind: "user" }, turn: 1, content: "Fix the OX model routing." } },
    { type: "assistant/message", seq: 3, data: { turn: 1, content: "Routing fixed, catalog green." } },
    { type: "turn/end", seq: 4, data: { turn: 1 } },
    start,
    { type: "user/message", seq: 21, data: { source: { kind: "user" }, turn: 3, content: "继续" } },
    { type: "assistant/message", seq: 22, data: { turn: 3, content: "上一轮任务已全部完成，无遗留步骤。" } },
    end,
  ]
  const result = traceFor(events, { start, end, turn: 3 })
  assert.equal(result.problem, "继续")
  assert.equal(result.hasCurrentDirectTask, true)
  assert.equal(result.stats.toolEventCount, 0)
  const gate = turnGateDecision({ problem: result.problem, hasCurrentDirectTask: result.hasCurrentDirectTask, toolEventCount: result.stats.toolEventCount })
  assert.equal(gate.kind, "status-continuation")
  assert.equal(gate.verify, false, "bare continuation must not reach five-lane verification or the feedback quota")
  assert.equal(gate.skipReason, "bare-status-continuation")
})

test("fixture: continuation prompt WITH real tool work is still verified as a task", () => {
  const start = { type: "turn/start", seq: 20, data: { turn: 3 } }
  const end = { type: "turn/end", seq: 25, data: { turn: 3 } }
  const events = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: { source: { kind: "user" }, turn: 1, content: "Fix the OX model routing." } },
    { type: "assistant/message", seq: 3, data: { turn: 1, content: "Routing fixed, catalog green." } },
    { type: "turn/end", seq: 4, data: { turn: 1 } },
    start,
    { type: "user/message", seq: 21, data: { source: { kind: "user" }, turn: 3, content: "继续" } },
    { type: "tool/call", seq: 22, data: { name: "pwsh", arguments: "npm test", turn: 3 } },
    { type: "tool/result", seq: 23, data: { message: "41/41 pass", turn: 3 } },
    { type: "assistant/message", seq: 24, data: { turn: 3, content: "Follow-up work finished with tests." } },
    end,
  ]
  const result = traceFor(events, { start, end, turn: 3 })
  assert.equal(result.problem, "继续")
  const gate = turnGateDecision({ problem: result.problem, hasCurrentDirectTask: result.hasCurrentDirectTask, toolEventCount: result.stats.toolEventCount })
  assert.equal(gate.kind, "task", "tool evidence rescues an otherwise bare continuation")
  assert.equal(gate.verify, true)
  assert.equal(gate.skipReason, undefined)
})

test("fixture: tool-free Q&A stays verifiable — missing tools alone never gates", () => {
  const start = { type: "turn/start", seq: 30, data: { turn: 4 } }
  const end = { type: "turn/end", seq: 33, data: { turn: 4 } }
  const events = [
    start,
    { type: "user/message", seq: 31, data: { source: { kind: "user" }, turn: 4, content: "用两句话解释一下什么是幂等性？" } },
    { type: "assistant/message", seq: 32, data: { turn: 4, content: "幂等性指同一操作执行多次与执行一次的效果相同。例如重复发送同一个 HTTP PUT 请求，资源状态不会进一步改变。" } },
    end,
  ]
  const result = traceFor(events, { start, end, turn: 4 })
  assert.equal(result.problem, "用两句话解释一下什么是幂等性？")
  assert.equal(result.stats.toolEventCount, 0)
  const gate = turnGateDecision({ problem: result.problem, hasCurrentDirectTask: result.hasCurrentDirectTask, toolEventCount: result.stats.toolEventCount })
  assert.equal(gate.kind, "pure-answer")
  assert.equal(gate.verify, true, "explanations without tools are legitimate and must keep getting verified")
})

test("fixture: normal coding turn with build/test evidence verifies as a task", () => {
  const start = { type: "turn/start", seq: 40, data: { turn: 5 } }
  const end = { type: "turn/end", seq: 46, data: { turn: 5 } }
  const events = [
    start,
    { type: "user/message", seq: 41, data: { source: { kind: "user" }, turn: 5, content: "把回归从 29 条补齐到覆盖任务类型。" } },
    { type: "tool/call", seq: 42, data: { name: "pwsh", arguments: "bash scripts/build.sh", turn: 5 } },
    { type: "tool/result", seq: 43, data: { message: "build: complete", turn: 5 } },
    { type: "tool/call", seq: 44, data: { name: "pwsh", arguments: "npm test", turn: 5 } },
    { type: "tool/result", seq: 45, data: { message: "tests 41 pass 41 fail 0", turn: 5 } },
    end,
  ]
  const result = traceFor(events, { start, end, turn: 5 })
  assert.equal(result.problem, "把回归从 29 条补齐到覆盖任务类型。")
  assert.ok(result.stats.toolEventCount >= 2)
  const gate = turnGateDecision({ problem: result.problem, hasCurrentDirectTask: result.hasCurrentDirectTask, toolEventCount: result.stats.toolEventCount })
  assert.deepEqual(gate, { verify: true, kind: "task" })
})

test("fixture: verifier self-development keeps attribution despite report-shaped evidence in the trace", () => {
  const start = { type: "turn/start", seq: 50, data: { turn: 6 } }
  const end = { type: "turn/end", seq: 56, data: { turn: 6 } }
  const events = [
    start,
    { type: "user/message", seq: 51, data: { source: { kind: "plugin", plugin: "dsh-system-prompt" }, turn: 6, content: "runtime context snapshot" } },
    { type: "user/message", seq: 52, data: { source: { kind: "user" }, turn: 6, content: "为 dsh-verifier-autopilot 补齐任务类型 fixture 并跑通回归。" } },
    { type: "tool/call", seq: 53, data: { name: "pwsh", arguments: "npm run eval -- --only=clean", turn: 6 } },
    { type: "tool/result", seq: 54, data: { message: "eval baseline 32/32 detection, 0/24 false positives (historical)", turn: 6 } },
    { type: "assistant/message", seq: 55, data: { turn: 6, content: "fixtures added; HANDOFF updated." } },
    end,
  ]
  const result = traceFor(events, { start, end, turn: 6 })
  assert.equal(result.problem, "为 dsh-verifier-autopilot 补齐任务类型 fixture 并跑通回归。", "report text inside tool results must never be mistaken for the task")
  const gate = turnGateDecision({ problem: result.problem, hasCurrentDirectTask: result.hasCurrentDirectTask, toolEventCount: result.stats.toolEventCount })
  assert.equal(gate.kind, "task")
  assert.equal(gate.verify, true)
  assert.ok(result.trace.includes("32/32"), "report-shaped evidence stays visible; citation validation arrives with evidence ids (stage 2)")
})

test("fixture: legacy event without source metadata still counts as a direct task", () => {
  const start = { type: "turn/start", seq: 60, data: { turn: 7 } }
  const end = { type: "turn/end", seq: 64, data: { turn: 7 } }
  const events = [
    start,
    { type: "user/message", seq: 61, data: { turn: 7, content: "Legacy: tighten the guard test coverage." } },
    { type: "user/message", seq: 62, data: { source: { kind: "plugin", plugin: "user-approval" }, turn: 7, content: "approval notice" } },
    { type: "tool/call", seq: 63, data: { name: "pwsh", arguments: "npm test", turn: 7 } },
    end,
  ]
  const result = traceFor(events, { start, end, turn: 7 })
  assert.equal(result.problem, "Legacy: tighten the guard test coverage.")
  assert.equal(result.hasCurrentDirectTask, true)
  const gate = turnGateDecision({ problem: result.problem, hasCurrentDirectTask: result.hasCurrentDirectTask, toolEventCount: result.stats.toolEventCount })
  assert.equal(gate.kind, "task")
  assert.equal(gate.verify, true)
})

test("fixture: legacy bare continuation without source is still recognized and gated off", () => {
  const start = { type: "turn/start", seq: 70, data: { turn: 8 } }
  const end = { type: "turn/end", seq: 72, data: { turn: 8 } }
  const events = [
    start,
    { type: "user/message", seq: 71, data: { turn: 8, content: "下一步" } },
    { type: "assistant/message", seq: 72, data: { turn: 8, content: "无新增改动。" } },
    end,
  ]
  const result = traceFor(events, { start, end, turn: 8 })
  assert.equal(result.problem, "下一步")
  assert.equal(result.stats.toolEventCount, 0)
  const gate = turnGateDecision({ problem: result.problem, hasCurrentDirectTask: result.hasCurrentDirectTask, toolEventCount: result.stats.toolEventCount })
  assert.equal(gate.kind, "status-continuation", "the historical noise class must stay gated even without source metadata")
  assert.equal(gate.verify, false)
})

test("fixture: turn containing only a plugin injection falls back to the previous task", () => {
  const start = { type: "turn/start", seq: 80, data: { turn: 9 } }
  const end = { type: "turn/end", seq: 83, data: { turn: 9 } }
  const events = [
    { type: "turn/start", seq: 60, data: { turn: 7 } },
    { type: "user/message", seq: 61, data: { source: { kind: "user" }, turn: 7, content: "Tighten the guard test coverage." } },
    { type: "turn/end", seq: 79, data: { turn: 7 } },
    start,
    { type: "user/message", seq: 81, data: { source: { kind: "plugin", plugin: "user-approval" }, content: "The approval policy changed from ask to never." } },
    { type: "assistant/message", seq: 82, data: { turn: 9, content: "Acknowledged; continuing under the new policy." } },
    end,
  ]
  const result = traceFor(events, { start, end, turn: 9 })
  assert.equal(result.problem, "Tighten the guard test coverage.", "plugin injections must not become the task even when they are the only user-shaped text")
  assert.equal(result.hasCurrentDirectTask, false)
  const gate = turnGateDecision({ problem: result.problem, hasCurrentDirectTask: result.hasCurrentDirectTask, toolEventCount: result.stats.toolEventCount })
  assert.equal(gate.kind, "repair-followup")
  assert.equal(gate.verify, false, "injection-only acknowledgement without any evidence is noise")
  assert.equal(gate.skipReason, "evidence-free-repair-followup")
})

test("gate: only whole-message continuation pings qualify, never substrings or questions", () => {
  const gated = ["继续", "继续。", "继续！", "下一步", "Next step", "please continue", "Go on!", "status?", "any update?", "收到", "好的。", "进展如何？"]
  for (const text of gated) assert.ok(isBareContinuationPrompt(text), JSON.stringify(text) + " should be treated as a bare continuation")
  const kept = [
    "继续修 OX 模型",
    "下一步计划是什么？",
    "continue implementing the parser",
    "解释一下这段代码为什么这样写",
    "OK thanks — also fix the lint error",
    "",
    "好的，另外把 README 也更新一下",
  ]
  for (const text of kept) assert.ok(!isBareContinuationPrompt(text), JSON.stringify(text) + " must NOT be treated as a bare continuation")
  assert.equal(isBareContinuationPrompt("继续 ".repeat(30)), false, "overlong input can never gate on length alone")
})

test("gate matrix: force bypasses the skip, flag off restores raw behavior, other kinds always verify", () => {
  const continuation = { problem: "继续", hasCurrentDirectTask: true, toolEventCount: 0 }
  assert.equal(turnGateDecision(continuation).verify, false)
  assert.equal(turnGateDecision(continuation, {}).verify, false)
  assert.equal(turnGateDecision(continuation, { skipEnabled: false }).verify, true, "disabling the flag restores verify-everything behavior")
  assert.deepEqual(turnGateDecision(continuation, { force: true }), { verify: true, kind: "status-continuation" }, "manual POST /verify bypasses the gate")
  const noTask = { problem: "", hasCurrentDirectTask: false, hasAnyDirectTask: false, toolEventCount: 0 }
  assert.deepEqual(turnGateDecision(noTask, { skipEnabled: false }), { verify: false, kind: "no-task", skipReason: "no-direct-task" }, "disabling noise skips must never make a task-less session spend verifier lanes")
  assert.deepEqual(turnGateDecision(noTask, { force: true, skipEnabled: false }), { verify: false, kind: "no-task", skipReason: "no-direct-task" }, "manual force cannot override the task attribution safety invariant")

  assert.deepEqual(turnGateDecision({ problem: "什么是幂等性？", hasCurrentDirectTask: true, toolEventCount: 0 }), { verify: true, kind: "pure-answer" })
  assert.deepEqual(turnGateDecision({ problem: "Fix the OX model routing.", hasCurrentDirectTask: false, toolEventCount: 0 }), { verify: false, kind: "repair-followup", skipReason: "evidence-free-repair-followup" })
  assert.deepEqual(turnGateDecision({ problem: "Fix the OX model routing.", hasCurrentDirectTask: false, toolEventCount: 3 }), { verify: true, kind: "repair-followup" })
  assert.deepEqual(turnGateDecision({ problem: "Ship the feature.", hasCurrentDirectTask: true, toolEventCount: 4 }), { verify: true, kind: "task" })
})

// ---------- stage 2: stable [E*] evidence ids + citation auditing ----------

test("traceFor numbers every rendered line and separates evidence ids from verdict ids", () => {
  const start = { type: "turn/start", seq: 1, data: { turn: 1 } }
  const end = { type: "turn/end", seq: 6, data: { turn: 1 } }
  const events = [
    start,
    { type: "user/message", seq: 2, data: { source: { kind: "user" }, turn: 1, content: "Run the tests." } },
    { type: "tool/call", seq: 3, data: { name: "pwsh", arguments: "npm test", turn: 1 } },
    { type: "tool/result", seq: 4, data: { message: "Tests: 5 passed", turn: 1 } },
    { type: "assistant/message", seq: 5, data: { turn: 1, content: "All green." } },
    end,
  ]
  const result = traceFor(events, { start, end, turn: 1 })
  assert.ok(result.trace.includes("[E01] USER: Run the tests."))
  assert.ok(result.trace.includes("[E03] TOOL RESULT: Tests: 5 passed"))
  assert.deepEqual(result.evidenceIds, [1, 2, 3, 4])
  assert.deepEqual(result.verdictLineIds, [])
  assert.equal(result.stats.toolEventCount, 2, "prefixes must not break tool statistics")
})

test("a verifier-feedback marker inside the turn is tracked as a verdict line id", () => {
  const start = { type: "turn/start", seq: 10, data: { turn: 2 } }
  const end = { type: "turn/end", seq: 14, data: { turn: 2 } }
  const events = [
    start,
    { type: "user/message", seq: 11, data: { source: { kind: "user" }, content: "[Verifier feedback] 平均完成度 0.40。请复查证据。" } },
    { type: "assistant/message", seq: 12, data: { turn: 2, content: "re-checked" } },
    end,
  ]
  const result = traceFor(events, { start, end, turn: 2 })
  assert.ok(result.trace.includes("[VERIFIER FEEDBACK RECEIVED"))
  assert.deepEqual(result.verdictLineIds, result.evidenceIds.filter(id => id === 1), "the marker line is E01 here")
})

test("compactTrace keeps classifying and counting prefixed tool lines under compression", () => {
  const rendered = []
  for (let i = 1; i <= 300; i += 1) rendered.push("[E" + String(i).padStart(3, "0") + "] TOOL CALL pwsh" + i + ": command-" + i)
  for (let i = 301; i <= 600; i += 1) rendered.push("[E" + String(i).padStart(3, "0") + "] TOOL RESULT: output " + i)
  rendered.push("[E601] TOOL RESULT: pwsh bash scripts/build.sh -> build: complete exit=0")
  const stats = compactTrace(rendered)
  assert.equal(stats.toolEventCount, 601)
  assert.ok(stats.evidenceSignalCount >= 1)
  assert.ok(stats.trace.includes("build: complete"))
})

test("auditFindingCitation validates refs and flags unknown and historical-verdict citations", () => {
  const good = auditFindingCitation("tests failed but were declared passing [E03][E04]", [1, 2, 3, 4], [])
  assert.deepEqual(good.citedIds, [3, 4])
  assert.equal(good.validCitation, true)
  assert.deepEqual(good.unknownIds, [])
  const bogus = auditFindingCitation("see the missing file in [E99]", [1, 2, 3], [])
  assert.deepEqual(bogus.citedIds, [99])
  assert.deepEqual(bogus.unknownIds, [99])
  assert.equal(bogus.validCitation, false)
  const verdict = auditFindingCitation("as the omitted verdict already said [E02]", [1, 2], [2])
  assert.equal(verdict.citesHistoricalVerdict, true)
  assert.equal(verdict.validCitation, false, "citing the omitted historical verdict is not real evidence")
})

test("no-defect findings are exempt from the citation requirement", () => {
  const clean = auditFindingCitation("no concrete defect found", [], [])
  assert.equal(clean.noDefectFinding, true)
  assert.deepEqual(clean.citedIds, [])
  const absent = auditFindingCitation(undefined, [1], [])
  assert.equal(absent.findingPresent, false)
})

test("aggregate citation rollup counts only defect findings", () => {
  const aggregate = {
    results: [],
    valid: [
      { finding: "retry never runs, see failure [E02]" },
      { finding: "no concrete defect found" },
      { finding: "bogus reference to src/duration.ts [E77]" },
    ],
  }
  const rollup = auditAggregateCitations(aggregate, [1, 2, 3], [])
  assert.equal(rollup.defectFindings, 2)
  assert.equal(rollup.defectFindingsWithoutCitation, 1, "the bogus-reference finding cites an unknown id")
  assert.equal(rollup.findingsCitingUnknownIds, 1)
  assert.equal(rollup.findingsCitingHistoricalVerdict, 0)
})

test("prompt requires [E*] citations for defect claims", () => {
  assert.ok(buildVerifierPrompt("p", "t", "c").includes("[E*]"), "the strict protocol must pin the citation format")
})

test("citation audit parses compact [E01-E04] ranges and stays conservative at the edges", () => {
  const ranged = auditFindingCitation("no verification evidence present [E01-E04]", [1, 2, 3, 4], [])
  assert.deepEqual(ranged.citedIds, [1, 2, 3, 4])
  assert.equal(ranged.validCitation, true)
  assert.deepEqual(ranged.unknownIds, [])

  const mixed = auditFindingCitation("broken here [E02]; also [E07-E09]", [1, 2, 3, 4, 5, 6], [])
  assert.deepEqual(mixed.citedIds, [2, 7, 8, 9])
  assert.deepEqual(mixed.unknownIds, [7, 8, 9])
  assert.equal(mixed.validCitation, true, "the real [E02] still counts even when other refs are unknown")

  const huge = auditFindingCitation("everything is wrong [E01-E9999]", [1, 2], [])
  assert.deepEqual(huge.citedIds, [], "spans beyond 64 are ignored, not credited")
  assert.equal(huge.validCitation, false)
})

// ---------- payload serialization fallbacks ----------

test("structured payloads fall back through flattening to JSON", () => {
  const rendered = renderEventTexts([
    { type: "tool/call", data: { name: "pwsh", arguments: { command: "ls -la", n: 3 } } },
    { type: "tool/result", data: { message: { content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] } } },
    { type: "tool/result", data: { result: [{ text: "ab" }, { text: "cd" }] } },
  ])
  const callLine = rendered.find(line => line.startsWith("TOOL CALL pwsh:"))
  assert.ok(callLine !== undefined && callLine.includes("ls -la") && callLine.includes("{"), "object arguments serialize via JSON fallback")
  assert.ok(rendered.some(line => line === "TOOL RESULT: hello world"))
  assert.ok(rendered.some(line => line === "TOOL RESULT: abcd"))
})

test("phase0: a late event tagged with the finished turn cannot sneak past the completed-turn seq seal", () => {
  const start = { type: "turn/start", seq: 10, data: { turn: 2 } }
  const end = { type: "turn/end", seq: 14, data: { turn: 2 } }
  const events = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: { source: { kind: "user" }, turn: 1, content: "First task." } },
    { type: "turn/end", seq: 9, data: { turn: 1 } },
    start,
    { type: "user/message", seq: 11, data: { source: { kind: "user" }, turn: 2, content: "Second task." } },
    { type: "assistant/message", seq: 12, data: { turn: 2, content: "Working." } },
    end,
    { type: "assistant/message", seq: 20, data: { turn: 2, content: "LATE SAME-TURN INJECTION" } },
  ]
  const result = traceFor(events, { start, end, turn: 2 })
  assert.ok(!result.trace.includes("LATE SAME-TURN INJECTION"), "events appended after turn/end must stay out of the sealed turn")
  assert.equal(result.problem, "Second task.")
  const control = traceFor(events.slice(0, 7), { start, end, turn: 2 })
  assert.ok(control.trace.includes("[E02] ASSISTANT: Working."), "control: in-range events render exactly as before")
})

test("phase0: evidenceSignals ignores failure-shaped lines that merely contain signal substrings", () => {
  const negatives = compactTrace([
    "TOOL RESULT: pwsh npm test -> ValidationError: input invalid",
    "TOOL RESULT: git commit warning: bypassed pre-commit hook",
  ])
  assert.equal(negatives.evidenceSignalCount, 0, "'invalid' and 'bypassed' must not fabricate positive evidence via substring hits")
  assert.equal(negatives.passSignalCount, 0)
  const positives = compactTrace([
    "TOOL RESULT: pwsh npm test",
    "TOOL RESULT: tests 5 passed",
    "TOOL RESULT: pwsh bash scripts/build.sh -> build: complete exit=0",
  ])
  assert.ok(positives.evidenceSignalCount >= 2, "genuine PASS/build-complete lines must keep counting as signals")
})

test("phase1: traceFor classifies rendered line provenance for citation auditing", () => {
  const start = { type: "turn/start", seq: 10, data: { turn: 2 } }
  const end = { type: "turn/end", seq: 15, data: { turn: 2 } }
  const events = [
    start,
    { type: "user/message", seq: 11, data: { source: { kind: "user" }, turn: 2, content: "Run the tests." } },
    { type: "tool/call", seq: 12, data: { name: "pwsh", arguments: "npm test", turn: 2 } },
    { type: "tool/result", seq: 13, data: { turn: 2, message: "Tests: 5 passed" } },
    { type: "assistant/message", seq: 14, data: { turn: 2, content: "All green." } },
    end,
  ]
  const result = traceFor(events, { start, end, turn: 2 })
  assert.deepEqual(result.evidenceKinds, { 1: "user", 2: "tool-call", 3: "tool-result", 4: "assistant" })
})

test("phase1: citation auditing credits only independent execution evidence, never assistant prose alone", () => {
  const kinds = new Map([[1, "user"], [2, "tool-call"], [3, "tool-result"], [4, "assistant"]])
  const claimOnly = auditFindingCitation("the assistant said everything passed [E04]", [1, 2, 3, 4], [], kinds)
  assert.equal(claimOnly.validCitation, true, "the reference resolves to a real rendered line")
  assert.equal(claimOnly.independentCitation, false, "an assistant claim is not independent evidence")
  assert.equal(claimOnly.citesOnlyClaims, true)

  const grounded = auditFindingCitation("tests were never run despite the output [E03]", [1, 2, 3, 4], [], kinds)
  assert.equal(grounded.validCitation, true)
  assert.equal(grounded.independentCitation, true)
  assert.equal(grounded.citesOnlyClaims, false)

  const legacy = auditFindingCitation("see [E02]", [1, 2], [], undefined)
  assert.equal(legacy.validCitation, true, "callers without provenance keep prior behavior")
  assert.equal(legacy.independentCitation, true)
})

test("phase1: aggregate rollup reports defect findings lacking independent citations", () => {
  const kinds = new Map([[1, "user"], [2, "tool-call"], [3, "tool-result"], [4, "assistant"]])
  const aggregate = {
    results: [],
    valid: [
      { finding: "declared passing but nothing backs it [E04]" },
      { finding: "tests actually failed here [E03]" },
    ],
  }
  const rollup = auditAggregateCitations(aggregate, [1, 2, 3, 4], [], kinds)
  assert.equal(rollup.defectFindings, 2)
  assert.equal(rollup.defectFindingsWithoutCitation, 0, "both findings cite real lines")
  assert.equal(rollup.findingsWithoutIndependentCitation, 1, "only the tool-result-backed finding counts as independent")
  const legacyRollup = auditAggregateCitations(aggregate, [1, 2, 3, 4], [])
  assert.equal(legacyRollup.findingsWithoutIndependentCitation, 0, "legacy callers see no regression in the field")
})

test("phase2b: feedback is detected structurally from its plugin source, not by text prefix", () => {
  const pluginSource = { kind: "plugin", plugin: "@dsh-external/dsh-verifier-autopilot", form: "notice", summary: "验证完成度 0.40，已请求复查" }
  const events = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: { source: pluginSource, turn: 1, content: [{ type: "text", text: "平均完成度 0.40。请复查证据并修复。" }] } },
    { type: "assistant/message", seq: 3, data: { turn: 1, content: "收到，开始复查。" } },
    { type: "turn/end", seq: 9, data: { turn: 1 } },
  ]
  assert.equal(feedbackSentCount(events), 1, "structured plugin source alone identifies verifier feedback")

  const result = traceFor(events, { start: events[0], end: events[3], turn: 1 })
  assert.deepEqual(result.verdictLineIds, [1], "structured feedback renders as the omitted-verdict marker line")
  assert.equal(result.hasCurrentDirectTask, false, "feedback must never become the task under review")
  assert.ok(result.trace.includes("[VERIFIER FEEDBACK RECEIVED"), "historical verdict text stays omitted from the trace")

  const otherPlugin = [
    { type: "user/message", seq: 20, data: { source: { kind: "plugin", plugin: "someone-else", form: "notice", summary: "hi" }, turn: 1, content: "hello" } },
  ]
  assert.equal(feedbackSentCount(otherPlugin.concat(events)), 1, "other plugins' notices are not verifier feedback")
})
