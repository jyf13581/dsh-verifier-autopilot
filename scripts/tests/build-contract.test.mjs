// Review R6: build and release chain, DSH contract, defaults, and input types.
// See docs/reviews/R6-ARCHITECTURE-BUILD.md.
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import vm from "node:vm"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { apiRoutes } from "../../lib/index.js"
import { DEFAULT_CONFIG } from "../../lib/config.js"
import * as C from "../../lib/constants.js"
import { SelectionRunner, CANCEL_CANDIDATE_TIMEOUT, CANCEL_PROGRESS_GUARD } from "../../lib/selection/candidates.js"
import { normalizeSelectionTimeoutMs, normalizeCandidateTimeoutMs } from "../../lib/selection/host.js"
import { fakeReq, fakeRes } from "./helpers/host.mjs"
import { fakeBridge, makeFakeFactory, mkSelectionHost, realWorkspaces, selInput } from "./helpers/selection.mjs"
import { esbuildClientOptions, PLUGIN_ID } from "../client-bundle.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

// DSH's AgentCancelCause (dsh-session types.d.ts), exactly the variants
// dsh-agent-loop's abortedCancelCause() accepts; anything else reaches its
// assertNever and throws "unreachable variant" (agent-loop >= 0.1.7-rc.1).
const isAgentCancelCause = (c) => c !== null && typeof c === "object"
  && (["user", "parent", "disposed"].includes(c.kind) || (c.kind === "hook" && typeof c.reason === "string"))

function recordingFactory(opts) {
  const base = makeFakeFactory(opts)
  const causes = []
  return {
    causes,
    base,
    async create(spec) {
      const handle = await base.create(spec)
      const original = handle.agent.cancel
      handle.agent.cancel = (...args) => { causes.push(args); original() }
      return handle
    },
  }
}

test("R6 6.6: a candidate timeout cancels the DSH agent with a cause DSH's agent loop can map", async () => {
  const factory = recordingFactory({ scripts: [{ hang: true }] })
  const runner = new SelectionRunner({ factory, workspaces: realWorkspaces, bridge: fakeBridge() })
  await runner.run(selInput({ candidateCount: 1, candidateTimeoutMs: 60 }))
  assert.equal(factory.causes.length, 1, "the timeout cancelled the candidate once")
  const [cause] = factory.causes[0]
  assert.ok(isAgentCancelCause(cause), "old code: cancel() with no cause -> agent-loop's abortedCancelCause threw 'unreachable variant: {}' as the turn ended; got " + JSON.stringify(cause))
  assert.deepEqual(cause, CANCEL_CANDIDATE_TIMEOUT)
})

test("R6 6.6: a progress-guard abandonment cancels with a cause too", async () => {
  const factory = recordingFactory({ scripts: [{ hang: true, partial: true }] })
  const bridge = fakeBridge()
  bridge.progress = async () => ({ score: 0, usage: {} })
  const runner = new SelectionRunner({ factory, workspaces: realWorkspaces, bridge })
  await runner.run(selInput({ candidateCount: 1, candidateTimeoutMs: 30_000, progressGuard: { intervalMs: 1000, graceChecks: 2, maxChecks: 4 } }))
  assert.equal(factory.causes.length, 1, "the guard abandoned the hopeless rollout")
  assert.ok(isAgentCancelCause(factory.causes[0][0]), JSON.stringify(factory.causes[0]))
  assert.deepEqual(factory.causes[0][0], CANCEL_PROGRESS_GUARD)
})

