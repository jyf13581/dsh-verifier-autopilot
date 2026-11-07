// Review R7 7.1: documents state current facts only when the code produced
// them. The README defaults block is generated (scripts/doc-facts.mjs) and the
// authoritative documents are linted for the drift classes R7 found.
//
// Part of the offline regression suite: `npm test` runs every scripts/tests/*.test.mjs
// in its own process; this file also runs alone with `node --test scripts/tests/doc-truth.test.mjs`.
import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { DEFAULT_CONFIG } from "../../lib/config.js"
import { AUTHORITATIVE_DOCS, BEGIN, END, lintDoc, renderDefaults, replaceBlock } from "../doc-facts.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const read = (rel) => readFileSync(path.join(root, rel), "utf8")

test("R7 7.1: the README defaults block is exactly what the code renders", async () => {
  const readme = read("README.md")
  assert.ok(readme.includes(BEGIN) && readme.includes(END), "README carries the generated block markers")
  assert.equal(replaceBlock(readme, await renderDefaults()), readme, "stale: run node scripts/doc-facts.mjs --write")
  for (const key of Object.keys(DEFAULT_CONFIG)) assert.ok(readme.includes("| `" + key + "` |"), key + " has a row")
})

test("R7 7.1: authoritative documents carry no hand-written counts, machine paths, or drifted defaults", () => {
  for (const doc of AUTHORITATIVE_DOCS) assert.deepEqual(lintDoc(read(doc), DEFAULT_CONFIG), [], doc)
})

test("R7 7.1: the lint catches each drift class (negative controls)", () => {
  const stale = [
    "All 203 regressions pass (191/191 tests).",
    "The plugin lives in D:/tools/dsh-plugins/dsh-verifier-autopilot.",
    "`selectionMode` (default `auto`) admits actionable turns.",
    "The margin gate is 0.08 (`selectionMarginThreshold`).",
  ].join("\n")
  const findings = lintDoc(stale, DEFAULT_CONFIG)
  // One finding per drifted line: the counts line, the path, the default, the margin.
  assert.equal(findings.length, 4, findings.join("; "))
  assert.deepEqual(lintDoc("`selectionPostAuditTestCommand` (default empty)", DEFAULT_CONFIG), [], "an empty-string default may be written as empty")
  assert.deepEqual(lintDoc("`selectionMode` (default `off`) and a margin gate of 0.03.", DEFAULT_CONFIG), [], "current facts pass")
})

test("R7 7.1: the README before R7 fails the lint the README now passes", (t) => {
  let before
  try { before = execFileSync("git", ["show", "c32aa59:README.md"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) } catch { t.skip("c32aa59 not in this clone"); return }
  const findings = lintDoc(before, DEFAULT_CONFIG)
  t.diagnostic("pre-R7 README findings: " + findings.join("; "))
  assert.ok(findings.some((f) => f.includes("test count")), "191/191 and 203 regressions")
  assert.ok(findings.some((f) => f.includes("machine path")), "D:/tools/.autopilot-live-chain")
})

test("R7 7.1: HANDOFF.md is marked as a journal, and the documentation map points at real files", () => {
  const head = read("HANDOFF.md").split("\n").slice(0, 12).join("\n")
  assert.match(head, /运维日志|operator journal/i, "HANDOFF opens with its authority statement")
  const map = read("README.md").split("## Documentation Map")[1] ?? ""
  for (const [, file] of map.matchAll(/^\| ([\w./-]+\.md|[\w./-]+\/) \|/gm)) assert.ok(existsSync(path.join(root, file)), file)
})
