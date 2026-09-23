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
import { diagnostics as defaultDiagnostics, type Diagnostics } from '../diagnostics.js'
import { rmdir } from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_SELECTION_MARGIN_THRESHOLD } from '../constants.js'
import { boundCandidateHandoff, renderTrajectory, type TrajectoryEvent } from './trajectory.js'
import { runChecks, type CheckResult, type ObjectiveCheck } from './checks.js'
export type { CheckResult, ObjectiveCheck } from './checks.js'
import { BridgeError, type BridgeProgressRequest, type BridgeProgressResult, type BridgeSelectRequest, type BridgeSelectResult, type BridgeUsage } from './bridge.js'
import { retryTransientBridge, type RetrySleep } from './retry.js'

export type CandidateStatus =
  | 'created' | 'running' | 'finished' | 'failed' | 'eliminated' | 'winner' | 'retained' | 'loser'

/** Objective workspace-diff evidence collected after the rollout (ruling
 *  I.5/J.4). Produced by an injected helper so this module stays pure. */
export interface DiffStatLite {
  files: number
  insertions: number
  deletions: number
  untracked: number
  fingerprint: string
}

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
  /** Execution-class tool calls (meta/discovery tools excluded, ruling K.4-1). */
  execToolCalls?: number
  /** Worktree diff vs source HEAD; null when the workspace is not git. */
  diffStat?: DiffStatLite | null
  /** Objective-evidence tier: pass = caller checks all ok; none = no checks,
   *  checks invalid, or never ran. A candidate eliminated by a genuine check
   *  failure is recorded via eliminatedBy instead. */
  objectiveEvidence?: 'pass' | 'none'
  /** Every failing check was a shell interpreter error (B-10): the gate itself
   *  malfunctioned, so the candidate survives as if no checks were given. */
  checksInvalid?: boolean
  trajectoryChars?: number
  checks?: CheckResult[]
  eliminatedBy?: string[]
  /** Online progress samples when progressGuard was active. */
  progress?: Array<{ at: number; score: number }>
}

/** Ruling I.2 outcome state machine: exactly one value once the selection
 *  settles. `winnerBasis` is narrowed for compatibility; consumers must read
 *  `outcome` first. */
export type SelectionOutcome =
  | 'ranked_winner'             // margin above threshold; verifier preference
  | 'objective_only_result'     // verifier absent; strict deterministic order
  | 'single_candidate_fallback' // exactly one survivor; never compared
  | 'insufficient_evidence'     // survivors produced no verifiable work
  | 'abstain'                   // margin inside the provisional calibrated noise band
  | 'verifier_unavailable'      // ranking infrastructure failed after retries

