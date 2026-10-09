/** Dependency-free constants shared across runtime layers. */

export const PLUGIN_NAME = '@dsh-external/dsh-verifier-autopilot'
export const SETTINGS_NAMESPACE_ID = 'dsh-verifier-autopilot'

/** Calibrated round-one margin gate; still provisional until graduation. */
export const DEFAULT_SELECTION_MARGIN_THRESHOLD = 0.03

/** Verifier evaluations per comparison (K) when nothing else is configured.
 *  The config default, the runner fallback for embedded hosts, and the
 *  bridge fallback for direct calls all read this one value; they used to be
 *  1, 2 and 4 (review R5 5.4), and K is part of the calibrated condition. */
export const DEFAULT_SELECTION_EVALUATIONS = 1

/** Verifier pivots P. Same single-source rule as K: the config default (0,
 *  the standard N=2/K=1/P=0 profile) used to coexist with runner and bridge
 *  fallbacks of 1 (review R6 6.3). */
export const DEFAULT_SELECTION_PIVOTS = 0

/** Ranking (verifier) budget shared by every PPT call and its retry. The
 *  ceiling was raised to 10 min on 2026-09-05: at verifierEffort=max one
 *  minimax-m3 comparison costs ~70..100 s, so N=2 already needs ~300 s. The
 *  default is the config default; the Host and runner fallbacks used to be
 *  180 s (review R6 6.3). */
export const SELECTION_TIMEOUT_MIN_MS = 30_000
export const SELECTION_TIMEOUT_MAX_MS = 600_000
export const DEFAULT_SELECTION_TIMEOUT_MS = 600_000

/** Per-candidate agent window. */
export const CANDIDATE_TIMEOUT_MIN_MS = 30_000
export const CANDIDATE_TIMEOUT_MAX_MS = 1_800_000
export const DEFAULT_CANDIDATE_TIMEOUT_MS = 600_000
