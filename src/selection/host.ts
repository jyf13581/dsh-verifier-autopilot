/**
 * SelectionHost: host-side lifecycle for best-of-N candidate selection
 * (HANDOFF §2.5). Wraps SelectionRunner with live DSH adapters, the
 * verifier bridge singleton, selection history (in-memory + bounded JSONL),
 * and single-active-run admission.
 *
 * Boundary rules honored here:
 * - Selection may be started by the diagnostic HTTP route or by the host's
 *   pre-step autopilot policy; this module itself remains transport-agnostic.
 * - Manual runs may fork a balanced completed-turn seed. Autopilot runs pass a
 *   bounded context packet and disable raw event seeding.
 * - dispose() aborts an in-flight run and disposes every retained winner
 *   handle; no orphan agents, workspaces, or sidecar processes survive.
 */

import path from 'node:path'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { VerifierBridge, type BridgeSelectRequest, type BridgeSelectResult } from './bridge.js'
import { SelectionRunner,
  MAX_CANDIDATES,
  PROVISIONAL_MARGIN_THRESHOLD,
  type CandidateFactory,
  type ObjectiveCheck,
  type SelectionRecord,
  type SelectionRunInput,
  type SelectionRunResult,
  type WorkspaceManager,
} from './candidates.js'
import type { SelectionAgentHandle } from './candidates.js'
import { IsolatedWorkspaceManager, gitDiffStat, gitDiffFull, gitRepoState, makeLiveCandidateFactory } from './live.js'
import type { TrajectoryEvent } from './trajectory.js'
import { retryTransientBridge, type RetrySleep } from './retry.js'
import { appendJsonlLedger, atomicWriteFile, compactJsonlLedger, ledgerExceeds, readJsonlLedger } from '../ledger.js'
import { diagnostics as defaultDiagnostics, type Diagnostics } from '../diagnostics.js'
import type { AgentCreate } from '../dsh-context.js'
import type { SelectionSnapshot, SelectionStartRequest } from '../protocol.js'

/** Source-session lookup for manual runs: the seed cut, the problem text, and
 *  the candidate's parent identity all come from here. Settlement notices go
 *  back through `SelectionHostDeps.notify`, never through this provider, so
 *  the shape asks for nothing more than the Host's own `Agent` offers. */
export interface SelectionsAgentProvider {
  list(): Array<{ id: string }>
  get(id: string): {
    id: string
    ctx: unknown
    session: { events: readonly TrajectoryEvent[]; header?: { cwd?: string; delegationDepth?: number } }
  } | undefined
}

interface LiveAgentsWiring {
  create: AgentCreate
}

export interface SelectionHostDeps {
  agents?: SelectionsAgentProvider
  liveAgents?: LiveAgentsWiring
  resolveKey?: (ref: string) => Promise<string | undefined>
  /** Session default route, used to complete partial candidate route
   *  overrides (DSH requires provider and model as a pair). */
  defaultRoute?: () => { provider?: string; model?: string } | undefined
  verifier: () => { model: string; baseURL: string; apiKeyEnv: string; effort?: string; maxWorkers?: number; minIntervalMs?: number }
  /** Host-level default for manual /select when the request omits
   *  candidateTimeoutMs; sourced from config so strong slow models get the
   *  same time budget as autopilot instead of the runner's 300s floor. */
  candidateTimeoutMsDefault?: () => number
  /** Host-level config defaults for manual /select when the request omits
   *  them. Autopilot always passes its plan explicitly; these defaults let
   *  operator defaults ride every manual run the same way. */
  nEvaluationsDefault?: () => number
  pivotsDefault?: () => number
  /** Provisional margin gate for the winner state machine (ruling I.1). */
  marginThresholdDefault?: () => number
  /** Config default for the selection time budget when /select omits it. */
  selectTimeoutMsDefault?: () => number
  /** Directory for the per-selection audit pack written BEFORE cleanup
   *  (ruling I.5); null disables persistence. Derived from workspaceRoot. */
  artifactsDir?: string | null
  pythonPath?: string
  sidecarPath?: string
  workspaceRoot?: string
  selectionsFile?: string | null
  now?: () => number
  /** Settlement notice hook: called once per finished selection with the final
   *  record. Wired by the host layer to post the outcome into the SOURCE
   *  session (the operator keeps chatting there; without this the result is
   *  invisible outside the GUI panel). Best-effort; exceptions are contained. */
  notify?: (record: SelectionRecord) => void
  /** Degradation sink shared with the runner and the sidecar bridge; the
   *  process default when omitted. */
  diagnostics?: Diagnostics
  /** Deterministic overrides for tests: bypass live factory/workspace/bridge. */
  testing?: {
    factory?: CandidateFactory
    workspaces?: WorkspaceManager
    bridge?: { select(req: BridgeSelectRequest): Promise<BridgeSelectResult> }
    retrySleep?: RetrySleep
    /** Deterministic diff evidence for gate tests. */
    diffStat?: (cwd: string) => Promise<import('./candidates.js').DiffStatLite | null>
    /** Patch capture for artifact tests. */
    diffFull?: (cwd: string) => Promise<{ patch: string; truncated: boolean; untrackedFiles: string[] } | null>
  }
}

// Legacy single-account default: one in-flight verifier request. Kept as the
// explicit-workers=1 value for back-compat.
export const SELECTION_VERIFIER_MAX_WORKERS = 1
// Auto tier for the relay account-pool execution model: the relay round-robins
// accounts PER REQUEST, so concurrent verifier calls land on independent
// accounts — a stuck account stalls only its own call instead of the whole
// tournament. 4 is the conservative auto default (parallelism should not exceed
// the account pool size in practice); operators with bigger pools raise it via
// selectionVerifierWorkers.
export const AUTO_VERIFIER_WORKERS = 4

/** Resolve the tournament worker count from config: 0 = auto, 1..16 explicit.
 *  Call-count identity is unaffected (calls = nComparisons × criteriaCount × K);
 *  workers only change wall-clock time and account spread. */
export function effectiveVerifierWorkers(explicit: number | undefined | null): number {
  const value = Math.floor(Number(explicit ?? 0))
  if (!Number.isFinite(value) || value <= 0) return AUTO_VERIFIER_WORKERS
  return Math.min(16, value)
}

function safeHost(baseURL: string): string | null {
  try { return new URL(baseURL).host } catch { return null }
}

/** The public/manual request is canonical in protocol.ts. These fields are
 * internal orchestration metadata and are never accepted from HTTP callers. */
export interface StartSelectionBody extends SelectionStartRequest {
  trigger?: 'manual' | 'autopilot'
  policy?: SelectionRecord['policy']
  taskKind?: string
}

