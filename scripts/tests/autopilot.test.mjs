// Autopilot: task admission policy, route planning, the model prober, the
// pre-step hook lifecycle, relay text, post-audit delivery, and recovery of
// settled relays across reloads.
//
// Part of the offline regression suite: `npm test` runs every scripts/tests/*.test.mjs
// in its own process; this file also runs alone with `node --test scripts/tests/autopilot.test.mjs`.

import test from "node:test"
import assert from "node:assert/strict"
import { VerifierHost } from "../../lib/index.js"
import { buildAutopilotRelay, planAutopilotTask } from "../../lib/selection/autopilot.js"
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { completedTurnEvents, fakeAgent, fakeContext, fireIdle, hostOverrides } from "./helpers/host.mjs"
import { SEL_TMP, fakeBridge, makeFakeFactory, realWorkspaces } from "./helpers/selection.mjs"
import { makeGitRepo } from "./helpers/git.mjs"
import { deferred, quiesce, waitFor } from "./helpers/harness.mjs"

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

test("relay text: fallback and abstain never promise a chosen best", async () => {
  const { buildAutopilotRelay } = await import("../../lib/selection/autopilot.js")
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
  const { evaluateDelivery } = await import("../../lib/selection/candidates.js")
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

test("autopilot policy: named-session continuation is status control, not a refactor task", async () => {
  const { planAutopilotTask } = await import("../../lib/selection/autopilot.js")
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
  const { planAutopilotTask } = await import("../../lib/selection/autopilot.js")
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
  const { planAutopilotTask, classifyTaskKind } = await import("../../lib/selection/autopilot.js")
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

test("model prober: liveness beats catalog membership, with caching and cooldown", async () => {
  const { createModelProber } = await import("../../lib/selection/probe.js")
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
  const { createModelProber } = await import("../../lib/selection/probe.js")
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
  const { planAutopilotTask } = await import("../../lib/selection/autopilot.js")
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

test("autopilot cleanup: idle, a second idle, and agent/disposed racing on one source run a single discard pass", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "va-cleanup-race-"))
  try {
    const repo = makeGitRepo(base, "source")
    const ctx = fakeContext()
    ctx.setService("agentDefaultModel", { currentSelection: () => ({ provider: "kimi", model: "kimi-k3" }) })
    ctx.llm = { async listModels() { return [{ id: "kimi-k3" }] } }
    const gate = deferred()
    let gateRemoves = false
    const removed = []
    const wsx = {
      async prepare(sel) { const dir = path.join(SEL_TMP, sel.selectionId, "c" + sel.index); mkdirSync(dir, { recursive: true }); return dir },
      async remove(dir) { removed.push(dir); if (gateRemoves) await gate.promise; rmSync(dir, { recursive: true, force: true }) },
    }
    const host = new VerifierHost(ctx, hostOverrides({ enabled: false }), { selectionsTesting: { factory: makeFakeFactory({}), workspaces: wsx, bridge: fakeBridge() } })
    const source = ctx.spawnAgent(fakeAgent("sess-cleanup-race", completedTurnEvents(1)))
    source.session.header = { cwd: repo }
    host.start()
    const preStep = source.handlers.get("agent/pre-step")[0]
    const direct = { id: "u1", role: "user", content: [{ type: "text", text: "Refactor src/entry.ts and run the lifecycle tests" }], source: { kind: "user" } }
    await preStep({ messages: [direct], turn: 3, step: 1, signal: new AbortController().signal }, async () => ({ kind: "enter", messages: [direct] }))
    const record = host.selections.listSelections()[0]
    assert.equal(record.trigger, "autopilot")
    await waitFor(() => host.selections.getSelection(record.selectionId).status !== "running")
    await waitFor(() => source.followups.some((message) => message.source.form === "relay"))
    const winnerWs = host.selections.getSelection(record.selectionId).winner.workspace
    let discardCalls = 0
    const discard = host.selections.discardWinner.bind(host.selections)
    host.selections.discardWinner = (id) => { discardCalls += 1; return discard(id) }
    removed.length = 0
    gateRemoves = true
    fireIdle(source)
    fireIdle(source)
    ctx.emit("agent/disposed", { agent: source })
    await quiesce(40)
    assert.deepEqual(removed, [winnerWs], "three triggers, one in-flight removal")
    assert.equal(discardCalls, 1, "the post-audit + discard pass runs once; later triggers join it")
    gate.resolve()
    await waitFor(() => host.selections.getSelection(record.selectionId).winner.discardedAt)
    await quiesce(40)
    assert.deepEqual(removed, [winnerWs], "the coalesced re-run finds nothing left to discard")
    assert.equal(discardCalls, 1)
    assert.equal(existsSync(winnerWs), false)
    assert.equal(host.selections.getSelection(record.selectionId).delivery.audited, true, "the audit still happened exactly once: " + JSON.stringify(host.selections.getSelection(record.selectionId).delivery))
    await host.dispose()
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test("model prober: concurrent probes of one model share a single in-flight request", async () => {
  const { createModelProber } = await import("../../lib/selection/probe.js")
  const gate = deferred()
  let fetches = 0
  const fetchImpl = async () => { fetches += 1; await gate.promise; return { ok: true, status: 200 } }
  const prober = createModelProber({ baseURL: "http://relay.local/v1", apiKey: "k", fetchImpl })
  try {
    const first = prober.probe("shared-model")
    const second = prober.probe("shared-model")
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(fetches, 1, "the second caller joins the in-flight probe instead of spending a second request")
    gate.resolve()
    assert.deepEqual(await Promise.all([first, second]), [true, true])
    assert.equal(await prober.probe("shared-model"), true, "settled verdicts still come from the cache")
    assert.equal(fetches, 1)
  } finally { gate.resolve() }
})

test("autopilot pre-step: the preferred pool is probed concurrently, so liveness costs one probe, not one per model", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "va-probe-par-"))
  const origFetch = globalThis.fetch
  try {
    const repo = makeGitRepo(base, "source")
    const ctx = fakeContext()
    ctx.setService("agentDefaultModel", { currentSelection: () => ({ provider: "kimi", model: "kimi-k3" }) })
    ctx.credentials = { resolve: async () => ({ value: "probe-test-key" }) }
    const config = hostOverrides({ enabled: false, selectionProbeEnabled: true })
    const pool = config.selectionModels.split(",").map((m) => m.trim()).filter(Boolean)
    assert.ok(pool.length >= 3, "fixture: a multi-model preferred pool")
    const host = new VerifierHost(ctx, config, {
      selectionsTesting: { factory: makeFakeFactory({}), workspaces: realWorkspaces, bridge: fakeBridge() },
    })
    const source = ctx.spawnAgent(fakeAgent("sess-par", completedTurnEvents(1)))
    source.session.header = { cwd: repo }
    let inFlight = 0
    let maxInFlight = 0
    const probed = []
    globalThis.fetch = async (url, init) => {
      probed.push(JSON.parse(init.body).model)
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 30))
      inFlight -= 1
      // Every model reports dead: the pre-step fails closed, which keeps this
      // test free of a background tournament while still exercising the probe.
      return { ok: false, status: 410, body: null }
    }
    host.start()
    try {
      const preStep = source.handlers.get("agent/pre-step")[0]
      const direct = { id: "u1", role: "user", content: [{ type: "text", text: "Fix src/x.ts and run the tests" }], source: { kind: "user" } }
      const decision = await preStep({ messages: [direct], turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: "enter", messages: [direct] }))
      assert.equal(decision.kind, "enter")
      assert.deepEqual([...probed].sort(), [...pool].sort(), "every preferred model is probed exactly once")
      assert.equal(maxInFlight, pool.length, "probes overlap instead of queueing on the source turn (max in flight " + maxInFlight + ")")
      assert.equal(host.selections.listSelections().length, 0, "all-dead pool still fails closed")
    } finally {
      await host.dispose()
    }
  } finally {
    globalThis.fetch = origFetch
    rmSync(base, { recursive: true, force: true })
  }
})

