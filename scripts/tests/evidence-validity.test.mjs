// Review R3 (evidence and metric validity): candidate work evidence must not
// include the user's inherited uncommitted edits, and the delivery audit must
// attribute integration to the relayed winner instead of to any change in the
// source repository. See docs/reviews/R3-EVIDENCE-VALIDITY.md.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, copyFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { VerifierHost } from "../../lib/index.js"
import { IsolatedWorkspaceManager, gitDiffStat, adoptionOf } from "../../lib/selection/live.js"
import { evaluateDelivery, SelectionRunner } from "../../lib/selection/candidates.js"
import { lookupMarginCalibration, CALIBRATED_CONDITIONS } from "../../lib/selection/calibration.js"
import { buildAutopilotRelay } from "../../lib/selection/autopilot.js"
import { expectedC0Max, simulate, estimateSigmaGamma, signedFrame, rng } from "../../eval/calibration/null-model.mjs"
import { makeGitRepo, runGit } from "./helpers/git.mjs"
import { BRIDGE_PY } from "./helpers/sidecar.mjs"
import { parseSelectResult } from "../../lib/selection/bridge.js"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { completedTurnEvents, fakeAgent, fakeContext, fireIdle, hostOverrides } from "./helpers/host.mjs"
import { fakeBridge, makeFakeFactory, realWorkspaces, selInput } from "./helpers/selection.mjs"
import { waitFor } from "./helpers/harness.mjs"

/** A source repository the user is in the middle of editing: one modified
 *  tracked file and one new untracked file, neither committed. */
function dirtySource(base) {
  const repo = makeGitRepo(base, "source")
  writeFileSync(path.join(repo, "tracked.txt"), "tracked-base\nuser work in progress\n")
  writeFileSync(path.join(repo, "notes.md"), "user notes\n")
  return repo
}

async function withCandidate(fn, { subdir = null } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), "va-r3-"))
  const manager = new IsolatedWorkspaceManager(path.join(base, "ws"))
  let cwd = null
  try {
    const repo = dirtySource(base)
    const sourceCwd = subdir ? path.join(repo, subdir) : repo
    cwd = await manager.prepare({ selectionId: "sel-r3evid", index: 0, sourceCwd, strictSnapshot: true })
    await fn({ repo, sourceCwd, cwd, root: subdir ? path.dirname(cwd) : cwd })
  } finally {
    if (cwd) await manager.remove(subdir ? path.dirname(cwd) : cwd).catch(() => {})
    rmSync(base, { recursive: true, force: true })
  }
}

test("R3 3.7: a candidate that did nothing in a dirty repository shows no work of its own", async () => {
  await withCandidate(async ({ cwd }) => {
    const stat = await gitDiffStat(cwd)
    assert.deepEqual({ files: stat.files, insertions: stat.insertions, deletions: stat.deletions, untracked: stat.untracked, inherited: stat.inherited },
      { files: 0, insertions: 0, deletions: 0, untracked: 0, inherited: 2 },
      "the user's two uncommitted paths are inherited, not candidate work (old code: files 1, untracked 1)")
  })
})

test("R3 3.7: the candidate's own edits, further edits to inherited files, and reverts are all counted", async () => {
  await withCandidate(async ({ cwd }) => {
    writeFileSync(path.join(cwd, "src", "entry.ts"), "export const value = 2\n")
    let stat = await gitDiffStat(cwd)
    assert.equal(stat.files, 1)
    assert.equal(stat.insertions, 1)
    assert.equal(stat.deletions, 1)
    assert.equal(stat.inherited, 2)
    writeFileSync(path.join(cwd, "tracked.txt"), "tracked-base\nuser work in progress\ncandidate addition\n")
    stat = await gitDiffStat(cwd)
    assert.equal(stat.files, 2, "touching an inherited file makes it the candidate's change")
    assert.equal(stat.inherited, 1)
    runGit(cwd, "checkout", "--", "tracked.txt")
    stat = await gitDiffStat(cwd)
    assert.equal(stat.files, 2, "reverting the user's inherited edit is a change the candidate made")
    writeFileSync(path.join(cwd, "fresh.txt"), "new\n")
    assert.equal((await gitDiffStat(cwd)).untracked, 1)
  })
})

