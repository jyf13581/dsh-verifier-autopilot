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
