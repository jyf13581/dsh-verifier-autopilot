// P1 fixed-set metrics and the preregistered decision rule (review R7 7.2).
//
// eval/experiments/p1-fixed-set.preregistration.md defines the experiment;
// this module is its arithmetic, so the criterion for further investment is
// code that was reviewed before any data existed, not a reading of results.
// Pure functions, no I/O; scripts/tests/p1-metrics.test.mjs pins them.
//
// One row per task:
//   {
//     task: string,
//     baseline: { pass: boolean, tokens: number },            // arm A: one rollout, plugin off
//     candidates: [{ pass: boolean, tokens: number }, ...],   // arm B: the N rollouts of one selection
//     outcome: 'ranked_winner' | 'single_candidate_fallback' | 'abstain' | 'insufficient_evidence'
//            | 'verifier_unavailable' | 'failed',
//     selectedIndex: number | null,                           // the candidate arm B delivers, if any
//     verifierTokens: number,                                 // preflight + ranking for this selection
//   }
// `pass` is the task's hidden test command, run after the fact; neither arm
// ever sees it.

/** Wilson score interval for k successes in n trials (z = 1.96). */
export function wilson(k, n, z = 1.96) {
  if (n === 0) return { low: 0, high: 1 }
  const p = k / n
  const denom = 1 + (z * z) / n
  const centre = (p + (z * z) / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) }
}

/** What arm B hands the user. A selection that names no candidate (abstain,
 *  insufficient evidence, verifier failure) leaves the source agent with
 *  candidate 0 -- the same thing it would have had without a verifier. */
function delivered(row) {
  if (row.outcome === 'failed' || row.candidates.length === 0) return null
  const index = row.selectedIndex ?? 0
  return row.candidates[index] ?? null
}

export function computeP1Metrics(rows) {
  const n = rows.length
  const mean = (values) => (values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length)
  const passAt1 = mean(rows.map((row) => Number(row.baseline.pass)))
  const passSelected = mean(rows.map((row) => Number(delivered(row)?.pass ?? false)))
  const passRandomPick = mean(rows.map((row) => mean(row.candidates.map((c) => Number(c.pass)))))
  const passOracle = mean(rows.map((row) => Number(row.candidates.some((c) => c.pass))))
  // Discordant tasks: the candidates disagree on the hidden tests, so a pick
  // can be right or wrong. Only these measure the verifier.
  const discordant = rows.filter((row) => row.candidates.some((c) => c.pass) && row.candidates.some((c) => !c.pass))
  const decided = discordant.filter((row) => row.outcome === 'ranked_winner' && row.selectedIndex !== null)
  const agreed = decided.filter((row) => row.candidates[row.selectedIndex]?.pass === true)
  const tokensA = rows.reduce((sum, row) => sum + row.baseline.tokens, 0)
  const tokensB = rows.reduce((sum, row) => sum + row.candidates.reduce((s, c) => s + c.tokens, 0) + row.verifierTokens, 0)
  return {
    tasks: n,
    passAt1,
    passSelected,
    passRandomPick,
    passOracle,
    pipelineUplift: passSelected - passAt1,
    selectionUplift: passSelected - passRandomPick,
    discordant: discordant.length,
    decidedOnDiscordant: decided.length,
    abstainOnDiscordant: discordant.length - decided.length,
    agreement: decided.length === 0 ? null : agreed.length / decided.length,
    agreementInterval: wilson(agreed.length, decided.length),
    costMultiplier: tokensA === 0 ? null : tokensB / tokensA,
  }
}

/** Preregistered thresholds. Changing them after a run is a deviation that
 *  must be recorded in the preregistration, never a silent edit. */
export const P1_THRESHOLDS = Object.freeze({
  minTasks: 30,
  minDecidedDiscordant: 15,
  minPipelineUplift: 0.10,
  maxCostMultiplier: 3,
  agreementFloor: 0.5,
  agreementStop: 0.6,
})

/** continue: evidence for offering autopilot as a recommended setting.
 *  stop: evidence against further investment in verifier selection.
 *  inconclusive: neither; extend the set or stop spending, never "ship". */
