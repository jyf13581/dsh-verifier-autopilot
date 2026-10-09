// Review R5: persistence, audit pack, redaction and protocol contracts.
// Every egress of the selection path (verifier requests, ledger, /state, audit
// pack, source relay) must carry the same redaction the legacy lane prompt
// always had; the JSONL ledgers must survive torn tails, downgrades and
// compaction; the sidecar protocol must be version-checked.

import test from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { VerifierHost, redactSecrets } from "../../lib/index.js"
import { SelectionRunner } from "../../lib/selection/candidates.js"
import { IsolatedWorkspaceManager, gitDiffFull } from "../../lib/selection/live.js"
import { buildAutopilotRelay } from "../../lib/selection/autopilot.js"
import { appendJsonlLedger, compactJsonlLedger, readJsonlLedger } from "../../lib/ledger.js"
import { makeGitRepo, runGit } from "./helpers/git.mjs"
import { completedTurnEvents, fakeAgent, fakeContext, fireIdle, hostOverrides } from "./helpers/host.mjs"
import { fakeBridge, makeFakeFactory, realWorkspaces, selInput, SEL_TMP } from "./helpers/selection.mjs"
import { mkBridge, bridgeReq, STUB_SIDECAR } from "./helpers/sidecar.mjs"
import { waitFor } from "./helpers/harness.mjs"

