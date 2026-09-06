/**
 * Render one candidate session's durable events into verifier-ready trajectory
 * text. Stands alone from the legacy single-trace verifier rendering: this one
 * covers the whole candidate rollout (optionally starting after a seed prefix)
 * and renders tool evidence with the [E*] line ids a finding can cite.
 */

export interface TrajectoryEvent {
  type: string
  seq?: number
  time?: number
  data?: Record<string, unknown>
}

export interface TrajectoryRender {
  text: string
  eventCount: number
  renderedLines: number
  toolCalls: number
  truncatedCells: number
  totalChars: number
}

const DEFAULT_CELL_CAP = 2000
const DEFAULT_TOTAL_CAP = 24000

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
  let included = 0
  for (const ev of events) {
    if (typeof ev.seq === 'number' && ev.seq < fromSeq) continue
    included += 1
    const push = (line: string) => {
      cursor += 1
      lines.push('[E' + String(cursor).padStart(2, '0') + '] ' + line)
    }
    const data = (ev.data ?? {}) as Record<string, unknown>
    if (ev.type === 'user/message') {
      const src = (data.source ?? {}) as Record<string, unknown>
      const text = asText(data.content ?? data.message)
      if (!text.trim()) continue
      if (src.kind && src.kind !== 'user') {
        push('NOTICE(' + String(src.kind) + '): ' + summarize(text, 400).text)
      } else {
        push('USER: ' + summarize(text, cellCap).text)
      }
      continue
    }
    if (ev.type === 'assistant/message') {
      const text = asText((data.message as Record<string, unknown> | undefined)?.content)
      if (text.trim()) push('ASSISTANT: ' + summarize(text, cellCap).text)
      continue
    }
    if (ev.type === 'tool/call') {
      toolCalls += 1
      const s = summarize(data.arguments, cellCap)
      if (s.truncated) truncatedCells += 1
      push('TOOL CALL ' + String(data.name ?? 'unknown') + ': ' + s.text)
      continue
    }
    if (ev.type === 'tool/result') {
      const msg = data.message as Record<string, unknown> | undefined
      const content = msg?.content ?? data.content ?? data
      const s = summarize(content, cellCap)
      if (s.truncated) truncatedCells += 1
      push('TOOL RESULT: ' + s.text)
      continue
    }
  }
  let text = lines.join(String.fromCharCode(10))
  if (text.length > totalCap) {
    const keep = text.slice(text.length - totalCap)
    const firstNl = keep.indexOf(String.fromCharCode(10))
    text = '[... head truncated for budget: ' + (text.length - totalCap) + ' chars omitted ...]'
      + (firstNl >= 0 ? keep.slice(firstNl) : keep)
  }
  return {
    text,
    eventCount: included,
    renderedLines: lines.length,
    toolCalls,
    truncatedCells,
    totalChars: text.length,
  }
}