// Loads a client bundle the way DSH's web runtime does: the script runs, it
// calls window.__ModuleLoader__.load(), and the loader invokes the factory
// LATER, here after a neighbouring plugin script has executed. Returns the
// factories' results and what the script left in page scope.
function loadDeferred(code) {
  const loads = []
  const window = { __ModuleLoader__: { load: (entry) => loads.push(entry) }, localStorage: { getItem: () => null, setItem() {} } }
  const context = vm.createContext({ window, console })
  vm.runInContext(code, context)
  const leaked = ["module", "exports"].filter((name) => Object.prototype.hasOwnProperty.call(context, name))
  vm.runInContext("var module = { exports: { neighbour: true } }; var exports = module.exports;", context)
  const react = { createElement: (...args) => ({ args }), useEffect() {}, useState: (v) => [v, () => {}] }
  const modules = loads.map(({ id, factory }) => ({ id, exports: factory((name) => {
    if (name === "react") return react
    throw new Error("unexpected runtime require: " + name)
  }) }))
  modules.leaked = leaked
  return modules
}

function registrations(exports) {
  const slots = []
  const ctx = {
    get: () => ({ bind: () => ({ get: () => undefined, set() {} }) }),
    slots: { inject: (_name, fn) => fn(), register: (meta) => { slots.push({ name: meta.name, id: meta.id }); return () => {} } },
  }
  exports.apply(ctx)
  return slots
}

