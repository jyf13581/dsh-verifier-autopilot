/** Local HTTP/SSE transport for verifier and selection operations.
 *
 * Validation, authorization, and provider-spend quotas live at this boundary;
 * lifecycle and decision logic remain in VerifierHost.
 */

import {
  buildVerifierPrompt, verifyFive, verifyRoute,
} from './verifier.js'
import { DEFAULT_CONFIG, type Config } from './config.js'
import { SelectionApiError } from './selection/host.js'
import type { SelectionRecord } from './selection/candidates.js'
import { VERIFICATION_HISTORY_LIMIT, VerifyAbortedError } from './host.js'
import {
  API_PREFIX, MODEL_OPTIONS,
  type ConfigResponse, type HeaderValue, type SelectionActionResponse,
  type SelectionIdRequest, type SelectionItemResponse, type SelectionReleaseResponse,
  type SelectionSnapshot, type SelectionStartRequest, type SelectionStartResponse,
  type SelectionsListResponse, type StateResponse, type VerificationRecord,
  type VerifyResponse, type WebRequest, type WebResponse, type WebRoute,
} from './protocol.js'
import { normalizeBaseUrl, redactSecrets, resolveKey, type Credentials } from './util.js'

/** Structural domain seam consumed by the transport. VerifierHost satisfies it
 * at the composition root, while API tests can use a focused fake without
 * importing lifecycle implementation details. */
export interface SelectionApiService {
  start(body: SelectionStartRequest & { trigger?: 'manual' }): Promise<SelectionRecord>
  activeSelectionId(): string | null
  snapshot(): SelectionSnapshot
  listSelections(): SelectionRecord[]
  getSelection(selectionId: string): SelectionRecord | undefined
  cancel(selectionId: string): boolean
  releaseWinner(selectionId: string): Promise<'released' | 'not-retained'>
  discardWinner(selectionId: string): Promise<boolean>
}

export interface VerifierApiHost {
  snapshot(): StateResponse
  setConfig(patch: Partial<Config>): void
  getConfig(): Config
  getCredentials(): Credentials | undefined
  verifySession(sessionId: string): Promise<VerificationRecord | undefined>
  queryRecords(filter?: { sessionId?: string; status?: string; turn?: number }): VerificationRecord[]
  subscribe(listener: () => void): () => void
  readonly selections: SelectionApiService
}

export function json(res: WebResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export async function readJson<T = unknown>(req: WebRequest): Promise<T> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk))
    size += buffer.length
    if (size > 64 * 1024) throw new Error('body-too-large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as T
}

/** Fixed-window quota for provider-spending endpoints (Phase 1 egress policy):
 *  local callers get bounded /eval, /probe, and manual /verify spend per minute
 *  instead of an unthrottled lever on the external provider. */
function headerText(value: HeaderValue): string {
  if (typeof value === 'string') return value
  return value ? [...value].join(',') : ''
}

export const API_RATE_LIMITS = { evalPerMinute: 120, probePerMinute: 60, verifyPerMinute: 60, selectPerHour: 12 }

/** Sliding-window limiter on a stamp log: no fixed-window boundary burst
 *  (2x-at-the-edge is impossible in ANY window of windowMs). acquire() =
 *  peek+commit in one step; /select splits them so admissions rejected by the
 *  host (busy, bad route, missing key) never burn provider-spend quota. */
export interface RateLimiter { (): boolean; peek(): boolean; commit(): void }
/** Exported for regression tests; the clock is injectable for deterministic windows. */
export function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now): RateLimiter {
  const stamps: number[] = []
  const prune = (t: number) => { while (stamps.length > 0 && t - stamps[0] >= windowMs) stamps.shift() }
  const peek = () => { prune(now()); return stamps.length < limit }
  const commit = () => { stamps.push(now()) }
  return Object.assign(function acquire() { if (!peek()) return false; commit(); return true }, { peek, commit })
}

