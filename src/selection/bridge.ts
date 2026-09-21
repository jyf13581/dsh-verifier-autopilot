/**
 * VerifierBridge: Node side of the Python sidecar protocol (bridge/PROTOCOL.md).
 *
 * Owns the child process lifecycle (lazy spawn, respawn on crash, disposal),
 * serial-framed JSONL I/O, per-request timeout, external abort, and error
 * mapping. The API key is injected into the child's environment at spawn and
 * never serialized into a frame. A timeout or mid-flight abort kills the
 * child: the sidecar is serial, so a stuck request poisons the pipe.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export type BridgeErrorCode =
  | 'bad_frame' | 'invalid_request' | 'missing_api_key' | 'client_init'
  | 'missing_logprobs' | 'timeout' | 'provider_error' | 'selection_failed'
  | 'preflight_failed' | 'selection_timeout'
  | 'bridge_timeout' | 'bridge_down' | 'bridge_disposed' | 'bridge_aborted'
  | 'bridge_protocol'

export class BridgeError extends Error {
  readonly code: BridgeErrorCode
  readonly retriable: boolean
  constructor(code: BridgeErrorCode, message: string, retriable: boolean) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.retriable = retriable
  }
}

export interface BridgeHealth {
  python: string
  llm_verifier_version: string
  select_available: boolean
  note: string
  deepseek_effort: string | null
}

export interface BridgeSelectRequest {
  problem: string
  candidates: string[]
  criteria: Record<string, string> | Array<{ id: string; name: string; description: string }>
  groundTruthNote?: string | null
  nEvaluations?: number
  pivots?: number
  seed?: number
  model: string
  baseUrl: string
  /** Resolved key VALUE: placed in the child env at spawn, never framed. */
  apiKey: string
  apiKeyEnv?: string
  /** Verifier thinking strength ('off' | 'low' | 'high' | 'max'); the sidecar
   *  maps it onto DEEPSEEK_EFFORT for exactly this request. */
  effort?: string
  onError?: 'tie' | 'raise'
  maxWorkers?: number | null
  /** Token-bucket dispatch spacing (ms) inside the tournament; 0 = off. */
  minIntervalMs?: number
  /** Per-call transient (429) retries inside the sidecar. Each retry re-enters
   *  the relay's per-request account round-robin, so a rate-limited account
   *  stalls only its own call. 0..5, default 2. */
  callRetries?: number
  timeoutMs?: number
  signal?: AbortSignal
}

export interface BridgeUsage {
  calls: number
  input_tokens: number
  cached_input_tokens: number
  uncached_input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cache_hit_rate: number
}

export interface BridgeSelectResult {
  index: number
  bestPreview: string
  scores: number[]
  ranking: number[]
  nComparisons: number
  criteria: string[]
  usage: BridgeUsage
}

export interface VerifierBridgeOptions {
  pythonPath: string
  scriptPath: string
  /** Extra child env (merged over a copy of process.env). */
  env?: Record<string, string>
  /** Default per-request timeout; overridden per request. */
  defaultTimeoutMs?: number
  /** Grace period for the shutdown frame before SIGKILL. */
  shutdownGraceMs?: number
  /** Cap on retained stderr diagnostics (chars). */
  stderrBufferChars?: number
}

interface Pending {
  id: string
  settle: (err: BridgeError | null, frame?: Record<string, unknown>) => void
}

const PREFLIGHT_PROBLEM = 'Reply with exactly one word: ready'
const PREFLIGHT_GOOD = '[E01] USER: Reply with exactly one word: ready'
  + String.fromCharCode(10) + '[E02] ASSISTANT: ready'
const PREFLIGHT_BAD = '[E01] USER: Reply with exactly one word: ready'
  + String.fromCharCode(10) + '[E02] ASSISTANT: (no output produced, no tool used, task ignored)'
const PREFLIGHT_CRITERIA = [{
  id: 'preflight-presence',
  name: 'Requested output presence',
  description: 'The trajectory that actually produced the requested word is objectively better than one that produced nothing.',
}]


