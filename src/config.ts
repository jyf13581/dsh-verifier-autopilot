/** Runtime configuration schema, defaults, and validation.
 *
 * This module is deliberately dependency-light: core verifier and host code may
 * depend on it without importing the plugin composition root.
 */

import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from 'schemastery'
import { DEFAULT_SELECTION_MARGIN_THRESHOLD, SETTINGS_NAMESPACE_ID } from './constants.js'

export { DEFAULT_SELECTION_MARGIN_THRESHOLD, SETTINGS_NAMESPACE_ID } from './constants.js'

/** Configuration-owned policy primitives. Selection consumes these types;
 * config must never depend back on the selection implementation. */
export type AutopilotMode = 'off' | 'auto' | 'always'
export type CandidateModelStrategy = 'quality-first' | 'exploration'

export interface Config {
  enabled: boolean
  autoFeedback: boolean
  routes: number
  scoreThreshold: number
  disagreementThreshold: number
  maxFeedbackPerSession: number
  timeoutMs: number
  maxTokens: number
  temperature: number
  baseURL: string
  model: string
  apiKeyEnv: string
  /** Thinking strength ('思考强度') shared by the five-lane verifier and the
   *  selection tournament verifier: off | low | high | max. 'off' explicitly
   *  disables thinking; anything else enables it at that effort level. */
  verifierEffort: 'off' | 'low' | 'high' | 'max'
  /** Accept well-formed single-letter score tags without token logprobs (degraded mode).
   *  Default false: routes lacking logprob evidence stay invalid. */
  allowLabelFallback: boolean
  /** Suppress feedback when the median is high AND a majority of valid lanes found no
   *  concrete defect (single-lane outlier noise). Blocked verifications are recorded as
   *  suppressedFeedback on the record instead of disturbing the agent. */
  divergenceGuard: boolean
  /** Minimum aggregate median for the divergence guard to apply. */
  divergenceGuardMedian: number
  /** Skip five-lane verification for bare status-continuation turns ("继续"/"next")
   *  that produced no tool evidence; the turn is still recorded with status
   *  'skipped' instead of consuming the session's feedback quota. Default true. */
  skipStatusContinuation: boolean
  /** Post a one-line settlement notice into the selection's source session so
   *  the outcome is visible where the operator is actually working, without
   *  opening the panel. Plugin-sourced: never counts toward feedback quota,
   *  never seeds candidate tasks, never feeds verifier evidence. */
  selectionNotify: boolean
  selectionMode: AutopilotMode
  selectionModelStrategy: CandidateModelStrategy
  selectionProvider: string
  selectionModels: string
  selectionStandardCandidates: number
  selectionDeepCandidates: number
  selectionEvaluations: number
  /** Pivot round iterations (k, O(N·k); clamped to the survivor count). */
  selectionPivots: number
  selectionCandidateTimeoutMs: number
  selectionSelectTimeoutMs: number
  /** Calibrated-but-provisional top-2 margin gate for the winner state machine
   *  (ruling I.1/I.4); records retain the exact threshold used. */
  selectionMarginThreshold: number
  /** Probe candidate models for liveness before planning (default true):
   *  catalog membership is not availability (ruling 6.4 kimi-k3 window). */
  selectionProbeEnabled: boolean
  /** Optional explicit test command for the integration post-audit. Empty
   *  (default) = the audit never runs user tests, so delivered=yes stays
   *  unreachable — as the ruling demands until the operator opts in. */
  selectionPostAuditTestCommand: string
  /** Verifier tournament concurrency (server-side ThreadPool workers).
   *  0 = auto (AUTO_VERIFIER_WORKERS=4): the relay's per-request account
   *  round-robin spreads concurrent calls across independent accounts, so one
   *  rate-limited account stalls only its own call. Explicit 1..16 overrides.
   *  Parallelism is capped by the account pool size in practice. */
  selectionVerifierWorkers: number
  /** Token-bucket smoothing: minimum spacing (ms) between verifier request
   *  dispatches, shared by the five-lane verifier and the tournament sidecar.
   *  0 (default) = off. Spreads self-inflicted rate-limit bursts. */
  verifierMinIntervalMs: number
  /** Cheap-tier model for mechanical session-verifier lanes (completion /
   *  evidence). Empty (default) = every lane uses `model`. Opt-in layered
   *  model usage: only hard lanes stay on the main verifier model. */
  verifierSmallModel: string
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  // Feedback is opt-in by default: verifier findings are often useful only
  // after they point to independent tool evidence, while an unsolicited
  // follow-up can interrupt a perfectly good source turn.
  autoFeedback: z.boolean().default(false),
  routes: z.number().step(1).min(1).max(5).default(5),
  scoreThreshold: z.number().min(0).max(1).default(0.62),
  disagreementThreshold: z.number().min(0).max(1).default(0.12),
  maxFeedbackPerSession: z.number().step(1).min(0).max(3).default(1),
  // Keep the legacy lane usable on the free Kimi relay by default. M3 is the
  // currently live-proven strict route; kimi-k3 remains selectable but its max
  // effort latency is not a sensible default.
  timeoutMs: z.number().step(1).min(5000).max(180000).default(180000),
  maxTokens: z.number().step(1).min(256).max(65536).default(64000),
  temperature: z.number().min(0).max(1).default(0.2),
  baseURL: z.string().default('https://chat.holisthoom.top/v1'),
  // Live-proven strict route (2026-09-13: HTTP 200, protocol tags + 96 logprobs, ~5.8s).
  // z-ai/glm-5.3-flash was removed as a default: at effort=max it spent minutes
  // reasoning before emitting the protocol lines, which broke lane deadlines.
  model: z.string().default('nvidia/nemotron-3-super-120b-a12b'),
  apiKeyEnv: z.string().default('KIMI_API_KEY'),
  verifierEffort: z.union(['off', 'low', 'high', 'max']).default('low'),
  allowLabelFallback: z.boolean().default(false),
  divergenceGuard: z.boolean().default(true),
  divergenceGuardMedian: z.number().min(0).max(1).default(0.75),
  skipStatusContinuation: z.boolean().default(true),
  selectionNotify: z.boolean().default(true),
  selectionMode: z.union(['off', 'auto', 'always']).default('auto'),
  selectionModelStrategy: z.union(['quality-first', 'exploration']).default('quality-first'),
  selectionProvider: z.string().default('kimi'),
  // Default candidate route: strictly protocol-proven and ~6s per call, so the
  // automatic tournament stays inside its deadline. The pool remains a fully
  // operator-editable quality order (custom IDs are probed directly).
  selectionModels: z.string().default('nvidia/nemotron-3-super-120b-a12b'),
  // A small tournament is the usable automatic default. Higher N/K/P remain
  // explicit operator controls for deliberate quality runs.
  selectionStandardCandidates: z.number().step(1).min(2).max(5).default(2),
  selectionDeepCandidates: z.number().step(1).min(2).max(5).default(3),
  selectionEvaluations: z.number().step(1).min(1).max(8).default(1),
  // 枢轴迭代数 k：O(N·k) 的比较成本，下游按幸存者数自动收敛。
  selectionPivots: z.number().step(1).min(0).max(5).default(0),
  selectionCandidateTimeoutMs: z.number().step(1000).min(30000).max(1800000).default(600000),
  selectionSelectTimeoutMs: z.number().step(1000).min(30000).max(600000).default(600000),
  // 临时噪声门限（ruling I.1）：top-2 margin 低于它一律 abstain。2026-09-08
  // 校准首轮（C0 24 次同文复跑）噪声 q95=0.0123、最大 0.0135、位置偏差≈0；
  // 0.03 = 观测噪声上限的 2.2 倍，仍标 provisional 待多 fixture 复核。
  selectionMarginThreshold: z.number().min(0).max(0.5).default(DEFAULT_SELECTION_MARGIN_THRESHOLD),
  selectionProbeEnabled: z.boolean().default(true),
  // 后置审计可选测试命令（G-4）：空 = 绝不自动跑用户仓库的测试，delivered
  // 只可能到 unknown/no。
  selectionPostAuditTestCommand: z.string().max(2000).default(''),
  // 锦标赛验证并发：0=自动（4）；1..16 显式。中转站按请求轮询分号，并发
  // 请求天然摊到不同账号，单账号限速只卡它自己那一路。
  selectionVerifierWorkers: z.number().step(1).min(0).max(16).default(0),
  // 令牌桶平滑：验证请求发送的最小间隔（ms）；0=关闭。避免突发打满限额。
  verifierMinIntervalMs: z.number().step(1).min(0).max(60000).default(0),
  // 分层小模型：会话验证的机械 lane（completion/evidence）改用小模型；空=全部用主模型。
  verifierSmallModel: z.string().max(200).default(''),
})

