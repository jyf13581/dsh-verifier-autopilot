// Deterministic regression suite for @dsh-external/dsh-verifier-autopilot.
// Run: npm test   (equivalent to: node scripts/test.mjs)
//
// Scope: pure host-side logic needing no network, DOM, or live DSH runtime:
// trace compaction, de-anchoring filters, payload serialization fallbacks,
// the score-tag protocol parser via mocked fetch, feedback gating math, and
// the durable feedback counter. Client UI rendering stays out of scope here.
import test from "node:test"
import assert from "node:assert/strict"

import { renderEventTexts, compactTrace, feedbackSentCount, traceFor, isBareContinuationPrompt, turnGateDecision, auditFindingCitation, auditAggregateCitations, VerifierHost, apiRoutes, createSettingsSourceHooks } from "../lib/index.js"
import { buildVerifierPrompt, shouldRequestFeedback, decideFeedback, verifyRoute, verifierEffortFields } from "../lib/verifier.js"
import { fileURLToPath } from "node:url"
import { VerifierBridge, BridgeError } from "../lib/selection/bridge.js"
import { SelectionRunner } from "../lib/selection/candidates.js"
import { retryTransientBridge } from "../lib/selection/retry.js"
import { buildAutopilotRelay, planAutopilotTask } from "../lib/selection/autopilot.js"
import { runChecks } from "../lib/selection/checks.js"
import { renderTrajectory } from "../lib/selection/trajectory.js"
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"

const LF = String.fromCharCode(10)

// Phase 0 guard: accidental unhandled rejections become observable data instead
// of a crashed runner. Individual phase-0 tests assert on this list.
const __unhandledRejections = []
process.on("unhandledRejection", reason => { __unhandledRejections.push(reason) })

test("settings source changes refresh the live Host configuration", () => {
  const applied = []
  const hooks = createSettingsSourceHooks({ replaceConfig(next) { applied.push(next) } })
  const first = { enabled: false, model: "deepseek-chat" }
  const second = { enabled: true, model: "kimi-k3" }
  hooks.setSource(() => first)
  assert.equal(applied.length, 0, "setSource only replaces the authoritative source")
  hooks.onChange()
  assert.equal(applied.at(-1), first)
  hooks.setSource(() => second)
  hooks.onChange()
  assert.equal(applied.at(-1), second, "every committed settings change reaches the live Host")
  assert.equal(applied.length, 2)
})

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

// ---------- 2026-09-08 裁决 9.8 / J.4-E: legacy evidence visibility ----------

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

function letterDistribution(letter, competitors) {
  return [{ token: letter, logprob: Math.log(0.7) }].concat(competitors.filter(c => c !== letter).map(c => ({ token: c, logprob: Math.log(0.15) })))
}

function scorePositions() {
  const tokens = ["<score_A>", " K ", "</score_A>", LF, "<score_B>", " M ", "</score_B>"]
  return tokens.map((token, index) => ({ token, top_logprobs: index === 1 ? letterDistribution("K", ["T", "J"]) : index === 5 ? letterDistribution("M", ["T", "J"]) : [] }))
}

function mockFetch(body) {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => body })
  return () => { globalThis.fetch = original }
}

const testConfig = { apiKeyEnv: "TEST_KEY", baseURL: "http://mock.local/v1", model: "mock", routes: 5, maxTokens: 512, temperature: 0.2, timeoutMs: 1000, scoreThreshold: 0.62, disagreementThreshold: 0.12 }
const testCredentials = { resolve: async () => ({ value: "mock-key" }) }

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

// ---------- single transient-error retry per lane (direction F) ----------

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

const successBody = { choices: [{ finish_reason: "stop", message: { role: "assistant", content: ["Analysis.", "finding: no concrete defect found", "<score_A> A </score_A>", "<score_B> B </score_B>"].join(LF) }, logprobs: { content: scorePositions() } }] }

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

// ---------- phase 0: host scheduling, lifecycle, and protocol boundaries ----------
//
// These tests encode the legacy scheduling contract in HANDOFF.md §7.1: the Host
// scheduler and lifecycle boundary must be deterministically testable without a
// live DSH runtime or provider. Coordinator/host seams are imported dynamically
// so a missing seam shows up as a failing test instead of crashing the suite;
// parser and verifier fixtures run against the long-standing static exports.

const quiesce = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms))

function deferred() {
  let resolve
  let reject
  // Hold a live timer while the gate is pending: mocked lanes have no socket
  // handles, so without this the event loop could drain mid-await and the test
  // runner would cancel the suite. Cleared on settle for clean shutdown.
  const holder = setTimeout(() => {}, 60000)
  const promise = new Promise((res, rej) => {
    resolve = value => { clearTimeout(holder); res(value) }
    reject = error => { clearTimeout(holder); rej(error) }
  })
  return { promise, resolve: resolve, reject: reject }
}

function fakeAgent(id, events) {
  const handlers = new Map()
  const agent = {
    id,
    session: { events },
    handlers,
    followups: [],
    async followup(message) { agent.followups.push(message) },
    ctx: {
      on(name, handler) {
        const list = handlers.get(name) ?? []
        list.push(handler)
        handlers.set(name, list)
        return () => handlers.set(name, (handlers.get(name) ?? []).filter(item => item !== handler))
      },
    },
  }
  return agent
}

function fakeContext() {
  const agentsMap = new Map()
  const contextHandlers = new Map()
  const services = new Map()
  const ctx = {
    agents: { list: () => [...agentsMap.values()], get: id => agentsMap.get(id) },
    get(name) { return services.get(name) },
    setService(name, svc) { services.set(name, svc) },
    credentials: { resolve: async () => ({ value: "mock-key" }) },
    effect() {},
    webServer: { register: () => () => undefined },
    on(name, handler) {
      const list = contextHandlers.get(name) ?? []
      list.push(handler)
      contextHandlers.set(name, list)
      return () => contextHandlers.set(name, (contextHandlers.get(name) ?? []).filter(item => item !== handler))
    },
  }
  ctx.emit = (name, payload) => { for (const handler of [...(contextHandlers.get(name) ?? [])]) handler(payload) }
  ctx.spawnAgent = agent => { agentsMap.set(String(agent.id), agent); return agent }
  return ctx
}

function fireIdle(agent) {
  for (const handler of agent.handlers.get("agent/status") ?? []) handler({ status: "idle" })
}

function hostOverrides(overrides = {}) {
  return {
    enabled: true, autoFeedback: true, routes: 1, scoreThreshold: 0.62, disagreementThreshold: 0.12,
    maxFeedbackPerSession: 1, timeoutMs: 90000, maxTokens: 512, temperature: 0.2,
    baseURL: "http://mock.local/v1", model: "mock", apiKeyEnv: "TEST_KEY", verifierEffort: "max",
    allowLabelFallback: false, divergenceGuard: true, divergenceGuardMedian: 0.75,
    skipStatusContinuation: true, selectionNotify: true,
    selectionMode: "auto", selectionModelStrategy: "quality-first", selectionProvider: "kimi",
    selectionModels: "minimaxai/minimax-m3,nvidia/nemotron-3-super-120b-a12b,nemotron-3-ultra-550b-a55b,kimi-k3,deepseek-ai/deepseek-v4-pro-0813",
    selectionStandardCandidates: 2, selectionDeepCandidates: 3, selectionEvaluations: 2, selectionPivots: 2,
    selectionCandidateTimeoutMs: 30000, selectionSelectTimeoutMs: 30000, selectionMarginThreshold: 0.03, selectionProbeEnabled: false,
    selectionVerifierWorkers: 0, verifierMinIntervalMs: 0, verifierSmallModel: "",
    ...overrides,
  }
}

/** Deterministic single-lane provider: every fetch must claim a pre-queued
 *  responder, and simultaneous lane requests are counted so serialization
 *  guarantees are observable without timing heuristics. */
function mockLaneServer() {
  const original = globalThis.fetch
  const waiters = []
  const server = { calls: [], maxInFlight: 0, restore: () => { globalThis.fetch = original } }
  let inFlight = 0
  server.enqueue = responder => waiters.push(responder)
  server.enqueueBody = body => server.enqueue(() => ({ ok: true, status: 200, json: async () => body }))
  globalThis.fetch = async (url, init) => {
    const responder = waiters.shift()
    if (!responder) throw new Error("unexpected lane request: " + String(url))
    const call = { url, init }
    server.calls.push(call)
    inFlight += 1
    server.maxInFlight = Math.max(server.maxInFlight, inFlight)
    try { return await responder(call) } finally { inFlight -= 1 }
  }
  return server
}

function laneSuccessBody() {
  return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: ["Analysis.", "finding: no concrete defect found", "<score_A> A </score_A>", "<score_B> B </score_B>"].join(LF) }, logprobs: { content: scorePositions() } }] }
}

function laneLowScoreBody() {
  // K/M over scorePositions(): mean ~= 0.47 < 0.62, so this triggers the
  // feedback branch under the default threshold (routes=1 keeps it eligible).
  return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: ["Analysis.", "finding: retry path is missing [E02]", "<score_A> K </score_A>", "<score_B> M </score_B>"].join(LF) }, logprobs: { content: scorePositions() } }] }
}

/** Responder helper: settles with the wrapped body but rejects early when the
 *  run's abort signal fires, mirroring real fetch cancellation. */
function gatedLane(call, gate, maker = laneSuccessBody) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("This operation was aborted"))
    if (call.init?.signal) call.init.signal.addEventListener("abort", onAbort, { once: true })
    gate.promise.then(() => resolve({ ok: true, status: 200, json: async () => maker() }), reject)
  })
}

function completedTurnEvents(turn, problem = "Build the widget.") {
  const base = (turn - 1) * 100
  return [
    { type: "turn/start", seq: base + 1, data: { turn } },
    { type: "user/message", seq: base + 2, data: { source: { kind: "user" }, turn, content: problem } },
    { type: "tool/result", seq: base + 3, data: { turn, message: "pwsh npm test -> tests 5 passed" } },
    { type: "assistant/message", seq: base + 4, data: { turn, content: "Done." } },
    { type: "turn/end", seq: base + 5, data: { turn } },
  ]
}

/** Minimal async-iterable request stub for exercising exported API routes. */
function fakeReq(bodyObj, url = "/", method = "POST") {
  return {
    method,
    url,
    headers: { "content-type": "application/json" },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(bodyObj)) },
  }
}

/** Minimal response sink capturing status + body for route handler tests. */
function fakeRes() {
  return {
    status: 0,
    bodyText: "",
    headers: null,
    writeHead(code, headerMap) { this.status = code; this.headers = headerMap },
    end(text) { this.bodyText = String(text ?? "") },
    once() {},
  }
}

test("phase0: manual/auto overlap stays serialized and later auto idles keep mutual exclusion", async () => {
  const { VerifierHost } = await import("../lib/index.js")
  const server = mockLaneServer()
  try {
    const g1 = deferred()
    const gm = deferred()
    const g2 = deferred()
    const g3 = deferred()
    server.enqueue(call => gatedLane(call, g1))
    server.enqueue(call => gatedLane(call, gm))
    server.enqueue(call => gatedLane(call, g2))
    server.enqueue(call => gatedLane(call, g3))
    const ctx = fakeContext()
    const host = new VerifierHost(ctx, hostOverrides())
    host.start()
    const agent = ctx.spawnAgent(fakeAgent("sess-A", completedTurnEvents(1)))
    ctx.emit("agent/created", { agent })

    fireIdle(agent)
    await quiesce(10)
    assert.equal(server.calls.length, 1, "the automatic run starts alone")

    const manualPromise = host.verifySession("sess-A")
    await quiesce(10)
    assert.equal(server.calls.length, 1, "the manual request must queue behind the active auto run")

    agent.session.events = completedTurnEvents(1).concat(completedTurnEvents(2))
    fireIdle(agent)
    await quiesce(10)
    assert.equal(server.calls.length, 1, "newer turns wait while a run is active")

    g1.resolve()
    await quiesce(20)
    assert.equal(server.calls.length, 2, "the manual run starts only after the auto run finished")
    gm.resolve()
    const manualRecord = await manualPromise
    assert.equal(manualRecord.sessionId, "sess-A")
    assert.equal(manualRecord.turn, 1)

    await quiesce(20)
    assert.equal(server.calls.length, 3, "the queued newer turn runs next")

    g2.resolve()
    await quiesce(20)
    agent.session.events = agent.session.events.concat(completedTurnEvents(3))
    fireIdle(agent)
    await quiesce(20)
    assert.equal(server.calls.length, 4, "a later idle still gets its own serialized run")
    g3.resolve()
    await quiesce(30)

    assert.equal(server.maxInFlight, 1, "at most one lane request may be in flight for the whole scenario")
    assert.deepEqual(host.snapshot().records.map(record => record.turn), [3, 2, 1, 1])
  } finally { server.restore() }
})

test("phase0: manual verify resolves with its own record even when another session's run interleaves", async () => {
  const { VerifierHost } = await import("../lib/index.js")
  const server = mockLaneServer()
  try {
    const ga = deferred()
    const gb = deferred()
    server.enqueue(call => gatedLane(call, ga))
    server.enqueue(call => gatedLane(call, gb))
    const ctx = fakeContext()
    const host = new VerifierHost(ctx, hostOverrides())
    host.start()
    const a = ctx.spawnAgent(fakeAgent("sess-A", completedTurnEvents(1)))
    const b = ctx.spawnAgent(fakeAgent("sess-B", completedTurnEvents(1, "Other task.")))
    ctx.emit("agent/created", { agent: a })
    ctx.emit("agent/created", { agent: b })

    const pa = host.verifySession("sess-A")
    await quiesce(10)
    const pb = host.verifySession("sess-B")
    await quiesce(10)
    assert.equal(server.calls.length, 2, "different sessions may run concurrently")

    ga.resolve()
    const recordA = await pa
    assert.equal(recordA.sessionId, "sess-A", "the response must carry the requesting session's record, not records[0]")
    assert.equal(recordA.turn, 1)
    assert.ok(recordA.aggregate && recordA.aggregate.valid.length === 1)

    gb.resolve()
    const recordB = await pb
    assert.equal(recordB.sessionId, "sess-B")
    assert.notEqual(recordA.id, recordB.id)
    assert.equal(server.maxInFlight, 2, "cross-session concurrency is preserved")
  } finally { server.restore() }
})

test("phase0: a disposed agent's stale status listener cannot start verification, a re-created one can", async () => {
  const { VerifierHost } = await import("../lib/index.js")
  const server = mockLaneServer()
  try {
    server.enqueueBody(laneSuccessBody())
    const ctx = fakeContext()
    const host = new VerifierHost(ctx, hostOverrides())
    host.start()
    const agent = ctx.spawnAgent(fakeAgent("sess-D", completedTurnEvents(1)))
    ctx.emit("agent/created", { agent })
    ctx.emit("agent/disposed", { agent })
    fireIdle(agent)
    await quiesce(40)
    assert.equal(host.snapshot().records.length, 0, "no run may start from a revoked listener")

    const replacement = ctx.spawnAgent(fakeAgent("sess-D", completedTurnEvents(1)))
    ctx.emit("agent/created", { agent: replacement })
    fireIdle(replacement)
    await quiesce(40)
    const records = host.snapshot().records
    assert.equal(records.length, 1, "a freshly attached agent with the same id verifies normally")
    assert.equal(records[0].status, "completed")
  } finally { server.restore() }
})

test("phase0: a throwing SSE subscriber cannot break config updates or other subscribers", async () => {
  const { VerifierHost } = await import("../lib/index.js")
  const ctx = fakeContext()
  const host = new VerifierHost(ctx, hostOverrides())
  host.start()
  host.subscribe(() => { throw new Error("sse connection died") })
  let good = 0
  const off = host.subscribe(() => { good += 1 })
  let thrown = null
  try { host.setConfig({ scoreThreshold: 0.5 }) } catch (error) { thrown = error }
  assert.equal(thrown, null, "a broken subscriber must not turn a config update into an error")
  assert.equal(host.getConfig().scoreThreshold, 0.5, "the config update itself must still land")
  assert.equal(good, 1, "healthy subscribers must still be notified")
  off()
})

