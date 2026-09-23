// The diagnostics sink and what reports into it: ring coalescing, redaction,
// notification, /events delivery, and the leaf-module boundary.
//
// Part of the offline regression suite: `npm test` runs every scripts/tests/*.test.mjs
// in its own process; this file also runs alone with `node --test scripts/tests/diagnostics.test.mjs`.

import test from "node:test"
import assert from "node:assert/strict"
import { VerifierHost, apiRoutes } from "../../lib/index.js"
import { fileURLToPath } from "node:url"
import { BridgeError } from "../../lib/selection/bridge.js"
import { SelectionRunner } from "../../lib/selection/candidates.js"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { LF } from "./helpers/harness.mjs"
import { fakeBridge, makeFakeFactory, realWorkspaces, selInput } from "./helpers/selection.mjs"
import { fakeContext, fakeReq, fakeRes, hostOverrides } from "./helpers/host.mjs"
import { STUB_SIDECAR, bridgeReq, mkBridge } from "./helpers/sidecar.mjs"

// ---------- round 4: observability — silent best-effort becomes visible degradation ----------

test("diagnostics: the ring coalesces consecutive repeats, bounds itself, and caps a noisy scope's share", async () => {
  const { Diagnostics, DIAGNOSTICS_SCOPE_SHARE } = await import("../../lib/index.js")
  let clock = 1000
  const diag = new Diagnostics({ limit: 10, now: () => clock })
  diag.warn("ledger.append", new Error("EACCES: denied"), { file: "a.jsonl" })
  clock += 5
  diag.warn("ledger.append", new Error("EACCES: denied"), { file: "a.jsonl" })
  clock += 5
  diag.warn("ledger.append", new Error("EACCES: denied"), { file: "a.jsonl" })
  let snap = diag.snapshot()
  assert.equal(snap.entries.length, 1, "identical consecutive warnings fold into one entry")
  assert.equal(snap.entries[0].count, 3)
  assert.equal(snap.entries[0].firstAt, 1000, "firstAt keeps the start of the run")
  assert.equal(snap.entries[0].at, 1010, "at tracks the latest repeat")
  assert.deepEqual(snap.entries[0].detail, { file: "a.jsonl" })
  diag.warn("ledger.append", new Error("EACCES: denied"), { file: "b.jsonl" })
  assert.equal(diag.snapshot().entries.length, 2, "a different detail is a different entry")

  // A flapping scope with a varying message may hold at most its share.
  diag.warn("keep.me", "important and rare")
  for (let i = 0; i < 40; i += 1) diag.warn("noisy.sampler", "tick " + i + " failed")
  snap = diag.snapshot()
  const noisy = snap.entries.filter((entry) => entry.scope === "noisy.sampler")
  assert.equal(noisy.length, Math.floor(10 * DIAGNOSTICS_SCOPE_SHARE), "one scope never exceeds its share of the ring")
  assert.equal(noisy[0].message, "tick 39 failed", "the newest text of the noisy scope stays visible")
  assert.ok(snap.entries.some((entry) => entry.scope === "keep.me"), "other scopes survive a flood")
  assert.ok(snap.entries.length <= 10, "ring stays within its limit")
  assert.ok(snap.evicted >= 38, "evictions are accounted, not hidden (got " + snap.evicted + ")")

  // Global bound across many scopes.
  for (let i = 0; i < 25; i += 1) diag.warn("scope." + i, "distinct")
  snap = diag.snapshot()
  assert.equal(snap.entries.length, 10)
  assert.equal(snap.entries[0].scope, "scope.24", "newest first")
  diag.reset()
  assert.deepEqual(diag.snapshot(), { entries: [], counters: {}, evicted: 0 })
})

