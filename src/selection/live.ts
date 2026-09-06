/**
 * Live adapters for SelectionRunner: real DSH agent creation (the recipe proven
 * by the Phase 0 child smoke) and isolated candidate workspaces (git worktree
 * when the source cwd is a git worktree, else a fresh directory).
 *
 * Pure wiring, no decision logic; unit tests cover SelectionRunner with fakes
 * and this file is typechecked + smoke-tested against the live host.
 */

import { cp, lstat, mkdir, readlink, rm, rmdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import type { CandidateFactory, CandidateSpec, SelectionAgentHandle, WorkspaceManager } from './candidates.js'
import type { TrajectoryEvent } from './trajectory.js'

interface LiveAgentLike {
  id: string
  ctx: unknown
  session: { events: readonly TrajectoryEvent[] }
}

interface LiveContext {
  agents: {
    create(options: Record<string, unknown>): Promise<{ agent: unknown; dispose(): Promise<void> }>
  }
}

function exec(cmd: string, args: string[], cwd?: string, timeoutMs = 30000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = ''
    const child = spawn(cmd, args, { cwd, windowsHide: true })
    const take = (b: Buffer | string) => { out = (out + String(b)).slice(-2000) }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } }, timeoutMs)
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, out }) })
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out }) })
  })
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

function execCapture(
  cmd: string,
  args: string[],
  cwd?: string,
  timeoutMs = 30000,
  maxOutputBytes = 8 * 1024 * 1024,
  input?: Buffer,
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    let error = ''
    let truncated = false
    let settled = false
    const child = spawn(cmd, args, { cwd, windowsHide: true })
    const finish = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, out: Buffer.concat(chunks), error, truncated })
    }
    child.stdout?.on('data', (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      total += chunk.length
      if (total > maxOutputBytes) {
        truncated = true
        try { child.kill() } catch { /* gone */ }
        return
      }
      chunks.push(chunk)
    })
    child.stderr?.on('data', (value: Buffer | string) => { error = (error + String(value)).slice(-4000) })
    child.on('error', () => finish(-1))
    child.on('close', (code) => finish(truncated ? -2 : (code ?? -1)))
    const timer = setTimeout(() => { error = (error + ' command timed out').trim(); try { child.kill() } catch { /* gone */ } }, timeoutMs)
    child.stdin?.end(input)
  })
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

