/**
 * Live adapters for SelectionRunner: real DSH agent creation (the recipe proven
 * by the Phase 0 child smoke) and isolated candidate workspaces (git worktree
 * when the source cwd is a git worktree, else a fresh directory).
 *
 * Pure wiring, no decision logic; unit tests cover SelectionRunner with fakes
 * and this file is typechecked + smoke-tested against the live host.
 */

import { cp, lstat, mkdir, readdir, readFile, readlink, realpath, rm, rmdir, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { CandidateFactory, CandidateSpec, DiffStatLite, SelectionAgentHandle, WorkspaceManager, WorkspaceSeedReport } from './candidates.js'
import type { TrajectoryEvent } from './trajectory.js'
import { runProcess, runProcessCapture } from './proc.js'
import { isAgentScope, type AgentCreate } from '../dsh-context.js'

interface LiveAgentLike {
  id: string
  ctx: unknown
  session: { events: readonly TrajectoryEvent[]; header?: { delegationDepth?: number } }
}

interface LiveContext {
  agents: { create: AgentCreate }
}

/** Evidence listings (numstat, status, patches) legitimately exceed the
 *  2000-char diagnostic tail; they keep the head so truncation cuts the end. */
const EVIDENCE_CAP = 262144

interface ExecOptions {
  cwd?: string
  timeoutMs?: number
  cap?: number
  keep?: 'head' | 'tail'
  env?: NodeJS.ProcessEnv
}

/** Bounded process call. The default shape (2000-char tail) is the
 *  diagnostic one: when git fails, the reason is at the end. `code` is -1 for
 *  anything that did not produce an honest exit code (spawn failure, timeout). */
async function exec(cmd: string, args: string[], options: ExecOptions = {}): Promise<{ code: number; out: string }> {
  const result = await runProcess(cmd, args, options)
  return { code: result.code ?? -1, out: result.out }
}

/** Evidence-shaped call: large head-kept output. */
function execWide(cmd: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  return exec(cmd, args, { cwd, cap: EVIDENCE_CAP, keep: 'head', env })
}

async function existingAncestor(input: string): Promise<string | undefined> {
  let current = path.resolve(input)
  for (;;) {
    try {
      const info = await lstat(current)
      return info.isDirectory() ? current : path.dirname(current)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  }
}

/** One spelling per directory: realpath (libuv's native realpath, which on
 *  Windows expands 8.3 names and resolves junctions), else the lexical form. */
async function canonicalDir(input: string): Promise<string> {
  try { return await realpath(path.resolve(input)) } catch { return path.resolve(input) }
}

async function gitRootOf(input: string): Promise<string | undefined> {
  const existing = await existingAncestor(input)
  if (!existing) return undefined
  const result = await exec('git', ['-C', existing, 'rev-parse', '--show-toplevel'])
  return result.code === 0 && result.out.trim() ? path.resolve(result.out.trim()) : undefined
}

function taskPathHints(task: string): string[] {
  const hints = new Set<string>()
  for (const match of task.matchAll(/[`"']([^`"'\r\n]+)[`"']/g)) {
    if (/[\\/]/.test(match[1])) hints.add(match[1].trim())
  }
  for (const match of task.matchAll(/[A-Za-z]:[\\/][^\s`"'<>|?*,，。；;()（）\[\]{}]+/g)) hints.add(match[0])
  // POSIX absolute paths need their own boundary-aware form. Restrict this to
  // POSIX hosts so unquoted route-like text such as /api/users is not probed
  // as a current-drive path on Windows.
  if (path.sep === '/') {
    for (const match of task.matchAll(/(?:^|\s)(\/[^\s`"'<>|?*,，。；;()（）\[\]{}]+)/g)) hints.add(match[1])
  }
  for (const match of task.matchAll(/(?:^|\s)((?:\.{1,2}[\\/])?(?:[A-Za-z0-9_.@-]+[\\/])+[A-Za-z0-9_.@-]+)/g)) hints.add(match[1])
  return [...hints].map((hint) => hint.replace(/:\d+(?::\d+)?$/, '').replace(/[.!?。！？]+$/, ''))
}

/** Resolve the one repository a direct task explicitly targets. A non-Git
 * session root such as D:\tools is intentionally never scanned recursively:
 * zero or multiple referenced repositories make autopilot transparently defer
 * to the source agent instead of guessing and snapshotting the wrong tree. */
export async function resolveAutopilotSourceCwd(task: string, sessionCwd: string | undefined): Promise<string | undefined> {
  if (!sessionCwd) return undefined
  const direct = await gitRootOf(sessionCwd)
  const roots = new Map<string, string>()
  for (const hint of taskPathHints(task).slice(0, 24)) {
    const candidate = path.isAbsolute(hint) ? hint : path.resolve(sessionCwd, hint)
    const root = await gitRootOf(candidate)
    if (root) roots.set(root.toLowerCase(), root)
  }
  if (direct) {
    if ([...roots.keys()].some((root) => root !== direct.toLowerCase())) return undefined
    return path.resolve(sessionCwd)
  }
  return roots.size === 1 ? [...roots.values()][0] : undefined
}

interface CaptureResult { code: number; out: Buffer; error: string; truncated: boolean }

/** Byte-exact git plumbing call on the shared spawn core (review R4 4.7):
 *  same kill escalation, process-group reclamation, flush grace, and EPIPE
 *  containment as every other child. `code` is -2 when stdout exceeded
 *  `maxOutputBytes` (the child was stopped), -1 when there is no honest exit
 *  code (spawn failure, timeout, abort). */
async function execCapture(
  cmd: string,
  args: string[],
  cwd?: string,
  timeoutMs = 30000,
  maxOutputBytes = 8 * 1024 * 1024,
  input?: Buffer,
): Promise<CaptureResult> {
  const result = await runProcessCapture(cmd, args, { cwd, timeoutMs, maxOutputBytes, input })
  const truncated = result.end === 'overflow'
  const code = truncated ? -2 : result.end === 'exit' ? (result.code ?? -1) : -1
  const error = result.end === 'timeout' ? (result.error + ' command timed out').trim() : result.error
  return { code, out: result.out, error, truncated }
}

const ALLOWED_IGNORED_SNAPSHOT_PREFIXES = ['node_modules/', 'lib/', '.data/', 'eval/results/']

function isAllowedIgnoredSnapshotPath(input: string): boolean {
  const relative = input.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')
  if (!relative) return true
  const directoryForm = relative + '/'
  if (ALLOWED_IGNORED_SNAPSHOT_PREFIXES.some((prefix) => directoryForm.startsWith(prefix))) return true
  const basename = relative.slice(relative.lastIndexOf('/') + 1)
  return basename.endsWith('.tsbuildinfo') || basename.endsWith('.tgz')
}

async function assertIgnoredSnapshotBoundary(sourceRoot: string): Promise<void> {
  // Strict snapshots omit ignored inputs by design. Enumerate them explicitly so
  // a project-specific ignored source/config file cannot disappear silently.
  const listed = await execCapture('git', [
    '-C', sourceRoot, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z', '--', '.',
  ], undefined, 30000, 2 * 1024 * 1024)
  if (listed.code !== 0) throw new Error(listed.truncated ? 'workspace-ignored-list-too-large' : 'workspace-ignored-list-failed: ' + listed.error)
  const entries = listed.out.toString('utf8').split(String.fromCharCode(0)).filter(Boolean)
  if (entries.length > 2000) throw new Error('workspace-ignored-count-exceeded')
  const unknown = entries.filter((relative) => !isAllowedIgnoredSnapshotPath(relative))
  if (unknown.length > 0) {
    throw new Error('workspace-ignored-input-unsupported: ' + unknown.slice(0, 8).join(', '))
  }
}

/** Machine-read `git diff` output must not depend on the user's presentation
 *  config: `diff.external` replaces the patch with a viewer's output,
 *  `color.ui=always` injects ANSI codes even into a pipe, and a textconv
 *  driver (active by default, `--binary` included) rewrites hunks into text
 *  that no longer applies. Any of them made every seed snapshot fail with
 *  workspace-patch-apply-failed, and corrupted evidence and relay patches
 *  (review R4 4.2b). */
const RAW_DIFF = ['--no-ext-diff', '--no-textconv', '--no-color'] as const

async function mirrorGitWorkingState(sourceRoot: string, candidateRoot: string): Promise<void> {
  await assertIgnoredSnapshotBoundary(sourceRoot)
  const patch = await execCapture('git', ['-C', sourceRoot, 'diff', ...RAW_DIFF, '--binary', 'HEAD', '--', '.'], undefined, 60000)
  if (patch.code !== 0) throw new Error(patch.truncated ? 'workspace-patch-too-large' : 'workspace-patch-read-failed: ' + patch.error)
  if (patch.out.length > 0) {
    const apply = await execCapture('git', ['-C', candidateRoot, 'apply', '--whitespace=nowarn', '-'], undefined, 60000, 1024 * 1024, patch.out)
    if (apply.code !== 0) throw new Error('workspace-patch-apply-failed: ' + apply.error)
  }
  // Git apply may run checkout filters (notably core.autocrlf). Overlay every
  // changed tracked file from the live tree so candidate bytes match the source
  // worktree exactly; the patch still owns deletions, renames, and mode changes.
  const changed = await execCapture('git', ['-C', sourceRoot, 'diff', ...RAW_DIFF, '--name-only', '-z', 'HEAD', '--', '.'], undefined, 30000, 2 * 1024 * 1024)
  if (changed.code !== 0) throw new Error(changed.truncated ? 'workspace-tracked-list-too-large' : 'workspace-tracked-list-failed: ' + changed.error)
  const trackedEntries = changed.out.toString('utf8').split(String.fromCharCode(0)).filter(Boolean)
  if (trackedEntries.length > 5000) throw new Error('workspace-tracked-count-exceeded')
  let trackedBytes = 0
  for (const relative of trackedEntries) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('workspace-tracked-path-invalid')
    const source = path.resolve(sourceRoot, relative)
    const target = path.resolve(candidateRoot, relative)
    let info
    try { info = await lstat(source) } catch { await rm(target, { recursive: true, force: true }); continue }
    if (!info.isFile() && !info.isSymbolicLink()) throw new Error('workspace-tracked-special-file-unsupported')
    if (info.isSymbolicLink()) {
      const link = await readlink(source)
      const resolved = path.resolve(path.dirname(source), link)
      const linkRelative = path.relative(sourceRoot, resolved)
      if (path.isAbsolute(link) || path.isAbsolute(linkRelative) || linkRelative.split(/[\\/]/).includes('..')) throw new Error('workspace-tracked-symlink-outside-source')
    } else {
      trackedBytes += info.size
      if (trackedBytes > 256 * 1024 * 1024) throw new Error('workspace-tracked-bytes-exceeded')
    }
    await mkdir(path.dirname(target), { recursive: true })
    await rm(target, { recursive: true, force: true })
    await cp(source, target, { force: true, verbatimSymlinks: true })
  }
  const listed = await execCapture('git', ['-C', sourceRoot, 'ls-files', '--others', '--exclude-standard', '-z'], undefined, 30000, 2 * 1024 * 1024)
  if (listed.code !== 0) throw new Error(listed.truncated ? 'workspace-untracked-list-too-large' : 'workspace-untracked-list-failed: ' + listed.error)
  const entries = listed.out.toString('utf8').split(String.fromCharCode(0)).filter(Boolean)
  if (entries.length > 2000) throw new Error('workspace-untracked-count-exceeded')
  let totalBytes = 0
  for (const relative of entries) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('workspace-untracked-path-invalid')
    const source = path.resolve(sourceRoot, relative)
    const target = path.resolve(candidateRoot, relative)
    const info = await lstat(source)
    if (info.isSymbolicLink()) throw new Error('workspace-untracked-symlink-unsupported')
    if (!info.isFile()) throw new Error('workspace-untracked-special-file-unsupported')
    totalBytes += info.size
    if (totalBytes > 64 * 1024 * 1024) throw new Error('workspace-untracked-bytes-exceeded')
    await mkdir(path.dirname(target), { recursive: true })
    await cp(source, target, { force: true })
  }
}

/**
 * The subagent hardening recipe, proven by the Phase 0 smoke: inherit the
 * parent's preset, pin approval=never and the parent's sandbox override —
 * without these the child parks on its first approval prompt forever.
 *
 * Plus the model-selection install replicated from dsh-headless: a preset
 * persona section references the model via the system-prompt variables
 * provider/model; without this listener the FIRST request assembly fails with
 * "prompt variable has no value" and the turn ends empty (observed in the
 * first N=1 live selection). The dsh-agent helper itself is not importable
 * here because the plugin build does not link that package — keep the two
 * scoped listeners semantically identical to installModelSelection().
 */
function makeChildSetup(
  parent: LiveAgentLike | undefined,
  sandboxMode: string | undefined,
  route: { provider?: string; model?: string },
) {
  return (agentCtx: unknown) => {
    // DSH hands the child's scoped context in untyped; the seam is checked
    // once here. Without hooks and service lookup none of the setup below can
    // apply, and the child would run with whatever defaults DSH gives it.
    if (!isAgentScope(agentCtx)) return
    const aCtx = agentCtx
    if (parent) {
      try {
        const presets = aCtx.get('agentPresets') as { composeFrom?: (child: unknown, parentCtx: unknown) => void } | undefined
        presets?.composeFrom?.(agentCtx, parent.ctx)
      } catch { /* preset compose is best-effort */ }
    }
    const session = aCtx.agent?.session
    if (session) {
      // Approval must agree with the sandbox mode. `workspace-write` bundles
      // approval=ask, so pinning 'never' there made every escalation request
      // permanently unpromptable and the candidate parked on it (2026-09-14).
      // The full-access preset already means "no approval prompts", so the pin
      // is only correct when the child genuinely runs under that preset.
      const approval = sandboxMode === 'danger-full-access' ? 'never' : undefined
      if (approval) session.append('approval/policy', { policy: approval, source: 'delegation' })
      else if (!sandboxMode) session.append('approval/policy', { policy: 'never', source: 'delegation' })
      if (sandboxMode) session.append('sandbox/mode', { mode: sandboxMode, source: 'delegation' })
    }
    // Model-selection replication (see header comment).
    let selected = route.model !== undefined || route.provider !== undefined ? { ...route } : undefined
    if (!selected) {
      try {
        const defaults = (aCtx.get('agentDefaultModel') as { currentSelection?: () => { provider?: string; model?: string } } | undefined)?.currentSelection?.()
        if (defaults) selected = { provider: defaults.provider, model: defaults.model }
      } catch { /* defaults unavailable */ }
    }
    const selection: { current?: { provider?: string; model?: string }; assembled?: { provider?: string; model?: string } } = { current: selected, assembled: undefined }
    try {
      aCtx.on('system-prompt/assemble', async (_assembly: unknown, _context: unknown, next: () => Promise<{ variables?: Record<string, unknown> }>) => {
        const cur = selection.current
        const assembled = await next()
        selection.assembled = cur
        if (!cur) return assembled
        return { ...assembled, variables: { ...assembled.variables, provider: cur.provider, model: cur.model } }
      })
      aCtx.on('agent/request', async (_payload: unknown, next: () => Promise<Record<string, unknown>>) => {
        const resolved = await next()
        const sel = selection.assembled
        if (!sel) return resolved
        const rest = { ...resolved }
        delete rest.reasoningEffort
        return { ...rest, ...(sel.provider !== undefined ? { provider: sel.provider } : {}), ...(sel.model !== undefined ? { model: sel.model } : {}) }
      })
    } catch { /* prompt/request waterfalls absent in embedded contexts */ }
  }
}

export function makeLiveCandidateFactory(args: {
  ctx: LiveContext
  parent?: LiveAgentLike
  agentOptions?: { provider?: string; model?: string; maxTokens?: number }
  agentPreset?: string
  sandboxMode?: string
}): CandidateFactory {
  const parent = args.parent
  let sandboxMode: string | undefined = args.sandboxMode
  try {
    const pCtx = parent?.ctx as { get(name: string): { overrideOf?(session: unknown): string | undefined } | undefined } | undefined
    if (sandboxMode === undefined) sandboxMode = pCtx?.get('sandboxPolicy')?.overrideOf?.(parent?.session)
  } catch { /* explicit sandbox override, if any, remains authoritative */ }
  return {
    async create(spec: CandidateSpec): Promise<SelectionAgentHandle> {
      const parentDepth = Number(parent?.session.header?.delegationDepth ?? 0)
      const depth = Number.isSafeInteger(parentDepth) && parentDepth > 0 ? parentDepth + 1 : 1
      // A candidate that joins no preset resolves its tools against the empty
      // global layer (agent-presets logs exactly this: "published without
      // joining an agent preset"). It then has no real file/bash tool, so the
      // model mounts ad-hoc dev_stage_* tools that run in the HOST process
      // context and write through process.cwd() — which injected
      // percent.js/percent.test.js into the installed @deepseek-ai/dsh package
      // and killed the runtime with a native Node assertion (2026-09-13).
      // Default to the standard preset so candidates always inherit the
      // session-cwd-aware tool-fs/tool-bash/tool-pwsh set.
      const preset = spec.agentPreset ?? args.agentPreset ?? 'standard'
      // Per-candidate route (heterogeneous pools) wins over the factory-wide
      // default; the host pre-merges shared candidateModel/candidateProvider
      // into each entry, so a wholesale ?? is the correct priority.
      const route = spec.agentOptions ?? args.agentOptions
      const handle = await args.ctx.agents.create({
        sessionId: spec.sessionId,
        meta: {
          cwd: spec.cwd,
          parentSession: spec.parentSession,
          origin: 'subagent',
          delegationDepth: depth,
          ...(preset ? { agentPreset: preset } : {}),
          ...(spec.seedLength ? { seedLength: spec.seedLength } : {}),
        },
        agentOptions: route ?? {},
        ...(spec.seed ? { seed: spec.seed } : {}),
        setup: makeChildSetup(parent, sandboxMode, {
          provider: route?.provider,
          model: route?.model,
        }),
      })
      return { agent: handle.agent as SelectionAgentHandle['agent'], dispose: () => handle.dispose() }
    },
  }
}

/** Faithful port of dsh-session-persistence-jsonl's projectKey: separators and
 *  drive colons collapse to '-', [A-Za-z0-9._-] pass through, everything else is
 *  ~XXXX-escaped; the result is wrapped as --<key>-- and truncated to 251 chars.
 *  The session store roots one directory per workspace under this key. */
export function projectStoreKey(cwd: string): string {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return '--' + (readable.replace(/^-+/, '') || 'root').slice(0, 251) + '--'
}

function defaultSessionStoreRoot(): string {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'sessions')
}

/** Isolated candidate workspaces under one run root. When the sourceCwd is a
 * git worktree, candidates are detached worktrees of it (real state sharing);
 * otherwise each candidate gets a fresh directory. */
interface WorktreeLease {
  candidateCwd: string
  worktreeRoot: string
  sourceRoot: string
}

export class WorkspacePrepareError extends Error {
  readonly workspace: string
  constructor(message: string, workspace: string) {
    super(message)
    this.name = 'WorkspacePrepareError'
    this.workspace = workspace
  }
}

/** The only directory shapes the manager will ever create or remove:
 *  `<root>/sel-<id>/c<index>`. Both ends of the lifecycle (prepare/remove and
 *  listManaged) share these so enumeration can never widen removal. */
const MANAGED_SELECTION_DIR = /^sel-[A-Za-z0-9][A-Za-z0-9-]{0,100}$/
const MANAGED_CANDIDATE_DIR = /^c(\d+)$/

const SEED_ATTEMPTS = 3

/** HEAD plus a content fingerprint of every dirty/untracked file: equal
 *  before and after a mirror = nothing changed while it was copied. */
async function sourceFingerprint(sourceRoot: string): Promise<{ head: string; digest: string } | null> {
  const head = await exec('git', ['-C', sourceRoot, 'rev-parse', '--verify', 'HEAD'])
  if (head.code !== 0 || !head.out.trim()) return null
  const stat = await gitDiffStat(sourceRoot)
  if (!stat?.fingerprint) return null
  return { head: head.out.trim(), digest: stat.fingerprint }
}

export class IsolatedWorkspaceManager implements WorkspaceManager {
  private readonly root: string
  private readonly storeRoot: string
  private readonly worktrees = new Map<string, WorktreeLease>()
  /** Review R4 4.2: the seed worktree per selection while it exists. */
  private readonly seeds = new Map<string, { sourceRoot: string; worktreeRoot: string; report: WorkspaceSeedReport }>()
  /** Test seam (review R4 4.2): runs after each seed mirror, before the
   *  source is fingerprinted again — where a concurrent source edit lands. */
  private readonly onSeedMirrored?: (attempt: number) => void | Promise<void>
  constructor(root: string, sessionStoreRoot?: string, testing?: { onSeedMirrored?: (attempt: number) => void | Promise<void> }) {
    this.onSeedMirrored = testing?.onSeedMirrored
    this.root = path.resolve(root)
    this.storeRoot = path.resolve(sessionStoreRoot ?? defaultSessionStoreRoot())
  }

  private managedPath(input: string): string {
    const absolute = path.resolve(input)
    const relative = path.relative(this.root, absolute)
    const parts = relative.split(/[\\/]/).filter(Boolean)
    if (!relative || path.isAbsolute(relative) || parts.includes('..') || parts.length < 2
      || !MANAGED_SELECTION_DIR.test(parts[0]) || !MANAGED_CANDIDATE_DIR.test(parts[1])) {
      throw new Error('workspace-path-outside-managed-root')
    }
    return absolute
  }

  private async discoverLease(candidateCwd: string): Promise<WorktreeLease | undefined> {
    const known = this.worktrees.get(candidateCwd)
    if (known) return known
    const top = await exec('git', ['-C', candidateCwd, 'rev-parse', '--show-toplevel'])
    const common = await exec('git', ['-C', candidateCwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    if (top.code !== 0 || common.code !== 0 || !top.out.trim() || !common.out.trim()) return undefined
    // A plain candidate directory may still sit INSIDE someone else's git
    // repository (e.g. the plugin hosting .data/ has its own .git): rev-parse
    // then climbs past the managed root to that foreign toplevel. That is a
    // plain directory, not a worktree lease — discoverLease must conclude
    // "no lease" instead of faulting the entire cleanup path (observed
    // 2026-09-05: /selections/discard dying with workspace-path-outside-
    // managed-root and leaving selector workspaces behind).
    let worktreeRoot: string
    try {
      worktreeRoot = this.managedPath(top.out.trim())
    } catch {
      return undefined
    }
    const sourceRoot = path.dirname(path.resolve(common.out.trim()))
    return { candidateCwd, worktreeRoot, sourceRoot }
  }

  private async removeLease(lease: WorktreeLease): Promise<void> {
    const gone = await exec('git', ['-C', lease.sourceRoot, 'worktree', 'remove', '--force', lease.worktreeRoot], { timeoutMs: 60000 })
    if (gone.code !== 0) {
      await rm(lease.worktreeRoot, { recursive: true, force: true })
      const pruned = await exec('git', ['-C', lease.sourceRoot, 'worktree', 'prune', '--expire', 'now'], { timeoutMs: 60000 })
      if (pruned.code !== 0) throw new Error('workspace-worktree-prune-failed: ' + pruned.out)
    }
    this.worktrees.delete(lease.candidateCwd)
    try { await rmdir(path.dirname(lease.worktreeRoot)) } catch { /* other candidates still exist */ }
  }

  async purgeSessionRecord(candidateWorkspace: string): Promise<void> {
    const managed = this.managedPath(candidateWorkspace)
    await rm(path.join(this.storeRoot, projectStoreKey(managed)), { recursive: true, force: true })
  }

  async prepare(sel: { selectionId: string; index: number; sourceCwd?: string; strictSnapshot?: boolean }): Promise<string> {
    const worktreeRoot = this.managedPath(path.join(this.root, sel.selectionId, 'c' + sel.index))
    await mkdir(path.dirname(worktreeRoot), { recursive: true })
    if (sel.sourceCwd) {
      const root = await exec('git', ['-C', sel.sourceCwd, 'rev-parse', '--show-toplevel'])
      if (root.code === 0 && root.out.trim()) {
        // Compare canonical spellings. git prints its toplevel resolved
        // (long names, symlinks and junctions followed) while the caller's
        // cwd may be an alias of the same directory: a Windows 8.3 short
        // name such as C:\Users\RUNNER~1\... (os.tmpdir() on GitHub's
        // runners), a junction, or a symlinked checkout. path.relative on two
        // spellings is '..\..\...' and every selection there was refused as
        // source-cwd-outside-git-root (review R6 6.5, first windows-latest run).
        const sourceRoot = await canonicalDir(root.out.trim())
        const sourceCwd = await canonicalDir(sel.sourceCwd)
        const relativeCwd = path.relative(sourceRoot, sourceCwd)
        if (path.isAbsolute(relativeCwd) || relativeCwd.split(/[\\/]/).includes('..')) throw new Error('source-cwd-outside-git-root')
        const candidateCwd = path.join(worktreeRoot, relativeCwd)
        const lease = { candidateCwd, worktreeRoot, sourceRoot }
        const addAt = async (commit: string): Promise<void> => {
          const add = await exec('git', ['-C', sourceRoot, 'worktree', 'add', '--detach', worktreeRoot, commit], { timeoutMs: 60000 })
          if (add.code !== 0) throw new Error('workspace-worktree-add-failed: ' + add.out)
          this.worktrees.set(candidateCwd, lease)
        }
        // Review R4 4.2: the source agent keeps working while candidates are
        // prepared. Cutting every candidate from the live source gave each a
        // different snapshot (even a different HEAD after a source commit), so
        // the verifier compared unequal starting points. Only the first
        // candidate (the seed) reads the live source — re-snapshotting while
        // the source changed under it — and the rest copy the seed, which no
        // agent touches until every workspace is prepared.
        const seed = this.seeds.get(sel.selectionId)
        try {
          if (seed && seed.sourceRoot === sourceRoot) {
            await addAt(seed.report.head)
            await mirrorGitWorkingState(seed.worktreeRoot, worktreeRoot)
          } else {
            let report: WorkspaceSeedReport | undefined
            for (let attempt = 1; attempt <= SEED_ATTEMPTS && !report; attempt += 1) {
              const before = await sourceFingerprint(sourceRoot)
              if (attempt > 1) await this.removeLease(lease)
              await addAt(before?.head ?? 'HEAD')
              await mirrorGitWorkingState(sourceRoot, worktreeRoot)
              await this.onSeedMirrored?.(attempt)
              const after = before ? await sourceFingerprint(sourceRoot) : null
              const consistent = before && after ? before.head === after.head && before.digest === after.digest : null
              if (consistent !== false || attempt === SEED_ATTEMPTS) {
                const head = await exec('git', ['-C', worktreeRoot, 'rev-parse', '--verify', 'HEAD'])
                report = { seedIndex: sel.index, head: head.out.trim() || (before?.head ?? 'HEAD'), attempts: attempt, consistent }
              }
            }
            if (report) this.seeds.set(sel.selectionId, { sourceRoot, worktreeRoot, report })
          }
          await mkdir(candidateCwd, { recursive: true })
          // After the mirror, before the candidate runs: what it inherited.
          // Best effort — without a baseline, evidence falls back to HEAD.
          try { await captureWorkspaceBaseline(worktreeRoot) } catch { /* evidence degrades to HEAD-relative */ }
          return candidateCwd
        } catch (error) {
          let cleanupError = ''
          if (this.seeds.get(sel.selectionId)?.worktreeRoot === worktreeRoot) this.seeds.delete(sel.selectionId)
          try { await this.removeLease(lease) } catch (cleanup) { cleanupError = '; cleanup: ' + (cleanup instanceof Error ? cleanup.message : String(cleanup)) }
          const detail = error instanceof Error ? error.message : String(error)
          throw new WorkspacePrepareError(detail + cleanupError, candidateCwd)
        }
      }
    }
    if (sel.strictSnapshot) throw new Error('source-workspace-not-git')
    await mkdir(worktreeRoot, { recursive: true })
    return worktreeRoot
  }

  /** Review R4 4.2: how this selection's candidates were seeded. */
  seedReport(selectionId: string): WorkspaceSeedReport | undefined {
    const seed = this.seeds.get(selectionId)
    return seed ? { ...seed.report } : undefined
  }

  async remove(dir: string): Promise<void> {
    const managed = this.managedPath(dir)
    for (const [selectionId, seed] of this.seeds) {
      if (managed === seed.worktreeRoot || managed.startsWith(seed.worktreeRoot + path.sep)) this.seeds.delete(selectionId)
    }
    const lease = await this.discoverLease(managed)
    if (lease) await this.removeLease(lease)
    else {
      await rm(managed, { recursive: true, force: true })
      try { await rmdir(path.dirname(managed)) } catch { /* selection root not empty */ }
    }
  }

  /** Enumerate the `<root>/<selectionId>/c<i>` directories on disk. Only names
   *  that `managedPath` would accept are reported, so nothing an operator
   *  dropped into the root by hand can ever be handed to remove(). */
  async listManaged(): Promise<Array<{ selectionId: string; index: number; dir: string }>> {
    const found: Array<{ selectionId: string; index: number; dir: string }> = []
    let selections: string[]
    try { selections = await readdir(this.root) } catch { return found }
    for (const selectionId of selections) {
      if (!MANAGED_SELECTION_DIR.test(selectionId)) continue
      let candidates: string[]
      try { candidates = await readdir(path.join(this.root, selectionId)) } catch { continue }
      for (const name of candidates) {
        const match = MANAGED_CANDIDATE_DIR.exec(name)
        if (!match) continue
        found.push({ selectionId, index: Number(match[1]), dir: path.join(this.root, selectionId, name) })
      }
    }
    return found
  }
}

/** The evidence shape is owned by the runner contract (candidates.ts); this
 *  adapter produces it and re-exports the type so the two can never drift.
 *  files/untracked = paths the CANDIDATE changed relative to what it started
 *  with (the mirrored source state, review R3 3.7; HEAD when no baseline);
 *  inherited = source edits carried in untouched; fingerprint =
 *  stable hash of every changed or new path together with its CONTENT digest,
 *  so equal fingerprints mean byte-identical deliverables (review R2 2.1: the
 *  previous numstat+size hash collided for any two edits with equal line
 *  counts, e.g. `x = 2` vs `x = 9`, and deduped a different solution away). */
export type { DiffStatLite }

/** Bytes hashed per fingerprint before falling back to size-only entries: the
 *  snapshot limits already bound workspaces, this bounds a candidate that
 *  generated huge artifacts. */
const FINGERPRINT_CONTENT_BUDGET = 256 * 1024 * 1024
const FINGERPRINT_MAX_PATHS = 10_000

function nulList(out: string): string[] {
  return out.split(String.fromCharCode(0)).filter(Boolean)
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** Content identity of one workspace path: deleted, symlink target, or file
 *  bytes plus the executable bit (git tracks it, so it is part of the diff). */
async function contentDigest(file: string, budget: { left: number }): Promise<string> {
  let info
  try { info = await lstat(file) } catch { return 'deleted' }
  if (info.isSymbolicLink()) {
    try { return 'link:' + await readlink(file) } catch { return 'link:?' }
  }
  if (!info.isFile()) return 'other'
  const mode = (info.mode & 0o111) !== 0 ? 'x' : '-'
  if (info.size > budget.left) return mode + 'size:' + info.size
  budget.left -= info.size
  try { return mode + (await hashFile(file)) } catch { return mode + 'unreadable:' + info.size }
}

interface WorkspaceEntry {
  /** Repository-root-relative path, exactly as git reports it. */
  path: string
  digest: string
  tracked: boolean
}

/** Private per-worktree file (lives in the worktree's own git dir, so the
 *  candidate's `git status` never shows it and `worktree remove` deletes it). */
const BASELINE_FILE = 'dsh-va-baseline.json'

async function gitRoot(cwd: string): Promise<string | null> {
  const top = await execWide('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], cwd)
  return top.code === 0 && top.out.trim() ? path.resolve(top.out.trim()) : null
}

/** Every tracked path whose worktree bytes differ from HEAD plus every
 *  non-ignored untracked path, ROOT-relative, with content digests. Both git
 *  listings run at the root: `diff --name-only` is root-relative while
 *  `ls-files --others` is cwd-relative, and mixing the two from a subdirectory
 *  cwd hashed the wrong files (review R3, found in the R2 fingerprint). */
async function workspaceEntries(root: string): Promise<WorkspaceEntry[] | null> {
  const changed = await execWide('git', ['-C', root, 'diff', ...RAW_DIFF, '--no-renames', '--name-only', '-z', 'HEAD'], root)
  if (changed.code !== 0) return null
  const others = await execWide('git', ['-C', root, 'ls-files', '--others', '--exclude-standard', '-z'], root)
  const tracked = new Set(nulList(changed.out))
  const untracked = others.code === 0 ? nulList(others.out) : []
  const paths = [...new Set([...tracked, ...untracked])].sort().slice(0, FINGERPRINT_MAX_PATHS)
  const budget = { left: FINGERPRINT_CONTENT_BUDGET }
  const entries: WorkspaceEntry[] = []
  for (const rel of paths) entries.push({ path: rel, digest: await contentDigest(path.join(root, rel), budget), tracked: tracked.has(rel) })
  return entries
}

async function baselinePath(root: string): Promise<string | null> {
  const dir = await execWide('git', ['-C', root, 'rev-parse', '--absolute-git-dir'], root)
  return dir.code === 0 && dir.out.trim() ? path.join(dir.out.trim(), BASELINE_FILE) : null
}

/** Record what the candidate STARTED with: `prepare()` mirrors the source's
 *  uncommitted edits into the worktree without committing them, so `git diff
 *  HEAD` alone attributes the user's work-in-progress to every candidate
 *  (review R3 3.7: a candidate that did nothing passed the has-work gate in
 *  any dirty repository). Returns the number of inherited paths, or null when
 *  the workspace is not a git worktree. */
export async function captureWorkspaceBaseline(cwd: string): Promise<number | null> {
  const root = await gitRoot(cwd)
  if (!root) return null
  const entries = await workspaceEntries(root)
  const file = await baselinePath(root)
  if (!entries || !file) return null
  await writeFile(file, JSON.stringify({ version: 1, entries: Object.fromEntries(entries.map((e) => [e.path, e.digest])) }))
  return entries.length
}

async function readBaseline(root: string): Promise<Map<string, string> | null> {
  const file = await baselinePath(root)
  if (!file) return null
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { version?: number; entries?: Record<string, string> }
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object') return null
    return new Map(Object.entries(parsed.entries).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
  } catch {
    return null
  }
}

export interface OwnChanges {
  root: string
  /** False when no start baseline exists (manual workspaces, legacy
   *  worktrees): every change relative to HEAD then counts as the candidate's. */
  hasBaseline: boolean
  /** Full current deliverable (inherited + own). */
  entries: WorkspaceEntry[]
  /** Paths whose content differs from what the candidate started with.
   *  digest 'head' = the candidate restored an inherited path to HEAD. */
  own: WorkspaceEntry[]
  /** Inherited source edits the candidate left untouched. */
  inherited: number
}

export async function candidateOwnChanges(cwd: string): Promise<OwnChanges | null> {
  const root = await gitRoot(cwd)
  if (!root) return null
  const head = await execWide('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], root)
  if (head.code !== 0) return null
  const entries = await workspaceEntries(root)
  if (!entries) return null
  const baseline = await readBaseline(root)
  if (!baseline) return { root, hasBaseline: false, entries, own: entries, inherited: 0 }
  const current = new Set(entries.map((e) => e.path))
  const own = entries.filter((e) => baseline.get(e.path) !== e.digest)
  for (const inheritedPath of baseline.keys()) {
    if (!current.has(inheritedPath)) own.push({ path: inheritedPath, digest: 'head', tracked: true })
  }
  return { root, hasBaseline: true, entries, own, inherited: entries.length - entries.filter((e) => baseline.get(e.path) !== e.digest).length }
}

/** Objective work evidence for one candidate workspace (ruling K.5 / J.4).
 *  Returns null when the workspace is not a git worktree (manual blank
 *  workspaces) — the caller then relies on tool-call evidence alone. */
export async function gitDiffStat(cwd: string): Promise<DiffStatLite | null> {
  try {
    const changes = await candidateOwnChanges(cwd)
    if (!changes) return null
    const ownTracked = new Set(changes.own.filter((e) => e.tracked).map((e) => e.path))
    let insertions = 0
    let deletions = 0
    const numstat = await execWide('git', ['-C', changes.root, 'diff', ...RAW_DIFF, '--no-renames', '--numstat', '-z', 'HEAD'], changes.root)
    if (numstat.code === 0) {
      for (const record of nulList(numstat.out)) {
        const parts = record.replace(/^\n+/, '').split('\t')
        if (parts.length < 3 || !ownTracked.has(parts.slice(2).join('\t'))) continue
        insertions += parts[0] === '-' ? 0 : Number(parts[0]) || 0
        deletions += parts[1] === '-' ? 0 : Number(parts[1]) || 0
      }
    }
    const hash = createHash('sha256')
    for (const entry of changes.entries) hash.update(entry.path).update(String.fromCharCode(0)).update(entry.digest).update('\n')
    return {
      files: ownTracked.size,
      insertions,
      deletions,
      untracked: changes.own.filter((e) => !e.tracked).length,
      fingerprint: hash.digest('hex').slice(0, 16),
      ...(changes.hasBaseline ? { inherited: changes.inherited } : {}),
    }
  } catch {
    return null
  }
}

/** Which of the candidate's OWN changes now exist byte-for-byte in the source
 *  worktree (review R3 3.3). This is the attributable integration signal: a
 *  HEAD move or a dirty tree says the source changed, not that it took
 *  anything from the relayed candidate. */
export async function adoptionOf(candidateCwd: string, sourceCwd: string): Promise<{ total: number; adopted: string[] } | null> {
  try {
    const changes = await candidateOwnChanges(candidateCwd)
    const sourceRoot = await gitRoot(sourceCwd)
    if (!changes || !sourceRoot) return null
    const comparable = changes.own.filter((e) => e.digest !== 'head' && e.digest !== 'other' && !e.digest.includes('size:'))
    const budget = { left: FINGERPRINT_CONTENT_BUDGET }
    const adopted: string[] = []
    for (const entry of comparable) {
      if (await contentDigest(path.join(sourceRoot, entry.path), budget) === entry.digest) adopted.push(entry.path)
    }
    return { total: comparable.length, adopted }
  } catch {
    return null
  }
}

export interface DiffFull {
  /** git diff HEAD patch text, capped; untracked new files are included via
   *  `git add -N` intent-to-add recorded in a THROWAWAY copy of the index, so
   *  the candidate's real index is never touched (the retained winner's
   *  worktree is handed to the finalizer exactly as the candidate left it). */
  patch: string
  truncated: boolean
  /** Untracked (non-ignored) file names — the typical brand-new deliverable. */
  untrackedFiles: string[]
  /** 'own': only paths the candidate changed since its start baseline (review
   *  R5 5.6); 'head': everything vs HEAD (no baseline, or too many own paths
   *  to pass as pathspecs). Absent on records written before R5. */
  scope?: 'own' | 'head'
  /** Inherited source edits left out of an 'own' patch: the user's
   *  work-in-progress, not candidate work. */
  inheritedExcluded?: number
}

/** Pathspec budget for an own-paths patch; beyond it the patch falls back to
 *  scope 'head' rather than risk the platform's command-line limit. */
const OWN_PATCH_MAX_PATHS = 400
const OWN_PATCH_MAX_CHARS = 16_000

/** Full diff evidence for the audit pack (ruling I.5): what the candidate
 *  actually changed, captured BEFORE the workspace can be reclaimed. */
export async function gitDiffFull(cwd: string, patchCap = 262144): Promise<DiffFull | null> {
  let scratchIndex: string | undefined
  try {
    const head = await execWide('git', ['-C', cwd, 'rev-parse', '--verify', 'HEAD'], cwd)
    if (head.code !== 0) return null
    // Evidence collection must not mutate the evidence: stage intent-to-add
    // entries into a private copy of the index (GIT_INDEX_FILE) so untracked
    // files show up in the patch while `git status`/`git diff --cached` in the
    // candidate worktree stay exactly as the candidate left them.
    const indexPath = await execWide('git', ['-C', cwd, 'rev-parse', '--git-path', 'index'], cwd)
    if (indexPath.code !== 0 || !indexPath.out.trim()) return null
    scratchIndex = path.join(os.tmpdir(), 'dsh-va-index-' + randomUUID())
    try { await cp(path.resolve(cwd, indexPath.out.trim()), scratchIndex) } catch { /* no index yet: git starts from an empty one */ }
    const scratchEnv = { ...process.env, GIT_INDEX_FILE: scratchIndex }
    await execWide('git', ['-C', cwd, 'add', '-N', '.'], cwd, scratchEnv)
    // Review R5 5.6: a patch vs HEAD also carried the source edits the
    // candidate inherited at start (prepare mirrors the user's uncommitted
    // work): the audit pack then showed the user's work as candidate work and
    // shipped it to disk with every candidate. With a start baseline, limit
    // the patch to the paths the candidate itself changed.
    const changes = await candidateOwnChanges(cwd)
    const ownPaths = changes?.hasBaseline ? changes.own.map((entry) => entry.path) : null
    const ownSpecs = ownPaths ? ownPaths.map((rel) => ':(top,literal)' + rel) : null
    const ownFits = ownSpecs !== null && ownSpecs.length <= OWN_PATCH_MAX_PATHS && ownSpecs.reduce((n, spec) => n + spec.length + 1, 0) <= OWN_PATCH_MAX_CHARS
    const scope: 'own' | 'head' = ownFits ? 'own' : 'head'
    let patch = ''
    if (scope === 'head' || (ownSpecs && ownSpecs.length > 0)) {
      const diff = await exec('git', ['-C', cwd, 'diff', ...RAW_DIFF, 'HEAD', '--', ...(scope === 'own' ? ownSpecs! : ['.'])], { cwd, cap: patchCap, keep: 'head', env: scratchEnv })
      if (diff.code !== 0) return null
      patch = diff.out
    }
    const others = await execWide('git', ['-C', cwd, 'ls-files', '--others', '--exclude-standard', '--full-name'], cwd)
    const ownSet = scope === 'own' ? new Set(ownPaths) : null
    const untrackedFiles = (others.code === 0 ? others.out.split(/\r?\n/).filter(Boolean) : []).filter((rel) => !ownSet || ownSet.has(rel))
    return {
      patch,
      truncated: patch.length >= patchCap,
      untrackedFiles,
      scope,
      ...(scope === 'own' && changes ? { inheritedExcluded: changes.inherited } : {}),
    }
  } catch {
    return null
  } finally {
    if (scratchIndex) await rm(scratchIndex, { force: true }).catch(() => undefined)
  }
}

export interface RepoState {
  head: string | null
  /** Uncommitted porcelain entries (tracked edits + untracked). */
  dirtyEntries: number
}

/** Post-audit evidence for the source repository (ruling I.5/G-4): HEAD
 *  before/after plus worktree dirtiness, never a merge claim. */
export async function gitRepoState(cwd: string): Promise<RepoState | null> {
  try {
    const headRun = await execWide('git', ['-C', cwd, 'rev-parse', '--verify', 'HEAD'], cwd)
    if (headRun.code !== 0) return null
    const status = await execWide('git', ['-C', cwd, 'status', '--porcelain'], cwd)
    const dirtyEntries = status.code === 0 ? status.out.split(/\r?\n/).filter(Boolean).length : -1
    return { head: headRun.out.trim() || null, dirtyEntries }
  } catch {
    return null
  }
}
