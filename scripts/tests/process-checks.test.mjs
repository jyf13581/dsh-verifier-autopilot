// The bounded process runner and the objective check harness: four distinct
// process ends, stdio flushing, the shell fallback chain, and the portability
// boundary.
//
// Part of the offline regression suite: `npm test` runs every scripts/tests/*.test.mjs
// in its own process; this file also runs alone with `node --test scripts/tests/process-checks.test.mjs`.

import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { runChecks, resolveCheckShell, defaultCheckShells } from "../../lib/selection/checks.js"
import { runProcess } from "../../lib/selection/proc.js"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { CHECK_SHELL, SLOW_CHECK_COMMAND } from "./helpers/selection.mjs"

test("checks: pass/fail/timeout surface as structured results", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "va-check-"))
  const results = await runChecks(dir, [
    { name: "ok", command: "exit 0" },
    { name: "fail", command: "exit 3" },
    { name: "slow", command: SLOW_CHECK_COMMAND, timeoutMs: 800 },
  ])
  assert.deepEqual(results.map((r) => [r.name, r.ok, r.exitCode]), [
    ["ok", true, 0],
    ["fail", false, 3],
    ["slow", false, null],
  ])
  assert.ok(results.every((r) => r.shell === CHECK_SHELL.name), "every result records the shell that ran it")
  assert.equal(results[1].harnessError, undefined, "a plain non-zero exit is the candidate's failure, not the harness's")
})

// ---------- round 5: storage lifecycle and platform portability ----------
//
// One bounded process runner under both the git helpers and the check
// harness; a check shell resolved from a platform chain instead of a
// hard-coded pwsh; audit packs and candidate directories that live exactly as
// long as the records that can still reach them; sidecar warm-up measured.

test("proc: exit, spawn failure, timeout and abort are four distinct ends, and output is bounded from the chosen side", async () => {
  const node = process.execPath
  const tail = await runProcess(node, ["-e", "process.stdout.write('a'.repeat(3000)); process.stderr.write('Z'); process.exit(4)"], { cap: 100, keep: "tail" })
  assert.equal(tail.end, "exit")
  assert.equal(tail.code, 4)
  assert.equal(tail.out.length, 100)
  assert.ok(tail.out.endsWith("Z"), "tail mode keeps the end of the stream, where the failure is")
  const head = await runProcess(node, ["-e", "process.stdout.write('H' + 'b'.repeat(3000))"], { cap: 100, keep: "head" })
  assert.equal(head.code, 0)
  assert.equal(head.out.length, 100)
  assert.ok(head.out.startsWith("H"), "head mode keeps the start of the stream (listings truncate at the end)")
  const missing = await runProcess(path.join(tmpdir(), "va-no-such-shell-" + process.pid), ["-c", "exit 0"])
  assert.equal(missing.end, "spawn-failed")
  assert.equal(missing.code, null)
  assert.match(missing.error, /ENOENT/, "a shell that does not exist is reported as such, not as a non-zero exit")
  const slow = await runProcess(node, ["-e", "setTimeout(() => {}, 30000)"], { timeoutMs: 300 })
  assert.equal(slow.end, "timeout")
  assert.equal(slow.code, null)
  assert.ok(slow.durationMs < 5000, "the kill grace bounds a timeout, the child's own lifetime does not")
  const controller = new AbortController()
  const pending = runProcess(node, ["-e", "setTimeout(() => {}, 30000)"], { signal: controller.signal, timeoutMs: 30000 })
  setTimeout(() => controller.abort(), 50)
  const aborted = await pending
  assert.equal(aborted.end, "aborted")
  assert.equal(aborted.code, null)
  const preAborted = await runProcess(node, ["-e", "setTimeout(() => {}, 30000)"], { signal: AbortSignal.abort(), timeoutMs: 30000 })
  assert.equal(preAborted.end, "aborted", "an already-aborted signal settles immediately")
}, { timeout: 20000 })

test("proc: completion waits for stdio to flush, but a grandchild that inherited the pipes cannot pin the caller", async () => {
  const node = process.execPath
  const flushed = await runProcess(node, ["-e", "process.stdout.write('tail-of-output'); process.exit(0)"], { cap: 100 })
  assert.equal(flushed.out, "tail-of-output", "output written right before exit is in the result (close, not exit, completes the run)")
  // The child hands its stdout to a detached grandchild and exits. 'close'
  // cannot fire until the grandchild lets go (8 s here, forever for a
  // background server); the flush grace settles the caller with the child's
  // honest exit code long before that.
  const script = "const { spawn } = require('node:child_process');"
    + " spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: ['ignore', 'inherit', 'ignore'], detached: true, windowsHide: true }).unref();"
    + " process.stdout.write('parent-done');"
  const started = Date.now()
  const result = await runProcess(node, ["-e", script], { cap: 100 })
  assert.equal(result.end, "exit")
  assert.equal(result.code, 0)
  assert.ok(result.out.includes("parent-done"))
  assert.ok(Date.now() - started < 6000, "settled by the flush grace, not by the grandchild's lifetime")
}, { timeout: 20000 })

