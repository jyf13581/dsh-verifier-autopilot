// VerifierHost lifecycle over a fake DSH context: scheduling and mutual
// exclusion, agent attach/detach, config snapshots, feedback timeouts, record
// persistence, and the coordinator seam.
//
// Part of the offline regression suite: `npm test` runs every scripts/tests/*.test.mjs
// in its own process; this file also runs alone with `node --test scripts/tests/host.test.mjs`.

import test from "node:test"
import assert from "node:assert/strict"
import { VerifierHost, apiRoutes } from "../../lib/index.js"
import path from "node:path"
import { completedTurnEvents, fakeAgent, fakeContext, fakeReq, fakeRes, fireIdle, gatedLane, hostOverrides, laneSuccessBody, mockLaneServer } from "./helpers/host.mjs"
import { LF, deferred, quiesce, unhandledRejections, waitFor } from "./helpers/harness.mjs"
import { scorePositions } from "./helpers/provider.mjs"

function laneLowScoreBody() {
  // K/M over scorePositions(): mean ~= 0.47 < 0.62, so this triggers the
  // feedback branch under the default threshold (routes=1 keeps it eligible).
  return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: ["Analysis.", "finding: retry path is missing [E02]", "<score_A> K </score_A>", "<score_B> M </score_B>"].join(LF) }, logprobs: { content: scorePositions() } }] }
}

// ---------- phase 0: host scheduling, lifecycle, and protocol boundaries ----------
//
// These tests encode the legacy scheduling contract in HANDOFF.md §7.1: the Host
// scheduler and lifecycle boundary must be deterministically testable without a
// live DSH runtime or provider. Coordinator/host seams are imported dynamically
// so a missing seam shows up as a failing test instead of crashing the suite;
// parser and verifier fixtures run against the long-standing static exports.

test("phase0: manual/auto overlap stays serialized and later auto idles keep mutual exclusion", async () => {
  const { VerifierHost } = await import("../../lib/index.js")
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
  const { VerifierHost } = await import("../../lib/index.js")
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
  const { VerifierHost } = await import("../../lib/index.js")
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
  const { VerifierHost } = await import("../../lib/index.js")
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
  const seenBefore = unhandledRejections.length
  const { VerifierHost } = await import("../../lib/index.js")
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
    assert.equal(unhandledRejections.length, seenBefore, "the auto idle path must not leak an unhandled rejection")

    server.enqueueBody(laneSuccessBody())
    agent.session.events = completedTurnEvents(2)
    fireIdle(agent)
    await quiesce(60)
    const after = host.snapshot().records
    assert.equal(after.length, 2, "the scheduler stays healthy for the next turn")
    assert.equal(after[0].status, "completed")
  } finally { server.restore() }
})

test("phase0: settlement of an in-flight run uses the config snapshot taken at run start", async () => {
  const { VerifierHost } = await import("../../lib/index.js")
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
  const { VerifierHost } = await import("../../lib/index.js")
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
  const { VerifierHost } = await import("../../lib/index.js")
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
  const { VerifierHost } = await import("../../lib/index.js")
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
  const { VerifierHost } = await import("../../lib/index.js")
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

test("phase0: coordinator dispose aborts queued manual waiters and rejects further scheduling", async () => {
  const { VerificationCoordinator } = await import("../../lib/index.js")
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
  const { VerificationCoordinator } = await import("../../lib/index.js")
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
  const { VerificationCoordinator } = await import("../../lib/index.js")
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

test("phase1: a session with no direct task anywhere is skipped without consuming lanes or quota", async () => {
  const { VerifierHost } = await import("../../lib/index.js")
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

test("phase1: host records flag assistant-only citations while tool-result citations pass", async () => {
  const { VerifierHost } = await import("../../lib/index.js")
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

test("phase2: finished records persist to JSONL and survive a Host restart", async () => {
  const { VerifierHost, apiRoutes } = await import("../../lib/index.js")
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
  const { VerifierHost } = await import("../../lib/index.js")
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

test("phase2b: citations beyond the display truncation are audited from the full finding", async () => {
  const { VerifierHost } = await import("../../lib/index.js")
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

// ---------- DSH context seam (src/dsh-context.ts) ----------

test("seam: a root context without on() fails start() loudly; an agent whose scoped context has no hooks is reported and never attached", async () => {
  const { VerifierHost } = await import("../../lib/index.js")
  const { Diagnostics } = await import("../../lib/diagnostics.js")
  const { isHookSource, isAgentScope, requireHookSource } = await import("../../lib/dsh-context.js")
  assert.equal(isHookSource({ on() {} }), true)
  assert.equal(isHookSource({ on: 1 }), false)
  assert.equal(isHookSource(null), false)
  assert.equal(isAgentScope({ on() {}, get() {} }), true)
  assert.equal(isAgentScope({ on() {} }), false, "an agent scope needs service lookup too")
  assert.throws(() => requireHookSource({}, "host context"), /host context exposes no on\(\)/)

  const noHooks = fakeContext()
  delete noHooks.on
  const dead = new VerifierHost(noHooks, hostOverrides())
  try {
    assert.throws(() => dead.start(), /exposes no on\(\)/, "a context the plugin cannot subscribe through is a wiring fault at start(), not a TypeError later")
  } finally { await dead.dispose() }

  const ctx = fakeContext()
  const diag = new Diagnostics()
  const host = new VerifierHost(ctx, hostOverrides(), { diagnostics: diag })
  try {
    host.start()
    const hookless = ctx.spawnAgent({ id: "sess-nohooks", session: { events: completedTurnEvents() }, ctx: {}, async followup() {} })
    ctx.emit("agent/created", { agent: hookless })
    assert.equal(host.snapshot().agents, 0, "an agent the Host can never hear from is not counted as attached")
    const entry = diag.snapshot().entries.find((item) => item.scope === "agent.attach")
    assert.ok(entry, "the missing hook surface is reported")
    assert.deepEqual(entry.detail, { agent: "sess-nohooks" })
    const normal = ctx.spawnAgent(fakeAgent("sess-ok", completedTurnEvents()))
    ctx.emit("agent/created", { agent: normal })
    assert.equal(host.snapshot().agents, 1, "a normal agent still attaches after the hookless one")
  } finally { await host.dispose() }
})

test("seam: the live candidate setup narrows the child context once and installs nothing on a context without hooks", async () => {
  const { makeLiveCandidateFactory } = await import("../../lib/selection/live.js")
  let captured
  const factory = makeLiveCandidateFactory({
    ctx: { agents: { async create(options) { captured = options; return { agent: { id: "child", session: { events: [] } }, async dispose() {} } } } },
    agentOptions: { provider: "p", model: "m" },
  })
  await factory.create({ index: 0, sessionId: "child", cwd: process.cwd(), seed: undefined })
  assert.equal(typeof captured.setup, "function", "the child setup rides the create options")
  assert.doesNotThrow(() => captured.setup({}), "a context without hooks is skipped, not crashed")
  assert.doesNotThrow(() => captured.setup(null))
  const installed = []
  const appended = []
  captured.setup({
    on(name) { installed.push(name) },
    get() { return undefined },
    agent: { session: { append(type, data) { appended.push([type, data]) } } },
  })
  assert.deepEqual(installed, ["system-prompt/assemble", "agent/request"], "both replicated listeners are installed on a real scope")
  assert.ok(appended.some(([type]) => type === "approval/policy"), "policy events reach the child session")
})
