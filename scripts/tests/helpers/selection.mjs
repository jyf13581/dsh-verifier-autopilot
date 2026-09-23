// Best-of-N doubles: fake candidate factories, scripted bridges, real workspaces
// under a temp root, the check-shell probe, and a SelectionHost builder.
// Shared by scripts/tests/*.test.mjs; import what you use, every export is a
// plain function or value with no registration side effects.

import { VerifierHost } from "../../../lib/index.js"
import { resolveCheckShell } from "../../../lib/selection/checks.js"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fakeContext, hostOverrides, fakeAgent, completedTurnEvents } from "./host.mjs"

// One temp root per test process for fake and real candidate workspaces;
// removed at exit so a run leaves nothing behind in the OS temp directory.
export const SEL_TMP = mkdtempSync(path.join(tmpdir(), "va-sel-"))
process.on("exit", () => { try { rmSync(SEL_TMP, { recursive: true, force: true }) } catch { /* best effort */ } })

export function fakeEvents(i) {
  return [
    { type: "user/message", seq: 0, data: { content: [{ type: "text", text: "task for candidate " + i }], source: { kind: "user" } } },
    { type: "turn/start", seq: 1, data: { turn: 1 } },
    { type: "tool/call", seq: 2, data: { turn: 1, step: 1, name: "write", arguments: { file: "out" + i + ".txt" } } },
    { type: "tool/result", seq: 3, data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "written ok " + i }] } } },
    { type: "assistant/message", seq: 4, data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "done " + i }] } } },
    { type: "turn/end", seq: 5, data: { turn: 1, reason: { kind: "completed" } } },
  ]
}

export function makeFakeFactory(opts = {}) {
  const calls = []
  const handles = []
  return {
    calls,
    handles,
    async create(spec) {
      const i = calls.length
      calls.push(spec)
      if (opts.failAt && opts.failAt.includes(i)) throw new Error("create-fail-" + i)
      if (opts.passAt && opts.passAt.includes(i)) writeFileSync(path.join(spec.cwd, "pass.txt"), "ready")
      const script = (opts.scripts && opts.scripts[i]) || {}
      const agent = {
        id: spec.sessionId,
        session: { events: (script.initEvents ?? []).slice() },
        followups: [],
        cancelled: false,
        _release: null,
        followup(m) { agent.followups.push(m) },
        whenIdle() {
          // The runtime re-mints the seed prefix as seq 0..seedLength-1 with
          // the candidate's own rollout AFTER it. Default fake events are the
          // own-rollout part, so they are offset past the seed; script events
          // own their exact seq values (some tests bake the seed in by hand).
          const own = (events) => events.map((ev) => (typeof ev.seq === "number" ? { ...ev, seq: ev.seq + (spec.seedLength ?? 0) } : ev))
          if (script.hang) {
            // A live hung agent still accrues events mid-flight (partial
            // progress visible to anyone watching): the abandonment monitor
            // reads exactly this region.
            if (script.partial) agent.session = { events: agent.session.events.concat(own(fakeEvents(i))) }
            return new Promise((resolve) => { agent._release = resolve })
          }
          return new Promise((resolve) => setTimeout(() => {
            agent.session = { events: script.events ? script.events : own(fakeEvents(i)) }
            resolve()
          }, script.idleDelay ?? 5))
        },
        cancel() { agent.cancelled = true; if (agent._release) agent._release() },
      }
      const handle = { agent, disposed: false, async dispose() { handle.disposed = true } }
      handles.push(handle)
      return handle
    },
  }
}

export const realWorkspaces = {
  async prepare(sel) {
    const dir = path.join(SEL_TMP, sel.selectionId, "c" + sel.index)
    mkdirSync(dir, { recursive: true })
    return dir
  },
  async remove(dir) {
    rmSync(dir, { recursive: true, force: true })
  },
}

export function fakeBridge(impl) {
  const calls = []
  return {
    calls,
    async select(req) {
      calls.push(req)
      if (impl) return impl(req)
      // Decisive default: margin 0.5 clears the provisional 0.03 noise gate,
      // so plumbing tests keep exercising the ranked_winner path.
      return { index: 0, bestPreview: String(req.candidates[0]).slice(0, 50), scores: req.candidates.map((_, i) => (i === 0 ? 0.9 : 0.4)), ranking: req.candidates.map((_, i) => i), nComparisons: req.candidates.length, criteria: ["c1"], usage: { calls: 1, input_tokens: 1, cached_input_tokens: 0, uncached_input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, cache_hit_rate: 0 } }
    },
  }
}

export const selInput = (over = {}) => ({
  problem: "fix the thing",
  candidateCount: 3,
  workspaceRoot: SEL_TMP,
  sourceSessionId: "session-src",
  criteria: { c1: "did it actually fix the thing with evidence" },
  verifier: { model: "m", baseUrl: "http://127.0.0.1:9/v1", apiKey: "dummy" },
  ...over,
})

// The check harness resolves one shell per process (pwsh wherever it is
// installed, otherwise the platform shell). Check fixtures are written in
// whichever dialect won, so this suite runs the same on a pwsh-less Linux
// runner and a Windows dev box.
export const CHECK_SHELL = (await resolveCheckShell()).shell

export const CHECK_DIALECT = CHECK_SHELL?.name === "sh" ? "sh" : "pwsh"

export const PASS_CHECK = [{
  name: "marker",
  command: CHECK_DIALECT === "sh" ? "test -f ./pass.txt || exit 3" : "if (Test-Path ./pass.txt) { exit 0 } else { exit 3 }",
  timeoutMs: 20000,
}]

export const SLOW_CHECK_COMMAND = CHECK_DIALECT === "sh" ? "sleep 30" : "Start-Sleep -Seconds 30"

export function mkSelectionHost(over = {}) {
  const ctx = fakeContext()
  if (over.defaultRoute !== null) ctx.setService("agentDefaultModel", { currentSelection: () => over.defaultRoute ?? { provider: "kimi", model: "kimi-k3" } })
  const factory = makeFakeFactory(over.factoryOpts ?? {})
  const bridge = fakeBridge(over.bridgeImpl)
  const host = new VerifierHost(ctx, hostOverrides(over.config ?? {}), {
    selectionsTesting: { factory, workspaces: realWorkspaces, bridge },
  })
  const source = ctx.spawnAgent(fakeAgent("sess-A", completedTurnEvents(1)))
  return { ctx, host, factory, bridge, source }
}

export const settledRecord = (selectionId, startedAt, extra = {}) => ({
  selectionId, sourceSessionId: null, startedAt, finishedAt: startedAt + 1, status: "completed", candidates: [], ...extra,
})
