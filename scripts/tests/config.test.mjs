// Configuration: settings-source synchronisation into the live Host, and the
// schema-derived patch validator that bounds every /config write.
//
// Part of the offline regression suite: `npm test` runs every scripts/tests/*.test.mjs
// in its own process; this file also runs alone with `node --test scripts/tests/config.test.mjs`.

import test from "node:test"
import assert from "node:assert/strict"
import { createSettingsSourceHooks, VerifierHost, apiRoutes } from "../../lib/index.js"
import { fakeContext, fakeReq, fakeRes, hostOverrides } from "./helpers/host.mjs"
import { mkSelectionHost } from "./helpers/selection.mjs"

test("settings source changes refresh the live Host configuration", () => {
  const applied = []
  const hooks = createSettingsSourceHooks({ replaceConfig(next) { applied.push(next) } })
  const first = { enabled: false, model: "deepseek-chat" }
  const second = { enabled: true, model: "kimi-k3" }
  hooks.setSource(() => first)
  assert.equal(applied.length, 0, "setSource only replaces the authoritative source")
  hooks.onChange()
  assert.equal(applied.at(-1), first)
  hooks.setSource(() => second)
  hooks.onChange()
  assert.equal(applied.at(-1), second, "every committed settings change reaches the live Host")
  assert.equal(applied.length, 2)
})

test("phase1: config rejects non-http(s) or credentialed baseURL values", async () => {
  const { VerifierHost } = await import("../../lib/index.js")
  const ctx = fakeContext()
  const host = new VerifierHost(ctx, hostOverrides())
  host.start()
  // Note: WHATWG parsing normalizes 'http:///v1' to host 'v1', which is a
  // syntactically valid target — scheme/userinfo/host are the policy gates,
  // not slash counts.
  for (const bad of ["ftp://relay.example.com/v1", "https://user:pass@host.example.com/v1", "not a url"]) {
    assert.throws(() => host.setConfig({ baseURL: bad }), /baseURL/, "must reject: " + bad)
  }
  host.setConfig({ baseURL: "https://api.example.com/v1" })
  assert.equal(host.getConfig().baseURL, "https://api.example.com/v1")
})

test("phase2b: model and apiKeyEnv config values are sanity-constrained", async () => {
  const { Config, DEFAULT_CONFIG, VerifierHost } = await import("../../lib/index.js")
  assert.deepEqual(Config({}), DEFAULT_CONFIG, "the exported defaults are derived from the schema, not a second handwritten table")
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), true)
  const initial = hostOverrides()
  const host = new VerifierHost(fakeContext(), initial)
  initial.model = "mutated-outside-host"
  assert.notEqual(host.getConfig().model, initial.model, "the Host owns a defensive copy of constructor config")
  const exposed = host.getConfig()
  exposed.model = "mutated-through-getter"
  assert.notEqual(host.getConfig().model, exposed.model, "getConfig never leaks the mutable internal object")
  assert.throws(() => host.setConfig({ model: "bad model\nwith newline" }), /config-invalid-string:model/)
  assert.throws(() => host.setConfig({ model: "m".repeat(301) }), /config-invalid-string:model/)
  assert.throws(() => host.setConfig({ apiKeyEnv: "9bad-name" }), /config-invalid-string:apiKeyEnv/)
  assert.throws(() => host.setConfig({ selectionModelStrategy: "bad-strategy" }), /config-selection-model-strategy-invalid/)
  host.setConfig({ selectionModelStrategy: "exploration" })
  assert.equal(host.getConfig().selectionModelStrategy, "exploration")
  host.setConfig({ model: "nvidia/nemotron-3-super-120b-a12b" })
  host.setConfig({ apiKeyEnv: "KIMI_API_KEY_2" })
  host.setConfig({ baseURL: "  https://api.example.test/v1/  " })
  assert.equal(host.getConfig().baseURL, "https://api.example.test/v1/", "a validated baseURL is stored in the same trimmed form used for request construction")
})

test("phase2b: verifierEffort and tournament pivot/round knobs are validated", () => {
  const host = new VerifierHost(fakeContext(), hostOverrides())
  assert.throws(() => host.setConfig({ verifierEffort: "big" }), /config-verifier-effort-invalid/)
  assert.throws(() => host.setConfig({ verifierEffort: true }), /config-verifier-effort-invalid/)
  assert.throws(() => host.setConfig({ selectionPivots: 9 }), /config-out-of-range:selectionPivots/)
  assert.throws(() => host.setConfig({ selectionPivots: -1 }), /config-out-of-range:selectionPivots/)
  assert.throws(() => host.setConfig({ selectionEvaluations: 9 }), /config-out-of-range:selectionEvaluations/)
  host.setConfig({ verifierEffort: "low" })
  host.setConfig({ selectionPivots: 4 })
  host.setConfig({ selectionEvaluations: 6 })
  assert.equal(host.getConfig().verifierEffort, "low")
  assert.equal(host.getConfig().selectionPivots, 4)
  assert.equal(host.getConfig().selectionEvaluations, 6)
})