test("R3: a subdirectory cwd reports root-relative paths and a content-sensitive fingerprint", async () => {
  await withCandidate(async ({ cwd }) => {
    assert.equal(path.basename(cwd), "src", "fixture: the candidate cwd mirrors the source subdirectory")
    const idle = await gitDiffStat(cwd)
    assert.equal(idle.files + idle.untracked, 0)
    writeFileSync(path.join(cwd, "entry.ts"), "export const value = 2\n")
    const a = await gitDiffStat(cwd)
    writeFileSync(path.join(cwd, "entry.ts"), "export const value = 3\n")
    const b = await gitDiffStat(cwd)
    assert.equal(a.files, 1, "a diff name under src/ is resolved against the repository root")
    assert.notEqual(a.fingerprint, b.fingerprint, "same size, different bytes: the fingerprint hashes the right file")
    writeFileSync(path.join(cwd, "extra.ts"), "x\n")
    assert.equal((await gitDiffStat(cwd)).untracked, 1)
  }, { subdir: "src" })
})

test("R3 3.3: adoptionOf counts only candidate-owned files present byte-for-byte in the source", async () => {
  await withCandidate(async ({ cwd, repo }) => {
    writeFileSync(path.join(cwd, "pass.txt"), "ready\n")
    writeFileSync(path.join(cwd, "src", "entry.ts"), "export const value = 42\n")
    let adoption = await adoptionOf(cwd, repo)
    assert.deepEqual(adoption, { total: 2, adopted: [] }, "inherited user edits already in the source are not adoption")
    copyFileSync(path.join(cwd, "pass.txt"), path.join(repo, "pass.txt"))
    writeFileSync(path.join(repo, "src", "entry.ts"), "export const value = 43\n")
    adoption = await adoptionOf(cwd, repo)
    assert.deepEqual(adoption, { total: 2, adopted: ["pass.txt"] }, "a different edit to the same file is not the candidate's content")
  })
})

test("R3 3.3: evaluateDelivery attributes integration to relay-time adoption, never to bare source change", () => {
  const base = { audited: true, headChanged: true, dirtyEntries: 3, testsConfigured: true, testsExit: 0 }
  const adopted = evaluateDelivery({ ...base, attribution: { changedSinceRelay: true, adoptedNew: 2, candidateFiles: 3 } })
  assert.equal(adopted.delivered, "yes")
  assert.equal(adopted.basis, "relay-adoption")
  assert.equal(evaluateDelivery({ ...base, testsConfigured: false, attribution: { changedSinceRelay: true, adoptedNew: 1, candidateFiles: 1 } }).delivered, "unknown", "adoption without tests stays unresolved")
  assert.equal(evaluateDelivery({ ...base, testsExit: 1, attribution: { changedSinceRelay: true, adoptedNew: 1, candidateFiles: 1 } }).delivered, "no")
  const unrelated = evaluateDelivery({ ...base, attribution: { changedSinceRelay: true, adoptedNew: 0, candidateFiles: 2 } })
  assert.equal(unrelated.delivered, "unknown", "the source changed, but not with the winner's content: " + unrelated.note)
  assert.equal(evaluateDelivery({ ...base, attribution: { changedSinceRelay: false, adoptedNew: 0, candidateFiles: 2 } }).delivered, "no")
  assert.equal(evaluateDelivery({ ...base, attribution: { changedSinceRelay: null, adoptedNew: null, candidateFiles: null } }).delivered, "unknown")
  assert.equal(evaluateDelivery({ ...base, audited: false, attribution: { changedSinceRelay: true, adoptedNew: 1, candidateFiles: 1 } }).delivered, "unknown")
  const legacy = evaluateDelivery(base)
  assert.equal(legacy.basis, "start-baseline", "records without a relay snapshot keep the old semantics, labelled")
  assert.equal(legacy.delivered, "yes")
  assert.match(legacy.note, /not attributable to the relay/)
})

/** Drive one autopilot selection end to end over real git worktrees and
 *  return the settled record after the source goes idle. `afterRelay` runs
 *  once the relay has been delivered, standing in for the source turn. */
