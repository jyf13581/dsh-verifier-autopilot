// The Python sidecar bridge: JSON Lines framing over a stub and the real sidecar
// (offline paths), timeouts, crashes, aborts, error frames, retry deadlines,
// preflight, and warm-up accounting.
//
// Part of the offline regression suite: `npm test` runs every scripts/tests/*.test.mjs
// in its own process; this file also runs alone with `node --test scripts/tests/bridge.test.mjs`.

import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { BridgeError, SIDECAR_ERROR_CODES, parseErrorFrame, parseHealthResult, parseProgressResult, parseSelectResult } from "../../lib/selection/bridge.js"
import { retryTransientBridge } from "../../lib/selection/retry.js"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { PROTOCOL, REAL_SIDECAR, STUB_SIDECAR, bridgeReq, mkBridge } from "./helpers/sidecar.mjs"
import { waitFor } from "./helpers/harness.mjs"

/** The canonical select result as the bridge must hand it to the runner. */
function canonicalSelectResult() {
  const r = PROTOCOL.responses.select.result
  return { index: r.index, bestPreview: r.best_preview, scores: r.scores, ranking: r.ranking, nComparisons: r.n_comparisons, criteria: r.criteria, usage: r.usage }
}

// ---------- best-of-N selection bridge (Phase 1) ----------
//
// Offline protocol tests for src/selection/bridge.ts: happy path, timeout,
// crash, abort, dispose, error passthrough. Boundary semantics run against
// the REAL sidecar (empty/single candidates never touch the network).

test("bridge: stub health roundtrip is the canonical health frame", async () => {
  const bridge = mkBridge(STUB_SIDECAR)
  try {
    const health = await bridge.health({ timeoutMs: 15000 })
    assert.deepEqual(health, PROTOCOL.responses.health.result, "health maps field-for-field from the canonical frame")
  } finally { await bridge.dispose() }
  await bridge.dispose()
})

test("bridge: stub select happy path maps the canonical result to camelCase and injects the key env", async () => {
  const bridge = mkBridge(STUB_SIDECAR)
  try {
    const result = await bridge.select(bridgeReq())
    assert.deepEqual(result, canonicalSelectResult(), "every documented result field arrives, renamed and nothing else")
  } finally { await bridge.dispose() }
})

test("bridge: the wire frames the bridge emits are the canonical request frames", async () => {
  const echoFile = path.join(mkdtempSync(path.join(tmpdir(), "va-echo-")), "frames.jsonl")
  const bridge = mkBridge(STUB_SIDECAR, { env: { STUB_ECHO_FILE: echoFile } })
  try {
    await bridge.select(bridgeReq())
    await bridge.progress({ problem: "demo pair", steps: ["step one"], model: "m", baseUrl: "http://127.0.0.1:9/v1", apiKey: "dummy", apiKeyEnv: "SMOKE_KEY" })
  } finally { await bridge.dispose() }
  const frames = readFileSync(echoFile, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line))
  // The bridge's own warm-up probe is a health frame; the caller frames follow.
  const byType = Object.fromEntries(frames.map((frame) => [frame.type, frame]))
  const withoutId = (frame) => { const { id, ...rest } = frame; assert.equal(typeof id, "string"); return rest }
  for (const type of ["health", "select", "progress", "shutdown"]) {
    assert.ok(byType[type], "a " + type + " frame was sent")
    assert.deepEqual(withoutId(byType[type]), withoutId(PROTOCOL.requests[type]), type + " frame matches bridge/protocol-fixtures.json")
  }
  rmSync(path.dirname(echoFile), { recursive: true, force: true })
})

