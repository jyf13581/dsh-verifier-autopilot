// Evaluation runner for dsh-verifier-autopilot.
//
// Replays each fixture through the EXACT production trace pipeline (traceFor),
// asks the live host to run the real five-way verifier on it (/api/eval uses
// the same prompt builder, credentials, and aggregation as production), then
// classifies with the production feedback predicate. Outputs detection rate
// (defects flagged) and false-positive rate (clean scenarios flagged).
//
// --repeat=N     evaluate every scenario N times (sampling variance baseline;
//                lanes use fixed seeds but temperature>0, so rounds differ)
// --concurrency=K  in-flight /api/eval requests (default 2)
// --only=PFX     restrict to scenarios whose name starts with PFX
// --routes=N / --fallback pass through to /api/eval
//
// Run: npm run eval   (requires the plugin to be loaded in the local DSH host)

import { mkdirSync, writeFileSync } from 'node:fs'
import { SCENARIOS } from './scenarios.mjs'
import { traceFor } from '../lib/index.js'
import { decideFeedback } from '../lib/verifier.js'

const BASE = 'http://127.0.0.1:3080/@dsh-external/dsh-verifier-autopilot/api'

const argv = new Map(process.argv.slice(2).map(arg => {
  const eq = arg.indexOf('=')
  return eq === -1 ? [arg, ''] : [arg.slice(0, eq), arg.slice(eq + 1)]
}))
const selected = SCENARIOS.filter(s => !argv.has('--only') || s.name.startsWith(argv.get('--only')))
const repeatN = Math.max(1, Math.min(20, Number(argv.get('--repeat')) || 1))
const concurrency = Math.max(1, Math.min(selected.length || 1, Number(argv.get('--concurrency')) || 2))

const state = await (await fetch(BASE + '/state')).json()
const cfg = state.config
console.log('verifier config:', JSON.stringify({ routes: cfg.routes, scoreThreshold: cfg.scoreThreshold, disagreementThreshold: cfg.disagreementThreshold, divergenceGuard: cfg.divergenceGuard, divergenceGuardMedian: cfg.divergenceGuardMedian }))
const routeOverride = Object.assign(
  argv.has('--routes') ? { routes: Math.max(1, Math.min(5, Number(argv.get('--routes')) || cfg.routes)) } : {},
  argv.has('--fallback') ? { allowLabelFallback: true } : {},
)

async function evalScenario(s, round) {
  const bounds = { start: s.events[0], end: s.events[s.events.length - 1], turn: 1 }
  const built = traceFor(s.events, bounds)
  const startedAt = Date.now()
  try {
    const res = await fetch(BASE + '/eval', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ problem: built.problem, trace: built.trace, ...routeOverride }),
      signal: AbortSignal.timeout(180000),
    })
    const body = await res.json()
    if (!body.ok) {
      return Object.assign({ name: s.name, kind: s.kind, round, expectedFlag: s.kind === 'defect', error: String(body.error || ('HTTP ' + res.status)), wallMs: Date.now() - startedAt })
    }
    const agg = body.aggregate
    // NOTE: median must be passed — divergenceGuardBlocks reads it; omitting it silently disables the guard
    const decision = decideFeedback({ results: agg.results, valid: agg.valid, score: agg.score, dispersion: agg.dispersion, confidence: agg.confidence, median: agg.median }, cfg)
    const flagged = decision.feedback
    // pre-guard predicate, recomputed inline so the live guard effect stays measurable
    const baseFlagged = agg.valid.length >= Math.min(3, cfg.routes) && agg.score !== null && (agg.score < cfg.scoreThreshold || (agg.dispersion ?? 0) > cfg.disagreementThreshold)
    const findings = agg.valid.map(r => r.finding).filter(Boolean)
    const noDefectCount = findings.filter(f => /no concrete defect/i.test(f)).length
    const invalidLanes = agg.results.filter(r => !r.ok).map(r => r.route + ':' + (r.errorCode || 'invalid'))
    return {
      name: s.name,
      kind: s.kind,
      round,
      flaw: s.flaw || undefined,
      expectedFlag: s.kind === 'defect',
      flagged,
      guarded: decision.guarded,
      baseFlagged,
      mean: agg.score,
      median: agg.median,
      dispersion: agg.dispersion,
      confidence: agg.confidence,
      validRoutes: agg.valid.length,
      labels: agg.valid.map(r => r.scoreALabel).join(''),
      noDefectFindings: noDefectCount,
      findings,
      invalidLanes,
      retriedLanes: agg.results.filter(r => r.retried).length,
      traceChars: built.trace.length,
      wallMs: Date.now() - startedAt,
    }
  } catch (error) {
    return Object.assign({ name: s.name, kind: s.kind, round, expectedFlag: s.kind === 'defect', error: String(error && error.message || error), wallMs: Date.now() - startedAt })
  }
}

const tasks = []
for (let round = 1; round <= repeatN; round += 1) for (const s of selected) tasks.push({ round, s })
const rows = new Array(tasks.length)
let cursor = 0

async function worker(id) {
  while (cursor < tasks.length) {
    const index = cursor
    cursor += 1
    const { round, s } = tasks[index]
    const row = await evalScenario(s, round)
    rows[index] = row
    const mark = row.error ? 'ERROR' : row.guarded ? 'GUARD' : row.flagged ? 'FLAG' : 'quiet'
    console.log('[w' + id + '] ' + mark.padEnd(6) + ('r' + round + '/' + repeatN).padEnd(7) + row.name.padEnd(32), 'mean=' + (row.mean != null ? Number(row.mean).toFixed(3) : '-'), 'med=' + (row.median != null ? Number(row.median).toFixed(3) : '-'), 'disp=' + (row.dispersion != null ? Number(row.dispersion).toFixed(3) : '-'), 'labels=' + (row.labels || '-'), row.error || '')
  }
}
console.log('running', tasks.length, 'evaluations (rounds=' + repeatN + ', scenarios=' + selected.length + ', concurrency=' + concurrency + ')')
await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)))

