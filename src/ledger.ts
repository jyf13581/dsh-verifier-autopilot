/** Versioned JSONL persistence shared by verifier and selection histories.
 *
 * Rows are written oldest-to-newest with a top-level `v` stamp. Readers accept
 * legacy unstamped rows, reject unknown future versions, skip torn lines, and
 * return newest-first records. Compaction uses a same-directory temporary file
 * plus rename so a reload can observe either the old ledger or the complete new
 * ledger, never a partially rewritten file.
 *
 * Durability (review R5 5.3): every append is fdatasync'd and every atomic
 * replace fsyncs the new bytes before the rename (and the directory after it,
 * where the platform allows), so a power loss can lose at most the row being
 * written, never an acknowledged one, and a compaction can never leave an
 * empty ledger behind. A torn final row from such a crash is skipped on load
 * and never swallows the next append. Rows stamped with a newer ledger
 * version are not interpreted, but compaction carries them over verbatim so
 * running an older build cannot erase a newer build's history.
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync, fdatasyncSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readSync, renameSync, rmSync, statSync, writeSync,
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

/** writeSync may write fewer bytes than asked; loop until all are on disk. */
function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text, 'utf8')
  let offset = 0
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
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
  const fd = openSync(file, 'a+')
  try {
    // A crash mid-append leaves a final row without its newline; appending
    // straight after it glued the next, intact row onto the torn one and both
    // were skipped on load. Start on a fresh line instead.
    let prefix = ''
    const size = fstatSync(fd).size
    if (size > 0) {
      const last = Buffer.alloc(1)
      readSync(fd, last, 0, 1, size - 1)
      if (last[0] !== 10) prefix = String.fromCharCode(10)
    }
    writeAll(fd, prefix + encodeRecord(record) + String.fromCharCode(10))
    fdatasyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Make a completed rename durable. Directories cannot be opened for fsync on
 *  Windows (and some filesystems refuse); the file's own fsync already
 *  happened, so this is best effort. */
function syncDirectory(dir: string): void {
  if (process.platform === 'win32') return
  let fd: number | undefined
  try { fd = openSync(dir, 'r'); fsyncSync(fd) } catch { /* best effort */ } finally { if (fd !== undefined) try { closeSync(fd) } catch { /* ignore */ } }
}

/** Write bytes through a unique sibling and atomically replace the destination. */
export function atomicWriteFile(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp'
  try {
    const fd = openSync(temporary, 'w')
    try {
      writeAll(fd, content)
      // Without this a crash shortly after the rename can surface the new
      // name with no data: for a compaction that is the whole ledger.
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, file)
    syncDirectory(path.dirname(file))
  } catch (error) {
    try { rmSync(temporary, { force: true }) } catch { /* best effort */ }
    throw error
  }
}

/** Upper bound on newer-version rows a compaction carries over, so they can
 *  never keep the file above the compaction threshold by themselves. */
const FOREIGN_ROWS_MAX_BYTES = 1024 * 1024

/** Rows written by a newer build (`v` above ours), verbatim and in file
 *  order, newest kept when over budget. */
function foreignRows(file: string): string[] {
  let raw: string
  try { raw = readFileSync(file, 'utf8') } catch { return [] }
  const rows: string[] = []
  for (const line of raw.split(String.fromCharCode(10))) {
    const text = line.trim()
    if (!text) continue
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const version = (parsed as Record<string, unknown>).v
        if (typeof version === 'number' && version > LEDGER_VERSION) rows.push(text)
      }
    } catch { /* torn or corrupt: compaction drops it, as before */ }
  }
  let budget = FOREIGN_ROWS_MAX_BYTES
  const kept: string[] = []
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    budget -= rows[i].length + 1
    if (budget < 0) break
    kept.unshift(rows[i])
  }
  return kept
}

/** `records` must be newest-first, matching both in-memory hosts. Rows from a
 *  newer ledger version are preserved after them (review R5 5.3). */
export function compactJsonlLedger<T extends object>(file: string, records: readonly T[]): void {
  const lines = [...records].reverse().map(encodeRecord).concat(foreignRows(file))
  const content = lines.join(String.fromCharCode(10)) + (lines.length > 0 ? String.fromCharCode(10) : '')
  atomicWriteFile(file, content)
}

export function ledgerExceeds(file: string, maxBytes: number): boolean {
  try { return statSync(file).size > maxBytes } catch { return false }
}
