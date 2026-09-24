// HTTP transport: per-route rate-limit buckets, input validation before quota,
// probe readiness, /records queries, the mutating-endpoint token gate, client
// disconnects, and the single redacted 500 path.
//
// Part of the offline regression suite: `npm test` runs every scripts/tests/*.test.mjs
// in its own process; this file also runs alone with `node --test scripts/tests/api.test.mjs`.

import test from "node:test"
import assert from "node:assert/strict"
import { VerifierHost, apiRoutes } from "../../lib/index.js"
import { verifyRoute } from "../../lib/verifier.js"
import { completedTurnEvents, fakeAgent, fakeContext, fakeReq, fakeRes, fireIdle, gatedLane, hostOverrides, laneSuccessBody, mockLaneServer } from "./helpers/host.mjs"
import { LF, deferred, quiesce, waitFor } from "./helpers/harness.mjs"
import { successBody } from "./helpers/provider.mjs"
import { mkSelectionHost } from "./helpers/selection.mjs"

/** Response sink whose `close` listener can be fired to simulate a client that
 *  hung up before the handler answered. */
function disconnectableRes() {
  const res = fakeRes()
  const closers = []
  res.once = (event, listener) => { if (event === "close") closers.push(listener) }
  res.disconnect = () => { for (const listener of closers.splice(0)) listener() }
  return res
}

test("phase0: POST /verify reports lifecycle aborts as 503 instead of a missing session", async () => {
  const { VerifierHost, apiRoutes } = await import("../../lib/index.js")
  const server = mockLaneServer()
  try {
    const gate = deferred()
    server.enqueue(call => gatedLane(call, gate))
    const ctx = fakeContext()
    const host = new VerifierHost(ctx, hostOverrides())
    host.start()
    const agent = ctx.spawnAgent(fakeAgent("sess-abort", completedTurnEvents(1)))
    ctx.emit("agent/created", { agent })
    fireIdle(agent)
    await quiesce(15)
    assert.equal(server.calls.length, 1)

    const route = apiRoutes(host).find(item => item.path.endsWith("/verify"))
    const res = fakeRes()
    const pending = route.handler(fakeReq({ sessionId: "sess-abort" }), res)
    await quiesce(10)
    host.dispose()
    await pending
    assert.equal(res.status, 503)
    assert.ok(res.bodyText.includes("verification-aborted"))
    gate.resolve()

    const unknown = fakeRes()
    await route.handler(fakeReq({ sessionId: "sess-unknown" }), unknown)
    assert.equal(unknown.status, 404, "unknown sessions retain the not-found response")
  } finally { server.restore() }
})

test("phase1: /eval validates before consuming its rate-limit bucket", async () => {
  const { VerifierHost, apiRoutes, API_RATE_LIMITS } = await import("../../lib/index.js")
  const host = new VerifierHost(fakeContext(), hostOverrides())
  const evalRoute = apiRoutes(host).find(route => route.path.endsWith("/eval"))
  assert.ok(evalRoute, "/eval route exported for policy enforcement")
  const quota = API_RATE_LIMITS.evalPerMinute
  assert.ok(quota >= 20, "the quota must stay far above legitimate eval usage")
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => successBody })
  try {
    const invalid = fakeRes()
    await evalRoute.handler(fakeReq({ problem: "p", trace: "" }), invalid)
    assert.equal(invalid.status, 400, "invalid input is rejected before quota accounting")
    const wrongType = fakeRes()
    await evalRoute.handler({ ...fakeReq({ problem: "p", trace: "valid trace" }), headers: {} }, wrongType)
    assert.equal(wrongType.status, 415, "content type is rejected before quota accounting")
    const responses = []
    for (let i = 0; i <= quota; i += 1) {
      const res = fakeRes()
      await evalRoute.handler(fakeReq({ problem: "p", trace: "valid trace" }), res)
      responses.push({ status: res.status, bodyText: res.bodyText })
    }
    for (let i = 0; i < quota; i += 1) assert.equal(responses[i].status, 200, "valid requests consume the bucket")
    assert.equal(responses[quota].status, 429, "the request after the window quota is throttled")
    assert.ok(responses[quota].bodyText.includes("rate-limited"))
  } finally { globalThis.fetch = originalFetch }
})

