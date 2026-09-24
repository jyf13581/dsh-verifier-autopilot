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
 *
 * Harness errors are decided from CANDIDATE-INDEPENDENT evidence only (review
 * R2 2.2). The output tail is written by candidate code (`npm test` runs the
 * candidate's tests), so matching interpreter-error text anywhere in it let a
 * genuine failure that merely printed `: not found` survive the gate. Instead:
 *  - parse: the command is first run through the SAME shell transport wrapped
 *    in a never-taken branch (`if false; then … fi` / `if ($false) { … }`), in
 *    a neutral directory. The shell parses the whole script and executes
 *    nothing, so argv-quoting mangling (sel-5e84f540) still surfaces, but no
 *    candidate file can influence the answer;
 *  - lookup: after a real failure, the command's leading word is resolved in
 *    the same shell from a neutral directory. Only an operator-named tool that
 *    does not exist on this host (`pnpm` not installed) is the harness's fault;
 *    a missing path (`./run-tests.sh` the candidate deleted) is not.
 */

import { tmpdir } from 'node:os'
import { runProcess, scrubSecretEnv, type ProcessResult } from './proc.js'

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
  /** Wrap `command` so the shell parses all of it and executes none of it.
   *  Absent = this shell offers no parse probe (injected test shells). */
  parseOnly?: (command: string) => string
  /** A script whose exit 0 proves `word` resolves as a command here.
   *  Absent = no lookup probe; a failure is then always the candidate's. */
  resolves?: (word: string) => string
}

const powershellParseOnly = (command: string): string => 'if ($false) {\n' + command + '\n}'
const powershellResolves = (word: string): string =>
  "if (Get-Command -ErrorAction SilentlyContinue -Name '" + word.replace(/'/g, "''") + "') { exit 0 } else { exit 1 }"

export const POWERSHELL_CORE: CheckShell = { name: 'pwsh', file: 'pwsh', args: ['-NoProfile', '-Command'], parseOnly: powershellParseOnly, resolves: powershellResolves }
export const WINDOWS_POWERSHELL: CheckShell = { name: 'powershell', file: 'powershell', args: ['-NoProfile', '-Command'], parseOnly: powershellParseOnly, resolves: powershellResolves }
export const POSIX_SH: CheckShell = {
  name: 'sh',
  file: '/bin/sh',
  args: ['-c'],
  parseOnly: (command) => 'if false; then\n' + command + '\nfi',
  resolves: (word) => "command -v '" + word.replace(/'/g, "'\\''") + "' >/dev/null 2>&1",
}

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

/** @deprecated Review R2 2.2: text in an output tail is candidate-controlled
 *  and proves nothing about the harness; runChecks no longer consults this.
 *  Kept for embedders that display a hint next to a failed check. */
export function isHarnessError(outputTail: string): boolean {
  return HARNESS_ERROR_PATTERNS.some((pattern) => pattern.test(outputTail))
}

const SHELL_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'foreach', 'while', 'until', 'do', 'done', 'case', 'esac',
  'function', 'try', 'catch', 'finally', 'switch', 'param', 'begin', 'process', 'end', '!', '{', '}', '(', ')',
])

/** The operator-named program a check starts with, when that is a plain
 *  command name: leading `VAR=value` assignments and PowerShell's `&` call
 *  operator are skipped; a path, variable, expression, or shell keyword yields
 *  null (its absence is not provably the host's fault). Exported for tests. */
export function leadingCommandWord(command: string): string | null {
  const tokens = command.trim().split(/\s+/)
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1
  if (tokens[i] === '&') i += 1
  let word = tokens[i] ?? ''
  const quoted = /^(['"])(.*)\1$/.exec(word)
  if (quoted) word = quoted[2]
  word = word.replace(/[;|&]+$/, '')
  if (!word || SHELL_KEYWORDS.has(word.toLowerCase())) return null
  if (/[\\/$`(){}\[\]<>*?'"]/.test(word) || word.startsWith('.') || word.startsWith('-')) return null
  return word
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

/** Parse verdicts depend only on (shell, command), both operator-controlled, so
 *  one probe serves every candidate of a run and every later run. */
const parseProbes = new Map<string, Promise<ProcessResult>>()

function probeShell(shell: CheckShell, script: string, options: RunChecksOptions, signal?: AbortSignal): Promise<ProcessResult> {
  return runProcess(shell.file, [...shell.args, script], {
    signal,
    // Neutral directory: nothing a candidate wrote can influence a probe.
    cwd: tmpdir(),
    env: scrubSecretEnv(options.secretEnvNames),
    timeoutMs: SHELL_PROBE_TIMEOUT_MS,
    cap: 600,
    keep: 'head',
    now: options.now,
  })
}

function parseProbe(shell: CheckShell, command: string, options: RunChecksOptions): Promise<ProcessResult> | null {
  if (!shell.parseOnly) return null
  const key = chainKey([shell]) + String.fromCharCode(0) + command
  let pending = parseProbes.get(key)
  if (!pending) {
    pending = probeShell(shell, shell.parseOnly(command), options)
    parseProbes.set(key, pending)
    // Only an honest exit is a verdict; a timed-out or unspawnable probe
    // (cold pwsh start under load) fails open to the real run and is retried.
    const probe = pending
    void probe.then((result) => { if (result.end !== 'exit' && parseProbes.get(key) === probe) parseProbes.delete(key) })
  }
  return pending
}

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
  parseProbes.clear()
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
  // 1. Parse probe: a command the shell cannot even parse never reaches the
  //    candidate workspace, and its verdict cannot depend on the candidate.
  const parsed = await parseProbe(shell, check.command, options)
  if (parsed && parsed.end === 'exit' && parsed.code !== 0) {
    return {
      name: check.name,
      ok: false,
      exitCode: null,
      durationMs: parsed.durationMs,
      outputTail: ('harness: ' + shell.name + ' cannot parse the check command (parse probe exit ' + parsed.code + ')\n' + parsed.out).slice(0, options.outputTailChars ?? 2000),
      harnessError: true,
      shell: shell.name,
    }
  }
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
  // 2. Lookup probe, only for a real non-zero exit: is the operator-named
  //    leading program missing from this host? Timeouts and aborts are never
  //    the harness's fault, and neither is anything the output claims.
  let harnessError: true | undefined
  let outputTail = result.out
  if (!ok && result.end === 'exit' && !options.signal?.aborted) {
    const word = leadingCommandWord(check.command)
    if (word && shell.resolves) {
      const lookup = await probeShell(shell, shell.resolves(word), options, options.signal)
      if (lookup.end === 'exit' && lookup.code !== 0) {
        harnessError = true
        const prefix = 'harness: `' + word + '` does not resolve in ' + shell.name + ' on this host\n'
        const room = Math.max(0, (options.outputTailChars ?? 2000) - prefix.length)
        outputTail = prefix + (room > 0 ? result.out.slice(-room) : '')
      }
    }
  }
  return {
    name: check.name,
    ok,
    exitCode: result.code,
    durationMs: result.durationMs,
    outputTail,
    harnessError,
    shell: shell.name,
  }
}
