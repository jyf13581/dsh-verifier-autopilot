// Isolated candidate workspaces over real Git repositories: mirroring, strict
// snapshots, lease discovery, non-mutating diff capture, and orphan reclamation.
//
// Part of the offline regression suite: `npm test` runs every scripts/tests/*.test.mjs
// in its own process; this file also runs alone with `node --test scripts/tests/workspaces.test.mjs`.

import test from "node:test"
import assert from "node:assert/strict"
import { VerifierHost } from "../../lib/index.js"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { makeGitRepo, runGit } from "./helpers/git.mjs"
import { fakeBridge, makeFakeFactory, realWorkspaces, settledRecord } from "./helpers/selection.mjs"
import { fakeContext, hostOverrides } from "./helpers/host.mjs"
import { waitFor } from "./helpers/harness.mjs"

test("live: projectStoreKey matches the session store's directory convention", async () => {
  const { projectStoreKey } = await import("../../lib/selection/live.js")
  assert.equal(projectStoreKey("D:\\tools\\x\\c0"), "--D-tools-x-c0--")
  assert.equal(projectStoreKey("C:\\x y\\中"), "--C-x~0020y-~4E2D--")
  assert.equal(projectStoreKey("\\server\\share"), "--server-share--")
})

test("live: non-git session roots resolve only one explicitly referenced nested repository", async () => {
  const { resolveAutopilotSourceCwd } = await import("../../lib/selection/live.js")
  const base = mkdtempSync(path.join(tmpdir(), "va-resolve-"))
  try {
    const repo = makeGitRepo(base, "primary")
    const other = makeGitRepo(base, "other")
    assert.equal(await resolveAutopilotSourceCwd("Refactor primary/src/entry.ts and run tests", base), repo)
    assert.equal(await resolveAutopilotSourceCwd("Refactor the current project", base), undefined, "never scan and guess under a non-git root")
    assert.equal(await resolveAutopilotSourceCwd("Compare primary/src/entry.ts with other/src/entry.ts", base), undefined, "multiple repositories are ambiguous")
    assert.equal(await resolveAutopilotSourceCwd("Fix entry.ts", path.join(repo, "src")), path.join(repo, "src"), "a session already inside Git preserves its working subpath")
    assert.equal(await resolveAutopilotSourceCwd("Also edit " + path.join(other, "src", "entry.ts"), path.join(repo, "src")), undefined, "a task spanning another explicit repository falls back to the parent")
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test("live: git workspace mirrors dirty content, removes from the source repo, and rejects path escape", async () => {
  const { IsolatedWorkspaceManager } = await import("../../lib/selection/live.js")
  const base = mkdtempSync(path.join(tmpdir(), "va-worktree-"))
  try {
    const repo = makeGitRepo(base, "source")
    writeFileSync(path.join(repo, "tracked.txt"), "tracked-dirty\n")
    writeFileSync(path.join(repo, "staged.txt"), "staged-dirty\n")
    runGit(repo, "add", "staged.txt")
    writeFileSync(path.join(repo, "untracked.txt"), "untracked\n")
    const managedRoot = path.join(base, "managed")
    const storeRoot = path.join(base, "store")
    const manager = new IsolatedWorkspaceManager(managedRoot, storeRoot)
    const candidateCwd = await manager.prepare({ selectionId: "sel-snapshot", index: 0, sourceCwd: path.join(repo, "src"), strictSnapshot: true })
    const candidateRoot = path.dirname(candidateCwd)
    assert.equal(readFileSync(path.join(candidateRoot, "tracked.txt"), "utf8"), "tracked-dirty\n")
    assert.equal(readFileSync(path.join(candidateRoot, "staged.txt"), "utf8"), "staged-dirty\n")
    assert.equal(readFileSync(path.join(candidateRoot, "untracked.txt"), "utf8"), "untracked\n")
    assert.ok(runGit(repo, "worktree", "list", "--porcelain").includes(candidateRoot.replaceAll("\\", "/")))
    await manager.remove(candidateCwd)
    assert.equal(existsSync(candidateRoot), false)
    assert.equal(runGit(repo, "worktree", "list", "--porcelain").includes(candidateRoot.replaceAll("\\", "/")), false, "main repo has no stale worktree registration")
    const outside = path.join(base, "outside")
    mkdirSync(outside)
    await assert.rejects(manager.remove(outside), /workspace-path-outside-managed-root/)
    await assert.rejects(manager.purgeSessionRecord(outside), /workspace-path-outside-managed-root/)
    assert.equal(existsSync(outside), true, "rejected cleanup cannot delete the unrelated directory")
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test("live: strict snapshots reject unknown ignored inputs but allow generated directories", async () => {
  const { IsolatedWorkspaceManager } = await import("../../lib/selection/live.js")
  const base = mkdtempSync(path.join(tmpdir(), "va-ignored-"))
  try {
    const repo = makeGitRepo(base, "source")
    writeFileSync(path.join(repo, ".gitignore"), "node_modules/\nlib/\n.data/\neval/results/\n*.tsbuildinfo\n*.tgz\nprivate-input.txt\n")
    runGit(repo, "add", ".gitignore")
    runGit(repo, "commit", "-qm", "ignore-rules")
    mkdirSync(path.join(repo, "node_modules"), { recursive: true })
    writeFileSync(path.join(repo, "node_modules", "cache.txt"), "generated")
    mkdirSync(path.join(repo, "lib"), { recursive: true })
    writeFileSync(path.join(repo, "lib", "bundle.js"), "generated")
    writeFileSync(path.join(repo, "private-input.txt"), "must-not-disappear")
    const manager = new IsolatedWorkspaceManager(path.join(base, "managed"), path.join(base, "store"))
    await assert.rejects(
      manager.prepare({ selectionId: "sel-ignored-reject", index: 0, sourceCwd: repo, strictSnapshot: true }),
      /workspace-ignored-input-unsupported/,
      "unknown ignored inputs are never silently omitted",
    )
    rmSync(path.join(repo, "private-input.txt"))
    const candidateCwd = await manager.prepare({ selectionId: "sel-ignored-allow", index: 0, sourceCwd: repo, strictSnapshot: true })
    const candidateRoot = path.dirname(candidateCwd)
    assert.equal(existsSync(path.join(candidateRoot, "node_modules")), false, "allowed dependency directories remain excluded")
    assert.equal(existsSync(path.join(candidateRoot, "lib")), false, "allowed build directories remain excluded")
    await manager.remove(candidateCwd)
    assert.equal(existsSync(candidateRoot), false)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test("workspace manager: a foreign git repo above the managed root must not hijack lease discovery", async () => {
  const { IsolatedWorkspaceManager } = await import("../../lib/selection/live.js")
  const base = mkdtempSync(path.join(tmpdir(), "va-foreign-repo-"))
  try {
    // Reproduces 2026-09-05 live failure: .data/selection-workspaces sits
    // inside the PLUGIN's own git repo. A plain (non-worktree) candidate
    // directory resolves rev-parse --show-toplevel to that outer repo, which
    // previously poisoned discoverLease with workspace-path-outside-managed-
    // root and turned manual discard into a 400 + leaked empty dirs.
    const repo = makeGitRepo(base, "plugin-repo")
    const root = path.join(repo, ".data", "selection-workspaces")
    const ws = path.join(root, "sel-plain-candidate", "c0")
    mkdirSync(ws, { recursive: true })
    writeFileSync(path.join(ws, "keep.txt"), "k")
    const manager = new IsolatedWorkspaceManager(root)
    await manager.remove(ws)
    assert.equal(existsSync(ws), false, "plain dir removal works despite the foreign toplevel")
    await assert.rejects(manager.remove(path.join(base, "outside", "c0")), /workspace-path-outside-managed-root/, "the managed-root guard still fires for real escapes")
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test("live: gitDiffFull captures untracked files without touching the candidate's index", async () => {
  const { gitDiffFull, gitDiffStat } = await import("../../lib/selection/live.js")
  const base = mkdtempSync(path.join(tmpdir(), "dsh-va-difffull-"))
  try {
    const repo = makeGitRepo(base, "repo")
    writeFileSync(path.join(repo, "tracked.txt"), "tracked-changed\n")
    writeFileSync(path.join(repo, "brand-new.txt"), "hello from an untracked file\n")
    const before = runGit(repo, "status", "--porcelain")
    assert.ok(before.includes("?? brand-new.txt"), "fixture: the new file starts untracked")
    const full = await gitDiffFull(repo)
    assert.ok(full, "diff capture succeeds in a plain repo")
    assert.ok(full.patch.includes("+hello from an untracked file"), "untracked file content is part of the evidence")
    assert.ok(full.patch.includes("+tracked-changed"), "tracked modification is part of the evidence")
    assert.deepEqual(full.untrackedFiles, ["brand-new.txt"])
    assert.equal(full.truncated, false)
    assert.equal(runGit(repo, "status", "--porcelain"), before, "evidence capture leaves the worktree status exactly as the candidate left it")
    assert.equal(runGit(repo, "diff", "--cached", "--name-only"), "", "no intent-to-add entry leaks into the real index")
    const stat = await gitDiffStat(repo)
    assert.ok(stat, "diff stat succeeds")
    assert.equal(stat.files, 1, "stat counts tracked modifications")
    assert.equal(stat.untracked, 1, "stat counts the untracked file")
    assert.equal(runGit(repo, "diff", "--cached", "--name-only"), "", "stat capture does not stage either")
    const wt = path.join(base, "wt", "c0")
    runGit(repo, "worktree", "add", "--detach", wt, "HEAD")
    writeFileSync(path.join(wt, "new-in-worktree.txt"), "worktree-born\n")
    const wtFull = await gitDiffFull(wt)
    assert.ok(wtFull && wtFull.patch.includes("+worktree-born"), "linked worktrees (the real candidate layout) are captured too")
    assert.equal(runGit(wt, "status", "--porcelain"), "?? new-in-worktree.txt", "the linked worktree's own index is untouched")
    assert.equal(runGit(repo, "status", "--porcelain"), before, "the primary worktree is untouched by a linked-worktree capture")
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// ---------- round 5: storage lifecycle and platform portability ----------
//
// One bounded process runner under both the git helpers and the check
// harness; a check shell resolved from a platform chain instead of a
// hard-coded pwsh; audit packs and candidate directories that live exactly as
// long as the records that can still reach them; sidecar warm-up measured.

test("workspaces: orphan candidate directories are reclaimed by the record rules — retained winners and unknown ids are never deleted", async () => {
  const { SelectionHost } = await import("../../lib/selection/host.js")
  const { Diagnostics } = await import("../../lib/index.js")
  const base = mkdtempSync(path.join(tmpdir(), "va-orphans-"))
  try {
    const root = path.join(base, "managed")
    const ws = (sel, i) => path.join(root, sel, "c" + i)
    for (const dir of [ws("sel-known", 0), ws("sel-known", 1), ws("sel-old", 0), ws("sel-unknown", 0), path.join(root, "stray-dir", "c0")]) mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(root, "sel-known", "notes.txt"), "not a candidate directory")
    const ledger = path.join(base, "selections.jsonl")
    writeFileSync(ledger, [
      JSON.stringify(settledRecord("sel-known", 1, {
        candidates: [{ index: 0, sessionId: "c0", workspace: ws("sel-known", 0) }, { index: 1, sessionId: "c1", workspace: ws("sel-known", 1) }],
        winner: { index: 1, sessionId: "c1", workspace: ws("sel-known", 1) },
      })),
      JSON.stringify(settledRecord("sel-old", 2, {
        candidates: [{ index: 0, sessionId: "o0", workspace: ws("sel-old", 0) }],
        fallback: { index: 0, sessionId: "o0", workspace: ws("sel-old", 0), discardedAt: 5 },
      })),
    ].join("\n") + "\n")
    const diag = new Diagnostics()
    const host = new SelectionHost({ verifier: () => ({ model: "m", baseURL: "u", apiKeyEnv: "k" }), workspaceRoot: root, selectionsFile: ledger, diagnostics: diag })
    const first = host.reclaimOrphanWorkspaces()
    assert.equal(host.reclaimOrphanWorkspaces(), first, "concurrent callers share one pass")
    assert.deepEqual(await first, { reclaimed: 2, unknown: 1, failed: 0 })
    assert.ok(!existsSync(ws("sel-known", 0)), "a settled loser directory is reclaimed")
    assert.ok(existsSync(ws("sel-known", 1)), "the retained winner is protected")
    assert.ok(existsSync(path.join(root, "sel-known", "notes.txt")), "non-candidate entries are not the manager's to touch")
    assert.ok(!existsSync(path.join(root, "sel-old")), "a discarded slot's directory is reclaimed and its empty selection root removed")
    assert.ok(existsSync(ws("sel-unknown", 0)), "a directory with no record is reported, never deleted")
    assert.ok(existsSync(path.join(root, "stray-dir", "c0")), "names outside the managed shape are invisible to reclamation")
    assert.equal(diag.snapshot().counters["workspaces.reclaimed"], 2)
    const unknown = diag.snapshot().entries.find((entry) => entry.scope === "workspaces.unknown")
    assert.ok(unknown, "unknown directories are a diagnostic for the operator")
    assert.equal(unknown.detail.selectionIds, "sel-unknown")
    assert.deepEqual(await host.reclaimOrphanWorkspaces(), { reclaimed: 0, unknown: 1, failed: 0 }, "a second pass is idempotent")
    await host.dispose()
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test("workspaces: VerifierHost.start() runs orphan reclamation in the background from the ledger it loaded", async () => {
  const { Diagnostics } = await import("../../lib/index.js")
  const base = mkdtempSync(path.join(tmpdir(), "va-orphans-host-"))
  try {
    const ledger = path.join(base, "selections.jsonl")
    writeFileSync(ledger, JSON.stringify(settledRecord("sel-done", 1, {
      candidates: [{ index: 0, sessionId: "d0", workspace: "/managed/sel-done/c0" }],
      fallback: { index: 0, sessionId: "d0", workspace: "/managed/sel-done/c0", discardedAt: 2 },
    })) + "\n")
    const removed = []
    const purged = []
    const listed = [
      { selectionId: "sel-done", index: 0, dir: "/managed/sel-done/c0" },
      { selectionId: "sel-mystery", index: 0, dir: "/managed/sel-mystery/c0" },
    ]
    const workspaces = {
      ...realWorkspaces,
      async remove(dir) { removed.push(dir) },
      async purgeSessionRecord(dir) { purged.push(dir) },
      async listManaged() { return listed },
    }
    const diag = new Diagnostics()
    const ctx = fakeContext()
    const host = new VerifierHost(ctx, hostOverrides({ enabled: false }), {
      selectionsFile: ledger, diagnostics: diag,
      selectionsTesting: { factory: makeFakeFactory({}), workspaces, bridge: fakeBridge() },
    })
    host.start()
    await waitFor(() => removed.length === 1)
    assert.deepEqual(removed, ["/managed/sel-done/c0"])
    assert.deepEqual(purged, ["/managed/sel-done/c0"], "the session-store record goes with the directory")
    assert.equal(diag.snapshot().counters["workspaces.reclaimed"], 1)
    assert.ok(diag.snapshot().entries.some((entry) => entry.scope === "workspaces.unknown" && entry.detail.selectionIds === "sel-mystery"))
    await host.dispose()
  } finally { rmSync(base, { recursive: true, force: true }) }
})