export class SelectionApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'SelectionApiError'
    this.status = status
    this.code = code
  }
}

export const SELECTIONS_HISTORY_LIMIT = 200
const SELECTIONS_FILE_MAX_BYTES = 4 * 1024 * 1024
const SEED_EVENT_CAP = 600
const MIN_SELECTION_TIMEOUT_MS = 30_000
// 600s ceiling (raised 2026-09-05 from 300s): at verifierEffort=max a single
// minimax-m3 comparison runs 70..100s wall clock, so even the minimal two-beat
// tournament needs ~300s and any deeper K/P needs real headroom. The budget
// still must not outlive a candidate window counterpart shared with abort.
const MAX_SELECTION_TIMEOUT_MS = 600_000
const DEFAULT_SELECTION_TIMEOUT_MS = 180_000

/** Keep every verifier phase on the same finite request budget. */
export function normalizeSelectionTimeoutMs(value: unknown, fallback?: number): number {
  const parsed = value === undefined ? (fallback ?? DEFAULT_SELECTION_TIMEOUT_MS) : Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_SELECTION_TIMEOUT_MS
  return Math.max(MIN_SELECTION_TIMEOUT_MS, Math.min(MAX_SELECTION_TIMEOUT_MS, Math.floor(parsed)))
}

export function normalizeMarginThreshold(value: unknown, fallback = PROVISIONAL_MARGIN_THRESHOLD): number {
  const parsed = value === undefined ? fallback : value
  // The wire contract says number: do not let JS coercion turn null into zero
  // or accept numeric strings at this provider-spend boundary.
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 0 || parsed > 0.5) {
    throw new SelectionApiError(400, 'margin-threshold-invalid', 'marginThreshold must be a finite number in [0,0.5]')
  }
  return parsed
}

/** Explicit per-request candidate timeout wins; otherwise the host-level config
 *  default applies; without either the runner keeps its 300s safety floor. */
export function normalizeCandidateTimeoutMs(value: unknown, fallback: number | undefined): number | undefined {
  const parsed = value === undefined ? fallback : Number(value)
  if (parsed === undefined || !Number.isFinite(parsed)) return undefined
  return Math.max(30_000, Math.min(1_800_000, Math.floor(parsed)))
}

export function defaultSelectionsFile(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.data', 'selections.jsonl')
}

export function defaultSidecarPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bridge', 'llm_verifier_sidecar.py')
}

/** Operator venv documented in HANDOFF §4 (bridge dependencies live there on
 *  the production Windows host). It is only used when it actually exists. */
const OPERATOR_BRIDGE_VENV_PYTHON = 'D:/tools/pyvenvs/llm-verifier-bridge/Scripts/python.exe'

/** Sidecar interpreter resolution: explicit `DSH_VA_PYTHON` wins; otherwise the
 *  documented operator venv when present; otherwise the PATH interpreter, so a
 *  fresh checkout (CI, another machine) gets a truthful `bridge_unavailable`
 *  health verdict instead of ENOENT on a drive letter that does not exist. */
export function defaultPythonPath(): string {
  if (process.env.DSH_VA_PYTHON) return process.env.DSH_VA_PYTHON
  if (existsSync(OPERATOR_BRIDGE_VENV_PYTHON)) return OPERATOR_BRIDGE_VENV_PYTHON
  return process.platform === 'win32' ? 'python' : 'python3'
}

export function defaultWorkspaceRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.data', 'selection-workspaces')
}

/** Cut a balanced completed-turn seed prefix: the log up to and including the
 * LAST turn/end. Seeding is skipped (not guessed) when no completed turn
 * exists or the prefix is too long to carry. */
export function cutBalancedSeed(
  events: readonly TrajectoryEvent[],
  cap = SEED_EVENT_CAP,
): { seed: readonly TrajectoryEvent[]; seedLength: number } | undefined {
  let lastEnd = -1
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === 'turn/end') { lastEnd = i; break }
  }
  if (lastEnd < 0) return undefined
  const seed = events.slice(0, lastEnd + 1)
  if (seed.length > cap) return undefined
  return { seed, seedLength: seed.length }
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text?: string } => !!b && typeof b === 'object' && (b as { type?: string }).type === 'text')
      .map((b) => b.text ?? '')
      .join('')
  }
  return ''
}

/** The problem candidates solve: an explicit body value wins; otherwise the
 * source session's most recent direct user task. Never a synthesized guess. */
export function problemFromEvents(events: readonly TrajectoryEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]
    if (ev.type !== 'user/message') continue
    const src = ((ev.data ?? {}) as { source?: { kind?: string } }).source ?? {}
    if (src.kind && src.kind !== 'user') continue
    const text = messageText((ev.data ?? {})['content'])
    if (text.trim()) return text.slice(0, 8000)
  }
  return undefined
}

function normalizeLoadedSelection(record: SelectionRecord): SelectionRecord {
  if (record.status !== 'running') return record
  return { ...record, status: 'failed', error: 'interrupted-by-reload', finishedAt: record.finishedAt ?? Date.now() }
}

const SAFE_SELECTION_ID = /^sel-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export interface OrphanReclaim {
  /** Candidate directories removed (known settled selection, not retained). */
  reclaimed: number
  /** Selection ids on disk with no record in the window (reported only). */
  unknown: number
  /** Removals that raised; each is a `workspaces.reclaim` diagnostic. */
  failed: number
}

function isSelectionRecord(value: unknown): value is SelectionRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<SelectionRecord>
  return typeof record.selectionId === 'string'
    && SAFE_SELECTION_ID.test(record.selectionId)
    && typeof record.status === 'string'
}

function safeChecks(input: unknown): ObjectiveCheck[] | undefined {
  if (input === undefined || input === null) return undefined
  if (!Array.isArray(input)) throw new SelectionApiError(400, 'checks-invalid', 'checks must be an array')
  if (input.length === 0) return undefined
  if (input.length > 5) throw new SelectionApiError(400, 'checks-too-many', 'at most 5 objective checks')
  return input.map((raw, i) => {
    const item = raw as Partial<ObjectiveCheck>
    if (!item || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80) {
      throw new SelectionApiError(400, 'check-name-invalid', 'checks[' + i + '].name must be a non-empty string <= 80 chars')
    }
    if (typeof item.command !== 'string' || !item.command.trim() || item.command.length > 2000) {
      throw new SelectionApiError(400, 'check-command-invalid', 'checks[' + i + '].command must be a non-empty string <= 2000 chars')
    }
    const timeoutMs = item.timeoutMs === undefined ? undefined
      : Math.max(1000, Math.min(300000, Math.floor(Number(item.timeoutMs))))
    return { name: item.name.trim(), command: item.command, timeoutMs }
  })
}

