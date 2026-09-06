/**
 * Candidate batch orchestrator (HANDOFF §2): N real agent rollouts in
 * isolated workspaces, objective-check elimination, verifier select(), and the
 * winner/loser lifecycle. Pure orchestration — the DSH runtime, the process
 * workspace manager, and the Python bridge are injected, so this module is
 * exercised offline with fakes and never depends on a live host here.
 *
 * Invariants:
 * - The runner returns the winner handle/workspace to the Host; every loser is
 *   disposed and removed. Manual/autopilot winner ownership differs (HANDOFF §2.5).
 * - Abort/dispose runs best-effort cleanup for every child, workspace, and
 *   bridge request; persisted historical roots are documented in HANDOFF §6.3.
 * - The winner index maps back to the ORIGINAL candidate index, not the
 *   survivor-subset index.
 */

import { randomUUID } from 'node:crypto'
import { rmdir } from 'node:fs/promises'
import path from 'node:path'
import { renderTrajectory, type TrajectoryEvent } from './trajectory.js'
import { runChecks, type CheckResult, type ObjectiveCheck } from './checks.js'
export type { CheckResult, ObjectiveCheck } from './checks.js'
import { BridgeError, type BridgeProgressRequest, type BridgeProgressResult, type BridgeSelectRequest, type BridgeSelectResult, type BridgeUsage } from './bridge.js'
import { boundCandidateHandoff } from './autopilot.js'
import { retryTransientBridge, type RetrySleep } from './retry.js'

export type CandidateStatus =
  | 'created' | 'running' | 'finished' | 'failed' | 'eliminated' | 'winner' | 'loser'

export interface CandidateRecord {
  index: number
  sessionId: string | null
  workspace: string
  status: CandidateStatus
  /** Effective route this candidate ran on (heterogeneous pools only). */
  agentOptions?: { provider?: string; model?: string }
  error?: string
  eventCount?: number
  toolCalls?: number
  trajectoryChars?: number
  checks?: CheckResult[]
  eliminatedBy?: string[]
  /** Online progress samples when progressGuard was active. */
  progress?: Array<{ at: number; score: number }>
}

export interface SelectionRecord {
  selectionId: string
  sourceSessionId: string | null
  startedAt: number
  finishedAt: number | null
  status: 'running' | 'completed' | 'failed' | 'aborted'
  error?: string
  trigger?: 'manual' | 'autopilot'
  stage?: 'workspace' | 'preflight' | 'rollout' | 'checks' | 'ranking' | 'settled'
  policy?: { depth: 'standard' | 'deep'; modelStrategy?: 'quality-first' | 'exploration'; candidateCount: number; nEvaluations: number; contextChars: number; models: string[]; pivots?: number; verifierEffort?: string }
  effectiveEvaluations?: number
  verificationPasses?: number
  candidates: CandidateRecord[]
  winner?: { index: number; sessionId: string | null; workspace: string; discardedAt?: number }
  finalists?: Array<{ index: number; score: number | null; model?: string; handoff: string }>
  /** Per ORIGINAL candidate index; null for candidates that never reached select(). */
  scores?: Array<number | null>
  /** Original candidate indices, best-first. */
  ranking?: number[]
  nComparisons?: number
  /** Number of verifier tournament attempts (1 normally, >1 after transient provider failures). */
  rankingAttempts?: number
  /** Sanitized transient failures that were retried before settlement. */
  rankingRetryErrors?: string[]
  /** Evidence basis for the crowned candidate; never infer verifier evidence from a shortcut. */
  winnerBasis?: 'verifier' | 'objective-check-only' | 'single-candidate'
  usage?: BridgeUsage
  verifierModel?: string
}

export interface SelectionAgentHandle {
  agent: {
    id: string
    session: { events: readonly TrajectoryEvent[] }
    followup(message: {
      id: string
      role: 'user'
      content: Array<{ type: 'text'; text: string }>
      source: { kind: 'user' }
    }): void | Promise<void>
    whenIdle(): Promise<void>
    cancel?: () => void
  }
  dispose(): Promise<void>
}