test("checks: the shell chain falls back past a shell that cannot start, records which shell ran, and probes once per chain", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "va-shell-"))
  try {
    const ghost = { name: "ghost", file: path.join(dir, "no-such-shell"), args: ["-c"] }
    const nodeShell = { name: "node", file: process.execPath, args: ["-e"] }
    const resolved = await resolveCheckShell([ghost, nodeShell])
    assert.equal(resolved.shell, nodeShell, "the first startable shell in the chain wins")
    assert.equal(resolved.failures.length, 1)
    assert.match(resolved.failures[0], /^ghost: /)
    const results = await runChecks(dir, [
      { name: "ok", command: "process.exit(0)" },
      { name: "fail", command: "console.error('boom'); process.exit(2)" },
    ], { shells: [ghost, nodeShell] })
    assert.deepEqual(results.map((r) => [r.name, r.ok, r.exitCode, r.shell]), [["ok", true, 0, "node"], ["fail", false, 2, "node"]])
    assert.ok(results[1].outputTail.includes("boom"))
    assert.equal(results[1].harnessError, undefined, "a real non-zero exit through a fallback shell is still the candidate's failure")
    assert.equal(await resolveCheckShell([ghost, nodeShell]), resolved, "the probe is memoized per chain")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("checks: a chain with no startable shell yields a harness error for every check, never an elimination", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "va-noshell-"))
  try {
    const ghost = { name: "ghost", file: path.join(dir, "no-such-shell"), args: ["-c"] }
    const ghost2 = { name: "ghost2", file: path.join(dir, "also-missing"), args: [] }
    const results = await runChecks(dir, [{ name: "a", command: "exit 0" }, { name: "b", command: "exit 1" }], { shells: [ghost, ghost2] })
    assert.equal(results.length, 2, "every check is reported, none silently dropped")
    for (const r of results) {
      assert.equal(r.ok, false)
      assert.equal(r.exitCode, null)
      assert.equal(r.harnessError, true, "the harness's failure is flagged so the gate keeps the candidate (B-10)")
      assert.match(r.outputTail, /^harness: no usable shell \(ghost: .*; ghost2: .*\)$/)
    }
    assert.deepEqual(await runChecks(dir, [], { shells: [ghost] }), [], "no checks means no shell is even resolved")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("checks: the default chain prefers pwsh and falls back to the platform shell this host actually has", async () => {
  assert.deepEqual(defaultCheckShells("win32").map((s) => s.name), ["pwsh", "powershell"])
  assert.deepEqual(defaultCheckShells("linux").map((s) => s.name), ["pwsh", "sh"])
  assert.deepEqual(defaultCheckShells("darwin").map((s) => s.name), ["pwsh", "sh"])
  assert.ok(CHECK_SHELL, "this host has at least one usable check shell")
  const dir = mkdtempSync(path.join(tmpdir(), "va-defshell-"))
  try {
    const results = await runChecks(dir, [{ name: "plain", command: "exit 0" }, { name: "broken", command: "= -eq 3" }])
    assert.equal(results[0].ok, true)
    assert.equal(results[0].shell, CHECK_SHELL.name)
    assert.equal(results[1].ok, false)
    assert.equal(results[1].harnessError, true, "interpreter noise is recognized in the " + CHECK_SHELL.name + " dialect too")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("portability: the process runner is a leaf and the check harness is the only place a shell is named", () => {
  const proc = readFileSync(fileURLToPath(new URL("../../src/selection/proc.ts", import.meta.url)), "utf8")
  const procImports = [...proc.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1])
  assert.deepEqual(procImports, ["node:child_process"], "proc.ts depends on Node only, so live.ts and checks.ts share it without a cycle")
  const gate = readFileSync(fileURLToPath(new URL("../check-architecture.mjs", import.meta.url)), "utf8")
  assert.ok(gate.includes("from === 'src/selection/proc.ts'"), "the architecture gate enforces the leaf rule in CI")
  const live = readFileSync(fileURLToPath(new URL("../../src/selection/live.ts", import.meta.url)), "utf8")
  assert.ok(!/\bspawn\(\s*cmd\b/.test(live.replace(/execCapture[\s\S]*?\n}\n/, "")), "live.ts no longer hand-rolls its own bounded runner")
  const candidates = readFileSync(fileURLToPath(new URL("../../src/selection/candidates.ts", import.meta.url)), "utf8")
  assert.ok(!/pwsh/.test(candidates), "the runner does not know which shell runs a check")
})
