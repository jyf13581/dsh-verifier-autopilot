/** Host lifecycle and orchestration for legacy verification plus Best-of-N.
 *
 * Transport registration belongs to api.ts/index.ts; this module owns runtime
 * state, scheduling, persistence, source-session notifications, and cleanup.
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, boundContextSummary, type UserMessage } from '@deepseek-ai/dsh-llm'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  buildVerifierPrompt, decideFeedback, noDefectLaneCount, resolveKey, verifyFive,
  type AggregateResult,
} from './verifier.js'
import { VerificationCoordinator, type ScheduleEntry, type RunContext } from './coordinator.js'
import { Config, cleanConfig, validateConfigPatch } from './config.js'
import {
  PLUGIN_SOURCE_NAME, auditAggregateCitations, auditFindingCitation,
  feedbackSentCount, flatten, traceFor, turnBounds, turnGateDecision,
  type EventRecord,
} from './evidence.js'
import { appendJsonlLedger, compactJsonlLedger, ledgerExceeds, readJsonlLedger } from './ledger.js'
import { SelectionHost } from './selection/host.js'
import { runChecks } from './selection/checks.js'
import { evaluateDelivery } from './selection/candidates.js'
import { buildAutopilotContext, buildAutopilotRelay, planAutopilotTask } from './selection/autopilot.js'
import { gitRepoState, resolveAutopilotSourceCwd } from './selection/live.js'
import { createModelProber, type ModelProber } from './selection/probe.js'

export type Credentials = { resolve?: (ref: string) => Promise<{ value?: string } | undefined> }
export type Agent = { id: string; session: { events: readonly EventRecord[]; header?: { cwd?: string; parentSession?: string } }; ctx: Context; followup: (message: UserMessage) => void | Promise<void> }
export type WebRoute = { kind: 'exact'; path: string; handler: (req: any, res: any) => void | Promise<void> }
export type HostContext = Context & { webServer: { register(route: WebRoute): () => void }; credentials?: Credentials; agents?: { list(): Agent[]; get(id: string): Agent | undefined }; llm?: { listModels(provider: string): Promise<Array<{ id: string; provider?: string }>> } }

/** Phase 2 durability: finished records append to a JSONL trail so history
 *  survives hot reloads and stays queryable per session/turn. The trail is
 *  bounded (in-memory window + startup compaction) and its loss is never
 *  allowed to break verification. */
export const VERIFICATION_HISTORY_LIMIT = 500
const RECORDS_FILE_MAX_BYTES = 4 * 1024 * 1024

export function defaultRecordsFile(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.data', 'records.jsonl')
}

function normalizeLoadedRecord(record: RecordState): RecordState {
  if (record.status !== 'running') return record
  // A run that was in-flight during a reload can never finish honestly.
  return { ...record, status: 'failed', error: 'interrupted-by-reload', finishedAt: record.finishedAt ?? Date.now() }
}

function isRecordState(value: unknown): value is RecordState {
  return Boolean(value && typeof value === 'object'
    && typeof (value as Partial<RecordState>).id === 'string'
    && typeof (value as Partial<RecordState>).status === 'string')
}

function loadPersistedRecords(file: string): RecordState[] {
  const loaded = readJsonlLedger(file, {
    limit: VERIFICATION_HISTORY_LIMIT,
    validate: isRecordState,
    normalize: normalizeLoadedRecord,
  })
  if (ledgerExceeds(file, RECORDS_FILE_MAX_BYTES)) {
    try { compactJsonlLedger(file, loaded) } catch { /* best-effort compaction */ }
  }
  return loaded
}

export class VerifyAbortedError extends Error {
  constructor() {
    super('verification-aborted')
    this.name = 'VerifyAbortedError'
  }
}

export type RecordState = {
  id: string
  sessionId: string
  turn: number
  turnEndSeq: number
  status: 'running' | 'completed' | 'partial' | 'failed' | 'skipped'
  startedAt: number
  finishedAt?: number
  aggregate?: AggregateResult
  feedbackSent: boolean
  feedbackError?: string
  /** set when the divergence guard blocked a would-be feedback trigger */
  suppressedFeedback?: { median: number; noDefectLanes: number; validLanes: number }
  /** Feedback is intentionally withheld when no valid lane supplied an
   * independent tool-result citation for a concrete defect. */
  feedbackSuppressed?: { reason: 'no-independent-evidence'; defectFindings: number; independentFindings: number }
  /** set when the turn was classified as pure no-op noise and verification was skipped */
  skippedReason?: string
  /** aggregated [E*] citation audit over valid lanes' findings */
  citationAudit?: { defectFindings: number; defectFindingsWithoutCitation: number; findingsCitingUnknownIds: number; findingsCitingHistoricalVerdict: number; findingsWithoutIndependentCitation: number }
  traceStats?: { eventCount: number; renderedEventCount: number; toolEventCount: number; traceChars: number; evidenceSignalCount: number; passSignalCount: number; evidenceSummaryChars: number }
  error?: string
}

