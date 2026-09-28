/**
 * Offline null model for the margin gate (review R3 3.2). No network.
 *
 * Reproduces the production aggregation exactly (upstream llm_verifier
 * pivot_tournament.py + fine_grained_reward.directed_reward, P=0):
 *   - ring pass over a random Hamiltonian cycle (N directed pairs; with P=0
 *     there are no pivot rounds), odd evaluation reps swap the prompt slots;
 *   - R per directed comparison = mean over C criteria x K reps of the per-call
 *     expected score in [0,1];
 *   - p(a beats b) = sigmoid(R_a - R_b); score_i = w_i / c_i;
 *   - margin = top-1 minus top-2 score (candidates.ts), gate at THRESHOLD.
 *
 * Per-call score model for a prompt showing text x in slot A, y in slot B,
 * criterion k (all candidates have EQUAL true quality, so any cleared margin
 * is a false winner):
 *   sA - sB = beta + gamma[x,y,k] + eta
 *   eta   ~ N(0, sigmaEta)   fresh sampling noise per call
 *   gamma ~ N(0, sigmaGamma) fixed per ordered prompt (x,y) and criterion: an
 *           "order quirk" of that particular text pairing, identical on every
 *           resample of the same prompt
 *   beta  constant slot bias (measured ~0.0004, cancels around the ring)
 *
 * C0 compares a text with ITSELF, so the (a,b) and (b,a) prompts are the same
 * prompt and gamma[a,b] == gamma[b,a]: C0 cannot see sigmaGamma at all. The
 * calibration rounds pin sigmaEta only (max 0.01377 over 240 N=2 C=1 K=1
 * frames => sigmaEta ~ 0.0136, i.e. ~0.27 score levels).
 *
 *   node eval/calibration/null-model.mjs [--trials 20000] [--json]
 */
import { fileURLToPath } from "node:url"
import { DEFAULT_SELECTION_MARGIN_THRESHOLD } from "../../lib/constants.js"

export const THRESHOLD = DEFAULT_SELECTION_MARGIN_THRESHOLD

/** Deterministic PRNG (mulberry32) + Box-Muller normals. */
export function rng(seed) {
  let a = seed >>> 0
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  let spare = null
  const normal = () => {
    if (spare !== null) { const s = spare; spare = null; return s }
    let u = 0
    while (u === 0) u = uniform()
    const v = uniform()
    const r = Math.sqrt(-2 * Math.log(u))
    spare = r * Math.sin(2 * Math.PI * v)
    return r * Math.cos(2 * Math.PI * v)
  }
  return { uniform, normal }
}

const sigmoid = (x) => 1 / (1 + Math.exp(-x))

/** One selection under the null. `identical` = C0 (every candidate is the same
 *  text, so all prompts coincide). Returns the top-2 margin. */
export function nullMargin({ n, criteria, evaluations, sigmaEta, sigmaGamma, beta = 0, identical = false, sharedGamma = false }, r) {
  const perm = [...Array(n).keys()]
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(r.uniform() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]] }
  const ring = perm.map((x, t) => [x, perm[(t + 1) % n]])
  const gamma = new Map()
  const quirk = (x, y, k) => {
    const kk = sharedGamma ? 0 : k
    const key = identical ? "same|" + kk : x + "," + y + "," + kk
    if (!gamma.has(key)) gamma.set(key, sigmaGamma * r.normal())
    return gamma.get(key)
  }
  const w = new Array(n).fill(0)
  const c = new Array(n).fill(0)
  for (const [a, b] of ring) {
    let diff = 0
    for (let k = 0; k < criteria; k++) {
      for (let rep = 0; rep < evaluations; rep++) {
        // Even reps show (a,b); odd reps swap to (b,a) and read back in
        // candidate order, so R_a - R_b = -(sA - sB) there.
        const [x, y, sign] = rep % 2 === 0 ? [a, b, 1] : [b, a, -1]
        diff += sign * (beta + quirk(x, y, k) + sigmaEta * r.normal())
      }
    }
    const p = sigmoid(diff / (criteria * evaluations))
    w[a] += p; c[a] += 1
    w[b] += 1 - p; c[b] += 1
  }
  const scores = w.map((wi, i) => wi / c[i]).sort((x, y) => y - x)
  return scores[0] - scores[1]
}

export function simulate(cell, { trials = 20000, seed = 1 } = {}) {
  const r = rng(seed)
  const margins = new Float64Array(trials)
  for (let t = 0; t < trials; t++) margins[t] = nullMargin(cell, r)
  const sorted = Array.from(margins).sort((a, b) => a - b)
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  const cleared = sorted.filter((m) => m >= (cell.threshold ?? THRESHOLD)).length
  return { q50: q(0.5), q95: q(0.95), q99: q(0.99), falseWinnerRate: cleared / trials }
}

const variance = (xs) => {
  if (xs.length < 2) return null
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)
}

/** Upper bound on sigmaGamma from a calibration round (N=2, C=1, K=1).
 *  `c0Signed`: C0 signed margins (score[0]-score[1]); `c3PerPair`: for each
 *  equal-evidence pair, the signed margins "first text minus second" of its
 *  frames. Per pair the mean is 0.25*(gamma_ab-gamma_ba) + noise/frames, so
 *  the between-pair variance in excess of C0 noise is 0.125*sigmaGamma^2. */