// ---- aggregate ----
const okRows = rows.filter(r => r && !r.error)
const defects = okRows.filter(r => r.kind === 'defect')
const cleans = okRows.filter(r => r.kind === 'clean')
const detected = defects.filter(r => r.flagged).length
const falsePositives = cleans.filter(r => r.flagged).length

function stat(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  const sd = values.length > 1 ? Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1)) : 0
  return { n: values.length, mean, sd, min: sorted[0], max: sorted[sorted.length - 1] }
}

const names = [...new Set(okRows.map(r => r.name))]
const variance = { byScenario: {} }
for (const name of names) {
  const rs = okRows.filter(r => r.name === name)
  variance.byScenario[name] = {
    kind: rs[0].kind,
    roundsRequested: repeatN,
    roundsOk: rs.length,
    flagRate: rs.filter(r => r.flagged).length / rs.length,
    flagsViaDispersion: rs.filter(r => r.flagged && !(r.mean < cfg.scoreThreshold)).length,
    guardedRounds: rs.filter(r => r.guarded).length,
    retriedLanesTotal: rs.reduce((sum, r) => sum + (r.retriedLanes || 0), 0),
    baseFlagRate: rs.filter(r => r.baseFlagged).length / rs.length,
    mean: stat(rs.map(r => r.mean)),
    median: stat(rs.map(r => r.median)),
    dispersion: stat(rs.map(r => r.dispersion)),
    labelsPerRound: rs.map(r => r.labels),
    validRoutesPerRound: rs.map(r => r.validRoutes),
  }
}

// Candidate divergence-trigger guard: block feedback when median is high AND
// a majority of valid-lane findings say "no concrete defect". Simulated
// offline over collected rows; production code is untouched.
function guardBlocks(row, medianThreshold) {
  return row.median != null && row.median >= medianThreshold && row.noDefectFindings * 2 > row.validRoutes
}
const strategySim = [0.7, 0.75, 0.8, 0.85, 0.9].map(threshold => {
  let suppressedFalsePositives = 0
  let lostDetections = 0
  let keptTruePositives = 0
  let keptFalsePositives = 0
  for (const row of okRows) {
    if (!(row.baseFlagged ?? row.flagged)) continue
    if (guardBlocks(row, threshold)) {
      if (row.kind === 'clean') suppressedFalsePositives += 1
      else lostDetections += 1
    } else if (row.kind === 'clean') keptFalsePositives += 1
    else keptTruePositives += 1
  }
  return { medianThreshold: threshold, suppressedFalsePositives, lostDetections, keptTruePositives, keptFalsePositives }
})

const summary = {
  timestamp: new Date().toISOString(),
  config: { routes: cfg.routes, scoreThreshold: cfg.scoreThreshold, disagreementThreshold: cfg.disagreementThreshold, divergenceGuard: cfg.divergenceGuard === true, divergenceGuardMedian: cfg.divergenceGuardMedian },
  run: { repeat: repeatN, concurrency, scenarios: selected.length, override: routeOverride },
  scenarios: rows,
  metrics: {
    defectRows: defects.length,
    detected,
    detectionRate: defects.length ? detected / defects.length : null,
    cleanRows: cleans.length,
    falsePositives,
    falsePositiveRate: cleans.length ? falsePositives / cleans.length : null,
    guardedRows: okRows.filter(r => r.guarded).length,
    errorRows: rows.length - okRows.length,
  },
  variance,
  strategySim,
}

mkdirSync('eval/results', { recursive: true })
const file = 'eval/results/results-' + summary.timestamp.replace(/[:.]/g, '-') + '.json'
writeFileSync(file, JSON.stringify(summary, null, 2))

console.log('')
for (const name of names) {
  const v = variance.byScenario[name]
  const f = x => x ? x.mean.toFixed(3) + (x.sd ? ('±' + x.sd.toFixed(3)) : '') + ' [' + x.min.toFixed(3) + '~' + x.max.toFixed(3) + ']' : '-'
  console.log(name.padEnd(32), v.kind.padEnd(7), 'flagRate=' + v.flagRate.toFixed(2), 'viaDisp=' + v.flagsViaDispersion, 'mean=' + f(v.mean), 'median=' + f(v.median), 'disp=' + f(v.dispersion))
}
console.log('')
console.log('detection rate:', summary.metrics.detectionRate, '(' + detected + '/' + defects.length + ')')
console.log('false positive rate:', summary.metrics.falsePositiveRate, '(' + falsePositives + '/' + cleans.length + ')')
console.log('live guard suppressed:', summary.metrics.guardedRows, '(base-triggered rows where feedback was blocked)')
if (summary.metrics.errorRows) console.log('error rows:', summary.metrics.errorRows, '(excluded from metrics)')
console.log('strategy sim (guard: median>=T && majority no-defect findings blocks feedback):')
for (const s of strategySim) console.log('  T=' + s.medianThreshold.toFixed(2), 'suppressFP=' + s.suppressedFalsePositives, 'lostDetect=' + s.lostDetections, '| kept TP=' + s.keptTruePositives, 'kept FP=' + s.keptFalsePositives)
console.log('report:', file)
