/**
 * Objective per-candidate checks: caller-supplied shell commands that run in
 * the candidate's own workspace. A non-zero exit or timeout eliminates the
 * candidate before any verifier comparison — HANDOFF §2.3.
 */

import { spawn } from 'node:child_process'

export interface ObjectiveCheck {
  name: string
  command: string
  timeoutMs?: number
}

export interface CheckResult {
  name: string
  ok: boolean
  exitCode: number | null
  durationMs: number
  /** Bounded tail of combined stdout+stderr, for the record. */
  outputTail: string
}

export interface RunChecksOptions {
  signal?: AbortSignal
  defaultTimeoutMs?: number
  outputTailChars?: number
  now?: () => number
}

export async function runChecks(
  cwd: string,
  checks: readonly ObjectiveCheck[],
  options: RunChecksOptions = {},
): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  for (const check of checks) {
    results.push(await runOne(cwd, check, options))
    if (options.signal?.aborted) break
  }
  return results
}

function runOne(cwd: string, check: ObjectiveCheck, options: RunChecksOptions): Promise<CheckResult> {
  const start = (options.now ?? Date.now)()
  const cap = options.outputTailChars ?? 2000
  const timeoutMs = check.timeoutMs ?? options.defaultTimeoutMs ?? 60000
  return new Promise((resolve) => {
    let output = ''
    const child = spawn('pwsh', ['-NoProfile', '-Command', check.command], { cwd, windowsHide: true })
    const onData = (chunk: Buffer | string) => {
      output = (output + String(chunk)).slice(-cap)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    const done = (exitCode: number | null) => {
      cleanup()
      resolve({
        name: check.name,
        ok: exitCode === 0,
        exitCode,
        durationMs: (options.now ?? Date.now)() - start,
        outputTail: output,
      })
    }
    // kill() terminates pwsh.exe only; grandchildren spawned INSIDE the check
    // command survive a timeout on Windows (no job-object kill here). Accepted
    // boundary — keep check commands self-contained in the candidate workspace.
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      done(null)
    }, timeoutMs)
    const onAbort = () => {
      try { child.kill() } catch { /* already gone */ }
      done(null)
    }
    const cleanup = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', () => done(null))
    child.on('exit', (code) => done(code))
  })
}