export interface BridgeProgressRequest {
  problem: string
  /** Rendered trajectory fragments so far (each entry is one "agent step"). */
  steps: string[]
  model: string
  baseUrl: string
  apiKey: string
  apiKeyEnv?: string
  nEvaluations?: number
  /** Verifier thinking strength; same per-request semantics as select. */
  effort?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface BridgeProgressResult {
  score: number
  usage: BridgeUsage
}

export class VerifierBridge {
  private readonly pythonPath: string
  private readonly scriptPath: string
  private readonly extraEnv: Record<string, string>
  private readonly defaultTimeoutMs: number
  private readonly shutdownGraceMs: number
  private readonly stderrCap: number
  private child: ChildProcessWithoutNullStreams | null = null
  private stdoutBuf = ''
  private stderrTail = ''
  private pending = new Map<string, Pending>()
  private disposed = false
  private spawnKey: { name: string; value: string } | null = null

  constructor(options: VerifierBridgeOptions) {
    this.pythonPath = options.pythonPath
    this.scriptPath = options.scriptPath
    this.extraEnv = options.env ?? {}
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120000
    this.shutdownGraceMs = options.shutdownGraceMs ?? 5000
    this.stderrCap = options.stderrBufferChars ?? 2048
  }

  get alive(): boolean { return this.child !== null && !this.child.killed }

  private noteStderr(chunk: string): void {
    this.stderrTail = (this.stderrTail + chunk).slice(-this.stderrCap)
  }

