import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { createUserMessage, boundContextSummary, type UserMessage } from '@deepseek-ai/dsh-llm'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { buildVerifierPrompt, shouldRequestFeedback, decideFeedback, noDefectLaneCount, verifyFive, verifyRoute, resolveKey, normalizeBaseUrl, type AggregateResult, type RouteResult } from './verifier.js'
import { VerificationCoordinator, type ScheduleEntry, type RunContext } from './coordinator.js'
import { Config, DEFAULT_CONFIG, SETTINGS_NAMESPACE, cleanConfig, createSettingsSourceHooks, validateConfigPatch } from './config.js'

import { SelectionHost, SelectionApiError, defaultSelectionsFile } from './selection/host.js'
import { runChecks } from './selection/checks.js'
import { evaluateDelivery } from './selection/candidates.js'
import { buildAutopilotContext, buildAutopilotRelay, planAutopilotTask } from './selection/autopilot.js'
import { resolveAutopilotSourceCwd } from './selection/live.js'
import { gitRepoState } from './selection/live.js'
import { createModelProber, type ModelProber } from './selection/probe.js'

export { VerificationCoordinator } from './coordinator.js'
export { SelectionHost } from './selection/host.js'
export type { SelectionRecord } from './selection/candidates.js'
export type { TurnBounds, ScheduleKind, ScheduleEntry, RunContext, EntryOutcome } from './coordinator.js'
export { Config, DEFAULT_CONFIG, cleanConfig, createSettingsSourceHooks, validateConfigPatch } from './config.js'
export type { Config as VerifierConfig } from './config.js'

type Credentials = { resolve?: (ref: string) => Promise<{ value?: string } | undefined> }
type Agent = { id: string; session: { events: readonly EventRecord[]; header?: { cwd?: string; parentSession?: string } }; ctx: Context; followup: (message: UserMessage) => void | Promise<void> }
type EventRecord = { type: string; seq?: number; time?: number; data?: any }
type HostContext = Context & { webServer: { register(route: WebRoute): () => void }; credentials?: Credentials; agents?: { list(): Agent[]; get(id: string): Agent | undefined }; llm?: { listModels(provider: string): Promise<Array<{ id: string; provider?: string }>> } }
type WebRoute = { kind: 'exact'; path: string; handler: (req: any, res: any) => void | Promise<void> }

export const name = '@dsh-external/dsh-verifier-autopilot'
export const inject = ['webServer', 'credentials', 'agents', 'llm']


const API_PREFIX = '/@dsh-external/dsh-verifier-autopilot/api'
/** Phase 2 durability: finished records append to a JSONL trail so history
 *  survives hot reloads and stays queryable per session/turn. The trail is
 *  bounded (in-memory window + startup compaction) and its loss is never
 *  allowed to break verification. */
const HISTORY_LIMIT = 500
const RECORDS_FILE_MAX_BYTES = 4 * 1024 * 1024

function defaultRecordsFile(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.data', 'records.jsonl')
}

function normalizeLoadedRecord(record: RecordState): RecordState {
  if (record.status !== 'running') return record
  // A run that was in-flight during a reload can never finish honestly.
  return { ...record, status: 'failed', error: 'interrupted-by-reload', finishedAt: record.finishedAt ?? Date.now() }
}

function parseRecordsFile(file: string): RecordState[] {
  let raw: string
  try { raw = readFileSync(file, 'utf8') } catch { return [] }
  const out: RecordState[] = []
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (!text) continue
    try {
      const value = JSON.parse(text) as RecordState
      if (value && typeof value === 'object' && typeof value.id === 'string' && typeof value.status === 'string') out.push(value)
    } catch { /* skip torn or corrupt lines */ }
  }
  // The file is chronological (oldest first); Host state is newest-first.
  return out.reverse().slice(0, HISTORY_LIMIT).map(normalizeLoadedRecord)
}

function loadPersistedRecords(file: string): RecordState[] {
  try {
    if (!existsSync(file)) return []
    if (statSync(file).size > RECORDS_FILE_MAX_BYTES) {
      const tail = parseRecordsFile(file)
      try { writeFileSync(file, tail.slice().reverse().map(record => JSON.stringify(record)).join('\n') + '\n') } catch { /* best-effort compaction */ }
      return tail
    }
    return parseRecordsFile(file)
  } catch { return [] }
}

export class VerifyAbortedError extends Error {
  constructor() {
    super('verification-aborted')
    this.name = 'VerifyAbortedError'
  }
}

type RecordState = {
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
  /** set when the divergence guard blocked a would-be feedback trigger */
  suppressedFeedback?: { median: number; noDefectLanes: number; validLanes: number }
  /** Feedback is intentionally withheld when no valid lane supplied an
   * independent tool-result citation for a concrete defect. */
  feedbackSuppressed?: { reason: 'no-independent-evidence'; defectFindings: number; independentFindings: number }
  /** set when the turn was classified as pure no-op noise and verification was skipped */
  skippedReason?: string
  /** aggregated [E*] citation audit over valid lanes' findings */
  citationAudit?: { defectFindings: number; defectFindingsWithoutCitation: number; findingsCitingUnknownIds: number; findingsCitingHistoricalVerdict: number; findingsWithoutIndependentCitation: number }
  traceStats?: { eventCount: number; renderedEventCount: number; toolEventCount: number; traceChars: number; evidenceSignalCount: number; passSignalCount: number; evidenceSummaryChars: number }
  error?: string
}

function json(res: any, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req: any): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 64 * 1024) throw new Error('body-too-large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function flatten(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(flatten).join('')
  if (value && typeof value === 'object') {
    if ('text' in value) return String((value as { text?: unknown }).text ?? '')
    if ('content' in value) return flatten((value as { content?: unknown }).content)
  }
  return value == null ? '' : JSON.stringify(value)
}

/** Trace pollution measured on live sessions (2026-08-28, session journal
 *  replay): request/header embeds the whole agent system prompt plus every tool
 *  schema (~6KB per turn), session/title(-llm-request) and llm/retry* are turn
 *  bookkeeping. Rendered into the [E*] window they crowd out real TOOL lines
 *  (turn 6 of the repro session lost 20 of 38 tool lines to the 16k prompt
 *  clamp) and make lanes report "trajectory contains only request header". */
const TRACE_NOISE_EVENTS = new Set([
  'assistant/chunk', 'step/start', 'step/end', 'agent/inbox/spliced',
  'request/header', 'request/context', 'session/title', 'session/title-llm-request',
  'llm/retry', 'llm/retry-started',
])

function eventText(event: EventRecord): string {
  const data = event.data ?? {}
  const fallback = (): string => flatten(data)
  if (event.type === 'turn/start' || event.type === 'turn/end') return ''
  if (TRACE_NOISE_EVENTS.has(event.type)) return ''
  if (event.type === 'user/message') {
    if (isVerifierFeedback(event)) return '[VERIFIER FEEDBACK RECEIVED - prior verdict text omitted]'
    // Injected transport (runtime-context snapshots, skill reminders, approval
    // notices) is plumbing around the task, not evidence of work done: each
    // copy costs kilobytes of the clamped [E*] window. Direct human messages
    // (incl. legacy source-less ones) still render as the task/submission.
    if (!isDirectUserMessage(event)) return ''
    return 'USER: ' + (flatten(data.content ?? data.message?.content ?? data.message) || fallback())
  }
  if (event.type === 'assistant/message') return 'ASSISTANT: ' + (flatten(data.message?.content ?? data.content ?? data.message) || fallback())
  if (event.type === 'tool/call') return 'TOOL CALL ' + String(data.name ?? data.tool?.name ?? '') + ': ' + (flatten(data.arguments ?? data.input ?? data.tool?.arguments) || fallback())
  if (event.type === 'tool/result') return 'TOOL RESULT: ' + (flatten(data.message?.content ?? data.message ?? data.result ?? data.output ?? data.content) || fallback()) + (data.error ? ' ERROR: ' + String(data.error.code ?? data.error.name ?? 'tool error') : '')
  return event.type.toUpperCase() + ': ' + (flatten(data.content ?? data.message ?? data.result ?? data.output) || fallback())
}

export function renderEventTexts(events: readonly EventRecord[]): string[] {
  return events.map(eventText).filter(Boolean)
}

/** This plugin's structured feedback identity: followups carry
 *  source.kind='plugin' with this name and form='notice', so detection never
 *  depends on the forgeable '[Verifier feedback]' text prefix. Legacy durable
 *  logs without source metadata keep working through the prefix fallback. */
const PLUGIN_SOURCE_NAME = '@dsh-external/dsh-verifier-autopilot'
const FEEDBACK_PREFIX = '[Verifier feedback]'

function isVerifierFeedback(event: EventRecord): boolean {
  if (event.type !== 'user/message') return false
  const source = event.data?.source
  if (source && typeof source === 'object' && source.kind === 'plugin') {
    return source.plugin === PLUGIN_SOURCE_NAME
  }
  // user-kind sources and legacy source-less events predate the structured
  // identity: recognize them by their text prefix.
  return flatten(event.data?.content).trimStart().startsWith(FEEDBACK_PREFIX)
}