export function estimateSigmaGamma(c0Signed, c3PerPair) {
  const c0Var = variance(c0Signed)
  const means = c3PerPair.filter((xs) => xs.length > 0).map((xs) => xs.reduce((a, b) => a + b, 0) / xs.length)
  const between = variance(means)
  if (c0Var === null || between === null) return { c0SignedVariance: c0Var, betweenPairVariance: between, sigmaGammaUpper: null }
  const frames = c3PerPair.reduce((a, xs) => a + xs.length, 0) / Math.max(1, means.length)
  const excess = Math.max(0, between - c0Var / Math.max(1, frames))
  return { c0SignedVariance: c0Var, betweenPairVariance: between, sigmaGammaUpper: Math.sqrt(excess) / (0.25 * Math.SQRT2) }
}

/** Signed N=2 C=1 K=1 margin of one frame for a FIXED pair quirk. */
export function signedFrame(gammaAB, gammaBA, sigmaEta, r) {
  const pab = sigmoid(gammaAB + sigmaEta * r.normal())
  const pba = sigmoid(gammaBA + sigmaEta * r.normal())
  return pab - pba
}

/** Expected max of `frames` C0 margins, to check sigmaEta against the invoice. */
export function expectedC0Max(sigmaEta, { frames = 240, reps = 400, seed = 7 } = {}) {
  const r = rng(seed)
  let total = 0
  for (let i = 0; i < reps; i++) {
    let max = 0
    for (let f = 0; f < frames; f++) max = Math.max(max, nullMargin({ n: 2, criteria: 1, evaluations: 1, sigmaEta, sigmaGamma: 0, identical: true }, r))
    total += max
  }
  return total / reps
}

// C>1 rows assume the quirk is independent per criterion (optimistic); the
// "shared quirk" row puts one quirk on all criteria of a prompt (pessimistic).
const CONDITIONS = [
  { name: "calibrated: N=2 C=1 K=1", n: 2, criteria: 1, evaluations: 1 },
  { name: "manual /select default: N=2 C=1 K=1", n: 2, criteria: 1, evaluations: 1 },
  { name: "autopilot standard: N=2 C=3 K=1", n: 2, criteria: 3, evaluations: 1 },
  { name: "  same, quirk shared by criteria", n: 2, criteria: 3, evaluations: 1, sharedGamma: true },
  { name: "autopilot deep: N=3 C=3 K=2", n: 3, criteria: 3, evaluations: 2 },
  { name: "N=3 C=1 K=1", n: 3, criteria: 1, evaluations: 1 },
]
/** Chosen so the model reproduces the invoice: expected max of 240 C0 frames
 *  = 0.0138 (observed 0.01377). */
const SIGMA_ETA = 0.0129
/** Unmeasured input-shift proxy: real 24k-char trajectories may be noisier. */
const ETA_MULTIPLIERS = [2, 3]
/** Order-quirk scales in score units: 0, half a level, one level, two levels. */
const SIGMA_GAMMAS = [0, 0.025, 0.05, 0.1]

function main() {
  const args = process.argv.slice(2)
  const trials = Number(args[args.indexOf("--trials") + 1]) || 20000
  const rows = []
  const c0max = expectedC0Max(SIGMA_ETA)
  for (const cond of CONDITIONS.filter((c, i) => i !== 1)) {
    for (const sigmaGamma of SIGMA_GAMMAS) {
      rows.push({ condition: cond.name, sigmaGamma, ...simulate({ ...cond, sigmaEta: SIGMA_ETA, sigmaGamma }, { trials }) })
    }
  }
  const shift = []
  for (const cond of CONDITIONS.filter((c, i) => i !== 1)) {
    for (const m of ETA_MULTIPLIERS) shift.push({ condition: cond.name, sigmaEta: +(SIGMA_ETA * m).toFixed(4), ...simulate({ ...cond, sigmaEta: SIGMA_ETA * m, sigmaGamma: 0 }, { trials }) })
  }
  if (args.includes("--json")) { console.log(JSON.stringify({ sigmaEta: SIGMA_ETA, expectedC0Max240: c0max, threshold: THRESHOLD, trials, rows, inputShift: shift }, null, 2)); return }
  console.log(`sigmaEta=${SIGMA_ETA} (fitted to invoice C0 max 0.01377/240): model-expected C0 max over 240 frames = ${c0max.toFixed(5)}`)
  console.log(`false-winner rate = P(margin >= ${THRESHOLD}) with all candidates of EQUAL quality; ${trials} trials per cell`)
  console.log("")
  console.log("condition                          sigmaGamma   q95      q99      FWR@0.03")
  for (const r of rows) console.log(`${r.condition.padEnd(35)}${String(r.sigmaGamma).padEnd(13)}${r.q95.toFixed(4)}   ${r.q99.toFixed(4)}   ${(100 * r.falseWinnerRate).toFixed(2)}%`)
  console.log("")
  console.log("input-shift proxy (sigmaGamma=0, sampling noise scaled)")
  console.log("condition                          sigmaEta     q95      q99      FWR@0.03")
  for (const r of shift) console.log(`${r.condition.padEnd(35)}${String(r.sigmaEta).padEnd(13)}${r.q95.toFixed(4)}   ${r.q99.toFixed(4)}   ${(100 * r.falseWinnerRate).toFixed(2)}%`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
