// Preregistered repair-v2 evaluation tooling (eval/repair-v2.mjs): seeded
// scenario generation, constraint non-leakage, and the metrics fixture.
//
// Part of the offline regression suite: `npm test` runs every scripts/tests/*.test.mjs
// in its own process; this file also runs alone with `node --test scripts/tests/repair-v2.test.mjs`.

import test from "node:test"
import assert from "node:assert/strict"

const REPAIR_V2 = "../../eval/repair-v2.mjs"

// ---------- phase 3: repair-v2 preregistration tooling ----------
//
// HANDOFF.md §7.1 preserves the preregistration boundary: metrics precede any live
// experiment. This section locks the deterministic scenario generator and the
// four-metric calculator so the experiment runs on stable ground truth.

test("phase3: scenario generation is seeded, deterministic, and produces the requested mix", async () => {
  const { generateScenarios, parseRepairV2Args } = await import(REPAIR_V2)
  assert.deepEqual(parseRepairV2Args([]), { seed: 7, defect: 20, clean: 10, out: undefined }, "CLI defaults match the preregistered live scenario set")
  assert.deepEqual(parseRepairV2Args(["--seed=11", "--defect=6", "--clean=3", "--out=run.json"]), { seed: 11, defect: 6, clean: 3, out: "run.json" })
  assert.equal(parseRepairV2Args(["--seed=-1", "--defect=0", "--clean=0"]).seed, -1, "all integer seeds accepted by generateScenarios stay CLI-compatible")
  assert.throws(() => parseRepairV2Args(["--out-dir=run.json"]), /unknown-or-malformed-flag/)
  assert.throws(() => parseRepairV2Args(["--seed=not-a-number"]), /flag-seed-integer-required/)
  assert.throws(() => parseRepairV2Args(["--defect=-1"]), /flag-defect-nonnegative-integer-required/)
  const a = generateScenarios({ seed: 11, defectCount: 6, cleanCount: 3 })
  const b = generateScenarios({ seed: 11, defectCount: 6, cleanCount: 3 })
  assert.deepEqual(a, b, "same seed must reproduce byte-identical scenarios")
  assert.equal(a.length, 9)
  assert.equal(a.filter(s => s.kind === "defect").length, 6)
  assert.equal(a.filter(s => s.kind === "clean").length, 3)
  const c = generateScenarios({ seed: 12, defectCount: 6, cleanCount: 3 })
  assert.notDeepEqual(a, c, "different seeds must diverge")
  for (const s of a) {
    assert.ok(s.id && s.problem && s.files && Array.isArray(s.checks) && s.checks.length >= 1, "scenario carries brief, files and checks")
    if (s.kind === "defect") assert.ok(s.plantedFlaw, "defect scenarios declare their planted flaw")
    else assert.equal(s.plantedFlaw, undefined)
  }
})

test("phase3: generated task briefs never leak evaluation constraints", async () => {
  const { generateScenarios } = await import(REPAIR_V2)
  const forbidden = ["测试", "试验", "验证", "评分", "verifier", "预期失败", "禁止运行", "不要运行", "不得运行", "hidden", "trap", "缺陷", "bug planted", "eval"]
  for (const s of generateScenarios({ seed: 3, defectCount: 8, cleanCount: 4 })) {
    for (const word of forbidden) {
      assert.ok(!s.problem.toLowerCase().includes(word.toLowerCase()), `brief "${s.id}" must not leak "${word}"`)
    }
  }
})

test("phase3: defect scenarios carry an initially-failing check; clean ones never do", async () => {
  const { generateScenarios } = await import(REPAIR_V2)
  for (const s of generateScenarios({ seed: 5, defectCount: 6, cleanCount: 4 })) {
    const failing = s.checks.filter(check => check.initial === "fail")
    if (s.kind === "defect") {
      assert.ok(failing.length >= 1, s.id + " must embed at least one initially-failing independent check")
      for (const check of s.checks) assert.ok(check.command.includes("node "), "checks are plain node commands")
    } else {
      assert.equal(failing.length, 0, s.id + " is clean: no check may start failing")
    }
  }
})

