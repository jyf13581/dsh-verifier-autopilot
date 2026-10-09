// Review R7 7.2/7.3: what the shipped defaults spend, and on what.
// docs/reviews/R7-DOCS-PRODUCT-DIRECTION.md cites these numbers; they are
// produced by the real admission policy and the real VerifierHost, offline.
//
// Part of the offline regression suite: `npm test` runs every scripts/tests/*.test.mjs
// in its own process; this file also runs alone with `node --test scripts/tests/product-defaults.test.mjs`.
import test from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_CONFIG } from "../../lib/config.js"
import { planAutopilotTask } from "../../lib/selection/autopilot.js"
import { VerifierHost } from "../../lib/index.js"
import { ADMISSION_CORPUS } from "./fixtures/admission-corpus.mjs"
import { completedTurnEvents, fakeAgent, fakeContext, fireIdle, laneSuccessBody, mockLaneServer } from "./helpers/host.mjs"
import { waitFor } from "./helpers/harness.mjs"

function policyFrom(config) {
  return {
    mode: config.selectionMode, provider: config.selectionProvider, preferredModels: config.selectionModels.split(","),
    modelStrategy: config.selectionModelStrategy, standardCandidates: config.selectionStandardCandidates,
    deepCandidates: config.selectionDeepCandidates, nEvaluations: config.selectionEvaluations,
    candidateTimeoutMs: config.selectionCandidateTimeoutMs, selectTimeoutMs: config.selectionSelectTimeoutMs,
  }
}

function admissionProfile(config) {
  const policy = policyFrom(config)
  const profile = {}
  for (const [category, turns] of Object.entries(ADMISSION_CORPUS)) {
    const plans = turns.map((turn) => planAutopilotTask(turn, policy.preferredModels, policy))
    const admitted = plans.filter((plan) => plan.admitted)
    profile[category] = { admitted: admitted.length, of: turns.length, rollouts: admitted.reduce((sum, plan) => sum + plan.candidateCount, 0) }
  }
  return profile
}

test("R7 7.2: both spending paths are opt-in by default (owner decision 2026-10-09)", () => {
  assert.equal(DEFAULT_CONFIG.selectionMode, "off", "autopilot is an explicit opt-in (was 'auto')")
  assert.equal(DEFAULT_CONFIG.enabled, false, "the five-lane idle verifier is an explicit opt-in (was true)")
  assert.equal(DEFAULT_CONFIG.autoFeedback, false, "unchanged: feedback stays opt-in")
  const profile = admissionProfile(DEFAULT_CONFIG)
  for (const [category, row] of Object.entries(profile)) assert.equal(row.admitted, 0, category + ": nothing is admitted by default")
})

test("R7 7.2: what opting in to 'auto' admits -- the heuristic's profile on the labelled corpus", (t) => {
  const profile = admissionProfile({ ...DEFAULT_CONFIG, selectionMode: "auto" })
  t.diagnostic("auto admission profile: " + JSON.stringify(profile))
  // Characterization, not endorsement: pure questions and trivial edits are
  // admitted on keywords ("test", "code", a file path, >= 160 chars), each one
  // costing N=2 full-permission rollouts plus 2 x 3 criteria x K=1 = 6
  // ranking calls (docs/VERIFIER-SCHEDULER.md). Change the heuristic, then
  // update these numbers in the same commit as the R7 memo's table.
  assert.deepEqual(profile, {
    chat: { admitted: 0, of: 10, rollouts: 0 },
    question: { admitted: 5, of: 10, rollouts: 10 },
    trivial: { admitted: 6, of: 10, rollouts: 12 },
    substantive: { admitted: 10, of: 10, rollouts: 20 },
  })
  const policy = policyFrom({ ...DEFAULT_CONFIG, selectionMode: "auto" })
  const plan = (turn) => planAutopilotTask(turn, policy.preferredModels, policy)
  assert.equal(plan("What is the difference between release and discard?").reason, "external-side-effect-risk", "a question containing 'release' is refused as a side effect")
  assert.equal(plan("Migrate the ledger from JSONL to SQLite while keeping the read API stable.").depth, "standard", "no corpus task reaches the deep tier")
})

async function idleRun(overrides, lanes) {
  const server = mockLaneServer()
  try {
    for (let i = 0; i < lanes; i++) server.enqueueBody(laneSuccessBody())
    const ctx = fakeContext()
    const host = new VerifierHost(ctx, { ...DEFAULT_CONFIG, baseURL: "http://mock.local/v1", apiKeyEnv: "TEST_KEY", ...overrides })
    host.start()
    const agent = ctx.spawnAgent(fakeAgent("sess-cost", completedTurnEvents(1)))
    ctx.emit("agent/created", { agent })
    fireIdle(agent)
    if (lanes > 0) await waitFor(() => host.snapshot().records.find((record) => record.status !== "running"))
    else await new Promise((resolve) => setTimeout(resolve, 50))
    const result = { calls: server.calls.length, followups: agent.followups.length, records: host.snapshot().records.length }
    await host.dispose()
    return result
  } finally {
    server.restore()
  }
}

test("R7 7.3: the legacy idle verifier spends nothing by default", async () => {
  assert.deepEqual(await idleRun({}, 0), { calls: 0, followups: 0, records: 0 })
})

test("R7 7.3: opted in with the other defaults, each gated idle turn costs 5 lane calls and changes nothing the agent sees", async () => {
  const run = await idleRun({ enabled: true }, 5)
  assert.deepEqual(run, { calls: 5, followups: 0, records: 1 }, "routes=5 calls; autoFeedback=false means the verdict only reaches records.jsonl and the GUI")
})