export interface CandidateSpec {
  sessionId: string
  cwd: string
  parentSession?: string
  seed?: readonly TrajectoryEvent[]
  seedLength?: number
  agentPreset?: string
  /** Per-candidate route override (already merged over shared defaults). */
  agentOptions?: { provider?: string; model?: string }
}

/** Online hopeless-rollout abandonment via the library's progress tracker
 *  (HANDOFF §2.3). Only active when progressGuard is provided AND the bridge
 *  implementation offers progress(). Opt-in: absent = no monitoring. */
export interface ProgressGuardOptions {
  /** Sampling interval, ms (default 60000). */
  intervalMs?: number
  /** Score below this counts as hopeless (default 0.15). */
  minScore?: number
  /** Consecutive hopeless samples with no new tool evidence before cancel (default 3). */
  graceChecks?: number
  /** Give up monitoring after this many samples even when healthy (default 8). */
  maxChecks?: number
}

export interface CandidateFactory {
  create(spec: CandidateSpec): Promise<SelectionAgentHandle>
}

export interface WorkspaceManager {
  prepare(sel: { selectionId: string; index: number; sourceCwd?: string; strictSnapshot?: boolean }): Promise<string>
  remove(path: string): Promise<void>
  /** Best-effort purge of the candidate's DSH session-store record (the
   *  persisted journal under the session root). Without this the GUI forever
   *  lists disposed losers as dead sessions pointing at deleted workspaces
   *  (the "目录损坏" ghosts counted 25 orphaned entries on 2026-08-30). */
  purgeSessionRecord?(candidateWorkspace: string): Promise<void>
}

export interface SelectionRunnerDeps {
  factory: CandidateFactory
  workspaces: WorkspaceManager
  bridge: { select(req: BridgeSelectRequest): Promise<BridgeSelectResult>
            progress?(req: BridgeProgressRequest): Promise<BridgeProgressResult> }
  /** Optional provider readiness gate, awaited before ANY candidate spend
   *  (HANDOFF: unsupported provider must fail the selection fast, never mint
   *  five silent ties). Throwing fails the run as status 'failed'. */
  preflight?: (signal: AbortSignal | undefined) => Promise<void>
  /** Test seam for bounded verifier backoff; production uses abort-aware timers. */
  sleep?: RetrySleep
  now?: () => number
}

export interface SelectionRunInput {
  problem: string
  candidateCount: number
  workspaceRoot: string
  sourceSessionId?: string
  sourceCwd?: string
  /** Autopilot requires an exact current-worktree snapshot; manual diagnostics may still use a blank non-git workspace. */
  strictWorkspaceSnapshot?: boolean
  agentPreset?: string
  /** Balanced completed-turn prefix inherited by every candidate. */
  seed?: readonly TrajectoryEvent[]
  checks?: readonly ObjectiveCheck[]
  criteria: BridgeSelectRequest['criteria']
  groundTruthNote?: string | null
  nEvaluations?: number
  pivots?: number
  /** Per-index route overrides, pre-merged by the caller (host) over the
   *  shared candidateModel/candidateProvider defaults. Enables heterogeneous
   *  candidate pools (effect-evaluation lever, HANDOFF §7.3). */
  candidateOptions?: ReadonlyArray<{ provider?: string; model?: string } | undefined>
  /** Per-candidate diversity instruction appended after the canonical problem. */
  candidateInstructions?: readonly string[]
  trigger?: 'manual' | 'autopilot'
  policy?: SelectionRecord['policy']
  onUpdate?: (record: SelectionRecord) => void
  /** Opt-in online abandonment (see ProgressGuardOptions). */
  progressGuard?: ProgressGuardOptions
  /** Tournament seed (providers' RNG boundary), defaults 0. */
  algorithmSeed?: number
  selectionId?: string
  candidateTimeoutMs?: number
  selectTimeoutMs?: number
  verifier: {
    model: string
    baseUrl: string
    apiKey: string
    apiKeyEnv?: string
    /** Verifier thinking strength (sidecar DEEPSEEK_EFFORT scope), e.g. 'max'. */
    effort?: string
    onError?: 'tie' | 'raise'
    maxWorkers?: number | null
  }
  signal?: AbortSignal
}

