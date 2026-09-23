// SelectionRunner: the best-of-N candidate batch from provisioning to settlement
// — checks gate, verifier retries, winner state machine and margin gate,
// progress guard, abort, and cleanup invariants. Scripted fakes throughout: no
// live DSH runtime, no provider, and apart from the check shell no external
// processes.
//
// Part of the offline regression suite: `npm test` runs every scripts/tests/*.test.mjs
// in its own process; this file also runs alone with `node --test scripts/tests/selection-runner.test.mjs`.

import test from "node:test"
import assert from "node:assert/strict"
import { BridgeError } from "../../lib/selection/bridge.js"
import { SelectionRunner } from "../../lib/selection/candidates.js"
import { renderTrajectory } from "../../lib/selection/trajectory.js"
import { existsSync, rmSync, mkdtempSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { PASS_CHECK, SEL_TMP, fakeBridge, fakeEvents, makeFakeFactory, realWorkspaces, selInput } from "./helpers/selection.mjs"
import { quiesce, waitFor } from "./helpers/harness.mjs"

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

test("selection: disposed losers lose BOTH workspace and session record; the winner keeps both", async () => {
  const { projectStoreKey } = await import("../../lib/selection/live.js")
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

test("selrunner: a pre-aborted signal settles as aborted before any workspace or agent is provisioned", async () => {
  const controller = new AbortController()
  controller.abort()
  let prepared = 0
  const wsx = {
    async prepare(sel) { prepared += 1; return realWorkspaces.prepare(sel) },
    async remove(dir) { return realWorkspaces.remove(dir) },
  }
  const factory = makeFakeFactory({})
  const runner = new SelectionRunner({ factory, workspaces: wsx, bridge: fakeBridge() })
  const { record, retained } = await runner.run(selInput({ signal: controller.signal, selectionId: "sel-preaborted" }))
  assert.equal(record.status, "aborted", "an already-aborted signal is an abort, not all_candidates_eliminated")
  assert.equal(retained, undefined)
  assert.equal(prepared, 0, "no worktree is provisioned for a dead selection")
  assert.equal(factory.calls.length, 0, "no agent is created for a dead selection")
  assert.equal(existsSync(path.join(SEL_TMP, "sel-preaborted")), false, "no empty run root is left behind")
})

test("selrunner: progressGuard monitors die with an aborted rollout (no orphaned interval)", async () => {
  const factory = makeFakeFactory({ scripts: { 0: { hang: true, partial: true }, 1: { hang: true, partial: true }, 2: { hang: true, partial: true } } })
  const bridge = progressScriptedBridge(() => 0.95)
  const runner = new SelectionRunner({ factory, workspaces: realWorkspaces, bridge })
  const controller = new AbortController()
  const liveTimeouts = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length
  const timeoutsBefore = liveTimeouts()
  const running = runner.run(selInput({ signal: controller.signal, progressGuard: { intervalMs: 10, minScore: 0.5, graceChecks: 2, maxChecks: 50 } }))
  await waitFor(() => bridge.progressCalls.length >= 3)
  assert.ok(liveTimeouts() >= timeoutsBefore + 3, "control: one monitor interval per candidate is live mid-rollout")
  controller.abort()
  const { record } = await running
  assert.equal(record.status, "aborted")
  const timeoutsAfter = liveTimeouts()
  assert.ok(timeoutsAfter <= timeoutsBefore, "no candidate monitor interval survives the abort (before=" + timeoutsBefore + ", after=" + timeoutsAfter + ")")
  const calls = bridge.progressCalls.length
  await quiesce(60)
  assert.equal(bridge.progressCalls.length, calls, "no progress sampling continues after settlement")
})

test("selrunner: progress samples are serialized per run (one frame in the pipe at a time, every candidate still sampled)", async () => {
  const factory = makeFakeFactory({ scripts: { 0: { hang: true, partial: true }, 1: { hang: true, partial: true }, 2: { hang: true, partial: true } } })
  const bridge = fakeBridge()
  bridge.progressCalls = []
  let inFlight = 0
  let maxInFlight = 0
  bridge.progress = async (req) => {
    bridge.progressCalls.push(req)
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((r) => setTimeout(r, 40))
    inFlight -= 1
    return { score: 0.95, usage: { calls: 1, input_tokens: 1, cached_input_tokens: 0, uncached_input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, cache_hit_rate: 0 } }
  }
  const runner = new SelectionRunner({ factory, workspaces: realWorkspaces, bridge })
  const controller = new AbortController()
  const running = runner.run(selInput({ signal: controller.signal, progressGuard: { intervalMs: 10, minScore: 0.5, graceChecks: 2, maxChecks: 50 } }))
  await waitFor(() => bridge.progressCalls.length >= 3)
  controller.abort()
  const { record } = await running
  assert.equal(record.status, "aborted")
  assert.equal(maxInFlight, 1, "the sidecar is a serial pipe: never more than one progress frame in flight (saw " + maxInFlight + ")")
  const sampled = new Set(bridge.progressCalls.map((req) => (/candidate (\d+)/.exec(req.steps.join(" ")) ?? [])[1]))
  assert.deepEqual([...sampled].sort(), ["0", "1", "2"], "serialization never starves a candidate")
})
