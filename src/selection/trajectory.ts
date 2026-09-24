/**
 * Render one candidate session's durable events into verifier-ready trajectory
 * text. Stands alone from the legacy single-trace verifier rendering: this one
 * covers the whole candidate rollout (optionally starting after a seed prefix)
 * and renders tool evidence with the [E*] line ids a finding can cite.
 */

import { read, type EventRecord } from '../payload.js'

/** Same declared shape as the legacy verifier path: one session event whose
 *  payload is read tolerantly, never asserted. */
export type TrajectoryEvent = EventRecord

export interface TrajectoryRender {
  text: string
  eventCount: number
  renderedLines: number
  toolCalls: number
  /** Tool calls excluding catalog/meta discovery tools and read-only
   *  workspace observation (read/grep/ls…, review R2 2.4). The winner gate
   *  counts only execution evidence: a candidate whose toolCalls are all
   *  tool_search or read never changed or ran anything (ruling K.4-1). */
  execToolCalls: number
  truncatedCells: number
  totalChars: number
}

const DEFAULT_CELL_CAP = 2000
const DEFAULT_TOTAL_CAP = 24000

/** Shared head/tail bounding for candidate context and handoff evidence. Keeping
 * this with trajectory rendering prevents the candidate runner from depending
 * back on autopilot orchestration. */
export function boundText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.35)
  const tail = maxChars - head
  return text.slice(0, head) + '\n[... bounded ...]\n' + text.slice(-tail)
}

export function boundCandidateHandoff(text: string, maxChars = 14_000): string {
  return boundText(text.trim(), maxChars)
}

/** Orchestration section headers the Host itself writes into verifier payloads,
 *  candidate context, and the source relay. Candidate-controlled text (tool
 *  output, assistant prose, handoff excerpts) must never be able to open one of
 *  these sections: a forged `[DETERMINISTIC EVIDENCE ...]` block would claim
 *  runner-collected evidence to the verifier, and a forged `[END CANDIDATE c1]`
 *  followed by `[FINALIZER CONTRACT]` would issue instructions to the source
 *  finalizer (review R1 1.8). */
const CONTROL_MARKER = /\[(\s*)(DETERMINISTIC EVIDENCE|TRAJECTORY\b|END CANDIDATE|CANDIDATE\s+c\d|FINALIZER CONTRACT|AUTOPILOT\b|SINGLE-SURVIVOR|CURRENT TASK|RELEVANT RECENT CONVERSATION|DELIVERY CONTRACT|EXTRACTED TOOL EVIDENCE|VERIFIER FEEDBACK)/gi

/** Defang Host control markers inside untrusted text. The content survives
 *  verbatim for the reader, but it can no longer be mistaken for a section the
 *  Host opened. Idempotent: the rewritten form never matches again. */
export function neutralizeControlMarkers(text: string): string {
  return text.replace(CONTROL_MARKER, (_match, space: string, marker: string) => '[UNTRUSTED-QUOTE:' + (space || ' ') + marker)
}

/** Meta/navigation tools that never modify the workspace or execute anything.
 *  tool_call is a dispatcher: its inner name is not visible in the event we
 *  see, so it conservatively counts as meta (never as execution evidence). */
const META_TOOLS = new Set([
  'tool_search',
  'tool_describe',
  'tool_call',
  'tool_slimmer_catalog',
  'tool_slimmer_update_config',
  'list_agents',
])

export function isMetaToolName(name: unknown): boolean {
  return typeof name === 'string' && META_TOOLS.has(name)
}

/** Workspace-observing tools (review R2 2.4). Reading, listing or searching
 *  is not work: before this set, a candidate that only ran `read` passed the
 *  has-work gate of a code task with an empty diff. Allowlist on purpose —
 *  an unknown tool name still counts as execution (conservative: it may
 *  write), so a new mutating tool can never be silently excluded. DSH emits
 *  `read`/`write`/`edit`/`pwsh`/`bash`; the others are common aliases. */
const READ_ONLY_TOOLS = new Set([
  'read',
  'read_file',
  'view',
  'grep',
  'glob',
  'ls',
  'list_dir',
  'list_files',
  'search_files',
  'web_search',
  'web_fetch',
  'fetch_page',
])

export function isReadOnlyToolName(name: unknown): boolean {
  return typeof name === 'string' && READ_ONLY_TOOLS.has(name)
}

/** Counts toward the has-work gate: neither catalog/meta nor read-only. */
export function isExecutionToolName(name: unknown): boolean {
  return !isMetaToolName(name) && !isReadOnlyToolName(name)
}

function asText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text?: string } => !!b && typeof b === 'object' && (b as { type?: string }).type === 'text')
      .map((b) => b.text ?? '')
      .join('')
  }
  return ''
}

