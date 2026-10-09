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
 *    missing" and "the command failed";
 *  - on POSIX every child leads its own process group, and a timeout/abort
 *    signals the whole group, so a shell's grandchildren (`npm test` → node,
 *    `sleep` inside a script) die with it (review R4 4.4). `reapGroup` also
 *    kills whatever the command left running after a normal exit. Windows has
 *    no process groups here; a best-effort `taskkill /T` covers the tree while
 *    the root is still alive;
 *  - stdin always reaches EOF (optionally after `input`), and a child that
 *    exits without reading it cannot raise an unhandled EPIPE (review R4
 *    4.7b: that error event used to terminate the whole host process).
 *
 * `runProcess` keeps a bounded text tail/head; `runProcessCapture` keeps raw
 * stdout bytes up to a limit (and kills the child past it) for git plumbing.
 * Both run on the same core, so there is one spawn policy (review R4 4.7).
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
  /** Bytes written to the child's stdin before EOF. Default: none (EOF at once). */
  input?: Buffer | string
  /** POSIX: after the command exits, kill anything still running in its
   *  process group (background jobs a check left behind). Default false. */
  reapGroup?: boolean
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

const POSIX_GROUPS = process.platform !== 'win32'

/** Signal the child's whole tree. POSIX: the process group it leads (it was
 *  spawned detached). Windows: `taskkill /T /F` while the root is alive,
 *  plus the direct kill. Never throws. */
function signalTree(child: ChildProcess | null, signal: NodeJS.Signals): void {
  if (!child || child.pid === undefined) return
  if (POSIX_GROUPS) {
    try { process.kill(-child.pid, signal); return } catch { /* group gone, or not a leader: fall back */ }
    try { child.kill(signal) } catch { /* already gone */ }
    return
  }
  if (child.exitCode === null && child.signalCode === null) {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => { /* best effort */ })
    } catch { /* best effort */ }
  }
  try { child.kill(signal) } catch { /* already gone */ }
}

type CoreEnd = ProcessEnd | 'overflow'

interface CoreResult { code: number | null; end: CoreEnd; durationMs: number; error?: string }

interface CoreSink {
  /** Return false to stop the child (`end: 'overflow'`). */
  stdout(chunk: Buffer): boolean
  stderr(chunk: Buffer): void
}