const DEFAULT_FEEDBACK_TIMEOUT_MS = 15_000

/** A Host followup has no cancellation API, so bound how long it can occupy a
 * coordinator slot while still observing lifecycle disposal. */
function awaitFollowupWithFence(operation: Promise<void>, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      settle()
    }
    const onAbort = (): void => finish(() => reject(new Error('feedback-aborted')) )
    const timer = setTimeout(() => finish(() => reject(new Error('feedback-timeout'))), timeoutMs)
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      () => finish(() => resolve()),
      error => finish(() => reject(error)),
    )
  })
}

export class VerifierHost {
  private config: Config
  private readonly agents = new Map<string, Agent>()
  /** per-agent status-listener revocation, keyed by agent id */
  private readonly agentListeners = new Map<string, () => void>()
  private readonly records: RecordState[] = []
  private readonly listeners = new Set<() => void>()
  private readonly disposers: Array<() => void> = []
  private readonly coordinator: VerificationCoordinator<Agent, RecordState | undefined>
  private disposed = false
  /** null disables persistence (tests/embedded use); the injected Host enables it */
  private readonly recordsFile: string | null
  private readonly feedbackTimeoutMs: number
  /** Best-of-N selection host (manual trigger plus first-step autopilot). */
  readonly selections: SelectionHost
  /** Autopilot winners live only until the source turn reaches idle. */
  private readonly autopilotCleanup = new Map<string, Set<string>>()
  /** Background selections are cancelled when their source session disappears. */
  private readonly autopilotActive = new Map<string, Set<string>>()

  /** Candidate-model liveness prober, memoized per (baseURL, key) pair so
   *  config churn never keeps a stale credential around. */
  private proberState: { baseURL: string; apiKey: string; instance: ModelProber } | null = null

  private proberFor(baseURL: string, apiKey: string): ModelProber {
    if (!this.proberState || this.proberState.baseURL !== baseURL || this.proberState.apiKey !== apiKey) {
      this.proberState = { baseURL, apiKey, instance: createModelProber({ baseURL, apiKey }) }
    }
    return this.proberState.instance
  }

  constructor(private readonly ctx: HostContext, config: Config, options: { recordsFile?: string | null; feedbackTimeoutMs?: number; selectionsFile?: string | null; selectionsTesting?: ConstructorParameters<typeof SelectionHost>[0]['testing'] } = {}) {
    this.config = config
    this.recordsFile = options.recordsFile === undefined ? null : options.recordsFile
    this.feedbackTimeoutMs = Number.isFinite(options.feedbackTimeoutMs)
      ? Math.max(1, Math.floor(options.feedbackTimeoutMs as number))
      : DEFAULT_FEEDBACK_TIMEOUT_MS
    this.coordinator = new VerificationCoordinator<Agent, RecordState | undefined>({
      run: (entry, runContext) => this.executeEntry(entry, runContext),
    })
    this.selections = new SelectionHost({
      agents: this.ctx.agents as never,
      liveAgents: this.ctx.agents as never,
      defaultRoute: () => {
        try {
          return (this.ctx.get('agentDefaultModel') as { currentSelection?: () => { provider?: string; model?: string } } | undefined)?.currentSelection?.()
        } catch { return undefined }
      },
      resolveKey: (ref) => resolveKey(this.ctx.credentials, ref),
      verifier: () => ({ model: this.config.model, baseURL: this.config.baseURL, apiKeyEnv: this.config.apiKeyEnv, effort: this.config.verifierEffort, maxWorkers: this.config.selectionVerifierWorkers, minIntervalMs: this.config.verifierMinIntervalMs }),
      candidateTimeoutMsDefault: () => this.config.selectionCandidateTimeoutMs,
      nEvaluationsDefault: () => this.config.selectionEvaluations,
      pivotsDefault: () => this.config.selectionPivots,
      marginThresholdDefault: () => this.config.selectionMarginThreshold,
      selectTimeoutMsDefault: () => this.config.selectionSelectTimeoutMs,
      // I.5 audit pack sits next to the ledger; disabled when the ledger is.
      artifactsDir: options.selectionsFile == null ? null : path.join(path.dirname(options.selectionsFile), 'selection-artifacts'),
      selectionsFile: options.selectionsFile === undefined ? null : options.selectionsFile,
      testing: options.selectionsTesting,
      notify: (record) => this.notifySelectionSettlement(record),
    })
  }