test("bridge: frame parsers accept every canonical response and reject every malformed result as bridge_protocol", () => {
  assert.deepEqual(parseHealthResult(PROTOCOL.responses.health.result), PROTOCOL.responses.health.result)
  assert.deepEqual(parseSelectResult(PROTOCOL.responses.select.result), canonicalSelectResult())
  assert.deepEqual(parseProgressResult(PROTOCOL.responses.progress.result), PROTOCOL.responses.progress.result)
  // Telemetry degrades, verdicts do not: a partial usage block (what the real
  // sidecar sends on the single-candidate identity) fills with zeros.
  const partial = { ...PROTOCOL.responses.select.result, usage: { calls: 0 } }
  assert.equal(parseSelectResult(partial).usage.cache_hit_rate, 0)
  const parsers = { select: parseSelectResult, health: parseHealthResult, progress: parseProgressResult }
  for (const bad of PROTOCOL.malformed_results) {
    assert.throws(() => parsers[bad.type](bad.result), (err) => err instanceof BridgeError && err.code === "bridge_protocol", bad.name)
  }
  for (const [code, error] of Object.entries(PROTOCOL.errors)) {
    const mapped = parseErrorFrame({ id: "x", ok: false, error })
    assert.equal(mapped.code, code, "documented code " + code + " passes through")
    assert.equal(mapped.retriable, error.retriable)
    assert.equal(mapped.message, error.message)
  }
  const unknown = parseErrorFrame({ id: "x", ok: false, error: { code: "brand_new", message: "later protocol", retriable: true } })
  assert.equal(unknown.code, "selection_failed", "an undocumented code is not invented into the union")
  assert.match(unknown.message, /brand_new/)
  assert.equal(unknown.retriable, true, "the sidecar's retriable verdict still stands")
})