test("phase3: computeRepairMetrics matches the hand-computed preregistration fixture", async () => {
  const { computeRepairMetrics } = await import(REPAIR_V2)
  const run = (kind, fields) => ({ kind, ...fields })
  const runs = [
    run("defect", { triggered: true, repaired: true, repairValid: true, regressed: false }),
    run("defect", { triggered: true, repaired: true, repairValid: true, regressed: false }),
    run("defect", { triggered: true, repaired: true, repairValid: false, regressed: true }),
    run("defect", { triggered: true, repaired: false }),
    run("defect", { triggered: false }),
    run("defect", { triggered: false }),
    run("defect", { triggered: false }),
    run("defect", { triggered: false }),
    run("clean", { triggered: true }),
    run("clean", { triggered: false }),
    run("clean", { triggered: false }),
    run("clean", { triggered: false }),
  ]
  const m = computeRepairMetrics(runs)
  assert.equal(m.defectScenarios, 8)
  assert.equal(m.cleanScenarios, 4)
  assert.equal(m.triggers, 4)
  assert.equal(m.triggerRate, 0.5)
  assert.equal(m.nuisanceTriggers, 1)
  assert.equal(m.nuisanceRate, 0.25)
  assert.equal(m.repairsAttempted, 3)
  assert.equal(m.validRepairs, 2)
  assert.equal(m.validRepairRate, 2 / 3)
  assert.equal(m.regressions, 1)
  assert.equal(m.regressionRate, 1 / 3)
})

test("phase3: regression rate excludes clean controls from the defect-repair denominator and numerator", async () => {
  const { computeRepairMetrics } = await import(REPAIR_V2)
  const m = computeRepairMetrics([
    { kind: "defect", repaired: true, regressed: true },
    { kind: "defect", repaired: true, regressed: false },
    { kind: "clean", triggered: true, regressed: true },
    { kind: "clean", regressed: true },
  ])
  assert.equal(m.regressions, 1, "clean controls are measured by nuisanceRate, not the defect repair regression metric")
  assert.equal(m.regressionRate, 1 / 2)
})

test("phase3: metrics handle empty input and reject malformed rows", async () => {
  const { computeRepairMetrics } = await import(REPAIR_V2)
  const empty = computeRepairMetrics([])
  assert.equal(empty.triggerRate, null, "zero denominators report null, never 0 or NaN")
  assert.equal(empty.nuisanceRate, null)
  assert.equal(empty.validRepairRate, null)
  assert.equal(empty.regressionRate, null)
  assert.throws(() => computeRepairMetrics([{ kind: "mystery" }]), /unknown scenario kind/)
  assert.throws(() => computeRepairMetrics([{ triggered: true }]), /missing kind/)
})

test("phase3: every check requires a module that exists in the emitted files map", async () => {
  const { generateScenarios } = await import(REPAIR_V2)
  for (const s of generateScenarios({ seed: 99, defectCount: 12, cleanCount: 6 })) {
    const checkPath = "checks/" + s.checks[0].name + ".check.js"
    const body = s.files[checkPath]
    assert.ok(typeof body === "string", s.id + " emits its check file")
    const required = []
    let cursor = body.indexOf("require('../")
    while (cursor !== -1) {
      const start = cursor + "require('../".length
      const end = body.indexOf("'", start)
      if (end === -1) break
      required.push(body.slice(start, end))
      cursor = body.indexOf("require('../", end)
    }
    assert.ok(required.length >= 1, s.id + " check requires its subject module")
    for (const rel of required) {
      assert.ok(s.files[rel] !== undefined, s.id + ": required module '" + rel + "' must exist in files")
    }
    assert.ok(s.files["src/" + s.checks[0].name + ".js"] !== undefined, s.id + ": src module uses the id-derived name")
  }
})
