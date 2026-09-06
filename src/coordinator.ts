/**
 * Per-session verification scheduler.
 *
 * Legacy verifier scheduling boundary (HANDOFF.md §7.1): the mutual-exclusion semantics
 * of verification runs live here instead of inside the cordus-coupled
 * VerifierHost, so overlap, queueing, disposal, and stale-listener behavior can
 * be tested deterministically without a live DSH runtime or provider.
 *
 * Invariants (each pinned by a regression test):
 * - At most one run per session is active at any time; a run's completion is
 *   the only thing that starts the next queued entry.
 * - Pending automatic entries collapse to the newest turn ("latest wins");
 *   pending manual entries are never dropped and jump ahead of autos because a
 *   human is synchronously waiting on the response.
 * - A manual entry resolves with the outcome of its OWN run, never another
 *   session's or a newer queued run.
 * - Disposal aborts active controllers, settles every waiter as aborted, and
 *   refuses further scheduling; forgetting a session clears its dedupe marker
 *   and pending entries so stale callbacks cannot start anything new.
 */

export interface ScheduledEvent { type: string; seq?: number; time?: number; data?: any }

export type TurnBounds = { start: ScheduledEvent; end: ScheduledEvent; turn: number }

export type ScheduleKind = 'auto' | 'manual'

export interface ScheduleEntry<A> {
  readonly sessionId: string
  readonly agent: A
  readonly bounds: TurnBounds
  readonly kind: ScheduleKind
}

export interface RunContext {
  /** Aborted when the coordinator is disposed; the run must stop side effects. */
  readonly signal: AbortSignal
}

export type EntryOutcome<T> =
  | { status: 'completed'; value: T }
  | { status: 'aborted' }
  | { status: 'failed'; error: unknown }

export interface CoordinatorHooks<A, T> {
  /** Performs the actual verification for one entry. Implementations must
   *  settle every run into a terminal state; a rejection only means the entry
   *  produced no value. */
  run(entry: ScheduleEntry<A>, context: RunContext): Promise<T>
}

interface QueueItem<A, T> {
  entry: ScheduleEntry<A>
  settle: (outcome: EntryOutcome<T>) => void
}

interface SessionState<A, T> {
  active: { entry: ScheduleEntry<A>; controller: AbortController } | null
  pending: Array<QueueItem<A, T>>
  /** end.seq of the last accepted turn; dedupes repeated idle callbacks. */
  lastSeq?: number
}

export class VerificationCoordinator<A, T = unknown> {
  private readonly sessions = new Map<string, SessionState<A, T>>()
  private disposed = false

  constructor(private readonly hooks: CoordinatorHooks<A, T>) {}

  /** Automatic idle path. Returns false when the entry was refused (disposed
   *  host) or deduplicated (this completed turn was already seen). */
  scheduleAuto(sessionId: string, agent: A, bounds: TurnBounds): boolean {
    if (this.disposed) return false
    const session = this.sessionOf(sessionId)
    if (session.lastSeq === bounds.end.seq) return false
    session.lastSeq = bounds.end.seq
    // Latest automatic turn wins: older pending autos are dropped silently.
    session.pending = session.pending.filter(item => item.entry.kind !== 'auto')
    session.pending.push({ entry: { sessionId, agent, bounds, kind: 'auto' }, settle: () => undefined })
    this.pump(session, sessionId)
    return true
  }

  /** Manual path: joins the same per-session queue (mutual exclusion applies),
   *  never gets dropped by later arrivals, and resolves with its own run's
   *  outcome once that run actually executes. */
  scheduleManual(sessionId: string, agent: A, bounds: TurnBounds): Promise<EntryOutcome<T>> {
    if (this.disposed) return Promise.resolve({ status: 'aborted' })
    const session = this.sessionOf(sessionId)
    const endSeq = bounds.end.seq
    if (typeof endSeq === 'number') {
      session.lastSeq = session.lastSeq === undefined || session.lastSeq < endSeq ? endSeq : session.lastSeq
    }
    return new Promise<EntryOutcome<T>>(resolve => {
      // A human is blocked on this HTTP response: insert manuals before autos,
      // while preserving FIFO order among other manuals.
      const firstAuto = session.pending.findIndex(item => item.entry.kind === 'auto')
      const item = { entry: { sessionId, agent, bounds, kind: 'manual' as const }, settle: resolve }
      if (firstAuto === -1) session.pending.push(item)
      else session.pending.splice(firstAuto, 0, item)
      this.pump(session, sessionId)
    })
  }

  /** The agent went away: revoke scheduler state so stale status callbacks and
   *  queued turns cannot start anything new. An already-active run is left to
   *  reach its terminal record on its own. */
  forgetSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    for (const item of session.pending.splice(0)) item.settle({ status: 'aborted' })
    session.lastSeq = undefined
    if (session.active === null) this.sessions.delete(sessionId)
  }

  dispose(): void {
    this.disposed = true
    for (const session of this.sessions.values()) {
      session.active?.controller.abort()
      for (const item of session.pending.splice(0)) item.settle({ status: 'aborted' })
      session.lastSeq = undefined
      session.active = null
    }
    this.sessions.clear()
  }

  isActive(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.active != null
  }

  pendingCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.pending.length ?? 0
  }

  sessionCount(): number {
    return this.sessions.size
  }

  isDisposed(): boolean {
    return this.disposed
  }

  private sessionOf(sessionId: string): SessionState<A, T> {
    let session = this.sessions.get(sessionId)
    if (!session) {
      session = { active: null, pending: [] }
      this.sessions.set(sessionId, session)
    }
    return session
  }

  private pump(session: SessionState<A, T>, sessionId: string): void {
    this.cleanupIdleSession(sessionId, session)
    if (this.disposed || session.active !== null || session.pending.length === 0) return
    const next = session.pending.shift() as QueueItem<A, T>
    const controller = new AbortController()
    session.active = { entry: next.entry, controller }
    let promise: Promise<void>
    try {
      promise = this.hooks.run(next.entry, { signal: controller.signal }).then(
        value => next.settle({ status: 'completed', value }),
        error => next.settle({ status: 'failed', error }),
      )
    } catch (error) {
      // hooks.run must be async and never throw synchronously; contain it anyway.
      next.settle({ status: 'failed', error })
      session.active = null
      this.cleanupIdleSession(sessionId, session)
      return
    }
    void promise.finally(() => {
      session.active = null
      this.cleanupIdleSession(sessionId, session)
      this.pump(session, sessionId)
    })
  }

  private cleanupIdleSession(sessionId: string, session: SessionState<A, T>): void {
    if (session.active === null && session.pending.length === 0 && session.lastSeq === undefined && this.sessions.get(sessionId) === session) {
      this.sessions.delete(sessionId)
    }
  }
}
