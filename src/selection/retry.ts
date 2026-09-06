import { BridgeError } from './bridge.js'

// Keep longer delays available for explicit diagnostics. Production callers
// pass maxAttempts=2 so a transient outage cannot multiply the full timeout.
export const TRANSIENT_RETRY_DELAYS_MS = [2000, 5000, 10000] as const

export type RetrySleep = (delayMs: number, signal?: AbortSignal) => Promise<void>

export interface RetryAttemptContext {
  attempt: number
  /** Remaining shared budget for this attempt, when a deadline is set. */
  timeoutMs?: number
  /** Aborts on caller cancellation or shared-deadline expiry. */
  signal: AbortSignal
}

export type RetryOperation<T> = (context: RetryAttemptContext) => Promise<T>

export function abortableRetrySleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new BridgeError('bridge_aborted', 'selection aborted during verifier retry', false))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, Math.max(0, delayMs))
    function done(): void {
      signal?.removeEventListener('abort', aborted)
      resolve()
    }
    function aborted(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      reject(new BridgeError('bridge_aborted', 'selection aborted during verifier retry', false))
    }
    signal?.addEventListener('abort', aborted, { once: true })
  })
}

function timeoutError(): BridgeError {
  return new BridgeError('selection_timeout', 'verifier selection exceeded its absolute budget', false)
}

function abortError(): BridgeError {
  return new BridgeError('bridge_aborted', 'selection aborted during verifier retry', false)
}

/** Retry only transient bridge failures inside one absolute time budget. */
export async function retryTransientBridge<T>(
  operation: RetryOperation<T>,
  options: {
    signal?: AbortSignal
    sleep?: RetrySleep
    delaysMs?: readonly number[]
    /** Absolute epoch deadline shared by every attempt and backoff. */
    deadlineAt?: number
    /** Total attempts, including the first. Defaults to two. */
    maxAttempts?: number
    now?: () => number
    onAttempt?: (attempt: number) => void
    onRetry?: (error: BridgeError, attempt: number, delayMs: number) => void
  } = {},
): Promise<T> {
  const delays = options.delaysMs ?? TRANSIENT_RETRY_DELAYS_MS
  const sleep = options.sleep ?? abortableRetrySleep
  const now = options.now ?? Date.now
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 2))
  const deadlineAt = Number.isFinite(options.deadlineAt) ? Number(options.deadlineAt) : undefined
  const controller = new AbortController()
  let externallyAborted = false
  let deadlineExpired = false
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  let rejectControl: ((error: BridgeError) => void) | undefined
  const controlPromise = new Promise<never>((_, reject) => { rejectControl = reject })
  // The control promise can reject before the first race (already-aborted
  // caller). Attach a sink so that path never creates an unhandled rejection;
  // Promise.race still observes the original rejection below.
  void controlPromise.catch(() => undefined)

  const abortCaller = (): void => {
    externallyAborted = true
    if (!controller.signal.aborted) controller.abort()
    rejectControl?.(abortError())
  }
  const expire = (): void => {
    deadlineExpired = true
    if (!controller.signal.aborted) controller.abort()
    rejectControl?.(timeoutError())
  }
  const remainingMs = (): number | undefined => {
    if (deadlineAt === undefined) return undefined
    return Math.max(1, Math.floor(deadlineAt - now()))
  }

  try {
    if (options.signal?.aborted) abortCaller()
    else options.signal?.addEventListener('abort', abortCaller, { once: true })
    if (deadlineAt !== undefined) {
      const remaining = deadlineAt - now()
      if (remaining <= 0) expire()
      else deadlineTimer = setTimeout(expire, remaining)
    }

    for (let attempt = 1; ; attempt += 1) {
      if (externallyAborted) throw abortError()
      if (deadlineExpired || (deadlineAt !== undefined && deadlineAt <= now())) {
        expire()
        throw timeoutError()
      }
      options.onAttempt?.(attempt)
      try {
        const operationPromise = operation({ attempt, timeoutMs: remainingMs(), signal: controller.signal })
        const result = await Promise.race([operationPromise, controlPromise])
        if (externallyAborted) throw abortError()
        if (deadlineExpired || (deadlineAt !== undefined && deadlineAt <= now())) {
          expire()
          throw timeoutError()
        }
        return result
      } catch (error) {
        if (externallyAborted) throw abortError()
        if (deadlineExpired || (deadlineAt !== undefined && deadlineAt <= now())) {
          expire()
          throw timeoutError()
        }
        const delayMs = delays[attempt - 1]
        if (!(error instanceof BridgeError) || !error.retriable || delayMs === undefined || attempt >= maxAttempts) throw error
        const remaining = deadlineAt === undefined ? undefined : deadlineAt - now()
        if (remaining !== undefined && remaining <= delayMs) {
          options.onRetry?.(error, attempt, Math.max(0, Math.floor(remaining)))
          expire()
          throw timeoutError()
        }
        options.onRetry?.(error, attempt, delayMs)
        try {
          await Promise.race([sleep(delayMs, controller.signal), controlPromise])
        } catch (backoffError) {
          if (externallyAborted) throw abortError()
          if (deadlineExpired || (deadlineAt !== undefined && deadlineAt <= now())) {
            expire()
            throw timeoutError()
          }
          throw backoffError
        }
      }
    }
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
    options.signal?.removeEventListener('abort', abortCaller)
  }
}
