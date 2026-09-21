import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { Config, DEFAULT_CONFIG, SETTINGS_NAMESPACE, createSettingsSourceHooks, validateConfigPatch } from './config.js'

import { defaultSelectionsFile } from './selection/host.js'
import { VerifierHost, defaultRecordsFile, type HostContext } from './host.js'
import { apiRoutes } from './api.js'

export { VerificationCoordinator } from './coordinator.js'
export { VERIFICATION_HISTORY_LIMIT, VerifierHost, VerifyAbortedError, defaultRecordsFile } from './host.js'
export type { Agent, Credentials, HostContext, RecordState, WebRoute } from './host.js'
export { SelectionHost } from './selection/host.js'
export type { SelectionRecord } from './selection/candidates.js'
export type { TurnBounds, ScheduleKind, ScheduleEntry, RunContext, EntryOutcome } from './coordinator.js'
export { Config, DEFAULT_CONFIG, cleanConfig, createSettingsSourceHooks, validateConfigPatch } from './config.js'
export type { Config as VerifierConfig } from './config.js'
export {
  PLUGIN_SOURCE_NAME, TRACE_BUDGET_CHARS, auditAggregateCitations,
  auditFindingCitation, classifyTurn, compactTrace, feedbackSentCount, flatten,
  isBareContinuationPrompt, renderEventTexts, traceFor, turnBounds,
  turnGateDecision,
} from './evidence.js'
export type { EvidenceKind, EventRecord, FindingCitationAudit, TurnClassification, TurnKind, TurnShape } from './evidence.js'
export { LEDGER_VERSION, atomicWriteFile, appendJsonlLedger, compactJsonlLedger, ledgerExceeds, readJsonlLedger } from './ledger.js'
export { API_RATE_LIMITS, apiRoutes, createRateLimiter, json, readJson } from './api.js'
export { API_PREFIX, MODEL_OPTIONS } from './protocol.js'
export type { ApiErrorResponse, ConfigRequest, ConfigResponse, ModelOption, SelectionIdRequest, SelectionItemResponse, SelectionSnapshot, SelectionView, SelectionsListResponse, State, StateResponse, VerificationRecord, VerifyRequest, VerifyResponse, WebRequest, WebResponse } from './protocol.js'
export type { RateLimiter } from './api.js'


export const name = '@dsh-external/dsh-verifier-autopilot'
export const inject = ['webServer', 'credentials', 'agents', 'llm']


export function apply(ctx: HostContext, config?: Config): void {
  const initial = validateConfigPatch({ ...DEFAULT_CONFIG, ...(config ?? {}) }) as Config
  const host = new VerifierHost(ctx, initial, { recordsFile: defaultRecordsFile(), selectionsFile: defaultSelectionsFile() })
  host.start()
  installSettingsSection(ctx as any, SETTINGS_NAMESPACE, Config, host.getConfig(), createSettingsSourceHooks(host))
  ctx.effect(() => {
    const disposers = apiRoutes(host).map(route => ctx.webServer.register(route))
    return async () => { for (const dispose of disposers) dispose(); await host.dispose() }
  }, 'verifier-autopilot: host service and routes')
}