export function decideP1(metrics, thresholds = P1_THRESHOLDS) {
  const reasons = []
  if (metrics.tasks < thresholds.minTasks) reasons.push('tasks ' + metrics.tasks + ' < ' + thresholds.minTasks)
  if (metrics.decidedOnDiscordant < thresholds.minDecidedDiscordant) reasons.push('decided discordant ' + metrics.decidedOnDiscordant + ' < ' + thresholds.minDecidedDiscordant)
  const enough = reasons.length === 0
  const { low, high } = metrics.agreementInterval
  // Stop rules are point estimates on purpose: at ~20 decided discordant
  // tasks a coin-flip verifier's agreement interval is about [0.30, 0.70], so
  // an interval-only stop rule could never fire and a useless verifier would
  // stay "inconclusive" (and funded) forever. This is an investment decision,
  // not a significance claim.
  if (enough) {
    const stop = []
    if (high < thresholds.agreementStop) stop.push('agreement upper bound ' + high.toFixed(3) + ' < ' + thresholds.agreementStop)
    if (metrics.selectionUplift <= 0) stop.push('selection uplift ' + metrics.selectionUplift.toFixed(3) + ' <= 0 (no better than a random pick of its own candidates)')
    if (metrics.pipelineUplift <= 0) stop.push('pipeline uplift ' + metrics.pipelineUplift.toFixed(3) + ' <= 0')
    if (stop.length > 0) return { decision: 'stop', reasons: stop }
  }
  if (low <= thresholds.agreementFloor) reasons.push('agreement lower bound ' + low.toFixed(3) + ' <= ' + thresholds.agreementFloor)
  if (metrics.pipelineUplift < thresholds.minPipelineUplift) reasons.push('pipeline uplift ' + metrics.pipelineUplift.toFixed(3) + ' < ' + thresholds.minPipelineUplift)
  if (metrics.costMultiplier === null || metrics.costMultiplier > thresholds.maxCostMultiplier) reasons.push('cost multiplier ' + metrics.costMultiplier + ' > ' + thresholds.maxCostMultiplier)
  return reasons.length === 0 ? { decision: 'continue', reasons: [] } : { decision: 'inconclusive', reasons }
}

// Arm L (legacy keep/retire, review R7 7.3): the legacy five-lane verifier
// scores each arm-A trajectory once, after the fact, through manual /verify.
// One row per task: { baselinePass: boolean, flagged: boolean, valid: boolean }
// where `flagged` means the record would have sent feedback with
// autoFeedback=true -- decideFeedback(aggregate, config).feedback under the
// shipped thresholds AND independent defect evidence from the citation audit
// (the src/host.ts feedback branch) -- and `valid` is false when the lanes
// could not produce a decision (too few valid lanes, transport failure).

export const LEGACY_THRESHOLDS = Object.freeze({
  minFailures: 10,
  minPrecision: 0.7,
  minRecall: 0.5,
  maxInvalidRate: 0.2,
})

export function computeLegacyFlagMetrics(rows) {
  const valid = rows.filter((row) => row.valid)
  const failures = valid.filter((row) => !row.baselinePass)
  const flagged = valid.filter((row) => row.flagged)
  const truePositives = flagged.filter((row) => !row.baselinePass)
  return {
    tasks: rows.length,
    invalidRate: rows.length === 0 ? 0 : (rows.length - valid.length) / rows.length,
    failures: failures.length,
    flagged: flagged.length,
    precision: flagged.length === 0 ? null : truePositives.length / flagged.length,
    recall: failures.length === 0 ? null : truePositives.length / failures.length,
  }
}

/** keep: the flag predicts hidden-test failure well enough to justify an
 *  idle-time path. retire: remove the automatic idle path (keep manual
 *  /verify). insufficient: too few failures in the set to judge -- treated as
 *  retire for the default-on question, since spend needs evidence, not doubt. */
export function decideLegacy(metrics, thresholds = LEGACY_THRESHOLDS) {
  // An unreliable transport is disqualifying at any sample size, and it also
  // shrinks the valid set, so it is judged before the failure count.
  if (metrics.invalidRate > thresholds.maxInvalidRate) return { decision: 'retire', reasons: ['invalid rate ' + metrics.invalidRate.toFixed(3) + ' > ' + thresholds.maxInvalidRate] }
  if (metrics.failures < thresholds.minFailures) return { decision: 'insufficient', reasons: ['failures ' + metrics.failures + ' < ' + thresholds.minFailures] }
  const reasons = []
  if (metrics.precision === null || metrics.precision < thresholds.minPrecision) reasons.push('precision ' + metrics.precision + ' < ' + thresholds.minPrecision)
  if (metrics.recall === null || metrics.recall < thresholds.minRecall) reasons.push('recall ' + metrics.recall + ' < ' + thresholds.minRecall)
  return reasons.length === 0 ? { decision: 'keep', reasons: [] } : { decision: 'retire', reasons }
}