test("phase1: /probe has an independent rate-limit bucket from /eval", async () => {
  const { VerifierHost, apiRoutes, API_RATE_LIMITS } = await import("../../lib/index.js")
  const host = new VerifierHost(fakeContext(), hostOverrides())
  const routeList = apiRoutes(host)
  const evalRoute = routeList.find(route => route.path.endsWith("/eval"))
  const probeRoute = routeList.find(route => route.path.endsWith("/probe"))
  const originalFetch = globalThis.fetch
  // A non-transient local stand-in exercises each bucket without retry sleeps.
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({}) })
  try {
    for (let i = 0; i <= API_RATE_LIMITS.evalPerMinute; i += 1) await evalRoute.handler(fakeReq({ problem: "p", trace: "valid trace" }), fakeRes())
    const malformedProbe = fakeRes()
    await probeRoute.handler(fakeReq(null), malformedProbe)
    assert.equal(malformedProbe.status, 400, "a non-object probe body is rejected before quota accounting")
    assert.ok(malformedProbe.bodyText.includes("json-object-required"))
    const res = fakeRes()
    await probeRoute.handler(fakeReq({}), res)
    assert.equal(res.status, 200, "an exhausted eval bucket must not throttle the probe bucket")
    let throttled = false
    // The bucket-separation call above consumed one probe slot.
    for (let i = 0; i < API_RATE_LIMITS.probePerMinute - 1; i += 1) {
      const r = fakeRes()
      await probeRoute.handler(fakeReq({}), r)
      if (r.status === 429) { throttled = true; break }
      assert.equal(r.status, 200)
    }
    assert.equal(throttled, false, "the probe quota itself stays available within its window")
  } finally { globalThis.fetch = originalFetch }
})

test("phase1: /verify has an independent rate-limit bucket and rejects bad input before quota accounting", async () => {
  const { VerifierHost, apiRoutes, API_RATE_LIMITS } = await import("../../lib/index.js")
  const host = new VerifierHost(fakeContext(), hostOverrides())
  const routeList = apiRoutes(host)
  const evalRoute = routeList.find(route => route.path.endsWith("/eval"))
  const probeRoute = routeList.find(route => route.path.endsWith("/probe"))
  const verifyRoute = routeList.find(route => route.path.endsWith("/verify"))
  assert.ok(verifyRoute, "/verify route exported for policy enforcement")
  assert.equal(API_RATE_LIMITS.verifyPerMinute, 60, "the verify window quota stays pinned at the documented 60/min")
  const originalFetch = globalThis.fetch
  // Benign local stand-ins so draining the sibling buckets touches no network.
  // Status 400 is deliberately NON-transient (no lane-retry backoff sleep), so
  // the drain finishes well inside the sliding window without stamps aging
  // out mid-test.
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({}) })
  try {
    for (let i = 0; i <= API_RATE_LIMITS.evalPerMinute; i += 1) await evalRoute.handler(fakeReq({ problem: "p", trace: "valid trace" }), fakeRes())
    for (let i = 0; i < API_RATE_LIMITS.probePerMinute; i += 1) await probeRoute.handler(fakeReq({}), fakeRes())
    const drainedProbe = fakeRes()
    await probeRoute.handler(fakeReq({}), drainedProbe)
    assert.equal(drainedProbe.status, 429, "control: the probe bucket really is drained")

    // Refusals that happen before the limiter must never consume a verify slot.
    const wrongShape = fakeRes()
    await verifyRoute.handler(fakeReq(null), wrongShape)
    assert.equal(wrongShape.status, 400, "a non-object body is rejected before quota accounting")
    assert.ok(wrongShape.bodyText.includes("json-object-required"))
    const malformed = fakeRes()
    await verifyRoute.handler({ method: "POST", url: "/verify", headers: { "content-type": "application/json" }, [Symbol.asyncIterator]: async function* () { yield Buffer.from("{not json") } }, malformed)
    assert.equal(malformed.status, 400, "malformed JSON is rejected before quota accounting")
    assert.ok(malformed.bodyText.includes("invalid-json-body"))
    const noSession = fakeRes()
    await verifyRoute.handler(fakeReq({}), noSession)
    assert.equal(noSession.status, 400, "a missing sessionId is rejected before quota accounting")
    assert.ok(noSession.bodyText.includes("session-id-required"))

    // Independence: with eval and probe drained, verify still serves its own full window.
    for (let i = 0; i < API_RATE_LIMITS.verifyPerMinute; i += 1) {
      const res = fakeRes()
      await verifyRoute.handler(fakeReq({ sessionId: "sess-unknown" }), res)
      assert.equal(res.status, 404, "request " + i + " passes the untouched verify bucket (unknown session 404s, never 429)")
    }
    const throttled = fakeRes()
    await verifyRoute.handler(fakeReq({ sessionId: "sess-unknown" }), throttled)
    assert.equal(throttled.status, 429, "the request past the verify window quota is throttled")
    assert.ok(throttled.bodyText.includes("rate-limited"))
  } finally { globalThis.fetch = originalFetch }
})