test("bridge: PROTOCOL.md, the fixtures, and the TypeScript error union agree", () => {
  const doc = readFileSync(fileURLToPath(new URL("../../bridge/PROTOCOL.md", import.meta.url)), "utf8")
  const section = (heading) => {
    const start = doc.indexOf(heading)
    assert.ok(start >= 0, heading + " section present")
    const rest = doc.slice(start + heading.length)
    const next = rest.search(/\n#{2,3} /)
    return next >= 0 ? rest.slice(0, next) : rest
  }
  const documentedCodes = [...section("## Error Codes").matchAll(/^- `([a-z_]+)`:/gm)].map((m) => m[1]).sort()
  assert.deepEqual(documentedCodes, Object.keys(PROTOCOL.errors).sort(), "every documented error code has a canonical fixture frame and vice versa")
  assert.deepEqual(documentedCodes, [...SIDECAR_ERROR_CODES].sort(), "the TypeScript sidecar code list is the documented list")
  for (const code of documentedCodes) {
    const line = section("## Error Codes").match(new RegExp("^- `" + code + "`:.*$", "m"))[0]
    const fixed = line.match(/`retriable`: (true|false)\./)
    if (fixed) assert.equal(String(PROTOCOL.errors[code].retriable), fixed[1], code + " retriable flag matches the document")
  }
  const keysIn = (heading) => [...section(heading).matchAll(/^\s*"([a-z_]+)":/gm)].map((m) => m[1]).filter((k, i, a) => a.indexOf(k) === i).sort()
  assert.deepEqual(Object.keys(PROTOCOL.requests.select).sort(), keysIn("### Select Request"), "select request keys")
  assert.deepEqual(Object.keys(PROTOCOL.requests.progress).sort(), keysIn("### Progress Request"), "progress request keys")
  const documentedResultKeys = keysIn("### Success Response").filter((k) => !["id", "ok", "result"].includes(k))
  const fixtureResultKeys = [...Object.keys(PROTOCOL.responses.select.result), ...Object.keys(PROTOCOL.responses.select.result.usage)].sort()
  assert.deepEqual(fixtureResultKeys, documentedResultKeys, "select success result keys (including usage)")
})

test("bridge: real sidecar rejects empty candidates offline", async () => {
  const bridge = mkBridge(REAL_SIDECAR)
  try {
    await assert.rejects(
      bridge.select(bridgeReq({ candidates: [] })),
      (err) => err instanceof BridgeError && err.code === "invalid_request" && err.retriable === false)
  } finally { await bridge.dispose() }
})

test("bridge: real sidecar short-circuits a single candidate without provider calls", async () => {
  const bridge = mkBridge(REAL_SIDECAR)
  try {
    const result = await bridge.select(bridgeReq({ candidates: ["only one"] }))
    assert.equal(result.index, 0)
    assert.equal(result.nComparisons, 0)
    assert.equal(result.usage.calls, 0, "single candidate must not touch the provider")
    assert.deepEqual(result.scores, [1.0])
  } finally { await bridge.dispose() }
})

test("bridge: real sidecar accepts a per-request effort override and rejects unknown levels", async () => {
  const bridge = mkBridge(REAL_SIDECAR)
  try {
    const maxed = await bridge.select(bridgeReq({ candidates: ["only one"], effort: "max" }))
    assert.equal(maxed.index, 0, "single-candidate frame with effort still validates and short-circuits")
    await assert.rejects(
      bridge.select(bridgeReq({ candidates: ["only one"], effort: "turbo" })),
      (err) => err instanceof BridgeError && err.code === "invalid_request" && err.retriable === false)
    await assert.rejects(
      bridge.progress({ problem: "p", steps: ["s"], model: "m", baseUrl: "http://127.0.0.1:9/v1", apiKey: "dummy", apiKeyEnv: "SMOKE_KEY", effort: 7 }),
      (err) => err instanceof BridgeError && err.code === "invalid_request")
  } finally { await bridge.dispose() }
})

test("bridge: timeout kills the serial child, rejects bridge_timeout, then respawns", async () => {
  const bridge = mkBridge(STUB_SIDECAR)
  try {
    await assert.rejects(
      bridge.select(bridgeReq({ problem: "HANG pair", timeoutMs: 900 })),
      (err) => err instanceof BridgeError && err.code === "bridge_timeout" && err.retriable === true)
    assert.equal(bridge.alive, false, "a timed-out serial child must be killed")
    const health = await bridge.health({ timeoutMs: 15000 })
    assert.equal(health.select_available, true, "bridge respawns lazily after a kill")
  } finally { await bridge.dispose() }
})

test("bridge: child crash rejects pending as bridge_down and later requests respawn", async () => {
  const bridge = mkBridge(STUB_SIDECAR)
  try {
    await assert.rejects(
      bridge.select(bridgeReq({ problem: "CRASH pair", timeoutMs: 10000 })),
      (err) => err instanceof BridgeError && err.code === "bridge_down")
    const health = await bridge.health({ timeoutMs: 15000 })
    assert.equal(health.select_available, true)
  } finally { await bridge.dispose() }
})

test("bridge: external abort rejects bridge_aborted and reaps the in-flight child", async () => {
  const bridge = mkBridge(STUB_SIDECAR)
  try {
    const controller = new AbortController()
    const run = bridge.select(bridgeReq({ problem: "HANG abort", timeoutMs: 30000, signal: controller.signal }))
    setTimeout(() => controller.abort(), 100)
    await assert.rejects(run, (err) => err instanceof BridgeError && err.code === "bridge_aborted")
    assert.equal(bridge.alive, false)
  } finally { await bridge.dispose() }
})

test("bridge: sidecar error frames pass code, message, and retriable through", async () => {
  const bridge = mkBridge(STUB_SIDECAR)
  const canonical = PROTOCOL.errors.provider_error
  try {
    await assert.rejects(
      bridge.select(bridgeReq({ problem: "ERRPROV pair" })),
      (err) => err instanceof BridgeError && err.code === canonical.code && err.retriable === canonical.retriable && err.message === canonical.message)
  } finally { await bridge.dispose() }
})

test("bridge: dispose with an in-flight request rejects it and is idempotent", async () => {
  const bridge = mkBridge(STUB_SIDECAR)
  const run = bridge.select(bridgeReq({ problem: "HANG dispose", timeoutMs: 30000 }))
  setTimeout(() => { void bridge.dispose() }, 100)
  await assert.rejects(run, (err) => err instanceof BridgeError && /^bridge_(down|disposed)$/.test(err.code))
  await bridge.dispose()
})

test("retry: shares one absolute deadline and passes dynamic remaining time", async () => {
  let clock = 1000
  const attempts = []
  const delays = []
  await assert.rejects(
    retryTransientBridge(async (context) => {
      attempts.push({ attempt: context.attempt, timeoutMs: context.timeoutMs, aborted: context.signal.aborted })
      clock += 40
      throw new BridgeError("provider_error", "temporary", true)
    }, {
      deadlineAt: 1100,
      now: () => clock,
      delaysMs: [30],
      maxAttempts: 5,
      sleep: async (delayMs) => { delays.push(delayMs); clock += delayMs },
    }),
    (err) => err instanceof BridgeError && err.code === "selection_timeout",
  )
  assert.deepEqual(attempts, [
    { attempt: 1, timeoutMs: 100, aborted: false },
    { attempt: 2, timeoutMs: 30, aborted: false },
  ])
  assert.deepEqual(delays, [30])
}, { timeout: 2000 })

test("retry: absolute deadline aborts an in-flight operation", async () => {
  let operationAborted = false
  const startedAt = Date.now()
  await assert.rejects(
    retryTransientBridge(async (context) => await new Promise((resolve, reject) => {
      context.signal.addEventListener("abort", () => {
        operationAborted = true
        reject(new BridgeError("bridge_timeout", "operation noticed deadline", true))
      }, { once: true })
    }), { deadlineAt: Date.now() + 45 }),
    (err) => err instanceof BridgeError && err.code === "selection_timeout",
  )
  assert.equal(operationAborted, true)
  assert.ok(Date.now() - startedAt < 1000, "deadline must not wait for the operation's own timeout")
}, { timeout: 2000 })

test("retry: external abort during backoff settles as bridge_aborted", async () => {
  const controller = new AbortController()
  let attempts = 0
  const run = retryTransientBridge(async () => {
    attempts += 1
    throw new BridgeError("provider_error", "temporary", true)
  }, {
    signal: controller.signal,
    delaysMs: [500],
    sleep: async (delayMs, signal) => await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs)
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new BridgeError("bridge_aborted", "cancelled", false)) }, { once: true })
    }),
  })
  setTimeout(() => controller.abort(), 30)
  await assert.rejects(run, (err) => err instanceof BridgeError && err.code === "bridge_aborted")
  assert.equal(attempts, 1)
}, { timeout: 2000 })

