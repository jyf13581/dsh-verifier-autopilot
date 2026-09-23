/** Bounded, secret-free operator diagnostics.
 *
 * Most failure paths in this plugin are deliberately best-effort: cleanup,
 * persistence, notices, relays, and sampling must never take a selection or a
 * verification down with them. Until now those paths were also silent — a
 * worktree that would not prune, a ledger that would not append, a relay that
 * never reached the source session, or a sidecar that kept dying was invisible
 * short of inspecting the file system. This module gives them one place to
 * land: a ring of recent degradation events plus monotonic counters, exposed
 * through the Host snapshot and pushed over the SSE channel.
 *
 * Rules:
 *  - helpers signal (return null / throw); the owner that decides to continue
 *    anyway is the one that records here;
 *  - every message is secret-redacted and bounded before it is stored;
 *  - consecutive repeats of one (scope, message, detail) coalesce into a single
 *    entry with a count, and one scope may occupy at most a fixed share of the
 *    ring, so a flapping failure cannot flush every other scope's history;
 *  - recording never throws and never re-enters the caller.
 *
 * Dependency-light by design: only `util.ts` (redaction) may be imported.
 */

import { redactSecrets } from './util.js'

export const DIAGNOSTICS_LIMIT = 200
/** No single scope may hold more than this share of the ring: a flapping
 *  sampler with a varying message must not evict every other scope's entries. */
export const DIAGNOSTICS_SCOPE_SHARE = 0.2
const MESSAGE_LIMIT = 240
const DETAIL_LIMIT = 160

export type DiagnosticDetail = Record<string, string | number | boolean | null | undefined>

export interface DiagnosticEntry {
  /** Most recent occurrence. */
  at: number
  /** First occurrence of this coalesced run. */
  firstAt: number
  /** Dotted owner.event name, e.g. `workspace.remove`, `sidecar.timeout`. */
  scope: string
  /** Redacted, bounded human-readable reason. */
  message: string
  /** Consecutive repeats folded into this entry (>= 1). */
  count: number
  /** Small structured context (ids, paths); string values are redacted. */
  detail?: Record<string, string | number | boolean>
}

export interface DiagnosticsSnapshot {
  /** Newest first, at most `limit` entries. */
  entries: DiagnosticEntry[]
  /** Monotonic counters since process start (or reset). */
  counters: Record<string, number>
  /** Entries evicted by the ring since start (or reset). */
  evicted: number
}

/** Message text for an arbitrary thrown value. Errors that carry a stable
 *  machine code (BridgeError-like) contribute it as a prefix so repeats
 *  coalesce on the code even when the free text carries request ids. */
export function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    const code = (cause as Error & { code?: unknown }).code
    const prefix = typeof code === 'string' && code && !cause.message.startsWith(code) ? code + ': ' : ''
    return prefix + (cause.message || cause.name)
  }
  if (typeof cause === 'string') return cause
  try { return JSON.stringify(cause) ?? String(cause) } catch { return String(cause) }
}

export class Diagnostics {
  private readonly entries: DiagnosticEntry[] = []
  private readonly counters = new Map<string, number>()
  private readonly listeners = new Set<() => void>()
  private readonly limit: number
  private readonly scopeLimit: number
  private readonly now: () => number
  private evicted = 0

  constructor(options: { limit?: number; now?: () => number } = {}) {
    this.limit = Math.max(1, Math.floor(options.limit ?? DIAGNOSTICS_LIMIT))
    this.scopeLimit = Math.max(1, Math.floor(this.limit * DIAGNOSTICS_SCOPE_SHARE))
    this.now = options.now ?? Date.now
  }

  /** Record a degradation the caller decided to survive. Never throws. */
  warn(scope: string, cause: unknown, detail?: DiagnosticDetail): void {
    try {
      const message = redactSecrets(describeCause(cause)).slice(0, MESSAGE_LIMIT)
      const cleanDetail = this.cleanDetail(detail)
      const at = this.now()
      const newest = this.entries[0]
      if (newest && newest.scope === scope && newest.message === message && sameDetail(newest.detail, cleanDetail)) {
        newest.count += 1
        newest.at = at
      } else {
        this.entries.unshift({ at, firstAt: at, scope, message, count: 1, ...(cleanDetail ? { detail: cleanDetail } : {}) })
        this.enforceScopeShare(scope)
        if (this.entries.length > this.limit) {
          this.evicted += this.entries.length - this.limit
          this.entries.length = this.limit
        }
      }
    } catch {
      return
    }
    this.notify()
  }

  /** Bump a monotonic counter. Counters never notify subscribers: they are
   *  safe to call from inside snapshot/emit paths. */
  count(counter: string, by = 1): void {
    if (!Number.isFinite(by)) return
    this.counters.set(counter, (this.counters.get(counter) ?? 0) + by)
  }

  snapshot(): DiagnosticsSnapshot {
    return {
      entries: this.entries.map(entry => ({ ...entry, ...(entry.detail ? { detail: { ...entry.detail } } : {}) })),
      counters: Object.fromEntries([...this.counters.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      evicted: this.evicted,
    }
  }

  /** Notified after every recorded warning (not after counters). Listener
   *  exceptions are isolated and never surface back through `warn`. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  reset(): void {
    this.entries.length = 0
    this.counters.clear()
    this.evicted = 0
  }

  private cleanDetail(detail?: DiagnosticDetail): Record<string, string | number | boolean> | undefined {
    if (!detail) return undefined
    const out: Record<string, string | number | boolean> = {}
    for (const [key, value] of Object.entries(detail)) {
      if (value === null || value === undefined) continue
      out[key] = typeof value === 'string' ? redactSecrets(value).slice(0, DETAIL_LIMIT) : value
    }
    return Object.keys(out).length > 0 ? out : undefined
  }

  /** Evict the oldest entry of `scope` once the scope exceeds its share, so
   *  the newest text of a noisy scope stays visible while every other scope
   *  keeps its history. */
  private enforceScopeShare(scope: string): void {
    let held = 0
    let oldest = -1
    for (let index = 0; index < this.entries.length; index += 1) {
      if (this.entries[index].scope !== scope) continue
      held += 1
      oldest = index
    }
    if (held <= this.scopeLimit || oldest < 0) return
    this.entries.splice(oldest, 1)
    this.evicted += 1
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try { listener() } catch { /* a broken observer must not break the recorder */ }
    }
  }
}

function sameDetail(a?: Record<string, string | number | boolean>, b?: Record<string, string | number | boolean>): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every(key => a[key] === b[key])
}

/** Process-wide default. Hosts accept an injected instance for isolation
 *  (tests, embedded use); production composition uses this one. */
export const diagnostics = new Diagnostics()