test("phase2: probe rejects malformed JSON bodies with 400 instead of probing blind", async () => {
  const { VerifierHost, apiRoutes } = await import("../../lib/index.js")
  const host = new VerifierHost(fakeContext(), hostOverrides())
  const probeRoute = apiRoutes(host).find(route => route.path.endsWith("/probe"))
  const original = globalThis.fetch
  let fetchCalled = 0
  globalThis.fetch = async () => { fetchCalled += 1; throw new Error("must not reach provider") }
  try {
    const res = fakeRes()
    await probeRoute.handler({ method: "POST", url: "/probe", headers: { "content-type": "application/json" }, [Symbol.asyncIterator]: async function* () { yield Buffer.from("{not json") } }, res)
    assert.equal(res.status, 400, "malformed input is a client error, not an empty-body probe")
    assert.ok(res.bodyText.includes("invalid-json-body"))
    assert.equal(fetchCalled, 0)
  } finally { globalThis.fetch = original }
})

test("phase2: probe listModels maps upstream failure into ok:false with the real status", async () => {
  const { VerifierHost, apiRoutes } = await import("../../lib/index.js")
  const host = new VerifierHost(fakeContext(), hostOverrides())
  const probeRoute = apiRoutes(host).find(route => route.path.endsWith("/probe"))
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: { message: "upstream down" } }) })
  try {
    const res = fakeRes()
    await probeRoute.handler(fakeReq({ listModels: true }), res)
    const body = JSON.parse(res.bodyText)
    assert.equal(res.status, 200)
    assert.equal(body.ok, false, "upstream non-2xx must not report ok:true")
    assert.equal(body.status, 503)
    assert.equal(body.apiError, "upstream down")
  } finally { globalThis.fetch = original }
})

test("phase2 (F10): probe refuses a non-http(s) baseURL before any fetch, even for listModels", async () => {
  const { VerifierHost, apiRoutes } = await import("../../lib/index.js")
  // The constructor takes the config verbatim (validation lives in setConfig),
  // so an ftp:// baseURL reaches the route exactly as a misconfigured Host would.
  const host = new VerifierHost(fakeContext(), hostOverrides({ baseURL: "ftp://bad.example.com" }))
  const probeRoute = apiRoutes(host).find(route => route.path.endsWith("/probe"))
  const original = globalThis.fetch
  let fetchCalled = 0
  globalThis.fetch = async () => { fetchCalled += 1; throw new Error("must not reach provider") }
  try {
    const res = fakeRes()
    await probeRoute.handler(fakeReq({ listModels: true }), res)
    assert.equal(res.status, 200)
    const body = JSON.parse(res.bodyText)
    assert.equal(body.ok, false)
    assert.equal(body.errorCode, "invalid_base_url", "the scheme gate reports its own error code")
    assert.equal(body.transportOk, false)
    assert.equal(body.httpStatus, null)
    assert.equal(fetchCalled, 0, "no network attempt may happen for a non-http(s) target, listModels or not")
  } finally { globalThis.fetch = original }
})

