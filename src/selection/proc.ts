/** Bounded child-process execution shared by the workspace/git helpers and
 * the objective-check harness.
 *
 * Every hand-rolled spawn wrapper in this plugin had drifted on the same four
 * details: how output is bounded, what a timeout does to a child that ignores
 * the signal, how an abort is wired, and whether completion waits for the
 * stdio streams to flush. This module owns them once:
 *
 *  - output is one combined stdout+stderr string, bounded to `cap` characters,
 *    keeping either the tail (diagnostics: the failure is at the end) or the
 *    head (evidence listings: truncate the end, never the start);
 *  - a timeout or abort kills the child, then hard-kills it after a short
 *    grace, and always settles the promise;
 *  - completion waits for `close` (all stdio flushed) after `exit`, bounded by
 *    a flush grace so a background grandchild that inherited the pipes cannot
 *    pin the caller; the exit code is the child's own either way;
 *  - a process that never started (`ENOENT`, `EACCES`) is reported as such,
 *    distinct from a non-zero exit — the difference between "the harness is
 *    missing" and "the command failed".
 *
 * Dependency-free (Node only) so both `live.ts` and `checks.ts` can share it
 * without a cycle.
 */

import { spawn, type ChildProcess } from 'node:child_process'

export interface RunProcessOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Wall-clock budget; the child is killed when it elapses. Default 30 s. */
  timeoutMs?: number
  signal?: AbortSignal
  /** Characters of combined output retained. Default 2000. */
  cap?: number
  /** Which end of an over-long output survives. Default `tail`. */
  keep?: 'head' | 'tail'
  now?: () => number
}

/** Why a result has no honest exit code, or `exit` when it has one. */
export type ProcessEnd = 'exit' | 'spawn-failed' | 'timeout' | 'aborted'

export interface ProcessResult {
  /** The child's exit code; null whenever `end !== 'exit'`. */
  code: number | null
  /** Bounded combined stdout+stderr. */
  out: string
  end: ProcessEnd
  durationMs: number
  /** Spawn failure text (`spawn pwsh ENOENT`), only for `end === 'spawn-failed'`. */
  error?: string
}

/** Environment-variable names that carry credentials by convention: any
 *  `_`-delimited segment naming a key, token, secret, password, credential, or
 *  auth handle (KIMI_API_KEY, GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY,
 *  SSH_AUTH_SOCK, NPM_CONFIG__AUTH). Matching is per segment, so KEYBOARD or
 *  TOKENIZERS_PARALLELISM survive. */
const SECRET_ENV_NAME = /(?:^|_)(?:API_?KEYS?|KEYS?|TOKENS?|SECRETS?|PASSWORDS?|PASSWD|PASS|CREDENTIALS?|AUTH|PRIVATE)(?:_|$)/i

/** Review R1 (1.2): a copy of `env` without credential-shaped variables and
 *  without the explicitly named ones (the configured verifier key). Objective
 *  checks and the post-audit execute candidate-authored code (`npm test` runs
 *  whatever tests the candidate wrote), so they must not inherit the Host's
 *  provider keys. PATH, HOME, locale, proxy, and toolchain variables stay. */
export function scrubSecretEnv(extraNames: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const explicit = new Set(extraNames.filter(name => typeof name === 'string' && name).map(name => name.toUpperCase()))
  const out: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (explicit.has(name.toUpperCase()) || SECRET_ENV_NAME.test(name)) continue
    out[name] = value
  }
  return out
}

/** How long a killed child may take to release its stdio before we stop waiting. */
const KILL_GRACE_MS = 2000
/** How long after `exit` we wait for `close` (stdio flush) before settling anyway. */
const FLUSH_GRACE_MS = 1000

export function runProcess(cmd: string, args: readonly string[], options: RunProcessOptions = {}): Promise<ProcessResult> {
  const now = options.now ?? Date.now
  const start = now()
  const cap = Math.max(0, options.cap ?? 2000)
  const keep = options.keep ?? 'tail'
  const timeoutMs = Math.max(1, options.timeoutMs ?? 30000)
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    let end: ProcessEnd = 'exit'
    let spawnError: string | undefined
    let exitCode: number | null | undefined
    let closed = false
    let timer: NodeJS.Timeout | null = null
    let graceTimer: NodeJS.Timeout | null = null
    let flushTimer: NodeJS.Timeout | null = null
    let child: ChildProcess | null = null

    const take = (chunk: Buffer | string): void => {
      if (cap === 0) return
      if (keep === 'tail') out = (out + String(chunk)).slice(-cap)
      else if (out.length < cap) out = (out + String(chunk)).slice(0, cap)
    }
    const finish = (): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      if (flushTimer) clearTimeout(flushTimer)
      options.signal?.removeEventListener('abort', onAbort)
      // Settling before 'close' means something still holds the pipes (a
      // grandchild that inherited them). Release our ends so it cannot keep
      // this process's event loop alive; it will see EPIPE if it writes.
      if (!closed) {
        try { child?.stdout?.destroy() } catch { /* already closed */ }
        try { child?.stderr?.destroy() } catch { /* already closed */ }
      }
      resolve({
        code: end === 'exit' ? (exitCode ?? null) : null,
        out,
        end,
        durationMs: now() - start,
        ...(spawnError ? { error: spawnError } : {}),
      })
    }
    const terminate = (why: Exclude<ProcessEnd, 'exit'>): void => {
      if (settled) return
      if (end === 'exit') end = why
      try { child?.kill() } catch { /* already gone */ }
      // A child that ignores the signal (or a Windows shell whose grandchildren
      // hold the pipes) must not pin the caller: escalate, then settle.
      graceTimer = setTimeout(() => {
        try { child?.kill('SIGKILL') } catch { /* already gone */ }
        finish()
      }, KILL_GRACE_MS)
    }
    const onAbort = (): void => terminate('aborted')

    try {
      child = spawn(cmd, [...args], { cwd: options.cwd, env: options.env, windowsHide: true })
    } catch (error) {
      // Synchronous spawn failures (invalid arguments) are rare; report them
      // exactly like the asynchronous ENOENT so callers see one shape.
      spawnError = error instanceof Error ? error.message : String(error)
      end = 'spawn-failed'
      finish()
      return
    }
    timer = setTimeout(() => terminate('timeout'), timeoutMs)
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    child.on('error', (error) => {
      // 'error' also fires for a failed kill(); only a child that never ran
      // turns into a spawn failure.
      if (exitCode === undefined && end === 'exit') {
        spawnError = error.message
        end = 'spawn-failed'
      }
      finish()
    })
    child.on('exit', (code) => {
      exitCode = code
      if (closed || settled) return
      flushTimer = setTimeout(finish, FLUSH_GRACE_MS)
    })
    child.on('close', (code) => {
      closed = true
      if (exitCode === undefined) exitCode = code
      finish()
    })
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
  })
}