  private async handleAutopilotPreStep(
    agent: Agent,
    payload: { messages: UserMessage[]; turn: number; step: number; signal: AbortSignal },
    next: () => Promise<{ kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] }>,
  ): Promise<{ kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] }> {
    if (this.disposed || this.config.selectionMode === 'off' || payload.step !== 1 || agent.session.header?.parentSession) return next()
    const decision = await next()
    if (decision.kind === 'reject') return decision

    // Downstream pre-step transforms own the accepted message boundary. Build
    // both admission and relay input from that same decision, never the raw
    // claimed inbox batch.
    const direct = decision.messages.filter((message) => message.source?.kind === 'user')
    if (direct.length === 0 || direct.some((message) => message.content.some((block) => block.type !== 'text'))) return decision
    const task = direct.map((message) => flatten(message.content)).filter(Boolean).join('\n\n').trim()
    if (!task || task.length > 32_000) return decision

    const preferredModels = this.config.selectionModels.split(',').map((model) => model.trim()).filter(Boolean)
    const policy = {
      mode: this.config.selectionMode,
      provider: this.config.selectionProvider,
      preferredModels,
      modelStrategy: this.config.selectionModelStrategy,
      standardCandidates: this.config.selectionStandardCandidates,
      deepCandidates: this.config.selectionDeepCandidates,
      nEvaluations: this.config.selectionEvaluations,
      candidateTimeoutMs: this.config.selectionCandidateTimeoutMs,
      selectTimeoutMs: this.config.selectionSelectTimeoutMs,
    } as const
    // Cheap classification first: session-control/status messages and unsafe
    // side effects never call model discovery or touch a workspace.
    const preliminary = planAutopilotTask(task, preferredModels, policy)
    if (!preliminary.admitted) return decision
    const sourceCwd = await resolveAutopilotSourceCwd(task, agent.session.header?.cwd)
    if (!sourceCwd) return decision

    let availableModels: string[] = preferredModels.slice()
    let catalogAvailable = true
    try {
      const catalogModels = await this.ctx.llm?.listModels(this.config.selectionProvider)
      if (catalogModels) availableModels = [...new Set([...preferredModels, ...catalogModels.map((model) => model.id)])]
    } catch {
      // A provider catalog is discovery metadata, not an allowlist. Keep the
      // operator-supplied model IDs and let the real probe decide liveness.
      catalogAvailable = false
    }
    payload.signal.throwIfAborted()
    // Liveness before planning (ruling P-C): the catalog lists models that may
    // be dead for days. Probe every configured model, including custom IDs that
    // a provider catalog does not advertise, and drop only confirmed failures.
    let probeEvidence: Record<string, boolean> | undefined
    if (this.config.selectionProbeEnabled) {
      try {
        const probeKey = await resolveKey(this.ctx.credentials, this.config.apiKeyEnv)
        if (probeKey) {
          const prober = this.proberFor(this.config.baseURL, probeKey)
          const alive: string[] = []
          const dead: string[] = []
          for (const model of preferredModels) {
            (await prober.probe(model) ? alive : dead).push(model)
          }
          if (alive.length > 0 || dead.length === 0) {
            const deadSet = new Set(dead)
            availableModels = [...alive, ...availableModels.filter((m) => !deadSet.has(m) && !alive.includes(m))]
            if (dead.length > 0 || !catalogAvailable) probeEvidence = Object.fromEntries(dead.map((m) => [m, false]).concat(alive.map((m) => [m, true])))
          } else if (dead.length > 0) {
            // All configured models are dead: never roll the whole pool onto a
            // corpse or silently weaken the selection gates.
            return decision
          }
        }
      } catch { /* probing is advisory only when the provider key is unavailable */ }
    }
    const plan = planAutopilotTask(task, availableModels, policy)
    if (!plan.admitted || !plan.depth || !plan.candidateCount || !plan.nEvaluations || !plan.candidateOptions || !plan.candidateInstructions || !plan.criteria) return decision

    const context = buildAutopilotContext(agent.session.events, task)
    // Autopilot is advisory and must never hold the source turn hostage to a
    // slow free relay. The explicit /select API remains awaitable; this path
    // starts a background selection and returns the original decision now.
    let selectionId: string | null = null
    const cancel = () => { if (selectionId) this.selections.cancel(selectionId) }
    payload.signal.addEventListener('abort', cancel, { once: true })
    try {
      const started = await this.selections.start({
        sourceSessionId: agent.id,
        problem: context,
        candidateCount: plan.candidateCount,
        candidateOptions: plan.candidateOptions,
        candidateInstructions: plan.candidateInstructions,
        criteria: plan.criteria,
        nEvaluations: plan.nEvaluations,
        pivots: this.config.selectionPivots,
        candidateTimeoutMs: plan.candidateTimeoutMs,
        selectTimeoutMs: plan.selectTimeoutMs,
        useSourceSeed: false,
        trigger: 'autopilot',
        taskKind: plan.taskKind,
        policy: {
          depth: plan.depth,
          modelStrategy: plan.modelStrategy ?? 'quality-first',
          candidateCount: plan.candidateCount,
          nEvaluations: plan.nEvaluations,
          pivots: this.config.selectionPivots,
          verifierEffort: this.config.verifierEffort,
          taskKind: plan.taskKind,
          probes: probeEvidence,
          contextChars: context.length,
          models: plan.candidateOptions.map((route) => route.model),
        },
      }, { sourceCwd })
      selectionId = started.selectionId
      if (payload.signal.aborted) {
        this.selections.cancel(selectionId)
        payload.signal.throwIfAborted()
      }
      const sourceId = String(agent.id)
      const active = this.autopilotActive.get(sourceId) ?? new Set<string>()
      active.add(selectionId)
      this.autopilotActive.set(sourceId, active)
      // Detach all slow work from the pre-step promise. The source task enters
      // immediately; only a completed winner is relayed later, when the source
      // agent is still alive. Failures are observable in the selection ledger.
      void this.selections.waitFor(selectionId).then((record) => {
        const current = this.autopilotActive.get(sourceId)
        current?.delete(selectionId as string)
        if (current && current.size === 0) this.autopilotActive.delete(sourceId)
        payload.signal.removeEventListener('abort', cancel)
        // Ruling I.2: relay every terminal outcome, not only winners — an
        // abstain or insufficient_evidence is exactly the information the
        // source turn needs. Outcome-less legacy records never reach here.
        if (record.status !== 'completed' || !record.outcome || this.disposed) return
        if (this.ctx.agents?.get(sourceId) !== agent) return
        const retained = record.winner ?? record.fallback
        if (retained) {
          const pending = this.autopilotCleanup.get(sourceId) ?? new Set<string>()
          pending.add(selectionId as string)
          this.autopilotCleanup.set(sourceId, pending)
        }
        record.timing = { ...(record.timing ?? {}), relayedAt: Date.now() }
        // Ledger + artifact must see relayedAt now, not at some later discard:
        // a hot reload between relay and cleanup would otherwise erase the mark.
        this.selections.pubRecord(record)
        void Promise.resolve(agent.followup(createUserMessage({
          source: { kind: 'plugin', plugin: PLUGIN_SOURCE_NAME + '/autopilot', form: 'relay' },
          content: [{ type: 'text', text: buildAutopilotRelay(record) }],
        }))).catch(() => undefined)
      }).catch(() => {
        const current = this.autopilotActive.get(sourceId)
        current?.delete(selectionId as string)
        if (current && current.size === 0) this.autopilotActive.delete(sourceId)
        payload.signal.removeEventListener('abort', cancel)
      })
      return decision
    } catch {
      // The selection admission itself is the only synchronous failure point.
      // Once admitted, its terminal outcome is handled by the background waiter.
      payload.signal.removeEventListener('abort', cancel)
      payload.signal.throwIfAborted()
      return decision
    }
  }

  private async cleanupAutopilotWinners(sourceSessionId: string): Promise<void> {
    const pending = this.autopilotCleanup.get(sourceSessionId)
    if (!pending) return
    for (const selectionId of [...pending]) {
      try {
        // G-4 post-audit BEFORE discard: compare the source repo state against
        // the start-time snapshot. Audited-but-unevidenced integration reports
        // 'no'; observed HEAD/dirty evidence without running tests can only be
        // 'unknown' — 'yes' requires deterministic passing tests, which this
        // hook intentionally never runs on the user's repository.
        const rec = this.selections.getSelection(selectionId)
        const slot = rec ? (rec.winner ?? rec.fallback) : undefined
        if (rec && slot && slot.discardedAt === undefined && !rec.delivery) {
          const cwd = typeof rec.configSnapshot?.sourceCwd === 'string' ? rec.configSnapshot.sourceCwd as string : undefined
          if (!cwd) {
            rec.delivery = { audited: false, delivered: 'unknown', note: 'no source cwd in config snapshot' }
          } else {
            try {
              const state = await gitRepoState(cwd)
              if (!state) {
                rec.delivery = { audited: false, delivered: 'unknown', note: 'source repo unreadable at audit time' }
              } else {
                const before = rec.sourceHeadAtStart ?? null
                const headChanged = before !== null && state.head !== null ? state.head !== before : null
                const testCommand = this.config.selectionPostAuditTestCommand.trim()
                let testsExit: number | null = null
                let testsRan = false
                let postAuditError: string | undefined
                if (testCommand && (headChanged === true || state.dirtyEntries > 0)) {
                  try {
                    const results = await runChecks(cwd, [{ name: 'post-audit', command: testCommand, timeoutMs: 120000 }])
                    testsExit = results[0]?.exitCode ?? null
                    testsRan = true
                  } catch (runError) {
                    postAuditError = runError instanceof Error ? runError.message.slice(0, 200) : String(runError).slice(0, 200)
                  }
                }
                const verdict = evaluateDelivery({
                  audited: true,
                  headChanged,
                  dirtyEntries: state.dirtyEntries,
                  testsConfigured: testCommand.length > 0,
                  testsExit: testsRan ? testsExit : null,
                })
                rec.delivery = {
                  audited: true,
                  headBefore: before,
                  headAfter: state.head,
                  headChanged,
                  dirtyEntries: state.dirtyEntries,
                  ...(testsRan ? { postAuditTestExit: testsExit } : {}),
                  delivered: verdict.delivered,
                  note: verdict.note + (postAuditError ? ' [test runner error: ' + postAuditError + ']' : ''),
                }
              }
            } catch {
              rec.delivery = { audited: false, delivered: 'unknown', note: 'audit raised' }
            }
          }
          rec.timing = { ...(rec.timing ?? {}), auditedAt: Date.now() }
        }
        const removed = await this.selections.discardWinner(selectionId)
        const after = this.selections.getSelection(selectionId)
        const slotAfter = after ? (after.winner ?? after.fallback) : undefined
        if (removed || !slotAfter || slotAfter.discardedAt !== undefined) pending.delete(selectionId)
      } catch { /* keep it queued for the next idle/dispose retry */ }
    }
    if (pending.size === 0) this.autopilotCleanup.delete(sourceSessionId)
  }

  /** One concise settlement notice into the source session: the outcome lands
   *  where the operator is looking instead of only in the panel. The distinct
   *  plugin sub-identity ('…/selection') keeps it out of feedback quota,
   *  verifier evidence, and selection seed extraction. Never throws. */
  private notifySelectionSettlement(record: import('./selection/candidates.js').SelectionRecord): void {
    if (!this.config.selectionNotify) return
    const sid = record.sourceSessionId
    if (!sid) return
    const agent = this.ctx.agents?.get(sid)
    if (!agent || typeof agent.followup !== 'function') return
    const scores = record.scores?.map((s) => (s === null ? 'null' : s.toFixed(3))).join('/')
    const slot = record.winner ?? record.fallback
    const text = record.status === 'completed' && slot
      ? '[Selection 结算] ' + record.selectionId + ' 已完成：outcome=' + (record.outcome ?? 'legacy')
        + '，' + (record.winner ? 'winner=c' + record.winner.index : 'fallback=c' + slot.index + '（未经候选间比较，非选优结论）')
        + (scores ? '（scores ' + scores + '，比较 ' + (record.nComparisons ?? 0) + ' 次）' : '')
        + (record.margin !== undefined ? '（margin ' + record.margin.toFixed(4) + ' / 阈值 ' + (record.marginThreshold ?? 'n/a') + (record.marginProvisional ? '，临时' : '') + '）' : '')
        + '。loser/淘汰候选已回收（会话与工作区均已删除）。保留对象的工作区位于 ' + slot.workspace + '，面板里可"丢弃 winner"彻底清理。此消息为结算通知，无需回复。'
      : '[Selection 结算] ' + record.selectionId + ' 结束：status=' + record.status + (record.outcome ? '，outcome=' + record.outcome : '') + (record.error ? '（' + record.error + '）' : '') + '，候选已全部回收。此消息为结算通知，无需回复。'
    try {
      void Promise.resolve(agent.followup(createUserMessage({
        source: { kind: 'plugin', plugin: PLUGIN_SOURCE_NAME + '/selection', form: 'notice', summary: boundContextSummary('选择结算：' + record.selectionId) },
        content: [{ type: 'text', text }],
      }))).catch(() => undefined)
    } catch { /* notice failures are silent by design */ }
  }

  start(): void {
    this.loadHistory()
    for (const agent of this.ctx.agents?.list() ?? []) this.attach(agent)
    const events = this.ctx as unknown as { on: (name: string, handler: (...args: any[]) => any, options?: { prepend?: boolean }) => (() => void) | void }
    const created = events.on('agent/created', payload => this.attach(payload?.agent))
    if (typeof created === 'function') this.disposers.push(created)
    const disposed = events.on('agent/disposed', payload => this.detach(payload?.agent))
    if (typeof disposed === 'function') this.disposers.push(disposed)
    this.recoverAutopilotRelays()
  }

  /** Reload recovery (live incident sel-ac04cfd7, 2026-09-09): a plugin hot
   *  reload disposes the background waiter, so a settled autopilot fallback/
   *  winner could sit retained forever with its relay never delivered. On
   *  startup, re-deliver the relay for any newly-settled record whose source
   *  agent is still alive, and re-register the retained workspace so idle /
   *  dispose cleanup picks it up exactly once. */
  private recoverAutopilotRelays(): void {
    for (const record of this.selections.listSelections()) {
      if (record.trigger !== 'autopilot' || record.status !== 'completed') continue
      if (!record.outcome) continue
      const slot = record.winner ?? record.fallback
      if (!slot || slot.discardedAt !== undefined) continue
      if (record.timing?.relayedAt) continue
      const sourceId = record.sourceSessionId
      if (!sourceId) continue
      const agent = this.ctx.agents?.get(sourceId)
      if (!agent) continue
      const pending = this.autopilotCleanup.get(sourceId) ?? new Set<string>()
      pending.add(record.selectionId)
      this.autopilotCleanup.set(sourceId, pending)
      record.timing = { ...(record.timing ?? {}), relayedAt: Date.now() }
      this.selections.pubRecord(record)
      void Promise.resolve(agent.followup(createUserMessage({
        source: { kind: 'plugin', plugin: PLUGIN_SOURCE_NAME + '/autopilot', form: 'relay' },
        content: [{ type: 'text', text: buildAutopilotRelay(record) }],
      }))).catch(() => undefined)
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.coordinator.dispose()
    for (const dispose of this.disposers.splice(0)) { try { dispose() } catch { /* isolated */ } }
    for (const unsubscribe of this.agentListeners.values()) { try { unsubscribe() } catch { /* isolated */ } }
    this.agentListeners.clear()
    for (const selectionIds of this.autopilotActive.values()) for (const selectionId of selectionIds) this.selections.cancel(selectionId)
    this.autopilotActive.clear()
    await Promise.all([...this.autopilotCleanup.keys()].map((id) => this.cleanupAutopilotWinners(id)))
    await this.selections.dispose()
    // A handle lock may clear only during SelectionHost disposal; retry any
    // queued workspace/session cleanup once after all live agents have settled.
    await Promise.all([...this.autopilotCleanup.keys()].map((id) => this.cleanupAutopilotWinners(id)))
    this.agents.clear()
    this.listeners.clear()
  }

  setConfig(patch: Partial<Config>): void {
    this.config = { ...this.config, ...validateConfigPatch(patch) }
    this.emit()
  }

  getConfig(): Config { return this.config }

  getCredentials(): Credentials | undefined { return this.ctx.credentials }

  replaceConfig(next: Config): void {
    this.config = { ...this.config, ...validateConfigPatch(next) }
    this.emit()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** A single broken SSE connection must never break verification or config
   *  operations: listener exceptions are contained here. */
  private emit(): void {
    for (const listener of [...this.listeners]) {
      try { listener() } catch { /* subscriber exceptions are isolated */ }
    }
  }

  private attach(agent: Agent | undefined): void {
    if (!agent || this.disposed) return
    // Candidate children (parentSession set) belong to the best-of-N selection
    // path: legacy auto verification + feedback followups there would contaminate
    // the trajectories select() compares. Manual /verify stays available.
    if ((agent.session as { header?: { parentSession?: string } }).header?.parentSession) return
    const id = String(agent.id)
    if (this.agents.has(id)) return
    this.agents.set(id, agent)
    const scoped = agent.ctx as unknown as { on: (name: string, handler: (...args: any[]) => any, options?: { prepend?: boolean }) => (() => void) | void }
    const status = scoped.on('agent/status', payload => this.handleStatus(agent, payload))
    const preStep = scoped.on('agent/pre-step', (payload, next) => this.handleAutopilotPreStep(agent, payload, next), { prepend: true })
    this.agentListeners.set(id, () => {
      if (typeof status === 'function') status()
      if (typeof preStep === 'function') preStep()
    })
  }

  /** agent/disposed: revoke the status listener and scheduler state so stale
   *  callbacks cannot start verification for an agent that no longer exists. */
  private detach(agent: { id?: string } | undefined): void {
    const id = String(agent?.id ?? '')
    if (!id) return
    const unsubscribe = this.agentListeners.get(id)
    if (unsubscribe) {
      unsubscribe()
      this.agentListeners.delete(id)
    }
    this.agents.delete(id)
    for (const selectionId of this.autopilotActive.get(id) ?? []) this.selections.cancel(selectionId)
    this.autopilotActive.delete(id)
    void this.cleanupAutopilotWinners(id)
    this.coordinator.forgetSession(id)
  }

  /** Fully synchronous: a status callback can never float a promise, so a
   *  trace/provider failure cannot become an unhandled rejection. */
  private handleStatus(agent: Agent, payload: { status?: string } | undefined): void {
    if (payload?.status !== 'idle') return
    const id = String(agent.id)
    if (this.agents.get(id) !== agent) return
    void this.cleanupAutopilotWinners(id)
    if (this.disposed || !this.config.enabled) return
    const bounds = turnBounds(agent.session.events)
    if (!bounds || typeof bounds.end.seq !== 'number') return
    this.coordinator.scheduleAuto(id, agent, bounds)
  }

  /** Coordinator seam: every run gets an abort signal plus an immutable config
   *  snapshot; configuration updates mid-flight affect only future runs. */
  private executeEntry(entry: ScheduleEntry<Agent>, runContext: RunContext): Promise<RecordState | undefined> {
    const snapshot = Object.freeze({ ...this.config }) as Config
    return this.verifyAgent(entry.agent, entry.bounds, {
      force: entry.kind === 'manual',
      config: snapshot,
      signal: runContext.signal,
    }).catch(() => undefined)
  }

  private async verifyAgent(
    agent: Agent,
    bounds: { start: EventRecord; end: EventRecord; turn: number },
    options: { force?: boolean; config: Readonly<Config>; signal: AbortSignal },
  ): Promise<RecordState> {
    const sessionId = String(agent.id)
    const record: RecordState = { id: crypto.randomUUID(), sessionId, turn: bounds.turn, turnEndSeq: bounds.end.seq ?? -1, status: 'running', startedAt: Date.now(), feedbackSent: false }
    this.records.unshift(record)
    this.records.splice(VERIFICATION_HISTORY_LIMIT)
    this.emit()
    const config = options.config
    try {
      // Trace building and gating live inside the same containment boundary as
      // the provider call: a crash here yields a failed record instead of a
      // permanently 'running' record and an unhandled rejection.
      const { problem, hasCurrentDirectTask, hasAnyDirectTask, trace, stats, visibleEvidenceIds, verdictLineIds, evidenceKinds } = traceFor(agent.session.events, bounds)
      record.traceStats = stats
      // No-op gate: bare status continuations with zero tool evidence are recorded
      // as 'skipped' (kept observable) but never scored, so they cannot consume
      // the session's feedback quota. Task-less sessions are skipped regardless of
      // force — a run without a task cannot name what it verifies. Manual POST
      // /verify passes force and bypasses the other skips.
      const gate = turnGateDecision({ problem, hasCurrentDirectTask, toolEventCount: stats.toolEventCount, hasAnyDirectTask }, { force: options.force, skipEnabled: config.skipStatusContinuation })
      if (!gate.verify) {
        record.status = 'skipped'
        record.skippedReason = gate.skipReason
        record.finishedAt = Date.now()
        this.persist(record)
        this.emit()
        return record
      }
      const prompt = buildVerifierPrompt(problem, trace, 'Did the agent actually complete the requested task correctly, with sufficient evidence from tools or tests?')
      const aggregate = await verifyFive(config, this.ctx.credentials, prompt, { signal: options.signal })
      record.aggregate = aggregate
      const kindsById = new Map<number, string>(Object.entries(evidenceKinds).map(([id, kind]) => [Number(id), String(kind)]))
      record.citationAudit = auditAggregateCitations(aggregate, visibleEvidenceIds, verdictLineIds, kindsById)
      record.finishedAt = Date.now()
      record.status = aggregate.valid.length === 0 ? 'failed' : aggregate.valid.length < Math.min(3, config.routes) ? 'partial' : 'completed'
      const feedbackDecision = decideFeedback(aggregate, config)
      if (config.autoFeedback && feedbackDecision.guarded) {
        record.suppressedFeedback = { median: aggregate.median ?? 0, noDefectLanes: noDefectLaneCount(aggregate), validLanes: aggregate.valid.length }
      }
      // Feedback is useful only when it points at independently observed
      // execution evidence. Model-only findings and uncited disagreement stay
      // in the record without interrupting the source task.
      const citationAudit = record.citationAudit
      const independentFindings = Math.max(0, (citationAudit?.defectFindings ?? 0) - (citationAudit?.findingsWithoutIndependentCitation ?? 0))
      const hasIndependentDefectEvidence = independentFindings > 0
      if (config.autoFeedback && feedbackDecision.feedback && !hasIndependentDefectEvidence) {
        record.feedbackSuppressed = { reason: 'no-independent-evidence', defectFindings: citationAudit?.defectFindings ?? 0, independentFindings }
      }
      if (config.autoFeedback && feedbackDecision.feedback && hasIndependentDefectEvidence) {
        const count = feedbackSentCount(agent.session.events)
        if (count < config.maxFeedbackPerSession) {
          if (options.signal.aborted || this.disposed || (this.agents.get(sessionId) !== agent && !this.ctx.agents?.get(sessionId))) {
            record.feedbackError = 'run-aborted-before-feedback'
          } else {
            const summary = aggregate.score === null ? '评分不可用' : '平均完成度 ' + aggregate.score.toFixed(2) + ', 分歧 ' + (aggregate.dispersion ?? 0).toFixed(2)
            const findings = aggregate.valid
              .filter(item => item.finding && !/no concrete defect/i.test(item.finding) && auditFindingCitation(item.findingFull ?? item.finding, visibleEvidenceIds, verdictLineIds, kindsById).independentCitation)
              .map(item => 'lane ' + item.route + '/' + (item.lane ?? 'unknown') + ': ' + String(item.finding).slice(0, 260))
              .slice(0, 3)
            const feedback = '[Verifier feedback] ' + summary + '。有工具证据支持的具体问题：' + findings.join('；') + '。仅在复查工具结果后确认问题才修复；否则继续完成原始任务并交付，不要为了提高审查分数修改代码。'
            try {
              // Structured producer identity (kind=plugin + form=notice) makes the
              // feedback recognizable without its text prefix; task attribution
              // excludes plugin sources structurally.
              await awaitFollowupWithFence(Promise.resolve(agent.followup(createUserMessage({
                source: { kind: 'plugin', plugin: PLUGIN_SOURCE_NAME, form: 'notice', summary: boundContextSummary('验证反馈：' + summary) },
                content: [{ type: 'text', text: feedback }],
              }))), options.signal, this.feedbackTimeoutMs)
              if (options.signal.aborted || this.disposed) record.feedbackError = 'run-aborted-during-feedback'
              else record.feedbackSent = true
            } catch (error) {
              record.feedbackError = error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240)
            }
          }
        }
      }
    } catch (error) {
      record.status = 'failed'
      record.finishedAt = Date.now()
      record.error = error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240)
    }
    this.persist(record)
    this.emit()
    return record
  }

  async verifySession(sessionId: string): Promise<RecordState | undefined> {
    const agent = this.agents.get(sessionId) ?? this.ctx.agents?.get(sessionId)
    if (!agent) return undefined
    const bounds = turnBounds(agent.session.events)
    if (!bounds || typeof bounds.end.seq !== 'number') return undefined
    // Manual verification joins the same per-session queue as automatic idles:
    // force bypasses the no-op gate, never the mutual exclusion, and resolves
    // with the record created by its own run.
    const outcome = await this.coordinator.scheduleManual(sessionId, agent, bounds)
    if (outcome.status === 'aborted') throw new VerifyAbortedError()
    if (outcome.status === 'failed') {
      throw outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error))
    }
    return outcome.value
  }

  snapshot(): Record<string, unknown> {
    return { config: cleanConfig(this.config), agents: this.agents.size, records: this.records.slice(0, 20), selection: this.selections.snapshot() }
  }

  private loadHistory(): void {
    if (!this.recordsFile) return
    const loaded = loadPersistedRecords(this.recordsFile)
    if (loaded.length > 0) this.records.unshift(...loaded)
    this.records.splice(VERIFICATION_HISTORY_LIMIT)
  }

  private persist(record: RecordState): void {
    if (!this.recordsFile) return
    try { appendJsonlLedger(this.recordsFile, record) }
    catch { /* observability must never break verification */ }
  }

  /** Newest-first history view with optional filters for the /records endpoint. */
  queryRecords(filter: { sessionId?: string; status?: string; turn?: number } = {}): RecordState[] {
    return this.records.filter(record =>
      (filter.sessionId === undefined || record.sessionId === filter.sessionId) &&
      (filter.status === undefined || record.status === filter.status) &&
      (filter.turn === undefined || record.turn === filter.turn))
  }
}