test("phase2: probe reports strict readiness through the production lane path", async () => {
  const { VerifierHost, apiRoutes } = await import("../../lib/index.js")
  const server = mockLaneServer()
  try {
    const host = new VerifierHost(fakeContext(), hostOverrides())
    const probeRoute = apiRoutes(host).find(route => route.path.endsWith("/probe"))

    server.enqueueBody(laneSuccessBody())
    let res = fakeRes()
    await probeRoute.handler(fakeReq({}), res)
    let body = JSON.parse(res.bodyText)
    assert.equal(res.status, 200)
    assert.equal(body.ok, true, "ok keeps meaning 'handler completed a structured check'")
    assert.equal(body.transportOk, true)
    assert.equal(body.httpStatus, 200)
    assert.equal(body.finish, "stop")
    assert.equal(body.hasScoreTags, true)
    assert.equal(body.scoreTokenLogprobs, true)
    assert.equal(body.strictReady, true, "a fully conforming short answer is strict-ready")

    server.enqueueBody({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "<score_A> K </score_A>" + LF + "<score_B> M </score_B>" } }] })
    res = fakeRes()
    await probeRoute.handler(fakeReq({}), res)
    body = JSON.parse(res.bodyText)
    assert.equal(body.strictReady, false, "tags without token logprobs are not strict-ready")
    assert.equal(body.scoreTokenLogprobs, false)
    assert.equal(body.errorCode, "missing_score_logprobs", "the precise protocol code surfaces")

    // Upstream fault: transient retry fires once inside the production path,
    // then the final transport state is surfaced instead of masked.
    server.enqueue(() => Promise.resolve({ ok: false, status: 503, json: async () => ({ error: { message: "relay hiccup" } }) }))
    server.enqueue(() => Promise.resolve({ ok: false, status: 500, json: async () => ({ error: { message: "still down" } }) }))
    res = fakeRes()
    await probeRoute.handler(fakeReq({}), res)
    body = JSON.parse(res.bodyText)
    assert.equal(body.transportOk, false)
    assert.equal(body.httpStatus, 500)
    assert.equal(body.errorCode, "provider_error")
    assert.equal(body.strictReady, false)

    assert.ok(server.calls.length >= 3 && String(server.calls[0].init.body).includes("verifier lane"), "the probe rides the production lane request shape (redaction + lane instruction included)")
  } finally { server.restore() }
})

test("phase2: /records queries full history with filters while /state stays a recent view", async () => {
  const { VerifierHost, apiRoutes } = await import("../../lib/index.js")
  const server = mockLaneServer()
  try {
    for (let i = 0; i < 35; i += 1) server.enqueueBody(laneSuccessBody())
    const ctx = fakeContext()
    const host = new VerifierHost(ctx, hostOverrides())
    host.start()
    const agent = ctx.spawnAgent(fakeAgent("sess-R", completedTurnEvents(1)))
    ctx.emit("agent/created", { agent })
    let events = []
    for (let turn = 1; turn <= 35; turn += 1) {
      events = events.concat(completedTurnEvents(turn))
      agent.session.events = events
      fireIdle(agent)
      await quiesce(12)
    }
    await quiesce(80)

    const recordsRoute = apiRoutes(host).find(route => route.path.endsWith("/records"))
    assert.ok(recordsRoute, "/records query endpoint exists")
    const query = async querystring => {
      const res = fakeRes()
      await recordsRoute.handler(fakeReq({}, "/records" + querystring, "GET"), res)
      return JSON.parse(res.bodyText)
    }

    const all = await query("?limit=500")
    assert.ok(all.total >= 35, "history keeps every finished record, not just the newest handful")
    assert.ok(host.snapshot().records.length <= 20, "/state remains a bounded recent view")

    const bySession = await query("?sessionId=sess-R&limit=500")
    assert.equal(bySession.total, all.total, "session filter matches every run of that session")
    assert.ok(bySession.records.every(record => record.sessionId === "sess-R"))

    const byTurn = await query("?turn=7")
    assert.equal(byTurn.total, 1)
    assert.equal(byTurn.records[0].turn, 7)

    const emptyTurn = await query("?turn=")
    assert.equal(emptyTurn.total, all.total, "an empty turn filter must behave as no filter, not turn zero")

    const emptyLimit = await query("?turn=&limit=")
    assert.equal(emptyLimit.limit, 50, "an empty limit falls back to the default page size of 50")
    assert.equal(emptyLimit.records.length, Math.min(50, all.total), "the defaulted page still slices correctly")
    const noParams = await query("")
    assert.equal(noParams.limit, 50, "an absent limit uses the same default of 50")
    assert.equal(noParams.records.length, Math.min(50, noParams.total))

    const byStatus = await query("?status=completed&limit=500")
    assert.equal(byStatus.total, all.total, "all fixture runs complete")
    assert.ok(byStatus.records.every(record => record.status === "completed"))

    const limited = await query("?limit=2")
    assert.equal(limited.records.length, 2, "limit caps the page but not the reported total")
    assert.equal(limited.total, all.total)

    const none = await query("?sessionId=nobody")
    assert.equal(none.total, 0)
    assert.deepEqual(none.records, [])
  } finally { server.restore() }
})