function requireRouteStr(v: unknown, key: string, index: number): string {
  if (typeof v !== 'string' || !v.trim()) throw new SelectionApiError(400, 'candidate-options-invalid', 'candidateOptions[' + index + '].' + key + ' must be a non-empty string')
  if (v.length > 160) throw new SelectionApiError(400, 'candidate-options-invalid', 'candidateOptions[' + index + '].' + key + ' must be <= 160 chars')
  return v.trim()
}

/** DSH agent routes come in pairs: a partial {provider}-only or {model}-only
 *  override makes the FIRST candidate turn fail with "no provider/model"（2026-08-28
 *  异质池首跑实测）。Complete the missing half from the session default route;
 *  refuse loudly when no default is available. */
export function completeRoutePair(route: { provider?: string; model?: string }, dft: { provider?: string; model?: string } | undefined, label: string): { provider?: string; model?: string } | undefined {
  const hasP = route.provider !== undefined
  const hasM = route.model !== undefined
  if (hasP === hasM) return hasP ? route : undefined
  const missing = hasP ? 'model' : 'provider'
  const fill = dft?.[missing]
  if (typeof fill !== 'string' || !fill) {
    throw new SelectionApiError(400, 'candidate-route-partial', label + ': 只给了 ' + (hasP ? 'provider' : 'model') + '——DSH 要求 route 成对出现（provider+model），且无法从会话默认路由补齐 ' + missing + '；请两个字段都给，或都不给（走默认路由）')
  }
  return hasP ? { provider: route.provider, model: fill } : { provider: fill, model: route.model }
}

/** Parse + merge the per-candidate route array over the shared defaults. */
export function safeCandidateOptions(input: unknown, shared: { provider?: string; model?: string }, dft?: { provider?: string; model?: string }): Array<{ provider?: string; model?: string }> | undefined {
  if (input === undefined || input === null) return undefined
  if (!Array.isArray(input)) throw new SelectionApiError(400, 'candidate-options-invalid', 'candidateOptions must be an array of {provider?, model?}')
  if (input.length === 0) throw new SelectionApiError(400, 'candidate-options-invalid', 'candidateOptions must not be empty')
  if (input.length > MAX_CANDIDATES) throw new SelectionApiError(400, 'candidate-options-invalid', 'candidateOptions allows at most ' + MAX_CANDIDATES + ' entries')
  return input.map((raw, i) => {
    const e = (raw ?? {}) as Record<string, unknown>
    if (typeof e !== 'object' || Array.isArray(e)) throw new SelectionApiError(400, 'candidate-options-invalid', 'candidateOptions[' + i + '] must be an object')
    for (const k of Object.keys(e)) {
      if (k !== 'provider' && k !== 'model') throw new SelectionApiError(400, 'candidate-options-invalid', 'candidateOptions[' + i + '] has unknown key: ' + k)
    }
    const provider = e.provider === undefined ? shared.provider : requireRouteStr(e.provider, 'provider', i)
    const model = e.model === undefined ? shared.model : requireRouteStr(e.model, 'model', i)
    // Never undefined inside the array: entries carry at least the fully
    // default route once normalized, so the runner annotation stays truthful.
    return completeRoutePair({ provider, model }, dft, 'candidateOptions[' + i + ']') ?? {}
  })
}

function safeProgressGuard(input: unknown): { intervalMs?: number; minScore?: number; graceChecks?: number; maxChecks?: number } | undefined {
  if (input === undefined || input === null) return undefined
  if (typeof input !== 'object' || Array.isArray(input)) throw new SelectionApiError(400, 'progress-guard-invalid', 'progressGuard must be an object')
  const o = input as Record<string, unknown>
  const out: { intervalMs?: number; minScore?: number; graceChecks?: number; maxChecks?: number } = {}
  for (const k of Object.keys(o)) {
    if (!['intervalMs', 'minScore', 'graceChecks', 'maxChecks'].includes(k)) throw new SelectionApiError(400, 'progress-guard-invalid', 'progressGuard has unknown key: ' + k)
  }
  if (o.intervalMs !== undefined) {
    const v = Number(o.intervalMs)
    if (!Number.isInteger(v) || v < 5000 || v > 600000) throw new SelectionApiError(400, 'progress-guard-invalid', 'intervalMs must be an integer in [5000, 600000]')
    out.intervalMs = v
  }
  if (o.minScore !== undefined) {
    const v = Number(o.minScore)
    if (!Number.isFinite(v) || v < 0 || v > 1) throw new SelectionApiError(400, 'progress-guard-invalid', 'minScore must be in [0,1]')
    out.minScore = v
  }
  if (o.graceChecks !== undefined) {
    const v = Number(o.graceChecks)
    if (!Number.isInteger(v) || v < 2 || v > 10) throw new SelectionApiError(400, 'progress-guard-invalid', 'graceChecks must be an integer in [2,10]')
    out.graceChecks = v
  }
  if (o.maxChecks !== undefined) {
    const v = Number(o.maxChecks)
    if (!Number.isInteger(v) || v < 1 || v > 30) throw new SelectionApiError(400, 'progress-guard-invalid', 'maxChecks must be an integer in [1,30]')
    out.maxChecks = v
  }
  return out
}

function safeCandidateInstructions(input: unknown, count: number): string[] | undefined {
  if (input === undefined || input === null) return undefined
  if (!Array.isArray(input) || input.length !== count) {
    throw new SelectionApiError(400, 'candidate-instructions-count-mismatch', 'candidateInstructions must contain exactly one string per candidate')
  }
  return input.map((value, index) => {
    if (typeof value !== 'string' || !value.trim()) {
      throw new SelectionApiError(400, 'candidate-instruction-invalid', 'candidateInstructions[' + index + '] must be a non-empty string')
    }
    return value.trim().slice(0, 2000)
  })
}

function safeCriteria(input: unknown): BridgeSelectRequest['criteria'] {
  if (input === undefined || input === null) {
    return { correctness: 'The candidate objectively completed the task, with concrete tool or test evidence backing the claim; unverified claims fail.' }
  }
  if (typeof input === 'object' && !Array.isArray(input) && Object.values(input as Record<string, unknown>).every((v) => typeof v === 'string')) {
    if (Object.keys(input as Record<string, unknown>).length === 0) throw new SelectionApiError(400, 'criteria-empty', 'criteria map must not be empty')
    return input as Record<string, string>
  }
  if (Array.isArray(input) && input.length > 0 && input.every((c) => c && typeof c === 'object' && typeof c.id === 'string' && typeof c.name === 'string' && typeof c.description === 'string')) {
    return input as Array<{ id: string; name: string; description: string }>
  }
  throw new SelectionApiError(400, 'criteria-invalid', 'criteria must be a {name: description} map or a list of {id,name,description}')
}

