// Review R4: concurrency, lifecycle, and resource reclamation.
//
// Each test reproduces one finding from docs/reviews/R4-LIFECYCLE.md against
// the real host/process code; the fakes model only the documented DSH
// contracts (agent.status mirror, inbox projection) they stand in for.

import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import path from "node:path"
import { VerifierHost } from "../../lib/index.js"
import { makeGitRepo } from "./helpers/git.mjs"
import { completedTurnEvents, fakeAgent, fakeContext, fireIdle, hostOverrides } from "./helpers/host.mjs"
import { fakeBridge, makeFakeFactory, realWorkspaces, SEL_TMP } from "./helpers/selection.mjs"
import { runProcess, runProcessCapture } from "../../lib/selection/proc.js"
import { runChecks } from "../../lib/selection/checks.js"
import { quiesce, waitFor } from "./helpers/harness.mjs"

/** A source agent with DSH's documented status mirror and inbox projection:
 *  followup() queues the relay in inbox.nextTurn; `claim()` moves it into the
 *  session (a turn started reading it). */
function contractAgent(id, events) {
  const agent = fakeAgent(id, events)
  agent.status = "running"
  agent.inbox = { nextTurn: [], nextStep: [] }
  agent.followup = async (message) => {
    agent.followups.push(message)
    agent.inbox.nextTurn = [...agent.inbox.nextTurn, message]
  }
  agent.claim = () => {
    const [message, ...rest] = agent.inbox.nextTurn
    agent.inbox.nextTurn = rest
    agent.session.events.push({ type: "user/message", seq: 1000 + agent.session.events.length, data: message })
  }
  return agent
}

test("R4 4.1: an idle that is not the relay turn's own end never removes the retained winner", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "va-r4-relay-"))
  try {
    const repo = makeGitRepo(base, "source")
    const ctx = fakeContext()
    ctx.setService("agentDefaultModel", { currentSelection: () => ({ provider: "kimi", model: "kimi-k3" }) })
    ctx.llm = { async listModels() { return [{ id: "kimi-k3" }, { id: "minimaxai/minimax-m3" }] } }
    const host = new VerifierHost(ctx, hostOverrides({ enabled: false }), {
      selectionsTesting: { factory: makeFakeFactory({}), workspaces: realWorkspaces, bridge: fakeBridge() },
    })
    const source = ctx.spawnAgent(contractAgent("sess-r4-relay", completedTurnEvents(1)))
    source.session.header = { cwd: repo }
    host.start()
    const direct = { id: "u1", role: "user", content: [{ type: "text", text: "Refactor src/entry.ts and run the lifecycle tests" }], source: { kind: "user" } }
    await source.handlers.get("agent/pre-step")[0]({ messages: [direct], turn: 4, step: 1, signal: new AbortController().signal }, async () => ({ kind: "enter", messages: [direct] }))
    const id = host.selections.listSelections()[0].selectionId
    // The selection settles while the source's original turn is still running:
    // the relay is queued behind it.
    await waitFor(() => source.inbox.nextTurn.some((message) => message.source?.form === "relay"))
    const workspace = host.selections.getSelection(id).winner.workspace

    // (a) Cancel convergence: the aborted original turn reaches idle while the
    // relay still waits in the inbox for its own turn.
    source.status = "idle"
    fireIdle(source)
    await quiesce(60)
    assert.ok(existsSync(workspace), "idle with the relay still queued must not remove the winner it points at")
    assert.equal(host.selections.getSelection(id).delivery, undefined, "nor audit before the relay was read")

    // (b) A stale trigger (e.g. a coalesced cleanup re-run from an earlier
    // idle) lands while the relay turn is running.
    source.status = "running"
    source.claim()
    fireIdle(source)
    await quiesce(60)
    assert.ok(existsSync(workspace), "the relay turn is reading the winner; cleanup waits for it to finish")

    // (c) The relay turn ends: now the audit and removal run, exactly once.
    source.status = "idle"
    fireIdle(source)
    await waitFor(() => host.selections.getSelection(id).winner.discardedAt)
    assert.equal(existsSync(workspace), false)
    assert.equal(host.selections.getSelection(id).delivery?.audited, true)
    assert.ok((host.snapshot().diagnostics.counters["autopilot.cleanup_deferred"] ?? 0) >= 2, "each deferral is counted")
    await host.dispose()
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test("R4 4.1: a source that disappears with its relay still queued is cleaned unconditionally", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "va-r4-gone-"))
  try {
    const repo = makeGitRepo(base, "source")
    const ctx = fakeContext()
    ctx.setService("agentDefaultModel", { currentSelection: () => ({ provider: "kimi", model: "kimi-k3" }) })
    ctx.llm = { async listModels() { return [{ id: "kimi-k3" }, { id: "minimaxai/minimax-m3" }] } }
    const host = new VerifierHost(ctx, hostOverrides({ enabled: false }), {
      selectionsTesting: { factory: makeFakeFactory({}), workspaces: realWorkspaces, bridge: fakeBridge() },
    })
    const source = ctx.spawnAgent(contractAgent("sess-r4-gone", completedTurnEvents(1)))
    source.session.header = { cwd: repo }
    host.start()
    const direct = { id: "u1", role: "user", content: [{ type: "text", text: "Refactor src/entry.ts and run the lifecycle tests" }], source: { kind: "user" } }
    await source.handlers.get("agent/pre-step")[0]({ messages: [direct], turn: 4, step: 1, signal: new AbortController().signal }, async () => ({ kind: "enter", messages: [direct] }))
    const id = host.selections.listSelections()[0].selectionId
    await waitFor(() => source.inbox.nextTurn.some((message) => message.source?.form === "relay"))
    const workspace = host.selections.getSelection(id).winner.workspace
    ctx.emit("agent/disposed", { agent: source })
    await waitFor(() => host.selections.getSelection(id).winner.discardedAt)
    assert.equal(existsSync(workspace), false, "nothing can read the relay any more, so nothing is retained for it")
    await host.dispose()
  } finally { rmSync(base, { recursive: true, force: true }) }
})