const rand = (n) => Array.from({ length: n }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("")

// ---------- 5.1: one redaction policy for every selection-path egress ----------

/** Four secrets a candidate can surface by running `env` / `cat .env`:
 *  - the verifier key itself (not token-shaped: only literal matching finds it)
 *  - another credential in the host environment (name says TOKEN)
 *  - a token-shaped value that is in no environment (pattern matching)
 *  - an assignment whose name ends in _PASSWORD (prefixed-name pattern) */
function plantSecrets() {
  const s = {
    verifierKey: "vk-live-" + rand(28),
    envSecret: "svc." + rand(30),
    shaped: "sk-" + rand(32),
    assigned: "pw" + rand(24),
  }
  process.env.R5_SERVICE_TOKEN = s.envSecret
  return s
}
const leakText = (s) => [
  "OPENAI_API_KEY=" + s.verifierKey,
  "R5_SERVICE_TOKEN=" + s.envSecret,
  "stray " + s.shaped,
  "DATABASE_PASSWORD=" + s.assigned,
].join("\n")

function leakyFactory(s) {
  const events = (i) => [
    { type: "user/message", seq: 0, data: { content: [{ type: "text", text: "task for candidate " + i }], source: { kind: "user" } } },
    { type: "tool/call", seq: 1, data: { name: "bash", arguments: { command: "env" } } },
    { type: "tool/result", seq: 2, data: { message: { content: [{ type: "text", text: leakText(s) }] } } },
    { type: "assistant/message", seq: 3, data: { message: { role: "assistant", content: [{ type: "text", text: "Configured the client with " + s.verifierKey + " — done " + i }] } } },
  ]
  const base = makeFakeFactory({ scripts: [{ idleDelay: 1300 }, { idleDelay: 1300 }] })
  return {
    ...base,
    async create(spec) {
      const handle = await base.create(spec)
      const i = base.calls.length - 1
      // The candidate leaves a script the operator's check runs: its output
      // tail lands in the record.
      writeFileSync(path.join(spec.cwd, "leak.js"), "console.log(" + JSON.stringify(leakText(s)) + ")\n")
      const agent = handle.agent
      const settle = agent.whenIdle.bind(agent)
      agent.whenIdle = () => {
        agent.session = { events: events(i) } // visible to progress samples mid-run
        const done = settle()
        return done.then(() => { agent.session = { events: events(i) } })
      }
      return handle
    },
  }
}

test("R5 5.1: a candidate's env dump reaches no verifier request, record, audit pack or relay", async () => {
  const s = plantSecrets()
  const secrets = Object.values(s)
  const selectReqs = []
  const progressReqs = []
  const bridge = fakeBridge((req) => {
    selectReqs.push(req)
    return { index: 0, bestPreview: "", scores: req.candidates.map((_, i) => (i === 0 ? 0.9 : 0.4)), ranking: req.candidates.map((_, i) => i), nComparisons: req.candidates.length, criteria: ["c1"], usage: { calls: req.candidates.length, input_tokens: 1, cached_input_tokens: 0, uncached_input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, cache_hit_rate: 0 } }
  })
  bridge.progress = async (req) => { progressReqs.push(req); return { score: 0.5, usage: {} } }
  const runner = new SelectionRunner({
    factory: leakyFactory(s),
    workspaces: realWorkspaces,
    bridge,
    diffStat: async (cwd) => ({ files: 1, insertions: 1, deletions: 0, untracked: 0, fingerprint: path.basename(cwd) + "-fp" }),
    diffFull: async () => ({ patch: "diff --git a/.env b/.env\n+" + leakText(s).split("\n").join("\n+"), truncated: false, untrackedFiles: [] }),
  })
  try {
    const { record, artifacts } = await runner.run(selInput({
      candidateCount: 2, nEvaluations: 1, pivots: 0,
      // The user pasted a credential into the task; the legacy lane prompt
      // always redacted the task text too.
      problem: "Rotate the DB login, current value DATABASE_PASSWORD=" + s.assigned,
      checks: [{ name: "leak", command: "node leak.js", timeoutMs: 30000 }],
      progressGuard: { intervalMs: 1000, maxChecks: 3 },
      verifier: { model: "m", baseUrl: "http://127.0.0.1:9/v1", apiKey: s.verifierKey, apiKeyEnv: "R5_VERIFIER_KEY" },
    }))
    assert.equal(record.status, "completed", String(record.error))
    assert.ok(selectReqs.length === 1 && progressReqs.length >= 1, "both verifier request kinds were exercised")
    assert.ok(record.candidates.every((c) => c.checks?.[0]?.outputTail.includes("PASSWORD")), "the check really printed the leak")
    const egress = {
      "select.candidates": JSON.stringify(selectReqs.map((r) => r.candidates)),
      "select.problem": JSON.stringify(selectReqs.map((r) => r.problem)),
      "progress.steps": JSON.stringify(progressReqs.map((r) => [r.problem, r.steps])),
      "record (ledger, /state, SSE, record.json)": JSON.stringify(record),
      "traces/*.txt": JSON.stringify(artifacts.traces),
      "diffs/*.patch": JSON.stringify(artifacts.diffPatches),
      "source relay": buildAutopilotRelay(record),
    }
    for (const [where, text] of Object.entries(egress)) {
      for (const secret of secrets) assert.ok(!text.includes(secret), where + " leaks " + secret.slice(0, 6) + "… (old code: only the legacy lane prompt was redacted)")
    }
    // Redaction keeps the evidence readable: the verifier still sees that
    // the candidate ran env and what it touched.
    assert.match(egress["select.candidates"], /OPENAI_API_KEY=\[REDACTED/)
    assert.match(egress["traces/*.txt"], /TOOL CALL bash/)
    // The API key stays where it belongs: on the request's credential field.
    assert.equal(selectReqs[0].apiKey, s.verifierKey)
  } finally { delete process.env.R5_SERVICE_TOKEN }
})

test("R5 5.1: the shared pattern redacts NAME_API_KEY= / NAME_PASSWORD= assignments, not just bare keywords", () => {
  const v = "Q" + rand(23)
  for (const line of ["OPENAI_API_KEY=" + v, "export DATABASE_PASSWORD='" + v + "'", '"client_secret": "' + v + '"', "AWS_SECRET_ACCESS_KEY: " + v]) {
    assert.ok(!redactSecrets(line).includes(v), line.slice(0, 22) + "… was not redacted")
  }
  // Ordinary configuration stays intact.
  for (const line of ["max_tokens: 1234567890123456789", "password_min_length = 16", "tokenizer=cl100k_base_long_name"]) {
    assert.equal(redactSecrets(line), line)
  }
})

// ---------- 5.3: ledger durability ----------

const ledgerOpts = (skips = []) => ({ limit: 100, validate: (r) => typeof r.id === "string", idOf: (r) => r.id, onSkippedRow: (line) => skips.push(line) })

test("R5 5.3: a row appended after a torn tail (crash mid-write) is not swallowed by it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "r5-torn-"))
  try {
    const file = path.join(dir, "l.jsonl")
    appendJsonlLedger(file, { id: "a" })
    appendFileSync(file, '{"id":"b","v":1') // the process died mid-row
    appendJsonlLedger(file, { id: "c" })    // first write after restart
    const skips = []
    const ids = readJsonlLedger(file, ledgerOpts(skips)).map((r) => r.id).sort()
    assert.deepEqual(ids, ["a", "c"], "old code: c was glued onto the torn row and lost with it")
    assert.equal(skips.length, 1, "only the torn row itself is lost")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("R5 5.3: compaction keeps rows from a newer ledger version instead of deleting them (downgrade safety)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "r5-future-"))
  try {
    const file = path.join(dir, "l.jsonl")
    const future = JSON.stringify({ id: "from-v2", v: 2, shape: "unknown to this build" })
    writeFileSync(file, JSON.stringify({ id: "old", v: 1 }) + "\n" + future + "\n")
    const loaded = readJsonlLedger(file, ledgerOpts())
    assert.deepEqual(loaded.map((r) => r.id), ["old"], "a newer row is still not interpreted")
    compactJsonlLedger(file, loaded)
    const text = readFileSync(file, "utf8")
    assert.ok(text.includes(future), "old code: compaction rewrote the file from known rows only")
    assert.deepEqual(readJsonlLedger(file, ledgerOpts()).map((r) => r.id), ["old"])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("R5 5.3: a persist that crosses the size limit compacts WITH the record being written", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "r5-compact-"))
  try {
    const ledger = path.join(base, "selections.jsonl")
    const ctx = fakeContext()
    ctx.setService("agentDefaultModel", { currentSelection: () => ({ provider: "kimi", model: "kimi-k3" }) })
    const host = new VerifierHost(ctx, hostOverrides(), { selectionsFile: ledger, selectionsTesting: { factory: makeFakeFactory({}), workspaces: realWorkspaces, bridge: fakeBridge() } })
    ctx.spawnAgent(fakeAgent("sess-A", completedTurnEvents(1)))
    const { selectionId } = await host.selections.start({ sourceSessionId: "sess-A", candidateCount: 2 })
    // Another writer (or years of history) pushed the file over 4 MiB while
    // the run was in flight: the settle write takes the compaction branch.
    appendFileSync(ledger, (JSON.stringify({ selectionId: "filler", sourceSessionId: null, startedAt: 1, finishedAt: 2, status: "completed", candidates: [], pad: "x".repeat(1024) }) + "\n").repeat(4200))
    const record = await host.selections.waitFor(selectionId)
    assert.equal(record.status, "completed")
    const rows = readFileSync(ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    assert.ok(rows.length < 300, "the file was compacted")
    const mine = rows.filter((row) => row.selectionId === selectionId)
    assert.equal(mine.at(-1)?.status, "completed", "the settling record is in the compacted file")
    await host.dispose()
  } finally { rmSync(base, { recursive: true, force: true }) }
})

// ---------- 5.2: settlement is immutable; lifecycle fields are the only later writes ----------

const SETTLEMENT_FIELDS = ["status", "outcome", "winnerBasis", "scores", "ranking", "margin", "marginThreshold", "finalists", "error", "finishedAt", "dedupedCandidates", "noSearchSpace"]
const settlementOf = (row) => ({
  ...Object.fromEntries(SETTLEMENT_FIELDS.map((k) => [k, row[k]])),
  winner: row.winner ? { index: row.winner.index, workspace: row.winner.workspace } : undefined,
  fallback: row.fallback ? { index: row.fallback.index, workspace: row.fallback.workspace } : undefined,
  candidates: (row.candidates ?? []).map((c) => [c.index, c.status, c.eliminatedBy]),
})

test("R5 5.2: relay, delivery audit and discard rewrite only lifecycle fields; every ledger row agrees on the settlement", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "r5-immutable-"))
  try {
    const repo = makeGitRepo(base, "source")
    const ledger = path.join(base, "selections.jsonl")
    const ctx = fakeContext()
    ctx.setService("agentDefaultModel", { currentSelection: () => ({ provider: "kimi", model: "kimi-k3" }) })
    ctx.llm = { async listModels() { return [{ id: "kimi-k3" }] } }
    const host = new VerifierHost(ctx, hostOverrides({ enabled: false }), { selectionsFile: ledger, selectionsTesting: { factory: makeFakeFactory({}), workspaces: realWorkspaces, bridge: fakeBridge() } })
    const source = ctx.spawnAgent(fakeAgent("sess-imm", completedTurnEvents(1)))
    source.session.header = { cwd: repo }
    host.start()
    const preStep = source.handlers.get("agent/pre-step")[0]
    const direct = { id: "u1", role: "user", content: [{ type: "text", text: "Refactor src/entry.ts and run the persistence tests" }], source: { kind: "user" } }
    await preStep({ messages: [direct], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: "enter", messages: [direct] }))
    const id = host.selections.listSelections()[0].selectionId
    await waitFor(() => source.followups.some((m) => m.source.form === "relay"))
    fireIdle(source)
    await waitFor(() => host.selections.getSelection(id).winner?.discardedAt ?? host.selections.getSelection(id).fallback?.discardedAt)
    const rows = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.selectionId === id)
    const terminal = rows.filter((r) => r.status !== "running")
    assert.ok(terminal.length >= 3, "settle, relay, audit/discard each wrote a row (got " + terminal.length + ")")
    for (const row of terminal.slice(1)) assert.deepEqual(settlementOf(row), settlementOf(terminal[0]))
    const last = terminal.at(-1)
    assert.ok(last.timing?.relayedAt && last.delivery && (last.winner ?? last.fallback).discardedAt, "the lifecycle fields did land")
    await host.dispose()
  } finally { rmSync(base, { recursive: true, force: true }) }
})

