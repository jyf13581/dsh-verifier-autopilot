/** Shared Host ↔ Web client wire contract.
 *
 * Keep this module free of Host/API runtime imports. The browser bundles the
 * model catalog below; all domain imports are type-only and disappear from the
 * client build. A field change here must typecheck both producer and consumer.
 */

import { PLUGIN_NAME, SETTINGS_NAMESPACE_ID } from './constants.js'
import type { Config } from './config.js'
import type { AggregateResult } from './verifier.js'
import type { BridgeSelectRequest } from './selection/bridge.js'
import type { ObjectiveCheck, SelectionRecord } from './selection/candidates.js'
import type { DiagnosticsSnapshot } from './diagnostics.js'

export const API_PREFIX = `/${PLUGIN_NAME}/api` as const
export { SETTINGS_NAMESPACE_ID }

export interface VerificationRecord {
  id: string
  sessionId: string
  turn: number
  turnEndSeq: number
  status: 'running' | 'completed' | 'partial' | 'failed' | 'skipped'
  startedAt: number
  finishedAt?: number
  aggregate?: AggregateResult
  feedbackSent: boolean
  feedbackError?: string
  suppressedFeedback?: { median: number; noDefectLanes: number; validLanes: number }
  feedbackSuppressed?: { reason: 'no-independent-evidence'; defectFindings: number; independentFindings: number }
  skippedReason?: string
  citationAudit?: {
    defectFindings: number
    defectFindingsWithoutCitation: number
    findingsCitingUnknownIds: number
    findingsCitingHistoricalVerdict: number
    findingsWithoutIndependentCitation: number
  }
  traceStats?: {
    eventCount: number
    renderedEventCount: number
    toolEventCount: number
    traceChars: number
    evidenceSignalCount: number
    passSignalCount: number
    evidenceSummaryChars: number
  }
  error?: string
}

export interface SelectionSnapshot {
  active: string | null
  retainedWinners: string[]
  selections: SelectionRecord[]
}

export interface StateResponse {
  config: Config
  agents: number
  records: VerificationRecord[]
  selection: SelectionSnapshot
  /** Recent best-effort degradations and counters (bounded, redacted). */
  diagnostics: DiagnosticsSnapshot
}

export interface SelectionsListResponse {
  ok: true
  active: string | null
  retainedWinners: string[]
  selections: SelectionRecord[]
}

export interface SelectionItemResponse {
  ok: true
  selection: SelectionRecord
}

export interface SelectionStartResponse {
  ok: true
  selection: SelectionRecord
}

export interface SelectionActionResponse { ok: true }

export interface SelectionReleaseResponse {
  ok: true
  state: 'released' | 'not-retained'
}

export interface ConfigResponse {
  ok: true
  config: Config
}

export interface ApiErrorResponse {
  ok: false
  error: string
  message?: string
}

export interface VerifyRequest { sessionId: string }
export interface VerifyResponse { ok: true; record: VerificationRecord }
export interface ConfigRequest extends Partial<Config> {}
export interface SelectionIdRequest { selectionId: string }

/** Public/manual selection admission contract. Runtime validation stays in
 * SelectionHost; internal autopilot metadata extends this shape only inside the
 * domain layer. */
export interface SelectionStartRequest {
  sourceSessionId?: string
  problem?: string
  candidateCount?: number
  criteria?: BridgeSelectRequest['criteria']
  progressGuard?: unknown
  groundTruthNote?: string | null
  checks?: ObjectiveCheck[]
  nEvaluations?: number
  pivots?: number
  algorithmSeed?: number
  agentPreset?: string
  candidateTimeoutMs?: number
  selectTimeoutMs?: number
  candidateModel?: string
  candidateProvider?: string
  candidateOptions?: unknown
  candidateInstructions?: unknown
  useSourceSeed?: boolean
  sourceCwd?: string
  marginThreshold?: number
}

export type HeaderValue = string | readonly string[] | undefined
export type HeaderMap = Record<string, HeaderValue>

/** Minimal structural request/response surface supplied by the DSH web host. */
export interface WebRequest extends AsyncIterable<unknown> {
  method?: string
  url?: string
  headers: HeaderMap
  once(event: 'close', listener: () => void): unknown
}

export interface WebResponse {
  writeHead(status: number, headers: Record<string, string>): unknown
  end(body?: string): unknown
  write(chunk: string): unknown
  once(event: 'close', listener: () => void): unknown
}

export interface WebRoute {
  kind: 'exact'
  path: string
  handler(req: WebRequest, res: WebResponse): void | Promise<void>
}

export interface ModelOption {
  id: string
  baseURL: string
  apiKeyEnv: string
  note: string
}

/** Lane model options. Each entry is a complete endpoint tuple, so selecting a
 * model cannot silently retain another provider's URL or credential reference. */
const RELAY = { baseURL: 'https://chat.holisthoom.top/v1', apiKeyEnv: 'KIMI_API_KEY' } as const
const DEEPSEEK_OFFICIAL = { baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' } as const

export const MODEL_OPTIONS: readonly ModelOption[] = Object.freeze([
  { id: 'nvidia/nemotron-3-super-120b-a12b', ...RELAY, note: '默认：严格协议实测通过（~6s，带 logprobs）' },
  { id: 'z-ai/glm-5.3-flash', ...RELAY, note: '不推荐：effort=max 时思考耗时长，容易撞 lane 超时' },
  { id: 'kimi-k3', ...RELAY, note: '可用：max 强度下延迟不稳定' },
  { id: 'moonshotai/kimi-k3', ...RELAY, note: '可用：kimi-k3 的别名路由' },
  { id: 'nemotron-3-ultra-550b-a55b', ...RELAY, note: '可用：~3s，更强但慢' },
  { id: 'minimaxai/minimax-m3', ...RELAY, note: '已下线：2026-09-09 relay 返回 410（End-of-life）' },
  { id: 'deepseek-chat', ...DEEPSEEK_OFFICIAL, note: '备选：官方 API，需单独配置 DEEPSEEK_API_KEY' },
  { id: 'deepseek-v4-flash', ...DEEPSEEK_OFFICIAL, note: '不推荐：reasoning 吞噬 4096 预算（8192 时 51s/次）' },
  { id: 'step-3.7-flash', ...RELAY, note: '不推荐：长提示推理超 180s 会超时' },
])

export type SelectionView = SelectionRecord
export type State = StateResponse