export interface SelectionRecord {
  selectionId: string
  sourceSessionId: string | null
  startedAt: number
  finishedAt: number | null
  status: 'running' | 'completed' | 'failed' | 'aborted'
  error?: string
  trigger?: 'manual' | 'autopilot'
  stage?: 'workspace' | 'preflight' | 'rollout' | 'checks' | 'ranking' | 'settled'
  policy?: { depth: 'standard' | 'deep'; modelStrategy?: 'quality-first' | 'exploration'; candidateCount: number; nEvaluations: number; contextChars: number; models: string[]; pivots?: number; verifierEffort?: string; taskKind?: string; probes?: Record<string, boolean> }
  /** Admission-time task type evidence lane (ruling I.3). */
  taskKind?: string
  outcome?: SelectionOutcome
  effectiveEvaluations?: number
  verificationPasses?: number
  candidates: CandidateRecord[]
  /** Set ONLY for outcome=ranked_winner: a verifier preference cleared the
   *  margin gate. Retained workspace/handle for the finalizer. */
  winner?: { index: number; sessionId: string | null; workspace: string; discardedAt?: number }
  /** Retained survivor that is NOT a chosen-best claim: single-survivor or
   *  objective-only / deduped results keep the workspace under this field. */
  fallback?: { index: number; sessionId: string | null; workspace: string; discardedAt?: number }
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
  /** Legacy compatibility basis; the authoritative state is `outcome`. */
  winnerBasis?: 'verifier' | 'objective-check-only' | 'single-candidate'
  /** All survivors shared one diff fingerprint — deduped before the verifier
   *  (ruling F3); the record is a fallback, never a ranking claim. */
  noSearchSpace?: boolean
  /** No candidate carried deterministic objective evidence (checks pass); any
   *  ranking on this record was LLM-only. */
  llmOnly?: boolean
  /** Top-2 score margin and the gate it was judged against. */
  margin?: number
  marginThreshold?: number
  marginCondition?: string
  /** Threshold remains provisional until the graduation invoice clears (I.4). */
  marginProvisional?: boolean
  /** At least one candidate's checks were shell-level failures (B-10). */
  checksUnreliable?: boolean
  /** Effective config captured at start; survives config reloads (ruling F5). */
  configSnapshot?: Record<string, unknown>
  sourceModel?: string | null
  sourceHeadAtStart?: string | null
  /** Free-text note carrying an abstain/fallback reason for the ledger. */
  note?: string
  /**
   * Source-integration post-audit (ruling G-4/I.5): executed at autopilot
   * winner/fallback cleanup time. `delivered` is granted only when the audit
   * observed integration evidence; un-audited stays `unknown` forever.
   */
  delivery?: {
    audited: boolean
    headBefore?: string | null
    headAfter?: string | null
    headChanged?: boolean | null
    dirtyEntries?: number | null
    /** Exit code of the configured post-audit test command, when it ran. */
    postAuditTestExit?: number | null
    delivered: 'yes' | 'no' | 'unknown'
    note?: string
  }
  /** Lifecycle timestamps so relay/idle/discard timing questions (B-9) can be
   *  answered from the ledger instead of guessed. */
  timing?: { relayedAt?: number; auditedAt?: number }
  usage?: BridgeUsage
  /** Count of criteria sent to the verifier for this ranking. Together with
   *  nComparisons and effectiveEvaluations it pins the scheduler identity
   *  (upstream fine_grained_reward: one API call per directed comparison per
   *  (criterion, rep), no internal retries — on_error='raise' aborts):
   *  usage.calls == nComparisons * criteriaCount * effectiveEvaluations. */
  criteriaCount?: number
  /** nComparisons * criteriaCount * effectiveEvaluations at ranking time.
   *  A live usage.calls that deviates from this value is itself an anomaly
   *  (legacy tie-swallow path, upstream scheduler change, or counter drift). */
  expectedVerifierCalls?: number
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
  /** Every candidate directory currently under the managed root, whether or
   *  not this process created it. Absent = the manager cannot enumerate
   *  (test fakes), and orphan reclamation is skipped. */
  listManaged?(): Promise<Array<{ selectionId: string; index: number; dir: string }>>
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
  /** Objective diff evidence collector; absent → diff portion of the has-work
   *  gate silently unavailable (tool-call evidence still applies). */
  diffStat?: (cwd: string) => Promise<DiffStatLite | null>
  /** Full patch capture for the audit pack (ruling I.5). Runs right after the
   *  per-candidate accounting pass, before any workspace disposal. */
  diffFull?: (cwd: string) => Promise<{ patch: string; truncated: boolean; untrackedFiles: string[] } | null>
  /** Test seam for bounded verifier backoff; production uses abort-aware timers. */
  sleep?: RetrySleep
  now?: () => number
  /** Degradation sink for best-effort paths (loser cleanup, evidence
   *  capture, progress sampling, ranking retries). Process default if omitted. */
  diagnostics?: Diagnostics
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
  /** Task-type evidence lane decided at admission (ruling I.3). Unknown is
   *  treated as code-shaped whenever worktrees are involved. */
  taskKind?: string
  /** Provisional top-2 margin gate; below it the outcome is abstain, not a
   *  verifier winner (ruling I.1/I.4). Recorded per run with its condition. */
  marginThreshold?: number
  /** Extra fields merged into the record at creation (config snapshot, source
   *  attribution). Runner-controlled keys always win. */
  recordSeed?: Partial<SelectionRecord>
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
    /** Token-bucket dispatch spacing (ms) inside the tournament sidecar; 0 = off. */
    minIntervalMs?: number
  }
  signal?: AbortSignal
}