  private ensureSpawned(envKey?: { name: string; value: string }): Promise<void> {
    if (this.disposed) return Promise.reject(new BridgeError('bridge_disposed', 'bridge is disposed', false))
    // spawnKey === null means the live child was spawned WITHOUT a key (e.g.
    // a bare health probe): reuse would hand select() a keyless sidecar and
    // every request would miss its credential — respawn on the first keyed use.
    const needRespawn = envKey && this.child !== null
      && (this.spawnKey === null || this.spawnKey.name !== envKey.name || this.spawnKey.value !== envKey.value)
    if (this.alive && !needRespawn) return Promise.resolve()
    if (needRespawn) this.teardownChild(new BridgeError('bridge_down', 'api key changed: respawning sidecar', true))
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.extraEnv }
    if (envKey) env[envKey.name] = envKey.value
    const child = spawn(this.pythonPath, [this.scriptPath], { env, windowsHide: true })
    this.spawnKey = envKey ?? null
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.noteStderr(chunk))
    // Identity guard: a killed child's late exit/error must not clear the
    // pending queue of its already-respawned successor.
    child.on('error', (err) => {
      if (this.child !== child) return
      this.onChildGone(new BridgeError('bridge_down', 'spawn failed: ' + err.message, true))
    })
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      const why = 'sidecar exited code=' + String(code) + ' signal=' + String(signal)
      this.onChildGone(new BridgeError('bridge_down', why + this.stderrSuffix(), false))
    })
    return Promise.resolve()
  }

  private stderrSuffix(): string {
    const tail = this.stderrTail.trim()
    return tail ? ' | stderr: ' + tail.slice(-600) : ''
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk
    const NL = String.fromCharCode(10)
    for (;;) {
      const idx = this.stdoutBuf.indexOf(NL)
      if (idx < 0) return
      const line = this.stdoutBuf.slice(0, idx).trim()
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1)
      if (!line) continue
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(line) as Record<string, unknown>
      } catch {
        this.teardownChild(new BridgeError('bridge_protocol', 'sidecar emitted non-JSON line' + this.stderrSuffix(), false))
        return
      }
      const id = typeof frame.id === 'string' ? frame.id : null
      if (id === null) {
        // bad_frame from the sidecar means OUR last frame was malformed;
        // the serial pipe cannot identify which request failed.
        this.teardownChild(new BridgeError('bridge_protocol', 'sidecar reported bad_frame' + this.stderrSuffix(), false))
        return
      }
      const entry = this.pending.get(id)
      if (!entry) continue
      this.pending.delete(id)
      entry.settle(null, frame)
    }
  }

  private onChildGone(err: BridgeError): void {
    this.child = null
    this.spawnKey = null
    this.stdoutBuf = ''
    const pend = [...this.pending.values()]
    this.pending.clear()
    for (const p of pend) p.settle(err)
  }

  private teardownChild(err: BridgeError): void {
    const child = this.child
    this.onChildGone(err)
    if (child && !child.killed) child.kill()
  }

  private request(
    frame: Record<string, unknown>,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<Record<string, unknown>> {
    const id = String(frame.id)
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const settle = (err: BridgeError | null, out?: Record<string, unknown>) => {
        cleanup()
        if (err) reject(err)
        else if (out) resolve(out)
      }
      const timer = setTimeout(() => {
        const err = new BridgeError('bridge_timeout', 'sidecar request ' + id + ' exceeded ' + options.timeoutMs + 'ms' + this.stderrSuffix(), true)
        this.pending.delete(id)
        this.teardownChild(err)
        settle(err)
      }, options.timeoutMs)
      const onAbort = () => {
        const err = new BridgeError('bridge_aborted', 'sidecar request ' + id + ' aborted by caller', false)
        this.pending.delete(id)
        // The sidecar is serial: an aborted in-flight request would still
        // produce a response. Kill the child to keep id routing sound.
        this.teardownChild(err)
        settle(err)
      }
      const cleanup = () => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
      }
      this.pending.set(id, { id, settle })
      options.signal?.addEventListener('abort', onAbort, { once: true })
      const child = this.child
      if (!child || child.killed) {
        this.pending.delete(id)
        cleanup()
        reject(new BridgeError('bridge_down', 'sidecar not running', true))
        return
      }
      child.stdin.write(JSON.stringify(frame) + String.fromCharCode(10), (err) => {
        if (err) {
          this.pending.delete(id)
          cleanup()
          reject(new BridgeError('bridge_down', 'stdin write failed: ' + err.message, true))
        }
      })
    })
  }

  async health(options?: { timeoutMs?: number }): Promise<BridgeHealth> {
    await this.ensureSpawned()
    const frame = await this.request(
      { id: crypto.randomUUID(), type: 'health' },
      { timeoutMs: options?.timeoutMs ?? this.defaultTimeoutMs })
    if (frame.ok !== true) throw this.frameError(frame)
    return frame.result as unknown as BridgeHealth
  }

  async select(req: BridgeSelectRequest): Promise<BridgeSelectResult> {
    const apiKeyEnv = req.apiKeyEnv ?? 'KIMI_API_KEY'
    await this.ensureSpawned({ name: apiKeyEnv, value: req.apiKey })
    if (req.signal?.aborted) throw new BridgeError('bridge_aborted', 'select aborted before dispatch', false)
    const frame = await this.request({
      id: crypto.randomUUID(),
      type: 'select',
      problem: req.problem,
      candidates: req.candidates,
      criteria: req.criteria,
      ground_truth_note: req.groundTruthNote ?? null,
      n_evaluations: req.nEvaluations ?? 4, // direct-call fallback matches upstream; Host defaults are in HANDOFF §2.4
      pivots: req.pivots ?? 1,
      seed: req.seed ?? 0,
      effort: req.effort ?? null,
      model: req.model,
      base_url: req.baseUrl,
      api_key_env: apiKeyEnv,
      cache: null,
      on_error: req.onError ?? 'raise',
      max_workers: req.maxWorkers ?? null,
      min_interval_ms: Math.max(0, Math.floor(req.minIntervalMs ?? 0)),
      call_retries: Math.max(0, Math.min(5, Math.floor(req.callRetries ?? 2))),
      progress: false,
    }, { timeoutMs: req.timeoutMs ?? this.defaultTimeoutMs, signal: req.signal })
    if (frame.ok !== true) throw this.frameError(frame)
    const result = frame.result as Record<string, unknown>
    return {
      index: Number(result.index),
      bestPreview: String(result.best_preview ?? ''),
      scores: (result.scores as number[]).map(Number),
      ranking: (result.ranking as number[]).map(Number),
      nComparisons: Number(result.n_comparisons),
      criteria: (result.criteria as string[]).map(String),
      usage: result.usage as BridgeUsage,
    }
  }


  /** Online progress score (llm_verifier.track, single final checkpoint):
   *  "would the agent's CURRENT state already satisfy the task?" — the
   *  framework's own hopeless-rollout meter (HANDOFF §2.3). */
  async progress(req: BridgeProgressRequest): Promise<BridgeProgressResult> {
    const apiKeyEnv = req.apiKeyEnv ?? 'KIMI_API_KEY'
    await this.ensureSpawned({ name: apiKeyEnv, value: req.apiKey })
    if (req.signal?.aborted) throw new BridgeError('bridge_aborted', 'progress aborted before dispatch', false)
    const frame = await this.request({
      id: crypto.randomUUID(),
      type: 'progress',
      problem: req.problem,
      steps: req.steps,
      model: req.model,
      base_url: req.baseUrl,
      api_key_env: apiKeyEnv,
      n_evaluations: req.nEvaluations ?? 1,
      effort: req.effort ?? null,
    }, { timeoutMs: req.timeoutMs ?? this.defaultTimeoutMs, signal: req.signal })
    if (frame.ok !== true) throw this.frameError(frame)
    const result = frame.result as Record<string, unknown>
    return { score: Number(result.score), usage: result.usage as BridgeUsage }
  }

  /**
   * Provider readiness gate for selection: one tiny directed comparison with a
   * blatantly asymmetric pair. PASS requires a real tournament (nComparisons>0)
   * AND scores[0] > scores[1] — a model that cannot follow the score-tag
   * protocol degenerates to 0.5/0.5 (silent tie), which fails this check the
   * same as a wrong verdict. Raises BridgeError('preflight_failed') on failure.
   */
  async preflight(opts: {
    model: string
    baseUrl: string
    apiKey: string
    apiKeyEnv?: string
    effort?: string
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<void> {
    const result = await this.select({
      problem: PREFLIGHT_PROBLEM,
      candidates: [PREFLIGHT_GOOD, PREFLIGHT_BAD],
      criteria: PREFLIGHT_CRITERIA,
      model: opts.model,
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      apiKeyEnv: opts.apiKeyEnv,
      effort: opts.effort,
      nEvaluations: 1, // preflight only proves strict-order ability; one directed pair is the cheapest sufficient probe (keep cheap)
      pivots: 0,
      seed: 0,
      onError: 'raise',
      timeoutMs: opts.timeoutMs ?? 240000,
      signal: opts.signal,
    })
    const good = result.scores[0] ?? 0
    const bad = result.scores[1] ?? 1
    if (result.nComparisons < 1 || !(good > bad)) {
      throw new BridgeError(
        'preflight_failed',
        'verifier preflight failed: pair scores ' + good.toFixed(3) + '/' + bad.toFixed(3)
          + ' over ' + result.nComparisons + ' comparisons — expected the present-output trajectory to win strictly',
        false)
    }
  }

  private frameError(frame: Record<string, unknown>): BridgeError {
    const err = (frame.error ?? {}) as Record<string, unknown>
    const code = (typeof err.code === 'string' ? err.code : 'selection_failed') as BridgeErrorCode
    const message = typeof err.message === 'string' ? err.message : 'sidecar selection failed'
    return new BridgeError(code, message, err.retriable === true)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const child = this.child
    if (!child) return
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    try {
      if (!child.killed) {
        child.stdin.write(JSON.stringify({ id: crypto.randomUUID(), type: 'shutdown' }) + String.fromCharCode(10))
        child.stdin.end()
      }
    } catch { /* pipe already broken */ }
    const grace = new Promise<void>((resolve) => setTimeout(resolve, this.shutdownGraceMs))
    await Promise.race([exited, grace])
    if (!child.killed) child.kill()
    this.onChildGone(new BridgeError('bridge_disposed', 'bridge disposed', false))
  }
}