test("bridge preflight: passes when the verifier strictly prefers the present output", async () => {
  const bridge = mkBridge(STUB_SIDECAR)
  try {
    await bridge.preflight({ model: "m", baseUrl: "http://127.0.0.1:9/v1", apiKey: "dummy", apiKeyEnv: "SMOKE_KEY" })
  } finally { await bridge.dispose() }
})

test("bridge preflight: degenerate tie scores fail fast with preflight_failed", async () => {
  const bridge = mkBridge(STUB_SIDECAR)
  try {
    await assert.rejects(
      bridge.preflight({ model: "m", baseUrl: "http://tie.invalid/v1", apiKey: "dummy", apiKeyEnv: "SMOKE_KEY" }),
      (err) => err instanceof BridgeError && err.code === "preflight_failed" && err.retriable === false)
  } finally { await bridge.dispose() }
})

test("bridge: sidecar warm-up is measured from spawn to first answer, and the internal probe is never a lost caller request", async () => {
  const { Diagnostics } = await import("../../lib/index.js")
  const diag = new Diagnostics()
  const bridge = mkBridge(STUB_SIDECAR, { diagnostics: diag })
  try {
    assert.equal(bridge.lastWarmupMs, null, "nothing measured before the first spawn")
    await bridge.health({ timeoutMs: 15000 })
    await waitFor(() => diag.snapshot().counters["sidecar.warmups"] === 1, 5000)
    const snapshot = diag.snapshot()
    assert.equal(typeof bridge.lastWarmupMs, "number")
    assert.ok(bridge.lastWarmupMs >= 0 && bridge.lastWarmupMs < 15000)
    assert.equal(snapshot.counters["sidecar.warmup_ms"], bridge.lastWarmupMs, "the counter accumulates the same milliseconds the getter reports")
    assert.ok(!snapshot.entries.some((entry) => entry.scope === "sidecar.warmup"), "a fast warm-up is a counter, not a warning")
    assert.ok(!snapshot.entries.some((entry) => entry.scope === "sidecar.select_unavailable"), "the stub reports select_available=true")
  } finally { await bridge.dispose() }
})