test("diagnostics: text is redacted and bounded, counters never notify, warnings do, and describeCause keeps machine codes", async () => {
  const { Diagnostics, describeCause } = await import("../../lib/index.js")
  const diag = new Diagnostics()
  let notified = 0
  const unsubscribe = diag.subscribe(() => { notified += 1 })
  diag.subscribe(() => { throw new Error("broken observer") })
  diag.count("quiet.counter")
  diag.count("quiet.counter", 4)
  diag.count("quiet.counter", Number.NaN)
  assert.equal(notified, 0, "counters are safe to bump from inside emit paths")
  const key = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"
  diag.warn("relay.post", new Error("relay rejected Bearer " + key + " " + "x".repeat(400)), {
    url: "https://relay.local/v1?api_key=" + key + "&trace=" + "y".repeat(300),
    selectionId: "sel-1",
    skipped: null,
    missing: undefined,
    attempt: 2,
  })
  assert.equal(notified, 1, "a warning notifies subscribers even when another observer throws")
  const [entry] = diag.snapshot().entries
  assert.ok(!entry.message.includes(key) && !JSON.stringify(entry.detail).includes(key), "no credential survives into the snapshot")
  assert.ok(entry.message.includes("[REDACTED"), "redaction is visible, not silent truncation")
  assert.ok(entry.message.length <= 240, "message bounded (" + entry.message.length + ")")
  assert.ok(entry.detail.url.length <= 160, "detail strings bounded (" + entry.detail.url.length + ")")
  assert.deepEqual(Object.keys(entry.detail).sort(), ["attempt", "selectionId", "url"], "null/undefined detail keys are dropped")
  assert.deepEqual(diag.snapshot().counters, { "quiet.counter": 5 })
  unsubscribe()
  diag.warn("relay.post", "again")
  assert.equal(notified, 1, "unsubscribe is honored")

  assert.equal(describeCause(new BridgeError("bridge_timeout", "sidecar request 7 exceeded 900ms", true)), "bridge_timeout: sidecar request 7 exceeded 900ms")
  assert.equal(describeCause(new BridgeError("bridge_down", "bridge_down: already prefixed", true)), "bridge_down: already prefixed", "no double prefix")
  assert.equal(describeCause("plain text"), "plain text")
  assert.equal(describeCause({ code: 9 }), '{"code":9}')
  assert.equal(describeCause(undefined), "undefined")
  // Never throws, whatever the cause.
  const cyclic = {}; cyclic.self = cyclic
  diag.warn("weird.cause", cyclic)
  assert.equal(diag.snapshot().entries[0].scope, "weird.cause")
})