export interface SelectionRunResult {
  record: SelectionRecord
  /** Transfer of ownership: the orchestrator never disposes the winner. */
  winner?: { candidateIndex: number; sessionId: string; workspace: string; handle: SelectionAgentHandle }
}

export const MAX_CANDIDATES = 5

function clampCandidateCount(n: number): number {
  if (!Number.isInteger(n) || n < 1) throw new Error('candidate-count-invalid')
  return Math.min(n, MAX_CANDIDATES)
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300)
}

function invalidSelectionResult(detail: string): BridgeError {
  return new BridgeError('selection_failed', 'invalid verifier selection result: ' + detail, false)
}

/** Validate the untrusted sidecar payload before any index is mapped back to
 * an agent. A malformed result must fail transparently; it must never crown a
 * candidate by accident or turn a partial ranking into a winner. */
function validateSelectionResult(outcome: BridgeSelectResult, candidateCount: number): void {
  const value = outcome as unknown as Record<string, unknown>
  const index = value.index
  const scores = value.scores
  const ranking = value.ranking
  const comparisons = value.nComparisons
  if (!Number.isInteger(index) || Number(index) < 0 || Number(index) >= candidateCount) {
    throw invalidSelectionResult('winner index is outside the candidate set')
  }
  if (!Array.isArray(scores) || scores.length !== candidateCount
      || scores.some((score) => typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1)) {
    throw invalidSelectionResult('scores must contain one finite value in [0,1] per candidate')
  }
  if (!Array.isArray(ranking) || ranking.length !== candidateCount
      || ranking.some((item) => !Number.isInteger(item) || item < 0 || item >= candidateCount)
      || new Set(ranking).size !== candidateCount) {
    throw invalidSelectionResult('ranking must be a complete unique permutation of candidate indices')
  }
  if (ranking[0] !== index) {
    throw invalidSelectionResult('winner index must agree with ranking[0]')
  }
  // The upstream contract defines ranking as a stable score sort. Treat a
  // permutation that contradicts scores as untrusted instead of crowning a
  // candidate on an inconsistent sidecar response.
  for (let position = 1; position < ranking.length; position += 1) {
    const previous = scores[ranking[position - 1]] as number
    const current = scores[ranking[position]] as number
    if (previous < current || (previous === current && ranking[position - 1] > ranking[position])) {
      throw invalidSelectionResult('ranking must be sorted by scores descending with index tie-breaks')
    }
  }
  if (!Number.isInteger(comparisons) || Number(comparisons) < 1) {
    throw invalidSelectionResult('nComparisons must be a positive integer')
  }
}