function summarize(value: unknown, cap: number): { text: string; truncated: boolean } {
  let raw: string
  try { raw = typeof value === 'string' ? value : JSON.stringify(value) ?? '' } catch { raw = String(value) }
  raw = raw.replace(/\s+/g, ' ').trim()
  if (raw.length <= cap) return { text: raw, truncated: false }
  return { text: raw.slice(0, cap) + ' [… +' + (raw.length - cap) + ' chars]', truncated: true }
}

/**
 * Render events with seq >= fromSeq. Line kinds: USER / ASSISTANT / TOOL CALL /
 * TOOL RESULT. Chunk, policy, inbox, and title events are runtime noise and
 * dropped; turn/step markers are folded into step boundaries.
 */
export function renderTrajectory(
  events: readonly TrajectoryEvent[],
  options: { fromSeq?: number; cellCap?: number; totalCap?: number } = {},
): TrajectoryRender {
  const fromSeq = options.fromSeq ?? -1
  const cellCap = options.cellCap ?? DEFAULT_CELL_CAP
  const totalCap = options.totalCap ?? DEFAULT_TOTAL_CAP
  const lines: string[] = []
  let cursor = 0
  let truncatedCells = 0
  let toolCalls = 0
  let execToolCalls = 0
  let included = 0
  for (const ev of events) {
    if (typeof ev.seq === 'number' && ev.seq < fromSeq) continue
    included += 1
    const push = (line: string) => {
      cursor += 1
      lines.push('[E' + String(cursor).padStart(2, '0') + '] ' + line)
    }
    const data: unknown = ev.data ?? {}
    if (ev.type === 'user/message') {
      const sourceKind = read(data, 'source', 'kind')
      const text = asText(read(data, 'content') ?? read(data, 'message'))
      if (!text.trim()) continue
      if (sourceKind && sourceKind !== 'user') {
        push('NOTICE(' + String(sourceKind) + '): ' + summarize(text, 400).text)
      } else {
        push('USER: ' + summarize(text, cellCap).text)
      }
      continue
    }
    if (ev.type === 'assistant/message') {
      const text = asText(read(data, 'message', 'content'))
      if (text.trim()) push('ASSISTANT: ' + summarize(text, cellCap).text)
      continue
    }
    if (ev.type === 'tool/call') {
      toolCalls += 1
      const name = read(data, 'name')
      if (isExecutionToolName(name)) execToolCalls += 1
      const s = summarize(read(data, 'arguments'), cellCap)
      if (s.truncated) truncatedCells += 1
      push('TOOL CALL ' + String(name ?? 'unknown') + ': ' + s.text)
      continue
    }
    if (ev.type === 'tool/result') {
      const content = read(data, 'message', 'content') ?? read(data, 'content') ?? data
      const s = summarize(content, cellCap)
      if (s.truncated) truncatedCells += 1
      push('TOOL RESULT: ' + s.text)
      continue
    }
  }
  const NL = String.fromCharCode(10)
  let text = neutralizeControlMarkers(lines.join(NL))
  if (text.length > totalCap) {
    // Pin the first USER line (review R2 2.7): tail-only truncation used to
    // drop the candidate's own task statement first, leaving the verifier a
    // trajectory of actions with no record of what they were answering. The
    // pin is bounded to a quarter of the budget; the tail keeps the rest.
    const firstUser = lines.findIndex((line) => /^\[E\d+\] USER: /.test(line))
    const pinCap = Math.floor(totalCap / 4)
    let pinned = firstUser >= 0 ? neutralizeControlMarkers(lines[firstUser]) : ''
    if (pinned.length > pinCap) pinned = pinned.slice(0, pinCap) + ' [... task line bounded ...]'
    const tailBudget = Math.max(0, totalCap - pinned.length)
    const keep = text.slice(text.length - tailBudget)
    const firstNl = keep.indexOf(NL)
    const tail = firstNl >= 0 ? keep.slice(firstNl) : keep
    const tag = pinned ? pinned.slice(0, pinned.indexOf(']') + 1) : ''
    if (!pinned || tail.includes(NL + tag + ' ')) pinned = ''
    const omitted = text.length - tail.length
    text = (pinned ? pinned + NL : '')
      + '[... head truncated for budget: ' + omitted + ' chars omitted' + (pinned ? '; first task line kept above' : '') + ' ...]'
      + tail
  }
  return {
    text,
    eventCount: included,
    renderedLines: lines.length,
    toolCalls,
    execToolCalls,
    truncatedCells,
    totalChars: text.length,
  }
}
