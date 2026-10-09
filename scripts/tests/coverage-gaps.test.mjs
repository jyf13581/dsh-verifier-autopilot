// Review R6 6.5: characterization tests for the highest-risk paths the
// coverage run found unexercised (docs/reviews/R6-ARCHITECTURE-BUILD.md §5).
// They pin CURRENT behavior so the 6.1 module split cannot change it silently.
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, symlinkSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { IsolatedWorkspaceManager, adoptionOf, gitDiffStat, makeLiveCandidateFactory } from "../../lib/selection/live.js"
import { execFileSync } from "node:child_process"
import { makeGitRepo } from "./helpers/git.mjs"
import { abortableRetrySleep } from "../../lib/selection/retry.js"

// A child agent's scoped context as DSH hands it to `setup`.
function fakeScope(services = {}) {
  const appended = []
  const handlers = {}
  return {
    appended,
    handlers,
    scope: {
      on(name, handler) { handlers[name] = handler },
      get(name) { return services[name] },
      agent: { session: { append(type, data) { appended.push([type, data]) } } },
    },
  }
}

async function setupFor(args, spec = {}) {
  const created = []
  const ctx = { agents: { async create(options) { created.push(options); return { agent: { id: options.sessionId }, async dispose() {} } } } }
  const factory = makeLiveCandidateFactory({ ctx, ...args })
  await factory.create({ sessionId: "cand-1", cwd: "/tmp/cand-1", parentSession: "src-1", ...spec })
  assert.equal(created.length, 1)
  return created[0]
}

test("R6 6.5: child sandbox and approval policy per mode (the R1 trust boundary, previously never run offline)", async () => {
  const cases = [
    // autopilot: full access already means no prompts, so approval is pinned to never
    ["danger-full-access", [["approval/policy", { policy: "never", source: "delegation" }], ["sandbox/mode", { mode: "danger-full-access", source: "delegation" }]]],
    // workspace-write bundles approval=ask: pinning never parked candidates on unpromptable escalations (2026-09-14)
    ["workspace-write", [["sandbox/mode", { mode: "workspace-write", source: "delegation" }]]],
    // no sandbox override at all: DSH's default sandbox, approval never
    [undefined, [["approval/policy", { policy: "never", source: "delegation" }]]],
  ]
  for (const [sandboxMode, expected] of cases) {
    const options = await setupFor({ sandboxMode })
    const { scope, appended } = fakeScope()
    options.setup(scope)
    assert.deepEqual(appended, expected, "sandboxMode=" + sandboxMode)
  }
})

test("R6 6.5: a child inherits the parent's sandbox override when none is passed", async () => {
  const parent = {
    session: { events: [], header: { delegationDepth: 2 } },
    ctx: { get: (name) => (name === "sandboxPolicy" ? { overrideOf: () => "read-only" } : undefined) },
  }
  const options = await setupFor({ parent })
  const { scope, appended } = fakeScope()
  options.setup(scope)
  assert.deepEqual(appended, [["sandbox/mode", { mode: "read-only", source: "delegation" }]])
  assert.equal(options.meta.delegationDepth, 3, "depth is the parent's + 1")
  assert.equal(options.meta.origin, "subagent")
  assert.equal(options.meta.agentPreset, "standard", "no preset means the standard tool set, never the empty global layer (2026-09-13)")
})

test("R6 6.5: the candidate route is injected into prompt variables and every request; reasoningEffort is dropped", async () => {
  const options = await setupFor({ agentOptions: { provider: "kimi", model: "kimi-k3" } })
  const { scope, handlers } = fakeScope()
  options.setup(scope)
  assert.equal(typeof handlers["system-prompt/assemble"], "function")
  assert.equal(typeof handlers["agent/request"], "function")
  const assembled = await handlers["system-prompt/assemble"]({}, {}, async () => ({ variables: { persona: "p" } }))
  assert.deepEqual(assembled.variables, { persona: "p", provider: "kimi", model: "kimi-k3" })
  const request = await handlers["agent/request"]({}, async () => ({ provider: "other", model: "other-m", reasoningEffort: "high", temperature: 1 }))
  assert.deepEqual(request, { provider: "kimi", model: "kimi-k3", temperature: 1 })
})

test("R6 6.5: without a route the child follows the session's default model selection", async () => {
  const options = await setupFor({})
  const { scope, handlers } = fakeScope({ agentDefaultModel: { currentSelection: () => ({ provider: "deepseek", model: "ds-v4" }) } })
  options.setup(scope)
  const assembled = await handlers["system-prompt/assemble"]({}, {}, async () => ({ variables: {} }))
  assert.deepEqual(assembled.variables, { provider: "deepseek", model: "ds-v4" })
})