/** Only direct human messages should define the task under review. Runtime context,
 * approval notices, and skill injections use user/message for transport compatibility,
 * but are evidence around the task rather than the task itself. */
function isDirectUserMessage(event: EventRecord): boolean {
  if (event.type !== 'user/message' || isVerifierFeedback(event)) return false
  const source = event.data?.source
  if (source && typeof source === 'object' && typeof source.kind === 'string') return source.kind === 'user'
  // Older persisted events have no source metadata; retain their prior behavior.
  return true
}

/** Turn shapes the no-op gate can distinguish. Historical records show bare
 *  "继续"/status-check turns scoring near T and burning the session's single
 *  feedback slot on noise. Tool absence alone must never trigger the gate:
 *  explanations, design answers, and pure Q&A are legitimately tool-free and
 *  stay fully verifiable. */
export type TurnKind = 'task' | 'pure-answer' | 'status-continuation' | 'repair-followup' | 'no-task'

const CONTINUATION_PROMPTS = new Set([
  'continue', 'go on', 'keep going', 'proceed', 'next', 'next step', 'move on',
  'status', 'status check', 'any update', 'any progress', 'how is it going', 'done',
  '继续', '请继续', '接着来', '接着做', '接着干', '接下来', '下一步',
  '好的', '好', '行', '可以', '嗯', '哦', '收到', '了解', '明白了', '知道了',
  '状态', '进度', '怎么样了', '如何了', '进展如何', '有进展吗', '完成了吗', '做完了吗',
])

/** True only when the WHOLE prompt is a bare continuation/status ping — never when
 *  it carries any additional instruction ("继续修 OX 模型" stays a real task). */
export function isBareContinuationPrompt(problem: string): boolean {
  let text = problem.trim().toLowerCase().replace(/[\s!！?？.。,，、~～…—-]+$/g, '')
  text = text.replace(/^(?:please|plz)\s+/, '').replace(/[\s!！?？.。,，、~～…—-]+$/g, '').trim()
  if (!text || text.length > 24) return false
  return CONTINUATION_PROMPTS.has(text)
}

export interface TurnShape {
  problem: string
  hasCurrentDirectTask: boolean
  toolEventCount: number
  /** false = no direct user task in the current OR historical log; legacy callers omit it */
  hasAnyDirectTask?: boolean
}

export interface TurnClassification { kind: TurnKind; /** set only when automatic verification would evaluate pure noise */ skipReason?: 'bare-status-continuation' | 'evidence-free-repair-followup' }

/** Classifies a finished turn from values traceFor already computed.
 *  - repair-followup: no direct human task in this turn (verifier feedback or a
 *    plugin injection triggered it); the previous task stays under review.
 *  - status-continuation: bare "继续"-style prompt AND zero tool events — the only
 *    class the gate skips. Every other shape keeps being verified. */
export function classifyTurn(shape: TurnShape): TurnClassification {
  if (!shape.hasCurrentDirectTask) {
    // Post-feedback/injection replies with zero tool evidence cannot demonstrate
    // anything about the previous task. Live stage-4 experiment: such a turn
    // scored 0 with tools=0 — record it as skipped instead of burning five lanes.
    if (shape.toolEventCount === 0) return { kind: 'repair-followup', skipReason: 'evidence-free-repair-followup' }
    return { kind: 'repair-followup' }
  }
  if (shape.toolEventCount === 0 && isBareContinuationPrompt(shape.problem)) return { kind: 'status-continuation', skipReason: 'bare-status-continuation' }
  if (shape.toolEventCount === 0) return { kind: 'pure-answer' }
  return { kind: 'task' }
}

export interface FindingCitationAudit {
  findingPresent: boolean
  noDefectFinding: boolean
  citedIds: number[]
  /** cited ids that do not exist in this turn's rendered trace */
  unknownIds: number[]
  /** cites the omitted historical-verdict marker line */
  citesHistoricalVerdict: boolean
  /** at least one citation resolves to a real, non-verdict trace line */
  validCitation: boolean
  /** at least one citation resolves to independent execution evidence (tool result).
   *  Without provenance metadata this equals validCitation (legacy behavior). */
  independentCitation: boolean
  /** the finding cites real lines but only claims (assistant/user), never tool results */
  citesOnlyClaims: boolean
}

/** Extracts cited ids from a finding: single "[E12]" refs and compact ranges
 *  like "[E01-E04]". Spans beyond 64 are ignored entirely rather than credited
 *  or expanded — the conservative direction for an audit marker. */
function extractCitedIds(finding: string): number[] {
  const ids = new Set<number>()
  for (const match of finding.matchAll(/\[E(\d+)\]/g)) ids.add(Number(match[1]))
  for (const match of finding.matchAll(/\[E(\d+)-E?(\d+)\]/g)) {
    const lo = Number(match[1])
    const hi = Number(match[2])
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo || hi - lo > 64) continue
    for (let id = lo; id <= hi; id += 1) ids.add(id)
  }
  return [...ids]
}

/** Validates the [E*] references a finding makes against the ids traceFor
 *  assigned. Purely descriptive: the Host marks bad citations, it never
 *  rewrites or discards the model's conclusion by keyword. When per-line
 *  provenance is supplied, only tool results count as independent execution
 *  evidence — assistant prose and user lines are claims or task statements. */
export function auditFindingCitation(finding: string | undefined, evidenceIds: readonly number[], verdictLineIds: readonly number[], evidenceKinds?: ReadonlyMap<number, string>): FindingCitationAudit {
  const present = typeof finding === 'string' && finding.trim().length > 0
  const noDefect = present && /no concrete defect/i.test(finding as string)
  const cited = present ? extractCitedIds(finding as string) : []
  const evidence = new Set(evidenceIds)
  const verdicts = new Set(verdictLineIds)
  const unknownIds = cited.filter(id => !evidence.has(id))
  const validIds = cited.filter(id => evidence.has(id) && !verdicts.has(id))
  const validCitation = validIds.length > 0
  const independentCitation = validIds.some(id => {
    const kind = evidenceKinds?.get(id)
    // Unknown provenance keeps legacy credit; known non-tool kinds never do.
    return kind === undefined || kind === 'tool-result'
  })
  return {
    findingPresent: present,
    noDefectFinding: noDefect,
    citedIds: cited,
    unknownIds: unknownIds,
    citesHistoricalVerdict: cited.some(id => verdicts.has(id)),
    validCitation,
    independentCitation: validCitation ? independentCitation : false,
    citesOnlyClaims: validCitation && !independentCitation,
  }
}

/** Record-level rollup over valid lanes: only defect findings must cite;
 *  "no concrete defect" findings are exempt by design. When provenance is
 *  supplied, findings that cite only claims (never tool results) are counted
 *  as lacking independent evidence. */
export function auditAggregateCitations(result: AggregateResult, evidenceIds: readonly number[], verdictLineIds: readonly number[], evidenceKinds?: ReadonlyMap<number, string>): { defectFindings: number; defectFindingsWithoutCitation: number; findingsCitingUnknownIds: number; findingsCitingHistoricalVerdict: number; findingsWithoutIndependentCitation: number } {
  let defectFindings = 0
  let withoutCitation = 0
  let unknown = 0
  let historical = 0
  let withoutIndependent = 0
  for (const lane of result.valid) {
    const audit = auditFindingCitation(lane.findingFull ?? lane.finding, evidenceIds, verdictLineIds, evidenceKinds)
    if (!audit.findingPresent || audit.noDefectFinding) continue
    defectFindings += 1
    if (!audit.validCitation) withoutCitation += 1
    if (!audit.independentCitation) withoutIndependent += 1
    if (audit.unknownIds.length > 0) unknown += 1
    if (audit.citesHistoricalVerdict) historical += 1
  }
  return { defectFindings: defectFindings, defectFindingsWithoutCitation: withoutCitation, findingsCitingUnknownIds: unknown, findingsCitingHistoricalVerdict: historical, findingsWithoutIndependentCitation: withoutIndependent }
}

/** Pure decision used by the host idle path: force (manual POST /verify) always
 *  verifies EXCEPT when the session has no direct task at all — a run without a
 *  task cannot name what it verifies, so placeholder verification is skipped
 *  unconditionally (it would burn five lanes and can consume feedback quota). */
export function turnGateDecision(shape: TurnShape, options: { force?: boolean; skipEnabled?: boolean } = {}): { verify: boolean; kind: TurnKind; skipReason?: string } {
  // This safety invariant is independent of the optional noise gate: without a
  // direct task anywhere in the session there is nothing meaningful to verify.
  if (shape.hasAnyDirectTask === false) {
    return { verify: false, kind: 'no-task', skipReason: 'no-direct-task' }
  }
  const classification = classifyTurn(shape)
  if (!options.force && options.skipEnabled !== false && classification.skipReason) return { verify: false, kind: classification.kind, skipReason: classification.skipReason }
  return { verify: true, kind: classification.kind }
}

/** Durable count of verifier feedback messages already delivered in this session,
 *  derived from the append-only session event log so it survives hot reloads. */
export function feedbackSentCount(events: readonly EventRecord[]): number {
  return events.reduce((count, event) => count + (event.type === 'user/message' && isVerifierFeedback(event) ? 1 : 0), 0)
}