/** Review R1 (1.4/1.5): fields whose HTTP mutation is a credential-egress or
 *  command-execution lever. Over the unauthenticated default transport they are
 *  settings-service-only (the DSH settings UI / settings file is the trusted
 *  operator channel); an HTTP caller may change them only when the operator
 *  configured DSH_VA_API_TOKEN and the request carried it.
 *
 *  - selectionPostAuditTestCommand runs through the check shell in the USER'S
 *    source repository on the next source idle. Clearing it ('') is always
 *    allowed: that only removes privilege.
 *  - baseURL + apiKeyEnv together decide which secret is sent as a Bearer
 *    header to which host (/probe, autopilot probes, verifier lanes, sidecar).
 *    Unprivileged callers may only select one of the shipped endpoint tuples,
 *    exactly what the GUI model picker sends. */
export const PRIVILEGED_CONFIG_FIELDS = ['selectionPostAuditTestCommand', 'baseURL', 'apiKeyEnv'] as const

function egressKey(baseURL: string, apiKeyEnv: string): string {
  return normalizeBaseUrl(baseURL.trim()).toLowerCase() + '\u0000' + apiKeyEnv
}

const ALLOWED_EGRESS = new Set<string>([
  egressKey(DEFAULT_CONFIG.baseURL, DEFAULT_CONFIG.apiKeyEnv),
  ...MODEL_OPTIONS.map(option => egressKey(option.baseURL, option.apiKeyEnv)),
])

/** Exported for regression tests: null when the patch is admissible for this
 *  caller, otherwise the stable error code of the refused field. */
export function httpConfigPolicyViolation(patch: unknown, current: Config, privileged: boolean): string | null {
  if (privileged || !patch || typeof patch !== 'object' || Array.isArray(patch)) return null
  const input = patch as Record<string, unknown>
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(input, key)
  if (has('selectionPostAuditTestCommand') && input.selectionPostAuditTestCommand !== '') {
    return 'privileged-config-field:selectionPostAuditTestCommand'
  }
  if (has('baseURL') || has('apiKeyEnv')) {
    const baseURL = has('baseURL') ? input.baseURL : current.baseURL
    const apiKeyEnv = has('apiKeyEnv') ? input.apiKeyEnv : current.apiKeyEnv
    // Type errors are left to validateConfigPatch; only well-typed tuples are policed here.
    if (typeof baseURL === 'string' && typeof apiKeyEnv === 'string' && !ALLOWED_EGRESS.has(egressKey(baseURL, apiKeyEnv))) {
      return 'privileged-config-field:egress-target'
    }
  }
  return null
}

/** Review R1 (1.6): every POST route shares one admission gate so none can be
 *  driven as a cross-site "simple request". A JSON content type forces a CORS
 *  preflight that this transport never answers, and browsers that send
 *  Sec-Fetch-Site mark forged cross-site requests explicitly. */
function mutationRefusal(req: WebRequest, authorized: (req: WebRequest) => boolean): { status: number; error: string } | null {
  if (!authorized(req)) return { status: 403, error: 'unauthorized' }
  if (headerText(req.headers['sec-fetch-site']).toLowerCase() === 'cross-site') return { status: 403, error: 'cross-site-request' }
  if (!headerText(req.headers['content-type']).toLowerCase().startsWith('application/json')) return { status: 415, error: 'json-required' }
  return null
}

/** Shared body contract for the selection lifecycle routes (cancel, release,
 *  discard): a JSON object carrying a non-empty selectionId. A literal `null`
 *  body used to reach `body.selectionId` and throw inside the async handler. */
async function readSelectionIdRequest(req: WebRequest): Promise<{ ok: true; selectionId: string } | { ok: false; status: number; error: string }> {
  let body: unknown
  try {
    body = await readJson(req)
  } catch {
    return { ok: false, status: 400, error: 'invalid-json-body' }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, status: 400, error: 'json-object-required' }
  const selectionId = typeof (body as Partial<SelectionIdRequest>).selectionId === 'string' ? (body as SelectionIdRequest).selectionId.trim() : ''
  if (!selectionId) return { ok: false, status: 400, error: 'selection-id-required' }
  return { ok: true, selectionId }
}

/** The one shape of an unexpected failure on this transport: a JSON 500 whose
 *  message is secret-redacted and bounded. Provider errors can echo request
 *  URLs, headers, or response bodies, so no route may forward `error.message`
 *  to the operator unfiltered. */
function internalFailure(res: WebResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  json(res, 500, { ok: false, error: redactSecrets(message).slice(0, 240) })
}

