/** Versioned JSONL persistence shared by verifier and selection histories.
 *
 * Rows are written oldest-to-newest with a top-level `v` stamp. Readers accept
 * legacy unstamped rows, reject unknown future versions, skip torn lines, and
 * return newest-first records. Compaction uses a same-directory temporary file
 * plus rename so a reload can observe either the old ledger or the complete new
 * ledger, never a partially rewritten file.
 */

import { randomUUID } from 'node:crypto'
import {
  appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

export const LEDGER_VERSION = 1 as const

export interface LedgerReadOptions<T extends object> {
  limit: number
  validate(record: unknown): record is T
  idOf?: (record: T) => string
  normalize?: (record: T) => T
  /** Observes every skipped row (torn line, unparseable JSON, unknown ledger
   *  version, failed validation). The skip itself stays unconditional: the
   *  hook exists so callers can make the loss visible, not veto it. */
  onSkippedRow?: (line: number, error: unknown) => void
}

function encodeRecord<T extends object>(record: T): string {
  return JSON.stringify({ ...record, v: LEDGER_VERSION })
}

function decodeRecord<T extends object>(raw: unknown, validate: (record: unknown) => record is T): T | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const stamped = raw as Record<string, unknown>
  if (stamped.v !== undefined && stamped.v !== LEDGER_VERSION) return undefined
  const { v: _version, ...record } = stamped
  return validate(record) ? record : undefined
}

export function readJsonlLedger<T extends object>(file: string, options: LedgerReadOptions<T>): T[] {
  let raw: string
  try { raw = readFileSync(file, 'utf8') } catch { return [] }

  const records: T[] = []
  const byId = options.idOf ? new Map<string, T>() : undefined
  const skipped = (line: number, error: unknown): void => {
    try { options.onSkippedRow?.(line, error) } catch { /* an observer never breaks startup */ }
  }
  let lineNo = 0
  for (const line of raw.split(String.fromCharCode(10))) {
    lineNo += 1
    const text = line.trim()
    if (!text) continue
    try {
      const record = decodeRecord(JSON.parse(text), options.validate)
      if (!record) { skipped(lineNo, new Error('row rejected (unknown version or failed validation)')); continue }
      if (byId && options.idOf) byId.set(options.idOf(record), record)
      else records.push(record)
    } catch (error) { skipped(lineNo, error) /* a torn/corrupt row never breaks host startup */ }
  }

  const chronological = byId ? [...byId.values()] : records
  const newestFirst = chronological.reverse().slice(0, Math.max(0, options.limit))
  return options.normalize ? newestFirst.map(options.normalize) : newestFirst
}

export function appendJsonlLedger<T extends object>(file: string, record: T): void {
  mkdirSync(path.dirname(file), { recursive: true })
  appendFileSync(file, encodeRecord(record) + String.fromCharCode(10), 'utf8')
}

/** Write bytes through a unique sibling and atomically replace the destination. */
export function atomicWriteFile(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(temporary, content, 'utf8')
    renameSync(temporary, file)
  } catch (error) {
    try { rmSync(temporary, { force: true }) } catch { /* best effort */ }
    throw error
  }
}

/** `records` must be newest-first, matching both in-memory hosts. */
export function compactJsonlLedger<T extends object>(file: string, records: readonly T[]): void {
  const chronological = [...records].reverse()
  const content = chronological.map(encodeRecord).join(String.fromCharCode(10))
    + (chronological.length > 0 ? String.fromCharCode(10) : '')
  atomicWriteFile(file, content)
}

export function ledgerExceeds(file: string, maxBytes: number): boolean {
  try { return statSync(file).size > maxBytes } catch { return false }
}