async function autopilotDelivery({ afterRelay }) {
  const base = mkdtempSync(path.join(tmpdir(), "va-r3-e2e-"))
  const manager = new IsolatedWorkspaceManager(path.join(base, "ws"))
  try {
    const repo = dirtySource(base)
    const ledger = path.join(base, "selections.jsonl")
    const ctx = fakeContext()
    ctx.setService("agentDefaultModel", { currentSelection: () => ({ provider: "kimi", model: "kimi-k3" }) })
    ctx.llm = { async listModels() { return [{ id: "kimi-k3" }] } }
    // Two distinct deliverables (identical ones are deduplicated, review R2).
    const factory = makeFakeFactory({ passAt: [0, 1] })
    const create = factory.create.bind(factory)
    factory.create = async (spec) => {
      const handle = await create(spec)
      if (path.basename(spec.cwd) === "c1") writeFileSync(path.join(spec.cwd, "pass.txt"), "ready (second approach)")
      return handle
    }
    // `node --version` resolves as a program under both sh and pwsh.
    const host = new VerifierHost(ctx, hostOverrides({ enabled: false, selectionPostAuditTestCommand: "node --version" }), {
      selectionsFile: ledger,
      selectionsTesting: { factory, workspaces: manager, bridge: fakeBridge() },
    })
    const source = ctx.spawnAgent(fakeAgent("sess-r3-e2e", completedTurnEvents(1)))
    source.session.header = { cwd: repo }
    host.start()
    const preStep = source.handlers.get("agent/pre-step")[0]
    const direct = { id: "u1", role: "user", content: [{ type: "text", text: "Refactor src/entry.ts and run the lifecycle tests" }], source: { kind: "user" } }
    await preStep({ messages: [direct], turn: 3, step: 1, signal: new AbortController().signal }, async () => ({ kind: "enter", messages: [direct] }))
    const { selectionId } = host.selections.listSelections()[0]
    await waitFor(() => host.selections.getSelection(selectionId).status !== "running")
    await waitFor(() => source.followups.some((message) => message.source.form === "relay"))
    const settled = host.selections.getSelection(selectionId)
    assert.ok(settled.winner, "fixture: the selection produced a retained winner: " + JSON.stringify(settled.outcome))
    await afterRelay({ repo, winner: settled.winner.workspace })
    fireIdle(source)
    await waitFor(() => host.selections.getSelection(selectionId).winner.discardedAt)
    const record = host.selections.getSelection(selectionId)
    const ledgerText = readFileSync(ledger, "utf8")
    await host.dispose()
    return { record, ledgerText }
  } finally { rmSync(base, { recursive: true, force: true }) }
}

test("R3 3.3 e2e: a dirty source that integrated nothing is audited 'no' (old code: 'yes')", async () => {
  const { record, ledgerText } = await autopilotDelivery({ afterRelay: async () => {} })
  assert.ok(record.sourceAtRelay, "the relay-time snapshot exists")
  assert.deepEqual(record.sourceAtRelay.adoptedPaths, [])
  assert.equal(record.delivery.basis, "relay-adoption")
  assert.equal(record.delivery.delivered, "no", JSON.stringify(record.delivery))
  assert.equal(record.delivery.postAuditTestExit, undefined, "tests are not run in the user's repo without attributable integration")
  assert.ok(ledgerText.includes("relayedAt") && ledgerText.includes("sourceAtRelay"), "relay mark and snapshot reach the ledger")
})

test("R3 3.3 e2e: unrelated concurrent source work is 'unknown', adoption of the winner's bytes is 'yes'", async () => {
  const unrelated = await autopilotDelivery({ afterRelay: async ({ repo }) => { writeFileSync(path.join(repo, "other.txt"), "source turn's own work\n") } })
  assert.equal(unrelated.record.delivery.changedSinceRelay, true)
  assert.equal(unrelated.record.delivery.delivered, "unknown", JSON.stringify(unrelated.record.delivery))
  const adopted = await autopilotDelivery({ afterRelay: async ({ repo, winner }) => { copyFileSync(path.join(winner, "pass.txt"), path.join(repo, "pass.txt")) } })
  assert.deepEqual(adopted.record.delivery.adoptedFiles, ["pass.txt"])
  assert.equal(adopted.record.delivery.candidateFiles, 1, "only pass.txt is the winner's own; the user's WIP is inherited")
  assert.equal(adopted.record.delivery.postAuditTestExit, 0)
  assert.equal(adopted.record.delivery.delivered, "yes", JSON.stringify(adopted.record.delivery))
})