test("phase0: a trace-building crash becomes a failed record without an unhandled rejection", async () => {
  const seenBefore = __unhandledRejections.length
  const { VerifierHost } = await import("../lib/index.js")
  const server = mockLaneServer()
  try {
    server.enqueueBody(laneSuccessBody())
    const ctx = fakeContext()
    const host = new VerifierHost(ctx, hostOverrides())
    host.start()
    const cyclic = { name: "cyclic" }
    cyclic.self = cyclic
    const events = [
      { type: "turn/start", seq: 1, data: { turn: 1 } },
      { type: "user/message", seq: 2, data: { source: { kind: "user" }, turn: 1, content: "Build the widget." } },
      { type: "tool/result", seq: 3, data: { turn: 1, message: "ok output" } },
      { type: "tool/result", seq: 4, data: { turn: 1, message: cyclic } },
      { type: "assistant/message", seq: 5, data: { turn: 1, content: "Done." } },
      { type: "turn/end", seq: 6, data: { turn: 1 } },
    ]
    const agent = ctx.spawnAgent(fakeAgent("sess-C", events))
    ctx.emit("agent/created", { agent })
    fireIdle(agent)
    await quiesce(60)
    const records = host.snapshot().records
    assert.equal(records.length, 1)
    assert.equal(records[0].status, "failed", "the crashed run must reach a terminal record, not stay running forever")
    assert.match(String(records[0].error), /circular/i)
    assert.equal(__unhandledRejections.length, seenBefore, "the auto idle path must not leak an unhandled rejection")

    server.enqueueBody(laneSuccessBody())
    agent.session.events = completedTurnEvents(2)
    fireIdle(agent)
    await quiesce(60)
    const after = host.snapshot().records
    assert.equal(after.length, 2, "the scheduler stays healthy for the next turn")
    assert.equal(after[0].status, "completed")
  } finally { server.restore() }
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

test("phase0: settlement of an in-flight run uses the config snapshot taken at run start", async () => {
  const { VerifierHost } = await import("../lib/index.js")
  const server = mockLaneServer()
  try {
    const gate = deferred()
    server.enqueue(call => gatedLane(call, gate, laneLowScoreBody))
    const ctx = fakeContext()
    const host = new VerifierHost(ctx, hostOverrides())
    host.start()
    const agent = ctx.spawnAgent(fakeAgent("sess-S", completedTurnEvents(1)))
    ctx.emit("agent/created", { agent })
    fireIdle(agent)
    await quiesce(20)
    assert.equal(server.calls.length, 1, "lane request in flight")

    host.setConfig({ scoreThreshold: 0.30, maxFeedbackPerSession: 0 })
    gate.resolve()
    await quiesce(40)
    const record = host.snapshot().records[0]
    assert.equal(record.status, "completed")
    assert.equal(record.feedbackSent, true, "a concrete finding citing a tool result may request review")
    assert.equal(record.feedbackSuppressed, undefined)
    assert.equal(agent.followups.length, 1)
  } finally { server.restore() }
})

test("phase0: manual verification keeps force semantics — a bare continuation turn is scored, not skipped", async () => {
  const { VerifierHost } = await import("../lib/index.js")
  const server = mockLaneServer()
  try {
    server.enqueueBody(laneSuccessBody())
    const ctx = fakeContext()
    const host = new VerifierHost(ctx, hostOverrides())
    host.start()
    const events = [
      { type: "turn/start", seq: 1, data: { turn: 1 } },
      { type: "user/message", seq: 2, data: { source: { kind: "user" }, turn: 1, content: "Fix routing." } },
      { type: "assistant/message", seq: 3, data: { turn: 1, content: "Routing fixed." } },
      { type: "turn/end", seq: 4, data: { turn: 1 } },
      { type: "turn/start", seq: 100, data: { turn: 2 } },
      { type: "user/message", seq: 101, data: { source: { kind: "user" }, turn: 2, content: "继续" } },
      { type: "assistant/message", seq: 102, data: { turn: 2, content: "无新增改动。" } },
      { type: "turn/end", seq: 103, data: { turn: 2 } },
    ]
    const agent = ctx.spawnAgent(fakeAgent("sess-F", events))
    ctx.emit("agent/created", { agent })
    const record = await host.verifySession("sess-F")
    assert.ok(record, "manual verification returns its own record")
    assert.equal(record.status, "completed", "force must bypass the bare-status skip gate")
    assert.equal(record.skippedReason, undefined)
    assert.equal(server.calls.length, 1)
  } finally { server.restore() }
})

test("phase0: rapid auto idles collapse to the newest pending turn and stay serial", async () => {
  const { VerifierHost } = await import("../lib/index.js")
  const server = mockLaneServer()
  try {
    const g1 = deferred()
    server.enqueue(call => gatedLane(call, g1))
    server.enqueueBody(laneSuccessBody())
    const ctx = fakeContext()
    const host = new VerifierHost(ctx, hostOverrides())
    host.start()
    const agent = ctx.spawnAgent(fakeAgent("sess-H", completedTurnEvents(1)))
    ctx.emit("agent/created", { agent })
    fireIdle(agent)
    await quiesce(10)
    agent.session.events = completedTurnEvents(1).concat(completedTurnEvents(2))
    fireIdle(agent)
    agent.session.events = agent.session.events.concat(completedTurnEvents(3))
    fireIdle(agent)
    await quiesce(20)
    assert.equal(server.calls.length, 1, "queued turns must collapse to newest while blocked")
    g1.resolve()
    await quiesce(40)
    assert.equal(server.calls.length, 2, "exactly one collapsed run executes afterwards")
    assert.deepEqual(host.snapshot().records.map(record => record.turn), [3, 1])
    assert.equal(server.maxInFlight, 1)
  } finally { server.restore() }
})

test("phase0: disposing mid-run aborts the lane request, finalizes the record, and never sends follow-up", async () => {
  const { VerifierHost } = await import("../lib/index.js")
  const server = mockLaneServer()
  try {
    const gate = deferred()
    server.enqueue(call => gatedLane(call, gate, laneLowScoreBody))
    const ctx = fakeContext()
    const host = new VerifierHost(ctx, hostOverrides())
    host.start()
    const agent = ctx.spawnAgent(fakeAgent("sess-G", completedTurnEvents(1)))
    ctx.emit("agent/created", { agent })
    fireIdle(agent)
    await quiesce(20)
    assert.equal(server.calls.length, 1)
    host.dispose()
    await quiesce(20)
    gate.resolve()
    await quiesce(40)
    const records = host.snapshot().records
    assert.equal(records.length, 1)
    assert.notEqual(records[0].status, "running", "an aborted run must still reach a terminal record")
    assert.equal(agent.followups.length, 0, "dispose must fence the feedback follow-up")

    agent.session.events = completedTurnEvents(2)
    fireIdle(agent)
    await quiesce(30)
    assert.equal(host.snapshot().records.length, 1, "a disposed host schedules nothing further")
  } finally { server.restore() }
})

test("phase0: a stalled feedback followup times out and releases the session queue", async () => {
  const { VerifierHost } = await import("../lib/index.js")
  const server = mockLaneServer()
  const stalled = deferred()
  let host
  try {
    server.enqueueBody(laneLowScoreBody())
    server.enqueueBody(laneSuccessBody())
    const ctx = fakeContext()
    host = new VerifierHost(ctx, hostOverrides(), { feedbackTimeoutMs: 15 })
    host.start()
    const agent = ctx.spawnAgent(fakeAgent("sess-followup-timeout", completedTurnEvents(1)))
    agent.followup = message => { agent.followups.push(message); return stalled.promise }
    ctx.emit("agent/created", { agent })
    fireIdle(agent)
    await quiesce(60)

    const first = host.snapshot().records[0]
    assert.equal(first.status, "completed")
    assert.equal(first.feedbackSent, false)
    assert.equal(first.feedbackError, "feedback-timeout")

    agent.followup = async message => { agent.followups.push(message) }
    agent.session.events = completedTurnEvents(2)
    fireIdle(agent)
    await quiesce(40)
    assert.equal(server.calls.length, 2, "the next completed turn starts after the bounded feedback wait")
    assert.equal(host.snapshot().records[0].turn, 2)
  } finally {
    host?.dispose()
    stalled.resolve()
    server.restore()
  }
})

test("phase0: POST /verify reports lifecycle aborts as 503 instead of a missing session", async () => {
  const { VerifierHost, apiRoutes } = await import("../lib/index.js")
  const server = mockLaneServer()
  try {
    const gate = deferred()
    server.enqueue(call => gatedLane(call, gate))
    const ctx = fakeContext()
    const host = new VerifierHost(ctx, hostOverrides())
    host.start()
    const agent = ctx.spawnAgent(fakeAgent("sess-abort", completedTurnEvents(1)))
    ctx.emit("agent/created", { agent })
    fireIdle(agent)
    await quiesce(15)
    assert.equal(server.calls.length, 1)

    const route = apiRoutes(host).find(item => item.path.endsWith("/verify"))
    const res = fakeRes()
    const pending = route.handler(fakeReq({ sessionId: "sess-abort" }), res)
    await quiesce(10)
    host.dispose()
    await pending
    assert.equal(res.status, 503)
    assert.ok(res.bodyText.includes("verification-aborted"))
    gate.resolve()

    const unknown = fakeRes()
    await route.handler(fakeReq({ sessionId: "sess-unknown" }), unknown)
    assert.equal(unknown.status, 404, "unknown sessions retain the not-found response")
  } finally { server.restore() }
})

test("phase0: coordinator dispose aborts queued manual waiters and rejects further scheduling", async () => {
  const { VerificationCoordinator } = await import("../lib/index.js")
  const ran = []
  const coordinator = new VerificationCoordinator({
    run: async entry => {
      ran.push(entry.bounds.turn)
      await new Promise(resolve => setTimeout(resolve, 15))
      return "ran-" + entry.bounds.turn
    },
  })
  const boundsOf = turn => ({ start: { type: "turn/start", seq: turn * 10, data: { turn } }, end: { type: "turn/end", seq: turn * 10 + 4, data: { turn } }, turn })
  assert.equal(coordinator.scheduleAuto("s", {}, boundsOf(1)), true)
  const manual = coordinator.scheduleManual("s", {}, boundsOf(2))
  await quiesce(5)
  coordinator.dispose()
  const outcome = await manual
  assert.equal(outcome.status, "aborted")
  assert.deepEqual(ran, [1], "only the already-active run finishes")
  assert.equal(coordinator.scheduleAuto("s", {}, boundsOf(3)), false, "scheduling after disposal is refused")
})

test("phase0: coordinator replaces pending autos with the newest turn and preserves queued manuals", async () => {
  const { VerificationCoordinator } = await import("../lib/index.js")
  const gates = [deferred(), deferred(), deferred(), deferred()]
  let index = 0
  const order = []
  const coordinator = new VerificationCoordinator({
    run: async entry => {
      order.push(entry.kind + ":" + entry.bounds.turn)
      const gate = gates[index]
      index += 1
      await gate.promise
      return entry.bounds.turn
    },
  })
  const boundsOf = turn => ({ start: { type: "turn/start", seq: turn * 10, data: { turn } }, end: { type: "turn/end", seq: turn * 10 + 4, data: { turn } }, turn })
  coordinator.scheduleAuto("s", {}, boundsOf(1))
  await quiesce(5)
  coordinator.scheduleAuto("s", {}, boundsOf(2))
  coordinator.scheduleManual("s", {}, boundsOf(3))
  coordinator.scheduleManual("s", {}, boundsOf(5))
  coordinator.scheduleAuto("s", {}, boundsOf(4))
  gates[0].resolve(); await quiesce(10)
  gates[1].resolve(); await quiesce(10)
  gates[2].resolve(); await quiesce(10)
  gates[3].resolve(); await quiesce(10)
  assert.deepEqual(order, ["auto:1", "manual:3", "manual:5", "auto:4"], "manuals stay FIFO while jumping ahead of autos")
  coordinator.forgetSession("s")
  assert.equal(coordinator.sessionCount(), 0, "forgetting an idle session releases its coordinator state")
})

test("phase0: forgetSession aborts queued manual waiters and reclaims the session once the active run settles", async () => {
  const { VerificationCoordinator } = await import("../lib/index.js")
  const gate = deferred()
  const ran = []
  const coordinator = new VerificationCoordinator({
    run: async entry => {
      ran.push(entry.kind + ":" + entry.bounds.turn)
      await gate.promise
      return entry.bounds.turn
    },
  })
  const boundsOf = turn => ({ start: { type: "turn/start", seq: turn * 10, data: { turn } }, end: { type: "turn/end", seq: turn * 10 + 4, data: { turn } }, turn })
  coordinator.scheduleAuto("s", {}, boundsOf(1))
  await quiesce(5)
  const m1 = coordinator.scheduleManual("s", {}, boundsOf(2))
  const m2 = coordinator.scheduleManual("s", {}, boundsOf(3))
  assert.equal(coordinator.pendingCount("s"), 2, "both manual waiters are queued in FIFO order")
  coordinator.forgetSession("s")
  assert.deepEqual(await m1, { status: "aborted" })
  assert.deepEqual(await m2, { status: "aborted" })
  assert.equal(coordinator.pendingCount("s"), 0, "forgetting drops all queued work immediately")
  assert.equal(coordinator.isActive("s"), true, "an already-active run is left alone to reach its terminal record")
  gate.resolve()
  await quiesce(20)
  assert.deepEqual(ran, ["auto:1"], "aborted manuals must never execute")
  assert.equal(coordinator.sessionCount(), 0, "the forgotten session's state is released after its active run settles")
  assert.equal(coordinator.scheduleAuto("s", {}, boundsOf(9)), true, "a fresh callback for the same id starts clean")
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

// ---------- phase 1: task/evidence layering + provider egress policy ----------
//
// Legacy verifier evidence/egress scope indexed in HANDOFF.md §7.1: a session without any direct
// task must never enter five-lane verification against the placeholder;
// rendered lines carry provenance so citation auditing only credits
// independent execution evidence; provider egress is redacted and the
// baseURL/eval/probe surfaces get explicit policy limits.

test("phase1: a session with no direct task anywhere is skipped without consuming lanes or quota", async () => {
  const { VerifierHost } = await import("../lib/index.js")
  const server = mockLaneServer()
  try {
    const ctx = fakeContext()
    const host = new VerifierHost(ctx, hostOverrides())
    host.start()
    // Injection-only turn WITH tools: the legacy shape used to reach five-lane
    // verification against the "Current agent task" placeholder.
    const events = [
      { type: "turn/start", seq: 100, data: { turn: 2 } },
      { type: "user/message", seq: 101, data: { source: { kind: "plugin", plugin: "dsh-system-prompt" }, content: "runtime context snapshot" } },
      { type: "tool/call", seq: 102, data: { name: "pwsh", arguments: "npm test", turn: 2 } },
      { type: "tool/result", seq: 103, data: { turn: 2, message: "tests 5 passed" } },
      { type: "assistant/message", seq: 104, data: { turn: 2, content: "Done." } },
      { type: "turn/end", seq: 105, data: { turn: 2 } },
    ]
    const agent = ctx.spawnAgent(fakeAgent("sess-T", events))
    ctx.emit("agent/created", { agent })
    fireIdle(agent)
    await quiesce(30)
    const records = host.snapshot().records
    assert.equal(records.length, 1)
    assert.equal(records[0].status, "skipped", "task-less turns must be recorded as skipped")
    assert.equal(records[0].skippedReason, "no-direct-task")
    assert.equal(server.calls.length, 0, "no lane spend without a task")

    const manualRecord = await host.verifySession("sess-T")
    assert.ok(manualRecord)
    assert.equal(manualRecord.status, "skipped", "manual force must not bypass the no-task skip")
    assert.equal(server.calls.length, 0, "manual force still must not consume lanes")
  } finally { server.restore() }
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

test("phase1: host records flag assistant-only citations while tool-result citations pass", async () => {
  const { VerifierHost } = await import("../lib/index.js")
  // Rendered order: E01 user task, E02 assistant claim, E03 tool result.
  const events = [
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "user/message", seq: 2, data: { source: { kind: "user" }, turn: 1, content: "Ship the retry fix." } },
    { type: "assistant/message", seq: 3, data: { turn: 1, content: "Everything works now." } },
    { type: "tool/result", seq: 4, data: { turn: 1, message: "npm test -> tests 5 passed" } },
    { type: "turn/end", seq: 5, data: { turn: 1 } },
  ]

  const runOnce = async findingText => {
    const server = mockLaneServer()
    try {
      server.enqueueBody({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: ["Analysis.", "finding: " + findingText, "<score_A> K </score_A>", "<score_B> M </score_B>"].join(LF) }, logprobs: { content: scorePositions() } }] })
      const ctx = fakeContext()
      const host = new VerifierHost(ctx, hostOverrides())
      host.start()
      const agent = ctx.spawnAgent(fakeAgent("sess-P" + Math.random().toString(36).slice(2, 8), events))
      ctx.emit("agent/created", { agent })
      fireIdle(agent)
      await quiesce(40)
      return host.snapshot().records[0]
    } finally { server.restore() }
  }

  const claimOnlyRecord = await runOnce("success was asserted without proof [E02]")
  assert.equal(claimOnlyRecord.status, "completed")
  assert.equal(claimOnlyRecord.citationAudit.findingsWithoutIndependentCitation, 1, "assistant-only citation is flagged as unsupported")

  const groundedRecord = await runOnce("tool output proves the tests ran [E03]")
  assert.equal(groundedRecord.citationAudit.findingsWithoutIndependentCitation, 0, "tool-result citation keeps full credit")
})

test("phase1: redactSecrets strips credentials from provider-bound text without touching normal lines", async () => {
  const { redactSecrets } = await import("../lib/verifier.js")
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
  const { verifyRoute } = await import("../lib/verifier.js")
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

test("phase1: config rejects non-http(s) or credentialed baseURL values", async () => {
  const { VerifierHost } = await import("../lib/index.js")
  const ctx = fakeContext()
  const host = new VerifierHost(ctx, hostOverrides())
  host.start()
  // Note: WHATWG parsing normalizes 'http:///v1' to host 'v1', which is a
  // syntactically valid target — scheme/userinfo/host are the policy gates,
  // not slash counts.
  for (const bad of ["ftp://relay.example.com/v1", "https://user:pass@host.example.com/v1", "not a url"]) {
    assert.throws(() => host.setConfig({ baseURL: bad }), /baseURL/, "must reject: " + bad)
  }
  host.setConfig({ baseURL: "https://api.example.com/v1" })
  assert.equal(host.getConfig().baseURL, "https://api.example.com/v1")
})

test("phase1: lanes fail fast with a non-transient error when the configured baseURL is unusable", async () => {
  const { verifyRoute } = await import("../lib/verifier.js")
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

test("phase1: /eval validates before consuming its rate-limit bucket", async () => {
  const { VerifierHost, apiRoutes, API_RATE_LIMITS } = await import("../lib/index.js")
  const host = new VerifierHost(fakeContext(), hostOverrides())
  const evalRoute = apiRoutes(host).find(route => route.path.endsWith("/eval"))
  assert.ok(evalRoute, "/eval route exported for policy enforcement")
  const quota = API_RATE_LIMITS.evalPerMinute
  assert.ok(quota >= 20, "the quota must stay far above legitimate eval usage")
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => successBody })
  try {
    const invalid = fakeRes()
    await evalRoute.handler(fakeReq({ problem: "p", trace: "" }), invalid)
    assert.equal(invalid.status, 400, "invalid input is rejected before quota accounting")
    const wrongType = fakeRes()
    await evalRoute.handler({ ...fakeReq({ problem: "p", trace: "valid trace" }), headers: {} }, wrongType)
    assert.equal(wrongType.status, 415, "content type is rejected before quota accounting")
    const responses = []
    for (let i = 0; i <= quota; i += 1) {
      const res = fakeRes()
      await evalRoute.handler(fakeReq({ problem: "p", trace: "valid trace" }), res)
      responses.push({ status: res.status, bodyText: res.bodyText })
    }
    for (let i = 0; i < quota; i += 1) assert.equal(responses[i].status, 200, "valid requests consume the bucket")
    assert.equal(responses[quota].status, 429, "the request after the window quota is throttled")
    assert.ok(responses[quota].bodyText.includes("rate-limited"))
  } finally { globalThis.fetch = originalFetch }
})

test("phase1: /probe has an independent rate-limit bucket from /eval", async () => {
  const { VerifierHost, apiRoutes, API_RATE_LIMITS } = await import("../lib/index.js")
  const host = new VerifierHost(fakeContext(), hostOverrides())
  const routeList = apiRoutes(host)
  const evalRoute = routeList.find(route => route.path.endsWith("/eval"))
  const probeRoute = routeList.find(route => route.path.endsWith("/probe"))
  const originalFetch = globalThis.fetch
  // A non-transient local stand-in exercises each bucket without retry sleeps.
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({}) })
  try {
    for (let i = 0; i <= API_RATE_LIMITS.evalPerMinute; i += 1) await evalRoute.handler(fakeReq({ problem: "p", trace: "valid trace" }), fakeRes())
    const malformedProbe = fakeRes()
    await probeRoute.handler(fakeReq(null), malformedProbe)
    assert.equal(malformedProbe.status, 400, "a non-object probe body is rejected before quota accounting")
    assert.ok(malformedProbe.bodyText.includes("json-object-required"))
    const res = fakeRes()
    await probeRoute.handler(fakeReq({}), res)
    assert.equal(res.status, 200, "an exhausted eval bucket must not throttle the probe bucket")
    let throttled = false
    // The bucket-separation call above consumed one probe slot.
    for (let i = 0; i < API_RATE_LIMITS.probePerMinute - 1; i += 1) {
      const r = fakeRes()
      await probeRoute.handler(fakeReq({}), r)
      if (r.status === 429) { throttled = true; break }
      assert.equal(r.status, 200)
    }
    assert.equal(throttled, false, "the probe quota itself stays available within its window")
  } finally { globalThis.fetch = originalFetch }
})

test("phase1: /verify has an independent rate-limit bucket and rejects bad input before quota accounting", async () => {
  const { VerifierHost, apiRoutes, API_RATE_LIMITS } = await import("../lib/index.js")
  const host = new VerifierHost(fakeContext(), hostOverrides())
  const routeList = apiRoutes(host)
  const evalRoute = routeList.find(route => route.path.endsWith("/eval"))
  const probeRoute = routeList.find(route => route.path.endsWith("/probe"))
  const verifyRoute = routeList.find(route => route.path.endsWith("/verify"))
  assert.ok(verifyRoute, "/verify route exported for policy enforcement")
  assert.equal(API_RATE_LIMITS.verifyPerMinute, 60, "the verify window quota stays pinned at the documented 60/min")
  const originalFetch = globalThis.fetch
  // Benign local stand-ins so draining the sibling buckets touches no network.
  // Status 400 is deliberately NON-transient (no lane-retry backoff sleep), so
  // the drain finishes well inside the sliding window without stamps aging
  // out mid-test.
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({}) })
  try {
    for (let i = 0; i <= API_RATE_LIMITS.evalPerMinute; i += 1) await evalRoute.handler(fakeReq({ problem: "p", trace: "valid trace" }), fakeRes())
    for (let i = 0; i < API_RATE_LIMITS.probePerMinute; i += 1) await probeRoute.handler(fakeReq({}), fakeRes())
    const drainedProbe = fakeRes()
    await probeRoute.handler(fakeReq({}), drainedProbe)
    assert.equal(drainedProbe.status, 429, "control: the probe bucket really is drained")

    // Refusals that happen before the limiter must never consume a verify slot.
    const wrongShape = fakeRes()
    await verifyRoute.handler(fakeReq(null), wrongShape)
    assert.equal(wrongShape.status, 400, "a non-object body is rejected before quota accounting")
    assert.ok(wrongShape.bodyText.includes("json-object-required"))
    const malformed = fakeRes()
    await verifyRoute.handler({ method: "POST", url: "/verify", headers: { "content-type": "application/json" }, [Symbol.asyncIterator]: async function* () { yield Buffer.from("{not json") } }, malformed)
    assert.equal(malformed.status, 400, "malformed JSON is rejected before quota accounting")
    assert.ok(malformed.bodyText.includes("invalid-json-body"))
    const noSession = fakeRes()
    await verifyRoute.handler(fakeReq({}), noSession)
    assert.equal(noSession.status, 400, "a missing sessionId is rejected before quota accounting")
    assert.ok(noSession.bodyText.includes("session-id-required"))

    // Independence: with eval and probe drained, verify still serves its own full window.
    for (let i = 0; i < API_RATE_LIMITS.verifyPerMinute; i += 1) {
      const res = fakeRes()
      await verifyRoute.handler(fakeReq({ sessionId: "sess-unknown" }), res)
      assert.equal(res.status, 404, "request " + i + " passes the untouched verify bucket (unknown session 404s, never 429)")
    }
    const throttled = fakeRes()
    await verifyRoute.handler(fakeReq({ sessionId: "sess-unknown" }), throttled)
    assert.equal(throttled.status, 429, "the request past the verify window quota is throttled")
    assert.ok(throttled.bodyText.includes("rate-limited"))
  } finally { globalThis.fetch = originalFetch }
})

// ---------- phase 2: probe strict-readiness + durable record history ----------
//
// Legacy probe/history contract indexed in HANDOFF.md §3: the probe must report transport /
// protocol / strict-readiness separately through the production parsing path,
// reject malformed bodies, and map upstream status into listModels; finished
// records gain a durable JSONL trail plus a /records query endpoint with
// session/turn/status filters.

test("phase2: probe rejects malformed JSON bodies with 400 instead of probing blind", async () => {
  const { VerifierHost, apiRoutes } = await import("../lib/index.js")
  const host = new VerifierHost(fakeContext(), hostOverrides())
  const probeRoute = apiRoutes(host).find(route => route.path.endsWith("/probe"))
  const original = globalThis.fetch
  let fetchCalled = 0
  globalThis.fetch = async () => { fetchCalled += 1; throw new Error("must not reach provider") }
  try {
    const res = fakeRes()
    await probeRoute.handler({ method: "POST", url: "/probe", headers: { "content-type": "application/json" }, [Symbol.asyncIterator]: async function* () { yield Buffer.from("{not json") } }, res)
    assert.equal(res.status, 400, "malformed input is a client error, not an empty-body probe")
    assert.ok(res.bodyText.includes("invalid-json-body"))
    assert.equal(fetchCalled, 0)
  } finally { globalThis.fetch = original }
})

test("phase2: probe listModels maps upstream failure into ok:false with the real status", async () => {
  const { VerifierHost, apiRoutes } = await import("../lib/index.js")
  const host = new VerifierHost(fakeContext(), hostOverrides())
  const probeRoute = apiRoutes(host).find(route => route.path.endsWith("/probe"))
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: { message: "upstream down" } }) })
  try {
    const res = fakeRes()
    await probeRoute.handler(fakeReq({ listModels: true }), res)
    const body = JSON.parse(res.bodyText)
    assert.equal(res.status, 200)
    assert.equal(body.ok, false, "upstream non-2xx must not report ok:true")
    assert.equal(body.status, 503)
    assert.equal(body.apiError, "upstream down")
  } finally { globalThis.fetch = original }
})

test("phase2 (F10): probe refuses a non-http(s) baseURL before any fetch, even for listModels", async () => {
  const { VerifierHost, apiRoutes } = await import("../lib/index.js")
  // The constructor takes the config verbatim (validation lives in setConfig),
  // so an ftp:// baseURL reaches the route exactly as a misconfigured Host would.
  const host = new VerifierHost(fakeContext(), hostOverrides({ baseURL: "ftp://bad.example.com" }))
  const probeRoute = apiRoutes(host).find(route => route.path.endsWith("/probe"))
  const original = globalThis.fetch
  let fetchCalled = 0
  globalThis.fetch = async () => { fetchCalled += 1; throw new Error("must not reach provider") }
  try {
    const res = fakeRes()
    await probeRoute.handler(fakeReq({ listModels: true }), res)
    assert.equal(res.status, 200)
    const body = JSON.parse(res.bodyText)
    assert.equal(body.ok, false)
    assert.equal(body.errorCode, "invalid_base_url", "the scheme gate reports its own error code")
    assert.equal(body.transportOk, false)
    assert.equal(body.httpStatus, null)
    assert.equal(fetchCalled, 0, "no network attempt may happen for a non-http(s) target, listModels or not")
  } finally { globalThis.fetch = original }
})

test("phase2: probe reports strict readiness through the production lane path", async () => {
  const { VerifierHost, apiRoutes } = await import("../lib/index.js")
  const server = mockLaneServer()
  try {
    const host = new VerifierHost(fakeContext(), hostOverrides())
    const probeRoute = apiRoutes(host).find(route => route.path.endsWith("/probe"))

    server.enqueueBody(laneSuccessBody())
    let res = fakeRes()
    await probeRoute.handler(fakeReq({}), res)
    let body = JSON.parse(res.bodyText)
    assert.equal(res.status, 200)
    assert.equal(body.ok, true, "ok keeps meaning 'handler completed a structured check'")
    assert.equal(body.transportOk, true)
    assert.equal(body.httpStatus, 200)
    assert.equal(body.finish, "stop")
    assert.equal(body.hasScoreTags, true)
    assert.equal(body.scoreTokenLogprobs, true)
    assert.equal(body.strictReady, true, "a fully conforming short answer is strict-ready")

    server.enqueueBody({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "<score_A> K </score_A>" + LF + "<score_B> M </score_B>" } }] })
    res = fakeRes()
    await probeRoute.handler(fakeReq({}), res)
    body = JSON.parse(res.bodyText)
    assert.equal(body.strictReady, false, "tags without token logprobs are not strict-ready")
    assert.equal(body.scoreTokenLogprobs, false)
    assert.equal(body.errorCode, "missing_score_logprobs", "the precise protocol code surfaces")

    // Upstream fault: transient retry fires once inside the production path,
    // then the final transport state is surfaced instead of masked.
    server.enqueue(() => Promise.resolve({ ok: false, status: 503, json: async () => ({ error: { message: "relay hiccup" } }) }))
    server.enqueue(() => Promise.resolve({ ok: false, status: 500, json: async () => ({ error: { message: "still down" } }) }))
    res = fakeRes()
    await probeRoute.handler(fakeReq({}), res)
    body = JSON.parse(res.bodyText)
    assert.equal(body.transportOk, false)
    assert.equal(body.httpStatus, 500)
    assert.equal(body.errorCode, "provider_error")
    assert.equal(body.strictReady, false)

    assert.ok(server.calls.length >= 3 && String(server.calls[0].init.body).includes("verifier lane"), "the probe rides the production lane request shape (redaction + lane instruction included)")
  } finally { server.restore() }
})