test("phase2b: DSH_VA_API_TOKEN gates mutating endpoints while reads stay open", async () => {
  const { API_PREFIX, VerifierHost, apiRoutes } = await import("../../lib/index.js")
  process.env.DSH_VA_API_TOKEN = "secret-token"
  try {
    const host = new VerifierHost(fakeContext(), hostOverrides())
    const routeList = apiRoutes(host)
    assert.ok(routeList.every(route => route.path.startsWith(API_PREFIX + "/")), "every server route is rooted at the shared protocol prefix")
    const evalRoute = routeList.find(route => route.path.endsWith("/eval"))
    const recordsRoute = routeList.find(route => route.path.endsWith("/records"))
    let res = fakeRes()
    await evalRoute.handler(fakeReq({ problem: "p", trace: "" }), res)
    assert.equal(res.status, 403, "mutating endpoint rejects unauthenticated callers when a token is configured")

    res = fakeRes()
    await evalRoute.handler({ ...fakeReq({ problem: "p", trace: "" }), headers: { "content-type": "application/json", authorization: "Bearer secret-token" } }, res)
    assert.equal(res.status, 400, "authorized caller proceeds to normal validation (empty trace)")

    res = fakeRes()
    await recordsRoute.handler(fakeReq({}, "/records", "GET"), res)
    assert.equal(res.status, 200, "read-only views stay open to local operators")
  } finally { delete process.env.DSH_VA_API_TOKEN }
})

test("rate limiter: sliding window admits the cap, never a boundary burst, and ages stamps out", async () => {
  const { createRateLimiter } = await import("../../lib/index.js")
  let t = 100000
  const limiter = createRateLimiter(2, 100, () => t)
  assert.equal(limiter(), true)
  assert.equal(limiter(), true)
  assert.equal(limiter(), false, "cap reached")
  t = 100099
  assert.equal(limiter(), false, "99% into the window: a fixed window would reset at the boundary — sliding must not")
  t = 100100
  // Both initial stamps (t=100000) age out together here, so up to two fresh
  // stamps fit — but never MORE than two inside ANY 100-wide window, which is
  // exactly the boundary-burst property a fixed window lacks.
  assert.equal(limiter(), true)
  assert.equal(limiter(), true)
  assert.equal(limiter(), false, "window full again — never more than the cap in any window")
  t = 100199
  assert.equal(limiter.peek(), false)
  assert.equal(limiter.peek(), false, "rejected peeks and 429s never consume")
  t = 100200
  assert.equal(limiter.peek(), true, "stamps age out as the window slides")
  limiter.commit()
  limiter.commit()
  assert.equal(limiter.peek(), false, "commits occupy the window")
})

test("api: selection lifecycle routes answer 400 for non-object bodies and a redacted 500 for cleanup failures", async () => {
  const { host } = mkSelectionHost()
  try {
    const routes = apiRoutes(host)
    for (const suffix of ["/selections/cancel", "/selections/release", "/selections/discard"]) {
      const route = routes.find((r) => r.path.endsWith(suffix))
      for (const body of [null, [], "sel-x"]) {
        const res = fakeRes()
        await route.handler(fakeReq(body), res)
        assert.equal(res.status, 400, suffix + " rejects " + JSON.stringify(body))
        assert.equal(JSON.parse(res.bodyText).error, "json-object-required")
      }
      const missing = fakeRes()
      await route.handler(fakeReq({}), missing)
      assert.equal(missing.status, 400)
      assert.equal(JSON.parse(missing.bodyText).error, "selection-id-required")
    }
    host.selections.discardWinner = async () => { throw new Error("workspace-worktree-prune-failed: token=sk-abcdefghijklmnopqrstuvwxyz0123") }
    const failed = fakeRes()
    await routes.find((r) => r.path.endsWith("/selections/discard")).handler(fakeReq({ selectionId: "sel-x" }), failed)
    assert.equal(failed.status, 500, "a cleanup failure is a JSON 500, not an unhandled rejection in the web server")
    const body = JSON.parse(failed.bodyText)
    assert.equal(body.ok, false)
    assert.ok(body.error.includes("workspace-worktree-prune-failed"), "the operator still sees the reason")
    assert.ok(!body.error.includes("sk-abcdefghijklmnopqrstuvwxyz0123"), "secrets never leave through the error channel")
  } finally { await host.selections.dispose() }
})