/** One status/error mapping for every selection route: domain admission
 *  errors keep their HTTP status and code; anything else is the bounded,
 *  secret-redacted 500 above instead of an unhandled rejection in the web server. */
function selectionFailure(res: WebResponse, error: unknown): void {
  if (error instanceof SelectionApiError) return json(res, error.status, { ok: false, error: error.code, message: error.message })
  internalFailure(res, error)
}

/** Provider-spending routes stop spending when nobody is left to read the
 *  answer: the returned signal aborts once the response closes before the
 *  handler ended it. A `close` that follows our own `end()` aborts nothing
 *  that is still running, so the signal is safe to attach unconditionally. */
function clientAbortSignal(res: WebResponse): AbortSignal {
  const controller = new AbortController()
  res.once('close', () => controller.abort(new Error('client-disconnected')))
  return controller.signal
}

/** Exported for regression tests: builds the Host API routes for this host. */
/** Model ids from an OpenAI-style `/models` listing body of unknown shape:
 *  `{ data: [{ id }] }`, or bare strings, capped at 50; anything else is an
 *  empty list, never a throw. */
/** `error.message` from an OpenAI-style error body, when it has one. */
function upstreamErrorMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('error' in body)) return undefined
  const error = body.error
  if (typeof error !== 'object' || error === null || !('message' in error)) return undefined
  return typeof error.message === 'string' ? error.message : undefined
}

function modelIdsOf(body: unknown): string[] {
  if (typeof body !== 'object' || body === null || !('data' in body) || !Array.isArray(body.data)) return []
  return body.data.slice(0, 50).map((entry: unknown) => {
    if (typeof entry === 'object' && entry !== null && 'id' in entry) return String(entry.id)
    return String(entry)
  })
}