export class SelectionHost {
  private readonly deps: SelectionHostDeps
  private readonly diagnostics: Diagnostics
  private readonly now: () => number
  private readonly selections: SelectionRecord[] = []
  private active: { selectionId: string; controller: AbortController; run: Promise<void> | null } | null = null
  private readonly winners = new Map<string, SelectionAgentHandle>()
  /** Per-selection FIFO for retained-candidate operations (release,
   *  discard, shutdown disposal). Concurrent callers — GUI double-click,
   *  idle + agent/disposed cleanup racing, dispose() during a discard —
   *  run strictly one after another and observe sequential semantics. */
  private readonly winnerOps = new Map<string, Promise<unknown>>()
  private bridgeSingleton: VerifierBridge | null = null
  private workspaceManager: WorkspaceManager | null = null
  private disposed = false
  private readonly listeners = new Set<() => void>()
  private readonly selectionsFile: string | null
  /** Audit-pack collection is serialized: two passes must never race the same
   *  directory removal, and a pass must never overlap a write for an id it
   *  could not have observed. */
  private artifactGc: Promise<number> = Promise.resolve(0)
  private reclaiming: Promise<OrphanReclaim> | null = null
  /** True once the in-memory history is known to reflect the ledger: at
   *  least one record loaded from it, or one written to it by this process.
   *  Until then the window proves nothing about which packs are stale. */
  private ledgerKnown = false

  constructor(deps: SelectionHostDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.diagnostics = deps.diagnostics ?? defaultDiagnostics
    this.selectionsFile = deps.selectionsFile === undefined ? null : deps.selectionsFile
    if (this.selectionsFile) {
      // Audit packs live exactly as long as their record is in the history
      // window; a ledger that could not be read (or is empty) proves nothing
      // about what is stale, so collection waits for a successful load.
      if (this.loadSelections(this.selectionsFile) > 0) {
        this.ledgerKnown = true
        void this.collectArtifacts()
      }
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      // Counted, not warned: a warning would notify the diagnostics
      // subscribers, which re-enter emit() — a throwing listener must not
      // become an infinite loop.
      try { listener() } catch { this.diagnostics.count('selections.subscriber_error') }
    }
  }

  listSelections(): SelectionRecord[] { return this.selections.slice() }

  getSelection(selectionId: string): SelectionRecord | undefined {
    return this.selections.find((s) => s.selectionId === selectionId)
  }

  activeSelectionId(): string | null { return this.active?.selectionId ?? null }

  /** Provider tuples proven ready during this host's lifetime. */
  private readonly preflightOk = new Set<string>()

  private bridge(): { select(req: BridgeSelectRequest): Promise<BridgeSelectResult> } {
    if (this.deps.testing?.bridge) return this.deps.testing.bridge
    if (!this.bridgeSingleton) {
      this.bridgeSingleton = new VerifierBridge({
        pythonPath: this.deps.pythonPath ?? defaultPythonPath(),
        scriptPath: this.deps.sidecarPath ?? defaultSidecarPath(),
        diagnostics: this.diagnostics,
      })
    }
    return this.bridgeSingleton
  }