test("api: /eval stops the lane fan-out when the client disconnects", async () => {
  const { VerifierHost, apiRoutes } = await import("../../lib/index.js")
  const server = mockLaneServer()
  const gate = deferred()
  try {
    const host = new VerifierHost(fakeContext(), hostOverrides())
    const evalRoute = apiRoutes(host).find((route) => route.path.endsWith("/eval"))
    server.enqueue((call) => gatedLane(call, gate))
    const res = disconnectableRes()
    const pending = evalRoute.handler(fakeReq({ problem: "p", trace: "valid trace" }), res)
    await waitFor(() => server.calls.length === 1)
    assert.ok(server.calls[0].init.signal, "the lane request carries an abort signal")
    assert.equal(server.calls[0].init.signal.aborted, false)
    res.disconnect()
    const outcome = await Promise.race([
      pending.then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("still-running"), 1500)),
    ])
    assert.equal(outcome, "settled", "the handler settles once the client is gone, without waiting for the provider")
    assert.equal(server.calls[0].init.signal.aborted, true, "the in-flight provider request is aborted with the client")
    assert.equal(server.calls.length, 1, "an aborted lane is not retried")
    assert.equal(res.status, 0, "nothing is written to a connection nobody is reading")
  } finally {
    gate.resolve()
    server.restore()
  }
})

test("api: every unexpected failure leaves through one redacted, bounded 500; /config rejects bad JSON with the shared code", async () => {
  const { host } = mkSelectionHost()
  try {
    const routes = apiRoutes(host)
    const secret = "sk-abcdefghijklmnopqrstuvwxyz0123"
    const loud = "upstream said " + secret + " " + "x".repeat(1000)
    const expectRedacted = (res, label) => {
      assert.equal(res.status, 500, label + " is a JSON 500")
      const body = JSON.parse(res.bodyText)
      assert.equal(body.ok, false)
      assert.ok(body.error.includes("upstream said"), label + " keeps the reason")
      assert.ok(!body.error.includes(secret), label + " never leaks a key")
      assert.ok(body.error.length <= 240, label + " is bounded (" + body.error.length + ")")
    }
    host.verifySession = async () => { throw new Error(loud) }
    const verify = fakeRes()
    await routes.find((route) => route.path.endsWith("/verify")).handler(fakeReq({ sessionId: "sess-A" }), verify)
    expectRedacted(verify, "/verify")
    const originalGetConfig = host.getConfig.bind(host)
    host.getConfig = () => { throw new Error(loud) }
    const evalRes = fakeRes()
    await routes.find((route) => route.path.endsWith("/eval")).handler(fakeReq({ problem: "p", trace: "valid trace" }), evalRes)
    expectRedacted(evalRes, "/eval")
    const probeRes = fakeRes()
    await routes.find((route) => route.path.endsWith("/probe")).handler(fakeReq({}), probeRes)
    expectRedacted(probeRes, "/probe")
    host.getConfig = originalGetConfig
    const badJson = { ...fakeReq({}), [Symbol.asyncIterator]: async function* () { yield Buffer.from("{not json") } }
    const configRes = fakeRes()
    await routes.find((route) => route.path.endsWith("/config")).handler(badJson, configRes)
    assert.equal(configRes.status, 400)
    assert.equal(JSON.parse(configRes.bodyText).error, "invalid-json-body", "/config speaks the same malformed-body code as every other route")
  } finally { await host.selections.dispose() }
})