test("phase2: /records queries full history with filters while /state stays a recent view", async () => {
  const { VerifierHost, apiRoutes } = await import("../lib/index.js")
  const server = mockLaneServer()
  try {
    for (let i = 0; i < 35; i += 1) server.enqueueBody(laneSuccessBody())
    const ctx = fakeContext()
    const host = new VerifierHost(ctx, hostOverrides())
    host.start()
    const agent = ctx.spawnAgent(fakeAgent("sess-R", completedTurnEvents(1)))
    ctx.emit("agent/created", { agent })
    let events = []
    for (let turn = 1; turn <= 35; turn += 1) {
      events = events.concat(completedTurnEvents(turn))
      agent.session.events = events
      fireIdle(agent)
      await quiesce(12)
    }
    await quiesce(80)

    const recordsRoute = apiRoutes(host).find(route => route.path.endsWith("/records"))
    assert.ok(recordsRoute, "/records query endpoint exists")
    const query = async querystring => {
      const res = fakeRes()
      await recordsRoute.handler(fakeReq({}, "/records" + querystring, "GET"), res)
      return JSON.parse(res.bodyText)
    }

    const all = await query("?limit=500")
    assert.ok(all.total >= 35, "history keeps every finished record, not just the newest handful")
    assert.ok(host.snapshot().records.length <= 20, "/state remains a bounded recent view")

    const bySession = await query("?sessionId=sess-R&limit=500")
    assert.equal(bySession.total, all.total, "session filter matches every run of that session")
    assert.ok(bySession.records.every(record => record.sessionId === "sess-R"))

    const byTurn = await query("?turn=7")
    assert.equal(byTurn.total, 1)
    assert.equal(byTurn.records[0].turn, 7)

    const emptyTurn = await query("?turn=")
    assert.equal(emptyTurn.total, all.total, "an empty turn filter must behave as no filter, not turn zero")

    const emptyLimit = await query("?turn=&limit=")
    assert.equal(emptyLimit.limit, 50, "an empty limit falls back to the default page size of 50")
    assert.equal(emptyLimit.records.length, Math.min(50, all.total), "the defaulted page still slices correctly")
    const noParams = await query("")
    assert.equal(noParams.limit, 50, "an absent limit uses the same default of 50")
    assert.equal(noParams.records.length, Math.min(50, noParams.total))

    const byStatus = await query("?status=completed&limit=500")
    assert.equal(byStatus.total, all.total, "all fixture runs complete")
    assert.ok(byStatus.records.every(record => record.status === "completed"))

    const limited = await query("?limit=2")
    assert.equal(limited.records.length, 2, "limit caps the page but not the reported total")
    assert.equal(limited.total, all.total)

    const none = await query("?sessionId=nobody")
    assert.equal(none.total, 0)
    assert.deepEqual(none.records, [])
  } finally { server.restore() }
})

test("phase2: finished records persist to JSONL and survive a Host restart", async () => {
  const { VerifierHost, apiRoutes } = await import("../lib/index.js")
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  const file = path.join(os.tmpdir(), "dsh-va-test-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".jsonl")
  const server = mockLaneServer()
  try {
    server.enqueueBody(laneSuccessBody())
    const ctx = fakeContext()
    const host = new VerifierHost(ctx, hostOverrides(), { recordsFile: file })
    host.start()
    const agent = ctx.spawnAgent(fakeAgent("sess-X", completedTurnEvents(9)))
    ctx.emit("agent/created", { agent })
    fireIdle(agent)
    await quiesce(50)
    assert.ok(fs.existsSync(file), "records file is created on first terminal record")
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line))
    assert.equal(lines.length, 1)
    assert.equal(lines[0].v, 1, "new persistence rows carry the shared ledger version")
    assert.equal(lines[0].sessionId, "sess-X")
    assert.ok(lines[0].aggregate && lines[0].aggregate.results.length === 1, "per-lane details persist for post-reload diagnostics")
    host.dispose()
    server.restore()

    fs.appendFileSync(file, JSON.stringify({ id: "stale-running", sessionId: "sess-Z", turn: 1, status: "running", startedAt: 1 }) + "\n")
    fs.appendFileSync(file, JSON.stringify({ id: "future-row", sessionId: "sess-future", turn: 1, status: "completed", startedAt: 1, feedbackSent: false, v: 2 }) + "\n")
    const host2 = new VerifierHost(fakeContext(), hostOverrides(), { recordsFile: file })
    host2.start()
    host2.start()
    const recordsRoute = apiRoutes(host2).find(route => route.path.endsWith("/records"))
    const res = fakeRes()
    await recordsRoute.handler(fakeReq({}, "/records", "GET"), res)
    const body = JSON.parse(res.bodyText)
    assert.equal(body.total, 2, "legacy unstamped rows load while unknown future ledger versions are rejected")
    assert.equal(body.records.some(record => record.id === "future-row"), false)
    const stale = body.records.find(record => record.id === "stale-running")
    assert.equal(stale.status, "failed", "a running row from a previous life becomes honestly failed")
    assert.match(String(stale.error), /interrupted-by-reload/)
    const persisted = body.records.find(record => record.sessionId === "sess-X")
    assert.ok(persisted && persisted.aggregate && persisted.aggregate.valid.length === 1, "the completed record survives restart with lanes intact")
    host2.dispose()
  } finally { server.restore(); fs.rmSync(file, { force: true }) }
})

test("phase2: persistence is opt-in — embedded/test hosts without recordsFile stay pure in-memory", async () => {
  const { VerifierHost } = await import("../lib/index.js")
  const fs = await import("node:fs")
  const os = await import("node:os")
  const before = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith("dsh-va-")).length
  const server = mockLaneServer()
  try {
    server.enqueueBody(laneSuccessBody())
    const ctx = fakeContext()
    const host = new VerifierHost(ctx, hostOverrides())
    host.start()
    const agent = ctx.spawnAgent(fakeAgent("sess-N", completedTurnEvents(3)))
    ctx.emit("agent/created", { agent })
    fireIdle(agent)
    await quiesce(40)
    const after = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith("dsh-va-")).length
    assert.equal(after, before, "no records file appears without explicit recordsFile")
    assert.equal(host.snapshot().records.length, 1, "in-memory behavior unchanged")
  } finally { server.restore() }
})

// ---------- phase 2b: closing items ----------
//
// Remaining Phase 2 scope: citations must be audited from the full finding
// (not the 320-char display truncation), feedback gets a structured plugin
// source instead of relying on a forgeable text prefix, model/apiKeyEnv config
// values get sanity bounds, and an optional env token can gate mutating API
// endpoints without touching read-only views.

test("phase2b: citations beyond the display truncation are audited from the full finding", async () => {
  const { VerifierHost } = await import("../lib/index.js")
  const server = mockLaneServer()
  try {
    // Prefix longer than the 320-char display cap pushes the decisive [E02] past it.
    const longPrefix = "The implementation was reviewed across several modules and the trajectory looks broadly consistent with the stated goal overall. " + "Additional neutral review context follows so the display truncation boundary is certainly crossed somewhere in here. ".repeat(3)
    assert.ok(longPrefix.length >= 300)
    server.enqueueBody({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: ["Analysis.", "finding: " + longPrefix + "the tests were never actually executed here [E02]", "<score_A> K </score_A>", "<score_B> M </score_B>"].join(LF) }, logprobs: { content: scorePositions() } }] })
    const ctx = fakeContext()
    const host = new VerifierHost(ctx, hostOverrides())
    host.start()
    const agent = ctx.spawnAgent(fakeAgent("sess-TB1", completedTurnEvents(4)))
    ctx.emit("agent/created", { agent })
    fireIdle(agent)
    await quiesce(50)
    const record = host.snapshot().records[0]
    assert.equal(record.status, "completed")
    assert.equal(record.citationAudit.defectFindings, 1)
    assert.equal(record.citationAudit.defectFindingsWithoutCitation, 0, "the tail citation must resolve from the untruncated finding")
    assert.equal(record.citationAudit.findingsWithoutIndependentCitation, 0, "[E02] is the tool result line: full independent credit")
  } finally { server.restore() }
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

test("phase2b: model and apiKeyEnv config values are sanity-constrained", async () => {
  const { Config, DEFAULT_CONFIG, VerifierHost } = await import("../lib/index.js")
  assert.deepEqual(Config({}), DEFAULT_CONFIG, "the exported defaults are derived from the schema, not a second handwritten table")
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), true)
  const initial = hostOverrides()
  const host = new VerifierHost(fakeContext(), initial)
  initial.model = "mutated-outside-host"
  assert.notEqual(host.getConfig().model, initial.model, "the Host owns a defensive copy of constructor config")
  const exposed = host.getConfig()
  exposed.model = "mutated-through-getter"
  assert.notEqual(host.getConfig().model, exposed.model, "getConfig never leaks the mutable internal object")
  assert.throws(() => host.setConfig({ model: "bad model\nwith newline" }), /config-invalid-string:model/)
  assert.throws(() => host.setConfig({ model: "m".repeat(301) }), /config-invalid-string:model/)
  assert.throws(() => host.setConfig({ apiKeyEnv: "9bad-name" }), /config-invalid-string:apiKeyEnv/)
  assert.throws(() => host.setConfig({ selectionModelStrategy: "bad-strategy" }), /config-selection-model-strategy-invalid/)
  host.setConfig({ selectionModelStrategy: "exploration" })
  assert.equal(host.getConfig().selectionModelStrategy, "exploration")
  host.setConfig({ model: "nvidia/nemotron-3-super-120b-a12b" })
  host.setConfig({ apiKeyEnv: "KIMI_API_KEY_2" })
  host.setConfig({ baseURL: "  https://api.example.test/v1/  " })
  assert.equal(host.getConfig().baseURL, "https://api.example.test/v1/", "a validated baseURL is stored in the same trimmed form used for request construction")
})

test("phase2b: verifierEffort and tournament pivot/round knobs are validated", () => {
  const host = new VerifierHost(fakeContext(), hostOverrides())
  assert.throws(() => host.setConfig({ verifierEffort: "big" }), /config-verifier-effort-invalid/)
  assert.throws(() => host.setConfig({ verifierEffort: true }), /config-verifier-effort-invalid/)
  assert.throws(() => host.setConfig({ selectionPivots: 9 }), /config-out-of-range:selectionPivots/)
  assert.throws(() => host.setConfig({ selectionPivots: -1 }), /config-out-of-range:selectionPivots/)
  assert.throws(() => host.setConfig({ selectionEvaluations: 9 }), /config-out-of-range:selectionEvaluations/)
  host.setConfig({ verifierEffort: "low" })
  host.setConfig({ selectionPivots: 4 })
  host.setConfig({ selectionEvaluations: 6 })
  assert.equal(host.getConfig().verifierEffort, "low")
  assert.equal(host.getConfig().selectionPivots, 4)
  assert.equal(host.getConfig().selectionEvaluations, 6)
})

test("phase2b: DSH_VA_API_TOKEN gates mutating endpoints while reads stay open", async () => {
  const { API_PREFIX, VerifierHost, apiRoutes } = await import("../lib/index.js")
  process.env.DSH_VA_API_TOKEN = "secret-token"
  try {
    const host = new VerifierHost(fakeContext(), hostOverrides())
    const routeList = apiRoutes(host)
    assert.ok(routeList.every(route => route.path.startsWith(API_PREFIX + "/")), "every server route is rooted at the shared protocol prefix")
    const evalRoute = routeList.find(route => route.path.endsWith("/eval"))
    const recordsRoute = routeList.find(route => route.path.endsWith("/records"))
    let res = fakeRes()
    await evalRoute.handler(fakeReq({ problem: "p", trace: "" }), res)
    assert.equal(res.status, 403, "mutating endpoint rejects unauthenticated callers when a token is configured")

    res = fakeRes()
    await evalRoute.handler({ ...fakeReq({ problem: "p", trace: "" }), headers: { "content-type": "application/json", authorization: "Bearer secret-token" } }, res)
    assert.equal(res.status, 400, "authorized caller proceeds to normal validation (empty trace)")

    res = fakeRes()
    await recordsRoute.handler(fakeReq({}, "/records", "GET"), res)
    assert.equal(res.status, 200, "read-only views stay open to local operators")
  } finally { delete process.env.DSH_VA_API_TOKEN }
})

// ---------- phase 3: repair-v2 preregistration tooling ----------
//
// HANDOFF.md §7.1 preserves the preregistration boundary: metrics precede any live
// experiment. This section locks the deterministic scenario generator and the
// four-metric calculator so the experiment runs on stable ground truth.

const REPAIR_V2 = "../eval/repair-v2.mjs"

test("phase3: scenario generation is seeded, deterministic, and produces the requested mix", async () => {
  const { generateScenarios, parseRepairV2Args } = await import(REPAIR_V2)
  assert.deepEqual(parseRepairV2Args([]), { seed: 7, defect: 20, clean: 10, out: undefined }, "CLI defaults match the preregistered live scenario set")
  assert.deepEqual(parseRepairV2Args(["--seed=11", "--defect=6", "--clean=3", "--out=run.json"]), { seed: 11, defect: 6, clean: 3, out: "run.json" })
  assert.equal(parseRepairV2Args(["--seed=-1", "--defect=0", "--clean=0"]).seed, -1, "all integer seeds accepted by generateScenarios stay CLI-compatible")
  assert.throws(() => parseRepairV2Args(["--out-dir=run.json"]), /unknown-or-malformed-flag/)
  assert.throws(() => parseRepairV2Args(["--seed=not-a-number"]), /flag-seed-integer-required/)
  assert.throws(() => parseRepairV2Args(["--defect=-1"]), /flag-defect-nonnegative-integer-required/)
  const a = generateScenarios({ seed: 11, defectCount: 6, cleanCount: 3 })
  const b = generateScenarios({ seed: 11, defectCount: 6, cleanCount: 3 })
  assert.deepEqual(a, b, "same seed must reproduce byte-identical scenarios")
  assert.equal(a.length, 9)
  assert.equal(a.filter(s => s.kind === "defect").length, 6)
  assert.equal(a.filter(s => s.kind === "clean").length, 3)
  const c = generateScenarios({ seed: 12, defectCount: 6, cleanCount: 3 })
  assert.notDeepEqual(a, c, "different seeds must diverge")
  for (const s of a) {
    assert.ok(s.id && s.problem && s.files && Array.isArray(s.checks) && s.checks.length >= 1, "scenario carries brief, files and checks")
    if (s.kind === "defect") assert.ok(s.plantedFlaw, "defect scenarios declare their planted flaw")
    else assert.equal(s.plantedFlaw, undefined)
  }
})

test("phase3: generated task briefs never leak evaluation constraints", async () => {
  const { generateScenarios } = await import(REPAIR_V2)
  const forbidden = ["测试", "试验", "验证", "评分", "verifier", "预期失败", "禁止运行", "不要运行", "不得运行", "hidden", "trap", "缺陷", "bug planted", "eval"]
  for (const s of generateScenarios({ seed: 3, defectCount: 8, cleanCount: 4 })) {
    for (const word of forbidden) {
      assert.ok(!s.problem.toLowerCase().includes(word.toLowerCase()), `brief "${s.id}" must not leak "${word}"`)
    }
  }
})

test("phase3: defect scenarios carry an initially-failing check; clean ones never do", async () => {
  const { generateScenarios } = await import(REPAIR_V2)
  for (const s of generateScenarios({ seed: 5, defectCount: 6, cleanCount: 4 })) {
    const failing = s.checks.filter(check => check.initial === "fail")
    if (s.kind === "defect") {
      assert.ok(failing.length >= 1, s.id + " must embed at least one initially-failing independent check")
      for (const check of s.checks) assert.ok(check.command.includes("node "), "checks are plain node commands")
    } else {
      assert.equal(failing.length, 0, s.id + " is clean: no check may start failing")
    }
  }
})

test("phase3: computeRepairMetrics matches the hand-computed preregistration fixture", async () => {
  const { computeRepairMetrics } = await import(REPAIR_V2)
  const run = (kind, fields) => ({ kind, ...fields })
  const runs = [
    run("defect", { triggered: true, repaired: true, repairValid: true, regressed: false }),
    run("defect", { triggered: true, repaired: true, repairValid: true, regressed: false }),
    run("defect", { triggered: true, repaired: true, repairValid: false, regressed: true }),
    run("defect", { triggered: true, repaired: false }),
    run("defect", { triggered: false }),
    run("defect", { triggered: false }),
    run("defect", { triggered: false }),
    run("defect", { triggered: false }),
    run("clean", { triggered: true }),
    run("clean", { triggered: false }),
    run("clean", { triggered: false }),
    run("clean", { triggered: false }),
  ]
  const m = computeRepairMetrics(runs)
  assert.equal(m.defectScenarios, 8)
  assert.equal(m.cleanScenarios, 4)
  assert.equal(m.triggers, 4)
  assert.equal(m.triggerRate, 0.5)
  assert.equal(m.nuisanceTriggers, 1)
  assert.equal(m.nuisanceRate, 0.25)
  assert.equal(m.repairsAttempted, 3)
  assert.equal(m.validRepairs, 2)
  assert.equal(m.validRepairRate, 2 / 3)
  assert.equal(m.regressions, 1)
  assert.equal(m.regressionRate, 1 / 3)
})

test("phase3: regression rate excludes clean controls from the defect-repair denominator and numerator", async () => {
  const { computeRepairMetrics } = await import(REPAIR_V2)
  const m = computeRepairMetrics([
    { kind: "defect", repaired: true, regressed: true },
    { kind: "defect", repaired: true, regressed: false },
    { kind: "clean", triggered: true, regressed: true },
    { kind: "clean", regressed: true },
  ])
  assert.equal(m.regressions, 1, "clean controls are measured by nuisanceRate, not the defect repair regression metric")
  assert.equal(m.regressionRate, 1 / 2)
})

test("phase3: metrics handle empty input and reject malformed rows", async () => {
  const { computeRepairMetrics } = await import(REPAIR_V2)
  const empty = computeRepairMetrics([])
  assert.equal(empty.triggerRate, null, "zero denominators report null, never 0 or NaN")
  assert.equal(empty.nuisanceRate, null)
  assert.equal(empty.validRepairRate, null)
  assert.equal(empty.regressionRate, null)
  assert.throws(() => computeRepairMetrics([{ kind: "mystery" }]), /unknown scenario kind/)
  assert.throws(() => computeRepairMetrics([{ triggered: true }]), /missing kind/)
})

test("phase3: every check requires a module that exists in the emitted files map", async () => {
  const { generateScenarios } = await import(REPAIR_V2)
  for (const s of generateScenarios({ seed: 99, defectCount: 12, cleanCount: 6 })) {
    const checkPath = "checks/" + s.checks[0].name + ".check.js"
    const body = s.files[checkPath]
    assert.ok(typeof body === "string", s.id + " emits its check file")
    const required = []
    let cursor = body.indexOf("require('../")
    while (cursor !== -1) {
      const start = cursor + "require('../".length
      const end = body.indexOf("'", start)
      if (end === -1) break
      required.push(body.slice(start, end))
      cursor = body.indexOf("require('../", end)
    }
    assert.ok(required.length >= 1, s.id + " check requires its subject module")
    for (const rel of required) {
      assert.ok(s.files[rel] !== undefined, s.id + ": required module '" + rel + "' must exist in files")
    }
    assert.ok(s.files["src/" + s.checks[0].name + ".js"] !== undefined, s.id + ": src module uses the id-derived name")
  }
})

// ---------- best-of-N selection bridge (Phase 1) ----------
//
// Offline protocol tests for src/selection/bridge.ts: happy path, timeout,
// crash, abort, dispose, error passthrough. Boundary semantics run against
// the REAL sidecar (empty/single candidates never touch the network).

const BRIDGE_PY = process.env.DSH_VA_PYTHON
  || (process.platform === "win32" ? "D:/tools/pyvenvs/llm-verifier-bridge/Scripts/python.exe" : "python3")
const STUB_SIDECAR = fileURLToPath(new URL("./fixtures/stub_sidecar.py", import.meta.url))
const REAL_SIDECAR = fileURLToPath(new URL("../bridge/llm_verifier_sidecar.py", import.meta.url))

function mkBridge(scriptPath, opts = {}) {
  return new VerifierBridge({
    pythonPath: BRIDGE_PY,
    scriptPath,
    shutdownGraceMs: 300,
    ...opts,
  })
}

const bridgeReq = (over = {}) => ({
  problem: "demo pair",
  candidates: ["cand-0", "cand-1"],
  criteria: { c1: "demo criterion" },
  model: "m", baseUrl: "http://127.0.0.1:9/v1",
  apiKey: "dummy", apiKeyEnv: "SMOKE_KEY",
  ...over,
})

test("bridge: stub health roundtrip", async () => {
  const bridge = mkBridge(STUB_SIDECAR)
  try {
    const health = await bridge.health({ timeoutMs: 15000 })
    assert.equal(health.select_available, true)
    assert.equal(health.python, "stub")
  } finally { await bridge.dispose() }
  await bridge.dispose()
})

test("bridge: stub select happy path maps result fields and injects the key env", async () => {
  const bridge = mkBridge(STUB_SIDECAR)
  try {
    const result = await bridge.select(bridgeReq())
    assert.equal(result.index, 0)
    assert.deepEqual(result.ranking, [0, 1])
    assert.equal(result.scores.length, 2)
    assert.equal(result.nComparisons, 2)
    assert.equal(result.usage.calls, 1)
    assert.equal(result.bestPreview, "cand-0")
  } finally { await bridge.dispose() }
})

test("bridge: real sidecar rejects empty candidates offline", async () => {
  const bridge = mkBridge(REAL_SIDECAR)
  try {
    await assert.rejects(
      bridge.select(bridgeReq({ candidates: [] })),
      (err) => err instanceof BridgeError && err.code === "invalid_request" && err.retriable === false)
  } finally { await bridge.dispose() }
})

test("bridge: real sidecar short-circuits a single candidate without provider calls", async () => {
  const bridge = mkBridge(REAL_SIDECAR)
  try {
    const result = await bridge.select(bridgeReq({ candidates: ["only one"] }))
    assert.equal(result.index, 0)
    assert.equal(result.nComparisons, 0)
    assert.equal(result.usage.calls, 0, "single candidate must not touch the provider")
    assert.deepEqual(result.scores, [1.0])
  } finally { await bridge.dispose() }
})