export interface SelectionRunResult {
  record: SelectionRecord
  /** Transfer of ownership: the orchestrator never disposes the retained
   *  candidate. Present for a ranked winner OR a fallback survivor. */
  retained?: { candidateIndex: number; sessionId: string; workspace: string; handle: SelectionAgentHandle }
  /** Captured before loser workspaces were disposed: rendered trajectories and
   *  full git patches per candidate index. Written to the audit pack
   *  (.data/selection-artifacts/<id>/) by the host at settle time. */
  artifacts?: {
    traces: Array<string | null>
    diffPatches: Array<{ patch: string; truncated: boolean; untrackedFiles: string[] } | null>
  }
}

export const MAX_CANDIDATES = 5

/** Delivery decision for the source-integration post-audit (ruling I.2):
 *  `yes` requires observed integration AND a configured test command that
 *  passed. Without a test command the answer is never yes — the plugin does
 *  not invent evidence. */
export function evaluateDelivery(input: {
  audited: boolean
  headChanged: boolean | null
  dirtyEntries: number | null
  testsConfigured: boolean
  testsExit?: number | null
}): { delivered: 'yes' | 'no' | 'unknown'; note: string } {
  if (!input.audited) return { delivered: 'unknown', note: 'audit did not run' }
  const integrated = input.headChanged === true || (input.dirtyEntries !== null && (input.dirtyEntries ?? 0) > 0)
  if (!integrated) return { delivered: 'no', note: 'no HEAD advance and clean worktree at audit time' }
  if (!input.testsConfigured) {
    return { delivered: 'unknown', note: 'integration evidence observed; no test command configured (selectionPostAuditTestCommand) so verification is unresolved' }
  }
  if (input.testsExit === 0) return { delivered: 'yes', note: 'HEAD/advanced worktree integrated and the configured test command exited 0' }
  return { delivered: 'no', note: 'integration evidence present but the configured test command failed (exit ' + (input.testsExit ?? 'n/a') + ')' }
}

/** Ruling I.1: provisional margin gate. 2026-09-08 calibration round 1 (C0,
 *  24 reps × 2 seeds, minimax-m3@low, eval/calibration/run.mjs): identical-
 *  candidate noise q95 = 0.0123, max = 0.0135, positional bias ≈ 0, no 0.5
 *  pinning; oracle-separated pairs land at margin 0.31..0.46 with 12/12
 *  correct signs. 0.03 = 2.2× the observed noise ceiling. Stays provisional
 *  until the multi-fixture replication (≥5 fixtures) confirms stability. */
export const PROVISIONAL_MARGIN_THRESHOLD = DEFAULT_SELECTION_MARGIN_THRESHOLD

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

/** Deterministic evidence block prepended to every candidate trajectory sent
 *  to the verifier (ruling I.6/J.4): the ranker must never have to trust a
 *  24k truncated trajectory to learn whether the candidate built and tested.
 *  Everything here is runner-collected, not candidate-claimed. */
