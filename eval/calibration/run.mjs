/**
 * Margin calibration driver (ruling I.4 / plan P-A).
 *
 * Round 2: C0 fans out over five different trajectory fixtures; C1 and C2 each
 * run three oracle-known pairs in both orders. Every call is logged to
 * .data/calibration/<condition>.jsonl; the summary compares the current q95
 * against the previous saved summary for the same condition when one exists,
 * because the threshold may only leave "provisional" once two independent
 * rounds agree within 20% (ruling I.4 acceptance).
 *
 *   node eval/calibration/run.mjs
 *   env knobs: CAL_MODEL, CAL_EFFORT (default low), KIMI_BASE_URL, CAL_LABEL
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { VerifierBridge } from "../../lib/selection/bridge.js"
import { defaultPythonPath, defaultSidecarPath } from "../../lib/selection/host.js"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const outDir = path.join(repoRoot, ".data", "calibration")
mkdirSync(outDir, { recursive: true })

const model = process.env.CAL_MODEL ?? "minimaxai/minimax-m3"
const effort = process.env.CAL_EFFORT ?? "low"
const baseURL = process.env.KIMI_BASE_URL ?? "https://chat.holisthoom.top/v1"
const condition = `${model.replace(/[^\w.\-]+/g, "_")}@${effort}`
const label = process.env.CAL_LABEL ?? new Date().toISOString().replace(/[:.]/g, "-")
// Reps per fixture; 8 yields ~40 C0 frames, 12 yields 60. Tail quantiles need
// the larger batch before the graduation criterion can be judged.
const c0Reps = Math.max(2, Math.floor(Number(process.env.CAL_C0_REPS ?? 8)))

function resolveApiKey() {
  if (process.env.KIMI_API_KEY) return process.env.KIMI_API_KEY
  const credPath = process.env.DSH_CREDENTIALS ?? "C:/Users/Admin/.dsh/.credentials.yaml"
  if (existsSync(credPath)) {
    const text = readFileSync(credPath, "utf8")
    const m = /KIMI_API_KEY["']?\s*[:=]\s*["']?([^\s"']+)/.exec(text)
    if (m) return m[1]
  }
  throw new Error("KIMI_API_KEY not found in env or " + credPath)
}
const apiKey = resolveApiKey()

// ---- C0 fixtures: five DIFFERENT realistic completed-task trajectories -----

const F1 = [
  "[E01] USER: Add addMoney(a, b) in cents to utils.js and run the existing test suite.",
  "[E02] ASSISTANT: I'll implement it and verify with the tests.",
  '[E03] TOOL CALL edit: {"file_path": "utils.js", ...}',
  "[E04] TOOL RESULT: utils.js updated (12 insertions)",
  '[E05] TOOL CALL pwsh: {"command": "node --test"}',
  "[E06] TOOL RESULT: # pass 8 # fail 0",
  "[E07] ASSISTANT: addMoney implemented in cents; the 8 existing tests all pass.",
].join("\n")

const F2 = [
  "[E01] USER: Read package.json and tell me the package name and its test script.",
  '[E02] TOOL CALL read: {"file_path": "package.json"}',
  '[E03] TOOL RESULT: {"name": "acme-widgets", "scripts": {"test": "node --test"}}',
  '[E04] ASSISTANT: The package is "acme-widgets" and its test script is `node --test`.',
].join("\n")

const F3 = [
  "[E01] USER: Create branch notes/tips, write NOTES.md with two tips, and commit it.",
  '[E02] TOOL CALL pwsh: {"command": "git checkout -b notes/tips"}',
  "[E03] TOOL RESULT: Switched to a new branch 'notes/tips'",
  '[E04] TOOL CALL write: {"file_path": "NOTES.md", "content": "..."}',
  "[E05] TOOL RESULT: NOTES.md created",
  '[E06] TOOL CALL pwsh: {"command": "git add NOTES.md && git commit -m tips"}',
  "[E07] TOOL RESULT: [notes/tips 3f1a2b0] tips",
  "[E08] ASSISTANT: Branch notes/tips created, NOTES.md written and committed as 3f1a2b0.",
].join("\n")

const F4 = [
  "[E01] USER: Investigate why summary.json was empty yesterday and summarize the cause.",
  '[E02] TOOL CALL pwsh: {"command": "Get-Content summary.json"}',
  "[E03] TOOL RESULT: (0 bytes)",
  '[E04] TOOL CALL pwsh: {"command": "Get-Item summary.json | Select LastWriteTime"}',
  "[E05] TOOL RESULT: LastWriteTime 2026-09-03 23:59:58",
  '[E06] TOOL CALL pwsh: {"command": "Get-EventLog -LogName Application -Newest 3"}',
  "[E07] TOOL RESULT: AcmeWriter E1005 disk full at 23:59:58",
  "[E08] ASSISTANT: The writer hit a full disk at 23:59:58, so the file was left empty; the event log entry E1005 confirms it.",
].join("\n")

const F5 = [
  "[E01] USER: Write slugify(text) in slug.js (lowercase, spaces to dashes) with tests.",
  '[E02] TOOL CALL write: {"file_path": "slug.js", ...}',
  "[E03] TOOL RESULT: slug.js created",
  '[E04] TOOL CALL pwsh: {"command": "node --test"}',
  "[E05] TOOL RESULT: # pass 3 # fail 1 (dash-collapse case)",
  '[E06] TOOL CALL edit: {"file_path": "slug.js", "fix": ".."}',
  "[E07] TOOL RESULT: slug.js updated",
  '[E08] TOOL CALL pwsh: {"command": "node --test"}',
  "[E09] TOOL RESULT: # pass 4 # fail 0",
  "[E10] ASSISTANT: slugify is implemented; 4/4 tests pass after fixing the dash-collapse case.",
].join("\n")

const C0_FIXTURES = [F1, F2, F3, F4, F5]

// C1: three oracle-separated pairs. Strong >>> weak every time.
const PREFLIGHT_GOOD = "[E01] USER: Reply with exactly one word: ready"
  + "\n[E02] ASSISTANT: ready"
const PREFLIGHT_BAD = "[E01] USER: Reply with exactly one word: ready"
  + "\n[E02] ASSISTANT: (no output produced, no tool used, task ignored)"
const C1_PAIRS = [
  [PREFLIGHT_GOOD, PREFLIGHT_BAD],
  [
    "[E01] USER: Write an add(a,b) function and prove it works."
      + "\n[E02] TOOL CALL write: {\"file_path\": \"add.js\", \"content\": \"module.exports = (a, b) => a + b\"}"
      + "\n[E03] TOOL RESULT: add.js created"
      + "\n[E04] TOOL CALL pwsh: {\"command\": \"node -e \\\"console.log(require('./add')(1,2))\\\"\"}"
      + "\n[E05] TOOL RESULT: 3"
      + "\n[E06] ASSISTANT: add(a,b) written and verified: 1+2 printed 3.",
    "[E01] USER: Write an add(a,b) function and prove it works."
      + "\n[E02] ASSISTANT: Here is add: function add(a,b){return a+b}. Trust me, it works.",
  ],
  [
    F5,
    "[E01] USER: Write slugify(text) in slug.js (lowercase, spaces to dashes) with tests."
      + "\n[E02] ASSISTANT: slug.js written; done.",
  ],
]

// C2: three near-but-different pairs, oracle-known direction.
const C2_PAIRS = [
  [
    F5,
    [
      "[E01] USER: Write slugify(text) in slug.js (lowercase, spaces to dashes) with tests.",
      '[E02] TOOL CALL write: {"file_path": "slug.js", ...}',
      "[E03] TOOL RESULT: slug.js created",
      '[E04] TOOL CALL pwsh: {"command": "node --test"}',
      "[E05] TOOL RESULT: # pass 2 # fail 2 (unicode + collapse cases)",
      "[E06] ASSISTANT: slugify written; 2 of 4 tests still fail.",
    ].join("\n"),
  ],
  [
    F3,
    [
      "[E01] USER: Create branch notes/tips, write NOTES.md with two tips, and commit it.",
      '[E02] TOOL CALL pwsh: {"command": "git checkout -b notes/tips"}',
      "[E03] TOOL RESULT: Switched to a new branch 'notes/tips'",
      '[E04] TOOL CALL write: {"file_path": "NOTES.md", "content": "..."}',
      "[E05] TOOL RESULT: NOTES.md created",
      "[E06] ASSISTANT: branch created and NOTES.md written. (Not committed yet — I stopped here.)",
    ].join("\n"),
  ],
  [
    F4,
    [
      "[E01] USER: Investigate why summary.json was empty yesterday and summarize the cause.",
      '[E02] TOOL CALL pwsh: {"command": "Get-Item summary.json | Select LastWriteTime"}',
      "[E03] TOOL RESULT: LastWriteTime 2026-09-03 23:59:58",
      '[E04] ASSISTANT: I did not find logs, but the file was last touched at 23:59:58; probably a writer crash. Guessing here.',
    ].join("\n"),
  ],
]

const CRITERIA = { task_fidelity: "The candidate satisfies the actual request and provides concrete tool/test evidence for its claims. Unsupported claims and missing evidence lose." }

// ---- driver -----------------------------------------------------------------

const bridge = new VerifierBridge({ pythonPath: defaultPythonPath(), scriptPath: defaultSidecarPath() })
const outFile = path.join(outDir, condition + ".jsonl")
const startedAt = Date.now()
const rows = []
let failures = 0

async function oneCall(group, fixture, order, a, b, seed, rep) {
  const t0 = Date.now()
  try {
    const res = await bridge.select({
      problem: "Which candidate trajectory is better?",
      candidates: [a, b],
      criteria: CRITERIA,
      groundTruthNote: null,
      nEvaluations: 1,
      pivots: 0,
      seed,
      model,
      baseUrl: baseURL,
      apiKey,
      apiKeyEnv: "KIMI_API_KEY",
      effort,
      onError: "raise",
      maxWorkers: 1,
      timeoutMs: 180000,
    })
    const row = {
      group, fixture, order, seed, rep,
      scores: res.scores, ranking: res.ranking, winner: res.index,
      margin: Math.abs(res.scores[0] - res.scores[1]),
      nComparisons: res.nComparisons,
      usage: res.usage,
      durationMs: Date.now() - t0,
      at: new Date().toISOString(),
    }
    rows.push(row)
    appendFileSync(outFile, JSON.stringify(row) + "\n")
    console.log(`${group}[${fixture}] rep=${rep} seed=${seed} margin=${row.margin.toFixed(4)} ${(row.durationMs / 1000).toFixed(0)}s`)
    return row
  } catch (err) {
    failures += 1
    const row = { group, fixture, order, seed, rep, error: String(err && err.message || err).slice(0, 300), durationMs: Date.now() - t0, at: new Date().toISOString() }
    rows.push(row)
    appendFileSync(outFile, JSON.stringify(row) + "\n")
    console.log(`${group}[${fixture}] rep=${rep} seed=${seed} ERROR ${(row.durationMs / 1000).toFixed(0)}s: ${row.error}`)
    return null
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  console.log(`calibration round: condition=${condition} label=${label} baseURL=${baseURL}`)
  // C0: five fixtures × c0Reps at seed 0 (identical pair).
  for (let f = 0; f < C0_FIXTURES.length; f += 1) {
    for (let rep = 0; rep < c0Reps; rep += 1) {
      await oneCall("C0", "F" + (f + 1), "same", C0_FIXTURES[f], C0_FIXTURES[f], 0, rep)
      await sleep(800)
    }
  }
  // C1 and C2: pairs × both orders × 2 reps.
  for (const seed of [0]) {
    for (let p = 0; p < C1_PAIRS.length; p += 1) {
      for (let rep = 0; rep < 2; rep += 1) {
        await oneCall("C1", "pair" + p, "AB", C1_PAIRS[p][0], C1_PAIRS[p][1], seed, rep)
        await sleep(800)
        await oneCall("C1", "pair" + p, "BA", C1_PAIRS[p][1], C1_PAIRS[p][0], seed, rep)
        await sleep(800)
      }
    }
    for (let p = 0; p < C2_PAIRS.length; p += 1) {
      for (let rep = 0; rep < 2; rep += 1) {
        await oneCall("C2", "pair" + p, "AB", C2_PAIRS[p][0], C2_PAIRS[p][1], seed, rep)
        await sleep(800)
        await oneCall("C2", "pair" + p, "BA", C2_PAIRS[p][1], C2_PAIRS[p][0], seed, rep)
        await sleep(800)
      }
    }
  }

  // ---- summary ---------------------------------------------------------------
  const okRows = rows.filter((r) => !r.error)
  const quantile = (xs, q) => {
    if (xs.length === 0) return null
    const sorted = [...xs].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]
  }
  const groupStats = (prefix) => {
    const list = okRows.filter((r) => r.group.startsWith(prefix))
    const margins = list.map((r) => r.margin)
    const pos = list.map((r) => r.scores[0] - r.scores[1])
    return {
      n: list.length,
      marginMedian: quantile(margins, 0.5),
      marginQ95: quantile(margins, 0.95),
      marginMax: margins.length ? Math.max(...margins) : null,
      positionalBiasMean: pos.length ? pos.reduce((a, b) => a + b, 0) / pos.length : null,
      exactHalfScores: list.filter((r) => r.scores.some((s) => Math.abs(s - 0.5) < 1e-9)).length,
      callsTotal: list.reduce((a, r) => a + (r.usage?.calls ?? 0), 0),
      msP50: quantile(list.map((r) => r.durationMs), 0.5),
    }
  }
  const c1 = okRows.filter((r) => r.group === "C1")
  const c1Correct = c1.filter((r) => (r.order === "AB" ? r.scores[0] > r.scores[1] : r.scores[1] > r.scores[0]))
  const c2 = okRows.filter((r) => r.group === "C2")
  const c2Correct = c2.filter((r) => (r.order === "AB" ? r.scores[0] > r.scores[1] : r.scores[1] > r.scores[0]))

  const summary = {
    condition, label, model, effort, baseURL: new URL(baseURL).host,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    calls: rows.length, failures,
    c0: groupStats("C0"),
    c1: { ...groupStats("C1"), correctDirection: `${c1Correct.length}/${c1.length}` },
    c2: { ...groupStats("C2"), correctDirection: `${c2Correct.length}/${c2.length}` },
    perFixtureC0: Object.fromEntries(C0_FIXTURES.map((_, f) => ["F" + (f + 1), (() => { const l = okRows.filter((r) => r.group === "C0" && r.fixture === "F" + (f + 1)); return { n: l.length, q95: quantile(l.map((r) => r.margin), 0.95), max: l.length ? Math.max(...l.map((r) => r.margin)) : null } })()])),
  }

  // Cross-round stability: the threshold may only leave "provisional" when two
  // rounds of the same condition agree within 20% on the C0 q95.
  const previousSummaries = readdirSync(outDir)
    .filter((f) => f.startsWith(condition + ".summary.") && f.endsWith(".json"))
    .map((f) => { try { return JSON.parse(readFileSync(path.join(outDir, f), "utf8")) } catch { return null } })
    .filter(Boolean)
  const previousC0 = previousSummaries
    .map((s) => s?.c0?.marginQ95 ?? s?.groups?.C0?.marginQ95)
    .filter((v) => typeof v === "number")
  if (previousC0.length > 0 && summary.c0.marginQ95 !== null) {
    const prev = previousC0[previousC0.length - 1]
    const rel = prev > 0 ? Math.abs(summary.c0.marginQ95 - prev) / prev : null
    summary.crossRound = { previousQ95: prev, thisQ95: summary.c0.marginQ95, relativeDiff: rel, stableUnder20Percent: rel !== null && rel < 0.2 }
  }

  writeFileSync(path.join(outDir, `${condition}.summary.${label}.json`), JSON.stringify(summary, null, 2) + "\n")
  console.log("=== summary ===")
  console.log(JSON.stringify(summary, null, 2))
  await bridge.dispose()
}

main().catch(async (err) => {
  console.error("calibration driver failed:", err)
  try { await bridge.dispose() } catch { /* gone */ }
  process.exitCode = 1
})
