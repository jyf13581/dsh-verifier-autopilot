/**
 * Candidate-model liveness probing (ruling 6.4.4 todo / B-3 defense).
 *
 * `listModels()` only lists the provider catalog; a catalog-listed model can
 * be dead for days (kimi-k3 0/11 window, 2026-09-03/04). quality-first then
 * slots every candidate onto the dead first entry and the whole selection
 * burns down. This prober performs one tiny real request per model and caches
 * the verdict, so liveness — not directory membership — decides the pool.
 *
 * Pure module: fetch/clock are injected for offline tests.
 */

export interface ProbeVerdict { ok: boolean; at: number; detail?: string }

export interface ModelProberOptions {
  baseURL: string
  /** Resolved API key value (never logged). */
  apiKey: string
  fetchImpl?: typeof fetch
  now?: () => number
  /** Per-request timeout for the probe call (default 10s). */
  probeTimeoutMs?: number
  /** How long a dead verdict is trusted before one retry (default 120s). */
  deadCooldownMs?: number
}

export interface ModelProber {
  /** true = model answered; false = timeout / HTTP failure. Results are
   *  cached: an ok verdict lasts until reload, a dead verdict cools off.
   *  Concurrent probes of the same model share one in-flight request. */
  probe(model: string): Promise<boolean>
  /** Force a model into the dead window (e.g. after a rollout failure). */
  markDead(model: string, detail?: string): void
  snapshot(): Record<string, ProbeVerdict>
}

export function createModelProber(options: ModelProberOptions): ModelProber {
  const doFetch = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const timeoutMs = options.probeTimeoutMs ?? 10_000
  const cooldownMs = options.deadCooldownMs ?? 120_000
  const table = new Map<string, ProbeVerdict>()
  /** One request per model at a time: parallel pre-steps (or a duplicated
   *  entry in the preferred list) coalesce onto the same verdict instead of
   *  spending N identical provider calls. */
  const inFlight = new Map<string, Promise<boolean>>()

  const probeOnce = async (model: string): Promise<boolean> => {
    let ok = false
    let detail: string | undefined
    try {
      const response = await doFetch(options.baseURL.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + options.apiKey },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      ok = response.ok
      detail = 'http-' + response.status
      // The verdict is the status line; release the connection instead of
      // leaving an unread body to pin a keep-alive socket until GC.
      try { await response.body?.cancel() } catch { /* already drained or closed */ }
    } catch (error) {
      ok = false
      detail = error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120)
    }
    table.set(model, { ok, at: now(), detail })
    return ok
  }

  return {
    probe(model: string): Promise<boolean> {
      const cached = table.get(model)
      if (cached) {
        if (cached.ok) return Promise.resolve(true)
        if (now() - cached.at < cooldownMs) return Promise.resolve(false)
      }
      const pending = inFlight.get(model)
      if (pending) return pending
      const request = probeOnce(model).finally(() => { inFlight.delete(model) })
      inFlight.set(model, request)
      return request
    },
    markDead(model: string, detail?: string): void {
      table.set(model, { ok: false, at: now(), detail })
    },
    snapshot(): Record<string, ProbeVerdict> {
      return Object.fromEntries(table.entries())
    },
  }
}