  /** One tiny asymmetric comparison proves the relay+model can actually
   *  score tags for selection; memoized per (baseURL, model, key env). A
   *  supported failure raises and the runner fails the selection before any
   *  candidate spend. */
  private async runVerifierPreflight(v: { model: string; baseURL: string; apiKeyEnv: string; effort?: string }, key: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<void> {
    const bridge = this.bridge()
    if (typeof (bridge as Partial<VerifierBridge>).preflight !== 'function') return
    // Effort changes tag-emission behavior (thinking traces shift where score
    // tokens land), so a changed thinking strength re-proves readiness.
    const tuple = v.baseURL + '|' + v.model + '|' + v.apiKeyEnv + '|' + (v.effort ?? '')
    if (this.preflightOk.has(tuple)) return
    const deadlineAt = this.now() + timeoutMs
    await retryTransientBridge((attempt) => (bridge as VerifierBridge).preflight({
      model: v.model,
      baseUrl: v.baseURL,
      apiKey: key,
      apiKeyEnv: v.apiKeyEnv,
      effort: v.effort,
      timeoutMs: attempt.timeoutMs,
      signal: attempt.signal,
    }), {
      signal,
      sleep: this.deps.testing?.retrySleep,
      deadlineAt,
      // Readiness gets the same bounded verifier budget as ranking; a slow
      // but valid relay must not be rejected by a separate hard-coded deadline.
      maxAttempts: 2,
      now: this.now,
      onRetry: (error, attempt) => this.diagnostics.warn('verifier.preflight_retry', error, { attempt, model: v.model }),
    })
    this.preflightOk.add(tuple)
  }

  /** Explicit operator-triggered selection. Throws SelectionApiError for the
   *  route to translate. The run completes asynchronously; the returned record
   *  is the RUNNING placeholder later replaced in place in the history list. */
  async start(body: StartSelectionBody, runtime?: { sourceCwd?: string }): Promise<SelectionRecord> {
    if (this.disposed) throw new SelectionApiError(503, 'selection-host-disposed', 'selection host is disposed')
    const sourceSessionId = typeof body.sourceSessionId === 'string' && body.sourceSessionId.trim() ? body.sourceSessionId.trim() : undefined
    let parent: ReturnType<SelectionsAgentProvider['get']>
    let problem = typeof body.problem === 'string' && body.problem.trim() ? body.problem.trim() : undefined
    let seed: { seed: readonly TrajectoryEvent[]; seedLength: number } | undefined
    let sourceCwd: string | undefined
    if (sourceSessionId) {
      if (!this.deps.agents) throw new SelectionApiError(503, 'agents-unavailable', 'agent registry not wired')
      parent = this.deps.agents.get(sourceSessionId)
      if (!parent) throw new SelectionApiError(404, 'source-session-not-found', 'source session is not live: ' + sourceSessionId)
      sourceCwd = runtime?.sourceCwd ?? parent.session.header?.cwd
      if (!problem) problem = problemFromEvents(parent.session.events)
      if (body.useSourceSeed !== false) seed = cutBalancedSeed(parent.session.events)
    } else if (typeof body.sourceCwd === 'string' && body.sourceCwd.trim()) {
      // Explicit operator-supplied Git workspace for a headless manual run.
      // The workspace adapter still creates isolated worktrees inside it, so
      // candidates never inherit the host process directory.
      sourceCwd = body.sourceCwd.trim()
    }
    if (!problem) throw new SelectionApiError(400, 'problem-required', 'problem is required when the source session has no direct user task')
    const hasCandidateOptions = body.candidateOptions !== undefined && body.candidateOptions !== null
    const nRaw = body.candidateCount === undefined
      ? (Array.isArray(body.candidateOptions) ? body.candidateOptions.length : 3)
      : Math.floor(Number(body.candidateCount))
    if (!Number.isInteger(nRaw) || nRaw < 1) throw new SelectionApiError(400, 'candidate-count-invalid', 'candidateCount must be an integer >= 1')
    const candidateCount = Math.min(nRaw, MAX_CANDIDATES)
    if (hasCandidateOptions && Array.isArray(body.candidateOptions) && body.candidateCount !== undefined && body.candidateOptions.length !== candidateCount) {
      throw new SelectionApiError(400, 'candidate-options-count-mismatch', 'candidateOptions has ' + body.candidateOptions.length + ' entries but candidateCount is ' + candidateCount + '; omit one of them or make them agree')
    }
    let dftRoute: { provider?: string; model?: string } | undefined
    try { dftRoute = this.deps.defaultRoute?.() } catch { dftRoute = undefined }
    const sharedRoute = completeRoutePair({ provider: body.candidateProvider, model: body.candidateModel }, dftRoute, 'candidateProvider/candidateModel')
    const candidateOptions = safeCandidateOptions(body.candidateOptions, sharedRoute ?? {}, dftRoute)
    const candidateInstructions = safeCandidateInstructions(body.candidateInstructions, candidateCount)
    const progressGuard = safeProgressGuard(body.progressGuard)
    const criteria = safeCriteria(body.criteria)
    const checks = safeChecks(body.checks)
    const verifierConf = this.deps.verifier()
    const selectTimeoutMs = normalizeSelectionTimeoutMs(body.selectTimeoutMs, this.deps.selectTimeoutMsDefault?.())
    // Isolation guard (2026-09-13 incident): without a resolvable Git source
    // cwd the workspace adapter degrades to a blank directory and candidates
    // then write through process.cwd(), i.e. the host process directory. That
    // injected percent.js/percent.test.js into the installed @deepseek-ai/dsh
    // package and crashed the runtime with a native Node assertion. Real
    // candidate rollouts therefore require a Git source workspace; refuse
    // loudly instead of spawning agents that can touch the host tree. Test
    // harnesses inject their own factory/workspace manager and stay exempt.
    const injectedHarness = this.deps.testing?.factory !== undefined || this.deps.testing?.workspaces !== undefined
    if (!sourceCwd && !injectedHarness) {
      throw new SelectionApiError(400, 'source-cwd-required', 'candidate selection requires a resolvable Git source session or workspace: without it candidates run in the host process directory and can overwrite host files')
    }
    const marginThreshold = normalizeMarginThreshold(
      body.marginThreshold,
      this.deps.marginThresholdDefault?.() ?? PROVISIONAL_MARGIN_THRESHOLD,
    )
    const key = this.deps.resolveKey ? await this.deps.resolveKey(verifierConf.apiKeyEnv) : undefined
    if (!key) throw new SelectionApiError(400, 'missing-api-key', 'verifier credential is not configured: ' + verifierConf.apiKeyEnv)

    // Everything from here to the claim is pure construction or read-only
    // inspection. Nothing below may have a side effect before admission is
    // decided, and nothing may throw AFTER the claim: a post-claim throw (e.g.
    // the live agent factory not being wired) used to leave `this.active` set
    // with run=null, so every later start() answered 429 selection-busy until
    // a reload and cancel() had nothing to abort.
    const testing = this.deps.testing ?? {}
    const workspaces = testing.workspaces ?? (this.workspaceManager ??= new IsolatedWorkspaceManager(this.deps.workspaceRoot ?? defaultWorkspaceRoot()))
    const factory = testing.factory ?? (() => {
      if (!this.deps.liveAgents) throw new SelectionApiError(503, 'live-agents-unavailable', 'live agent factory not wired')
      return makeLiveCandidateFactory({
        ctx: { agents: this.deps.liveAgents },
        parent,
        agentOptions: sharedRoute ?? {},
        agentPreset: body.agentPreset,
        // Autopilot candidates need to run real verification commands (e.g.
        // `node --test`), which spawn child processes. `workspace-write`
        // bundles approval=ask, while the child setup pins approval=never, so
        // every escalation request was silently unpromptable and the candidate
        // parked until candidate-timeout (2026-09-14: three candidates sat in
        // ranking for 10+ minutes behind one pending escalation). Autopilot
        // therefore uses the self-consistent full-access preset, whose
        // approval policy is never. Operators who want to approve each
        // escalation should run manual /select without this override.
        sandboxMode: body.trigger === 'autopilot' ? 'danger-full-access' : undefined,
      })
    })()
    const runner = new SelectionRunner({
      factory,
      workspaces,
      bridge: this.bridge(),
      preflight: (signal) => this.runVerifierPreflight(verifierConf, key, selectTimeoutMs, signal),
      diffStat: this.deps.testing?.diffStat ?? gitDiffStat,
      diffFull: this.deps.testing?.diffFull ?? gitDiffFull,
      sleep: testing.retrySleep,
      now: this.now,
      diagnostics: this.diagnostics,
    })
    // F5/I.5 — capture the EFFECTIVE configuration at start: later
    // build/reload/POST /config drift must never rewrite what actually ran.
    const configSnapshot: Record<string, unknown> = {
      trigger: body.trigger === 'autopilot' ? 'autopilot' : 'manual',
      candidateCount,
      candidateOptions: candidateOptions
        ? candidateOptions.map((route) => ({ provider: route?.provider ?? null, model: route?.model ?? null }))
        : [{ provider: sharedRoute?.provider ?? null, model: sharedRoute?.model ?? null, shared: true }],
      nEvaluations: body.nEvaluations ?? this.deps.nEvaluationsDefault?.() ?? null,
      pivots: body.pivots ?? this.deps.pivotsDefault?.() ?? null,
      candidateTimeoutMs: normalizeCandidateTimeoutMs(body.candidateTimeoutMs, this.deps.candidateTimeoutMsDefault?.()),
      selectTimeoutMs,
      marginThreshold,
      verifierModel: verifierConf.model,
      verifierEffort: verifierConf.effort ?? null,
      verifierBaseURLHost: safeHost(verifierConf.baseURL),
      taskKind: body.taskKind ?? body.policy?.taskKind ?? null,
      checksConfigured: checks ? checks.map((c) => c.name) : null,
      sourceCwd: sourceCwd ?? null,
    }
    // I.5: source attribution for the audit pack. The HEAD pins the source
    // repo state at start; the model is read from the session header when the
    // host exposes it (null stays honest when unknown). This is the last await
    // before the claim, so it must stay above the admission re-check.
    let sourceHeadAtStart: string | null = null
    let sourceModel: string | null = null
    if (sourceCwd && body.trigger === 'autopilot') {
      try { sourceHeadAtStart = (await gitRepoState(sourceCwd))?.head ?? null } catch (error) { sourceHeadAtStart = null; this.diagnostics.warn('source.head', error, { sourceCwd }) }
    }
    try {
      const header = parent?.session.header as { model?: string } | undefined
      sourceModel = header?.model ?? null
    } catch { sourceModel = null }

    // Admission must be re-checked HERE, immediately before the claim with no
    // await in between: the credential resolve and the HEAD read above yield,
    // so a busy-check at the top of this method lets two concurrent starts
    // both pass (TOCTOU — both runners would then burn real candidates
    // fighting over this.active). From the claim to `this.active.run = run`
    // the code is synchronous and cannot throw, so dispose() always finds a
    // run to await and a stuck claim is impossible.
    if (this.disposed) throw new SelectionApiError(503, 'selection-host-disposed', 'selection host is disposed')
    if (this.active) {
      throw new SelectionApiError(429, 'selection-busy', 'selection ' + this.active.selectionId + ' is already running; cancel it first')
    }
    const selectionId = 'sel-' + randomUUID()
    const controller = new AbortController()
    const placeholder: SelectionRecord = {
      selectionId,
      sourceSessionId: sourceSessionId ?? null,
      startedAt: this.now(),
      finishedAt: null,
      status: 'running',
      trigger: body.trigger === 'autopilot' ? 'autopilot' : 'manual',
      ...(body.policy ? { policy: body.policy } : {}),
      candidates: [],
      verifierModel: verifierConf.model,
    }
    this.active = { selectionId, controller, run: null }
    this.selections.unshift(placeholder)
    const evicted = this.selections.splice(SELECTIONS_HISTORY_LIMIT)
    // The running row is persisted now, not only at settlement: a process that
    // dies mid-run leaves an `interrupted-by-reload` record on the next load
    // instead of an unexplained gap, and its candidate directories become
    // attributable (and reclaimable) orphans instead of anonymous ones.
    // persist() never throws, so the admission claim stays atomic.
    if (this.selectionsFile) this.persist(placeholder)
    if (evicted.length > 0) void this.collectArtifacts()
    this.emit()

    const runInput: SelectionRunInput = {
      problem,
      candidateCount,
      workspaceRoot: this.deps.workspaceRoot ?? defaultWorkspaceRoot(),
      sourceSessionId,
      sourceCwd,
      strictWorkspaceSnapshot: body.trigger === 'autopilot',
      agentPreset: body.agentPreset,
      seed: seed?.seed,
      checks,
      criteria,
      groundTruthNote: body.groundTruthNote ?? null,
      nEvaluations: body.nEvaluations ?? this.deps.nEvaluationsDefault?.(),
      pivots: body.pivots ?? this.deps.pivotsDefault?.(),
      algorithmSeed: body.algorithmSeed,
      candidateOptions,
      candidateInstructions,
      trigger: body.trigger === 'autopilot' ? 'autopilot' : 'manual',
      ...(body.policy ? { policy: body.policy } : {}),
      taskKind: body.taskKind ?? body.policy?.taskKind,
      marginThreshold,
      recordSeed: {
        configSnapshot,
        sourceModel,
        sourceHeadAtStart,
      },
      progressGuard,
      onUpdate: (record) => { Object.assign(placeholder, record); this.emit() },
      candidateTimeoutMs: normalizeCandidateTimeoutMs(body.candidateTimeoutMs, this.deps.candidateTimeoutMsDefault?.()),
      selectTimeoutMs,
      selectionId,
      verifier: {
        model: verifierConf.model,
        baseUrl: verifierConf.baseURL,
        apiKey: key,
        apiKeyEnv: verifierConf.apiKeyEnv,
        effort: verifierConf.effort,
        maxWorkers: effectiveVerifierWorkers(verifierConf.maxWorkers),
        minIntervalMs: Math.max(0, Math.floor(verifierConf.minIntervalMs ?? 0)),
      },
      signal: controller.signal,
    }
    const run = (async () => {
      try {
        const { record, retained, artifacts } = await runner.run(runInput)
        await this.finishRun(placeholder, record, retained ?? undefined, artifacts)
      } catch (error) {
        const failed: SelectionRecord = {
          ...placeholder,
          status: 'failed',
          error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
          finishedAt: this.now(),
        }
        await this.finishRun(placeholder, failed, undefined)
      }
    })()
    this.active.run = run
    return { ...placeholder }
  }

  private async finishRun(placeholder: SelectionRecord, record: SelectionRecord, retained: { handle: SelectionAgentHandle } | undefined, artifacts?: SelectionRunResult['artifacts']): Promise<void> {
    const idx = this.selections.indexOf(placeholder)
    if (idx >= 0) this.selections[idx] = record
    else this.selections.unshift(record)
    if (retained) {
      if (record.trigger === 'autopilot') this.winners.set(record.selectionId, retained.handle)
      else {
        try { await retained.handle.dispose() } catch (error) {
          this.winners.set(record.selectionId, retained.handle)
          this.diagnostics.warn('winner.dispose', error, { selectionId: record.selectionId })
        }
      }
    }
    if (this.active?.selectionId === record.selectionId) this.active = null
    if (this.selectionsFile) this.persist(record)
    this.writeArtifact(record, artifacts)
    this.emit()
    if (record.trigger !== 'autopilot' && this.deps.notify) {
      try { this.deps.notify(record) } catch (error) { this.diagnostics.warn('selection.notify', error, { selectionId: record.selectionId }) }
    }
  }

  /** Abort the in-flight selection (no-op for finished ones). A record that
   *  already settled answers false even if the active slot is mid-clear, so a
   *  late cancel can never resurrect a terminal run. */
  cancel(selectionId: string): boolean {
    const record = this.selections.find((s) => s.selectionId === selectionId)
    if (record && record.status !== 'running') return false
    if (this.active?.selectionId !== selectionId) return false
    this.active.controller.abort()
    this.emit()
    return true
  }

  /** Await one selection's durable terminal record. The caller owns cancellation
   *  policy; aborting this wait does not implicitly cancel unrelated runs. */
  async waitFor(selectionId: string, signal?: AbortSignal): Promise<SelectionRecord> {
    const current = this.getSelection(selectionId)
    if (!current) throw new SelectionApiError(404, 'selection-not-found', 'selection not found: ' + selectionId)
    if (current.status !== 'running') return current
    if (signal?.aborted) throw new SelectionApiError(499, 'selection-wait-aborted', 'selection wait aborted')
    return await new Promise<SelectionRecord>((resolve, reject) => {
      let unsubscribe = () => {}
      const cleanup = () => {
        unsubscribe()
        signal?.removeEventListener('abort', onAbort)
      }
      const check = () => {
        const record = this.getSelection(selectionId)
        if (!record) { cleanup(); reject(new SelectionApiError(404, 'selection-not-found', 'selection not found: ' + selectionId)); return }
        if (record.status !== 'running') { cleanup(); resolve(record) }
      }
      const onAbort = () => { cleanup(); reject(new SelectionApiError(499, 'selection-wait-aborted', 'selection wait aborted')) }
      unsubscribe = this.subscribe(check)
      signal?.addEventListener('abort', onAbort, { once: true })
      check()
    })
  }

  /** Chain one retained-candidate operation behind whatever is already in
   *  flight for the same selection. A failed predecessor never poisons the
   *  chain; the map entry is dropped once the last operation settles. */
  private serializeWinnerOp<T>(selectionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.winnerOps.get(selectionId) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    this.winnerOps.set(selectionId, next)
    void next.then(
      () => { if (this.winnerOps.get(selectionId) === next) this.winnerOps.delete(selectionId) },
      () => { if (this.winnerOps.get(selectionId) === next) this.winnerOps.delete(selectionId) },
    )
    return next
  }

  /** Release the live candidate handle while retaining its persisted session
   *  and workspace. Failed disposal stays retained so a later call can retry. */
  releaseWinner(selectionId: string): Promise<'released' | 'not-retained'> {
    return this.serializeWinnerOp(selectionId, () => this.releaseWinnerNow(selectionId))
  }

  private async releaseWinnerNow(selectionId: string): Promise<'released' | 'not-retained'> {
    const handle = this.winners.get(selectionId)
    if (!handle) return 'not-retained'
    await handle.dispose()
    this.winners.delete(selectionId)
    this.emit()
    return 'released'
  }

  /** Destroy the retained candidate outright (winner OR fallback). Each
   *  operation is idempotent; discardedAt is durable only after handle,
   *  workspace, session journal, and the audit pack have all settled. */
  discardWinner(selectionId: string): Promise<boolean> {
    return this.serializeWinnerOp(selectionId, () => this.discardWinnerNow(selectionId))
  }

  private async discardWinnerNow(selectionId: string): Promise<boolean> {
    const record = this.selections.find((s) => s.selectionId === selectionId)
    const slot = record ? (record.winner ?? record.fallback) : undefined
    // The guard is evaluated inside the per-selection chain, so a second
    // discard that arrived while the first was still removing the worktree
    // sees discardedAt set and answers false instead of racing the removal.
    if (!record || !slot || slot.discardedAt !== undefined) return false
    await this.releaseWinnerNow(selectionId)
    const manager = this.deps.testing?.workspaces
      ?? (this.workspaceManager ??= new IsolatedWorkspaceManager(this.deps.workspaceRoot ?? defaultWorkspaceRoot()))
    await manager.remove(slot.workspace)
    await manager.purgeSessionRecord?.(slot.workspace)
    slot.discardedAt = this.now()
    if (this.selectionsFile) this.persist(record)
    // Audit pack is rewritten AFTER the record update so post-audit fields
    // (delivery, discardedAt) are captured before any restart loses them.
    this.writeArtifact(record)
    this.emit()
    return true
  }

  snapshot(): SelectionSnapshot {
    return {
      active: this.active?.selectionId ?? null,
      retainedWinners: [...this.winners.keys()],
      selections: this.selections.slice(0, 20),
    }
  }

  /** Returns how many records were loaded; 0 also when the ledger is absent
   *  or unreadable. */
  private loadSelections(file: string): number {
    try {
      let skippedRows = 0
      const loaded = readJsonlLedger(file, {
        limit: SELECTIONS_HISTORY_LIMIT,
        validate: isSelectionRecord,
        idOf: record => record.selectionId,
        normalize: normalizeLoadedSelection,
        onSkippedRow: () => { skippedRows += 1 },
      })
      // One entry per load, not one per row: a large torn ledger must not
      // flush the whole diagnostics window with its own corruption.
      if (skippedRows > 0) this.diagnostics.warn('selections.corrupt_rows', skippedRows + ' unreadable row(s) skipped while loading the selection ledger', { file, rows: skippedRows })
      if (ledgerExceeds(file, SELECTIONS_FILE_MAX_BYTES)) {
        this.diagnostics.count('selections.compact')
        compactJsonlLedger(file, loaded)
      }
      this.selections.push(...loaded)
      return loaded.length
    } catch (error) {
      this.diagnostics.warn('selections.load', error, { file })
      return 0
    }
  }

  /** Persist a settled record again after an out-of-band mutation (relay
   *  timestamps, delivery audit): the ledger line wins by recency on reload,
   *  and the audit pack's record.json re-reads from the same object. */
  pubRecord(record: SelectionRecord): void {
    if (!this.selections.includes(record)) return
    if (this.selectionsFile) this.persist(record)
    this.writeArtifact(record)
    this.emit()
  }

  private persist(record: SelectionRecord): void {
    const file = this.selectionsFile
    if (!file) return
    this.ledgerKnown = true
    try {
      if (ledgerExceeds(file, SELECTIONS_FILE_MAX_BYTES)) {
        this.diagnostics.count('selections.compact')
        compactJsonlLedger(file, this.selections.slice(0, SELECTIONS_HISTORY_LIMIT))
        return
      }
      appendJsonlLedger(file, record)
    } catch (error) { this.diagnostics.warn('selections.append', error, { file, selectionId: record.selectionId }) }
  }

  /** Audit pack (ruling I.5/G, F6): one directory per selection, written at
   *  settle BEFORE any workspace cleanup can free the evidence it holds —
   *  record.json plus raw per-candidate materials. discard rewrites only the
   *  record so settlement attribution stays immutable. */
  private artifactDir(): string | null {
    return this.deps.artifactsDir ?? null
  }

  private writeArtifact(record: SelectionRecord, artifacts?: SelectionRunResult['artifacts']): void {
    const dir = this.artifactDir()
    if (!dir || !SAFE_SELECTION_ID.test(record.selectionId)) return
    try {
      const selDir = path.join(dir, record.selectionId)
      mkdirSync(path.join(selDir, 'traces'), { recursive: true })
      mkdirSync(path.join(selDir, 'diffs'), { recursive: true })
      atomicWriteFile(path.join(selDir, 'record.json'), JSON.stringify({ artifactWrittenAt: this.now(), record }, null, 1) + String.fromCharCode(10))
      if (artifacts) {
        for (let i = 0; i < artifacts.traces.length; i += 1) {
          const trace = artifacts.traces[i]
          if (typeof trace === 'string' && trace) {
            atomicWriteFile(path.join(selDir, 'traces', 'c' + i + '.txt'), trace)
          }
        }
        for (let i = 0; i < artifacts.diffPatches.length; i += 1) {
          const d = artifacts.diffPatches[i]
          if (d) {
            atomicWriteFile(
              path.join(selDir, 'diffs', 'c' + i + '.patch'),
              d.patch + String.fromCharCode(10) + '# truncated=' + d.truncated + '; untracked=' + (d.untrackedFiles.join(' ') || 'none') + String.fromCharCode(10),
            )
          }
        }
      }
    } catch (error) { this.diagnostics.warn('artifact.write', error, { selectionId: record.selectionId }) }
  }

  /** Remove every audit pack whose selection is no longer in the history
   *  window. The window (SELECTIONS_HISTORY_LIMIT newest records) is the only
   *  retention policy this host has: a record outside it can no longer be
   *  listed, discarded, or relayed, so its pack is unreachable evidence and
   *  the directory would otherwise grow without bound. Only entries shaped
   *  like a selection id are considered — dirs `sel-…` and the legacy flat
   *  `sel-….json` — so nothing else in the directory is touched. Resolves to
   *  the number of packs removed; never rejects. */
  collectArtifacts(): Promise<number> {
    const dir = this.artifactDir()
    if (!dir || !this.ledgerKnown) return Promise.resolve(0)
    const pass = async (): Promise<number> => {
      let entries: string[]
      try { entries = readdirSync(dir) } catch { return 0 }
      const live = new Set(this.selections.map((record) => record.selectionId))
      let removed = 0
      for (const entry of entries) {
        const selectionId = entry.endsWith('.json') ? entry.slice(0, -'.json'.length) : entry
        if (!SAFE_SELECTION_ID.test(selectionId) || live.has(selectionId) || this.active?.selectionId === selectionId) continue
        try {
          await rm(path.join(dir, entry), { recursive: true, force: true })
          removed += 1
        } catch (error) { this.diagnostics.warn('artifacts.gc', error, { selectionId }) }
      }
      if (removed > 0) this.diagnostics.count('artifacts.gc_removed', removed)
      return removed
    }
    this.artifactGc = this.artifactGc.then(pass, pass)
    return this.artifactGc
  }

  /** Reclaim candidate directories left behind by a process that died
   *  mid-selection, or by a loser cleanup that failed. Two rules keep this
   *  safe for the operator:
   *   - a directory whose selection is known (in the history window) is
   *     reclaimed unless it is that record's retained winner/fallback slot
   *     (`discardedAt` unset) or the selection is running right now;
   *   - a directory with no record at all is reported, never removed: it may
   *     be a retained manual winner whose record aged out of the window, and
   *     deleting an operator's live worktree is the one failure worse than a
   *     leak. Manual and autopilot winners keep their own lifecycles.
   *  Concurrent calls share one pass. Never rejects. */
  reclaimOrphanWorkspaces(): Promise<OrphanReclaim> {
    if (this.reclaiming) return this.reclaiming
    const run = async (): Promise<OrphanReclaim> => {
      const summary: OrphanReclaim = { reclaimed: 0, unknown: 0, failed: 0 }
      const manager = this.deps.testing?.workspaces
        ?? (this.workspaceManager ??= new IsolatedWorkspaceManager(this.deps.workspaceRoot ?? defaultWorkspaceRoot()))
      if (!manager.listManaged) return summary
      let dirs: Array<{ selectionId: string; index: number; dir: string }>
      try { dirs = await manager.listManaged() } catch (error) { this.diagnostics.warn('workspaces.list', error); return summary }
      const unknownIds = new Set<string>()
      for (const entry of dirs) {
        if (this.disposed) break
        if (this.active?.selectionId === entry.selectionId) continue
        const record = this.selections.find((s) => s.selectionId === entry.selectionId)
        if (!record) { unknownIds.add(entry.selectionId); continue }
        if (record.status === 'running') continue
        const slot = record.winner ?? record.fallback
        if (slot && slot.index === entry.index && slot.discardedAt === undefined) continue
        // Prefer the workspace path the record knows (the candidate cwd may be
        // a sub-directory of the worktree root, and the session-store key was
        // derived from it); fall back to the directory itself when the record
        // points elsewhere (ledger copied from another machine).
        const known = (record.candidates ?? []).find((candidate) => candidate.index === entry.index)?.workspace
        const inside = known ? path.relative(entry.dir, known) : '..'
        const target = known && inside !== '' && !inside.startsWith('..') && !path.isAbsolute(inside) ? known : entry.dir
        try {
          await manager.remove(target)
          await manager.purgeSessionRecord?.(target)
          summary.reclaimed += 1
        } catch (error) {
          summary.failed += 1
          this.diagnostics.warn('workspaces.reclaim', error, { selectionId: entry.selectionId, candidate: entry.index })
        }
      }
      summary.unknown = unknownIds.size
      if (summary.reclaimed > 0) this.diagnostics.count('workspaces.reclaimed', summary.reclaimed)
      if (summary.unknown > 0) {
        this.diagnostics.warn('workspaces.unknown', summary.unknown + ' candidate workspace director' + (summary.unknown === 1 ? 'y has' : 'ies have') + ' no record in the history window; left in place for the operator', { selectionIds: [...unknownIds].slice(0, 5).join(',') })
      }
      return summary
    }
    this.reclaiming = run().finally(() => { this.reclaiming = null })
    return this.reclaiming
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const active = this.active
    active?.controller.abort()
    if (active?.run) {
      try { await active.run } catch { /* the terminal record contains the failure */ }
    }
    // Shutdown disposal joins the same per-selection chain as release/discard,
    // so a discard that is mid-flight when the host goes down cannot dispose
    // the same handle twice or observe a half-removed worktree.
    await Promise.all([...this.winners.keys()].map(async (id) => {
      try { await this.serializeWinnerOp(id, () => this.releaseWinnerNow(id)) } catch (error) { this.diagnostics.warn('winner.release', error, { selectionId: id, phase: 'dispose' }) }
    }))
    if (this.bridgeSingleton) {
      try { await this.bridgeSingleton.dispose() } catch (error) { this.diagnostics.warn('sidecar.dispose', error) }
      this.bridgeSingleton = null
    }
    this.listeners.clear()
  }
}