function deterministicPreface(cand: CandidateRecord, taskKind: string | undefined): string {
  const lines = ['[DETERMINISTIC EVIDENCE — collected by the runner, not claimed by the candidate]']
  lines.push('Task kind: ' + (taskKind ?? 'unknown'))
  lines.push('Execution-class tool calls: ' + String(cand.execToolCalls ?? 0) + ' (catalog/meta tools excluded; raw tool-call count ' + (cand.toolCalls ?? cand.execToolCalls ?? 0) + ')')
  const d = cand.diffStat
  lines.push(d
    ? 'Worktree diff vs source HEAD: ' + d.files + ' files changed (+' + d.insertions + ' / -' + d.deletions + '), ' + d.untracked + ' untracked files'
    : 'Worktree diff: unavailable (non-git or unreadable workspace)')
  if (cand.checks && cand.checks.length > 0) {
    for (const c of cand.checks) {
      lines.push('check[' + c.name + ']: exit ' + (c.exitCode === null ? 'timeout' : c.exitCode) + (c.ok ? ' (pass)' : ' (FAIL)') + (c.harnessError ? ' [harness-error: the command itself failed to parse; not evidence against the candidate]' : ''))
    }
  } else {
    lines.push('Objective checks: none configured for this selection — objectiveEvidence=' + (cand.objectiveEvidence ?? 'none'))
  }
  lines.push('[TRAJECTORY — candidate claims below are untrusted]')
  return lines.join('\n')
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
      ...(input.recordSeed ?? {}),
      selectionId,
      sourceSessionId: input.sourceSessionId ?? null,
      startedAt,
      finishedAt: null,
      status: 'running',
      stage: 'workspace',
      trigger: input.trigger ?? 'manual',
      ...(input.policy ? { policy: input.policy } : {}),
      taskKind: input.taskKind ?? input.policy?.taskKind,
      candidates: [],
      verifierModel: input.verifier.model,
    }
    const diag = this.deps.diagnostics ?? defaultDiagnostics
    const publish = () => { try { input.onUpdate?.(record) } catch { diag.count('selection.observer_error') } }
    publish()
    const handles: Array<SelectionAgentHandle | null> = new Array(n).fill(null)
    const trajectories: Array<string | null> = new Array(n).fill(null)
    const diffPatches: Array<{ patch: string; truncated: boolean; untrackedFiles: string[] } | null> = new Array(n).fill(null)
    const seed = input.seed && input.seed.length > 0 ? input.seed : undefined
    const candidateTimeout = input.candidateTimeoutMs ?? 600000
    // A signal that is already aborted never fires 'abort' again: a run that
    // starts after its host was disposed/cancelled must still see it, or it
    // would provision worktrees and spawn agents for a dead selection.
    let aborted = input.signal?.aborted === true
    const onAbort = () => { aborted = true }
    input.signal?.addEventListener('abort', onAbort, { once: true })

    // Run-scoped serial progress sampler. The sidecar is one serial pipe: N
    // candidates ticking together used to push N progress frames into it at
    // once, so with a slow verifier the tail frame could outlive the bridge
    // timeout and tear the whole sidecar down. Samples now run one at a time
    // in FIFO order with at most one queued sample per candidate; a tick that
    // finds its own sample still pending is skipped (a sample is a best-effort
    // observation, not a scheduled obligation).
    let progressChain: Promise<void> = Promise.resolve()
    const progressPending = new Set<number>()
    const enqueueProgressSample = (index: number, sample: () => Promise<void>): void => {
      if (progressPending.has(index)) return
      progressPending.add(index)
      const run = async () => {
        try { await sample() } catch { /* sampling never owns the run */ } finally { progressPending.delete(index) }
      }
      progressChain = progressChain.then(run, run)
    }

    // Loser cleanup is best-effort by contract (a leaked worktree must never
    // fail a settled selection) but not silent: every leaked resource is a
    // diagnostic the operator can act on.
    const disposeLoser = async (i: number) => {
      const h = handles[i]
      if (h) { try { await h.dispose() } catch (error) { diag.warn('loser.dispose', error, { selectionId: record.selectionId, candidate: i }) } }
      const ws = record.candidates[i]?.workspace
      if (ws) {
        try { await this.deps.workspaces.remove(ws) } catch (error) { diag.warn('loser.workspace', error, { selectionId: record.selectionId, candidate: i, workspace: ws }) }
        // Dispose BEFORE purge: the agent may still flush its journal at
        // disposal time; purging first would race a late write into re-creating
        // the directory.
        try { await this.deps.workspaces.purgeSessionRecord?.(ws) } catch (error) { diag.warn('loser.session', error, { selectionId: record.selectionId, candidate: i }) }
      }
    }

    try {
      if (aborted) throw new BridgeError('bridge_aborted', 'selection aborted before workspace preparation', false)
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
            if (pgCancelled || cand.status !== 'running') return
            enqueueProgressSample(cand.index, async () => {
              // Re-check after the queue wait: the candidate may have settled
              // (or the run aborted) while another candidate's sample ran.
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
                    // A run abort must not leave a sample occupying the pipe.
                    signal: input.signal,
                  })
                  score = r.score
                }
              } catch (error) {
                score = null
                diag.count('progress.sample_failed')
                // A run abort is the caller's decision, not a degradation. The
                // bridge already recorded the per-request detail (timeout text,
                // stderr tail); here the stable code keeps one entry per outage
                // instead of one per tick.
                if (!input.signal?.aborted) diag.warn('progress.sample', error instanceof BridgeError ? 'sidecar ' + error.code : error, { selectionId: record.selectionId })
              }
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
            })
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
          // The progress monitor must die with the candidate on EVERY exit
          // path: after an abort or a followup failure the interval used to
          // keep ticking (each tick returned early on status, so it never
          // reached its maxChecks self-stop) and pinned the event loop.
          if (monitor) { clearInterval(monitor); monitor = null }
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
          cand.execToolCalls = r.execToolCalls
          cand.trajectoryChars = r.totalChars
          trajectories[cand.index] = r.text
        } catch (error) { diag.warn('evidence.render', error, { selectionId: record.selectionId, candidate: cand.index }) }
        // Objective diff evidence (ruling I.5): the workspace's git surface is
        // the has-work gate's primary trust anchor. Best-effort; a non-git
        // workspace yields null and the gate falls back to tool calls.
        if (this.deps.diffStat) {
          try { cand.diffStat = await this.deps.diffStat(cand.workspace) } catch (error) { cand.diffStat = null; diag.warn('evidence.diffstat', error, { selectionId: record.selectionId, candidate: cand.index }) }
        }
        // Full patch capture for the artifact pack — BEFORE any cleanup could
        // delete the worktree (loser disposal runs later).
        if (this.deps.diffFull) {
          try { diffPatches[cand.index] = await this.deps.diffFull(cand.workspace) } catch (error) { diffPatches[cand.index] = null; diag.warn('evidence.diff', error, { selectionId: record.selectionId, candidate: cand.index }) }
        }
        publish()
      }))
      if (aborted) throw new BridgeError('bridge_aborted', 'selection aborted after candidate runs', false)

      record.stage = 'checks'
      publish()
      // 4. Objective checks eliminate clearly-failed candidates. A check whose
      //    own command was mangled by the shell (harnessError) is not evidence
      //    against the candidate (ruling B-10/K.5): the gate stayed silent,
      //    recorded, and never causes all_candidates_eliminated.
      for (const cand of record.candidates) {
        if (cand.status !== 'finished') continue
        if (!input.checks || input.checks.length === 0) { cand.objectiveEvidence = 'none'; continue }
        cand.checks = await runChecks(cand.workspace, input.checks, { signal: input.signal })
        const failed = cand.checks.filter((c) => !c.ok)
        if (failed.length > 0 && failed.every((c) => c.harnessError)) {
          cand.checksInvalid = true
          cand.objectiveEvidence = 'none'
          record.checksUnreliable = true
        } else if (failed.length > 0) {
          cand.status = 'eliminated'
          cand.eliminatedBy = failed.map((c) => c.name)
        } else {
          cand.objectiveEvidence = 'pass'
        }
      }

      record.stage = 'ranking'
      publish()
      // 5. Survivor gates around the verifier tournament (ruling I.2/I.3, K.5):
      //    a "winner" must clear objective evidence, a real search space, and
      //    the margin gate; anything less is an honestly labeled fallback,
      //    abstain, or insufficient_evidence — never winnerBasis=verifier.
      record.candidates.forEach((c) => {
        if (c.status === 'failed' && !c.eliminatedBy) c.eliminatedBy = ['run-failed']
      })
      let survivors = record.candidates.filter((c) => c.status === 'finished')
      const taskKind = record.taskKind ?? 'unknown'
      // Analysis-text tasks have no deterministic evidence layer by design
      // (ruling I.3); everything else provisioned a worktree and is judged as
      // code-shaped. "No tool calls" alone never eliminates for analysis.
      const requiresWork = taskKind !== 'analysis-text'
      if (survivors.length > 0 && !survivors.some((c) => c.objectiveEvidence === 'pass')) record.llmOnly = true
      if (requiresWork) {
        for (const cand of survivors) {
          const diff = cand.diffStat ?? null
          const diffWork = !!diff && (diff.files > 0 || diff.untracked > 0)
          const toolWork = (cand.execToolCalls ?? 0) > 0
          if (!diffWork && !toolWork) {
            cand.status = 'eliminated'
            cand.eliminatedBy = [...(cand.eliminatedBy ?? []), 'insufficient-evidence']
          }
        }
        survivors = record.candidates.filter((c) => c.status === 'finished')
        if (survivors.length === 0
          && record.candidates.some((c) => c.eliminatedBy?.includes('insufficient-evidence'))) {
          record.outcome = 'insufficient_evidence'
          record.note = 'surviving candidates produced no execution-class tool calls and an empty worktree diff (has-work gate)'
        }
      }
      let winnerIdx = -1
      let retainedIdx = -1
      if (!record.outcome) {
        if (survivors.length === 0) {
          record.status = 'failed'
          record.error = 'all_candidates_eliminated'
        } else if (survivors.length === 1) {
          // Single survivor: retained for the source turn but NEVER a ranking
          // claim (ruling I.2 single_candidate_fallback).
          const sole = survivors[0]
          retainedIdx = sole.index
          record.outcome = 'single_candidate_fallback'
          record.winnerBasis = input.checks && input.checks.length > 0 && !sole.checksInvalid ? 'objective-check-only' : 'single-candidate'
          record.scores = record.candidates.map(() => null)
          record.ranking = [sole.index]
          record.nComparisons = 0
          record.fallback = { index: sole.index, sessionId: sole.sessionId, workspace: sole.workspace }
        } else {
          // Identical diff surfaces = zero search space: dedupe BEFORE paying
          // the tournament (ruling F3). Applies only when git evidence exists
          // for every survivor; otherwise the verifier decides.
          const fingerprints = survivors.map((c) => c.diffStat?.fingerprint)
          if (requiresWork
            && fingerprints.every((fp) => typeof fp === 'string')
            && new Set(fingerprints).size === 1) {
            const kept = survivors[0]
            record.noSearchSpace = true
            record.outcome = 'single_candidate_fallback'
            record.winnerBasis = 'single-candidate'
            retainedIdx = kept.index
            record.scores = record.candidates.map(() => null)
            record.ranking = [kept.index]
            record.nComparisons = 0
            record.fallback = { index: kept.index, sessionId: kept.sessionId, workspace: kept.workspace }
            record.note = 'all survivors produced identical diff surfaces; deduped before verifier (no-search-space)'
          } else {
            if (aborted) throw new BridgeError('bridge_aborted', 'selection aborted before verifier select', false)
            // Ceiling matches host.ts MAX_SELECTION_TIMEOUT_MS (600s since
            // 2026-09-05): max-effort verifiers need >300s for even two beats.
            const rankingBudgetMs = Math.max(1, Math.min(600_000, Math.floor(input.selectTimeoutMs ?? 180_000)))
            const rankingDeadlineAt = now() + rankingBudgetMs
            const nEvaluations = Math.max(1, Math.min(8, Math.floor(input.nEvaluations ?? 2)))
            const pivots = Math.max(0, Math.min(survivors.length, Math.floor(input.pivots ?? 1)))
            let selectResult: BridgeSelectResult | null = null
            try {
              selectResult = await retryTransientBridge((attempt) => this.deps.bridge.select({
                problem: input.problem,
                candidates: survivors.map((c) => deterministicPreface(c, record.taskKind ?? input.taskKind) + '\n\n' + (trajectories[c.index] ?? '')),
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
                minIntervalMs: input.verifier.minIntervalMs ?? 0,
                timeoutMs: attempt.timeoutMs,
                signal: attempt.signal,
              }), {
                signal: input.signal,
                sleep: this.deps.sleep,
                deadlineAt: rankingDeadlineAt,
                maxAttempts: 2,
                now,
                onAttempt: (attempt) => { record.rankingAttempts = attempt; publish() },
                onRetry: (error, attempt) => {
                  const errors = record.rankingRetryErrors ?? (record.rankingRetryErrors = [])
                  errors.push(error.message.slice(0, 300))
                  diag.warn('verifier.ranking_retry', error, { selectionId: record.selectionId, attempt })
                  publish()
                },
              })
            } catch (bridgeFailure) {
              // Ruling K.5: verifier infrastructure failure is NOT a verdict.
              // When every survivor carries passing objective checks, keep
              // their eligibility honestly instead of dropping to failed.
              if (!survivors.every((c) => c.objectiveEvidence === 'pass')) throw bridgeFailure
              record.outcome = 'verifier_unavailable'
              diag.warn('verifier.unavailable', bridgeFailure, { selectionId: record.selectionId })
              record.note = 'ranking failed after retries: ' + errText(bridgeFailure)
              const passCounts = survivors.map((c) => (c.checks ?? []).filter((x) => x.ok).length)
              if (new Set(passCounts).size === passCounts.length) {
                // A strictly ordered deterministic signal exists: report it as
                // an objective-only result, explicitly not a verifier ranking.
                const ordered = [...survivors].sort((a, b) => {
                  const pa = (a.checks ?? []).filter((x) => x.ok).length
                  const pb = (b.checks ?? []).filter((x) => x.ok).length
                  return pb - pa || a.index - b.index
                })
                const lead = ordered[0]
                record.outcome = 'objective_only_result'
                record.winnerBasis = 'objective-check-only'
                record.ranking = ordered.map((c) => c.index)
                record.scores = record.candidates.map(() => null)
                record.nComparisons = 0
                retainedIdx = lead.index
                record.fallback = { index: lead.index, sessionId: lead.sessionId, workspace: lead.workspace }
              }
            }
            if (selectResult) {
              validateSelectionResult(selectResult, survivors.length)
              record.effectiveEvaluations = nEvaluations
              record.verificationPasses = record.rankingAttempts ?? 1
              const fullScores: Array<number | null> = record.candidates.map(() => null)
              survivors.forEach((c, si) => { fullScores[c.index] = selectResult.scores[si] })
              record.scores = fullScores
              record.ranking = selectResult.ranking.map((ri) => survivors[ri].index)
              record.nComparisons = selectResult.nComparisons
              record.usage = selectResult.usage
              const criteriaCount = Array.isArray(input.criteria) ? input.criteria.length : Object.keys(input.criteria ?? {}).length
              record.criteriaCount = criteriaCount
              record.expectedVerifierCalls = selectResult.nComparisons * criteriaCount * nEvaluations
              // Margin gate (ruling I.1/I.4, B-8): a verifier preference inside
              // the provisional calibrated noise band — exact ties included — abstains.
              // Evidence base (rounds 1-5, two model families): the measured
              // noise ceiling stayed <= 0.014 throughout (n=240 zero-hypothesis
              // frames, max=0.01377); 0.03 sits 2.17x above it (the earlier
              // "2.2x" phrasing was a rounding overstatement, corrected
              // 2026-09-10). Graduation rules: docs/MARGIN-GRADUATION-INVOICE.md;
              // marginProvisional stays true until the invoice clears.
              const first = record.scores[record.ranking[0]] as number
              const second = record.scores[record.ranking[1]] as number
              const margin = Math.abs(first - second)
              const threshold = Math.max(0, Math.min(0.5, input.marginThreshold ?? PROVISIONAL_MARGIN_THRESHOLD))
              record.margin = margin
              record.marginThreshold = threshold
              record.marginProvisional = true
              record.marginCondition = input.verifier.model + '@' + (input.verifier.effort ?? 'default')
              if (margin < threshold) {
                record.outcome = 'abstain'
                record.note = 'top-2 margin ' + margin.toFixed(6) + ' inside provisional noise band < ' + threshold + ' (' + record.marginCondition + ')'
              } else {
                record.outcome = 'ranked_winner'
                record.winnerBasis = 'verifier'
                winnerIdx = survivors[selectResult.index].index
              }
            }
          }
        }
      }

      // Preserve bounded evidence from the two highest-ranked candidates before
      // loser disposal. This is a synthesis packet, not a probability claim.
      record.finalists = (record.ranking ?? []).slice(0, 2).map((index) => ({
        index,
        score: record.scores?.[index] ?? null,
        model: record.candidates[index]?.agentOptions?.model,
        handoff: boundCandidateHandoff(trajectories[index] ?? ''),
      }))

      // 6. Retention lifecycle: exactly one survived candidate may be kept for
      //    the source turn — as `winner` ONLY for outcome=ranked_winner, else
      //    as a `fallback`/`retained` slot that the relay must not frame as a
      //    chosen-best. Every other candidate is disposed and removed.
      const keepIdx = winnerIdx >= 0 ? winnerIdx : retainedIdx
      let retained: SelectionRunResult['retained']
      if (keepIdx >= 0) {
        const cand = record.candidates[keepIdx]
        cand.status = winnerIdx >= 0 ? 'winner' : 'retained'
        if (winnerIdx >= 0) {
          record.winner = { index: winnerIdx, sessionId: cand.sessionId, workspace: cand.workspace }
        }
        retained = { candidateIndex: keepIdx, sessionId: String(cand.sessionId), workspace: cand.workspace, handle: handles[keepIdx] as SelectionAgentHandle }
      }
      for (let i = 0; i < n; i += 1) {
        if (i === keepIdx) continue
        if (record.candidates[i].status !== 'failed' && record.candidates[i].status !== 'eliminated') {
          record.candidates[i].status = 'loser'
        }
        await disposeLoser(i)
      }
      record.finishedAt = now()
      if (record.status === 'running') record.status = 'completed'
      record.stage = 'settled'
      publish()
      await this.sweepWinnerlessRoot(record, keepIdx >= 0, input.workspaceRoot)
      return { record, retained, artifacts: { traces: trajectories, diffPatches } }
    } catch (e) {
      const isAbort = aborted || (e instanceof BridgeError && e.code === 'bridge_aborted')
      record.status = isAbort ? 'aborted' : 'failed'
      record.error = errText(e)
      record.finishedAt = now()
      record.stage = 'settled'
      publish()
      for (let i = 0; i < n; i += 1) await disposeLoser(i)
      await this.sweepWinnerlessRoot(record, false, input.workspaceRoot)
      return { record, artifacts: { traces: trajectories, diffPatches } }
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