function turnBounds(events: readonly EventRecord[]): { start: EventRecord; end: EventRecord; turn: number } | undefined {
  const end = [...events].reverse().find(event => event.type === 'turn/end')
  if (!end) return undefined
  const turn = Number(end.data?.turn)
  if (!Number.isFinite(turn)) return undefined
  const start = [...events].reverse().find(event => event.type === 'turn/start' && Number(event.data?.turn) === turn)
  return start ? { start, end, turn } : undefined
}

/** Single prompt budget shared with buildVerifierPrompt (ruling J.4-E-3):
 *  a compacted trace must NEVER exceed what the prompt builder accepts, so the
 *  old 18000→16000 double truncation can never tail-cut the final answer. */
export const TRACE_BUDGET_CHARS = 16000

function visibleIdsOf(text: string): number[] {
  const ids = new Set<number>()
  for (const match of text.matchAll(/\[E(\d+)\]/g)) ids.add(Number(match[1]))
  return [...ids].sort((a, b) => a - b)
}

export function compactTrace(rendered: readonly string[]): { trace: string; visibleIds: number[]; droppedRanges: string[]; toolEventCount: number; traceChars: number; evidenceSignalCount: number; passSignalCount: number; evidenceSummaryChars: number } {
  // Lines may carry a stable "[E07] " citation prefix; classification always
  // looks at the bare text so numbering can never change compaction or stats.
  const bareOf = (item: string): string => item.replace(/^\[E\d+\] /, '')
  const items = [...rendered]
  const toolLines = items.filter(item => bareOf(item).startsWith('TOOL '))
  const evidenceSignals = toolLines.filter(item => bareOf(item).startsWith('TOOL RESULT:') && /\bPASS(?:ED|ING)?\b|build: complete|\bno output\b|package reload|热重载|\bvalid\b|\bsuccessful\b/i.test(bareOf(item)))
  const evidenceSummary = evidenceSignals.length ? ['[EXTRACTED TOOL EVIDENCE]', ...evidenceSignals.slice(-8).map(item => item.slice(0, 700))].join('\n') : '[EXTRACTED TOOL EVIDENCE] none'
  const fullTrace = [evidenceSummary, items.join('\n')].join('\n')
  const importantToolLines = toolLines.filter(item => bareOf(item).startsWith('TOOL RESULT:') && /(?:PASS|build: complete|score|confidence|valid|finish|completed|success)/is.test(bareOf(item)))
  const selectedToolLines = [...toolLines.slice(0, 3), '[... middle tool events omitted ...]', ...importantToolLines.slice(-8), ...toolLines.slice(-8)]
  const toolEvidence = selectedToolLines.map(item => item.slice(0, 700)).join('\n').slice(0, 8000)
  // One budget, one rule: anything over 16000 compacts to head/tools/tail that
  // provably fits the same 16000 the prompt builder accepts (head 3500 + tools
  // ≤8000 + tail 3500 + markers ≈ 15.1k max). The final answer (last lines)
  // always survives.
  let trace = fullTrace
  let droppedRanges: string[] = []
  if (fullTrace.length > TRACE_BUDGET_CHARS) {
    const head = fullTrace.slice(0, 3500)
    const tail = fullTrace.slice(-3500)
    trace = [head, '[... tool evidence ...]', toolEvidence, '[... trajectory tail ...]', tail].join('\n')
    droppedRanges = ['middle ' + (fullTrace.length - head.length - tail.length) + ' chars of conversation text (non-excerpted portion)']
  }
  return { trace, visibleIds: visibleIdsOf(trace), droppedRanges, toolEventCount: toolLines.length, traceChars: trace.length, evidenceSignalCount: evidenceSignals.length, passSignalCount: evidenceSignals.filter(item => /PASS/i.test(item)).length, evidenceSummaryChars: evidenceSummary.length }
}

/** Provenance class of a rendered line. Only tool results are independent
 *  execution evidence; assistant prose is a claim, and user lines define the
 *  task rather than prove it. */
export type EvidenceKind = 'user' | 'tool-call' | 'tool-result' | 'assistant' | 'verdict-marker' | 'other'

function evidenceKindOf(event: EventRecord): EvidenceKind {
  if (event.type === 'tool/call') return 'tool-call'
  if (event.type === 'tool/result') return 'tool-result'
  if (event.type === 'assistant/message') return 'assistant'
  if (event.type === 'user/message') return isVerifierFeedback(event) ? 'verdict-marker' : 'user'
  return 'other'
}

/** Exported for the evaluation harness: builds problem + compacted trace exactly as production does.
 *  `evidenceIds` is the FULL rendered set (statistics only); citation audits
 *  must run against `visibleEvidenceIds` — the ids that actually survived
 *  compaction into the verifier prompt (ruling J.4-E, B-6). */
export function traceFor(events: readonly EventRecord[], bounds: { start: EventRecord; end: EventRecord; turn?: number }): { problem: string; hasCurrentDirectTask: boolean; hasAnyDirectTask: boolean; trace: string; evidenceIds: number[]; visibleEvidenceIds: number[]; verdictLineIds: number[]; evidenceKinds: Record<string, EvidenceKind>; stats: { eventCount: number; renderedEventCount: number; toolEventCount: number; traceChars: number; evidenceSignalCount: number; passSignalCount: number; evidenceSummaryChars: number } } {
  const startSeq = bounds.start.seq ?? 0
  const endSeq = bounds.end.seq ?? Number.MAX_SAFE_INTEGER
  const turn = Number(bounds.start.data?.turn ?? bounds.end.data?.turn)
  const belongsToTurn = (event: EventRecord): boolean => {
    const eventTurn = Number(event.data?.turn)
    const eventSeq = event.seq ?? 0
    // A matching turn field alone is not enough: events appended after turn/end
    // must not cross the completed-turn seq seal (late same-turn injection).
    if (Number.isFinite(turn) && Number.isFinite(eventTurn)) return eventTurn === turn && eventSeq >= startSeq && eventSeq <= endSeq
    return eventSeq >= startSeq && eventSeq <= endSeq
  }
  const current = events.filter(belongsToTurn)
  const before = events.filter(event => {
    if (!isDirectUserMessage(event)) return false
    const eventTurn = Number(event.data?.turn)
    if (Number.isFinite(turn) && Number.isFinite(eventTurn)) return eventTurn < turn
    return (event.seq ?? 0) < startSeq
  })
  const currentTask = [...current].reverse().find(isDirectUserMessage)
  // In current DSH logs the prompt normally follows turn/start. Older logs may
  // place it immediately before turn/start, so use history only as a fallback.
  const taskEvent = currentTask ?? before[before.length - 1]
  // Without any direct task the run must not invent one: verifyAgent skips
  // such turns ('no-direct-task') instead of scoring against a placeholder.
  const problem = flatten(taskEvent?.data?.content ?? taskEvent?.data?.message?.content ?? taskEvent?.data?.message ?? '')
  // Number every rendered line so findings can cite exact trajectory evidence.
  // Ids are positions in this turn's rendered order and stay attached to their
  // line through compaction and truncation. Verifier-feedback marker lines are
  // tracked separately: citing them means citing an omitted historical verdict.
  const numbered: Array<{ id: number; text: string; verdictMarker: boolean; kind: EvidenceKind }> = []
  let cursor = 0
  for (const event of current) {
    const text = eventText(event)
    if (!text) continue
    cursor += 1
    numbered.push({ id: cursor, text: '[E' + String(cursor).padStart(2, '0') + '] ' + text, verdictMarker: isVerifierFeedback(event), kind: evidenceKindOf(event) })
  }
  const rendered = numbered.map(item => item.text)
  const compacted = compactTrace(rendered)
  const stats = { eventCount: current.length, renderedEventCount: rendered.length, ...compacted }
  return {
    problem: problem.slice(0, 8000),
    hasCurrentDirectTask: currentTask !== undefined,
    hasAnyDirectTask: currentTask !== undefined || before.length > 0,
    trace: compacted.trace,
    stats,
    evidenceIds: numbered.map(item => item.id),
    visibleEvidenceIds: compacted.visibleIds,
    verdictLineIds: numbered.filter(item => item.verdictMarker).map(item => item.id),
    evidenceKinds: Object.fromEntries(numbered.map(item => [String(item.id), item.kind])),
  }
}

const DEFAULT_FEEDBACK_TIMEOUT_MS = 15_000

/** A Host followup has no cancellation API, so bound how long it can occupy a
 * coordinator slot while still observing lifecycle disposal. */
function awaitFollowupWithFence(operation: Promise<void>, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      settle()
    }
    const onAbort = (): void => finish(() => reject(new Error('feedback-aborted')) )
    const timer = setTimeout(() => finish(() => reject(new Error('feedback-timeout'))), timeoutMs)
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      () => finish(() => resolve()),
      error => finish(() => reject(error)),
    )
  })
}