test("autopilot pre-step: a source turn aborted mid-probe stops waiting for the pool", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "va-probe-abort-"))
  const origFetch = globalThis.fetch
  const gate = deferred()
  try {
    const repo = makeGitRepo(base, "source")
    const ctx = fakeContext()
    ctx.setService("agentDefaultModel", { currentSelection: () => ({ provider: "kimi", model: "kimi-k3" }) })
    ctx.credentials = { resolve: async () => ({ value: "probe-test-key" }) }
    const host = new VerifierHost(ctx, hostOverrides({ enabled: false, selectionProbeEnabled: true }), {
      selectionsTesting: { factory: makeFakeFactory({}), workspaces: realWorkspaces, bridge: fakeBridge() },
    })
    const source = ctx.spawnAgent(fakeAgent("sess-abort-probe", completedTurnEvents(1)))
    source.session.header = { cwd: repo }
    let fetches = 0
    globalThis.fetch = async () => { fetches += 1; await gate.promise; return { ok: true, status: 200, body: null } }
    host.start()
    try {
      const preStep = source.handlers.get("agent/pre-step")[0]
      const direct = { id: "u1", role: "user", content: [{ type: "text", text: "Fix src/x.ts and run the tests" }], source: { kind: "user" } }
      const controller = new AbortController()
      const pending = preStep({ messages: [direct], turn: 1, step: 1, signal: controller.signal }, async () => ({ kind: "enter", messages: [direct] }))
      await waitFor(() => fetches > 0)
      controller.abort()
      const outcome = await Promise.race([
        pending.then(() => "settled", () => "settled"),
        new Promise((resolve) => setTimeout(() => resolve("still-waiting"), 1500)),
      ])
      assert.equal(outcome, "settled", "the pre-step settles as soon as the turn is aborted, not when the probes finish")
      assert.equal(host.selections.listSelections().length, 0, "no selection is admitted for an aborted turn")
    } finally {
      gate.resolve()
      await host.dispose()
    }
  } finally {
    gate.resolve()
    globalThis.fetch = origFetch
    rmSync(base, { recursive: true, force: true })
  }
})
