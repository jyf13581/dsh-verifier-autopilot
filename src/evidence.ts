/** Deterministic extraction, compaction, turn classification, and citation audit.
 *
 * This is pure evidence logic: it has no Host lifecycle, persistence, or HTTP
 * dependency and can therefore be exercised independently.
 */

import { PLUGIN_NAME } from './constants.js'
import type { AggregateResult } from './verifier.js'

export type EventRecord = { type: string; seq?: number; time?: number; data?: any }

export function flatten(value: unknown): string {
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
export const PLUGIN_SOURCE_NAME = PLUGIN_NAME
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

export function turnBounds(events: readonly EventRecord[]): { start: EventRecord; end: EventRecord; turn: number } | undefined {
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