function spawnBounded(cmd: string, args: readonly string[], options: RunProcessOptions, sink: CoreSink): Promise<CoreResult> {
  const now = options.now ?? Date.now
  const start = now()
  const timeoutMs = Math.max(1, options.timeoutMs ?? 30000)
  return new Promise((resolve) => {
    let settled = false
    let end: CoreEnd = 'exit'
    let spawnError: string | undefined
    let exitCode: number | null | undefined
    let closed = false
    let timer: NodeJS.Timeout | null = null
    let graceTimer: NodeJS.Timeout | null = null
    let flushTimer: NodeJS.Timeout | null = null
    let child: ChildProcess | null = null

    const finish = (): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      if (flushTimer) clearTimeout(flushTimer)
      options.signal?.removeEventListener('abort', onAbort)
      // A stopped run gets a final hard sweep: group members that ignored (or
      // had no time to act on) the polite signal must not outlive the call.
      // A finished run is swept only on request (reapGroup).
      if (end !== 'exit' && end !== 'spawn-failed') signalTree(child, 'SIGKILL')
      else if (end === 'exit' && options.reapGroup && POSIX_GROUPS) signalTree(child, 'SIGKILL')
      // Settling before 'close' means something still holds the pipes (a
      // grandchild that inherited them). Release our ends so it cannot keep
      // this process's event loop alive; it will see EPIPE if it writes.
      if (!closed) {
        try { child?.stdout?.destroy() } catch { /* already closed */ }
        try { child?.stderr?.destroy() } catch { /* already closed */ }
      }
      resolve({
        code: end === 'exit' ? (exitCode ?? null) : null,
        end,
        durationMs: now() - start,
        ...(spawnError ? { error: spawnError } : {}),
      })
    }
    const terminate = (why: Exclude<CoreEnd, 'exit' | 'spawn-failed'>): void => {
      if (settled) return
      if (end === 'exit') end = why
      signalTree(child, 'SIGTERM')
      // A child that ignores the signal (or a Windows shell whose grandchildren
      // hold the pipes) must not pin the caller: escalate, then settle.
      if (!graceTimer) {
        graceTimer = setTimeout(() => {
          signalTree(child, 'SIGKILL')
          finish()
        }, KILL_GRACE_MS)
      }
    }
    const onAbort = (): void => terminate('aborted')

    try {
      // detached on POSIX = setsid: the child leads a new process group whose
      // id is its pid, which is what signalTree() addresses.
      child = spawn(cmd, [...args], { cwd: options.cwd, env: options.env, windowsHide: true, detached: POSIX_GROUPS })
    } catch (error) {
      // Synchronous spawn failures (invalid arguments) are rare; report them
      // exactly like the asynchronous ENOENT so callers see one shape.
      spawnError = error instanceof Error ? error.message : String(error)
      end = 'spawn-failed'
      finish()
      return
    }
    timer = setTimeout(() => terminate('timeout'), timeoutMs)
    child.stdout?.on('data', (value: Buffer | string) => {
      if (settled || end !== 'exit') return
      if (!sink.stdout(Buffer.isBuffer(value) ? value : Buffer.from(value))) terminate('overflow')
    })
    child.stderr?.on('data', (value: Buffer | string) => sink.stderr(Buffer.isBuffer(value) ? value : Buffer.from(value)))
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
    // EOF on stdin always: a command that reads it gets end-of-input instead
    // of blocking until the timeout. A child that exits without draining it
    // makes the write fail with EPIPE — an 'error' event that, unhandled,
    // would take down the whole host process.
    child.stdin?.on('error', () => { /* the child's own exit status reports the failure */ })
    try { child.stdin?.end(options.input) } catch { /* stdin already closed */ }
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function runProcess(cmd: string, args: readonly string[], options: RunProcessOptions = {}): Promise<ProcessResult> {
  const cap = Math.max(0, options.cap ?? 2000)
  const keep = options.keep ?? 'tail'
  let out = ''
  const take = (chunk: Buffer): void => {
    if (cap === 0) return
    if (keep === 'tail') out = (out + String(chunk)).slice(-cap)
    else if (out.length < cap) out = (out + String(chunk)).slice(0, cap)
  }
  return spawnBounded(cmd, args, options, { stdout: (chunk) => { take(chunk); return true }, stderr: take }).then((result) => ({
    // runProcess never stops on output volume, so 'overflow' cannot occur.
    code: result.code,
    out,
    end: result.end === 'overflow' ? 'aborted' : result.end,
    durationMs: result.durationMs,
    ...(result.error ? { error: result.error } : {}),
  }))
}

export interface CaptureOptions extends Omit<RunProcessOptions, 'cap' | 'keep'> {
  /** Stdout bytes kept; one more byte stops the child. Default 8 MiB. */
  maxOutputBytes?: number
  /** Characters of stderr tail kept. Default 4000. */
  errorCap?: number
}

export interface CaptureResult {
  code: number | null
  end: ProcessEnd | 'overflow'
  /** Raw stdout bytes (complete unless `end === 'overflow'`). */
  out: Buffer
  /** Bounded stderr tail. */
  error: string
  durationMs: number
}

/** Byte-exact stdout capture (git plumbing: patches, NUL-separated lists). */
export function runProcessCapture(cmd: string, args: readonly string[], options: CaptureOptions = {}): Promise<CaptureResult> {
  const limit = Math.max(0, options.maxOutputBytes ?? 8 * 1024 * 1024)
  const errorCap = Math.max(0, options.errorCap ?? 4000)
  const chunks: Buffer[] = []
  let total = 0
  let error = ''
  return spawnBounded(cmd, args, options, {
    stdout: (chunk) => {
      total += chunk.length
      if (total > limit) return false
      chunks.push(chunk)
      return true
    },
    stderr: (chunk) => { error = (error + String(chunk)).slice(-errorCap) },
  }).then((result) => ({
    code: result.code,
    end: result.end,
    out: Buffer.concat(chunks),
    error: result.error ? (error + ' ' + result.error).trim() : error,
    durationMs: result.durationMs,
  }))
}