test("bridge: real sidecar accepts a per-request effort override and rejects unknown levels", async () => {
  const bridge = mkBridge(REAL_SIDECAR)
  try {
    const maxed = await bridge.select(bridgeReq({ candidates: ["only one"], effort: "max" }))
    assert.equal(maxed.index, 0, "single-candidate frame with effort still validates and short-circuits")
    await assert.rejects(
      bridge.select(bridgeReq({ candidates: ["only one"], effort: "turbo" })),
      (err) => err instanceof BridgeError && err.code === "invalid_request" && err.retriable === false)
    await assert.rejects(
      bridge.progress({ problem: "p", steps: ["s"], model: "m", baseUrl: "http://127.0.0.1:9/v1", apiKey: "dummy", apiKeyEnv: "SMOKE_KEY", effort: 7 }),
      (err) => err instanceof BridgeError && err.code === "invalid_request")
  } finally { await bridge.dispose() }
})

test("bridge: timeout kills the serial child, rejects bridge_timeout, then respawns", async () => {
  const bridge = mkBridge(STUB_SIDECAR)
  try {
    await assert.rejects(
      bridge.select(bridgeReq({ problem: "HANG pair", timeoutMs: 900 })),
      (err) => err instanceof BridgeError && err.code === "bridge_timeout" && err.retriable === true)
    assert.equal(bridge.alive, false, "a timed-out serial child must be killed")
    const health = await bridge.health({ timeoutMs: 15000 })
    assert.equal(health.select_available, true, "bridge respawns lazily after a kill")
  } finally { await bridge.dispose() }
})

test("bridge: child crash rejects pending as bridge_down and later requests respawn", async () => {
  const bridge = mkBridge(STUB_SIDECAR)
  try {
    await assert.rejects(
      bridge.select(bridgeReq({ problem: "CRASH pair", timeoutMs: 10000 })),
      (err) => err instanceof BridgeError && err.code === "bridge_down")
    const health = await bridge.health({ timeoutMs: 15000 })
    assert.equal(health.select_available, true)
  } finally { await bridge.dispose() }
})

test("bridge: external abort rejects bridge_aborted and reaps the in-flight child", async () => {
  const bridge = mkBridge(STUB_SIDECAR)
  try {
    const controller = new AbortController()
    const run = bridge.select(bridgeReq({ problem: "HANG abort", timeoutMs: 30000, signal: controller.signal }))
    setTimeout(() => controller.abort(), 100)
    await assert.rejects(run, (err) => err instanceof BridgeError && err.code === "bridge_aborted")
    assert.equal(bridge.alive, false)
  } finally { await bridge.dispose() }
})

test("bridge: sidecar error frames pass code and retriable through", async () => {
  const bridge = mkBridge(STUB_SIDECAR)
  try {
    await assert.rejects(
      bridge.select(bridgeReq({ problem: "ERRPROV pair" })),
      (err) => err instanceof BridgeError && err.code === "provider_error" && err.retriable === true)
  } finally { await bridge.dispose() }
})

test("bridge: dispose with an in-flight request rejects it and is idempotent", async () => {
  const bridge = mkBridge(STUB_SIDECAR)
  const run = bridge.select(bridgeReq({ problem: "HANG dispose", timeoutMs: 30000 }))
  setTimeout(() => { void bridge.dispose() }, 100)
  await assert.rejects(run, (err) => err instanceof BridgeError && /^bridge_(down|disposed)$/.test(err.code))
  await bridge.dispose()
})


test("retry: shares one absolute deadline and passes dynamic remaining time", async () => {
  let clock = 1000
  const attempts = []
  const delays = []
  await assert.rejects(
    retryTransientBridge(async (context) => {
      attempts.push({ attempt: context.attempt, timeoutMs: context.timeoutMs, aborted: context.signal.aborted })
      clock += 40
      throw new BridgeError("provider_error", "temporary", true)
    }, {
      deadlineAt: 1100,
      now: () => clock,
      delaysMs: [30],
      maxAttempts: 5,
      sleep: async (delayMs) => { delays.push(delayMs); clock += delayMs },
    }),
    (err) => err instanceof BridgeError && err.code === "selection_timeout",
  )
  assert.deepEqual(attempts, [
    { attempt: 1, timeoutMs: 100, aborted: false },
    { attempt: 2, timeoutMs: 30, aborted: false },
  ])
  assert.deepEqual(delays, [30])
}, { timeout: 2000 })

test("retry: absolute deadline aborts an in-flight operation", async () => {
  let operationAborted = false
  const startedAt = Date.now()
  await assert.rejects(
    retryTransientBridge(async (context) => await new Promise((resolve, reject) => {
      context.signal.addEventListener("abort", () => {
        operationAborted = true
        reject(new BridgeError("bridge_timeout", "operation noticed deadline", true))
      }, { once: true })
    }), { deadlineAt: Date.now() + 45 }),
    (err) => err instanceof BridgeError && err.code === "selection_timeout",
  )
  assert.equal(operationAborted, true)
  assert.ok(Date.now() - startedAt < 1000, "deadline must not wait for the operation's own timeout")
}, { timeout: 2000 })

test("retry: external abort during backoff settles as bridge_aborted", async () => {
  const controller = new AbortController()
  let attempts = 0
  const run = retryTransientBridge(async () => {
    attempts += 1
    throw new BridgeError("provider_error", "temporary", true)
  }, {
    signal: controller.signal,
    delaysMs: [500],
    sleep: async (delayMs, signal) => await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs)
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new BridgeError("bridge_aborted", "cancelled", false)) }, { once: true })
    }),
  })
  setTimeout(() => controller.abort(), 30)
  await assert.rejects(run, (err) => err instanceof BridgeError && err.code === "bridge_aborted")
  assert.equal(attempts, 1)
}, { timeout: 2000 })

// ---------- best-of-N candidate batch orchestrator (Phase 2) ----------
//
// SelectionRunner with scripted fakes: no live DSH runtime, no provider, and
// (apart from the pwsh check runner) no external processes.

const SEL_TMP = mkdtempSync(path.join(tmpdir(), "va-sel-"))

function fakeEvents(i) {
  return [
    { type: "user/message", seq: 0, data: { content: [{ type: "text", text: "task for candidate " + i }], source: { kind: "user" } } },
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "tool/call", seq: 2, data: { turn: 1, step: 1, name: "write", arguments: { file: "out" + i + ".txt" } } },
    { type: "tool/result", seq: 3, data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "written ok " + i }] } } },
    { type: "assistant/message", seq: 4, data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "done " + i }] } } },
    { type: "turn/end", seq: 5, data: { turn: 1, reason: { kind: "completed" } } },
  ]
}

function makeFakeFactory(opts = {}) {
  const calls = []
  const handles = []
  return {
    calls,
    handles,
    async create(spec) {
      const i = calls.length
      calls.push(spec)
      if (opts.failAt && opts.failAt.includes(i)) throw new Error("create-fail-" + i)
      if (opts.passAt && opts.passAt.includes(i)) writeFileSync(path.join(spec.cwd, "pass.txt"), "ready")
      const script = (opts.scripts && opts.scripts[i]) || {}
      const agent = {
        id: spec.sessionId,
        session: { events: (script.initEvents ?? []).slice() },
        followups: [],
        cancelled: false,
        _release: null,
        followup(m) { agent.followups.push(m) },
        whenIdle() {
          // The runtime re-mints the seed prefix as seq 0..seedLength-1 with
          // the candidate's own rollout AFTER it. Default fake events are the
          // own-rollout part, so they are offset past the seed; script events
          // own their exact seq values (some tests bake the seed in by hand).
          const own = (events) => events.map((ev) => (typeof ev.seq === "number" ? { ...ev, seq: ev.seq + (spec.seedLength ?? 0) } : ev))
          if (script.hang) {
            // A live hung agent still accrues events mid-flight (partial
            // progress visible to anyone watching): the abandonment monitor
            // reads exactly this region.
            if (script.partial) agent.session = { events: agent.session.events.concat(own(fakeEvents(i))) }
            return new Promise((resolve) => { agent._release = resolve })
          }
          return new Promise((resolve) => setTimeout(() => {
            agent.session = { events: script.events ? script.events : own(fakeEvents(i)) }
            resolve()
          }, script.idleDelay ?? 5))
        },
        cancel() { agent.cancelled = true; if (agent._release) agent._release() },
      }
      const handle = { agent, disposed: false, async dispose() { handle.disposed = true } }
      handles.push(handle)
      return handle
    },
  }
}

const realWorkspaces = {
  async prepare(sel) {
    const dir = path.join(SEL_TMP, sel.selectionId, "c" + sel.index)
    mkdirSync(dir, { recursive: true })
    return dir
  },
  async remove(dir) {
    rmSync(dir, { recursive: true, force: true })
  },
}

function fakeBridge(impl) {
  const calls = []
  return {
    calls,
    async select(req) {
      calls.push(req)
      if (impl) return impl(req)
      // Decisive default: margin 0.5 clears the provisional 0.03 noise gate,
      // so plumbing tests keep exercising the ranked_winner path.
      return { index: 0, bestPreview: String(req.candidates[0]).slice(0, 50), scores: req.candidates.map((_, i) => (i === 0 ? 0.9 : 0.4)), ranking: req.candidates.map((_, i) => i), nComparisons: req.candidates.length, criteria: ["c1"], usage: { calls: 1, input_tokens: 1, cached_input_tokens: 0, uncached_input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, cache_hit_rate: 0 } }
    },
  }
}

const selInput = (over = {}) => ({
  problem: "fix the thing",
  candidateCount: 3,
  workspaceRoot: SEL_TMP,
  sourceSessionId: "session-src",
  criteria: { c1: "did it actually fix the thing with evidence" },
  verifier: { model: "m", baseUrl: "http://127.0.0.1:9/v1", apiKey: "dummy" },
  ...over,
})

const PASS_CHECK = [{ name: "marker", command: "if (Test-Path ./pass.txt) { exit 0 } else { exit 3 }", timeoutMs: 20000 }]

// ---------- selection host + routes (Phase 3) ----------

function mkSelectionHost(over = {}) {
  const ctx = fakeContext()
  if (over.defaultRoute !== null) ctx.setService("agentDefaultModel", { currentSelection: () => over.defaultRoute ?? { provider: "kimi", model: "kimi-k3" } })
  const factory = makeFakeFactory(over.factoryOpts ?? {})
  const bridge = fakeBridge(over.bridgeImpl)
  const host = new VerifierHost(ctx, hostOverrides(over.config ?? {}), {
    selectionsTesting: { factory, workspaces: realWorkspaces, bridge },
  })
  const source = ctx.spawnAgent(fakeAgent("sess-A", completedTurnEvents(1)))
  return { ctx, host, factory, bridge, source }
}

async function waitFor(fn, timeoutMs = 8000) {
  const start = Date.now()
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error("waitFor-timeout")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}



test("legacy auto: parented sessions never enter auto verification (selection candidates stay clean)", async () => {
  const server = mockLaneServer()
  try {
    const ctx = fakeContext()
    const host = new VerifierHost(ctx, hostOverrides())
    host.start()
    const child = fakeAgent("child-1", completedTurnEvents(1))
    child.session.header = { parentSession: "sess-parent" }
    ctx.spawnAgent(child)
    ctx.emit("agent/created", { agent: child })
    fireIdle(child)
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(server.calls.length, 0, "no verifier lane runs for a parented (candidate) session")
    assert.equal(host.queryRecords({ sessionId: "child-1" }).length, 0, "no record produced for a candidate session")
    const root = ctx.spawnAgent(fakeAgent("root-1", completedTurnEvents(1)))
    ctx.emit("agent/created", { agent: root })
    server.enqueueBody(laneSuccessBody())
    fireIdle(root)
    await waitFor(() => server.calls.length === 1, 4000)
    assert.equal(server.calls.length, 1, "control: root sessions still auto-verify")
  } finally { server.restore() }
})

test("selhost: cutBalancedSeed cuts at the last turn/end and refuses degenerate cases", async () => {
  const { cutBalancedSeed } = await import("../lib/selection/host.js")
  assert.equal(cutBalancedSeed([{ type: "user/message", seq: 1 }]), undefined, "no completed turn, no seed")
  const events = completedTurnEvents(1).concat([{ type: "user/message", seq: 99, data: {} }])
  const cut = cutBalancedSeed(events)
  assert.equal(cut.seedLength, 5, "cut lands right after turn/end")
  assert.equal(cut.seed[cut.seed.length - 1].type, "turn/end")
  const long = []
  for (let i = 0; i < 800; i += 1) long.push({ type: "assistant/chunk", seq: i, data: {} })
  long.push({ type: "turn/end", seq: 801, data: {} })
  assert.equal(cutBalancedSeed(long), undefined, "over-cap prefix is skipped, not guessed")
})

test("selhost: problemFromEvents takes the latest direct user task, skipping plugin notices", async () => {
  const { problemFromEvents } = await import("../lib/selection/host.js")
  const events = [
    { type: "user/message", seq: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "first task" }] } },
    { type: "user/message", seq: 2, data: { source: { kind: "plugin", plugin: "x" }, content: [{ type: "text", text: "plugin notice" }] } },
    { type: "user/message", seq: 3, data: { source: { kind: "user" }, content: [{ type: "text", text: "latest task" }] } },
  ]
  assert.equal(problemFromEvents(events), "latest task")
  assert.equal(problemFromEvents([{ type: "user/message", seq: 1, data: { source: { kind: "plugin" }, content: "x" } }]), undefined)
})

test("selhost: manual /select releases live winner while retaining workspace and session", async () => {
  const { ctx, host, factory, bridge, source } = mkSelectionHost()
  const routes = apiRoutes(host)
  const selectRoute = routes.find((r) => r.path.endsWith("/select"))
  const selectionsRoute = routes.find((r) => r.path.endsWith("/selections"))
  const releaseRoute = routes.find((r) => r.path.endsWith("/selections/release"))
  const res = fakeRes()
  await selectRoute.handler(fakeReq({ sourceSessionId: "sess-A", candidateCount: 2 }), res)
  assert.equal(res.status, 202)
  const started = JSON.parse(res.bodyText)
  const id = started.selection.selectionId
  assert.equal(started.selection.status, "running")
  const final = await waitFor(() => {
    const s = host.selections.getSelection(id)
    return s && s.status !== "running" ? s : null
  })
  assert.equal(final.status, "completed")
  assert.equal(final.winner.index, 0, "fake bridge default picks candidate 0")
  assert.equal(final.candidates.length, 2)
  for (const c of final.candidates) {
    assert.ok(c.workspace.includes(id), "candidate workspace lives under the selection root")
  }
  assert.ok(existsSync(final.winner.workspace), "winner workspace retained")
  assert.equal(factory.calls[0].cwd, final.candidates[0].workspace)
  assert.equal(factory.calls[0].parentSession, "sess-A")
  assert.equal(factory.calls[0].seedLength, 5, "balanced seed prefix length rides along")
  assert.equal(bridge.calls.length, 1)
  assert.equal(bridge.calls[0].maxWorkers, 4, "auto concurrency (selectionVerifierWorkers=0) spreads tournament calls across the relay's per-request account pool")
  assert.deepEqual(host.selections.snapshot().retainedWinners, [], "manual winner releases its live handle at settlement")
  assert.equal(factory.handles[final.winner.index].disposed, true, "persisted session and workspace do not require a live agent handle")
  // Settlement notice lands in the SOURCE session (the operator keeps working
  // there; without it the result was invisible outside the panel).
  assert.equal(source.followups.length, 1, "one settlement notice to the source session")
  assert.ok(String(source.followups[0].content[0].text).startsWith("[Selection 结算]"))
  assert.equal(source.followups[0].source.plugin, "@dsh-external/dsh-verifier-autopilot/selection")
  const listRes = fakeRes()
  await selectionsRoute.handler(fakeReq({}, "/selections", "GET"), listRes)
  assert.equal(JSON.parse(listRes.bodyText).selections[0].selectionId, id)
  const rel = fakeRes()
  await releaseRoute.handler(fakeReq({ selectionId: id }), rel)
  assert.equal(rel.status, 200, "manual release is already settled and stays idempotent")
  assert.equal(JSON.parse(rel.bodyText).state, "not-retained")
  const rel2 = fakeRes()
  await releaseRoute.handler(fakeReq({ selectionId: id }), rel2)
  assert.equal(rel2.status, 200, "repeated release stays idempotent")
  assert.equal(JSON.parse(rel2.bodyText).state, "not-retained")
  const relBad = fakeRes()
  await releaseRoute.handler(fakeReq({ selectionId: "sel-nope" }), relBad)
  assert.equal(relBad.status, 404, "unknown selection still 404s")
  await host.selections.dispose()
})

test("selhost: /select validation rejects missing problem and bad counts", async () => {
  const { host } = mkSelectionHost()
  const routes = apiRoutes(host)
  const selectRoute = routes.find((r) => r.path.endsWith("/select"))
  let res = fakeRes()
  await selectRoute.handler(fakeReq({ candidateCount: 2 }), res)
  assert.equal(res.status, 400)
  assert.equal(JSON.parse(res.bodyText).error, "problem-required")
  res = fakeRes()
  await selectRoute.handler(fakeReq({ problem: "x", candidateCount: 0 }), res)
  assert.equal(JSON.parse(res.bodyText).error, "candidate-count-invalid")
  res = fakeRes()
  await selectRoute.handler(fakeReq({ problem: "x", sourceSessionId: "session-gone" }), res)
  assert.equal(JSON.parse(res.bodyText).error, "source-session-not-found")
  await host.selections.dispose()
})


test("selhost: manual candidate timeout falls back to config default, not the runner floor", async () => {
  const { normalizeCandidateTimeoutMs } = await import("../lib/selection/host.js")
  assert.equal(normalizeCandidateTimeoutMs(undefined, 900000), 900000, "omitted per-request timeout follows the config default")
  assert.equal(normalizeCandidateTimeoutMs(120000, 900000), 120000, "explicit request value wins")
  assert.equal(normalizeCandidateTimeoutMs(5000, 900000), 30000, "lower clamp")
  assert.equal(normalizeCandidateTimeoutMs(2_500_000, 900000), 1800000, "upper clamp")
  assert.equal(normalizeCandidateTimeoutMs(undefined, undefined), undefined, "no host default defers to the runner floor")
})

test("selhost: explicit verifier timeout is capped at ten minutes", async () => {
  const { host, bridge } = mkSelectionHost()
  const selectRoute = apiRoutes(host).find((r) => r.path.endsWith("/select"))
  const res = fakeRes()
  await selectRoute.handler(fakeReq({ sourceSessionId: "sess-A", candidateCount: 2, selectTimeoutMs: 1800000 }), res)
  assert.equal(res.status, 202)
  const id = JSON.parse(res.bodyText).selection.selectionId
  await waitFor(() => {
    const s = host.selections.getSelection(id)
    return s && s.status !== "running" ? s : null
  })
  assert.ok(bridge.calls[0].timeoutMs <= 600000, "request timeout cannot exceed shared ten-minute budget")
  await host.selections.dispose()
})

test("selhost: configured effort/evaluations/pivots reach the tournament bridge; explicit body wins", async () => {
  const ctx = fakeContext()
  const factory = makeFakeFactory({})
  const bridge = fakeBridge()
  const host = new VerifierHost(ctx, hostOverrides({ verifierEffort: "high", selectionEvaluations: 6, selectionPivots: 3 }), {
    selectionsTesting: { factory, workspaces: realWorkspaces, bridge },
  })
  ctx.spawnAgent(fakeAgent("sess-A", completedTurnEvents(1)))
  const first = await host.selections.start({ sourceSessionId: "sess-A", candidateCount: 3 })
  await host.selections.waitFor(first.selectionId)
  assert.equal(bridge.calls.length, 1, "three clean rollouts reach exactly one tournament")
  assert.equal(bridge.calls[0].effort, "high", "configured thinking strength reaches the tournament bridge")
  assert.equal(bridge.calls[0].nEvaluations, 6, "configured evaluation rounds reach the tournament bridge")
  assert.equal(bridge.calls[0].pivots, 3, "configured pivot iterations reach the tournament bridge")
  const second = await host.selections.start({ sourceSessionId: "sess-A", candidateCount: 3, pivots: 1, nEvaluations: 2 })
  await host.selections.waitFor(second.selectionId)
  assert.equal(bridge.calls[1].pivots, 1, "explicit body pivots override the config default")
  assert.equal(bridge.calls[1].nEvaluations, 2, "explicit body evaluation rounds override the config default")
  assert.equal(bridge.calls[1].effort, "high", "effort has no per-request body override: config rules")
  await host.selections.dispose()
})

test("selhost: missing verifier credential fails loudly before spending", async () => {
  const ctx = fakeContext()
  ctx.credentials = { resolve: async () => undefined }
  const host = new VerifierHost(ctx, hostOverrides(), {
    selectionsTesting: { factory: makeFakeFactory(), workspaces: realWorkspaces, bridge: fakeBridge() },
  })
  ctx.spawnAgent(fakeAgent("sess-A", completedTurnEvents(1)))
  const selectRoute = apiRoutes(host).find((r) => r.path.endsWith("/select"))
  const res = fakeRes()
  await selectRoute.handler(fakeReq({ sourceSessionId: "sess-A", candidateCount: 1 }), res)
  assert.equal(res.status, 400)
  assert.equal(JSON.parse(res.bodyText).error, "missing-api-key")
  await host.selections.dispose()
})



test("bridge preflight: passes when the verifier strictly prefers the present output", async () => {
  const bridge = mkBridge(STUB_SIDECAR)
  try {
    await bridge.preflight({ model: "m", baseUrl: "http://127.0.0.1:9/v1", apiKey: "dummy", apiKeyEnv: "SMOKE_KEY" })
  } finally { await bridge.dispose() }
})

test("bridge preflight: degenerate tie scores fail fast with preflight_failed", async () => {
  const bridge = mkBridge(STUB_SIDECAR)
  try {
    await assert.rejects(
      bridge.preflight({ model: "m", baseUrl: "http://tie.invalid/v1", apiKey: "dummy", apiKeyEnv: "SMOKE_KEY" }),
      (err) => err instanceof BridgeError && err.code === "preflight_failed" && err.retriable === false)
  } finally { await bridge.dispose() }
})

test("selection: a failed verifier preflight stops the run before any candidate spend", async () => {
  const factory = makeFakeFactory({})
  const bridge = fakeBridge()
  const runner = new SelectionRunner({
    factory, workspaces: realWorkspaces, bridge,
    preflight: async () => { throw new BridgeError("preflight_failed", "scores 0.5/0.5", false) },
  })
  const { record, winner } = await runner.run(selInput({}))
  assert.equal(record.status, "failed")
  assert.ok(String(record.error).includes("verifier preflight"))
  assert.equal(winner, undefined)
  assert.equal(factory.calls.length, 0, "no candidate agent created")
  assert.equal(bridge.calls.length, 0, "no verifier comparison spent")
})