// ---------- 4.4 / 4.7: one spawn core, whole-tree reclamation ----------

const POSIX = process.platform !== "win32"

/** PIDs of live `sleep <secs>` processes (exact argv match, no shell involved). */
function sleepers(secs) {
  const out = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" })
  return out.split("\n").map((line) => line.trim().match(/^(\d+)\s+(?:\/bin\/|\/usr\/bin\/)?sleep (\d+)$/)).filter((m) => m && m[2] === String(secs)).map((m) => Number(m[1]))
}
const reap = (pids) => { for (const pid of pids) { try { process.kill(pid, "SIGKILL") } catch { /* gone */ } } }
// Distinct durations per test so concurrent suites never see each other's sleepers.
const uniqueSecs = (offset) => 4000 + (process.pid % 500) * 4 + offset

test("R4 4.4: a timed-out command's grandchildren die with it (POSIX process group)", { skip: !POSIX && "process groups are POSIX-only" }, async () => {
  const secs = uniqueSecs(0)
  try {
    // `sleep; echo` forces the shell to fork instead of exec'ing sleep, so the
    // sleeper is a grandchild of runProcess — exactly the npm test → node shape.
    const result = await runProcess("sh", ["-c", `sleep ${secs}; echo after`], { timeoutMs: 300, cap: 200 })
    assert.equal(result.end, "timeout")
    await quiesce(150)
    assert.deepEqual(sleepers(secs), [], "the shell's child must not outlive the timeout")
  } finally { reap(sleepers(secs)) }
})

test("R4 4.4: an aborted check through the real check runner leaves no process behind", { skip: !POSIX && "process groups are POSIX-only" }, async () => {
  const secs = uniqueSecs(1)
  try {
    const controller = new AbortController()
    // /bin/sleep is a native program in both sh and pwsh (in pwsh `sleep` is
    // an alias for the Start-Sleep cmdlet, which would not fork).
    const pending = runChecks(SEL_TMP, [{ name: "slow", command: `/bin/sleep ${secs}; echo after`, timeoutMs: 30000 }], { signal: controller.signal })
    await waitFor(() => sleepers(secs).length > 0, 15000)
    controller.abort()
    const [result] = await pending
    assert.equal(result.ok, false)
    await quiesce(150)
    assert.deepEqual(sleepers(secs), [], "abort reclaims the whole check tree")
  } finally { reap(sleepers(secs)) }
})