export const SETTINGS_NAMESPACE = settingsNamespace(SETTINGS_NAMESPACE_ID)

/** One authoritative default source: Schemastery owns field defaults and this
 * immutable snapshot is derived from it for non-settings composition paths. */
export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze({ ...Config({}) } as Config)

/** Field shape read off the Schemastery schema. The schema is the single
 *  authority for defaults AND for kind/bounds/choices: the API patch validator
 *  below derives its checks from this table, so a bound changed in the schema
 *  can never drift from the bound the API enforces. */
interface ConfigFieldShape {
  kind: 'boolean' | 'number' | 'string' | 'union'
  min?: number
  max?: number
  /** A step declared on the schema means the field is integral. */
  integer: boolean
  /** Allowed values of a union field, in declaration order. */
  choices: readonly string[]
}

function describeConfigFields(): ReadonlyMap<keyof Config, ConfigFieldShape> {
  const shapes = new Map<keyof Config, ConfigFieldShape>()
  for (const [key, field] of Object.entries(Config.dict ?? {})) {
    const kind = field.type
    if (kind !== 'boolean' && kind !== 'number' && kind !== 'string' && kind !== 'union') {
      throw new Error('config-schema-unsupported-field:' + key + ':' + kind)
    }
    shapes.set(key as keyof Config, {
      kind,
      min: field.meta.min,
      max: field.meta.max,
      integer: typeof field.meta.step === 'number' && Number.isInteger(field.meta.step),
      choices: kind === 'union' ? (field.list ?? []).map(option => String(option.value)) : [],
    })
  }
  return shapes
}