export class VerifierHost {
  private config: Config
  private readonly agents = new Map<string, Agent>()
  /** per-agent status-listener revocation, keyed by agent id */
  private readonly agentListeners = new Map<string, () => void>()
  private readonly records: RecordState[] = []
  private readonly listeners = new Set<() => void>()
  private readonly disposers: Array<() => void> = []
  private readonly coordinator: VerificationCoordinator<Agent, RecordState | undefined>
  private disposed = false
  /** null disables persistence (tests/embedded use); the injected Host enables it */
  private readonly recordsFile: string | null
  private readonly feedbackTimeoutMs: number
  /** Best-of-N selection host (manual trigger plus first-step autopilot). */
  readonly selections: SelectionHost
  /** Autopilot winners live only until the source turn reaches idle. */
  private readonly autopilotCleanup = new Map<string, Set<string>>()
  /** Background selections are cancelled when their source session disappears. */
  private readonly autopilotActive = new Map<string, Set<string>>()

  /** Candidate-model liveness prober, memoized per (baseURL, key) pair so
   *  config churn never keeps a stale credential around. */
  private proberState: { baseURL: string; apiKey: string; instance: ModelProber } | null = null

  private proberFor(baseURL: string, apiKey: string): ModelProber {
    if (!this.proberState || this.proberState.baseURL !== baseURL || this.proberState.apiKey !== apiKey) {
      this.proberState = { baseURL, apiKey, instance: createModelProber({ baseURL, apiKey }) }
    }
    return this.proberState.instance
  }

  constructor(private readonly ctx: HostContext, config: Config, options: { recordsFile?: string | null; feedbackTimeoutMs?: number; selectionsFile?: string | null; selectionsTesting?: ConstructorParameters<typeof SelectionHost>[0]['testing'] } = {}) {
    this.config = config
    this.recordsFile = options.recordsFile === undefined ? null : options.recordsFile
    this.feedbackTimeoutMs = Number.isFinite(options.feedbackTimeoutMs)
      ? Math.max(1, Math.floor(options.feedbackTimeoutMs as number))
      : DEFAULT_FEEDBACK_TIMEOUT_MS
    this.coordinator = new VerificationCoordinator<Agent, RecordState | undefined>({
      run: (entry, runContext) => this.executeEntry(entry, runContext),
    })
    this.selections = new SelectionHost({
      agents: this.ctx.agents as never,
      liveAgents: this.ctx.agents as never,
      defaultRoute: () => {
        try {
          return (this.ctx.get('agentDefaultModel') as { currentSelection?: () => { provider?: string; model?: string } } | undefined)?.currentSelection?.()
        } catch { return undefined }
      },
      resolveKey: (ref) => resolveKey(this.ctx.credentials, ref),
      verifier: () => ({ model: this.config.model, baseURL: this.config.baseURL, apiKeyEnv: this.config.apiKeyEnv, effort: this.config.verifierEffort, maxWorkers: this.config.selectionVerifierWorkers, minIntervalMs: this.config.verifierMinIntervalMs }),
      candidateTimeoutMsDefault: () => this.config.selectionCandidateTimeoutMs,
      nEvaluationsDefault: () => this.config.selectionEvaluations,
      pivotsDefault: () => this.config.selectionPivots,
      marginThresholdDefault: () => this.config.selectionMarginThreshold,
      selectTimeoutMsDefault: () => this.config.selectionSelectTimeoutMs,
      // I.5 audit pack sits next to the ledger; disabled when the ledger is.
      artifactsDir: options.selectionsFile == null ? null : path.join(path.dirname(options.selectionsFile), 'selection-artifacts'),
      selectionsFile: options.selectionsFile === undefined ? null : options.selectionsFile,
      testing: options.selectionsTesting,
      notify: (record) => this.notifySelectionSettlement(record),
    })
  }