test("R6 6.2: the installed-path bundle and the CI bundle load and register the same way under a deferred loader", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "r6-bundle-"))
  try {
    const out = path.join(dir, "client.js")
    await build({ ...esbuildClientOptions(out), absWorkingDir: ROOT, logLevel: "silent" })
    const variants = {
      "build:client (tsdown, CI)": readFileSync(path.join(ROOT, "lib", "client.js"), "utf8"),
      "build.sh fallback (esbuild)": readFileSync(out, "utf8"),
    }
    const seen = {}
    for (const [label, code] of Object.entries(variants)) {
      const loaded = loadDeferred(code)
      assert.equal(loaded.length, 1, label + ": one module registered")
      assert.equal(loaded[0].id, PLUGIN_ID, label)
      assert.equal(typeof loaded[0].exports.apply, "function", label + ": factory returned this plugin's exports, not the neighbour's")
      assert.deepEqual(loaded.leaked, [], label + ": the CommonJS shim stays inside the factory (no page globals)")
      // JSON: the array comes from the vm realm, so deepEqual would compare prototypes.
      assert.equal(JSON.stringify(loaded[0].exports.inject), JSON.stringify(["slots", "sessions", "settingsScope"]), label)
      seen[label] = JSON.parse(JSON.stringify(registrations(loaded[0].exports)))
    }
    const [a, b] = Object.values(seen)
    assert.deepEqual(b, a, "both build paths register identical slots")
    assert.equal(a.length, 3)

    // Negative control: the pre-R6 build.sh wrapper put the CommonJS shim at
    // script top level. esbuild's output still returns the right exports
    // (each factory assigns module.exports and returns it synchronously), but
    // `module` and `exports` become page globals that any later UMD-style
    // script would mistake for a CommonJS environment.
    const legacy = { ...esbuildClientOptions(path.join(dir, "legacy.js")), absWorkingDir: ROOT, logLevel: "silent",
      banner: { js: "var module = { exports: {} }; var exports = module.exports; window.__ModuleLoader__.load({ id: " + JSON.stringify(PLUGIN_ID) + ", factory: (require) => {" } }
    await build(legacy)
    const old = loadDeferred(readFileSync(path.join(dir, "legacy.js"), "utf8"))
    assert.deepEqual(old.leaked, ["module", "exports"], "the old wrapper declared page globals")
    assert.equal(typeof old[0].exports.apply, "function", "but still returned its own exports (no cross-plugin mix-up)")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("R6 6.2: build.sh delegates to the CI build and bundles its fallback from the shared spec", () => {
  const script = readFileSync(path.join(ROOT, "scripts", "build.sh"), "utf8")
  assert.match(script, /npm run -s build:host\n\s*npm run -s build:client/, "the lockfile path runs exactly CI's two commands")
  assert.match(script, /esbuildClientOptions\('lib\/client\.js'\)/, "the fallback bundles from scripts/client-bundle.mjs")
  assert.doesNotMatch(script, /external:\s*\[/, "no private externals list")
  assert.match(script, /\[ ! -L "node_modules\/\$name" \]/, "link_dep leaves npm-installed packages alone")
  const tsdown = readFileSync(path.join(ROOT, "tsdown.config.ts"), "utf8")
  assert.match(tsdown, /from '\.\/scripts\/client-bundle\.mjs'/)
})

test("R6 6.3: every internal fallback equals the config default (K, P, both timeouts)", async () => {
  assert.equal(DEFAULT_CONFIG.selectionEvaluations, C.DEFAULT_SELECTION_EVALUATIONS)
  assert.equal(DEFAULT_CONFIG.selectionPivots, C.DEFAULT_SELECTION_PIVOTS)
  assert.equal(DEFAULT_CONFIG.selectionSelectTimeoutMs, C.DEFAULT_SELECTION_TIMEOUT_MS)
  assert.equal(DEFAULT_CONFIG.selectionCandidateTimeoutMs, C.DEFAULT_CANDIDATE_TIMEOUT_MS)
  assert.equal(normalizeSelectionTimeoutMs(undefined), DEFAULT_CONFIG.selectionSelectTimeoutMs, "old code: an embedder without a Host default got 180 s against the config's 600 s")
  assert.equal(normalizeCandidateTimeoutMs(null, undefined), undefined, "null is absent: the runner applies DEFAULT_CANDIDATE_TIMEOUT_MS")
  // The runner with nothing passed (embedded host without config defaults).
  const bridge = fakeBridge()
  const runner = new SelectionRunner({ factory: makeFakeFactory(), workspaces: realWorkspaces, bridge })
  await runner.run(selInput({ candidateCount: 2 }))
  assert.equal(bridge.calls.length, 1, "two distinct candidates reach ranking")
  assert.equal(bridge.calls[0].nEvaluations, DEFAULT_CONFIG.selectionEvaluations)
  assert.equal(bridge.calls[0].pivots, DEFAULT_CONFIG.selectionPivots, "old code: runner fell back to P=1 against the config's 0")
})

test("R6 6.4: non-numeric K/P/timeouts are refused with 400 before any candidate agent is created", async () => {
  const bad = [["nEvaluations", "abc"], ["nEvaluations", {}], ["pivots", "x"], ["selectTimeoutMs", "soon"], ["candidateTimeoutMs", "later"], ["nEvaluations", "3"]]
  for (const [field, value] of bad) {
    const h = mkSelectionHost()
    try {
      const select = apiRoutes(h.host).find((r) => r.path.endsWith("/select"))
      const res = fakeRes()
      await select.handler(fakeReq({ sourceSessionId: "sess-A", candidateCount: 2, [field]: value }), res)
      assert.equal(res.status, 400, field + "=" + JSON.stringify(value) + " -> " + res.status + " " + res.bodyText.slice(0, 120) + " (old code: 202, NaN reached the verifier after the candidates ran)")
      assert.equal(JSON.parse(res.bodyText).error, "numeric-field-invalid")
      assert.equal(h.factory.calls.length, 0, "no candidate spend")
    } finally { await h.host.dispose().catch(() => {}) }
  }
  // Absent and null still mean "use the default".
  const h = mkSelectionHost()
  try {
    const select = apiRoutes(h.host).find((r) => r.path.endsWith("/select"))
    const res = fakeRes()
    await select.handler(fakeReq({ sourceSessionId: "sess-A", candidateCount: 2, nEvaluations: null, selectTimeoutMs: null }), res)
    assert.equal(res.status, 202, res.bodyText)
  } finally { await h.host.dispose().catch(() => {}) }
})

test("R6 6.6: the DSH contract check is wired into the scripts and CI", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"))
  assert.equal(pkg.scripts["check:contract"], "tsc -p scripts/contract/tsconfig.json")
  const ci = readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8")
  assert.match(ci, /npm run check:contract/)
  assert.match(ci, /DSH_BUILD_FORCE_INSTALLED=1/, "CI exercises build.sh's installed-runtime fallback")
})