const CONFIG_FIELDS = describeConfigFields()

/** Error code for a rejected union value, e.g. selectionMode ->
 *  config-selection-mode-invalid. Kept in sync with the historical codes. */
function unionErrorCode(key: string): string {
  return 'config-' + key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()) + '-invalid'
}

/** Bridge the settings service's source/change callbacks to the live Host config. */
export function createSettingsSourceHooks(host: { replaceConfig(next: Config): void }): {
  setSource(source: () => Config): void
  onChange(): void
} {
  let current: (() => Config) | undefined
  return {
    setSource: source => { current = source },
    onChange: () => { if (current) host.replaceConfig(current()) },
  }
}

/** @deprecated Since the sixth architecture pass this is an identity copy:
 *  configuration never carries credential values (only `apiKeyEnv` names),
 *  so there is nothing to clean before it leaves through `/state`. Kept one
 *  release for embedders; `VerifierHost.snapshot()` no longer calls it. */
export function cleanConfig(config: Config): Config {
  return { ...config }
}

export function validateConfigPatch(value: unknown): Partial<Config> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('config-object-required')
  const input = value as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(input) as Array<keyof Config>) {
    const shape = CONFIG_FIELDS.get(key)
    if (!shape) throw new Error('unknown-config-key:' + key)
    const item = input[key]
    if (shape.kind === 'boolean') {
      if (typeof item !== 'boolean') throw new Error('config-boolean-required:' + key)
      output[key] = item
      continue
    }
    if (shape.kind === 'union') {
      if (typeof item !== 'string' || !shape.choices.includes(item)) throw new Error(unionErrorCode(key))
      output[key] = item
      continue
    }
    if (key === 'selectionPostAuditTestCommand') {
      // Explicit operator-provided post-audit test command; empty is the
      // default and must be accepted.
      if (typeof item !== 'string') throw new Error('config-string-required:' + key)
      if (/[\u0000-\u0008\u000B-\u001F\u007F]/.test(item) || item.length > 2000) throw new Error('config-invalid-string:' + key)
      output[key] = item
      continue
    }
    if (key === 'verifierSmallModel') {
      // Layered-model opt-in; empty (default) must be accepted so the operator
      // can always clear it and fall back to the single-model verifier.
      if (typeof item !== 'string') throw new Error('config-string-required:' + key)
      if (/[\u0000-\u0008\u000B-\u001F\u007F]/.test(item) || item.length > 200) throw new Error('config-invalid-string:' + key)
      output[key] = item
      continue
    }
    if (shape.kind === 'string') {
      // Free-form identity strings (baseURL, model, apiKeyEnv, selectionProvider,
      // selectionModels): non-empty, printable, bounded, plus per-key policy.
      if (typeof item !== 'string' || item.trim() === '') throw new Error('config-string-required:' + key)
      // Sanity bounds for free-form identity strings (Phase 2): printable,
      // bounded, and env-var names must look like environment variable names.
      if (/[\u0000-\u001f\u007f]/.test(item) || item.length > 300) throw new Error('config-invalid-string:' + key)
      if ((key === 'model' || key === 'selectionProvider') && item.length > 200) throw new Error('config-invalid-string:' + key)
      if (key === 'selectionModels' && item.length > 1000) throw new Error('config-invalid-string:' + key)
      if (key === 'apiKeyEnv' && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(item)) throw new Error('config-invalid-string:' + key)
      // Egress policy (Phase 1): the provider target must be a plain http(s)
      // URL without embedded credentials.
      const normalized = key === 'baseURL' ? item.trim() : item
      if (key === 'baseURL') {
        let parsed: URL
        try { parsed = new URL(normalized) } catch { throw new Error('config-baseURL-url-required:' + key) }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('config-baseURL-http-required:' + key)
        if (!parsed.hostname) throw new Error('config-baseURL-host-required:' + key)
        if (parsed.username || parsed.password) throw new Error('config-baseURL-credentials-forbidden:' + key)
      }
      output[key] = normalized
      continue
    }
    // Numbers: kind, integrality, and bounds all come from the schema.
    if (typeof item !== 'number' || !Number.isFinite(item)) throw new Error('config-number-required:' + key)
    if (shape.integer && !Number.isInteger(item)) throw new Error('config-integer-required:' + key)
    if ((shape.min !== undefined && item < shape.min) || (shape.max !== undefined && item > shape.max)) throw new Error('config-out-of-range:' + key)
    output[key] = item
  }
  // Every value above was checked against CONFIG_FIELDS, which is derived
  // from the same Schemastery schema that defines Config. This is the one
  // place the checked record takes the Config type.
  return output as Partial<Config>
}