export class SelectionRunner {
  private readonly deps: SelectionRunnerDeps
  private readonly now: () => number
  constructor(deps: SelectionRunnerDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  async run(input: SelectionRunInput): Promise<SelectionRunResult> {
    const now = this.now
    const n = clampCandidateCount(input.candidateCount)
    const selectionId = input.selectionId ?? 'sel-' + randomUUID()
    const startedAt = now()
    const record: SelectionRecord = {
      selectionId,
      sourceSessionId: input.sourceSessionId ?? null,
      startedAt,
      finishedAt: null,
      status: 'running',
      stage: 'workspace',
      trigger: input.trigger ?? 'manual',
      ...(input.policy ? { policy: input.policy } : {}),
      candidates: [],
      verifierModel: input.verifier.model,
    }
    const publish = () => { try { input.onUpdate?.(record) } catch { /* observers never own the run */ } }
    publish()
    const handles: Array<SelectionAgentHandle | null> = new Array(n).fill(null)
    const trajectories: Array<string | null> = new Array(n).fill(null)
    const seed = input.seed && input.seed.length > 0 ? input.seed : undefined
    const candidateTimeout = input.candidateTimeoutMs ?? 300000
    let aborted = false
    const onAbort = () => { aborted = true }
    input.signal?.addEventListener('abort', onAbort, { once: true })

    const disposeLoser = async (i: number) => {
      const h = handles[i]
      if (h) { try { await h.dispose() } catch { /* loser cleanup best-effort */ } }
      const ws = record.candidates[i]?.workspace
      if (ws) {
        try { await this.deps.workspaces.remove(ws) } catch { /* best-effort */ }
        // Dispose BEFORE purge: the agent may still flush its journal at
        // disposal time; purging first would race a late write into re-creating
        // the directory.
        try { await this.deps.workspaces.purgeSessionRecord?.(ws) } catch { /* best-effort */ }
      }
    }

    try {
      // 1. Workspaces first: prepare sequentially (git worktree locks serialize).
      for (let i = 0; i < n; i += 1) {
        let workspace: string
        try {
          workspace = await this.deps.workspaces.prepare({ selectionId, index: i, sourceCwd: input.sourceCwd, strictSnapshot: input.strictWorkspaceSnapshot })
        } catch (e) {
          // A transactional workspace adapter may expose the managed path when
          // initial cleanup failed, allowing the runner's normal loser pass to
          // retry it. Unknown failures stay empty; never invent a relative path.
          const failedWorkspace = e && typeof e === 'object' && typeof (e as { workspace?: unknown }).workspace === 'string'
            ? (e as { workspace: string }).workspace : ''
          record.candidates[i] = { index: i, sessionId: null, workspace: failedWorkspace, status: 'failed', error: 'workspace-prepare: ' + errText(e) }
          continue
        }
        record.candidates[i] = { index: i, sessionId: null, workspace, status: 'created' }
      }
      if (aborted) throw new BridgeError('bridge_aborted', 'selection aborted before agent creation', false)
      record.stage = 'preflight'
      publish()
      // Phase 0: provider readiness gate — before any agent or verifier spend.
      if (this.deps.preflight) {
        try {
          await this.deps.preflight(input.signal)
        } catch (e) {
          throw new BridgeError('preflight_failed', 'verifier preflight: ' + errText(e), false)
        }
      }

      record.stage = 'rollout'
      publish()
      // 2. Create agents in parallel; per-candidate failure is contained.
      await Promise.all(record.candidates.map(async (cand, i) => {
        if (cand.status === 'failed') return
        const sessionId = 'session-' + randomUUID()
        try {
          const agentOptions = input.candidateOptions?.[i]
          handles[i] = await this.deps.factory.create({
            sessionId,
            cwd: cand.workspace,
            parentSession: input.sourceSessionId,
            seed,
            seedLength: seed?.length,
            agentPreset: input.agentPreset,
            agentOptions,
          })
          cand.sessionId = sessionId
          publish()
          if (agentOptions && (agentOptions.provider !== undefined || agentOptions.model !== undefined)) {
            cand.agentOptions = agentOptions
          }
        } catch (e) {
          cand.status = 'failed'
          cand.error = 'agent-create: ' + errText(e)
        }
      }))
      if (aborted) throw new BridgeError('bridge_aborted', 'selection aborted during agent creation', false)

      // 3. Drive all created candidates in parallel; per-candidate timeout
      //    cancels that agent without touching the others.
      await Promise.all(record.candidates.map(async (cand, i) => {
        const handle = handles[i]
        if (!handle || cand.status === 'failed') return
        cand.status = 'running'
        publish()
        const agent = handle.agent
        // Turn boundaries beyond this point belong to THIS candidate's run;
        // seed events must not be mistaken for candidate failures.
        const preRunCount = agent.session.events.length
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          try { agent.cancel?.() } catch { /* no-op */ }
        }, candidateTimeout)
        // Opt-in online hopeless-rollout abandonment (progressGuard): sample
        // the candidate's live trajectory through the verifier's progress
        // tracker; abandon when low scores persist AND no new tool evidence
        // arrived between samples. glm-5.2's historical 900s no-op burn (HANDOFF §7.3) is
        // the motivating case — this cancels it early with a stated reason.
        const pg = input.progressGuard
        const progressFn = pg ? this.deps.bridge.progress?.bind(this.deps.bridge) : undefined
        let pgCancelled = false
        let pgLastScore = null as number | null
        let monitor: ReturnType<typeof setInterval> | null = null
        if (pg && progressFn) {
          const interval = Math.max(1000, pg.intervalMs ?? 60000)
          const minScore = pg.minScore ?? 0.15
          const grace = Math.max(2, pg.graceChecks ?? 3)
          const maxChecks = Math.max(1, pg.maxChecks ?? 8)
          let samples = 0
          let lowStreak = 0
          let lastEvidence = -1
          const evidenceCount = () => agent.session.events.filter((ev) => ev.type === 'tool/result').length
          monitor = setInterval(() => {
            void (async () => {
              if (pgCancelled || cand.status !== 'running') return
              samples += 1
              const evidence = evidenceCount()
              let score: number | null = null
              try {
                const rendered = renderTrajectory(agent.session.events.slice(preRunCount))
                if (rendered.text.trim()) {
                  const r = await progressFn({
                    problem: input.problem,
                    steps: [rendered.text.slice(-12000)],
                    model: input.verifier.model,
                    baseUrl: input.verifier.baseUrl,
                    apiKey: input.verifier.apiKey,
                    apiKeyEnv: input.verifier.apiKeyEnv,
                    effort: input.verifier.effort,
                    nEvaluations: 1,
                  })
                  score = r.score
                }
              } catch { score = null }
              if (score !== null) {
                pgLastScore = score
                ;(cand.progress ??= []).push({ at: this.now(), score })
              }
              if (score !== null && score < minScore) {
                lowStreak = evidence === lastEvidence ? lowStreak + 1 : 1
              } else {
                lowStreak = 0
              }
              lastEvidence = evidence
              if (lowStreak >= grace) {
                pgCancelled = true
                try { agent.cancel?.() } catch { /* no-op */ }
              }
              if (monitor && (pgCancelled || samples >= maxChecks)) {
                clearInterval(monitor)
                monitor = null
              }
            })()
          }, interval)
        }
        try {
          const strategy = input.candidateInstructions?.[i]?.trim()
          const candidateTask = strategy
            ? input.problem + '\n\n[CANDIDATE STRATEGY]\n' + strategy + '\nDo not discuss the tournament or wait for other candidates.'
            : input.problem
          await agent.followup({
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: candidateTask }],
            source: { kind: 'user' },
          })
          // An abort must interrupt the idle wait promptly.
          let rejectAbort: ((e: BridgeError) => void) | null = null
          const abortP = new Promise<never>((_, reject) => { rejectAbort = reject })
          const onSig = () => rejectAbort?.(new BridgeError('bridge_aborted', 'selection aborted while candidates ran', false))
          if (input.signal) {
            if (input.signal.aborted) onSig()
            else input.signal.addEventListener('abort', onSig, { once: true })
          }
          try {
            await Promise.race([agent.whenIdle(), abortP])
          } finally {
            input.signal?.removeEventListener('abort', onSig)
          }
          if (monitor) { clearInterval(monitor); monitor = null }
          if (pgCancelled) {
            cand.status = 'failed'
            cand.error = 'progress-abandoned (lastScore=' + (pgLastScore === null ? 'n/a' : pgLastScore.toFixed(3)) + ')'
          } else if (timedOut) {
            cand.status = 'failed'
            cand.error = 'candidate-timeout'
          } else {
            // A turn that ended in error (e.g. prompt assembly failure) is a
            // failed candidate, not a finished one — never feed it to the
            // verifier as if it were a real rollout.
            const tail = agent.session.events.slice(preRunCount)
            const bad = tail.filter((ev) => ev.type === 'turn/end' && ((ev.data ?? {}) as { reason?: { kind?: string } }).reason?.kind === 'error')
            if (bad.length > 0) {
              cand.status = 'failed'
              const reason = ((bad[bad.length - 1].data ?? {}) as { reason?: { error?: { message?: string } } }).reason?.error?.message
              cand.error = 'turn-error' + (reason ? ': ' + reason.slice(0, 160) : '')
            } else {
              cand.status = 'finished'
            }
          }
        } catch (e) {
          cand.status = 'failed'
          cand.error = errText(e)
        } finally {
          clearTimeout(timer)
        }
        // Trajectory accounting is best-effort and runs for finished AND
        // failed candidates alike — a crashed candidate's partial trajectory
        // is evidence for the record.
        try {
          const seedLen = seed?.length ?? 0
          const events = handle.agent.session.events
          const sliced = seedLen
            ? events.filter((ev) => typeof ev.seq !== 'number' || ev.seq >= seedLen)
            : events
          const r = renderTrajectory(sliced)
          cand.eventCount = r.eventCount
          cand.toolCalls = r.toolCalls
          cand.trajectoryChars = r.totalChars
          trajectories[cand.index] = r.text
        } catch { /* render is observability, never fatal */ }
        publish()
      }))
      if (aborted) throw new BridgeError('bridge_aborted', 'selection aborted after candidate runs', false)

      record.stage = 'checks'
      publish()
      // 4. Objective checks eliminate clearly-failed candidates.
      for (const cand of record.candidates) {
        if (cand.status !== 'finished') continue
        if (!input.checks || input.checks.length === 0) continue
        cand.checks = await runChecks(cand.workspace, input.checks, { signal: input.signal })
        const failed = cand.checks.filter((c) => !c.ok).map((c) => c.name)
        if (failed.length > 0) {
          cand.status = 'eliminated'
          cand.eliminatedBy = failed
        }
      }

      record.stage = 'ranking'
      publish()
      // 5. Verifier selection over surviving candidates.
      const survivors = record.candidates.filter((c) => c.status === 'finished')
      record.candidates.forEach((c) => {
        if (c.status === 'failed' && !c.eliminatedBy) c.eliminatedBy = ['run-failed']
      })
      let winnerIdx = -1
      if (survivors.length === 0) {
        record.status = 'failed'
        record.error = 'all_candidates_eliminated'
      } else if (survivors.length === 1) {
        // Objective checks establish eligibility, not a verifier score. Keep
        // this shortcut explicit so downstream finalization cannot overclaim.
        winnerIdx = survivors[0].index
        record.winnerBasis = input.checks && input.checks.length > 0 ? 'objective-check-only' : 'single-candidate'
        record.scores = record.candidates.map(() => null)
        record.ranking = [survivors[0].index]
        record.nComparisons = 0
      } else {
        if (aborted) throw new BridgeError('bridge_aborted', 'selection aborted before verifier select', false)
        // Ceiling matches host.ts MAX_SELECTION_TIMEOUT_MS (600s since
        // 2026-09-05): max-effort verifiers need >300s for even two beats.
        const rankingBudgetMs = Math.max(1, Math.min(600_000, Math.floor(input.selectTimeoutMs ?? 180_000)))
        const rankingDeadlineAt = now() + rankingBudgetMs
        const nEvaluations = Math.max(1, Math.min(8, Math.floor(input.nEvaluations ?? 2)))
        const pivots = Math.max(0, Math.min(survivors.length, Math.floor(input.pivots ?? 1)))
        const outcome = await retryTransientBridge((attempt) => this.deps.bridge.select({
          problem: input.problem,
          candidates: survivors.map((c) => trajectories[c.index] ?? ''),
          criteria: input.criteria,
          groundTruthNote: input.groundTruthNote ?? null,
          nEvaluations,
          pivots,
          seed: input.algorithmSeed ?? 0,
          model: input.verifier.model,
          baseUrl: input.verifier.baseUrl,
          apiKey: input.verifier.apiKey,
          apiKeyEnv: input.verifier.apiKeyEnv,
          effort: input.verifier.effort,
          onError: input.verifier.onError ?? 'raise',
          maxWorkers: input.verifier.maxWorkers ?? null,
          timeoutMs: attempt.timeoutMs,
          signal: attempt.signal,
        }), {
          signal: input.signal,
          sleep: this.deps.sleep,
          deadlineAt: rankingDeadlineAt,
          maxAttempts: 2,
          now,
          onAttempt: (attempt) => { record.rankingAttempts = attempt; publish() },
          onRetry: (error) => {
            const errors = record.rankingRetryErrors ?? (record.rankingRetryErrors = [])
            errors.push(error.message.slice(0, 300))
            publish()
          },
        })
        validateSelectionResult(outcome, survivors.length)
        record.winnerBasis = 'verifier'
        record.effectiveEvaluations = nEvaluations
        record.verificationPasses = record.rankingAttempts ?? 1
        const fullScores: Array<number | null> = record.candidates.map(() => null)
        survivors.forEach((c, si) => { fullScores[c.index] = outcome.scores[si] })
        record.scores = fullScores
        record.ranking = outcome.ranking.map((ri) => survivors[ri].index)
        record.nComparisons = outcome.nComparisons
        record.usage = outcome.usage
        winnerIdx = survivors[outcome.index].index
      }

      // Preserve bounded evidence from the two highest-ranked candidates before
      // loser disposal. This is a synthesis packet, not a probability claim.
      record.finalists = (record.ranking ?? []).slice(0, 2).map((index) => ({
        index,
        score: record.scores?.[index] ?? null,
        model: record.candidates[index]?.agentOptions?.model,
        handoff: boundCandidateHandoff(trajectories[index] ?? ''),
      }))

      // 6. Winner/loser lifecycle: winner survives, losers disposed + removed.
      let winner: SelectionRunResult['winner']
      if (winnerIdx >= 0) {
        const cand = record.candidates[winnerIdx]
        cand.status = 'winner'
        record.winner = { index: winnerIdx, sessionId: cand.sessionId, workspace: cand.workspace }
        winner = { candidateIndex: winnerIdx, sessionId: String(cand.sessionId), workspace: cand.workspace, handle: handles[winnerIdx] as SelectionAgentHandle }
      }
      for (let i = 0; i < n; i += 1) {
        if (i === winnerIdx) continue
        if (record.candidates[i].status !== 'failed' && record.candidates[i].status !== 'eliminated') {
          record.candidates[i].status = 'loser'
        }
        await disposeLoser(i)
      }
      record.finishedAt = now()
      if (record.status === 'running') record.status = 'completed'
      record.stage = 'settled'
      publish()
      await this.sweepWinnerlessRoot(record, winnerIdx >= 0, input.workspaceRoot)
      return { record, winner }
    } catch (e) {
      const isAbort = aborted || (e instanceof BridgeError && e.code === 'bridge_aborted')
      record.status = isAbort ? 'aborted' : 'failed'
      record.error = errText(e)
      record.finishedAt = now()
      record.stage = 'settled'
      publish()
      for (let i = 0; i < n; i += 1) await disposeLoser(i)
      await this.sweepWinnerlessRoot(record, false, input.workspaceRoot)
      return { record }
    } finally {
      input.signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Winnerless runs (failed/aborted, or a completed run that never crowned)
   *  leave an empty root behind after per-candidate sweeps; drop it so
   *  .data/selection-workspaces only accumulates retained winners. rmdir is
   *  deliberately non-recursive: a root still holding ANYTHING (e.g. a
   *  winner's workspace kept by design) fails the op and is left untouched. */
  private async sweepWinnerlessRoot(record: SelectionRecord, hasWinner: boolean, workspaceRoot: string): Promise<void> {
    if (hasWinner) return
    try { await rmdir(path.join(workspaceRoot, record.selectionId)) } catch { /* non-empty or already gone: both intended */ }
  }
}