test("selhost: verifier preflight retries transient failure then memoizes the provider tuple", async () => {
  const ctx = fakeContext()
  const factory = makeFakeFactory({})
  const bridge = fakeBridge()
  let preflightCalls = 0
  const preflightTimeouts = []
  const retryDelays = []
  bridge.preflight = async (request) => {
    preflightCalls += 1
    preflightTimeouts.push(request.timeoutMs)
    if (preflightCalls < 2) throw new BridgeError("provider_error", "429 preflight", true)
  }
  const host = new VerifierHost(ctx, hostOverrides(), {
    selectionsTesting: { factory, workspaces: realWorkspaces, bridge, retrySleep: async (delayMs) => { retryDelays.push(delayMs) } },
  })
  ctx.spawnAgent(fakeAgent("sess-A", completedTurnEvents(1)))
  const routes = apiRoutes(host)
  const selectRoute = routes.find((r) => r.path.endsWith("/select"))
  for (let round = 0; round < 2; round += 1) {
    const res = fakeRes()
    await selectRoute.handler(fakeReq({ sourceSessionId: "sess-A", candidateCount: 2, selectTimeoutMs: 120000 }), res)
    assert.equal(res.status, 202)
    const id = JSON.parse(res.bodyText).selection.selectionId
    const final = await waitFor(() => {
      const s = host.selections.getSelection(id)
      return s && s.status !== "running" ? s : null
    })
    assert.equal(final.status, "completed")
    await host.selections.releaseWinner(id)
  }
  assert.equal(preflightCalls, 2, "one transient retry succeeds, then the second selection reuses the proven gate")
  assert.ok(preflightTimeouts.length === 2 && preflightTimeouts.every((value) => value > 118000 && value <= 120000), "preflight inherits the explicit bounded selection timeout")
  assert.deepEqual(retryDelays, [2000])
  await host.selections.dispose()
})

test("selhost: single active run admitted; cancel settles as aborted", async () => {
  const { host, factory, bridge } = mkSelectionHost({ factoryOpts: { scripts: { 0: { hang: true }, 1: { hang: true } } } })
  const routes = apiRoutes(host)
  const selectRoute = routes.find((r) => r.path.endsWith("/select"))
  const cancelRoute = routes.find((r) => r.path.endsWith("/selections/cancel"))
  const res = fakeRes()
  await selectRoute.handler(fakeReq({ sourceSessionId: "sess-A", candidateCount: 2 }), res)
  assert.equal(res.status, 202)
  const id = JSON.parse(res.bodyText).selection.selectionId
  const res2 = fakeRes()
  await selectRoute.handler(fakeReq({ sourceSessionId: "sess-A", candidateCount: 2 }), res2)
  assert.equal(res2.status, 429)
  assert.equal(JSON.parse(res2.bodyText).error, "selection-busy")
  const rc = fakeRes()
  await cancelRoute.handler(fakeReq({ selectionId: id }), rc)
  assert.equal(rc.status, 200)
  const final = await waitFor(() => {
    const s = host.selections.getSelection(id)
    return s && s.status !== "running" ? s : null
  })
  assert.equal(final.status, "aborted")
  assert.equal(bridge.calls.length, 0)
  for (const h of factory.handles) assert.equal(h.disposed, true, "aborted run leaves no live children")
  const rc2 = fakeRes()
  await cancelRoute.handler(fakeReq({ selectionId: id }), rc2)
  assert.equal(rc2.status, 404, "settled selections cannot be cancelled again")
  await host.selections.dispose()
})


test("selection: transient verifier failures retry with bounded telemetry", async () => {
  let attempts = 0
  const delays = []
  const bridge = fakeBridge((req) => {
    attempts += 1
    if (attempts < 2) throw new BridgeError("provider_error", "429 pending request", true)
    return {
      index: 1, bestPreview: "", scores: [0.25, 0.75], ranking: [1, 0], nComparisons: 3, criteria: ["c1"],
      usage: { calls: 3, input_tokens: 30, cached_input_tokens: 0, uncached_input_tokens: 30, output_tokens: 9, reasoning_tokens: 0, cache_hit_rate: 0 },
    }
  })
  const runner = new SelectionRunner({
    factory: makeFakeFactory({}), workspaces: realWorkspaces, bridge,
    sleep: async (delayMs) => { delays.push(delayMs) },
  })
  const { record, retained } = await runner.run(selInput({ candidateCount: 2 }))
  assert.equal(record.status, "completed")
  assert.equal(record.winner.index, 1)
  assert.equal(record.rankingAttempts, 2)
  assert.deepEqual(record.rankingRetryErrors, ["429 pending request"])
  assert.deepEqual(delays, [2000])
  assert.equal(bridge.calls.length, 2)
  await retained.handle.dispose()
  await realWorkspaces.remove(retained.workspace)
})

test("selection: non-retriable verifier failure is attempted once and cleans every child", async () => {
  const bridge = fakeBridge(() => { throw new BridgeError("missing_logprobs", "no score evidence", false) })
  const factory = makeFakeFactory({})
  const runner = new SelectionRunner({
    factory, workspaces: realWorkspaces, bridge,
    sleep: async () => { throw new Error("non-retriable errors must not sleep") },
  })
  const { record, winner } = await runner.run(selInput({ candidateCount: 2 }))
  assert.equal(record.status, "failed")
  assert.equal(record.rankingAttempts, 1)
  assert.equal(record.rankingRetryErrors, undefined)
  assert.equal(bridge.calls.length, 1)
  assert.equal(winner, undefined)
  for (const handle of factory.handles) assert.equal(handle.disposed, true)
})


test("selection: malformed verifier results fail closed without crowning a candidate", async () => {
  const malformed = [
    { index: 2, scores: [0.2, 0.8], ranking: [0, 1], nComparisons: 1 },
    { index: 0, scores: [0.2, Number.NaN], ranking: [0, 1], nComparisons: 1 },
    { index: 0, scores: [0.2, 0.8], ranking: [0, 0], nComparisons: 1 },
    { index: 1, scores: [0.2, 0.8], ranking: [0, 1], nComparisons: 1 },
    { index: 0, scores: [0.2, 0.8], ranking: [0, 1], nComparisons: 1 },
  ]
  for (const outcome of malformed) {
    const factory = makeFakeFactory({})
    const bridge = fakeBridge(() => outcome)
    const runner = new SelectionRunner({ factory, workspaces: realWorkspaces, bridge })
    const { record, winner } = await runner.run(selInput({ candidateCount: 2 }))
    assert.equal(record.status, "failed")
    assert.match(record.error, /invalid verifier selection result/)
    assert.equal(winner, undefined, "malformed ranking never crowns a candidate")
    for (const handle of factory.handles) assert.equal(handle.disposed, true)
  }
})


test("selection: finalizer relay states winner evidence basis", () => {
  const relay = buildAutopilotRelay({
    selectionId: "sel-relay",
    sourceSessionId: "source",
    startedAt: 1,
    finishedAt: 2,
    status: "completed",
    trigger: "autopilot",
    policy: { depth: "standard", candidateCount: 2, nEvaluations: 2, contextChars: 100, models: ["kimi-k3"] },
    candidates: [],
    winner: { index: 1, sessionId: "candidate-1", workspace: "C:\managed\sel\c1" },
    winnerBasis: "verifier",
    scores: [0.2, 0.8],
    ranking: [1, 0],
    nComparisons: 2,
    finalists: [{ index: 1, score: 0.8, handoff: "evidence" }],
  })
  assert.match(relay, /Winner basis: verifier/)
  assert.match(relay, /sole finalizer/)
})

test("selection: happy path — check-eliminates one candidate, winner maps back to original index", async () => {
  const factory = makeFakeFactory({ passAt: [0, 2] })
  const bridge = fakeBridge((req) => ({
    index: 1,
    bestPreview: "",
    scores: [0.4, 0.6],
    ranking: [1, 0],
    nComparisons: 3,
    criteria: ["c1"],
    usage: { calls: 3, input_tokens: 30, cached_input_tokens: 0, uncached_input_tokens: 30, output_tokens: 9, reasoning_tokens: 0, cache_hit_rate: 0 },
  }))
  const runner = new SelectionRunner({ factory, workspaces: realWorkspaces, bridge })
  const { record, retained } = await runner.run(selInput({ checks: PASS_CHECK }))
  assert.equal(record.status, "completed")
  assert.equal(record.candidates.length, 3)
  assert.equal(record.candidates[1].status, "eliminated", "candidate 1 lacks pass.txt")
  assert.deepEqual(record.candidates[1].eliminatedBy, ["marker"])
  assert.equal(bridge.calls.length, 1, "exactly one verifier select call")
  assert.equal(bridge.calls[0].candidates.length, 2, "only survivors reach the verifier")
  assert.ok(bridge.calls[0].candidates[0].includes("TOOL RESULT"), "trajectory carries tool evidence")
  assert.equal(record.winner.index, 2, "survivor index 1 maps back to original candidate 2")
  assert.deepEqual(record.ranking, [2, 0], "ranking is reported in original indices")
  assert.deepEqual(record.scores, [0.4, null, 0.6], "scores align to original indices with null holes")
  assert.ok(retained && retained.candidateIndex === 2)
  assert.equal(factory.handles[2].disposed, false, "winner stays alive")
  assert.ok(existsSync(record.winner.workspace), "winner workspace survives")
  for (const i of [0, 1]) {
    assert.equal(factory.handles[i].disposed, true, "loser " + i + " disposed")
    assert.ok(!existsSync(record.candidates[i].workspace), "loser " + i + " workspace removed")
  }
})

test("selection: all candidates eliminated -> failed, bridge untouched, everything cleaned", async () => {
  const factory = makeFakeFactory({ passAt: [] })
  const bridge = fakeBridge()
  const runner = new SelectionRunner({ factory, workspaces: realWorkspaces, bridge })
  const { record, winner } = await runner.run(selInput({ checks: PASS_CHECK }))
  assert.equal(record.status, "failed")
  assert.equal(record.error, "all_candidates_eliminated")
  assert.equal(winner, undefined)
  assert.equal(bridge.calls.length, 0)
  assert.equal(factory.handles.length, 3)
  for (const h of factory.handles) assert.equal(h.disposed, true)
  for (const c of record.candidates) assert.ok(!existsSync(c.workspace))
})

test("selection: agent-create failure is contained to that candidate", async () => {
  const factory = makeFakeFactory({ failAt: [1], passAt: [0, 2] })
  const bridge = fakeBridge()
  const runner = new SelectionRunner({ factory, workspaces: realWorkspaces, bridge })
  const { record, retained } = await runner.run(selInput({ checks: PASS_CHECK }))
  assert.equal(record.status, "completed")
  assert.equal(record.candidates[1].status, "failed")
  assert.ok(String(record.candidates[1].error).startsWith("agent-create:"))
  assert.deepEqual(record.candidates[1].eliminatedBy, ["run-failed"])
  assert.ok(bridge.calls.length === 1 && bridge.calls[0].candidates.length === 2)
  assert.ok(retained && [0, 2].includes(retained.candidateIndex))
})

test("selection: abort mid-run leaves no orphans and no winner", async () => {
  const factory = makeFakeFactory({ scripts: { 0: { hang: true }, 1: { hang: true }, 2: { hang: true } } })
  const bridge = fakeBridge()
  const runner = new SelectionRunner({ factory, workspaces: realWorkspaces, bridge })
  const controller = new AbortController()
  const run = runner.run(selInput({ signal: controller.signal }))
  setTimeout(() => controller.abort(), 60)
  const { record, winner } = await run
  assert.equal(record.status, "aborted")
  assert.equal(winner, undefined)
  assert.equal(bridge.calls.length, 0)
  for (const h of factory.handles) assert.equal(h.disposed, true)
  for (const c of record.candidates) assert.ok(!existsSync(c.workspace))
})

test("selection: N=1 never calls the verifier and retains as fallback (never a winner claim)", async () => {
  const factory = makeFakeFactory({})
  const bridge = fakeBridge()
  const runner = new SelectionRunner({ factory, workspaces: realWorkspaces, bridge })
  const { record, retained } = await runner.run(selInput({ candidateCount: 1, checks: undefined }))
  assert.equal(record.status, "completed")
  assert.equal(bridge.calls.length, 0, "single candidate must not spend verifier calls")
  assert.equal(record.nComparisons, 0)
  assert.deepEqual(record.scores, [null])
  assert.equal(record.outcome, "single_candidate_fallback")
  assert.equal(record.winnerBasis, "single-candidate")
  assert.equal(record.winner, undefined, "a fallback is never crowned winner")
  assert.equal(record.fallback.index, 0)
  assert.ok(retained && retained.candidateIndex === 0 && !factory.handles[0].disposed)
})

test("selection: exactly one survivor skips the verifier and falls back with objective basis", async () => {
  const factory = makeFakeFactory({ failAt: [0, 2], passAt: [1] })
  const bridge = fakeBridge()
  const runner = new SelectionRunner({ factory, workspaces: realWorkspaces, bridge })
  const { record, retained } = await runner.run(selInput({ checks: PASS_CHECK }))
  assert.equal(record.status, "completed")
  assert.equal(bridge.calls.length, 0)
  assert.ok(retained && retained.candidateIndex === 1)
  assert.deepEqual(record.ranking, [1])
  assert.deepEqual(record.scores, [null, null, null])
  assert.equal(record.outcome, "single_candidate_fallback")
  assert.equal(record.winnerBasis, "objective-check-only")
  assert.equal(record.winner, undefined)
  assert.equal(record.fallback.index, 1)
})

// ---------- 2026-09-08 裁决 9.8 winner gate（I.2/I.3、K.5、F1–F4）----------

test("winner gate: exact tie abstains — never a verifier winner (B-8)", async () => {
  const factory = makeFakeFactory({})
  const bridge = fakeBridge(() => ({ index: 0, bestPreview: "", scores: [0.5, 0.5], ranking: [0, 1], nComparisons: 2, criteria: ["c1"] }))
  const runner = new SelectionRunner({ factory, workspaces: realWorkspaces, bridge })
  const { record, retained } = await runner.run(selInput({ candidateCount: 2 }))
  assert.equal(record.status, "completed")
  assert.equal(record.outcome, "abstain")
  assert.equal(record.winnerBasis, undefined, "a tied tournament carries no verifier basis")
  assert.equal(record.winner, undefined, "abstain crowns nobody")
  assert.equal(retained, undefined, "abstain retains no workspace")
  assert.equal(record.margin, 0)
  assert.equal(record.marginProvisional, true)
  assert.ok(record.note && record.note.includes("noise band"))
  for (const h of factory.handles) assert.equal(h.disposed, true, "tied candidates are disposed")
})

test("winner gate: near-tie inside the provisional noise band abstains (F1)", async () => {
  const factory = makeFakeFactory({})
  const bridge = fakeBridge(() => ({ index: 0, bestPreview: "", scores: [0.51, 0.49], ranking: [0, 1], nComparisons: 2, criteria: ["c1"] }))
  const runner = new SelectionRunner({ factory, workspaces: realWorkspaces, bridge })
  const { record } = await runner.run(selInput({ candidateCount: 2, taskKind: "code-change" }))
  assert.equal(record.outcome, "abstain")
  assert.ok(Math.abs((record.margin ?? 0) - 0.02) < 1e-9, "margin records the near-tie spread within float tolerance")
  assert.equal(record.marginThreshold, 0.03)
  assert.equal(record.marginCondition, "m@default")
  assert.equal(record.llmOnly, true, "no objective checks ran, so the tournament was LLM-only")
  assert.equal(record.winner, undefined)
  assert.equal(record.winnerBasis, undefined, "ruling: the old ledger's winnerBasis=verifier on a 0.02 margin was exactly the false claim being removed")
})

test("winner gate: margins straddle the calibrated 0.03 boundary correctly", async () => {
  // Calibration rounds 1+2 put the noise ceiling at 0.0138; 0.03 sits ~2x over it.
  // Below the gate: abstain. Above it: ranked_winner.
  const mk = () => {
    const factory = makeFakeFactory({})
    const bridge = fakeBridge(() => ({ index: 0, bestPreview: "", scores: [0.512, 0.488], ranking: [0, 1], nComparisons: 2, criteria: ["c1"] }))
    return new SelectionRunner({ factory, workspaces: realWorkspaces, bridge })
  }
  const below = await mk().run(selInput({ candidateCount: 2, taskKind: "code-change" }))
  assert.equal(below.record.outcome, "abstain")
  assert.ok((below.record.margin ?? 0) < 0.03)
  const mk2 = () => {
    const factory = makeFakeFactory({})
    const bridge = fakeBridge(() => ({ index: 0, bestPreview: "", scores: [0.55, 0.5], ranking: [0, 1], nComparisons: 2, criteria: ["c1"] }))
    return new SelectionRunner({ factory, workspaces: realWorkspaces, bridge })
  }
  const above = await mk2().run(selInput({ candidateCount: 2, taskKind: "code-change" }))
  assert.equal(above.record.outcome, "ranked_winner")
  assert.ok((above.record.margin ?? 0) > 0.03)
  assert.equal(above.record.winnerBasis, "verifier")
})

test("winner gate: a decisive margin ranks the winner honestly", async () => {
  const factory = makeFakeFactory({})
  const bridge = fakeBridge(() => ({ index: 1, bestPreview: "", scores: [0.2, 0.85], ranking: [1, 0], nComparisons: 3, criteria: ["c1"] }))
  const runner = new SelectionRunner({ factory, workspaces: realWorkspaces, bridge })
  const { record, retained } = await runner.run(selInput({ candidateCount: 2 }))
  assert.equal(record.outcome, "ranked_winner")
  assert.equal(record.winnerBasis, "verifier")
  assert.equal(record.winner.index, 1)
  assert.equal(retained.candidateIndex, 1)
  assert.ok(Math.abs((record.margin ?? 0) - 0.65) < 1e-9, "margin is the decisive spread within float tolerance")
})

test("ranking input: deterministic evidence block precedes every trajectory (I.6/J.4)", async () => {
  const factory = makeFakeFactory({})
  const bridge = fakeBridge()
  const runner = new SelectionRunner({ factory, workspaces: realWorkspaces, bridge })
  await runner.run(selInput({ candidateCount: 2, taskKind: "code-change" }))
  assert.equal(bridge.calls.length, 1)
  for (const payload of bridge.calls[0].candidates) {
    const headEnd = payload.indexOf("[TRAJECTORY")
    assert.ok(payload.startsWith("[DETERMINISTIC EVIDENCE"), "runner-collected evidence leads the payload")
    assert.ok(headEnd > 0, "trajectory sits after the evidence block")
    assert.ok(payload.includes("Task kind: code-change"))
    assert.ok(payload.includes("Execution-class tool calls: 1"), "exec-class count is visible; meta tools excluded")
    assert.ok(payload.includes("Objective checks: none configured"), "absent checks are disclosed, not implied")
    assert.ok(payload.includes("Worktree diff: unavailable"), "non-git workspaces say so explicitly")
  }
})

test("winner gate: meta-tool-only rollouts fail the has-work gate (F4 / K.4-1)", async () => {
  const metaOnly = (i) => [
    { type: "user/message", seq: 0, data: { content: [{ type: "text", text: "inspect the repo " + i }], source: { kind: "user" } } },
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "tool/call", seq: 2, data: { turn: 1, name: "tool_search", arguments: { query: "find tools" } } },
    { type: "tool/result", seq: 3, data: { turn: 1, message: { content: [{ type: "text", text: "catalog listing" }] } } },
    { type: "assistant/message", seq: 4, data: { turn: 1, message: { role: "assistant", content: [{ type: "text", text: "looks fine to me " + i }] } } },
    { type: "turn/end", seq: 5, data: { turn: 1, reason: { kind: "completed" } } },
  ]
  const factory = makeFakeFactory({ scripts: { 0: { events: metaOnly(0) }, 1: { events: metaOnly(1) } } })
  let selectCalled = 0
  const bridge = fakeBridge(() => { selectCalled += 1; return { index: 0, bestPreview: "", scores: [0.9, 0.1], ranking: [0, 1], nComparisons: 2, criteria: ["c1"] } })
  const runner = new SelectionRunner({ factory, workspaces: realWorkspaces, bridge })
  const { record } = await runner.run(selInput({ candidateCount: 2, taskKind: "code-change" }))
  assert.equal(record.outcome, "insufficient_evidence")
  assert.equal(selectCalled, 0, "workless survivors never reach the verifier")
  assert.equal(record.winner, undefined)
  assert.deepEqual(record.candidates[0].eliminatedBy, ["insufficient-evidence"])
  assert.equal(record.candidates[0].execToolCalls, 0, "tool_search is meta, not execution evidence")
})

test("winner gate: identical diff surfaces dedupe to fallback before ranking (F3)", async () => {
  const factory = makeFakeFactory({})
  let selectCalled = 0
  const bridge = fakeBridge(() => { selectCalled += 1; return { index: 0, bestPreview: "", scores: [0.9, 0.1], ranking: [0, 1], nComparisons: 2, criteria: ["c1"] } })
  const sameStat = { files: 1, insertions: 3, deletions: 1, untracked: 0, fingerprint: "abc123" }
  const runner = new SelectionRunner({ factory, workspaces: realWorkspaces, bridge, diffStat: async () => sameStat })
  const { record, retained } = await runner.run(selInput({ candidateCount: 2, taskKind: "code-change" }))
  assert.equal(record.noSearchSpace, true)
  assert.equal(record.outcome, "single_candidate_fallback")
  assert.equal(selectCalled, 0, "no search space → no verifier spend")
  assert.equal(record.winnerBasis, "single-candidate")
  assert.ok(retained && retained.candidateIndex === 0)
  assert.equal(record.fallback.index, 0)
})

test("winner gate: analysis-text tasks are exempt from the has-work gate (I.3)", async () => {
  const textOnly = (i) => [
    { type: "user/message", seq: 0, data: { content: [{ type: "text", text: "analyze design " + i }], source: { kind: "user" } } },
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "assistant/message", seq: 2, data: { turn: 1, message: { role: "assistant", content: [{ type: "text", text: "analysis " + i }] } } },
    { type: "turn/end", seq: 3, data: { turn: 1, reason: { kind: "completed" } } },
  ]
  const factory = makeFakeFactory({ scripts: { 0: { events: textOnly(0) }, 1: { events: textOnly(1) } } })
  const bridge = fakeBridge()
  const runner = new SelectionRunner({ factory, workspaces: realWorkspaces, bridge })
  const { record } = await runner.run(selInput({ candidateCount: 2, taskKind: "analysis-text" }))
  assert.equal(record.outcome, "ranked_winner", "pure analysis never gets eliminated for lacking tool calls")
  assert.equal(record.llmOnly, true)
  assert.equal(record.winner.index, 0)
})

test("checks gate: shell harness errors never eliminate a candidate (B-10)", async () => {
  const factory = makeFakeFactory({})
  const bridge = fakeBridge()
  const runner = new SelectionRunner({ factory, workspaces: realWorkspaces, bridge })
  const badCheck = [{ name: "broken", command: "= -eq 3", timeoutMs: 10000 }]
  const { record } = await runner.run(selInput({ candidateCount: 2, checks: badCheck, taskKind: "code-change" }))
  assert.equal(record.status, "completed")
  assert.equal(record.checksUnreliable, true)
  assert.equal(record.candidates[0].checksInvalid, true)
  assert.equal(record.candidates[0].objectiveEvidence, "none", "an invalid check grants no objective evidence")
  assert.equal(bridge.calls.length, 1, "candidates reached the verifier instead of being gate-massacred")
  assert.equal(record.outcome, "ranked_winner")
})