  private async handleAutopilotPreStep(
    agent: Agent,
    payload: { messages: UserMessage[]; turn: number; step: number; signal: AbortSignal },
    next: () => Promise<{ kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] }>,
  ): Promise<{ kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] }> {
    if (this.disposed || this.config.selectionMode === 'off' || payload.step !== 1 || agent.session.header?.parentSession) return next()
    const decision = await next()
    if (decision.kind === 'reject') return decision

    // Downstream pre-step transforms own the accepted message boundary. Build
    // both admission and relay input from that same decision, never the raw
    // claimed inbox batch.
    const direct = decision.messages.filter((message) => message.source?.kind === 'user')
    if (direct.length === 0 || direct.some((message) => message.content.some((block) => block.type !== 'text'))) return decision
    const task = direct.map((message) => flatten(message.content)).filter(Boolean).join('\n\n').trim()
    if (!task || task.length > 32_000) return decision

    const preferredModels = this.config.selectionModels.split(',').map((model) => model.trim()).filter(Boolean)
    const policy = {
      mode: this.config.selectionMode,
      provider: this.config.selectionProvider,
      preferredModels,
      modelStrategy: this.config.selectionModelStrategy,
      standardCandidates: this.config.selectionStandardCandidates,
      deepCandidates: this.config.selectionDeepCandidates,
      nEvaluations: this.config.selectionEvaluations,
      candidateTimeoutMs: this.config.selectionCandidateTimeoutMs,
      selectTimeoutMs: this.config.selectionSelectTimeoutMs,
    } as const
    // Cheap classification first: session-control/status messages and unsafe
    // side effects never call model discovery or touch a workspace.
    const preliminary = planAutopilotTask(task, preferredModels, policy)
    if (!preliminary.admitted) return decision
    const sourceCwd = await resolveAutopilotSourceCwd(task, agent.session.header?.cwd)
    if (!sourceCwd) return decision

    let availableModels: string[] = preferredModels.slice()
    let catalogAvailable = true
    try {
      const catalogModels = await this.ctx.llm?.listModels(this.config.selectionProvider)
      if (catalogModels) availableModels = [...new Set([...preferredModels, ...catalogModels.map((model) => model.id)])]
    } catch {
      // A provider catalog is discovery metadata, not an allowlist. Keep the
      // operator-supplied model IDs and let the real probe decide liveness.
      catalogAvailable = false
    }
    payload.signal.throwIfAborted()
    // Liveness before planning (ruling P-C): the catalog lists models that may
    // be dead for days. Probe every configured model, including custom IDs that
    // a provider catalog does not advertise, and drop only confirmed failures.
    let probeEvidence: Record<string, boolean> | undefined
    if (this.config.selectionProbeEnabled) {
      try {
        const probeKey = await resolveKey(this.ctx.credentials, this.config.apiKeyEnv)
        if (probeKey) {
          const prober = this.proberFor(this.config.baseURL, probeKey)
          const alive: string[] = []
          const dead: string[] = []
          for (const model of preferredModels) {
            (await prober.probe(model) ? alive : dead).push(model)
          }
          if (alive.length > 0 || dead.length === 0) {
            const deadSet = new Set(dead)
            availableModels = [...alive, ...availableModels.filter((m) => !deadSet.has(m) && !alive.includes(m))]
            if (dead.length > 0 || !catalogAvailable) probeEvidence = Object.fromEntries(dead.map((m) => [m, false]).concat(alive.map((m) => [m, true])))
          } else if (dead.length > 0) {
            // All configured models are dead: never roll the whole pool onto a
            // corpse or silently weaken the selection gates.
            return decision
          }
        }
      } catch { /* probing is advisory only when the provider key is unavailable */ }
    }
    const plan = planAutopilotTask(task, availableModels, policy)
    if (!plan.admitted || !plan.depth || !plan.candidateCount || !plan.nEvaluations || !plan.candidateOptions || !plan.candidateInstructions || !plan.criteria) return decision

    const context = buildAutopilotContext(agent.session.events, task)
    // Autopilot is advisory and must never hold the source turn hostage to a
    // slow free relay. The explicit /select API remains awaitable; this path
    // starts a background selection and returns the original decision now.
    let selectionId: string | null = null
    const cancel = () => { if (selectionId) this.selections.cancel(selectionId) }
    payload.signal.addEventListener('abort', cancel, { once: true })
    try {
      const started = await this.selections.start({
        sourceSessionId: agent.id,
        problem: context,
        candidateCount: plan.candidateCount,
        candidateOptions: plan.candidateOptions,
        candidateInstructions: plan.candidateInstructions,
        criteria: plan.criteria,
        nEvaluations: plan.nEvaluations,
        pivots: this.config.selectionPivots,
        candidateTimeoutMs: plan.candidateTimeoutMs,
        selectTimeoutMs: plan.selectTimeoutMs,
        useSourceSeed: false,
        trigger: 'autopilot',
        taskKind: plan.taskKind,
        policy: {
          depth: plan.depth,
          modelStrategy: plan.modelStrategy ?? 'quality-first',
          candidateCount: plan.candidateCount,
          nEvaluations: plan.nEvaluations,
          pivots: this.config.selectionPivots,
          verifierEffort: this.config.verifierEffort,
          taskKind: plan.taskKind,
          probes: probeEvidence,
          contextChars: context.length,
          models: plan.candidateOptions.map((route) => route.model),
        },
      }, { sourceCwd })
      selectionId = started.selectionId
      if (payload.signal.aborted) {
        this.selections.cancel(selectionId)
        payload.signal.throwIfAborted()
      }
      const sourceId = String(agent.id)
      const active = this.autopilotActive.get(sourceId) ?? new Set<string>()
      active.add(selectionId)
      this.autopilotActive.set(sourceId, active)
      // Detach all slow work from the pre-step promise. The source task enters
      // immediately; only a completed winner is relayed later, when the source
      // agent is still alive. Failures are observable in the selection ledger.
      void this.selections.waitFor(selectionId).then((record) => {
        const current = this.autopilotActive.get(sourceId)
        current?.delete(selectionId as string)
        if (current && current.size === 0) this.autopilotActive.delete(sourceId)
        payload.signal.removeEventListener('abort', cancel)
        // Ruling I.2: relay every terminal outcome, not only winners — an
        // abstain or insufficient_evidence is exactly the information the
        // source turn needs. Outcome-less legacy records never reach here.
        if (record.status !== 'completed' || !record.outcome || this.disposed) return
        if (this.ctx.agents?.get(sourceId) !== agent) return
        const retained = record.winner ?? record.fallback
        if (retained) {
          const pending = this.autopilotCleanup.get(sourceId) ?? new Set<string>()
          pending.add(selectionId as string)
          this.autopilotCleanup.set(sourceId, pending)
        }
        record.timing = { ...(record.timing ?? {}), relayedAt: Date.now() }
        // Ledger + artifact must see relayedAt now, not at some later discard:
        // a hot reload between relay and cleanup would otherwise erase the mark.
        this.selections.pubRecord(record)
        void Promise.resolve(agent.followup(createUserMessage({
          source: { kind: 'plugin', plugin: PLUGIN_SOURCE_NAME + '/autopilot', form: 'relay' },
          content: [{ type: 'text', text: buildAutopilotRelay(record) }],
        }))).catch(() => undefined)
      }).catch(() => {
        const current = this.autopilotActive.get(sourceId)
        current?.delete(selectionId as string)
        if (current && current.size === 0) this.autopilotActive.delete(sourceId)
        payload.signal.removeEventListener('abort', cancel)
      })
      return decision
    } catch {
      // The selection admission itself is the only synchronous failure point.
      // Once admitted, its terminal outcome is handled by the background waiter.
      payload.signal.removeEventListener('abort', cancel)
      payload.signal.throwIfAborted()
      return decision
    }
  }

  private async cleanupAutopilotWinners(sourceSessionId: string): Promise<void> {
    const pending = this.autopilotCleanup.get(sourceSessionId)
    if (!pending) return
    for (const selectionId of [...pending]) {
      try {
        // G-4 post-audit BEFORE discard: compare the source repo state against
        // the start-time snapshot. Audited-but-unevidenced integration reports
        // 'no'; observed HEAD/dirty evidence without running tests can only be
        // 'unknown' — 'yes' requires deterministic passing tests, which this
        // hook intentionally never runs on the user's repository.
        const rec = this.selections.getSelection(selectionId)
        const slot = rec ? (rec.winner ?? rec.fallback) : undefined
        if (rec && slot && slot.discardedAt === undefined && !rec.delivery) {
          const cwd = typeof rec.configSnapshot?.sourceCwd === 'string' ? rec.configSnapshot.sourceCwd as string : undefined
          if (!cwd) {
            rec.delivery = { audited: false, delivered: 'unknown', note: 'no source cwd in config snapshot' }
          } else {
            try {
              const state = await gitRepoState(cwd)
              if (!state) {
                rec.delivery = { audited: false, delivered: 'unknown', note: 'source repo unreadable at audit time' }
              } else {
                const before = rec.sourceHeadAtStart ?? null
                const headChanged = before !== null && state.head !== null ? state.head !== before : null
                const testCommand = this.config.selectionPostAuditTestCommand.trim()
                let testsExit: number | null = null
                let testsRan = false
                let postAuditError: string | undefined
                if (testCommand && (headChanged === true || state.dirtyEntries > 0)) {
                  try {
                    const results = await runChecks(cwd, [{ name: 'post-audit', command: testCommand, timeoutMs: 120000 }])
                    testsExit = results[0]?.exitCode ?? null
                    testsRan = true
                  } catch (runError) {
                    postAuditError = runError instanceof Error ? runError.message.slice(0, 200) : String(runError).slice(0, 200)
                  }
                }
                const verdict = evaluateDelivery({
                  audited: true,
                  headChanged,
                  dirtyEntries: state.dirtyEntries,
                  testsConfigured: testCommand.length > 0,
                  testsExit: testsRan ? testsExit : null,
                })
                rec.delivery = {
                  audited: true,
                  headBefore: before,
                  headAfter: state.head,
                  headChanged,
                  dirtyEntries: state.dirtyEntries,
                  ...(testsRan ? { postAuditTestExit: testsExit } : {}),
                  delivered: verdict.delivered,
                  note: verdict.note + (postAuditError ? ' [test runner error: ' + postAuditError + ']' : ''),
                }
              }
            } catch {
              rec.delivery = { audited: false, delivered: 'unknown', note: 'audit raised' }
            }
          }
          rec.timing = { ...(rec.timing ?? {}), auditedAt: Date.now() }
        }
        const removed = await this.selections.discardWinner(selectionId)
        const after = this.selections.getSelection(selectionId)
        const slotAfter = after ? (after.winner ?? after.fallback) : undefined
        if (removed || !slotAfter || slotAfter.discardedAt !== undefined) pending.delete(selectionId)
      } catch { /* keep it queued for the next idle/dispose retry */ }
    }
    if (pending.size === 0) this.autopilotCleanup.delete(sourceSessionId)
  }

  /** One concise settlement notice into the source session: the outcome lands
   *  where the operator is looking instead of only in the panel. The distinct
   *  plugin sub-identity ('…/selection') keeps it out of feedback quota,
   *  verifier evidence, and selection seed extraction. Never throws. */
  private notifySelectionSettlement(record: import('./selection/candidates.js').SelectionRecord): void {
    if (!this.config.selectionNotify) return
    const sid = record.sourceSessionId
    if (!sid) return
    const agent = this.ctx.agents?.get(sid)
    if (!agent || typeof agent.followup !== 'function') return
    const scores = record.scores?.map((s) => (s === null ? 'null' : s.toFixed(3))).join('/')
    const slot = record.winner ?? record.fallback
    const text = record.status === 'completed' && slot
      ? '[Selection 结算] ' + record.selectionId + ' 已完成：outcome=' + (record.outcome ?? 'legacy')
        + '，' + (record.winner ? 'winner=c' + record.winner.index : 'fallback=c' + slot.index + '（未经候选间比较，非选优结论）')
        + (scores ? '（scores ' + scores + '，比较 ' + (record.nComparisons ?? 0) + ' 次）' : '')
        + (record.margin !== undefined ? '（margin ' + record.margin.toFixed(4) + ' / 阈值 ' + (record.marginThreshold ?? 'n/a') + (record.marginProvisional ? '，临时' : '') + '）' : '')
        + '。loser/淘汰候选已回收（会话与工作区均已删除）。保留对象的工作区位于 ' + slot.workspace + '，面板里可"丢弃 winner"彻底清理。此消息为结算通知，无需回复。'
      : '[Selection 结算] ' + record.selectionId + ' 结束：status=' + record.status + (record.outcome ? '，outcome=' + record.outcome : '') + (record.error ? '（' + record.error + '）' : '') + '，候选已全部回收。此消息为结算通知，无需回复。'
    try {
      void Promise.resolve(agent.followup(createUserMessage({
        source: { kind: 'plugin', plugin: PLUGIN_SOURCE_NAME + '/selection', form: 'notice', summary: boundContextSummary('选择结算：' + record.selectionId) },
        content: [{ type: 'text', text }],
      }))).catch(() => undefined)
    } catch { /* notice failures are silent by design */ }
  }

  start(): void {
    this.loadHistory()
    for (const agent of this.ctx.agents?.list() ?? []) this.attach(agent)
    const events = this.ctx as unknown as { on: (name: string, handler: (...args: any[]) => any, options?: { prepend?: boolean }) => (() => void) | void }
    const created = events.on('agent/created', payload => this.attach(payload?.agent))
    if (typeof created === 'function') this.disposers.push(created)
    const disposed = events.on('agent/disposed', payload => this.detach(payload?.agent))
    if (typeof disposed === 'function') this.disposers.push(disposed)
    this.recoverAutopilotRelays()
  }

  /** Reload recovery (live incident sel-ac04cfd7, 2026-09-09): a plugin hot
   *  reload disposes the background waiter, so a settled autopilot fallback/
   *  winner could sit retained forever with its relay never delivered. On
   *  startup, re-deliver the relay for any newly-settled record whose source
   *  agent is still alive, and re-register the retained workspace so idle /
   *  dispose cleanup picks it up exactly once. */
  private recoverAutopilotRelays(): void {
    for (const record of this.selections.listSelections()) {
      if (record.trigger !== 'autopilot' || record.status !== 'completed') continue
      if (!record.outcome) continue
      const slot = record.winner ?? record.fallback
      if (!slot || slot.discardedAt !== undefined) continue
      if (record.timing?.relayedAt) continue
      const sourceId = record.sourceSessionId
      if (!sourceId) continue
      const agent = this.ctx.agents?.get(sourceId)
      if (!agent) continue
      const pending = this.autopilotCleanup.get(sourceId) ?? new Set<string>()
      pending.add(record.selectionId)
      this.autopilotCleanup.set(sourceId, pending)
      record.timing = { ...(record.timing ?? {}), relayedAt: Date.now() }
      this.selections.pubRecord(record)
      void Promise.resolve(agent.followup(createUserMessage({
        source: { kind: 'plugin', plugin: PLUGIN_SOURCE_NAME + '/autopilot', form: 'relay' },
        content: [{ type: 'text', text: buildAutopilotRelay(record) }],
      }))).catch(() => undefined)
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.coordinator.dispose()
    for (const dispose of this.disposers.splice(0)) { try { dispose() } catch { /* isolated */ } }
    for (const unsubscribe of this.agentListeners.values()) { try { unsubscribe() } catch { /* isolated */ } }
    this.agentListeners.clear()
    for (const selectionIds of this.autopilotActive.values()) for (const selectionId of selectionIds) this.selections.cancel(selectionId)
    this.autopilotActive.clear()
    await Promise.all([...this.autopilotCleanup.keys()].map((id) => this.cleanupAutopilotWinners(id)))
    await this.selections.dispose()
    // A handle lock may clear only during SelectionHost disposal; retry any
    // queued workspace/session cleanup once after all live agents have settled.
    await Promise.all([...this.autopilotCleanup.keys()].map((id) => this.cleanupAutopilotWinners(id)))
    this.agents.clear()
    this.listeners.clear()
  }

  setConfig(patch: Partial<Config>): void {
    this.config = { ...this.config, ...validateConfigPatch(patch) }
    this.emit()
  }

  getConfig(): Config { return this.config }

  getCredentials(): Credentials | undefined { return this.ctx.credentials }

  replaceConfig(next: Config): void {
    this.config = { ...this.config, ...validateConfigPatch(next) }
    this.emit()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** A single broken SSE connection must never break verification or config
   *  operations: listener exceptions are contained here. */
  private emit(): void {
    for (const listener of [...this.listeners]) {
      try { listener() } catch { /* subscriber exceptions are isolated */ }
    }
  }

  private attach(agent: Agent | undefined): void {
    if (!agent || this.disposed) return
    // Candidate children (parentSession set) belong to the best-of-N selection
    // path: legacy auto verification + feedback followups there would contaminate
    // the trajectories select() compares. Manual /verify stays available.
    if ((agent.session as { header?: { parentSession?: string } }).header?.parentSession) return
    const id = String(agent.id)
    if (this.agents.has(id)) return
    this.agents.set(id, agent)
    const scoped = agent.ctx as unknown as { on: (name: string, handler: (...args: any[]) => any, options?: { prepend?: boolean }) => (() => void) | void }
    const status = scoped.on('agent/status', payload => this.handleStatus(agent, payload))
    const preStep = scoped.on('agent/pre-step', (payload, next) => this.handleAutopilotPreStep(agent, payload, next), { prepend: true })
    this.agentListeners.set(id, () => {
      if (typeof status === 'function') status()
      if (typeof preStep === 'function') preStep()
    })
  }

  /** agent/disposed: revoke the status listener and scheduler state so stale
   *  callbacks cannot start verification for an agent that no longer exists. */
  private detach(agent: { id?: string } | undefined): void {
    const id = String(agent?.id ?? '')
    if (!id) return
    const unsubscribe = this.agentListeners.get(id)
    if (unsubscribe) {
      unsubscribe()
      this.agentListeners.delete(id)
    }
    this.agents.delete(id)
    for (const selectionId of this.autopilotActive.get(id) ?? []) this.selections.cancel(selectionId)
    this.autopilotActive.delete(id)
    void this.cleanupAutopilotWinners(id)
    this.coordinator.forgetSession(id)
  }

  /** Fully synchronous: a status callback can never float a promise, so a
   *  trace/provider failure cannot become an unhandled rejection. */
  private handleStatus(agent: Agent, payload: { status?: string } | undefined): void {
    if (payload?.status !== 'idle') return
    const id = String(agent.id)
    if (this.agents.get(id) !== agent) return
    void this.cleanupAutopilotWinners(id)
    if (this.disposed || !this.config.enabled) return
    const bounds = turnBounds(agent.session.events)
    if (!bounds || typeof bounds.end.seq !== 'number') return
    this.coordinator.scheduleAuto(id, agent, bounds)
  }

  /** Coordinator seam: every run gets an abort signal plus an immutable config
   *  snapshot; configuration updates mid-flight affect only future runs. */
  private executeEntry(entry: ScheduleEntry<Agent>, runContext: RunContext): Promise<RecordState | undefined> {
    const snapshot = Object.freeze({ ...this.config }) as Config
    return this.verifyAgent(entry.agent, entry.bounds, {
      force: entry.kind === 'manual',
      config: snapshot,
      signal: runContext.signal,
    }).catch(() => undefined)
  }

  private async verifyAgent(
    agent: Agent,
    bounds: { start: EventRecord; end: EventRecord; turn: number },
    options: { force?: boolean; config: Readonly<Config>; signal: AbortSignal },
  ): Promise<RecordState> {
    const sessionId = String(agent.id)
    const record: RecordState = { id: crypto.randomUUID(), sessionId, turn: bounds.turn, turnEndSeq: bounds.end.seq ?? -1, status: 'running', startedAt: Date.now(), feedbackSent: false }
    this.records.unshift(record)
    this.records.splice(HISTORY_LIMIT)
    this.emit()
    const config = options.config
    try {
      // Trace building and gating live inside the same containment boundary as
      // the provider call: a crash here yields a failed record instead of a
      // permanently 'running' record and an unhandled rejection.
      const { problem, hasCurrentDirectTask, hasAnyDirectTask, trace, stats, visibleEvidenceIds, verdictLineIds, evidenceKinds } = traceFor(agent.session.events, bounds)
      record.traceStats = stats
      // No-op gate: bare status continuations with zero tool evidence are recorded
      // as 'skipped' (kept observable) but never scored, so they cannot consume
      // the session's feedback quota. Task-less sessions are skipped regardless of
      // force — a run without a task cannot name what it verifies. Manual POST
      // /verify passes force and bypasses the other skips.
      const gate = turnGateDecision({ problem, hasCurrentDirectTask, toolEventCount: stats.toolEventCount, hasAnyDirectTask }, { force: options.force, skipEnabled: config.skipStatusContinuation })
      if (!gate.verify) {
        record.status = 'skipped'
        record.skippedReason = gate.skipReason
        record.finishedAt = Date.now()
        this.persist(record)
        this.emit()
        return record
      }
      const prompt = buildVerifierPrompt(problem, trace, 'Did the agent actually complete the requested task correctly, with sufficient evidence from tools or tests?')
      const aggregate = await verifyFive(config, this.ctx.credentials, prompt, { signal: options.signal })
      record.aggregate = aggregate
      const kindsById = new Map<number, string>(Object.entries(evidenceKinds).map(([id, kind]) => [Number(id), String(kind)]))
      record.citationAudit = auditAggregateCitations(aggregate, visibleEvidenceIds, verdictLineIds, kindsById)
      record.finishedAt = Date.now()
      record.status = aggregate.valid.length === 0 ? 'failed' : aggregate.valid.length < Math.min(3, config.routes) ? 'partial' : 'completed'
      const feedbackDecision = decideFeedback(aggregate, config)
      if (config.autoFeedback && feedbackDecision.guarded) {
        record.suppressedFeedback = { median: aggregate.median ?? 0, noDefectLanes: noDefectLaneCount(aggregate), validLanes: aggregate.valid.length }
      }
      // Feedback is useful only when it points at independently observed
      // execution evidence. Model-only findings and uncited disagreement stay
      // in the record without interrupting the source task.
      const citationAudit = record.citationAudit
      const independentFindings = Math.max(0, (citationAudit?.defectFindings ?? 0) - (citationAudit?.findingsWithoutIndependentCitation ?? 0))
      const hasIndependentDefectEvidence = independentFindings > 0
      if (config.autoFeedback && feedbackDecision.feedback && !hasIndependentDefectEvidence) {
        record.feedbackSuppressed = { reason: 'no-independent-evidence', defectFindings: citationAudit?.defectFindings ?? 0, independentFindings }
      }
      if (config.autoFeedback && feedbackDecision.feedback && hasIndependentDefectEvidence) {
        const count = feedbackSentCount(agent.session.events)
        if (count < config.maxFeedbackPerSession) {
          if (options.signal.aborted || this.disposed || (this.agents.get(sessionId) !== agent && !this.ctx.agents?.get(sessionId))) {
            record.feedbackError = 'run-aborted-before-feedback'
          } else {
            const summary = aggregate.score === null ? '评分不可用' : '平均完成度 ' + aggregate.score.toFixed(2) + ', 分歧 ' + (aggregate.dispersion ?? 0).toFixed(2)
            const findings = aggregate.valid
              .filter(item => item.finding && !/no concrete defect/i.test(item.finding) && auditFindingCitation(item.findingFull ?? item.finding, visibleEvidenceIds, verdictLineIds, kindsById).independentCitation)
              .map(item => 'lane ' + item.route + '/' + (item.lane ?? 'unknown') + ': ' + String(item.finding).slice(0, 260))
              .slice(0, 3)
            const feedback = '[Verifier feedback] ' + summary + '。有工具证据支持的具体问题：' + findings.join('；') + '。仅在复查工具结果后确认问题才修复；否则继续完成原始任务并交付，不要为了提高审查分数修改代码。'
            try {
              // Structured producer identity (kind=plugin + form=notice) makes the
              // feedback recognizable without its text prefix; task attribution
              // excludes plugin sources structurally.
              await awaitFollowupWithFence(Promise.resolve(agent.followup(createUserMessage({
                source: { kind: 'plugin', plugin: PLUGIN_SOURCE_NAME, form: 'notice', summary: boundContextSummary('验证反馈：' + summary) },
                content: [{ type: 'text', text: feedback }],
              }))), options.signal, this.feedbackTimeoutMs)
              if (options.signal.aborted || this.disposed) record.feedbackError = 'run-aborted-during-feedback'
              else record.feedbackSent = true
            } catch (error) {
              record.feedbackError = error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240)
            }
          }
        }
      }
    } catch (error) {
      record.status = 'failed'
      record.finishedAt = Date.now()
      record.error = error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240)
    }
    this.persist(record)
    this.emit()
    return record
  }

  async verifySession(sessionId: string): Promise<RecordState | undefined> {
    const agent = this.agents.get(sessionId) ?? this.ctx.agents?.get(sessionId)
    if (!agent) return undefined
    const bounds = turnBounds(agent.session.events)
    if (!bounds || typeof bounds.end.seq !== 'number') return undefined
    // Manual verification joins the same per-session queue as automatic idles:
    // force bypasses the no-op gate, never the mutual exclusion, and resolves
    // with the record created by its own run.
    const outcome = await this.coordinator.scheduleManual(sessionId, agent, bounds)
    if (outcome.status === 'aborted') throw new VerifyAbortedError()
    if (outcome.status === 'failed') {
      throw outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error))
    }
    return outcome.value
  }

  snapshot(): Record<string, unknown> {
    return { config: cleanConfig(this.config), agents: this.agents.size, records: this.records.slice(0, 20), selection: this.selections.snapshot() }
  }

  private loadHistory(): void {
    if (!this.recordsFile) return
    const loaded = loadPersistedRecords(this.recordsFile)
    if (loaded.length > 0) this.records.unshift(...loaded)
    this.records.splice(HISTORY_LIMIT)
  }

  private persist(record: RecordState): void {
    if (!this.recordsFile) return
    try {
      mkdirSync(path.dirname(this.recordsFile), { recursive: true })
      appendFileSync(this.recordsFile, JSON.stringify(record) + '\n')
    } catch { /* observability must never break verification */ }
  }

  /** Newest-first history view with optional filters for the /records endpoint. */
  queryRecords(filter: { sessionId?: string; status?: string; turn?: number } = {}): RecordState[] {
    return this.records.filter(record =>
      (filter.sessionId === undefined || record.sessionId === filter.sessionId) &&
      (filter.status === undefined || record.status === filter.status) &&
      (filter.turn === undefined || record.turn === filter.turn))
  }
}

