// Review R2: selection decision-chain correctness. Each test pins one finding
// from docs/reviews/R2-SELECTION-CORRECTNESS.md — who may declare a check
// "the harness's fault", what counts as the same deliverable, what counts as
// work, and how long a cancelled candidate may hold a selection.
//
// Part of the offline regression suite: `npm test` runs every scripts/tests/*.test.mjs
// in its own process; this file also runs alone with `node --test scripts/tests/selection-correctness.test.mjs`.

import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { runChecks, leadingCommandWord } from "../../lib/selection/checks.js"
import { SelectionRunner } from "../../lib/selection/candidates.js"
import { gitDiffStat } from "../../lib/selection/live.js"
import { renderTrajectory } from "../../lib/selection/trajectory.js"
import { CHECK_DIALECT, CHECK_SHELL, fakeBridge, makeFakeFactory, realWorkspaces, selInput } from "./helpers/selection.mjs"

const sh = CHECK_DIALECT === "sh"
const scratch = () => mkdtempSync(path.join(tmpdir(), "va-r2-"))

// ---------- 2.2: harness-error verdicts come only from operator inputs ----------

test("R2 2.2: candidate output that imitates shell errors cannot turn a real failure into a harness error", async (t) => {
  t.diagnostic("check shell under test: " + CHECK_SHELL?.name)
  const dir = scratch()
  try {
    const [spoof, fake127] = await runChecks(dir, [
      {
        name: "spoof",
        command: sh
          ? "echo 'AssertionError: expected 3'; echo 'helper: not found'; echo 'Syntax error: x'; exit 1"
          : "Write-Output 'AssertionError: expected 3'; Write-Output 'helper is not recognized as a name'; Write-Output 'ParserError'; exit 1",
      },
      {
        // The candidate's own script exits 127 and prints the exact text a
        // missing interpreter would: still the candidate's failure.
        name: "fake-127",
        command: sh
          ? "printf 'sh: 1: node: not found\\n'; exit 127"
          : "Write-Output \"The term 'node' is not recognized as a name of a cmdlet\"; exit 127",
      },
    ])
    assert.equal(spoof.ok, false)
    assert.equal(spoof.harnessError, undefined, "old regex classifier would have excused this failure")
    assert.equal(fake127.exitCode, 127)
    assert.equal(fake127.harnessError, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("R2 2.2: a check script the candidate deleted is the candidate's failure; an uninstalled tool is the host's", async () => {
  const dir = scratch()
  try {
    const [deleted, missingTool] = await runChecks(dir, [
      { name: "deleted-script", command: sh ? "./run-tests.sh" : "./run-tests.ps1" },
      { name: "missing-tool", command: "definitely-not-installed-xyz --version" },
    ])
    assert.equal(deleted.ok, false)
    assert.equal(deleted.harnessError, undefined, "a path is candidate-controlled: its absence eliminates")
    assert.equal(missingTool.ok, false)
    assert.equal(missingTool.harnessError, true, "the lookup probe proves the program is absent on this host")
    assert.match(missingTool.outputTail, /^harness: `definitely-not-installed-xyz` does not resolve/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("R2 2.2: an unparseable check is a harness error and never executes in the candidate workspace", async () => {
  const dir = scratch()
  try {
    const [broken] = await runChecks(dir, [{
      name: "unparseable",
      command: sh ? "touch ran.txt; (" : "New-Item -ItemType File ran.txt | Out-Null; if (",
    }])
    assert.equal(broken.harnessError, true)
    assert.equal(broken.exitCode, null, "no real run happened, so there is no exit code to report")
    assert.match(broken.outputTail, /cannot parse the check command/)
    assert.equal(existsSync(path.join(dir, "ran.txt")), false, "the parse probe runs nothing and runs it elsewhere")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("R2 2.2: leadingCommandWord only names plain programs", () => {
  const cases = [
    ["npm test", "npm"],
    ["FOO=1 BAR=2 pnpm test", "pnpm"],
    ["& pwsh -NoProfile -c x", "pwsh"],
    ["\"node\" t.js", "node"],
    ["node; echo", "node"],
    ["./run.sh", null],
    ["bin/test", null],
    ["C:\\tools\\x.exe", null],
    ["$env:TOOL run", null],
    ["if true; then x; fi", null],
    ["(cd a && make)", null],
    ["-flag", null],
    ["", null],
  ]
  for (const [input, expected] of cases) assert.equal(leadingCommandWord(input), expected, JSON.stringify(input))
})

// ---------- 2.1: fingerprints identify content, not line counts ----------

function gitRepo(root, name, content = "x = 1\n") {
  const dir = path.join(root, name)
  mkdirSync(dir)
  const git = (...args) => execFileSync("git", ["-c", "user.email=r2@test", "-c", "user.name=r2", ...args], { cwd: dir, stdio: "ignore" })
  git("init", "-q")
  writeFileSync(path.join(dir, "f.js"), content)
  writeFileSync(path.join(dir, "keep.txt"), "k\n")
  git("add", ".")
  git("commit", "-qm", "init")
  return dir
}

test("R2 2.1: equal line counts with different content no longer collide; identical bytes still match", async () => {
  const root = scratch()
  try {
    const [a, b, c] = ["a", "b", "c"].map((n) => gitRepo(root, n))
    writeFileSync(path.join(a, "f.js"), "x = 2\n")
    writeFileSync(path.join(b, "f.js"), "x = 9\n")
    writeFileSync(path.join(c, "f.js"), "x = 2\n")
    const [sa, sb, sc] = await Promise.all([a, b, c].map(gitDiffStat))
    assert.deepEqual([sa.files, sa.insertions, sa.deletions], [sb.files, sb.insertions, sb.deletions], "same numstat shape")
    assert.notEqual(sa.fingerprint, sb.fingerprint, "different solutions are different deliverables")
    assert.equal(sa.fingerprint, sc.fingerprint, "byte-identical deliverables still dedupe")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("R2 2.1: untracked content, deletions, symlinks and the exec bit are part of the fingerprint", async () => {
  const root = scratch()
  try {
    const dirs = ["u1", "u2", "d", "l1", "l2", "x"].map((n) => gitRepo(root, n))
    const [u1, u2, d, l1, l2, x] = dirs
    writeFileSync(path.join(u1, "new.txt"), "aaaa")
    writeFileSync(path.join(u2, "new.txt"), "bbbb") // same size, same name
    unlinkSync(path.join(d, "keep.txt"))
    const stats = { u1: await gitDiffStat(u1), u2: await gitDiffStat(u2), d: await gitDiffStat(d) }
    assert.equal(stats.u1.untracked, 1)
    assert.notEqual(stats.u1.fingerprint, stats.u2.fingerprint, "untracked files hash by content, not name:size")
    assert.equal(stats.d.files, 1)
    if (process.platform !== "win32") {
      symlinkSync("f.js", path.join(l1, "link"))
      symlinkSync("keep.txt", path.join(l2, "link"))
      assert.notEqual((await gitDiffStat(l1)).fingerprint, (await gitDiffStat(l2)).fingerprint, "symlink targets differ")
      const before = (await gitDiffStat(x))
      writeFileSync(path.join(x, "tool.sh"), "echo\n")
      const plain = (await gitDiffStat(x)).fingerprint
      chmodSync(path.join(x, "tool.sh"), 0o755)
      assert.notEqual((await gitDiffStat(x)).fingerprint, plain, "chmod +x is a change git would commit")
      assert.equal(before.files + before.untracked, 0)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------- 2.1b / partial dedupe in the runner ----------

const alwaysSecond = () => fakeBridge((req) => ({
  index: 0,
  bestPreview: "",
  scores: req.candidates.map((_, i) => (i === 0 ? 0.9 : 0.2)),
  ranking: req.candidates.map((_, i) => i),
  nComparisons: req.candidates.length,
  criteria: ["c1"],
}))

test("R2 2.1b: candidates that changed nothing are never deduped as 'identical'", async () => {
  const factory = makeFakeFactory({})
  const bridge = alwaysSecond()
  const empty = { files: 0, insertions: 0, deletions: 0, untracked: 0, fingerprint: "e3b0c44298fc1c14" }
  const runner = new SelectionRunner({ factory, workspaces: realWorkspaces, bridge, diffStat: async () => empty })
  const { record } = await runner.run(selInput({ candidateCount: 2, taskKind: "code-change" }))
  assert.equal(record.noSearchSpace, undefined, "two answers with no file changes are still two answers")
  assert.equal(record.dedupedCandidates, undefined)
  assert.equal(bridge.calls.length, 1)
  assert.equal(bridge.calls[0].candidates.length, 2, "both reached the verifier")
  assert.equal(record.outcome, "ranked_winner")
})

test("R2 2.1: partial duplicates collapse to one representative before ranking", async () => {
  const factory = makeFakeFactory({})
  const bridge = alwaysSecond()
  const stat = (fingerprint) => ({ files: 1, insertions: 1, deletions: 1, untracked: 0, fingerprint })
  const byCandidate = { c0: stat("aaaa"), c1: stat("bbbb"), c2: stat("aaaa") }
  const runner = new SelectionRunner({
    factory,
    workspaces: realWorkspaces,
    bridge,
    diffStat: async (cwd) => byCandidate[path.basename(cwd)],
  })
  const { record } = await runner.run(selInput({ candidateCount: 3, taskKind: "code-change" }))
  assert.deepEqual(record.dedupedCandidates, [2])
  assert.equal(record.candidates[2].status, "eliminated")
  assert.deepEqual(record.candidates[2].eliminatedBy, ["duplicate-diff:c0"])
  assert.equal(bridge.calls[0].candidates.length, 2, "the twin is not ranked against itself")
  assert.equal(record.noSearchSpace, undefined, "two distinct deliverables remain: this is a real ranking")
  assert.equal(record.outcome, "ranked_winner")
  assert.equal(record.winner.index, 0)
})

// ---------- 2.4: reading is not work ----------

test("R2 2.4: read-only tool calls are not execution evidence", async () => {
  const counts = (name) => renderTrajectory([{ type: "tool/call", seq: 0, data: { name, arguments: {} } }]).execToolCalls
  for (const name of ["read", "read_file", "grep", "glob", "ls", "web_search", "tool_search"]) assert.equal(counts(name), 0, name)
  for (const name of ["write", "edit", "pwsh", "bash", "some_new_tool"]) assert.equal(counts(name), 1, name + " (unknown tools stay conservative)")

  const readOnly = (i) => [
    { type: "user/message", seq: 0, data: { content: [{ type: "text", text: "fix bug " + i }], source: { kind: "user" } } },
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "tool/call", seq: 2, data: { turn: 1, name: "read", arguments: { path: "src/a.ts" } } },
    { type: "tool/result", seq: 3, data: { turn: 1, message: { content: [{ type: "text", text: "file body" }] } } },
    { type: "assistant/message", seq: 4, data: { turn: 1, message: { role: "assistant", content: [{ type: "text", text: "the bug is fixed " + i }] } } },
    { type: "turn/end", seq: 5, data: { turn: 1, reason: { kind: "completed" } } },
  ]
  const factory = makeFakeFactory({ scripts: { 0: { events: readOnly(0) }, 1: { events: readOnly(1) } } })
  const bridge = fakeBridge()
  const runner = new SelectionRunner({ factory, workspaces: realWorkspaces, bridge })
  const { record } = await runner.run(selInput({ candidateCount: 2, taskKind: "code-change" }))
  assert.equal(record.outcome, "insufficient_evidence", "claiming a fix after only reading is not a deliverable")
  assert.equal(bridge.calls.length, 0)
})

// ---------- 2.5: cancel is advisory, the deadline is not ----------

test("R2 2.5: a candidate that ignores cancel is abandoned at timeout + grace", async () => {
  const base = makeFakeFactory({ scripts: { 0: { hang: true }, 1: { hang: true } } })
  const factory = {
    handles: base.handles,
    async create(spec) {
      const handle = await base.create(spec)
      handle.agent.cancel = () => { handle.agent.cancelled = true } // acknowledges nothing
      return handle
    },
  }
  const runner = new SelectionRunner({ factory, workspaces: realWorkspaces, bridge: fakeBridge() })
  const started = Date.now()
  const { record } = await runner.run(selInput({ candidateCount: 2, candidateTimeoutMs: 60, cancelGraceMs: 60, taskKind: "code-change" }))
  assert.ok(Date.now() - started < 10_000, "selection settled instead of waiting forever")
  assert.equal(record.status, "failed")
  for (const cand of record.candidates) {
    assert.equal(cand.status, "failed")
    assert.match(cand.error, /cancel not acknowledged within 60ms/)
  }
  assert.ok(factory.handles.every((h) => h.agent.cancelled && h.disposed), "cancel was still requested and every handle disposed")
})

// ---------- 2.7: the verifier keeps the task line ----------

test("R2 2.7: head truncation keeps the candidate's task statement", () => {
  const events = [{ seq: 0, type: "user/message", data: { content: "TASK: fix the parser bug in src/p.ts", source: { kind: "user" } } }]
  for (let i = 0; i < 60; i++) events.push({ seq: i + 1, type: "tool/call", data: { name: "pwsh", arguments: { command: "x".repeat(900) } } })
  const bounded = renderTrajectory(events)
  assert.ok(bounded.text.startsWith("[E01] USER: TASK: fix the parser bug"), "task line pinned first")
  assert.match(bounded.text, /head truncated for budget: \d+ chars omitted; first task line kept above/)
  assert.ok(bounded.totalChars <= 24_000 + 200, "the pin comes out of the budget, not on top of it")
  const small = renderTrajectory(events.slice(0, 3))
  assert.equal(small.text.includes("head truncated"), false, "no truncation, no pin, no duplicate")
})
