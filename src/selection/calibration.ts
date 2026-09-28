/** Margin-gate calibration registry (review R3 3.1).
 *
 *  The top-2 margin gate compares a verifier preference against a noise band
 *  that was measured under ONE condition. The null distribution of the margin
 *  depends on every dimension below, so a threshold is only evidence for the
 *  condition it was measured in:
 *
 *  - verifier model@effort: sampling temperature/entropy of the score letters;
 *  - survivors N: N=2 compares both orders, N>=3 with P=0 compares each pair
 *    in one order and the top-2 gap is an order statistic of N scores;
 *  - criteria C and evaluations K: the score is a mean of N·C·K draws, so the
 *    noise scales roughly with 1/sqrt(C·K);
 *  - pivots P: extra comparisons change both the mean and the dependence;
 *  - inputs: calibration fixtures are 300-700 char synthetic trajectories,
 *    production inputs are a deterministic preface + up to 24k chars of real
 *    trajectory (length, truncation and content shift the distribution).
 *
 *  A condition that is not in the registry is UNCALIBRATED. The gate still
 *  runs with the configured threshold (policy 'flag', default) but the record
 *  and the relay say so; policy 'abstain' refuses to name a winner instead.
 *  Adding an entry requires the graduation evidence of
 *  docs/MARGIN-GRADUATION-INVOICE.md for exactly that condition. */

export type MarginInputs = 'synthetic-short' | 'production-trajectory'

export interface MarginCondition {
  /** `model@effort`, as recorded in SelectionRecord.marginCondition. */
  verifier: string
  survivors: number
  criteria: number
  evaluations: number
  pivots: number
  inputs: MarginInputs
}

export interface CalibratedCondition extends MarginCondition {
  threshold: number
  status: 'provisional' | 'graduated'
  /** Null-hypothesis frames behind the noise estimate. */
  frames: number
  noiseMax: number
  evidence: string
}

/** The only condition with a measured noise band (invoice rounds 2-5,
 *  2026-09-10; the minimax-m3 round-1 numbers were voided). */
export const CALIBRATED_CONDITIONS: readonly CalibratedCondition[] = Object.freeze([
  {
    verifier: 'kimi-k3@low', survivors: 2, criteria: 1, evaluations: 1, pivots: 0, inputs: 'synthetic-short',
    threshold: 0.03, status: 'provisional', frames: 240, noiseMax: 0.01377,
    evidence: 'docs/MARGIN-GRADUATION-INVOICE.md rounds 2-5 (C0 self-comparison frames)',
  },
])

export type UncalibratedMarginPolicy = 'flag' | 'abstain'

export interface MarginCalibration {
  status: 'calibrated' | 'uncalibrated'
  /** Full condition key of this run. */
  key: string
  /** Registry key this run matched, or the closest entry when uncalibrated. */
  nearest: string | null
  /** Dimensions in which this run differs from `nearest`. */
  mismatches: string[]
  policy: UncalibratedMarginPolicy
  /** True when policy 'abstain' overrode a margin that cleared the threshold. */
  forcedAbstain?: boolean
  /** The registry threshold differs from the one the gate used. */
  thresholdMismatch?: { registry: number; used: number }
}

export function marginConditionKey(c: MarginCondition): string {
  return c.verifier + '|N=' + c.survivors + '|C=' + c.criteria + '|K=' + c.evaluations + '|P=' + c.pivots + '|' + c.inputs
}

const DIMENSIONS: ReadonlyArray<keyof MarginCondition> = ['verifier', 'survivors', 'criteria', 'evaluations', 'pivots', 'inputs']

function mismatchesOf(run: MarginCondition, entry: MarginCondition): string[] {
  return DIMENSIONS.filter((d) => {
    if (d === 'verifier') return run.verifier.trim().toLowerCase() !== entry.verifier.trim().toLowerCase()
    return run[d] !== entry[d]
  }).map((d) => d + '=' + String(run[d]) + ' (calibrated ' + String(entry[d]) + ')')
}

export function lookupMarginCalibration(
  run: MarginCondition,
  policy: UncalibratedMarginPolicy,
  usedThreshold: number,
  registry: readonly CalibratedCondition[] = CALIBRATED_CONDITIONS,
): MarginCalibration {
  const key = marginConditionKey(run)
  let best: { entry: CalibratedCondition; mismatches: string[] } | null = null
  for (const entry of registry) {
    const mismatches = mismatchesOf(run, entry)
    if (!best || mismatches.length < best.mismatches.length) best = { entry, mismatches }
  }
  if (!best) return { status: 'uncalibrated', key, nearest: null, mismatches: ['no calibrated condition registered'], policy }
  const calibrated = best.mismatches.length === 0
  return {
    status: calibrated ? 'calibrated' : 'uncalibrated',
    key,
    nearest: marginConditionKey(best.entry),
    mismatches: best.mismatches,
    policy,
    ...(calibrated && Math.abs(best.entry.threshold - usedThreshold) > 1e-12 ? { thresholdMismatch: { registry: best.entry.threshold, used: usedThreshold } } : {}),
  }
}

/** Short operator-facing summary of which dimensions are not calibrated. */
export function describeMismatch(calibration: MarginCalibration): string {
  return calibration.mismatches.map((m) => m.split(' ')[0]).join(', ')
}