// ---------- 5.4: protocol contracts ----------

test("R5 5.4: a sidecar that speaks another protocol version fails fast instead of being trusted", async () => {
  const bridge = mkBridge(STUB_SIDECAR, { env: { STUB_HEALTH_PROTOCOL: "99" } })
  try {
    await assert.rejects(bridge.select(bridgeReq()), (error) => error.code === "bridge_protocol" && /protocol/.test(error.message), "old code: health carried no version, so any sidecar was accepted")
  } finally { await bridge.dispose() }
  const legacy = mkBridge(STUB_SIDECAR, { env: { STUB_HEALTH_PROTOCOL: "absent" } })
  try {
    await assert.rejects(legacy.select(bridgeReq()), (error) => error.code === "bridge_protocol")
  } finally { await legacy.dispose() }
  const current = mkBridge(STUB_SIDECAR)
  try {
    const result = await current.select(bridgeReq())
    assert.equal(result.index, 0)
  } finally { await current.dispose() }
})

test("R5 5.4: one evaluation default everywhere (config, runner, direct bridge calls)", async () => {
  const seen = []
  const runner = new SelectionRunner({
    factory: makeFakeFactory({}),
    workspaces: realWorkspaces,
    bridge: fakeBridge((req) => { seen.push(req.nEvaluations); return { index: 0, bestPreview: "", scores: req.candidates.map((_, i) => (i === 0 ? 0.9 : 0.4)), ranking: req.candidates.map((_, i) => i), nComparisons: req.candidates.length, criteria: ["c1"], usage: { calls: req.candidates.length, input_tokens: 1, cached_input_tokens: 0, uncached_input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, cache_hit_rate: 0 } } }),
    diffStat: async (cwd) => ({ files: 1, insertions: 1, deletions: 0, untracked: 0, fingerprint: path.basename(cwd) + "-fp" }),
  })
  const input = selInput({ candidateCount: 2, pivots: 0 })
  delete input.nEvaluations
  await runner.run(input)
  assert.deepEqual(seen, [1], "an embedded host without nEvaluationsDefault paid K=2 (old runner default) while the config default is 1")
  const echo = path.join(SEL_TMP, "r5-echo-" + rand(6) + ".jsonl")
  const bridge = mkBridge(STUB_SIDECAR, { env: { STUB_ECHO_FILE: echo } })
  try {
    const req = bridgeReq()
    delete req.nEvaluations
    await bridge.select(req)
    const frame = readFileSync(echo, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((f) => f.type === "select")
    assert.equal(frame.n_evaluations, 1, "old bridge fallback: 4")
  } finally { await bridge.dispose() }
})

// ---------- 5.6: the audit patch shows the candidate's work, not the user's ----------

test("R5 5.6: the audit pack patch excludes source edits the candidate inherited and left alone", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "r5-ownpatch-"))
  const manager = new IsolatedWorkspaceManager(path.join(base, "ws"))
  let dir
  try {
    const repo = makeGitRepo(base, "source")
    writeFileSync(path.join(repo, "tracked.txt"), "tracked-base\nuser work in progress: do not ship\n")
    dir = await manager.prepare({ selectionId: "sel-r5own", index: 0, sourceCwd: repo, strictSnapshot: true })
    mkdirSync(path.join(dir, "src"), { recursive: true })
    writeFileSync(path.join(dir, "src", "entry.ts"), "export const value = 42\n")
    const full = await gitDiffFull(dir)
    assert.ok(full)
    assert.match(full.patch, /value = 42/)
    assert.ok(!full.patch.includes("user work in progress"), "old code: the patch was vs HEAD and shipped the user's uncommitted edits as candidate work")
    assert.equal(full.inheritedExcluded, 1)
  } finally {
    if (dir) await manager.remove(dir).catch(() => {})
    rmSync(base, { recursive: true, force: true })
  }
})