test("diagnostics: a ledger that cannot be appended or fully read is reported by the selection host, never thrown", async () => {
  const { SelectionHost } = await import("../../lib/selection/host.js")
  const { Diagnostics } = await import("../../lib/index.js")
  const diag = new Diagnostics()
  const dir = mkdtempSync(path.join(tmpdir(), "va-diag-"))
  const file = path.join(dir, "selections.jsonl")
  const base = { selectionId: "sel-diag", sourceSessionId: null, status: "completed", candidates: [], startedAt: 1, finishedAt: 2 }
  writeFileSync(file, JSON.stringify(base) + LF + '{"selectionId":"sel-torn","status":"comp' + LF + JSON.stringify({ ...base, selectionId: "sel-future", v: 99 }) + LF)
  try {
    const host = new SelectionHost({ verifier: () => ({ model: "m", baseURL: "u", apiKeyEnv: "k" }), selectionsFile: file, diagnostics: diag })
    const record = host.getSelection("sel-diag")
    assert.ok(record, "the readable row loads")
    let snap = diag.snapshot()
    const corrupt = snap.entries.find((entry) => entry.scope === "selections.corrupt_rows")
    assert.ok(corrupt, "unreadable rows are one visible entry, not a silent skip")
    assert.equal(corrupt.detail.rows, 2, "torn line + unknown-version row")
    assert.equal(corrupt.detail.file, file)
    assert.equal(snap.entries.length, 1, "one entry per load, however many rows were bad")

    // Turn the ledger into a directory: every append now fails with EISDIR.
    rmSync(file, { force: true })
    mkdirSync(file)
    host.pubRecord(record)
    host.pubRecord(record)
    snap = diag.snapshot()
    const append = snap.entries.find((entry) => entry.scope === "selections.append")
    assert.ok(append, "a failed ledger append is reported")
    assert.equal(append.count, 2, "repeats fold into a count")
    assert.match(append.message, /EISDIR/)
    assert.equal(append.detail.selectionId, "sel-diag")
    assert.equal(host.listSelections().length, 1, "the host keeps serving in-memory history")
    await host.dispose()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("diagnostics: a loser workspace that will not go away is reported with its selection and candidate, and the run still completes", async () => {
  const { Diagnostics } = await import("../../lib/index.js")
  const diag = new Diagnostics()
  const factory = makeFakeFactory({})
  const bridge = fakeBridge()
  const workspaces = {
    ...realWorkspaces,
    async remove() { throw new Error("EBUSY: worktree locked (token=sk-LOSERWORKSPACE0123456789ABCD)") },
  }
  const runner = new SelectionRunner({ factory, workspaces, bridge, diagnostics: diag })
  const { record } = await runner.run(selInput({ candidateCount: 3 }))
  assert.equal(record.status, "completed", "loser cleanup stays best-effort for the run")
  assert.equal(record.winner.index, 0)
  const snap = diag.snapshot()
  const leaks = snap.entries.filter((entry) => entry.scope === "loser.workspace")
  assert.equal(leaks.length, 2, "one entry per leaked loser workspace")
  assert.deepEqual(leaks.map((entry) => entry.detail.candidate).sort(), [1, 2])
  for (const leak of leaks) {
    assert.equal(leak.detail.selectionId, record.selectionId)
    assert.match(leak.message, /EBUSY/)
    assert.ok(!leak.message.includes("LOSERWORKSPACE"), "secrets in a cleanup error are redacted")
  }
  for (const c of record.candidates) { try { rmSync(c.workspace, { recursive: true, force: true }) } catch { /* fixture cleanup */ } }
})

test("diagnostics: the Host snapshot carries the ledger, a warning pushes it over /events, and counters stay quiet", async () => {
  const { VerifierHost, apiRoutes, Diagnostics } = await import("../../lib/index.js")
  const diag = new Diagnostics()
  const dir = mkdtempSync(path.join(tmpdir(), "va-diag-host-"))
  const recordsFile = path.join(dir, "records.jsonl")
  writeFileSync(recordsFile, JSON.stringify({ id: "r1", sessionId: "s", turn: 1, status: "completed", startedAt: 1 }) + LF + "{torn" + LF)
  const ctx = fakeContext()
  const host = new VerifierHost(ctx, hostOverrides(), { recordsFile, diagnostics: diag })
  try {
    host.start()
    const corrupt = diag.snapshot().entries.find((entry) => entry.scope === "records.corrupt_rows")
    assert.ok(corrupt && corrupt.detail.rows === 1, "verification ledger corruption is visible at startup")
    assert.equal(host.getDiagnostics(), diag, "the injected sink is the one the Host reports from")

    let emits = 0
    host.subscribe(() => { emits += 1 })
    host.subscribe(() => { throw new Error("broken panel") })
    diag.count("only.a.counter")
    assert.equal(emits, 0, "counters do not fan out to SSE clients")
    diag.warn("test.scope", new Error("something degraded"), { selectionId: "sel-x" })
    assert.equal(emits, 1, "a warning is a state change the panel sees immediately")
    assert.equal(diag.snapshot().counters["host.subscriber_error"], 1, "a throwing subscriber is counted, not warned (no re-entrant loop)")

    const routes = apiRoutes(host)
    const stateRes = fakeRes()
    await routes.find((route) => route.path.endsWith("/state")).handler(fakeReq(null, "/state", "GET"), stateRes)
    assert.equal(stateRes.status, 200)
    const state = JSON.parse(stateRes.bodyText)
    assert.ok(state.diagnostics && Array.isArray(state.diagnostics.entries), "/state exposes the diagnostics snapshot")
    assert.equal(state.diagnostics.entries[0].scope, "test.scope")
    assert.deepEqual(state.diagnostics.entries[0].detail, { selectionId: "sel-x" })
    assert.equal(typeof state.diagnostics.counters["only.a.counter"], "number")

    // /events: the first push happens on connect, the next on the warning.
    const writes = []
    let onClose = null
    const sseRes = { writeHead() {}, write(chunk) { writes.push(String(chunk)) }, end() {}, once(name, fn) { if (name === "close") onClose = fn } }
    const sseReq = { method: "GET", url: "/events", headers: {}, once() {} }
    routes.find((route) => route.path.endsWith("/events")).handler(sseReq, sseRes)
    assert.equal(writes.length, 1, "initial state is pushed on connect")
    diag.warn("test.scope", new Error("another one"))
    assert.equal(writes.length, 2, "each warning pushes a fresh state frame")
    assert.ok(writes[1].includes('"scope":"test.scope"') && writes[1].includes("another one"), "the pushed frame carries the new entry")
    onClose()
    const before = writes.length
    await host.dispose()
    diag.warn("test.scope", new Error("after dispose"))
    assert.equal(writes.length, before, "a disposed Host no longer fans out diagnostics")
  } finally {
    await host.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("diagnostics: sidecar death and request timeouts are reported by the bridge; a clean dispose is not", async () => {
  const { Diagnostics } = await import("../../lib/index.js")
  const diag = new Diagnostics()
  const crashing = mkBridge(STUB_SIDECAR, { diagnostics: diag })
  try {
    await assert.rejects(crashing.select(bridgeReq({ problem: "CRASH pair", timeoutMs: 10000 })), (err) => err instanceof BridgeError && err.code === "bridge_down")
    const exit = diag.snapshot().entries.find((entry) => entry.scope === "sidecar.exit")
    assert.ok(exit, "an unexpected sidecar exit is a diagnostic")
    assert.match(exit.message, /^bridge_down: /, "the stable code prefixes the free text")
    assert.equal(exit.detail.pending, 1, "the number of requests the crash took down is recorded")
    await assert.rejects(crashing.select(bridgeReq({ problem: "HANG pair", timeoutMs: 700 })), (err) => err instanceof BridgeError && err.code === "bridge_timeout")
    const timeout = diag.snapshot().entries.find((entry) => entry.scope === "sidecar.timeout")
    assert.ok(timeout, "a request timeout is a diagnostic")
    assert.equal(timeout.detail.type, "select")
    assert.ok(!/request \d+/.test(timeout.message), "the message carries no per-request id, so repeats coalesce")
    assert.equal(diag.snapshot().counters["sidecar.spawn"], 1)
    assert.equal(diag.snapshot().counters["sidecar.respawn"], 1, "the lazy respawn after the crash is counted")
  } finally { await crashing.dispose() }
  const exitsBeforeClean = diag.snapshot().entries.filter((entry) => entry.scope === "sidecar.exit").length
  const clean = mkBridge(STUB_SIDECAR, { diagnostics: diag })
  await clean.health({ timeoutMs: 15000 })
  await clean.dispose()
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(diag.snapshot().entries.filter((entry) => entry.scope === "sidecar.exit").length, exitsBeforeClean, "an operator-initiated dispose is not a degradation")
})

test("diagnostics: the sink is a leaf module and the architecture gate says so", () => {
  const source = readFileSync(fileURLToPath(new URL("../../src/diagnostics.ts", import.meta.url)), "utf8")
  const imports = [...source.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1])
  assert.ok(imports.length >= 1, "fixture: the module imports something")
  for (const specifier of imports) {
    assert.ok(specifier === "./util.js" || specifier === "./constants.js", "diagnostics.ts may import only util/constants, found " + specifier)
  }
  const gate = readFileSync(fileURLToPath(new URL("../check-architecture.mjs", import.meta.url)), "utf8")
  assert.ok(gate.includes("from === 'src/diagnostics.ts'"), "the architecture gate enforces the leaf rule in CI")
  const protocol = readFileSync(fileURLToPath(new URL("../../src/protocol.ts", import.meta.url)), "utf8")
  assert.match(protocol, /import type \{ DiagnosticsSnapshot \} from '\.\/diagnostics\.js'/, "the browser-safe protocol takes the snapshot shape type-only")
  const client = readFileSync(fileURLToPath(new URL("../../src/client/index.ts", import.meta.url)), "utf8")
  assert.ok(client.includes("new EventSource(API + '/events')"), "the panel consumes the SSE route instead of leaving it dead")
  assert.ok(!/window\.setInterval\(\(\) => \{ void refresh\(\) \}, [35]000\)/.test(client), "the fixed 3s/5s polling loops are gone")
})