test("R3 (found): the relay mark reaches the final ledger row, so a crash before idle does not re-deliver the relay", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "va-r3-reload-"))
  try {
    const repo = makeGitRepo(base, "source")
    const ledger = path.join(base, "selections.jsonl")
    const ctx = fakeContext()
    ctx.setService("agentDefaultModel", { currentSelection: () => ({ provider: "kimi", model: "kimi-k3" }) })
    ctx.llm = { async listModels() { return [{ id: "kimi-k3" }] } }
    const testing = () => ({ factory: makeFakeFactory({}), workspaces: realWorkspaces, bridge: fakeBridge() })
    const host1 = new VerifierHost(ctx, hostOverrides({ enabled: false }), { selectionsFile: ledger, selectionsTesting: testing() })
    const source = ctx.spawnAgent(fakeAgent("sess-r3-reload", completedTurnEvents(1)))
    source.session.header = { cwd: repo }
    host1.start()
    const preStep = source.handlers.get("agent/pre-step")[0]
    const direct = { id: "u1", role: "user", content: [{ type: "text", text: "Refactor src/entry.ts and run the lifecycle tests" }], source: { kind: "user" } }
    await preStep({ messages: [direct], turn: 3, step: 1, signal: new AbortController().signal }, async () => ({ kind: "enter", messages: [direct] }))
    const { selectionId } = host1.selections.listSelections()[0]
    await waitFor(() => host1.selections.getSelection(selectionId).status !== "running")
    await waitFor(() => source.followups.some((message) => message.source.form === "relay"))
    // The final ledger row must carry the relay mark: the runner's record
    // replaced the placeholder that received it (old code: absent).
    const rows = readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    assert.ok(rows.at(-1).timing?.relayedAt, "last ledger row carries relayedAt")
    // The process dies before the source goes idle (no graceful dispose, so
    // no audit/discard); the next host loads the ledger and runs recovery.
    const host2 = new VerifierHost(ctx, hostOverrides({ enabled: false }), { selectionsFile: ledger, selectionsTesting: testing() })
    host2.start()
    const relays = source.followups.filter((message) => message.source.form === "relay").length
    assert.equal(relays, 1, "the source agent received the same relay " + relays + " times")
    await host2.dispose()
    await host1.dispose()
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test("R3 3.1: only the measured condition is calibrated; the shipped default is not", () => {
  const measured = { verifier: "kimi-k3@low", survivors: 2, criteria: 1, evaluations: 1, pivots: 0, inputs: "synthetic-short" }
  assert.equal(lookupMarginCalibration(measured, "flag", 0.03).status, "calibrated")
  assert.deepEqual(lookupMarginCalibration(measured, "flag", 0.05).thresholdMismatch, { registry: 0.03, used: 0.05 })
  // Shipped autopilot default: nemotron verifier, 3 criteria, real trajectories.
  const shipped = lookupMarginCalibration({ verifier: "nvidia/nemotron-3-super-120b-a12b@low", survivors: 2, criteria: 3, evaluations: 1, pivots: 0, inputs: "production-trajectory" }, "flag", 0.03)
  assert.equal(shipped.status, "uncalibrated")
  assert.deepEqual(shipped.mismatches.map((m) => m.split("=")[0]), ["verifier", "criteria", "inputs"])
  assert.equal(lookupMarginCalibration({ ...measured, survivors: 3 }, "flag", 0.03).status, "uncalibrated", "N=3 has a different null distribution")
  assert.equal(CALIBRATED_CONDITIONS.length, 1)
})

/** Two distinct deliverables and a decisive verifier (margin 0.5). */
function decisiveRun(over = {}, bridgeImpl) {
  const stat = (fingerprint) => ({ files: 1, insertions: 1, deletions: 0, untracked: 0, fingerprint })
  const runner = new SelectionRunner({
    factory: makeFakeFactory({}),
    workspaces: realWorkspaces,
    bridge: fakeBridge(bridgeImpl),
    diffStat: async (cwd) => stat(path.basename(cwd) + "-fp"),
  })
  return runner.run(selInput({ candidateCount: 2, taskKind: "code-change", nEvaluations: 1, pivots: 0, verifier: { model: "kimi-k3", effort: "low", baseUrl: "http://127.0.0.1:9/v1", apiKey: "dummy" }, ...over }))
}

test("R3 3.1: policy 'flag' keeps the winner but labels it; the relay stops claiming a calibrated gate", async () => {
  const { record } = await decisiveRun()
  assert.equal(record.outcome, "ranked_winner")
  assert.equal(record.marginCalibration.status, "uncalibrated")
  assert.deepEqual(record.marginCalibration.mismatches.map((m) => m.split("=")[0]), ["inputs"], "every dimension but the input regime matches the calibrated run")
  const relay = buildAutopilotRelay(record)
  assert.match(relay, /NOT calibrated for this condition \(differs in: inputs=production-trajectory\)/)
  assert.match(relay, /calibration=uncalibrated/)
  assert.doesNotMatch(relay, /cleared the margin gate/)
})

test("R3 3.1: policy 'abstain' refuses to name a winner in an uncalibrated condition", async () => {
  const { record } = await decisiveRun({ uncalibratedMarginPolicy: "abstain" })
  assert.equal(record.outcome, "abstain")
  assert.equal(record.winner, undefined)
  assert.equal(record.marginCalibration.forcedAbstain, true)
  assert.ok(record.margin >= record.marginThreshold, "the margin itself cleared the threshold")
  assert.match(buildAutopilotRelay(record), /no calibrated noise band for this condition \(inputs=production-trajectory\) and the operator policy is abstain/)
})

test("R3 3.4: usage.calls must equal nComparisons x criteria x evaluations on a successful ranking", async () => {
  const exact = (req) => ({ index: 0, bestPreview: "", scores: [0.9, 0.4], ranking: [0, 1], nComparisons: 2, criteria: ["c1"], usage: { calls: 2, input_tokens: 1, cached_input_tokens: 0, uncached_input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, cache_hit_rate: 0 } })
  const ok = await decisiveRun({}, exact)
  assert.equal(ok.record.expectedVerifierCalls, 2)
  assert.equal(ok.record.verifierCallsAnomaly, undefined)
  const off = await decisiveRun({}, (req) => ({ ...exact(req), usage: { ...exact(req).usage, calls: 5 } }))
  assert.deepEqual(off.record.verifierCallsAnomaly, { expected: 2, observed: 5 })
  assert.equal(off.record.outcome, "ranked_winner", "the anomaly is surfaced, not turned into a different outcome")
})

test("R3 3.1: selectionUncalibratedMarginPolicy is a validated setting defaulting to 'flag'", async () => {
  const host = new VerifierHost(fakeContext(), hostOverrides({ enabled: false }))
  assert.equal(host.getConfig().selectionUncalibratedMarginPolicy ?? "flag", "flag")
  assert.throws(() => host.setConfig({ selectionUncalibratedMarginPolicy: "never" }), /config-selection-uncalibrated-margin-policy-invalid/)
  host.setConfig({ selectionUncalibratedMarginPolicy: "abstain" })
  assert.equal(host.getConfig().selectionUncalibratedMarginPolicy, "abstain")
  await host.dispose()
})

test("R3 3.6: eval drivers carry no machine-specific paths or duplicated threshold literals", () => {
  const root = new URL("../../eval/", import.meta.url)
  const files = readdirSync(root, { recursive: true }).filter((f) => /\.(mjs|py)$/.test(f))
  assert.ok(files.length >= 5, "fixture: eval drivers found")
  const offenders = []
  for (const file of files) {
    const text = readFileSync(new URL(file, root), "utf8")
    if (/[A-Z]:[\\/]+Users[\\/]/i.test(text)) offenders.push(file + ": user-profile path")
    if (/THRESHOLD\s*=\s*0\.\d/.test(text)) offenders.push(file + ": hardcoded margin threshold")
  }
  assert.deepEqual(offenders, [])
})

test("R3 3.2: the null model reproduces the invoice and shows C0 is blind to order quirks", () => {
  // sigmaEta 0.0129 was fitted to the invoice's C0 max (0.01377 over 240 frames).
  const c0max = expectedC0Max(0.0129, { reps: 60 })
  assert.ok(Math.abs(c0max - 0.01377) / 0.01377 < 0.06, "model C0 max " + c0max)
  const cell = { n: 2, criteria: 1, evaluations: 1, sigmaEta: 0.0129 }
  const c0Quiet = simulate({ ...cell, sigmaGamma: 0, identical: true }, { trials: 4000 })
  const c0Quirky = simulate({ ...cell, sigmaGamma: 0.1, identical: true }, { trials: 4000 })
  assert.ok(Math.abs(c0Quirky.q95 - c0Quiet.q95) / c0Quiet.q95 < 0.1, "identical texts share one prompt, so a quirk cannot move C0")
  const real = simulate({ ...cell, sigmaGamma: 0.05 }, { trials: 4000 })
  assert.ok(real.falseWinnerRate > 0.05, "a one-level quirk between different equal texts clears 0.03 often: " + real.falseWinnerRate)
  assert.equal(c0Quirky.falseWinnerRate, 0)
})

test("R3 3.2: the C3 estimator recovers a known sigmaGamma and reports ~0 without one", () => {
  const r = rng(11)
  const sample = (sigmaGamma, pairs = 60, frames = 12) => {
    const c0 = Array.from({ length: 200 }, () => signedFrame(0, 0, 0.0129, r))
    const perPair = Array.from({ length: pairs }, () => {
      const gab = sigmaGamma * r.normal()
      const gba = sigmaGamma * r.normal()
      return Array.from({ length: frames }, () => signedFrame(gab, gba, 0.0129, r))
    })
    return estimateSigmaGamma(c0, perPair).sigmaGammaUpper
  }
  const recovered = sample(0.05)
  assert.ok(recovered > 0.04 && recovered < 0.06, "recovered " + recovered)
  assert.ok(sample(0) < 0.012, "no quirk -> near-zero bound")
  assert.equal(estimateSigmaGamma([0.01], [[0.1]]).sigmaGammaUpper, null, "too little data is reported as unknown")
})

test("R3 3.5: the sidecar classifies every upstream score extraction, including the silent 0.5 default", (t) => {
  const fake = fileURLToPath(new URL("./fixtures/fake_llm_verifier", import.meta.url))
  const bridgeDir = fileURLToPath(new URL("../../bridge", import.meta.url))
  const script = [
    "import json, llm_verifier_sidecar as sc",
    "from llm_verifier import fine_grained_reward as fgr",
    "lp = lambda l: [(l, -0.1), ('B', -2.5)]",
    "toks = ['<score_A>', ' A', '</score_A>', '<score_B>', ' C', '</score_B>']",
    "pos = [[], lp('A'), [], [], lp('C'), []]",
    "out = {}",
    "out['canonical'] = [fgr.extract_score(''.join(toks), toks, pos, t) for t in ('<score_A>', '<score_B>')]",
    "bare = ['score_A>', ' A', '</score_A>']",
    "out['bare'] = fgr.extract_score(''.join(bare), bare, [[], lp('A'), []], '<score_A>')",
    "out['literal'] = fgr.extract_score('<score_A> D </score_A>', [], [], '<score_A>')",
    "out['missing'] = fgr.extract_score('A is clearly better', [], [], '<score_B>')",
    "out['counts'] = sc.EXTRACTION.snapshot()",
    "sc.EXTRACTION.reset()",
    "out['reset'] = sc.EXTRACTION.snapshot()",
    "print(json.dumps(out))",
  ].join("\n")
  const run = spawnSync(BRIDGE_PY, ["-c", script], { cwd: bridgeDir, env: { ...process.env, PYTHONPATH: fake }, encoding: "utf8" })
  if (run.error) { t.skip("python unavailable: " + run.error.message); return }
  assert.equal(run.status, 0, run.stderr)
  const out = JSON.parse(run.stdout.trim().split("\n").at(-1))
  assert.ok(out.canonical[0] > 0.99 && out.canonical[1] > 0.85)
  assert.ok(out.bare > 0.99, "the tolerant lookup recovers a bare score_A> distribution")
  assert.equal(out.missing, 0.5, "upstream substitutes a neutral score instead of failing")
  assert.deepEqual(out.counts, { logprobs: 3, literal: 1, default: 1 })
  assert.deepEqual(out.reset, { logprobs: 0, literal: 0, default: 0 })
})

test("R3 3.5: extraction counts reach the record and the relay; malformed tallies are dropped", async () => {
  const base = { index: 0, best_preview: "", scores: [0.9, 0.4], ranking: [0, 1], n_comparisons: 2, criteria: ["c1"], usage: { calls: 2 } }
  assert.deepEqual(parseSelectResult({ ...base, extraction: { logprobs: 3, literal: 0, default: 1 } }).extraction, { logprobs: 3, literal: 0, default: 1 })
  assert.equal(parseSelectResult({ ...base, extraction: { logprobs: -1, literal: 0, default: 0 } }).extraction, undefined)
  assert.equal(parseSelectResult(base).extraction, undefined, "older sidecars omit the tally")
  const { record } = await decisiveRun({}, () => ({ index: 0, bestPreview: "", scores: [0.9, 0.4], ranking: [0, 1], nComparisons: 2, criteria: ["c1"], usage: { calls: 2 }, extraction: { logprobs: 3, literal: 0, default: 1 } }))
  assert.deepEqual(record.scoreExtraction, { logprobs: 3, literal: 0, default: 1 })
  assert.match(buildAutopilotRelay(record), /Score extraction: 1 of 4 verifier scores had no score-token distribution \(0 literal letter, 1 neutral 0\.5/)
})
