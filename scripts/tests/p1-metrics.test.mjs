// Review R7 7.2: the P1 fixed-set decision rule is code, pinned before any
// data exists (eval/experiments/p1-fixed-set.preregistration.md). Synthetic
// task sets check that each verifier quality maps to the preregistered decision.
//
// Part of the offline regression suite: `npm test` runs every scripts/tests/*.test.mjs
// in its own process; this file also runs alone with `node --test scripts/tests/p1-metrics.test.mjs`.
import test from "node:test"
import assert from "node:assert/strict"
import { P1_THRESHOLDS, computeLegacyFlagMetrics, computeP1Metrics, decideLegacy, decideP1, wilson } from "../../eval/p1/metrics.mjs"

// 40 tasks: 10 both-pass, 10 both-fail, 20 discordant (candidate 1 passes);
// the baseline passes exactly the both-pass tasks plus 2 more.
function taskSet(pick, { tokens = 1000, verifierTokens = 300 } = {}) {
  const rows = []
  for (let i = 0; i < 40; i++) {
    const kind = i < 10 ? "both-pass" : i < 20 ? "both-fail" : "discordant"
    const candidates = kind === "both-pass" ? [true, true] : kind === "both-fail" ? [false, false] : [false, true]
    const choice = pick(i, kind)
    rows.push({
      task: "t" + i,
      baseline: { pass: kind === "both-pass" || i === 20 || i === 21, tokens },
      candidates: candidates.map((pass) => ({ pass, tokens })),
      outcome: choice === null ? "abstain" : "ranked_winner",
      selectedIndex: choice,
      verifierTokens,
    })
  }
  return rows
}

test("R7 7.2: an oracle-quality verifier at 2.3x cost is 'continue'", () => {
  const m = computeP1Metrics(taskSet(() => 1))
  assert.equal(m.discordant, 20)
  assert.equal(m.agreement, 1)
  assert.equal(m.passSelected, m.passOracle, "it delivers the oracle pick")
  assert.ok(Math.abs(m.pipelineUplift - 0.45) < 1e-9, String(m.pipelineUplift))
  assert.ok(Math.abs(m.costMultiplier - 2.3) < 1e-9, String(m.costMultiplier))
  assert.deepEqual(decideP1(m), { decision: "continue", reasons: [] })
})

test("R7 7.2: a coin-flip verifier is 'stop' even though best-of-2 lifts pass rate", () => {
  const m = computeP1Metrics(taskSet((i) => i % 2))
  assert.equal(m.agreement, 0.5)
  assert.ok(m.pipelineUplift > 0, "N=2 alone helps: this is why uplift over pass@1 is not enough")
  assert.ok(Math.abs(m.selectionUplift) < 1e-9, "no better than a random pick of the two")
  assert.ok(m.agreementInterval.high > P1_THRESHOLDS.agreementStop, "the interval alone cannot reject a coin flip at this n")
  const verdict = decideP1(m)
  assert.equal(verdict.decision, "stop")
  assert.match(verdict.reasons.join(";"), /selection uplift 0\.000 <= 0/)
})

test("R7 7.2: a verifier that abstains on every discordant task cannot pass the power floor", () => {
  const m = computeP1Metrics(taskSet((i, kind) => (kind === "discordant" ? null : 0)))
  assert.equal(m.decidedOnDiscordant, 0)
  assert.equal(m.abstainOnDiscordant, 20)
  assert.equal(m.agreement, null)
  const verdict = decideP1(m)
  assert.equal(verdict.decision, "inconclusive")
  assert.match(verdict.reasons.join(";"), /decided discordant 0 < 15/)
})

test("R7 7.2: too few tasks or too much cost is never 'continue'", () => {
  const small = computeP1Metrics(taskSet(() => 1).slice(0, 29 - 9).concat(taskSet(() => 1).slice(20, 29)))
  assert.equal(decideP1(small).decision, "inconclusive")
  const pricey = computeP1Metrics(taskSet(() => 1, { verifierTokens: 2000 }))
  assert.ok(pricey.costMultiplier > P1_THRESHOLDS.maxCostMultiplier)
  assert.match(decideP1(pricey).reasons.join(";"), /cost multiplier/)
})

test("R7 7.2: Wilson interval and frozen thresholds", () => {
  const { low, high } = wilson(15, 20)
  assert.ok(low > 0.5 && low < 0.55 && high > 0.88 && high < 0.92, low + " " + high)
  assert.deepEqual(wilson(0, 0), { low: 0, high: 1 })
  assert.ok(Object.isFrozen(P1_THRESHOLDS))
})

test("R7 7.3: the legacy arm keeps only a flag that predicts hidden-test failure", () => {
  // 30 tasks, 12 baseline failures.
  const rows = (flag, valid = () => true) => Array.from({ length: 30 }, (_, i) => ({ baselinePass: i >= 12, flagged: flag(i), valid: valid(i) }))
  const good = computeLegacyFlagMetrics(rows((i) => i < 9 || i === 20)) // 9 of 12 failures, 1 false alarm
  assert.equal(good.precision, 0.9)
  assert.equal(good.recall, 0.75)
  assert.equal(decideLegacy(good).decision, "keep")
  // Flags everything: perfect recall, precision = base failure rate 0.4.
  const noisy = decideLegacy(computeLegacyFlagMetrics(rows(() => true)))
  assert.equal(noisy.decision, "retire")
  assert.match(noisy.reasons.join(";"), /precision 0\.4 < 0\.7/)
  // Flags nothing: the shipped autoFeedback=false behaviour in effect.
  assert.equal(decideLegacy(computeLegacyFlagMetrics(rows(() => false))).decision, "retire")
  // A good flag behind an unreliable transport is still retired.
  assert.match(decideLegacy(computeLegacyFlagMetrics(rows((i) => i < 9, (i) => i % 4 !== 3))).reasons.join(";"), /invalid rate/)
  // Too few failures to judge.
  assert.equal(decideLegacy(computeLegacyFlagMetrics(rows((i) => i < 3).map((r, i) => ({ ...r, baselinePass: i >= 5 })))).decision, "insufficient")
})
