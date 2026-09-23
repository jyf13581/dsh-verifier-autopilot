// A fake DSH context for VerifierHost tests: agents, scoped hooks, idle signals,
// the lane server, and request/response doubles.
// Shared by scripts/tests/*.test.mjs; import what you use, every export is a
// plain function or value with no registration side effects.

import { LF } from "./harness.mjs"
import { scorePositions } from "./provider.mjs"

export function fakeAgent(id, events) {
  const handlers = new Map()
  const agent = {
    id,
    session: { events },
    handlers,
    followups: [],
    async followup(message) { agent.followups.push(message) },
    ctx: {
      on(name, handler) {
        const list = handlers.get(name) ?? []
        list.push(handler)
        handlers.set(name, list)
        return () => handlers.set(name, (handlers.get(name) ?? []).filter(item => item !== handler))
      },
    },
  }
  return agent
}

export function fakeContext() {
  const agentsMap = new Map()
  const contextHandlers = new Map()
  const services = new Map()
  const ctx = {
    agents: { list: () => [...agentsMap.values()], get: id => agentsMap.get(id) },
    get(name) { return services.get(name) },
    setService(name, svc) { services.set(name, svc) },
    credentials: { resolve: async () => ({ value: "mock-key" }) },
    effect() {},
    webServer: { register: () => () => undefined },
    on(name, handler) {
      const list = contextHandlers.get(name) ?? []
      list.push(handler)
      contextHandlers.set(name, list)
      return () => contextHandlers.set(name, (contextHandlers.get(name) ?? []).filter(item => item !== handler))
    },
  }
  ctx.emit = (name, payload) => { for (const handler of [...(contextHandlers.get(name) ?? [])]) handler(payload) }
  ctx.spawnAgent = agent => { agentsMap.set(String(agent.id), agent); return agent }
  return ctx
}

export function fireIdle(agent) {
  for (const handler of agent.handlers.get("agent/status") ?? []) handler({ status: "idle" })
}

export function hostOverrides(overrides = {}) {
  return {
    enabled: true, autoFeedback: true, routes: 1, scoreThreshold: 0.62, disagreementThreshold: 0.12,
    maxFeedbackPerSession: 1, timeoutMs: 90000, maxTokens: 512, temperature: 0.2,
    baseURL: "http://mock.local/v1", model: "mock", apiKeyEnv: "TEST_KEY", verifierEffort: "max",
    allowLabelFallback: false, divergenceGuard: true, divergenceGuardMedian: 0.75,
    skipStatusContinuation: true, selectionNotify: true,
    selectionMode: "auto", selectionModelStrategy: "quality-first", selectionProvider: "kimi",
    selectionModels: "minimaxai/minimax-m3,nvidia/nemotron-3-super-120b-a12b,nemotron-3-ultra-550b-a55b,kimi-k3,deepseek-ai/deepseek-v4-pro-0813",
    selectionStandardCandidates: 2, selectionDeepCandidates: 3, selectionEvaluations: 2, selectionPivots: 2,
    selectionCandidateTimeoutMs: 30000, selectionSelectTimeoutMs: 30000, selectionMarginThreshold: 0.03, selectionProbeEnabled: false,
    selectionVerifierWorkers: 0, verifierMinIntervalMs: 0, verifierSmallModel: "",
    ...overrides,
  }
}

/** Deterministic single-lane provider: every fetch must claim a pre-queued
 *  responder, and simultaneous lane requests are counted so serialization
 *  guarantees are observable without timing heuristics. */
export function mockLaneServer() {
  const original = globalThis.fetch
  const waiters = []
  const server = { calls: [], maxInFlight: 0, restore: () => { globalThis.fetch = original } }
  let inFlight = 0
  server.enqueue = responder => waiters.push(responder)
  server.enqueueBody = body => server.enqueue(() => ({ ok: true, status: 200, json: async () => body }))
  globalThis.fetch = async (url, init) => {
    const responder = waiters.shift()
    if (!responder) throw new Error("unexpected lane request: " + String(url))
    const call = { url, init }
    server.calls.push(call)
    inFlight += 1
    server.maxInFlight = Math.max(server.maxInFlight, inFlight)
    try { return await responder(call) } finally { inFlight -= 1 }
  }
  return server
}

export function laneSuccessBody() {
  return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: ["Analysis.", "finding: no concrete defect found", "<score_A> A </score_A>", "<score_B> B </score_B>"].join(LF) }, logprobs: { content: scorePositions() } }] }
}

/** Responder helper: settles with the wrapped body but rejects early when the
 *  run's abort signal fires, mirroring real fetch cancellation. */
export function gatedLane(call, gate, maker = laneSuccessBody) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("This operation was aborted"))
    if (call.init?.signal) call.init.signal.addEventListener("abort", onAbort, { once: true })
    gate.promise.then(() => resolve({ ok: true, status: 200, json: async () => maker() }), reject)
  })
}

export function completedTurnEvents(turn, problem = "Build the widget.") {
  const base = (turn - 1) * 100
  return [
    { type: "turn/start", seq: base + 1, data: { turn } },
    { type: "user/message", seq: base + 2, data: { source: { kind: "user" }, turn, content: problem } },
    { type: "tool/result", seq: base + 3, data: { turn, message: "pwsh npm test -> tests 5 passed" } },
    { type: "assistant/message", seq: base + 4, data: { turn, content: "Done." } },
    { type: "turn/end", seq: base + 5, data: { turn } },
  ]
}

/** Minimal async-iterable request stub for exercising exported API routes. */
export function fakeReq(bodyObj, url = "/", method = "POST") {
  return {
    method,
    url,
    headers: { "content-type": "application/json" },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(bodyObj)) },
  }
}

/** Minimal response sink capturing status + body for route handler tests. */
export function fakeRes() {
  return {
    status: 0,
    bodyText: "",
    headers: null,
    writeHead(code, headerMap) { this.status = code; this.headers = headerMap },
    end(text) { this.bodyText = String(text ?? "") },
    once() {},
  }
}