test("R6 6.5: setup ignores a context without hooks or service lookup instead of throwing inside DSH", async () => {
  const options = await setupFor({ sandboxMode: "danger-full-access" })
  assert.doesNotThrow(() => options.setup({}))
  assert.doesNotThrow(() => options.setup(null))
})

test("R6 6.5: an abort during a verifier retry back-off rejects at once and does not wait out the delay", async () => {
  const controller = new AbortController()
  const started = Date.now()
  const sleeping = abortableRetrySleep(60_000, controller.signal)
  setTimeout(() => controller.abort(), 10)
  await assert.rejects(sleeping, (e) => e.code === "bridge_aborted" && e.retriable === false)
  assert.ok(Date.now() - started < 5_000, "rejected promptly")
  const pre = new AbortController(); pre.abort()
  await assert.rejects(abortableRetrySleep(60_000, pre.signal), (e) => e.code === "bridge_aborted")
  await abortableRetrySleep(5) // no signal: plain delay
})

// Windows paths (6.5): the first windows-latest run refused every selection
// whose source lived under os.tmpdir() -- C:\Users\RUNNER~1\..., an 8.3 alias
// of the long path git prints -- as source-cwd-outside-git-root. A junction
// (a plain symlink on POSIX) is the same defect reachable on every OS: two
// spellings of one directory.
test("R6 6.5: prepare accepts an aliased spelling of the source repository (8.3 name, junction, symlink)", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "va-r6-alias-"))
  const manager = new IsolatedWorkspaceManager(path.join(base, "ws"))
  let cwd = null
  try {
    const repo = makeGitRepo(base, "real")
    writeFileSync(path.join(repo, "tracked.txt"), "tracked-base\nuncommitted\n")
    const alias = path.join(base, "alias")
    symlinkSync(repo, alias, "junction")
    cwd = await manager.prepare({ selectionId: "sel-r6alias", index: 0, sourceCwd: path.join(alias, "src"), strictSnapshot: true })
    assert.equal(path.basename(cwd), "src", "the subdirectory is mapped into the worktree (old code: source-cwd-outside-git-root)")
    assert.equal(readFileSync(path.join(path.dirname(cwd), "tracked.txt"), "utf8").replace(/\r\n/g, "\n"), "tracked-base\nuncommitted\n", "the uncommitted edit is mirrored")
  } finally {
    if (cwd) await manager.remove(path.dirname(cwd)).catch(() => {})
    rmSync(base, { recursive: true, force: true })
  }
})

// Git for Windows installs with core.autocrlf=true; git then writes
// "warning: in the working copy of 'f.js', LF will be replaced by CRLF" to
// STDERR for every LF file it lists, on any OS. GIT_CONFIG_COUNT injects the
// same setting into every git child of this process, so Linux CI reproduces
// what the second windows-latest run showed: stderr merged into the listing
// turned into path entries, all three repositories below fingerprinted
// 43ff21557eb328cc, and own-work counts / adoption / audit patches were
// computed over warning text.
test("R6 6.5: git evidence reads stdout only (core.autocrlf=true, the Git for Windows default)", async () => {
  const saved = { count: process.env.GIT_CONFIG_COUNT, key: process.env.GIT_CONFIG_KEY_0, value: process.env.GIT_CONFIG_VALUE_0 }
  Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.autocrlf", GIT_CONFIG_VALUE_0: "true" })
  const base = mkdtempSync(path.join(tmpdir(), "va-r6-crlf-"))
  try {
    const repo = (name, edit) => {
      const dir = makeGitRepo(base, name)
      writeFileSync(path.join(dir, "src", "entry.ts"), edit)
      return dir
    }
    const [a, b, c] = [repo("a", "export const value = 2\n"), repo("b", "export const value = 9\n"), repo("c", "export const value = 2\n")]
    const warned = execFileSync("git", ["diff", "--name-only", "HEAD"], { cwd: a, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    assert.equal(warned.trim(), "src/entry.ts", "precondition: git lists the file (its CRLF warning goes to stderr)")
    const [sa, sb, sc] = await Promise.all([a, b, c].map(gitDiffStat))
    assert.deepEqual([sa.files, sa.insertions, sa.deletions, sa.untracked], [1, 1, 1, 0], "one own edit, counted from numstat (old code under autocrlf: insertions 0)")
    assert.notEqual(sa.fingerprint, sb.fingerprint, "different deliverables are different (old code under autocrlf: equal)")
    assert.equal(sa.fingerprint, sc.fingerprint, "byte-identical deliverables still dedupe")
    const adoption = await adoptionOf(a, c)
    assert.deepEqual(adoption, { total: 1, adopted: ["src/entry.ts"] }, "adoption names real paths only")
  } finally {
    for (const [k, v] of [["GIT_CONFIG_COUNT", saved.count], ["GIT_CONFIG_KEY_0", saved.key], ["GIT_CONFIG_VALUE_0", saved.value]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
    rmSync(base, { recursive: true, force: true })
  }
})