/** Fixed-window quota for provider-spending endpoints (Phase 1 egress policy):
 *  local callers get bounded /eval, /probe, and manual /verify spend per minute
 *  instead of an unthrottled lever on the external provider. */
export const API_RATE_LIMITS = { evalPerMinute: 120, probePerMinute: 60, verifyPerMinute: 60, selectPerHour: 12 }

/** Sliding-window limiter on a stamp log: no fixed-window boundary burst
 *  (2x-at-the-edge is impossible in ANY window of windowMs). acquire() =
 *  peek+commit in one step; /select splits them so admissions rejected by the
 *  host (busy, bad route, missing key) never burn provider-spend quota. */
export interface RateLimiter { (): boolean; peek(): boolean; commit(): void }
/** Exported for regression tests; the clock is injectable for deterministic windows. */
export function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now): RateLimiter {
  const stamps: number[] = []
  const prune = (t: number) => { while (stamps.length > 0 && t - stamps[0] >= windowMs) stamps.shift() }
  const peek = () => { prune(now()); return stamps.length < limit }
  const commit = () => { stamps.push(now()) }
  return Object.assign(function acquire() { if (!peek()) return false; commit(); return true }, { peek, commit })
}

/** Exported for regression tests: builds the Host API routes for this host. */
export function apiRoutes(host: VerifierHost): WebRoute[] {
  const evalLimiter = createRateLimiter(API_RATE_LIMITS.evalPerMinute, 60_000)
  const probeLimiter = createRateLimiter(API_RATE_LIMITS.probePerMinute, 60_000)
  const verifyLimiter = createRateLimiter(API_RATE_LIMITS.verifyPerMinute, 60_000)
  // Optional local API token (Phase 2 trust boundary): set DSH_VA_API_TOKEN to
  // require `authorization: Bearer <token>` on mutating / provider-spending
  // endpoints. Read-only views stay open to the local operator.
  const requiredToken = process.env.DSH_VA_API_TOKEN || ''
  const authorized = (req: { headers?: Record<string, unknown> }): boolean => !requiredToken || req?.headers?.authorization === 'Bearer ' + requiredToken
  const state: WebRoute = { kind: 'exact', path: API_PREFIX + '/state', handler: (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
    json(res, 200, host.snapshot())
  } }
  const config: WebRoute = { kind: 'exact', path: API_PREFIX + '/config', handler: async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
    if (!authorized(req)) return json(res, 403, { ok: false, error: 'unauthorized' })
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return json(res, 415, { ok: false, error: 'json-required' })
    try { host.setConfig(await readJson(req)); json(res, 200, { ok: true, config: host.getConfig() }) } catch (error) { json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }) }
  } }
  const verify: WebRoute = { kind: 'exact', path: API_PREFIX + '/verify', handler: async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
    if (!authorized(req)) return json(res, 403, { ok: false, error: 'unauthorized' })
    let body: Record<string, unknown>
    try {
      body = await readJson(req) as Record<string, unknown>
    } catch {
      return json(res, 400, { ok: false, error: 'invalid-json-body' })
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { ok: false, error: 'json-object-required' })
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (!sessionId) return json(res, 400, { ok: false, error: 'session-id-required' })
    if (!verifyLimiter()) return json(res, 429, { ok: false, error: 'rate-limited' })
    try {
      const record = await host.verifySession(sessionId)
      if (!record) return json(res, 404, { ok: false, error: 'session-not-found-or-no-completed-turn' })
      json(res, 200, { ok: true, record })
    } catch (error) {
      if (error instanceof VerifyAbortedError) return json(res, 503, { ok: false, error: 'verification-aborted' })
      json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  } }
  const evalRoute: WebRoute = { kind: 'exact', path: API_PREFIX + '/eval', handler: async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
    if (!authorized(req)) return json(res, 403, { ok: false, error: 'unauthorized' })
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return json(res, 415, { ok: false, error: 'json-required' })
    let body: Record<string, unknown>
    try {
      body = await readJson(req) as Record<string, unknown>
    } catch {
      return json(res, 400, { ok: false, error: 'invalid-json-body' })
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { ok: false, error: 'json-object-required' })
    try {
      const problem = typeof body.problem === 'string' ? body.problem.slice(0, 8000) : ''
      const trace = typeof body.trace === 'string' ? body.trace.slice(0, 60000) : ''
      if (!trace.trim()) return json(res, 400, { ok: false, error: 'trace-required' })
      if (!evalLimiter()) return json(res, 429, { ok: false, error: 'rate-limited' })
      const criterion = typeof body.criterion === 'string' && body.criterion.trim() ? body.criterion.slice(0, 2000)
        : 'Did the agent actually complete the requested task correctly, with sufficient evidence from tools or tests?'
      const prompt = buildVerifierPrompt(problem, trace, criterion)
      const routeOverride = typeof body.routes === 'number' ? { routes: Math.max(1, Math.min(5, Math.floor(body.routes))) } : {}
      if (typeof body.allowLabelFallback === 'boolean') (routeOverride as Record<string, unknown>).allowLabelFallback = body.allowLabelFallback
      const aggregate = await verifyFive({ ...host.getConfig(), ...routeOverride }, host.getCredentials(), prompt)
      json(res, 200, { ok: true, aggregate })
    } catch (error) { json(res, 500, { ok: false, error: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240) }) }
  } }
  const recordsRoute: WebRoute = { kind: 'exact', path: API_PREFIX + '/records', handler: (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
    const url = new URL(req.url ?? '/', 'http://local')
    const sessionId = url.searchParams.get('sessionId') ?? undefined
    const status = url.searchParams.get('status') ?? undefined
    const turnParam = url.searchParams.get('turn')?.trim()
    const turn = turnParam ? (Number.isFinite(Number(turnParam)) ? Number(turnParam) : undefined) : undefined
    const limitText = url.searchParams.get('limit')?.trim()
    const limitParam = limitText ? Number(limitText) : 50
    const limit = Math.max(1, Math.min(HISTORY_LIMIT, Number.isFinite(limitParam) ? Math.floor(limitParam) : 50))
    const filtered = host.queryRecords({ sessionId, status, turn })
    json(res, 200, { total: filtered.length, limit, records: filtered.slice(0, limit) })
  } }
  const probe: WebRoute = { kind: 'exact', path: API_PREFIX + '/probe', handler: async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
    if (!authorized(req)) return json(res, 403, { ok: false, error: 'unauthorized' })
    let body: Record<string, unknown>
    try {
      body = await readJson(req) as Record<string, unknown>
    } catch {
      // Malformed input must not silently become an empty-body probe.
      return json(res, 400, { ok: false, error: 'invalid-json-body' })
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { ok: false, error: 'json-object-required' })
    if (!probeLimiter()) return json(res, 429, { ok: false, error: 'rate-limited' })
    try {
      const config = host.getConfig()
      const key = await resolveKey(host.getCredentials(), config.apiKeyEnv)
      if (!key) return json(res, 200, { ok: false, error: 'no-key' })
      const target = normalizeBaseUrl(config.baseURL)
      if (!/^https?:\/\//i.test(target)) {
        return json(res, 200, { ok: false, transportOk: false, httpStatus: null, errorCode: 'invalid_base_url', error: 'verifier baseURL must be an http(s) URL', model: config.model })
      }
      if (body.listModels) {
        const listResponse = await fetch(target + '/models', {
          headers: { authorization: 'Bearer ' + key },
          signal: AbortSignal.timeout(30000),
        })
        const listBody = await listResponse.json().catch(() => ({}) as any)
        const ids = Array.isArray(listBody?.data) ? listBody.data.map((m: any) => String(m?.id ?? m)).slice(0, 50) : []
        // Upstream health maps straight into ok: a non-2xx listing is NOT a ready provider.
        return json(res, 200, {
          ok: listResponse.ok,
          transportOk: listResponse.ok,
          status: listResponse.status,
          models: ids,
          apiError: listResponse.ok ? undefined : String(listBody?.error?.message ?? 'HTTP ' + listResponse.status).slice(0, 240),
        })
      }
      // Ride the production lane path end-to-end: same prompt shape, parser,
      // redaction, retry taxonomy, and abort handling as a real verification.
      const nl = String.fromCharCode(10)
      const problem = ['Reply with exactly three lines and nothing else:', 'finding: probe', '<score_A> K </score_A>', '<score_B> M </score_B>'].join(nl)
      const prompt = buildVerifierPrompt(problem, '[EXTRACTED TOOL EVIDENCE] none' + nl + 'PROBE TRACE: no trajectory; this request only checks protocol readiness.', 'Probe criterion: follow the output protocol exactly.')
      const result = await verifyRoute(config, host.getCredentials(), prompt, 1)
      const hasScoreTags = Boolean(result.scoreALabel && result.scoreBLabel)
      const scoreTokenLogprobs = result.ok && result.scoreSource === 'logprobs'
      json(res, 200, {
        ok: true,
        transportOk: typeof result.httpStatus === 'number' ? result.httpStatus > 0 && result.httpStatus < 400 : false,
        httpStatus: result.httpStatus ?? null,
        finish: result.finishReason ?? null,
        hasScoreTags,
        scoreTokenLogprobs,
        scoreSource: result.scoreSource ?? null,
        reasoningSource: result.reasoningSource ?? null,
        lane: result.lane ?? null,
        errorCode: result.errorCode ?? null,
        error: result.error ?? null,
        retried: result.retried ?? false,
        durationMs: result.durationMs,
        strictReady: result.ok === true && result.scoreSource === 'logprobs',
        model: config.model,
      })
    } catch (error) { json(res, 500, { ok: false, error: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240) }) }
  } }
  const events: WebRoute = { kind: 'exact', path: API_PREFIX + '/events', handler: (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
    let closed = false
    const push = (): void => { try { res.write('data: ' + JSON.stringify(host.snapshot()) + '\n\n') } catch { /* a dead connection must not break the Host */ } }
    const unsubscribe = host.subscribe(push)
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n') } catch { /* ignored */ } }, 15000)
    const close = (): void => { if (closed) return; closed = true; clearInterval(heartbeat); unsubscribe() }
    req.once('close', close); res.once('close', close); push()
  } }
  // --- best-of-N manual API. Autopilot reaches the same SelectionHost from
  // pre-step; this route remains the explicit diagnostic/operator entry.
  // /select spawns N real child agents and never synthesizes a source verdict.
  const selectLimiter = createRateLimiter(API_RATE_LIMITS.selectPerHour, 3_600_000)
  const selectRoute: WebRoute = { kind: 'exact', path: API_PREFIX + '/select', handler: async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
    if (!authorized(req)) return json(res, 403, { ok: false, error: 'unauthorized' })
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return json(res, 415, { ok: false, error: 'json-required' })
    let body: Record<string, unknown>
    try {
      body = await readJson(req) as Record<string, unknown>
    } catch {
      return json(res, 400, { ok: false, error: 'invalid-json-body' })
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { ok: false, error: 'json-object-required' })
    // Peek before admission, commit only after the host actually accepted the
    // run: a busy or invalid /select spawns zero candidates and must not spend
    // one of the 12/hour provider-spend slots.
    if (!selectLimiter.peek()) return json(res, 429, { ok: false, error: 'rate-limited' })
    try {
      const selection = await host.selections.start(body)
      selectLimiter.commit()
      json(res, 202, { ok: true, selection })
    } catch (error) {
      if (error instanceof SelectionApiError) return json(res, error.status, { ok: false, error: error.code, message: error.message })
      json(res, 500, { ok: false, error: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240) })
    }
  } }
  const selectionsRoute: WebRoute = { kind: 'exact', path: API_PREFIX + '/selections', handler: (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
    const url = new URL(req.url ?? '/', 'http://local')
    const selectionId = url.searchParams.get('selectionId') ?? undefined
    if (selectionId) {
      const selection = host.selections.getSelection(selectionId)
      if (!selection) return json(res, 404, { ok: false, error: 'selection-not-found' })
      return json(res, 200, { ok: true, selection })
    }
    json(res, 200, { ok: true, active: host.selections.activeSelectionId(), retainedWinners: host.selections.snapshot().retainedWinners, selections: host.selections.listSelections().slice(0, 20) })
  } }
  const cancelSelectionRoute: WebRoute = { kind: 'exact', path: API_PREFIX + '/selections/cancel', handler: async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
    if (!authorized(req)) return json(res, 403, { ok: false, error: 'unauthorized' })
    let body: Record<string, unknown>
    try {
      body = await readJson(req) as Record<string, unknown>
    } catch {
      return json(res, 400, { ok: false, error: 'invalid-json-body' })
    }
    const selectionId = typeof body.selectionId === 'string' ? body.selectionId.trim() : ''
    if (!selectionId) return json(res, 400, { ok: false, error: 'selection-id-required' })
    if (!host.selections.cancel(selectionId)) return json(res, 404, { ok: false, error: 'selection-not-active' })
    json(res, 200, { ok: true })
  } }
  const releaseWinnerRoute: WebRoute = { kind: 'exact', path: API_PREFIX + '/selections/release', handler: async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
    if (!authorized(req)) return json(res, 403, { ok: false, error: 'unauthorized' })
    let body: Record<string, unknown>
    try {
      body = await readJson(req) as Record<string, unknown>
    } catch {
      return json(res, 400, { ok: false, error: 'invalid-json-body' })
    }
    const selectionId = typeof body.selectionId === 'string' ? body.selectionId.trim() : ''
    if (!selectionId) return json(res, 400, { ok: false, error: 'selection-id-required' })
    const selection = host.selections.getSelection(selectionId)
    if (!selection || !selection.winner) return json(res, 404, { ok: false, error: 'selection-or-winner-not-found' })
    // Manual winners release at settlement; autopilot winners release when the
    // source turn settles. The route stays idempotent for stale GUI panels.
    const released = await host.selections.releaseWinner(selectionId)
    json(res, 200, { ok: true, state: released })
  } }
  const discardWinnerRoute: WebRoute = { kind: 'exact', path: API_PREFIX + '/selections/discard', handler: async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
    if (!authorized(req)) return json(res, 403, { ok: false, error: 'unauthorized' })
    let body: Record<string, unknown>
    try {
      body = await readJson(req) as Record<string, unknown>
    } catch {
      return json(res, 400, { ok: false, error: 'invalid-json-body' })
    }
    const selectionId = typeof body.selectionId === 'string' ? body.selectionId.trim() : ''
    if (!selectionId) return json(res, 400, { ok: false, error: 'selection-id-required' })
    if (!(await host.selections.discardWinner(selectionId))) return json(res, 404, { ok: false, error: 'no-discardable-winner' })
    json(res, 200, { ok: true })
  } }
  return [state, config, verify, recordsRoute, evalRoute, probe, events, selectRoute, selectionsRoute, cancelSelectionRoute, releaseWinnerRoute, discardWinnerRoute]
}

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