test("config API: account-pool execution knobs accept valid values, defaults are auto/off, ranges enforced", async () => {
  const { host } = mkSelectionHost()
  try {
    const defaults = JSON.parse(JSON.stringify(host.getConfig()))
    assert.equal(defaults.selectionVerifierWorkers, 0, "workers default to auto")
    assert.equal(defaults.verifierMinIntervalMs, 0, "smoothing defaults to off")
    assert.equal(defaults.verifierSmallModel, "", "small model defaults to off")

    const routes = apiRoutes(host)
    const configRoute = routes.find((r) => r.path.endsWith("/config"))

    const ok = fakeRes()
    await configRoute.handler(fakeReq({ selectionVerifierWorkers: 8, verifierMinIntervalMs: 500, verifierSmallModel: "small/mock" }), ok)
    assert.equal(ok.status, 200, "valid account-pool knobs are accepted")
    const cfg = JSON.parse(ok.bodyText).config
    assert.equal(cfg.selectionVerifierWorkers, 8)
    assert.equal(cfg.verifierMinIntervalMs, 500)
    assert.equal(cfg.verifierSmallModel, "small/mock")

    for (const [name, patch] of [
      ["selectionVerifierWorkers", { selectionVerifierWorkers: 17 }],
      ["verifierMinIntervalMs", { verifierMinIntervalMs: 60001 }],
      ["verifierSmallModel", { verifierSmallModel: "x".repeat(201) }],
    ]) {
      const bad = fakeRes()
      await configRoute.handler(fakeReq(patch), bad)
      assert.equal(bad.status, 400, `${name} out of range is rejected`)
      assert.ok(String(JSON.parse(bad.bodyText).error).includes(name))
    }

    const badFrac = fakeRes()
    await configRoute.handler(fakeReq({ selectionVerifierWorkers: 1.5 }), badFrac)
    assert.equal(badFrac.status, 400, "non-integer workers rejected")

    const clear = fakeRes()
    await configRoute.handler(fakeReq({ verifierSmallModel: "" }), clear)
    assert.equal(clear.status, 200, "clearing the small model back to '' is accepted")
    assert.equal(JSON.parse(clear.bodyText).config.verifierSmallModel, "")
  } finally { await host.dispose().catch(() => {}) }
})

test("config: API patch validation is derived from the Schemastery schema, so bounds and choices cannot drift", async () => {
  const { Config, validateConfigPatch } = await import("../../lib/index.js")
  const fields = Object.entries(Config.dict)
  assert.ok(fields.length >= 30, "fixture: the whole schema is visible")
  const rejects = (patch, pattern) => assert.throws(() => validateConfigPatch(patch), pattern, JSON.stringify(patch))
  let numbers = 0
  let unions = 0
  let booleans = 0
  for (const [key, field] of fields) {
    if (field.type === "number") {
      numbers += 1
      const { min, max, step } = field.meta
      assert.ok(typeof min === "number" && typeof max === "number", key + ": every numeric knob declares both bounds in the schema")
      assert.deepEqual(validateConfigPatch({ [key]: min }), { [key]: min }, key + " accepts its schema minimum")
      assert.deepEqual(validateConfigPatch({ [key]: max }), { [key]: max }, key + " accepts its schema maximum")
      rejects({ [key]: min - 1 }, new RegExp("config-out-of-range:" + key))
      rejects({ [key]: max + 1 }, new RegExp("config-out-of-range:" + key))
      rejects({ [key]: "1" }, new RegExp("config-number-required:" + key))
      if (typeof step === "number") rejects({ [key]: min + 0.5 }, new RegExp("config-integer-required:" + key))
    } else if (field.type === "union") {
      unions += 1
      for (const option of field.list) assert.deepEqual(validateConfigPatch({ [key]: option.value }), { [key]: option.value })
      rejects({ [key]: "__bogus__" }, /config-.*-invalid/)
      rejects({ [key]: true }, /config-.*-invalid/)
    } else if (field.type === "boolean") {
      booleans += 1
      assert.deepEqual(validateConfigPatch({ [key]: false }), { [key]: false })
      rejects({ [key]: "true" }, new RegExp("config-boolean-required:" + key))
    }
  }
  assert.ok(numbers >= 15 && unions >= 3 && booleans >= 5, "fixture: all three derived kinds were exercised (" + numbers + "/" + unions + "/" + booleans + ")")
  rejects({ selectionMode: "sometimes" }, /^Error: config-selection-mode-invalid$/)
  rejects({ selectionModelStrategy: "random" }, /^Error: config-selection-model-strategy-invalid$/)
  rejects({ verifierEffort: "ultra" }, /^Error: config-verifier-effort-invalid$/)
  rejects({ notAKnob: 1 }, /unknown-config-key:notAKnob/)
})

test("config: cleanConfig is a deprecated identity copy and /state carries the live config without it", async () => {
  const { cleanConfig } = await import("../../lib/index.js")
  const config = hostOverrides({ apiKeyEnv: "SOME_ENV_NAME" })
  const cleaned = cleanConfig(config)
  assert.deepEqual(cleaned, config, "nothing is removed: config never holds credential values, only env names")
  assert.notEqual(cleaned, config, "callers still get their own copy")
  const host = new VerifierHost(fakeContext(), config)
  try {
    const snapshot = host.snapshot().config
    assert.deepEqual(snapshot, config)
    snapshot.model = "tampered"
    assert.equal(host.getConfig().model, config.model, "the snapshot is a copy: consumers cannot mutate the live config")
  } finally { await host.dispose() }
})