test("winner gate: verifier outage with full objective pass degrades to verifier_unavailable, never failed-with-nothing (K.5)", async () => {
  const factory = makeFakeFactory({ passAt: [0, 1] })
  const bridge = fakeBridge(() => { throw new BridgeError("verifier_timeout", "verifier selection exceeded its absolute budget", false) })
  const runner = new SelectionRunner({ factory, workspaces: realWorkspaces, bridge })
  const { record } = await runner.run(selInput({ candidateCount: 2, checks: PASS_CHECK, taskKind: "code-change" }))
  assert.equal(record.status, "completed")
  assert.equal(record.outcome, "verifier_unavailable")
  assert.equal(record.llmOnly, undefined, "objective evidence existed; the run was not LLM-only")
  assert.ok(record.note && record.note.includes("ranking failed"))
  assert.equal(record.winner, undefined, "a broken verifier must never fabricate a winner (sel-ac011a39)")
})

test("relay text: fallback and abstain never promise a chosen best", async () => {
  const { buildAutopilotRelay } = await import("../lib/selection/autopilot.js")
  const base = { selectionId: "sel-x", sourceSessionId: "s", startedAt: 1, finishedAt: 2, status: "completed", candidates: [] }
  const fb = buildAutopilotRelay({ ...base, outcome: "single_candidate_fallback", winnerBasis: "single-candidate", fallback: { index: 0, sessionId: "a", workspace: "W" } })
  assert.ok(fb.includes("SINGLE-SURVIVOR FALLBACK"))
  assert.ok(fb.includes("NEVER compared"), "the relay must state that no comparison happened")
  assert.ok(!fb.includes("ranked by the verifier"), "fallback copy must not imply selection")
  const ab = buildAutopilotRelay({ ...base, outcome: "abstain", margin: 0.01, marginThreshold: 0.03, marginProvisional: true, marginCondition: "m@low" })
  assert.ok(ab.includes("noise band"))
  assert.ok(!ab.includes("FINALIZER CONTRACT"), "abstain carries no finalizer contract")
  const insuff = buildAutopilotRelay({ ...base, outcome: "insufficient_evidence" })
  assert.ok(insuff.includes("Do NOT integrate"), "insufficient evidence must stop integration")
  const ranked = buildAutopilotRelay({ ...base, outcome: "ranked_winner", winnerBasis: "verifier", winner: { index: 0, sessionId: "a", workspace: "W" }, scores: [0.52, 0.48], ranking: [0, 1], margin: 0.04, marginThreshold: 0.03, marginProvisional: true, marginCondition: "m@low", finalists: [] })
  assert.ok(ranked.includes("FINALIZER CONTRACT"))
  assert.ok(ranked.includes("winner"), "a cleared margin keeps the winner framing")
  assert.ok(ranked.includes("Separation: clear"), "relay separation uses the record's actual margin gate instead of a stale hard-coded threshold")
})

test("post-audit delivery: yes needs integration AND passing configured tests (G-4)", async () => {
  const { evaluateDelivery } = await import("../lib/selection/candidates.js")
  // not audited
  assert.deepEqual(evaluateDelivery({ audited: false, headChanged: null, dirtyEntries: null, testsConfigured: false }).delivered, "unknown")
  // audited, nothing integrated
  assert.equal(evaluateDelivery({ audited: true, headChanged: false, dirtyEntries: 0, testsConfigured: false }).delivered, "no")
  // integrated but no test command configured -> honest unknown
  assert.equal(evaluateDelivery({ audited: true, headChanged: true, dirtyEntries: 0, testsConfigured: false }).delivered, "unknown")
  // integrated and tests pass -> yes
  assert.equal(evaluateDelivery({ audited: true, headChanged: true, dirtyEntries: 0, testsConfigured: true, testsExit: 0 }).delivered, "yes")
  // integrated but tests fail -> no
  assert.equal(evaluateDelivery({ audited: true, headChanged: false, dirtyEntries: 3, testsConfigured: true, testsExit: 1 }).delivered, "no")
})

test("recovery: a reload re-delivers a settled autopilot relay lost with the old host (sel-ac04cfd7 incident)", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "va-recover-"))
  try {
    const ledger = path.join(base, "selections.jsonl")
    const ctx = fakeContext()
    const source = ctx.spawnAgent(fakeAgent("sess-src", completedTurnEvents(1)))
    // Seed a ledger that finished under a previous host: settled autopilot
    // fallback, no relayedAt — exactly the orphan shape from sel-ac04cfd7.
    writeFileSync(ledger, JSON.stringify({
      selectionId: "sel-orphan", sourceSessionId: "sess-src", startedAt: 1, finishedAt: 2,
      status: "completed", trigger: "autopilot", outcome: "single_candidate_fallback",
      candidates: [], fallback: { index: 0, sessionId: "cand-1", workspace: path.join(base, "c0") },
    }) + "\n")
    mkdirSync(path.join(base, "c0"), { recursive: true })
    const host2 = new VerifierHost(ctx, hostOverrides({ enabled: false }), {
      selectionsFile: ledger,
      selectionsTesting: { factory: makeFakeFactory({}), workspaces: realWorkspaces, bridge: fakeBridge() },
    })
    host2.start()
    assert.ok(source.followups.length >= 1, "the lost relay is re-delivered after reload")
    assert.ok(source.followups.at(-1).source.form === "relay")
    assert.ok(source.followups.at(-1).content[0].text.includes("SINGLE-SURVIVOR FALLBACK"))
    const countAfterFirst = source.followups.length
    host2.start() // idempotence guard: a second start must not re-relay
    assert.equal(source.followups.length, countAfterFirst, "recovery is idempotent (record carries relayedAt)")
    const ledgerText = readFileSync(ledger, "utf8")
    assert.ok(ledgerText.includes("relayedAt"), "relay delivery is persisted, not only in memory")
    const host3 = new VerifierHost(ctx, hostOverrides({ enabled: false }), {
      selectionsFile: ledger,
      selectionsTesting: { factory: makeFakeFactory({}), workspaces: realWorkspaces, bridge: fakeBridge() },
    })
    host3.start()
    assert.equal(source.followups.length, countAfterFirst, "third generation skips delivery because relayedAt survived the reload")
    await host3.dispose()
    await host2.dispose()
    assert.ok(!existsSync(path.join(base, "c0")), "idle/dispose afterwards still owns workspace cleanup")
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("selection: a candidate whose turn ends in error is failed, never sent to the verifier", async () => {
  const errorEvents = [
    { type: "user/message", seq: 0, data: { content: [{ type: "text", text: "task" }], source: { kind: "user" } } },
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "step/start", seq: 2, data: { turn: 1, step: 1 } },
    { type: "step/end", seq: 3, data: { turn: 1, step: 1 } },
    { type: "turn/end", seq: 4, data: { turn: 1, reason: { kind: "error", error: { message: "prompt variable has no value" } } } },
  ]
  const factory = makeFakeFactory({ scripts: { 2: { events: errorEvents } } })
  const bridge = fakeBridge()
  const runner = new SelectionRunner({ factory, workspaces: realWorkspaces, bridge })
  const { record } = await runner.run(selInput({}))
  assert.equal(record.candidates[2].status, "failed")
  assert.ok(String(record.candidates[2].error).startsWith("turn-error"))
  assert.deepEqual(record.candidates[2].eliminatedBy, ["run-failed"], "turn-error candidates are marked non-eligible like other run failures")
  assert.equal(bridge.calls.length, 1, "verifier still compares the two real rollouts")
  assert.equal(bridge.calls[0].candidates.length, 2)
  assert.equal(record.status, "completed")
})

test("selection: seed prefix never enters the verifier trajectory payload", async () => {
  const seedEvents = [
    { type: "user/message", seq: 0, data: { content: [{ type: "text", text: "SEED-CONTEXT-MARKER" }], source: { kind: "user" } } },
    { type: "assistant/message", seq: 1, data: { message: { role: "assistant", content: [{ type: "text", text: "seed answer" }] } } },
  ]
  // The runtime RE-MINTS the seed prefix inside the child session as seqs
  // 0..1 (dsh-session append: seq = log.length, contiguous from 0); the
  // candidate's own rollout continues at seq 2. The runner must cut by that
  // boundary: seed text never reaches the verifier, own evidence must.
  const childEvents = (i) => seedEvents.concat([
    { type: "user/message", seq: 2, data: { content: [{ type: "text", text: "OWN-TASK-" + i }], source: { kind: "user" } } },
    { type: "turn/start", seq: 3, data: { turn: 1 } },
    { type: "tool/call", seq: 4, data: { turn: 1, name: "write", arguments: { file: "own-" + i + ".txt" } } },
    { type: "assistant/message", seq: 5, data: { message: { role: "assistant", content: [{ type: "text", text: "own work " + i }] } } },
    { type: "turn/end", seq: 6, data: { turn: 1, reason: { kind: "completed" } } },
  ])
  const factory = makeFakeFactory({ scripts: { 0: { events: childEvents(0) }, 1: { events: childEvents(1) } } })
  const bridge = fakeBridge()
  const runner = new SelectionRunner({ factory, workspaces: realWorkspaces, bridge })
  const { record } = await runner.run(selInput({ candidateCount: 2, seed: seedEvents }))
  assert.equal(record.status, "completed")
  assert.equal(bridge.calls.length, 1)
  assert.equal(bridge.calls[0].candidates.length, 2)
  for (const payload of bridge.calls[0].candidates) {
    assert.ok(!payload.includes("SEED-CONTEXT-MARKER"), "seed history must not leak into the verifier input")
    assert.ok(/OWN-TASK-\d/.test(payload), "the candidate's own rollout must be present")
  }
  assert.equal(record.candidates[0].eventCount, 5, "only the candidate's own events are counted")
})

test("selection: persistent transient bridge failure exhausts retries and reclaims every candidate", async () => {
  const factory = makeFakeFactory({})
  const bridge = fakeBridge(() => { throw new BridgeError("provider_error", "relay 500", true) })
  const delays = []
  const runner = new SelectionRunner({ factory, workspaces: realWorkspaces, bridge, sleep: async (delayMs) => { delays.push(delayMs) } })
  const { record, winner } = await runner.run(selInput({}))
  assert.equal(record.status, "failed")
  assert.equal(record.error, "relay 500")
  assert.equal(record.rankingAttempts, 2)
  assert.equal(record.rankingRetryErrors.length, 1)
  assert.deepEqual(delays, [2000])
  assert.equal(bridge.calls.length, 2)
  assert.equal(winner, undefined)
  for (const h of factory.handles) assert.equal(h.disposed, true)
})

test("checks: pass/fail/timeout surface as structured results", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "va-check-"))
  const results = await runChecks(dir, [
    { name: "ok", command: "exit 0" },
    { name: "fail", command: "exit 3" },
    { name: "slow", command: "Start-Sleep -Seconds 30", timeoutMs: 800 },
  ])
  assert.deepEqual(results.map((r) => [r.name, r.ok, r.exitCode]), [
    ["ok", true, 0],
    ["fail", false, 3],
    ["slow", false, null],
  ])
})

test("trajectory: renders evidence lines with stable ids and skips runtime noise", () => {
  const r = renderTrajectory(fakeEvents(7))
  assert.ok(r.text.includes("[E01] USER: task for candidate 7"))
  assert.ok(r.text.includes("[E02] TOOL CALL write:"), "tool calls are rendered")
  assert.ok(r.text.includes("TOOL RESULT: ") && r.text.includes("written ok 7"))
  assert.ok(r.text.includes("ASSISTANT: done 7"))
  assert.ok(!r.text.includes("turn/start"), "turn markers are folded")
  assert.equal(r.toolCalls, 1)
})

test("trajectory: fromSeq drops the seed prefix from the rendered evidence", () => {
  const events = [
    { type: "user/message", seq: 0, data: { content: [{ type: "text", text: "seeded history" }], source: { kind: "user" } } },
    { type: "assistant/message", seq: 1, data: { message: { role: "assistant", content: [{ type: "text", text: "seeded answer" }] } } },
    { type: "user/message", seq: 2, data: { content: [{ type: "text", text: "own task" }], source: { kind: "user" } } },
  ]
  const r = renderTrajectory(events, { fromSeq: 2 })
  assert.ok(!r.text.includes("seeded history"), "seed events stay out of the candidate trajectory")
  assert.ok(r.text.includes("own task"))
})

test("selhost: /select candidateOptions ride per candidate into factory spec and record", async () => {
  const { host, factory } = mkSelectionHost()
  const selectRoute = apiRoutes(host).find((r) => r.path.endsWith("/select"))
  const res = fakeRes()
  await selectRoute.handler(fakeReq({
    sourceSessionId: "sess-A",
    candidateOptions: [{}, { model: "weaker-model" }, { provider: "p2", model: "m2" }],
  }), res)
  assert.equal(res.status, 202, res.bodyText)
  const id = JSON.parse(res.bodyText).selection.selectionId
  const final = await waitFor(() => {
    const s = host.selections.getSelection(id)
    return s && s.status !== "running" ? s : null
  })
  assert.equal(final.status, "completed")
  assert.equal(final.candidates.length, 3, "array length implies the candidate count")
  assert.deepEqual(factory.calls[0].agentOptions, {}, "empty entry resolves to an empty merged object")
  assert.deepEqual(factory.calls[1].agentOptions, { provider: "kimi", model: "weaker-model" }, "model-only entry is completed with the default provider")
  assert.deepEqual(factory.calls[2].agentOptions, { provider: "p2", model: "m2" })
  assert.equal(final.candidates[0].agentOptions, undefined, "default-route candidate stays unannotated")
  assert.deepEqual(final.candidates[1].agentOptions, { provider: "kimi", model: "weaker-model" }, "record echoes the completed pair")
  assert.deepEqual(final.candidates[2].agentOptions, { provider: "p2", model: "m2" })
  await host.selections.dispose()
})

test("selhost: /select candidateOptions merge over shared candidateModel defaults", async () => {
  const { host, factory } = mkSelectionHost()
  const selectRoute = apiRoutes(host).find((r) => r.path.endsWith("/select"))
  const res = fakeRes()
  await selectRoute.handler(fakeReq({ sourceSessionId: "sess-A", candidateModel: "shared-model", candidateOptions: [{}, { model: "solo" }] }), res)
  assert.equal(res.status, 202, res.bodyText)
  const id = JSON.parse(res.bodyText).selection.selectionId
  const final = await waitFor(() => {
    const s = host.selections.getSelection(id)
    return s && s.status !== "running" ? s : null
  })
  assert.equal(final.status, "completed")
  assert.deepEqual(factory.calls[0].agentOptions, { provider: "kimi", model: "shared-model" }, "unspecified entry inherits the completed shared pair")
  assert.deepEqual(factory.calls[1].agentOptions, { provider: "kimi", model: "solo" }, "entry model overrides; provider backfilled from default route")
  await host.selections.dispose()
})

test("selhost: /select candidateOptions rejects count mismatch and malformed entries", async () => {
  const { host } = mkSelectionHost()
  const selectRoute = apiRoutes(host).find((r) => r.path.endsWith("/select"))
  let res = fakeRes()
  await selectRoute.handler(fakeReq({ sourceSessionId: "sess-A", candidateCount: 2, candidateOptions: [{}, {}, {}] }), res)
  assert.equal(JSON.parse(res.bodyText).error, "candidate-options-count-mismatch")
  res = fakeRes()
  await selectRoute.handler(fakeReq({ sourceSessionId: "sess-A", candidateOptions: [{ model: 5 }] }), res)
  assert.equal(JSON.parse(res.bodyText).error, "candidate-options-invalid")
  res = fakeRes()
  await selectRoute.handler(fakeReq({ sourceSessionId: "sess-A", candidateOptions: "not-an-array" }), res)
  assert.equal(JSON.parse(res.bodyText).error, "candidate-options-invalid")
  res = fakeRes()
  await selectRoute.handler(fakeReq({ sourceSessionId: "sess-A", candidateOptions: [{ sandbox: true }] }), res)
  assert.equal(JSON.parse(res.bodyText).error, "candidate-options-invalid", "unknown keys rejected")
  res = fakeRes()
  await selectRoute.handler(fakeReq({ sourceSessionId: "sess-A", marginThreshold: "not-a-number" }), res)
  assert.equal(res.status, 400)
  assert.equal(JSON.parse(res.bodyText).error, "margin-threshold-invalid", "non-number boundary values are rejected before candidate admission")
  res = fakeRes()
  await selectRoute.handler(fakeReq({ sourceSessionId: "sess-A", marginThreshold: null }), res)
  assert.equal(JSON.parse(res.bodyText).error, "margin-threshold-invalid", "null is not coerced to a zero margin gate")
  res = fakeRes()
  await selectRoute.handler(fakeReq({ sourceSessionId: "sess-A", marginThreshold: 0.6 }), res)
  assert.equal(JSON.parse(res.bodyText).error, "margin-threshold-invalid", "out-of-range margin gates are rejected rather than silently clamped")
  res = fakeRes()
  await selectRoute.handler(fakeReq({ sourceSessionId: "sess-A", trigger: "autopilot" }), res)
  assert.equal(JSON.parse(res.bodyText).error, "reserved-selection-field", "manual HTTP callers cannot claim the internal autopilot lifecycle")
  await host.selections.dispose()
})

test("selhost: /select partial route without a default route fails loudly (not at first turn)", async () => {
  const { host } = mkSelectionHost({ defaultRoute: null })
  const selectRoute = apiRoutes(host).find((r) => r.path.endsWith("/select"))
  let res = fakeRes()
  await selectRoute.handler(fakeReq({ sourceSessionId: "sess-A", candidateOptions: [{ model: "solo" }] }), res)
  assert.equal(JSON.parse(res.bodyText).error, "candidate-route-partial")
  res = fakeRes()
  await selectRoute.handler(fakeReq({ sourceSessionId: "sess-A", candidateCount: 1, candidateModel: "shared-only" }), res)
  assert.equal(JSON.parse(res.bodyText).error, "candidate-route-partial", "shared-only model override is also a toxic partial route")
  await host.selections.dispose()
})


// --- progressGuard: online hopeless-rollout abandonment (HANDOFF §2.3) ---
function progressScriptedBridge(scoreFor) {
  const bridge = fakeBridge()
  bridge.progressCalls = []
  bridge.progress = async (req) => {
    bridge.progressCalls.push(req)
    const m = /candidate (\d+)/.exec(req.steps.join(" "))
    const idx = m ? Number(m[1]) : 0
    return { score: scoreFor(idx), usage: { calls: 1, input_tokens: 1, cached_input_tokens: 0, uncached_input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, cache_hit_rate: 0 } }
  }
  return bridge
}

test("selrunner: progressGuard abandons a stalled hopeless candidate early, others proceed", async () => {
  const factory = makeFakeFactory({
    scripts: {
      0: { hang: true, partial: true }, // stuck: started work, then froze
      1: {}, 2: {},
    },
  })
  const bridge = progressScriptedBridge((idx) => idx === 0 ? 0.05 : 0.95)
  const runner = new SelectionRunner({ factory, workspaces: realWorkspaces, bridge })
  const { record } = await runner.run(selInput({
    progressGuard: { intervalMs: 25, minScore: 0.5, graceChecks: 2, maxChecks: 6 },
  }))
  const c0 = record.candidates[0]
  assert.equal(c0.status, "failed")
  assert.ok(String(c0.error).startsWith("progress-abandoned"), "stuck hopeless candidate is abandoned with a stated reason, got: " + c0.error)
  assert.ok(c0.progress && c0.progress.length >= 2, "samples recorded for the abandoned candidate")
  assert.equal(factory.handles[0].agent.cancelled, true, "cancel is the abandonment mechanism")
  assert.ok(["finished", "winner", "loser"].includes(record.candidates[1].status), "c1 survives: " + record.candidates[1].status)
  assert.ok(["finished", "winner", "loser"].includes(record.candidates[2].status), "c2 survives: " + record.candidates[2].status)
  assert.ok(!String(record.candidates[1].error ?? "").startsWith("progress-abandoned"), "healthy candidate not abandoned")
  assert.ok(!String(record.candidates[2].error ?? "").startsWith("progress-abandoned"), "healthy candidate not abandoned")
  assert.equal(record.status, "completed", "selection still completes on the survivors")
  assert.equal(bridge.calls.length, 1, "verifier select ran on survivors only")
})

test("selrunner: progressGuard never abandons when scores stay healthy", async () => {
  const factory = makeFakeFactory({})
  const bridge = progressScriptedBridge(() => 0.95)
  const runner = new SelectionRunner({ factory, workspaces: realWorkspaces, bridge })
  const { record } = await runner.run(selInput({
    progressGuard: { intervalMs: 15, minScore: 0.5, graceChecks: 2, maxChecks: 3 },
  }))
  assert.equal(record.status, "completed")
  for (const c of record.candidates) assert.notEqual(c.error ? String(c.error).slice(0, 18) : "", "progress-abandoned")
})

test("selhost: /select validates progressGuard shape", async () => {
  const { host } = mkSelectionHost()
  const selectRoute = apiRoutes(host).find((r) => r.path.endsWith("/select"))
  let res = fakeRes()
  await selectRoute.handler(fakeReq({ sourceSessionId: "sess-A", progressGuard: "yes" }), res)
  assert.equal(JSON.parse(res.bodyText).error, "progress-guard-invalid")
  res = fakeRes()
  await selectRoute.handler(fakeReq({ sourceSessionId: "sess-A", progressGuard: { intervalMs: 100 } }), res)
  assert.equal(JSON.parse(res.bodyText).error, "progress-guard-invalid", "intervalMs below floor rejected")
  res = fakeRes()
  await selectRoute.handler(fakeReq({ sourceSessionId: "sess-A", progressGuard: { unknownKnob: 1 } }), res)
  assert.equal(JSON.parse(res.bodyText).error, "progress-guard-invalid", "unknown keys rejected")
  res = fakeRes()
  await selectRoute.handler(fakeReq({ sourceSessionId: "sess-A", candidateCount: 1, progressGuard: {} }), res)
  assert.equal(res.status, 202, "empty guard object is a valid opt-in")
  await host.selections.dispose()
})

// ---------- 2026-08-30 tail fixes: sliding-window limiter, /select quota discipline, winnerless root sweep ----------