test("R4 4.4: reapGroup kills what a command left running after a normal exit; the default leaves it", { skip: !POSIX && "process groups are POSIX-only" }, async () => {
  const kept = uniqueSecs(2)
  const reaped = uniqueSecs(3)
  try {
    const plain = await runProcess("sh", ["-c", `sleep ${kept} >/dev/null 2>&1 & echo started`], { timeoutMs: 5000 })
    assert.equal(plain.code, 0)
    const swept = await runProcess("sh", ["-c", `sleep ${reaped} >/dev/null 2>&1 & echo started`], { timeoutMs: 5000, reapGroup: true })
    assert.equal(swept.code, 0)
    assert.match(swept.out, /started/)
    await quiesce(150)
    assert.equal(sleepers(kept).length, 1, "without reapGroup a deliberate background job is not touched (git plumbing never opts in)")
    assert.deepEqual(sleepers(reaped), [], "with reapGroup nothing the command started survives it")
  } finally { reap([...sleepers(kept), ...sleepers(reaped)]) }
})

test("R4 4.7b: a child that exits without reading its stdin cannot crash the host with EPIPE", async () => {
  const node = process.execPath
  const big = Buffer.alloc(4 * 1024 * 1024, 120)
  // The pipe buffer (64 KiB) fills, the child exits unread: the pending write
  // fails with EPIPE. Before R4 that error event was unhandled in execCapture.
  const captured = await runProcessCapture(node, ["-e", "setTimeout(() => process.exit(3), 200)"], { input: big, timeoutMs: 10000 })
  assert.equal(captured.end, "exit")
  assert.equal(captured.code, 3)
  const text = await runProcess(node, ["-e", "setTimeout(() => process.exit(4), 200)"], { input: big, timeoutMs: 10000 })
  assert.equal(text.code, 4)
})

test("R4 4.7: stdin reaches EOF, capture is byte-exact, and overflow stops the child", async () => {
  const node = process.execPath
  // A command that reads stdin used to block until the timeout in runProcess.
  const eof = await runProcess(node, ["-e", "process.stdin.resume(); process.stdin.on('end', () => { console.log('eof'); process.exit(0) })"], { timeoutMs: 5000 })
  assert.equal(eof.end, "exit")
  assert.match(eof.out, /eof/)
  const echoed = await runProcessCapture(node, ["-e", "process.stdin.pipe(process.stdout)"], { input: Buffer.from([0, 1, 2, 255, 10, 0]), timeoutMs: 5000 })
  assert.deepEqual([...echoed.out], [0, 1, 2, 255, 10, 0], "NUL-separated git listings survive unchanged")
  const flood = await runProcessCapture(node, ["-e", "setInterval(() => process.stdout.write('x'.repeat(65536)), 1)"], { maxOutputBytes: 100000, timeoutMs: 10000 })
  assert.equal(flood.end, "overflow")
  assert.ok(flood.out.length <= 100000)
  assert.ok(flood.durationMs < 5000, "overflow stops the child instead of waiting for the timeout")
})

test("R4 4.7: one spawn policy — only proc.ts (and the long-lived sidecar bridge) call spawn()", () => {
  const dir = fileURLToPath(new URL("../../src", import.meta.url))
  const offenders = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.name.endsWith(".ts")) continue
      const rel = path.relative(dir, full).replaceAll("\\", "/")
      if (rel === "selection/proc.ts" || rel === "selection/bridge.ts") continue
      const text = readFileSync(full, "utf8")
      if (/from 'node:child_process'|from "node:child_process"|require\(['"]child_process/.test(text)) offenders.push(rel)
    }
  }
  walk(dir)
  assert.deepEqual(offenders, [], "spawn outside proc.ts bypasses kill escalation, group reclamation, and EPIPE containment")
})
