/**
 * Objective per-candidate checks: caller-supplied shell commands that run in
 * the candidate's own workspace. A non-zero exit or timeout eliminates the
 * candidate before any verifier comparison — HANDOFF §2.3.
 *
 * The shell is a harness, not part of the verdict. It is resolved once per
 * process from a platform chain (PowerShell 7 everywhere it exists — the
 * project's check dialect — then Windows PowerShell on win32 or `/bin/sh`
 * elsewhere), and it is injectable so tests and embedded hosts can pin one.
 * A shell that cannot be started, or a command the shell cannot parse, is a
 * harness error: recorded, never evidence against the candidate (ruling B-10).
 */

import { runProcess, scrubSecretEnv } from './proc.js'

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
  /** True when the failure is the harness's, not the candidate's: the shell
   *  could not be started, or the command itself never ran because the shell
   *  rejected it (pwsh quoted-argument mangling killed sel-5e84f540 before any
   *  candidate artifact was examined — ruling B-10). Such failures must not
   *  eliminate a candidate. */
  harnessError?: boolean
  /** Which shell ran the command, for the audit record. */
  shell?: string
}

/** A shell invocation: `file` plus the arguments that precede the command
 *  string. The check command is always appended as one final argument. */
export interface CheckShell {
  /** Short stable label recorded on results (`pwsh`, `sh`). */
  name: string
  file: string
  args: readonly string[]
}

export const POWERSHELL_CORE: CheckShell = { name: 'pwsh', file: 'pwsh', args: ['-NoProfile', '-Command'] }
export const WINDOWS_POWERSHELL: CheckShell = { name: 'powershell', file: 'powershell', args: ['-NoProfile', '-Command'] }
export const POSIX_SH: CheckShell = { name: 'sh', file: '/bin/sh', args: ['-c'] }

/** Preference order per platform. PowerShell 7 first wherever it is installed
 *  because check commands in this project are written in its dialect; the
 *  platform's always-present shell is the fallback so a host without pwsh
 *  still runs plain commands (`npm test`) instead of eliminating everyone. */
export function defaultCheckShells(platform: NodeJS.Platform = process.platform): CheckShell[] {
  return platform === 'win32' ? [POWERSHELL_CORE, WINDOWS_POWERSHELL] : [POWERSHELL_CORE, POSIX_SH]
}

const HARNESS_ERROR_PATTERNS = [
  // PowerShell
  /\bis not recognized as\b/i,
  /(?:ParserError|UnexpectedToken|MissingExpression|Missing closing|Missing statement|syntax error)/i,
  // POSIX sh / bash / dash
  /\bcommand not found\b/i,
  /: not found\b/,
  /\bSyntax error\b/,
]

/** A failed check whose entire tail is shell-level interpreter noise proves
 *  nothing about the candidate; the check command itself was broken. */
export function isHarnessError(outputTail: string): boolean {
  return HARNESS_ERROR_PATTERNS.some((pattern) => pattern.test(outputTail))
}

export interface RunChecksOptions {
  signal?: AbortSignal
  defaultTimeoutMs?: number
  outputTailChars?: number
  now?: () => number
  /** Shell preference chain; the first one that starts is used for every
   *  check. Defaults to the platform chain. */
  shells?: readonly CheckShell[]
  /** Extra variable names to withhold from the check environment (the
   *  configured verifier key). Credential-shaped names are always withheld:
   *  checks execute candidate-authored code (review R1 1.2). */
  secretEnvNames?: readonly string[]
}

const SHELL_PROBE_TIMEOUT_MS = 15000

/** Resolved shell per chain (keyed by its files), so the probe runs once per
 *  process and concurrent callers share it. A chain with no startable shell
 *  resolves to null and every check reports a harness error. */
const resolvedShells = new Map<string, Promise<{ shell: CheckShell | null; failures: string[] }>>()

function chainKey(shells: readonly CheckShell[]): string {
  return shells.map((shell) => shell.file + ' ' + shell.args.join(' ')).join(String.fromCharCode(0))
}

/** The first shell in `shells` that can be started on this host. Availability
 *  is proven by running a trivial command through it, not by scanning PATH,
 *  so the answer is exactly what `runChecks` will experience. */
export function resolveCheckShell(shells: readonly CheckShell[] = defaultCheckShells()): Promise<{ shell: CheckShell | null; failures: string[] }> {
  const key = chainKey(shells)
  let pending = resolvedShells.get(key)
  if (!pending) {
    pending = (async () => {
      const failures: string[] = []
      for (const shell of shells) {
        const probe = await runProcess(shell.file, [...shell.args, 'exit 0'], { timeoutMs: SHELL_PROBE_TIMEOUT_MS, cap: 400 })
        if (probe.end === 'exit') return { shell, failures }
        failures.push(shell.name + ': ' + (probe.error ?? probe.end))
      }
      return { shell: null, failures }
    })()
    resolvedShells.set(key, pending)
  }
  return pending
}

/** Test seam: forget probe results (e.g. after PATH manipulation). */
export function resetCheckShellCache(): void {
  resolvedShells.clear()
}

export async function runChecks(
  cwd: string,
  checks: readonly ObjectiveCheck[],
  options: RunChecksOptions = {},
): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  if (checks.length === 0) return results
  const { shell, failures } = await resolveCheckShell(options.shells)
  for (const check of checks) {
    results.push(shell ? await runOne(cwd, check, shell, options) : noShellResult(check, failures))
    if (options.signal?.aborted) break
  }
  return results
}

function noShellResult(check: ObjectiveCheck, failures: string[]): CheckResult {
  return {
    name: check.name,
    ok: false,
    exitCode: null,
    durationMs: 0,
    outputTail: 'harness: no usable shell (' + failures.join('; ') + ')',
    harnessError: true,
  }
}

async function runOne(cwd: string, check: ObjectiveCheck, shell: CheckShell, options: RunChecksOptions): Promise<CheckResult> {
  // kill() terminates the shell only; grandchildren spawned INSIDE the check
  // command survive a timeout on Windows (no job-object kill here). Accepted
  // boundary — keep check commands self-contained in the candidate workspace.
  const result = await runProcess(shell.file, [...shell.args, check.command], {
    cwd,
    env: scrubSecretEnv(options.secretEnvNames),
    timeoutMs: check.timeoutMs ?? options.defaultTimeoutMs ?? 60000,
    signal: options.signal,
    cap: options.outputTailChars ?? 2000,
    keep: 'tail',
    now: options.now,
  })
  if (result.end === 'spawn-failed') {
    return {
      name: check.name,
      ok: false,
      exitCode: null,
      durationMs: result.durationMs,
      outputTail: 'harness: could not start ' + shell.name + ' (' + (result.error ?? 'spawn failed') + ')',
      harnessError: true,
      shell: shell.name,
    }
  }
  const ok = result.end === 'exit' && result.code === 0
  return {
    name: check.name,
    ok,
    exitCode: result.code,
    durationMs: result.durationMs,
    outputTail: result.out,
    harnessError: ok ? undefined : (isHarnessError(result.out) || undefined),
    shell: shell.name,
  }
}