async function mirrorGitWorkingState(sourceRoot: string, candidateRoot: string): Promise<void> {
  await assertIgnoredSnapshotBoundary(sourceRoot)
  const patch = await execCapture('git', ['-C', sourceRoot, 'diff', '--binary', 'HEAD', '--', '.'], undefined, 60000)
  if (patch.code !== 0) throw new Error(patch.truncated ? 'workspace-patch-too-large' : 'workspace-patch-read-failed: ' + patch.error)
  if (patch.out.length > 0) {
    const apply = await execCapture('git', ['-C', candidateRoot, 'apply', '--whitespace=nowarn', '-'], undefined, 60000, 1024 * 1024, patch.out)
    if (apply.code !== 0) throw new Error('workspace-patch-apply-failed: ' + apply.error)
  }
  // Git apply may run checkout filters (notably core.autocrlf). Overlay every
  // changed tracked file from the live tree so candidate bytes match the source
  // worktree exactly; the patch still owns deletions, renames, and mode changes.
  const changed = await execCapture('git', ['-C', sourceRoot, 'diff', '--name-only', '-z', 'HEAD', '--', '.'], undefined, 30000, 2 * 1024 * 1024)
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
    type AssembleCtx = {
      get(name: string): unknown
      on(name: string, handler: (...args: never[]) => unknown): unknown
      agent?: { session: { append(type: string, data: Record<string, unknown>): void } }
    }
    const aCtx = agentCtx as unknown as AssembleCtx
    if (parent) {
      try {
        const presets = aCtx.get('agentPresets') as { composeFrom?: (child: unknown, parentCtx: unknown) => void } | undefined
        presets?.composeFrom?.(agentCtx, parent.ctx)
      } catch { /* preset compose is best-effort */ }
    }
    const session = aCtx.agent?.session
    if (session) {
      session.append('approval/policy', { policy: 'never', source: 'delegation' })
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
      aCtx.on('system-prompt/assemble' as never, (async (_assembly: unknown, _context: unknown, next: () => Promise<{ variables?: Record<string, unknown> }>) => {
        const cur = selection.current
        const assembled = await next()
        selection.assembled = cur
        if (!cur) return assembled
        return { ...assembled, variables: { ...assembled.variables, provider: cur.provider, model: cur.model } }
      }) as never)
      aCtx.on('agent/request' as never, (async (_payload: unknown, next: () => Promise<Record<string, unknown>>) => {
        const resolved = await next()
        const sel = selection.assembled
        if (!sel) return resolved
        const rest = { ...resolved }
        delete rest.reasoningEffort
        return { ...rest, ...(sel.provider !== undefined ? { provider: sel.provider } : {}), ...(sel.model !== undefined ? { model: sel.model } : {}) }
      }) as never)
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
      const header = parent ? ((parent.session as { header?: { delegationDepth?: number } }).header ?? {}) : {}
      const parentDepth = Number(header.delegationDepth ?? 0)
      const depth = Number.isSafeInteger(parentDepth) && parentDepth > 0 ? parentDepth + 1 : 1
      const preset = spec.agentPreset ?? args.agentPreset
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

export class IsolatedWorkspaceManager implements WorkspaceManager {
  private readonly root: string
  private readonly storeRoot: string
  private readonly worktrees = new Map<string, WorktreeLease>()
  constructor(root: string, sessionStoreRoot?: string) {
    this.root = path.resolve(root)
    this.storeRoot = path.resolve(sessionStoreRoot ?? defaultSessionStoreRoot())
  }

  private managedPath(input: string): string {
    const absolute = path.resolve(input)
    const relative = path.relative(this.root, absolute)
    const parts = relative.split(/[\\/]/).filter(Boolean)
    if (!relative || path.isAbsolute(relative) || parts.includes('..') || parts.length < 2
      || !/^sel-[A-Za-z0-9][A-Za-z0-9-]{0,100}$/.test(parts[0]) || !/^c\d+$/.test(parts[1])) {
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
    const gone = await exec('git', ['-C', lease.sourceRoot, 'worktree', 'remove', '--force', lease.worktreeRoot], undefined, 60000)
    if (gone.code !== 0) {
      await rm(lease.worktreeRoot, { recursive: true, force: true })
      const pruned = await exec('git', ['-C', lease.sourceRoot, 'worktree', 'prune', '--expire', 'now'], undefined, 60000)
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
        const sourceRoot = path.resolve(root.out.trim())
        const sourceCwd = path.resolve(sel.sourceCwd)
        const relativeCwd = path.relative(sourceRoot, sourceCwd)
        if (path.isAbsolute(relativeCwd) || relativeCwd.split(/[\\/]/).includes('..')) throw new Error('source-cwd-outside-git-root')
        const add = await exec('git', ['-C', sourceRoot, 'worktree', 'add', '--detach', worktreeRoot, 'HEAD'], undefined, 60000)
        if (add.code !== 0) throw new Error('workspace-worktree-add-failed: ' + add.out)
        const candidateCwd = path.join(worktreeRoot, relativeCwd)
        const lease = { candidateCwd, worktreeRoot, sourceRoot }
        this.worktrees.set(candidateCwd, lease)
        try {
          await mirrorGitWorkingState(sourceRoot, worktreeRoot)
          await mkdir(candidateCwd, { recursive: true })
          return candidateCwd
        } catch (error) {
          let cleanupError = ''
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

  async remove(dir: string): Promise<void> {
    const managed = this.managedPath(dir)
    const lease = await this.discoverLease(managed)
    if (lease) await this.removeLease(lease)
    else {
      await rm(managed, { recursive: true, force: true })
      try { await rmdir(path.dirname(managed)) } catch { /* selection root not empty */ }
    }
  }
}
