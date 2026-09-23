// SelectionHost and its routes: /select admission and validation, candidate
// options, effective config snapshots, preflight memoisation, discard/release,
// audit packs, notices, and disposal ordering.
//
// Part of the offline regression suite: `npm test` runs every scripts/tests/*.test.mjs
// in its own process; this file also runs alone with `node --test scripts/tests/selection-host.test.mjs`.

import test from "node:test"
import assert from "node:assert/strict"
import { apiRoutes, VerifierHost } from "../../lib/index.js"
import { BridgeError } from "../../lib/selection/bridge.js"
import { existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { completedTurnEvents, fakeAgent, fakeContext, fakeReq, fakeRes, hostOverrides } from "./helpers/host.mjs"
import { SEL_TMP, fakeBridge, makeFakeFactory, mkSelectionHost, realWorkspaces } from "./helpers/selection.mjs"
import { deferred, quiesce, waitFor } from "./helpers/harness.mjs"
import { makeGitRepo } from "./helpers/git.mjs"

// ---------- selection host + routes (Phase 3) ----------

test("selhost: cutBalancedSeed cuts at the last turn/end and refuses degenerate cases", async () => {
  const { cutBalancedSeed } = await import("../../lib/selection/host.js")
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
  const { problemFromEvents } = await import("../../lib/selection/host.js")
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
  const { normalizeCandidateTimeoutMs } = await import("../../lib/selection/host.js")
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

test("selhost: /select admissions refused by the host never burn the hourly quota", async () => {
  const { API_RATE_LIMITS } = await import("../../lib/index.js")
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
  const { projectStoreKey } = await import("../../lib/selection/live.js")
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
    const { SelectionHost } = await import("../../lib/selection/host.js")
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

test("selhost: a tampered persisted winner path cannot escape the managed workspace root", async () => {
  const { SelectionHost } = await import("../../lib/selection/host.js")
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

test("selhost: dispose waits for active runner cleanup before resolving", async () => {
  const { SelectionHost } = await import("../../lib/selection/host.js")
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

test("selhost: a refusal after full admission (live factory not wired) never leaves a stuck claim", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "va-noclaim-"))
  try {
    const { SelectionHost } = await import("../../lib/selection/host.js")
    const repo = makeGitRepo(base, "source")
    const ctx = fakeContext()
    const host = new SelectionHost({
      agents: ctx.agents,
      // liveAgents is deliberately absent: every input check passes and the
      // factory construction is the first thing that refuses. Before the
      // reorder this happened AFTER the claim, so the host answered
      // selection-busy forever and cancel() had no run to abort.
      resolveKey: async () => "key",
      defaultRoute: () => ({ provider: "kimi", model: "kimi-k3" }),
      verifier: () => ({ model: "m", baseURL: "http://local", apiKeyEnv: "K" }),
      workspaceRoot: SEL_TMP,
      testing: { bridge: fakeBridge() },
    })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        () => host.start({ problem: "do the thing", candidateCount: 2, sourceCwd: repo, useSourceSeed: false }),
        (error) => {
          assert.equal(error.code, "live-agents-unavailable", "attempt " + attempt + " reports the real cause, not selection-busy")
          return true
        },
      )
      assert.equal(host.activeSelectionId(), null, "no active claim survives a refused start")
      assert.equal(host.listSelections().length, 0, "no running placeholder is left behind in history")
    }
    await host.dispose()
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test("selhost: concurrent discards of one retained slot serialize — one removal, the second answers false", async () => {
  const gate = deferred()
  let gateRemoves = false
  const removed = []
  let purges = 0
  const wsx = {
    async prepare(sel) { const dir = path.join(SEL_TMP, sel.selectionId, "c" + sel.index); mkdirSync(dir, { recursive: true }); return dir },
    async remove(dir) { removed.push(dir); if (gateRemoves) await gate.promise; rmSync(dir, { recursive: true, force: true }) },
    async purgeSessionRecord() { purges += 1 },
  }
  const ctx = fakeContext()
  ctx.setService("agentDefaultModel", { currentSelection: () => ({ provider: "kimi", model: "kimi-k3" }) })
  const host = new VerifierHost(ctx, hostOverrides(), { selectionsTesting: { factory: makeFakeFactory({}), workspaces: wsx, bridge: fakeBridge() } })
  ctx.spawnAgent(fakeAgent("sess-A", completedTurnEvents(1)))
  const started = await host.selections.start({ sourceSessionId: "sess-A", candidateCount: 2, trigger: "manual" })
  const final = await host.selections.waitFor(started.selectionId)
  assert.equal(final.status, "completed")
  const winnerWs = final.winner.workspace
  removed.length = 0
  purges = 0
  gateRemoves = true
  const first = host.selections.discardWinner(started.selectionId)
  const second = host.selections.discardWinner(started.selectionId)
  await quiesce(30)
  assert.deepEqual(removed, [winnerWs], "the second discard queues behind the first instead of racing the removal")
  gate.resolve()
  assert.deepEqual(await Promise.all([first, second]), [true, false], "sequential semantics under concurrency")
  assert.deepEqual(removed, [winnerWs])
  assert.equal(purges, 1, "the session journal is purged exactly once")
  assert.ok(host.selections.getSelection(started.selectionId).winner.discardedAt)
  assert.equal(existsSync(winnerWs), false)
  await host.selections.dispose()
})

test("selhost: defaultPythonPath prefers DSH_VA_PYTHON and otherwise never points at a missing interpreter", async () => {
  const { defaultPythonPath } = await import("../../lib/selection/host.js")
  const saved = process.env.DSH_VA_PYTHON
  try {
    process.env.DSH_VA_PYTHON = "/opt/custom/bin/python-x"
    assert.equal(defaultPythonPath(), "/opt/custom/bin/python-x", "explicit operator choice wins")
    delete process.env.DSH_VA_PYTHON
    const fallback = defaultPythonPath()
    if (existsSync("D:/tools/pyvenvs/llm-verifier-bridge/Scripts/python.exe")) {
      assert.equal(fallback, "D:/tools/pyvenvs/llm-verifier-bridge/Scripts/python.exe", "the documented operator venv is used when present")
    } else {
      assert.equal(fallback, process.platform === "win32" ? "python" : "python3", "a PATH interpreter, never a hardcoded path that does not exist here")
    }
  } finally {
    if (saved === undefined) delete process.env.DSH_VA_PYTHON
    else process.env.DSH_VA_PYTHON = saved
  }
})