test("rate limiter: sliding window admits the cap, never a boundary burst, and ages stamps out", async () => {
  const { createRateLimiter } = await import("../lib/index.js")
  let t = 100000
  const limiter = createRateLimiter(2, 100, () => t)
  assert.equal(limiter(), true)
  assert.equal(limiter(), true)
  assert.equal(limiter(), false, "cap reached")
  t = 100099
  assert.equal(limiter(), false, "99% into the window: a fixed window would reset at the boundary — sliding must not")
  t = 100100
  // Both initial stamps (t=100000) age out together here, so up to two fresh
  // stamps fit — but never MORE than two inside ANY 100-wide window, which is
  // exactly the boundary-burst property a fixed window lacks.
  assert.equal(limiter(), true)
  assert.equal(limiter(), true)
  assert.equal(limiter(), false, "window full again — never more than the cap in any window")
  t = 100199
  assert.equal(limiter.peek(), false)
  assert.equal(limiter.peek(), false, "rejected peeks and 429s never consume")
  t = 100200
  assert.equal(limiter.peek(), true, "stamps age out as the window slides")
  limiter.commit()
  limiter.commit()
  assert.equal(limiter.peek(), false, "commits occupy the window")
})

test("selhost: /select admissions refused by the host never burn the hourly quota", async () => {
  const { API_RATE_LIMITS } = await import("../lib/index.js")
  const { host } = mkSelectionHost()
  const routes = apiRoutes(host)
  const selectRoute = routes.find((r) => r.path.endsWith("/select"))
  // 13 > 12/hour refused admissions (unknown source session reaches start() and
  // throws): under count-then-reject the 13th refusal would already be a 429.
  for (let i = 0; i < API_RATE_LIMITS.selectPerHour + 1; i += 1) {
    const res = fakeRes()
    await selectRoute.handler(fakeReq({ problem: "x", sourceSessionId: "session-gone" }), res)
    assert.equal(res.status, 404, "refused admission #" + i + " stays a plain 404, never becomes quota exhaustion")
    assert.equal(JSON.parse(res.bodyText).error, "source-session-not-found")
  }
  // The full quota survives for real admitted runs: drain it with fast N=1 wins.
  for (let i = 0; i < API_RATE_LIMITS.selectPerHour; i += 1) {
    const res = fakeRes()
    await selectRoute.handler(fakeReq({ sourceSessionId: "sess-A", candidateCount: 1 }), res)
    assert.equal(res.status, 202, "admitted run #" + i + " consumes exactly one slot")
    const id = JSON.parse(res.bodyText).selection.selectionId
    await waitFor(() => {
      const s = host.selections.getSelection(id)
      return s && s.status !== "running" ? s : null
    })
  }
  const throttled = fakeRes()
  await selectRoute.handler(fakeReq({ sourceSessionId: "sess-A", candidateCount: 1 }), throttled)
  assert.equal(throttled.status, 429, "the first admission past the real quota is throttled")
  await host.selections.dispose()
})

test("selection: a failed run sweeps its empty workspace root; a winner's root stays", async () => {
  // Failed run (preflight throws before any candidate): the root must not linger.
  const failedRunner = new SelectionRunner({
    factory: makeFakeFactory({}), workspaces: realWorkspaces, bridge: fakeBridge(),
    preflight: async () => { throw new BridgeError("preflight_failed", "scores 0.5/0.5", false) },
  })
  const failed = await failedRunner.run(selInput({}))
  assert.equal(failed.record.status, "failed")
  assert.equal(existsSync(path.join(SEL_TMP, failed.record.selectionId)), false, "winnerless run root swept")

  // Winner run: root and winner workspace survive; the loser dir is still removed.
  const okRunner = new SelectionRunner({
    factory: makeFakeFactory({}), workspaces: realWorkspaces, bridge: fakeBridge(),
  })
  const done = await okRunner.run(selInput({ candidateCount: 2 }))
  assert.equal(done.record.status, "completed")
  assert.ok(done.retained)
  const root = path.join(SEL_TMP, done.record.selectionId)
  assert.equal(existsSync(root), true, "winner run root retained")
  assert.equal(existsSync(done.retained.workspace), true, "retained workspace survives")
  const loser = done.record.candidates[1 - done.retained.candidateIndex]
  assert.equal(existsSync(loser.workspace), false, "loser workspace removed as before")
  rmSync(root, { recursive: true, force: true })
})

// ---------- 2026-08-30 细节修复：会话残骸回收 / winner 自动释放 / 结算通知 ----------

test("live: projectStoreKey matches the session store's directory convention", async () => {
  const { projectStoreKey } = await import("../lib/selection/live.js")
  assert.equal(projectStoreKey("D:\\tools\\x\\c0"), "--D-tools-x-c0--")
  assert.equal(projectStoreKey("C:\\x y\\中"), "--C-x~0020y-~4E2D--")
  assert.equal(projectStoreKey("\\server\\share"), "--server-share--")
})

test("selection: disposed losers lose BOTH workspace and session record; the winner keeps both", async () => {
  const { projectStoreKey } = await import("../lib/selection/live.js")
  const storeTmp = mkdtempSync(path.join(tmpdir(), "va-store-"))
  const purged = []
  const wsx = {
    async prepare(sel) { const dir = path.join(SEL_TMP, sel.selectionId, "c" + sel.index); mkdirSync(dir, { recursive: true }); return dir },
    async remove(dir) { rmSync(dir, { recursive: true, force: true }) },
    async purgeSessionRecord(dir) { purged.push(dir); rmSync(path.join(storeTmp, projectStoreKey(dir)), { recursive: true, force: true }) },
  }
  const selectionId = "sel-purge-check"
  for (let i = 0; i < 3; i += 1) mkdirSync(path.join(storeTmp, projectStoreKey(path.join(SEL_TMP, selectionId, "c" + i))), { recursive: true })
  const runner = new SelectionRunner({ factory: makeFakeFactory({}), workspaces: wsx, bridge: fakeBridge() })
  const { record, winner } = await runner.run(selInput({ selectionId }))
  assert.equal(record.status, "completed")
  assert.equal(purged.length, 2, "exactly the two losers are purged")
  assert.ok(!purged.includes(record.winner.workspace), "winner session record is never purged")
  assert.ok(existsSync(path.join(storeTmp, projectStoreKey(record.winner.workspace))), "winner store dir survives")
  for (const p of purged) assert.equal(existsSync(path.join(storeTmp, projectStoreKey(p))), false, "loser store dirs gone")
  rmSync(path.join(SEL_TMP, selectionId), { recursive: true, force: true })
  rmSync(storeTmp, { recursive: true, force: true })
})

test("selhost: record carries the effective config snapshot that reload drift cannot rewrite (F5)", async () => {
  const ctx = fakeContext()
  ctx.setService("agentDefaultModel", { currentSelection: () => ({ provider: "kimi", model: "kimi-k3" }) })
  const host = new VerifierHost(ctx, hostOverrides({ selectionMarginThreshold: 0.2 }), {
    selectionsTesting: { factory: makeFakeFactory({}), workspaces: realWorkspaces, bridge: fakeBridge() },
  })
  ctx.spawnAgent(fakeAgent("sess-A", completedTurnEvents(1)))
  const routes = apiRoutes(host)
  const res = fakeRes()
  await routes.find((r) => r.path.endsWith("/select")).handler(fakeReq({ sourceSessionId: "sess-A", candidateCount: 2 }), res)
  assert.equal(res.status, 202)
  const id = JSON.parse(res.bodyText).selection.selectionId
  const final = await waitFor(() => { const s = host.selections.getSelection(id); return s && s.status !== "running" ? s : null })
  assert.equal(final.status, "completed")
  assert.equal(final.outcome, "ranked_winner")
  assert.equal(final.marginThreshold, 0.2, "the threshold at run time is recorded, not a later reload value")
  assert.equal(final.marginProvisional, true)
  assert.equal(final.marginCondition, "mock@max")
  assert.equal(final.configSnapshot.verifierModel, "mock")
  assert.equal(final.configSnapshot.verifierEffort, "max")
  assert.equal(final.configSnapshot.selectTimeoutMs, 30000)
  assert.equal(final.configSnapshot.trigger, "manual")
  assert.equal(final.configSnapshot.marginThreshold, 0.2)
  assert.deepEqual(final.configSnapshot.candidateOptions, [{ provider: null, model: null, shared: true }], "a manual run without an explicit pool records the honestly-absent default route")
  await host.selections.dispose()
})

test("selhost: a real selection without any Git source cwd fails closed instead of running in the host process directory", async () => {
  // 2026-09-13 incident: a manual /select with no source cwd degraded the
  // workspace adapter to a blank dir, the candidate wrote through
  // process.cwd(), and percent.js/percent.test.js landed inside the installed
  // @deepseek-ai/dsh package — the runtime then died on a native assertion.
  // A live (non-injected) host must refuse that shape outright.
  const ctx = fakeContext()
  ctx.setService("agentDefaultModel", { currentSelection: () => ({ provider: "kimi", model: "kimi-k3" }) })
  const host = new VerifierHost(ctx, hostOverrides(), { selectionsTesting: { bridge: fakeBridge() } })
  await assert.rejects(
    () => host.selections.start({ problem: "write files", candidateCount: 2 }),
    (error) => {
      assert.equal(error.code, "source-cwd-required")
      return true
    },
  )
  assert.equal(host.selections.listSelections().length, 0, "no placeholder record is created for a refused run")
  await host.selections.dispose()
})

test("selhost: discard removes the winner workspace + session record and rejects a second discard", async () => {
  const { projectStoreKey } = await import("../lib/selection/live.js")
  const storeTmp = mkdtempSync(path.join(tmpdir(), "va-store-"))
  const purged = []
  const wsx = {
    async prepare(sel) { const dir = path.join(SEL_TMP, sel.selectionId, "c" + sel.index); mkdirSync(dir, { recursive: true }); return dir },
    async remove(dir) { rmSync(dir, { recursive: true, force: true }) },
    async purgeSessionRecord(dir) { purged.push(dir); rmSync(path.join(storeTmp, projectStoreKey(dir)), { recursive: true, force: true }) },
  }
  const ctx = fakeContext()
  ctx.setService("agentDefaultModel", { currentSelection: () => ({ provider: "kimi", model: "kimi-k3" }) })
  const host = new VerifierHost(ctx, hostOverrides(), { selectionsTesting: { factory: makeFakeFactory({}), workspaces: wsx, bridge: fakeBridge() } })
  ctx.spawnAgent(fakeAgent("sess-A", completedTurnEvents(1)))
  const routes = apiRoutes(host)
  const selectRoute = routes.find((r) => r.path.endsWith("/select"))
  const discardRoute = routes.find((r) => r.path.endsWith("/selections/discard"))
  const res = fakeRes()
  await selectRoute.handler(fakeReq({ sourceSessionId: "sess-A", candidateCount: 2 }), res)
  assert.equal(res.status, 202)
  const id = JSON.parse(res.bodyText).selection.selectionId
  const final = await waitFor(() => { const s = host.selections.getSelection(id); return s && s.status !== "running" ? s : null })
  assert.equal(final.status, "completed")
  const winnerWs = final.winner.workspace
  mkdirSync(path.join(storeTmp, projectStoreKey(winnerWs)), { recursive: true })
  const d1 = fakeRes()
  await discardRoute.handler(fakeReq({ selectionId: id }), d1)
  assert.equal(d1.status, 200)
  assert.equal(existsSync(winnerWs), false, "winner workspace deleted on discard")
  assert.equal(existsSync(path.join(storeTmp, projectStoreKey(winnerWs))), false, "winner session record purged on discard")
  assert.ok(host.selections.getSelection(id).winner.discardedAt, "discard is recorded on the settlement")
  const d2 = fakeRes()
  await discardRoute.handler(fakeReq({ selectionId: id }), d2)
  assert.equal(d2.status, 404, "second discard finds nothing discardable")
  await host.selections.dispose()
  rmSync(storeTmp, { recursive: true, force: true })
})

test("selhost: audit pack directory holds record + traces + patches, captured before cleanup (F6)", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "va-artifact-"))
  try {
    const { SelectionHost } = await import("../lib/selection/host.js")
    const ctx = fakeContext()
    ctx.setService("agentDefaultModel", { currentSelection: () => ({ provider: "kimi", model: "kimi-k3" }) })
    const ledgerFile = path.join(base, "led", "s.jsonl")
    let n = 0
    const candidates = ["alpha", "beta"]
    const host = new VerifierHost(ctx, hostOverrides(), {
      selectionsFile: ledgerFile,
      selectionsTesting: {
        factory: makeFakeFactory({}),
        workspaces: realWorkspaces,
        bridge: fakeBridge(),
        diffStat: async () => ({ files: 1, insertions: 3, deletions: 0, untracked: 1, fingerprint: "fp" + (n++), __: 0 }),
        diffFull: async (cwd) => ({ patch: "diff --git a/notes.md b/notes.md\n+hello-from-" + path.basename(cwd) + "\n", truncated: false, untrackedFiles: ["NEW.txt"] }),
      },
    })
    ctx.spawnAgent(fakeAgent("sess-A", completedTurnEvents(1)))
    const res = fakeRes()
    await apiRoutes(host).find((r) => r.path.endsWith("/select")).handler(fakeReq({ sourceSessionId: "sess-A", candidateCount: 2 }), res)
    assert.equal(res.status, 202)
    const id = JSON.parse(res.bodyText).selection.selectionId
    await waitFor(() => { const s = host.selections.getSelection(id); return s && s.status !== "running" ? s : null })
    const ledgerRows = readFileSync(ledgerFile, "utf8").trim().split("\n").map(line => JSON.parse(line))
    assert.ok(ledgerRows.length > 0 && ledgerRows.every(row => row.v === 1), "selection history uses the same versioned ledger contract")
    const dir = path.join(base, "led", "selection-artifacts", id)
    assert.ok(existsSync(path.join(dir, "record.json")), "record.json lands in the per-selection directory")
    const rec = JSON.parse(readFileSync(path.join(dir, "record.json"), "utf8")).record
    assert.equal(rec.outcome, "ranked_winner", "diverse fingerprints keep the tournament")
    for (const i of [0, 1]) {
      const trace = readFileSync(path.join(dir, "traces", "c" + i + ".txt"), "utf8")
      assert.ok(trace.includes("TOOL CALL"), "candidate " + i + " trajectory text is preserved")
      const patch = readFileSync(path.join(dir, "diffs", "c" + i + ".patch"), "utf8")
      assert.ok(patch.includes("hello-from-c" + i), "candidate " + i + " diff text preserved even after workspace disposal")
    }
    await host.selections.dispose()
    // discard refreshes record.json (discardedAt) without touching traces/diffs
    const discardRoute = apiRoutes(host).find((r) => r.path.endsWith("/selections/discard"))
    const dres = fakeRes()
    await discardRoute.handler(fakeReq({ selectionId: id }), dres)
    assert.equal(dres.status, 200)
    const rec2 = JSON.parse(readFileSync(path.join(dir, "record.json"), "utf8")).record
    assert.ok(rec2.winner.discardedAt, "discardedAt rewritten into record.json")
    assert.ok(existsSync(path.join(dir, "traces", "c0.txt")), "traces survive a discard refresh")
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("selhost: settlement file dedupes later discard lines over the original record", async () => {
  const { SelectionHost } = await import("../lib/selection/host.js")
  const f = path.join(SEL_TMP, "sel-ledger-" + Date.now() + ".jsonl")
  const base = { selectionId: "sel-a", sourceSessionId: null, status: "completed", candidates: [], startedAt: 1, finishedAt: 2 }
  writeFileSync(f, JSON.stringify({ ...base, winner: { index: 0, sessionId: "s", workspace: "w" } }) + "\n"
    + JSON.stringify({ ...base, winner: { index: 0, sessionId: "s", workspace: "w", discardedAt: 9 } }) + "\n"
    + JSON.stringify({ ...base, selectionId: "sel-../../escape" }) + "\n")
  const host2 = new SelectionHost({ verifier: () => ({ model: "m", baseURL: "u", apiKeyEnv: "k" }), selectionsFile: f })
  const rec = host2.getSelection("sel-a")
  assert.equal(rec.winner.discardedAt, 9, "the later settlement line wins")
  assert.equal(host2.listSelections().length, 1, "no duplicate history entries and unsafe persisted ids are rejected")
  assert.equal(host2.getSelection("sel-../../escape"), undefined, "a ledger id can never become an audit-pack path traversal")
  await host2.dispose()
})

test("selhost: selectionNotify=false stays silent in the source session", async () => {
  const ctx = fakeContext()
  ctx.setService("agentDefaultModel", { currentSelection: () => ({ provider: "kimi", model: "kimi-k3" }) })
  const host = new VerifierHost(ctx, hostOverrides({ selectionNotify: false }), { selectionsTesting: { factory: makeFakeFactory({}), workspaces: realWorkspaces, bridge: fakeBridge() } })
  const source = ctx.spawnAgent(fakeAgent("sess-A", completedTurnEvents(1)))
  const selectRoute = apiRoutes(host).find((r) => r.path.endsWith("/select"))
  const res = fakeRes()
  await selectRoute.handler(fakeReq({ sourceSessionId: "sess-A", candidateCount: 1 }), res)
  assert.equal(res.status, 202)
  const id = JSON.parse(res.bodyText).selection.selectionId
  await waitFor(() => { const s = host.selections.getSelection(id); return s && s.status !== "running" ? s : null })
  assert.equal(source.followups.length, 0, "no settlement notice when disabled")
  await host.selections.dispose()
})

test("settlement notices never consume the session's verifier feedback quota", async () => {
  const ev = [{ type: "user/message", data: { source: { kind: "plugin", plugin: "@dsh-external/dsh-verifier-autopilot/selection", form: "notice" }, content: [{ type: "text", text: "[Selection 结算] sel-x 已完成" }] } }]
  assert.equal(feedbackSentCount(ev), 0, "selection notices are not verifier feedback")
})

function runGit(cwd, ...args) {
  return String(execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).trim()
}

function makeGitRepo(parent, name) {
  const repo = path.join(parent, name)
  mkdirSync(path.join(repo, "src"), { recursive: true })
  runGit(repo, "init", "-q")
  runGit(repo, "config", "user.email", "autopilot-test@example.invalid")
  runGit(repo, "config", "user.name", "Autopilot Test")
  writeFileSync(path.join(repo, "tracked.txt"), "tracked-base\n")
  writeFileSync(path.join(repo, "staged.txt"), "staged-base\n")
  writeFileSync(path.join(repo, "src", "entry.ts"), "export const value = 1\n")
  runGit(repo, "add", ".")
  runGit(repo, "commit", "-qm", "fixture")
  return repo
}

test("autopilot policy: named-session continuation is status control, not a refactor task", async () => {
  const { planAutopilotTask } = await import("../lib/selection/autopilot.js")
  const config = {
    mode: "auto", provider: "kimi", preferredModels: ["minimaxai/minimax-m3"], modelStrategy: "quality-first",
    standardCandidates: 2, deepCandidates: 3, nEvaluations: 4, candidateTimeoutMs: 30000, selectTimeoutMs: 30000,
  }
  const control = planAutopilotTask("会话名称：重构多模型自动选优架构，继续这个会话", ["minimaxai/minimax-m3"], config)
  assert.equal(control.admitted, false)
  assert.equal(control.reason, "status-only")
  const real = planAutopilotTask("Refactor src/selection/host.ts and verify the lifecycle tests", ["minimaxai/minimax-m3"], config)
  assert.equal(real.admitted, true, "an actual implementation task remains eligible")
})

test("autopilot policy: a completion report is never admitted as a task (K.4-7)", async () => {
  const { planAutopilotTask } = await import("../lib/selection/autopilot.js")
  const config = {
    mode: "auto", provider: "kimi", preferredModels: ["minimaxai/minimax-m3"], modelStrategy: "quality-first",
    standardCandidates: 2, deepCandidates: 3, nEvaluations: 2, candidateTimeoutMs: 30000, selectTimeoutMs: 30000,
  }
  // sel-1c8d28ef burned a deep selection on a source agent's own收尾汇报.
  const report = "本轮已全部完成并收口：npm test 173/173 全部通过，证据 sel-fa093cb5 已记录。\n\n验证通过，交付如下汇总。"
  const plan = planAutopilotTask(report, ["minimaxai/minimax-m3"], config)
  assert.equal(plan.admitted, false)
  assert.equal(plan.reason, "status-report")
  const imperativeReport = planAutopilotTask("之前已完成一半，请继续修复剩下的错误", ["minimaxai/minimax-m3"], config)
  assert.equal(imperativeReport.admitted, true, "continued work with an imperative verb is still a task")
})

test("autopilot policy: task-kind classification separates code from analysis (I.3)", async () => {
  const { planAutopilotTask, classifyTaskKind } = await import("../lib/selection/autopilot.js")
  assert.equal(classifyTaskKind("Fix src/a.ts and run the tests"), "code-change")
  assert.equal(classifyTaskKind("新建 README.md 并提交"), "code-change")
  assert.equal(classifyTaskKind("分析这个模块的耦合情况并给出评审意见"), "analysis-text")
  assert.equal(classifyTaskKind("review the queue design and explain the tradeoffs"), "analysis-text")
  assert.equal(classifyTaskKind("hello world plain text"), "unknown")
  const config = {
    mode: "always", provider: "kimi", preferredModels: ["minimaxai/minimax-m3"], modelStrategy: "quality-first",
    standardCandidates: 2, deepCandidates: 3, nEvaluations: 2, candidateTimeoutMs: 30000, selectTimeoutMs: 30000,
  }
  const plan = planAutopilotTask("审查淘汰策略和裁决逻辑并给出结论", ["minimaxai/minimax-m3"], config)
  assert.equal(plan.taskKind, "analysis-text", "policy carries the admission-time task kind into the ledger")
})

// ---------- P-C: candidate-model liveness probing ----------

test("model prober: liveness beats catalog membership, with caching and cooldown", async () => {
  const { createModelProber } = await import("../lib/selection/probe.js")
  const calls = []
  let now = 1000
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body.model)
    if (body.model === "dead-model") throw new Error("relay timeout")
    return { ok: true, status: 200 }
  }
  const prober = createModelProber({ baseURL: "http://relay.local/v1", apiKey: "k", fetchImpl, now: () => now })
  assert.equal(await prober.probe("good-model"), true)
  assert.equal(await prober.probe("dead-model"), false)
  assert.equal(await prober.probe("dead-model"), false, "dead verdict is memoized inside the cooldown window")
  assert.deepEqual(calls, ["good-model", "dead-model"], "the memoized dead model is not re-probed repeatedly")
  assert.equal(await prober.probe("good-model"), true)
  now += 130_000
  assert.equal(await prober.probe("dead-model"), false, "after cooldown the dead model is re-probed once")
  assert.equal(calls.length, 3, "cache hit + window re-probe account for exactly three fetches")
  prober.markDead("good-model", "rollout failed")
  assert.equal(prober.snapshot()["good-model"].ok, false, "explicit failures push the model into the dead window")
})

test("model prober: default fetch targets chat/completions with the api key", async () => {
  const { createModelProber } = await import("../lib/selection/probe.js")
  let seen = null
  const fetchImpl = async (url, init) => { seen = { url, init }; return { ok: true, status: 200 } }
  const prober = createModelProber({ baseURL: "http://relay.local/v1/", apiKey: "k", fetchImpl })
  assert.equal(await prober.probe("m"), true)
  assert.equal(seen.url, "http://relay.local/v1/chat/completions")
  assert.equal(seen.init.headers.authorization, "Bearer k")
  assert.equal(JSON.parse(seen.init.body).max_tokens, 1)
})