export function apiRoutes(host: VerifierApiHost): WebRoute[] {
  const evalLimiter = createRateLimiter(API_RATE_LIMITS.evalPerMinute, 60_000)
  const probeLimiter = createRateLimiter(API_RATE_LIMITS.probePerMinute, 60_000)
  const verifyLimiter = createRateLimiter(API_RATE_LIMITS.verifyPerMinute, 60_000)
  // Optional local API token (Phase 2 trust boundary): set DSH_VA_API_TOKEN to
  // require `authorization: Bearer <token>` on mutating / provider-spending
  // endpoints. Read-only views stay open to the local operator. The panel
  // prompts for the token on the first 403 and replays it (review R1 1.3).
  // A configured token is also what unlocks PRIVILEGED_CONFIG_FIELDS over HTTP.
  const requiredToken = process.env.DSH_VA_API_TOKEN || ''
  const authorized = (req: WebRequest): boolean => !requiredToken || headerText(req.headers.authorization) === 'Bearer ' + requiredToken
  const refuse = (req: WebRequest) => mutationRefusal(req, authorized)
  const state: WebRoute = { kind: 'exact', path: API_PREFIX + '/state', handler: (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
    json(res, 200, host.snapshot())
  } }
  const config: WebRoute = { kind: 'exact', path: API_PREFIX + '/config', handler: async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
    const refusal = refuse(req)
    if (refusal) return json(res, refusal.status, { ok: false, error: refusal.error })
    let patch: unknown
    try {
      patch = await readJson(req)
    } catch {
      return json(res, 400, { ok: false, error: 'invalid-json-body' })
    }
    const violation = httpConfigPolicyViolation(patch, host.getConfig(), requiredToken !== '')
    if (violation) return json(res, 403, { ok: false, error: violation })
    try { host.setConfig(patch as Partial<Config>); json(res, 200, { ok: true, config: host.getConfig() } satisfies ConfigResponse) } catch (error) { json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }) }
  } }
  const verify: WebRoute = { kind: 'exact', path: API_PREFIX + '/verify', handler: async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
    const refusal = refuse(req)
    if (refusal) return json(res, refusal.status, { ok: false, error: refusal.error })
    let body: Record<string, unknown>
    try {
      body = await readJson(req) as Record<string, unknown>
    } catch {
      return json(res, 400, { ok: false, error: 'invalid-json-body' })
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { ok: false, error: 'json-object-required' })
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (!sessionId) return json(res, 400, { ok: false, error: 'session-id-required' })
    if (!verifyLimiter()) return json(res, 429, { ok: false, error: 'rate-limited' })
    try {
      const record = await host.verifySession(sessionId)
      if (!record) return json(res, 404, { ok: false, error: 'session-not-found-or-no-completed-turn' })
      json(res, 200, { ok: true, record } satisfies VerifyResponse)
    } catch (error) {
      if (error instanceof VerifyAbortedError) return json(res, 503, { ok: false, error: 'verification-aborted' })
      internalFailure(res, error)
    }
  } }
  const evalRoute: WebRoute = { kind: 'exact', path: API_PREFIX + '/eval', handler: async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
    const refusal = refuse(req)
    if (refusal) return json(res, refusal.status, { ok: false, error: refusal.error })
    let body: Record<string, unknown>
    try {
      body = await readJson(req) as Record<string, unknown>
    } catch {
      return json(res, 400, { ok: false, error: 'invalid-json-body' })
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { ok: false, error: 'json-object-required' })
    // Up to five lanes with a retry each: a caller that disconnected must not
    // keep that provider spend running to completion.
    const signal = clientAbortSignal(res)
    try {
      const problem = typeof body.problem === 'string' ? body.problem.slice(0, 8000) : ''
      const trace = typeof body.trace === 'string' ? body.trace.slice(0, 60000) : ''
      if (!trace.trim()) return json(res, 400, { ok: false, error: 'trace-required' })
      if (!evalLimiter()) return json(res, 429, { ok: false, error: 'rate-limited' })
      const criterion = typeof body.criterion === 'string' && body.criterion.trim() ? body.criterion.slice(0, 2000)
        : 'Did the agent actually complete the requested task correctly, with sufficient evidence from tools or tests?'
      const prompt = buildVerifierPrompt(problem, trace, criterion)
      const routeOverride = typeof body.routes === 'number' ? { routes: Math.max(1, Math.min(5, Math.floor(body.routes))) } : {}
      if (typeof body.allowLabelFallback === 'boolean') (routeOverride as Record<string, unknown>).allowLabelFallback = body.allowLabelFallback
      const aggregate = await verifyFive({ ...host.getConfig(), ...routeOverride }, host.getCredentials(), prompt, { signal })
      if (signal.aborted) return
      json(res, 200, { ok: true, aggregate })
    } catch (error) {
      if (signal.aborted) return
      internalFailure(res, error)
    }
  } }
  const recordsRoute: WebRoute = { kind: 'exact', path: API_PREFIX + '/records', handler: (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
    const url = new URL(req.url ?? '/', 'http://local')
    const sessionId = url.searchParams.get('sessionId') ?? undefined
    const status = url.searchParams.get('status') ?? undefined
    const turnParam = url.searchParams.get('turn')?.trim()
    const turn = turnParam ? (Number.isFinite(Number(turnParam)) ? Number(turnParam) : undefined) : undefined
    const limitText = url.searchParams.get('limit')?.trim()
    const limitParam = limitText ? Number(limitText) : 50
    const limit = Math.max(1, Math.min(VERIFICATION_HISTORY_LIMIT, Number.isFinite(limitParam) ? Math.floor(limitParam) : 50))
    const filtered = host.queryRecords({ sessionId, status, turn })
    json(res, 200, { total: filtered.length, limit, records: filtered.slice(0, limit) })
  } }
  const probe: WebRoute = { kind: 'exact', path: API_PREFIX + '/probe', handler: async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
    const refusal = refuse(req)
    if (refusal) return json(res, refusal.status, { ok: false, error: refusal.error })
    let body: Record<string, unknown>
    try {
      body = await readJson(req) as Record<string, unknown>
    } catch {
      // Malformed input must not silently become an empty-body probe.
      return json(res, 400, { ok: false, error: 'invalid-json-body' })
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { ok: false, error: 'json-object-required' })
    if (!probeLimiter()) return json(res, 429, { ok: false, error: 'rate-limited' })
    const signal = clientAbortSignal(res)
    try {
      const config = host.getConfig()
      const key = await resolveKey(host.getCredentials(), config.apiKeyEnv)
      if (!key) return json(res, 200, { ok: false, error: 'no-key' })
      const target = normalizeBaseUrl(config.baseURL)
      if (!/^https?:\/\//i.test(target)) {
        return json(res, 200, { ok: false, transportOk: false, httpStatus: null, errorCode: 'invalid_base_url', error: 'verifier baseURL must be an http(s) URL', model: config.model })
      }
      if (body.listModels) {
        const listResponse = await fetch(target + '/models', {
          headers: { authorization: 'Bearer ' + key },
          signal: AbortSignal.any([AbortSignal.timeout(30000), signal]),
        })
        const listBody: unknown = await listResponse.json().catch(() => ({}))
        const ids = modelIdsOf(listBody)
        // Upstream health maps straight into ok: a non-2xx listing is NOT a ready provider.
        return json(res, 200, {
          ok: listResponse.ok,
          transportOk: listResponse.ok,
          status: listResponse.status,
          models: ids,
          apiError: listResponse.ok ? undefined : (upstreamErrorMessage(listBody) ?? 'HTTP ' + listResponse.status).slice(0, 240),
        })
      }
      // Ride the production lane path end-to-end: same prompt shape, parser,
      // redaction, retry taxonomy, and abort handling as a real verification.
      const nl = String.fromCharCode(10)
      const problem = ['Reply with exactly three lines and nothing else:', 'finding: probe', '<score_A> K </score_A>', '<score_B> M </score_B>'].join(nl)
      const prompt = buildVerifierPrompt(problem, '[EXTRACTED TOOL EVIDENCE] none' + nl + 'PROBE TRACE: no trajectory; this request only checks protocol readiness.', 'Probe criterion: follow the output protocol exactly.')
      const result = await verifyRoute(config, host.getCredentials(), prompt, 1, { signal })
      if (signal.aborted) return
      const hasScoreTags = Boolean(result.scoreALabel && result.scoreBLabel)
      const scoreTokenLogprobs = result.ok && result.scoreSource === 'logprobs'
      json(res, 200, {
        ok: true,
        transportOk: typeof result.httpStatus === 'number' ? result.httpStatus > 0 && result.httpStatus < 400 : false,
        httpStatus: result.httpStatus ?? null,
        finish: result.finishReason ?? null,
        hasScoreTags,
        scoreTokenLogprobs,
        scoreSource: result.scoreSource ?? null,
        reasoningSource: result.reasoningSource ?? null,
        lane: result.lane ?? null,
        errorCode: result.errorCode ?? null,
        error: result.error ?? null,
        retried: result.retried ?? false,
        durationMs: result.durationMs,
        strictReady: result.ok === true && result.scoreSource === 'logprobs',
        model: config.model,
      })
    } catch (error) {
      if (signal.aborted) return
      internalFailure(res, error)
    }
  } }
  const events: WebRoute = { kind: 'exact', path: API_PREFIX + '/events', handler: (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
    let closed = false
    const push = (): void => { try { res.write('data: ' + JSON.stringify(host.snapshot()) + '\n\n') } catch { /* a dead connection must not break the Host */ } }
    const unsubscribe = host.subscribe(push)
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n') } catch { /* ignored */ } }, 15000)
    const close = (): void => { if (closed) return; closed = true; clearInterval(heartbeat); unsubscribe() }
    req.once('close', close); res.once('close', close); push()
  } }
  // --- best-of-N manual API. Autopilot reaches the same SelectionHost from
  // pre-step; this route remains the explicit diagnostic/operator entry.
  // /select spawns N real child agents and never synthesizes a source verdict.
  const selectLimiter = createRateLimiter(API_RATE_LIMITS.selectPerHour, 3_600_000)
  const selectRoute: WebRoute = { kind: 'exact', path: API_PREFIX + '/select', handler: async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
    const refusal = refuse(req)
    if (refusal) return json(res, refusal.status, { ok: false, error: refusal.error })
    let body: Record<string, unknown>
    try {
      body = await readJson(req) as Record<string, unknown>
    } catch {
      return json(res, 400, { ok: false, error: 'invalid-json-body' })
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { ok: false, error: 'json-object-required' })
    // trigger/policy/taskKind are trusted Host orchestration metadata, not
    // public knobs: accepting them here could give a manual caller autopilot's
    // retention and relay lifecycle.
    if (['trigger', 'policy', 'taskKind'].some(key => Object.prototype.hasOwnProperty.call(body, key))) {
      return json(res, 400, { ok: false, error: 'reserved-selection-field' })
    }
    // Peek before admission, commit only after the host actually accepted the
    // run: a busy or invalid /select spawns zero candidates and must not spend
    // one of the 12/hour provider-spend slots.
    if (!selectLimiter.peek()) return json(res, 429, { ok: false, error: 'rate-limited' })
    try {
      const selection = await host.selections.start({ ...(body as SelectionStartRequest), trigger: 'manual' })
      selectLimiter.commit()
      json(res, 202, { ok: true, selection } satisfies SelectionStartResponse)
    } catch (error) {
      selectionFailure(res, error)
    }
  } }
  const selectionsRoute: WebRoute = { kind: 'exact', path: API_PREFIX + '/selections', handler: (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
    const url = new URL(req.url ?? '/', 'http://local')
    const selectionId = url.searchParams.get('selectionId') ?? undefined
    if (selectionId) {
      const selection = host.selections.getSelection(selectionId)
      if (!selection) return json(res, 404, { ok: false, error: 'selection-not-found' })
      return json(res, 200, { ok: true, selection } satisfies SelectionItemResponse)
    }
    json(res, 200, { ok: true, active: host.selections.activeSelectionId(), retainedWinners: host.selections.snapshot().retainedWinners, selections: host.selections.listSelections().slice(0, 20) } satisfies SelectionsListResponse)
  } }
  const cancelSelectionRoute: WebRoute = { kind: 'exact', path: API_PREFIX + '/selections/cancel', handler: async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
    const refusal = refuse(req)
    if (refusal) return json(res, refusal.status, { ok: false, error: refusal.error })
    const parsed = await readSelectionIdRequest(req)
    if (!parsed.ok) return json(res, parsed.status, { ok: false, error: parsed.error })
    const selectionId = parsed.selectionId
    try {
      if (!host.selections.cancel(selectionId)) return json(res, 404, { ok: false, error: 'selection-not-active' })
      json(res, 200, { ok: true } satisfies SelectionActionResponse)
    } catch (error) {
      selectionFailure(res, error)
    }
  } }
  const releaseWinnerRoute: WebRoute = { kind: 'exact', path: API_PREFIX + '/selections/release', handler: async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
    const refusal = refuse(req)
    if (refusal) return json(res, refusal.status, { ok: false, error: refusal.error })
    const parsed = await readSelectionIdRequest(req)
    if (!parsed.ok) return json(res, parsed.status, { ok: false, error: parsed.error })
    const selectionId = parsed.selectionId
    try {
      const selection = host.selections.getSelection(selectionId)
      if (!selection || !selection.winner) return json(res, 404, { ok: false, error: 'selection-or-winner-not-found' })
      // Manual winners release at settlement; autopilot winners release when the
      // source turn settles. The route stays idempotent for stale GUI panels.
      const released = await host.selections.releaseWinner(selectionId)
      json(res, 200, { ok: true, state: released } satisfies SelectionReleaseResponse)
    } catch (error) {
      selectionFailure(res, error)
    }
  } }
  const discardWinnerRoute: WebRoute = { kind: 'exact', path: API_PREFIX + '/selections/discard', handler: async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
    const refusal = refuse(req)
    if (refusal) return json(res, refusal.status, { ok: false, error: refusal.error })
    const parsed = await readSelectionIdRequest(req)
    if (!parsed.ok) return json(res, parsed.status, { ok: false, error: parsed.error })
    const selectionId = parsed.selectionId
    try {
      // Workspace/journal removal can fail (foreign toplevel, locked worktree):
      // that is a 500 carrying the reason, never a hung request.
      if (!(await host.selections.discardWinner(selectionId))) return json(res, 404, { ok: false, error: 'no-discardable-winner' })
      json(res, 200, { ok: true } satisfies SelectionActionResponse)
    } catch (error) {
      selectionFailure(res, error)
    }
  } }
  return [state, config, verify, recordsRoute, evalRoute, probe, events, selectRoute, selectionsRoute, cancelSelectionRoute, releaseWinnerRoute, discardWinnerRoute]
}