test("autopilot pre-step: all-dead preferred pool fails closed, never a ghost tournament", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "va-probe-"))
  try {
    const repo = makeGitRepo(base, "source")
    const ctx = fakeContext()
    ctx.setService("agentDefaultModel", { currentSelection: () => ({ provider: "kimi", model: "kimi-k3" }) })
    ctx.credentials = { resolve: async () => ({ value: "probe-test-key" }) }
    ctx.llm = { async listModels() { return [{ id: "kimi-k3" }, { id: "ghost" }] } }
    const ApolloSignals = { started: 0 }
    const host = new VerifierHost(ctx, hostOverrides({ enabled: false, selectionProbeEnabled: true }), {
      selectionsTesting: { factory: makeFakeFactory({}), workspaces: realWorkspaces, bridge: fakeBridge() },
    })
    // Force both catalog models to report dead by poking the fetch used by the prober.
    const source = ctx.spawnAgent(fakeAgent("sess-dead", completedTurnEvents(1)))
    source.session.header = { cwd: repo }
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => ({ ok: false, status: 410, body: null })
    host.start()
    try {
      const preStep = source.handlers.get("agent/pre-step")[0]
      const direct = { id: "u1", role: "user", content: [{ type: "text", text: "Fix src/x.ts and run the tests" }], source: { kind: "user" } }
      const decision = await preStep({ messages: [direct], turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: "enter", messages: [direct] }))
      assert.equal(decision.kind, "enter", "source turn proceeds normally")
      assert.equal(host.selections.listSelections().length, 0, "no selection started when every preferred model is dead")
    } finally {
      globalThis.fetch = origFetch
    }
    await host.dispose()
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test("autopilot policy: quality-first repeats the strongest available route and exploration rotates explicitly", async () => {
  const { planAutopilotTask } = await import("../lib/selection/autopilot.js")
  const base = {
    mode: "auto", provider: "kimi", preferredModels: ["kimi-k3", "deepseek-ai/deepseek-v4-pro-0813", "minimaxai/minimax-m3"],
    standardCandidates: 3, deepCandidates: 3, nEvaluations: 2, candidateTimeoutMs: 30000, selectTimeoutMs: 30000,
  }
  const task = "Implement the repository change and verify the relevant tests in src/selection/host.ts"
  const quality = planAutopilotTask(task, ["kimi-k3", "deepseek-ai/deepseek-v4-pro-0813", "minimaxai/minimax-m3"], { ...base, modelStrategy: "quality-first" })
  assert.equal(quality.admitted, true)
  assert.equal(quality.modelStrategy, "quality-first")
  assert.deepEqual(quality.candidateOptions.map(route => route.model), ["kimi-k3", "kimi-k3", "kimi-k3"], "quality-first spends every rollout on the first usable route")
  const fallback = planAutopilotTask(task, ["deepseek-ai/deepseek-v4-pro-0813", "minimaxai/minimax-m3"], { ...base, modelStrategy: "quality-first" })
  assert.deepEqual(fallback.candidateOptions.map(route => route.model), ["deepseek-ai/deepseek-v4-pro-0813", "deepseek-ai/deepseek-v4-pro-0813", "deepseek-ai/deepseek-v4-pro-0813"], "quality-first skips unavailable stronger routes without rotating to weaker ones")
  const exploration = planAutopilotTask(task, ["kimi-k3", "deepseek-ai/deepseek-v4-pro-0813", "minimaxai/minimax-m3"], { ...base, modelStrategy: "exploration" })
  assert.equal(exploration.modelStrategy, "exploration")
  assert.deepEqual(exploration.candidateOptions.map(route => route.model), ["kimi-k3", "deepseek-ai/deepseek-v4-pro-0813", "minimaxai/minimax-m3"], "exploration is the only mode that rotates the quality-ranked pool")
  const custom = planAutopilotTask(task, ["z-ai/glm-5.3-flash"], { ...base, preferredModels: ["z-ai/glm-5.3-flash"], modelStrategy: "quality-first" })
  assert.equal(custom.admitted, true)
  assert.deepEqual(custom.candidateOptions.map(route => route.model), ["z-ai/glm-5.3-flash", "z-ai/glm-5.3-flash", "z-ai/glm-5.3-flash"], "operator-supplied model IDs are valid without a fixed model allowlist")
  assert.equal(new Set(quality.candidateInstructions).size, 3, "independent candidates retain distinct strategy instructions")
})

test("live: non-git session roots resolve only one explicitly referenced nested repository", async () => {
  const { resolveAutopilotSourceCwd } = await import("../lib/selection/live.js")
  const base = mkdtempSync(path.join(tmpdir(), "va-resolve-"))
  try {
    const repo = makeGitRepo(base, "primary")
    const other = makeGitRepo(base, "other")
    assert.equal(await resolveAutopilotSourceCwd("Refactor primary/src/entry.ts and run tests", base), repo)
    assert.equal(await resolveAutopilotSourceCwd("Refactor the current project", base), undefined, "never scan and guess under a non-git root")
    assert.equal(await resolveAutopilotSourceCwd("Compare primary/src/entry.ts with other/src/entry.ts", base), undefined, "multiple repositories are ambiguous")
    assert.equal(await resolveAutopilotSourceCwd("Fix entry.ts", path.join(repo, "src")), path.join(repo, "src"), "a session already inside Git preserves its working subpath")
    assert.equal(await resolveAutopilotSourceCwd("Also edit " + path.join(other, "src", "entry.ts"), path.join(repo, "src")), undefined, "a task spanning another explicit repository falls back to the parent")
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test("live: git workspace mirrors dirty content, removes from the source repo, and rejects path escape", async () => {
  const { IsolatedWorkspaceManager } = await import("../lib/selection/live.js")
  const base = mkdtempSync(path.join(tmpdir(), "va-worktree-"))
  try {
    const repo = makeGitRepo(base, "source")
    writeFileSync(path.join(repo, "tracked.txt"), "tracked-dirty\n")
    writeFileSync(path.join(repo, "staged.txt"), "staged-dirty\n")
    runGit(repo, "add", "staged.txt")
    writeFileSync(path.join(repo, "untracked.txt"), "untracked\n")
    const managedRoot = path.join(base, "managed")
    const storeRoot = path.join(base, "store")
    const manager = new IsolatedWorkspaceManager(managedRoot, storeRoot)
    const candidateCwd = await manager.prepare({ selectionId: "sel-snapshot", index: 0, sourceCwd: path.join(repo, "src"), strictSnapshot: true })
    const candidateRoot = path.dirname(candidateCwd)
    assert.equal(readFileSync(path.join(candidateRoot, "tracked.txt"), "utf8"), "tracked-dirty\n")
    assert.equal(readFileSync(path.join(candidateRoot, "staged.txt"), "utf8"), "staged-dirty\n")
    assert.equal(readFileSync(path.join(candidateRoot, "untracked.txt"), "utf8"), "untracked\n")
    assert.ok(runGit(repo, "worktree", "list", "--porcelain").includes(candidateRoot.replaceAll("\\", "/")))
    await manager.remove(candidateCwd)
    assert.equal(existsSync(candidateRoot), false)
    assert.equal(runGit(repo, "worktree", "list", "--porcelain").includes(candidateRoot.replaceAll("\\", "/")), false, "main repo has no stale worktree registration")
    const outside = path.join(base, "outside")
    mkdirSync(outside)
    await assert.rejects(manager.remove(outside), /workspace-path-outside-managed-root/)
    await assert.rejects(manager.purgeSessionRecord(outside), /workspace-path-outside-managed-root/)
    assert.equal(existsSync(outside), true, "rejected cleanup cannot delete the unrelated directory")
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test("live: strict snapshots reject unknown ignored inputs but allow generated directories", async () => {
  const { IsolatedWorkspaceManager } = await import("../lib/selection/live.js")
  const base = mkdtempSync(path.join(tmpdir(), "va-ignored-"))
  try {
    const repo = makeGitRepo(base, "source")
    writeFileSync(path.join(repo, ".gitignore"), "node_modules/\nlib/\n.data/\neval/results/\n*.tsbuildinfo\n*.tgz\nprivate-input.txt\n")
    runGit(repo, "add", ".gitignore")
    runGit(repo, "commit", "-qm", "ignore-rules")
    mkdirSync(path.join(repo, "node_modules"), { recursive: true })
    writeFileSync(path.join(repo, "node_modules", "cache.txt"), "generated")
    mkdirSync(path.join(repo, "lib"), { recursive: true })
    writeFileSync(path.join(repo, "lib", "bundle.js"), "generated")
    writeFileSync(path.join(repo, "private-input.txt"), "must-not-disappear")
    const manager = new IsolatedWorkspaceManager(path.join(base, "managed"), path.join(base, "store"))
    await assert.rejects(
      manager.prepare({ selectionId: "sel-ignored-reject", index: 0, sourceCwd: repo, strictSnapshot: true }),
      /workspace-ignored-input-unsupported/,
      "unknown ignored inputs are never silently omitted",
    )
    rmSync(path.join(repo, "private-input.txt"))
    const candidateCwd = await manager.prepare({ selectionId: "sel-ignored-allow", index: 0, sourceCwd: repo, strictSnapshot: true })
    const candidateRoot = path.dirname(candidateCwd)
    assert.equal(existsSync(path.join(candidateRoot, "node_modules")), false, "allowed dependency directories remain excluded")
    assert.equal(existsSync(path.join(candidateRoot, "lib")), false, "allowed build directories remain excluded")
    await manager.remove(candidateCwd)
    assert.equal(existsSync(candidateRoot), false)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test("selhost: a tampered persisted winner path cannot escape the managed workspace root", async () => {
  const { SelectionHost } = await import("../lib/selection/host.js")
  const base = mkdtempSync(path.join(tmpdir(), "va-ledger-path-"))
  try {
    const outside = path.join(base, "outside")
    mkdirSync(outside)
    writeFileSync(path.join(outside, "keep.txt"), "keep")
    const ledger = path.join(base, "selections.jsonl")
    const record = {
      selectionId: "sel-tampered", sourceSessionId: null, startedAt: 1, finishedAt: 2,
      status: "completed", candidates: [], winner: { index: 0, sessionId: "s", workspace: outside }, verifierModel: "m",
    }
    writeFileSync(ledger, JSON.stringify(record) + "\n")
    const host = new SelectionHost({
      verifier: () => ({ model: "m", baseURL: "http://local", apiKeyEnv: "K" }),
      workspaceRoot: path.join(base, "managed"), selectionsFile: ledger,
    })
    await assert.rejects(host.discardWinner("sel-tampered"), /workspace-path-outside-managed-root/)
    assert.equal(existsSync(path.join(outside, "keep.txt")), true)
    assert.equal(host.getSelection("sel-tampered").winner.discardedAt, undefined, "failed cleanup remains retryable and never lies")
    await host.dispose()
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test("workspace manager: a foreign git repo above the managed root must not hijack lease discovery", async () => {
  const { IsolatedWorkspaceManager } = await import("../lib/selection/live.js")
  const base = mkdtempSync(path.join(tmpdir(), "va-foreign-repo-"))
  try {
    // Reproduces 2026-09-05 live failure: .data/selection-workspaces sits
    // inside the PLUGIN's own git repo. A plain (non-worktree) candidate
    // directory resolves rev-parse --show-toplevel to that outer repo, which
    // previously poisoned discoverLease with workspace-path-outside-managed-
    // root and turned manual discard into a 400 + leaked empty dirs.
    const repo = makeGitRepo(base, "plugin-repo")
    const root = path.join(repo, ".data", "selection-workspaces")
    const ws = path.join(root, "sel-plain-candidate", "c0")
    mkdirSync(ws, { recursive: true })
    writeFileSync(path.join(ws, "keep.txt"), "k")
    const manager = new IsolatedWorkspaceManager(root)
    await manager.remove(ws)
    assert.equal(existsSync(ws), false, "plain dir removal works despite the foreign toplevel")
    await assert.rejects(manager.remove(path.join(base, "outside", "c0")), /workspace-path-outside-managed-root/, "the managed-root guard still fires for real escapes")
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test("autopilot pre-step: final accepted direct messages, step=1, and source idle own the lifecycle", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "va-autopilot-"))
  try {
    const repo = makeGitRepo(base, "source")
    const ctx = fakeContext()
    ctx.setService("agentDefaultModel", { currentSelection: () => ({ provider: "kimi", model: "kimi-k3" }) })
    let modelLists = 0
    ctx.llm = { async listModels() { modelLists += 1; return [{ id: "kimi-k3" }, { id: "minimaxai/minimax-m3" }] } }
    const factory = makeFakeFactory({})
    const host = new VerifierHost(ctx, hostOverrides({ enabled: false }), {
      selectionsTesting: { factory, workspaces: realWorkspaces, bridge: fakeBridge() },
    })
    const source = ctx.spawnAgent(fakeAgent("sess-auto", completedTurnEvents(1).concat([{ type: "step/start", seq: 99, data: { turn: 7 } }])))
    source.session.header = { cwd: repo }
    host.start()
    const preStep = source.handlers.get("agent/pre-step")[0]
    const direct = { id: "u1", role: "user", content: [{ type: "text", text: "Refactor src/entry.ts and run the lifecycle tests" }], source: { kind: "user" } }
    const pluginOnly = { id: "p1", role: "user", content: [{ type: "text", text: "runtime context" }], source: { kind: "plugin", plugin: "test", form: "context" } }
    const signal = new AbortController().signal
    await preStep({ messages: [direct], turn: 7, step: 1, signal }, async () => ({ kind: "enter", messages: [pluginOnly] }))
    assert.equal(modelLists, 0, "downstream removal of direct authority prevents selection")
    await preStep({ messages: [direct], turn: 7, step: 2, signal }, async () => ({ kind: "enter", messages: [direct] }))
    assert.equal(modelLists, 0, "only the authoritative first proposed step can launch")
    const decision = await preStep({ messages: [direct], turn: 7, step: 1, signal }, async () => ({ kind: "enter", messages: [direct] }))
    assert.equal(modelLists, 1)
    assert.equal(decision.kind, "enter")
    assert.deepEqual(decision.messages, [direct], "source task enters immediately while selection runs in background")
    const record = host.selections.listSelections()[0]
    assert.equal(record.trigger, "autopilot")
    await waitFor(() => host.selections.getSelection(record.selectionId).status !== "running")
    assert.equal(source.followups.at(-1).source.form, "relay", "winner is relayed after background settlement")
    assert.deepEqual(host.selections.snapshot().retainedWinners, [record.selectionId])
    assert.ok(existsSync(record.winner.workspace), "winner survives while the source finalizer runs")
    fireIdle(source)
    await waitFor(() => host.selections.getSelection(record.selectionId).winner.discardedAt)
    assert.equal(existsSync(record.winner.workspace), false, "source idle settles the winner workspace")
    assert.deepEqual(host.selections.snapshot().retainedWinners, [])
    await host.dispose()
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test("autopilot pre-step: abort during start cancels the late selection id before propagating", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "va-autopilot-abort-"))
  try {
    const repo = makeGitRepo(base, "source")
    const ctx = fakeContext()
    ctx.llm = { async listModels() { return [{ id: "kimi-k3" }] } }
    const host = new VerifierHost(ctx, hostOverrides({ enabled: false }), { selectionsTesting: { factory: makeFakeFactory({}), workspaces: realWorkspaces, bridge: fakeBridge() } })
    const source = ctx.spawnAgent(fakeAgent("sess-abort-start", completedTurnEvents(1)))
    source.session.header = { cwd: repo }
    host.start()
    const controller = new AbortController()
    let cancels = 0
    let waits = 0
    host.selections.start = async () => { controller.abort(new Error("source-aborted")); return { selectionId: "sel-late" } }
    host.selections.cancel = (id) => { assert.equal(id, "sel-late"); cancels += 1; return true }
    host.selections.waitFor = async (id) => { assert.equal(id, "sel-late"); waits += 1; return { selectionId: id, status: "aborted" } }
    const direct = { id: "u1", role: "user", content: [{ type: "text", text: "Refactor src/entry.ts and run tests" }], source: { kind: "user" } }
    const preStep = source.handlers.get("agent/pre-step")[0]
    await assert.rejects(preStep({ messages: [direct], turn: 2, step: 1, signal: controller.signal }, async () => ({ kind: "enter", messages: [direct] })), /source-aborted/)
    assert.ok(cancels >= 1, "late id is cancelled even though abort fired before start resolved")
    assert.equal(waits, 0, "background selection must not block abort propagation")
    await host.dispose()
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test("selhost: dispose waits for active runner cleanup before resolving", async () => {
  const { SelectionHost } = await import("../lib/selection/host.js")
  const ctx = fakeContext()
  const source = ctx.spawnAgent(fakeAgent("sess-dispose-wait", completedTurnEvents(1)))
  const release = deferred()
  let created = 0
  const factory = {
    async create(spec) {
      created += 1
      return {
        agent: { id: spec.sessionId, session: { events: [] }, async followup() {}, async whenIdle() { return new Promise(() => {}) }, cancel() {} },
        async dispose() { await release.promise },
      }
    },
  }
  const host = new SelectionHost({
    agents: ctx.agents,
    resolveKey: async () => "key",
    defaultRoute: () => ({ provider: "kimi", model: "kimi-k3" }),
    verifier: () => ({ model: "m", baseURL: "http://local", apiKeyEnv: "K" }),
    workspaceRoot: SEL_TMP,
    testing: { factory, workspaces: realWorkspaces, bridge: fakeBridge() },
  })
  const started = await host.start({ sourceSessionId: source.id, candidateCount: 1, useSourceSeed: false })
  await waitFor(() => created === 1)
  let settled = false
  const disposing = host.dispose().then(() => { settled = true })
  await quiesce(30)
  assert.equal(settled, false, "host remains disposing while candidate cleanup is blocked")
  release.resolve()
  await disposing
  assert.equal(host.getSelection(started.selectionId).status, "aborted")
  assert.equal(existsSync(path.join(SEL_TMP, started.selectionId)), false)
})

// ---------- relay account-pool execution: concurrency, smoothing, tiering ----------

test("effectiveVerifierWorkers: 0=auto(4), explicit pass-through, clamp at 16", async () => {
  const { effectiveVerifierWorkers, AUTO_VERIFIER_WORKERS } = await import("../lib/selection/host.js")
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

test("config API: account-pool execution knobs accept valid values, defaults are auto/off, ranges enforced", async () => {
  const { host } = mkSelectionHost()
  try {
    const defaults = JSON.parse(JSON.stringify(host.getConfig()))
    assert.equal(defaults.selectionVerifierWorkers, 0, "workers default to auto")
    assert.equal(defaults.verifierMinIntervalMs, 0, "smoothing defaults to off")
    assert.equal(defaults.verifierSmallModel, "", "small model defaults to off")

    const routes = apiRoutes(host)
    const configRoute = routes.find((r) => r.path.endsWith("/config"))

    const ok = fakeRes()
    await configRoute.handler(fakeReq({ selectionVerifierWorkers: 8, verifierMinIntervalMs: 500, verifierSmallModel: "small/mock" }), ok)
    assert.equal(ok.status, 200, "valid account-pool knobs are accepted")
    const cfg = JSON.parse(ok.bodyText).config
    assert.equal(cfg.selectionVerifierWorkers, 8)
    assert.equal(cfg.verifierMinIntervalMs, 500)
    assert.equal(cfg.verifierSmallModel, "small/mock")

    for (const [name, patch] of [
      ["selectionVerifierWorkers", { selectionVerifierWorkers: 17 }],
      ["verifierMinIntervalMs", { verifierMinIntervalMs: 60001 }],
      ["verifierSmallModel", { verifierSmallModel: "x".repeat(201) }],
    ]) {
      const bad = fakeRes()
      await configRoute.handler(fakeReq(patch), bad)
      assert.equal(bad.status, 400, `${name} out of range is rejected`)
      assert.ok(String(JSON.parse(bad.bodyText).error).includes(name))
    }

    const badFrac = fakeRes()
    await configRoute.handler(fakeReq({ selectionVerifierWorkers: 1.5 }), badFrac)
    assert.equal(badFrac.status, 400, "non-integer workers rejected")

    const clear = fakeRes()
    await configRoute.handler(fakeReq({ verifierSmallModel: "" }), clear)
    assert.equal(clear.status, 200, "clearing the small model back to '' is accepted")
    assert.equal(JSON.parse(clear.bodyText).config.verifierSmallModel, "")
  } finally { await host.dispose().catch(() => {}) }
})

function laneSuccessResponseBody() {
  return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: ["Analysis.", "finding: no concrete defect found", "<score_A> K </score_A>", "<score_B> M </score_B>"].join(LF) }, logprobs: { content: scorePositions() } }] }
}

test("verifyFive: layered small model drives only the mechanical lanes (completion/evidence)", async () => {
  const { verifyFive } = await import("../lib/verifier.js")
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
  const { verifyFive } = await import("../lib/verifier.js")
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
  const { verifyFive } = await import("../lib/verifier.js")
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
  const { createRequestSmoother } = await import("../lib/verifier.js")
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

test("selhost: explicit selectionVerifierWorkers pins and clamps the tournament concurrency; minIntervalMs rides along", async () => {
  const pinOne = mkSelectionHost({ config: { selectionVerifierWorkers: 1 } })
  try {
    const routes = apiRoutes(pinOne.host)
    const selectRoute = routes.find((r) => r.path.endsWith("/select"))
    const res = fakeRes()
    await selectRoute.handler(fakeReq({ sourceSessionId: "sess-A", candidateCount: 2 }), res)
    assert.equal(res.status, 202)
    const id = JSON.parse(res.bodyText).selection.selectionId
    await waitFor(() => {
      const s = pinOne.host.selections.getSelection(id)
      return s && s.status !== "running" ? s : null
    })
    assert.equal(pinOne.bridge.calls[0].maxWorkers, 1, "explicit 1 keeps the legacy serial tournament")
    assert.equal(pinOne.bridge.calls[0].minIntervalMs, 0, "default smoothing is off")
  } finally { await pinOne.host.dispose().catch(() => {}) }

  const clamped = mkSelectionHost({ config: { selectionVerifierWorkers: 99, verifierMinIntervalMs: 120 } })
  try {
    const routes = apiRoutes(clamped.host)
    const selectRoute = routes.find((r) => r.path.endsWith("/select"))
    const res = fakeRes()
    await selectRoute.handler(fakeReq({ sourceSessionId: "sess-A", candidateCount: 2 }), res)
    assert.equal(res.status, 202)
    const id = JSON.parse(res.bodyText).selection.selectionId
    await waitFor(() => {
      const s = clamped.host.selections.getSelection(id)
      return s && s.status !== "running" ? s : null
    })
    assert.equal(clamped.bridge.calls[0].maxWorkers, 16, "99 clamps to the 16-worker ceiling")
    assert.equal(clamped.bridge.calls[0].minIntervalMs, 120, "smoothing interval reaches the tournament request")
  } finally { await clamped.host.dispose().catch(() => {}) }
})

