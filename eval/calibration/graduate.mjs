/**
 * Margin-gate graduation evaluator (docs/MARGIN-GRADUATION-INVOICE.md).
 *
 * Deterministic, offline: reads every tracked summary for one calibration
 * condition (default kimi-k3@low) and prints PASS/FAIL per invoice condition
 * plus the overall verdict. No network calls. Run it after a calibration
 * round instead of re-deriving the table by hand.
 *
 *   node eval/calibration/graduate.mjs [condition]
 */
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const calDir = path.join(repoRoot, ".data", "calibration")
const condition = process.argv[2] ?? "kimi-k3@low"

const THRESHOLD = 0.03           // current selectionMarginThreshold
const SAFETY = 2.0               // graduation gate per the invoice (<= 1/2.0)
const SAFETY_REPORT = 2.2        // historical observation line, report-only
const TRIPWIRE_MAX = 0.015       // C0 max above this forces re-thresholding
const PER_ROUND_MAX = 0.02       // per-round ceiling allowed by the invoice
const MIN_FRAMES = 300
const MIN_ROUNDS = 3
const MIN_DAYS = 2
const BIAS_LIMIT = 0.005

const files = readdirSync(calDir).filter((f) => f.startsWith(condition + ".summary.") && f.endsWith(".json")).sort()
if (files.length === 0) { console.error("no summaries for condition " + condition); process.exit(1) }

const rounds = files.map((f) => {
  const j = JSON.parse(readFileSync(path.join(calDir, f), "utf8"))
  return { label: j.label ?? f, startedAt: j.startedAt, finishedAt: j.finishedAt, failures: j.failures ?? 0, c0n: j.c0?.n ?? 0, c0max: j.c0?.marginMax ?? null, bias: j.c0?.positionalBiasMean ?? null, c1: j.c1?.correctDirection ?? null, c1n: j.c1?.n ?? 0, c2: j.c2?.correctDirection ?? null, c2n: j.c2?.n ?? 0, file: f }
})
const valid = rounds.filter((r) => r.failures === 0 && r.c0n > 0 && r.c0max !== null)
const voided = rounds.filter((r) => !valid.includes(r))

const localDay = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` }
const days = [...new Set(valid.map((r) => localDay(r.startedAt)))]
const cumFrames = valid.reduce((a, r) => a + r.c0n, 0)
const maxSeen = valid.reduce((a, r) => Math.max(a, r.c0max), 0)
const anyTrip = rounds.some((r) => (r.c0max ?? 0) > TRIPWIRE_MAX)

const latest = [...valid].sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? "")).pop() ?? null
const dirPass = (str, n, need) => {
  const m = /^(\d+)\/(\d+)$/.exec(str ?? "")
  if (!m) return false
  return Number(m[1]) === Number(m[2]) && Number(m[2]) === n && Number(m[1]) >= need
}
const c2OK = (() => { const m = /^(\d+)\/(\d+)$/.exec(latest?.c2 ?? ""); return !!m && Number(m[2]) === latest.c2n && Number(m[1]) / Number(m[2]) >= 11 / 12 })()

const checks = [
  { name: `C0 cumulative frames >= ${MIN_FRAMES} (valid rounds only)`, ok: cumFrames >= MIN_FRAMES, got: `${cumFrames}` },
  { name: `>= ${MIN_ROUNDS} independent valid rounds`, ok: valid.length >= MIN_ROUNDS, got: String(valid.length) },
  { name: `rounds span >= ${MIN_DAYS} distinct local days`, ok: days.length >= MIN_DAYS, got: days.join(", ") },
  { name: `every valid round C0 max <= ${PER_ROUND_MAX}`, ok: valid.every((r) => r.c0max <= PER_ROUND_MAX), got: valid.map((r) => r.c0max.toFixed(5)).join(" / ") },
  { name: "latest round C1 方向全对", ok: !!latest && dirPass(latest.c1, latest.c1n, latest.c1n), got: latest ? `${latest.c1} @${latest.label}` : "none" },
  { name: "latest round C2 >= 11/12", ok: !!latest && c2OK, got: latest ? `${latest.c2} @${latest.label}` : "none" },
  { name: `latest round C0 positional bias |x| <= ${BIAS_LIMIT}`, ok: !!latest && latest.bias !== null && Math.abs(latest.bias) <= BIAS_LIMIT, got: latest ? String(latest.bias) : "none" },
  { name: `clearance: cumulative max * ${SAFETY} <= threshold`, ok: maxSeen * SAFETY <= THRESHOLD, got: `${maxSeen.toFixed(5)} * ${SAFETY} = ${(maxSeen * SAFETY).toFixed(5)} vs ${THRESHOLD}` },
  { name: `report-only: observed factor vs the 2.2x narrative line`, ok: true, got: `${(THRESHOLD / maxSeen).toFixed(4)}x (>=2.2 would mean ${(maxSeen * SAFETY_REPORT).toFixed(5)} <= ${THRESHOLD}: ${maxSeen * SAFETY_REPORT <= THRESHOLD})` },
]

console.log(`condition    : ${condition}`)
console.log(`valid rounds : ${valid.length} -> ${valid.map((r) => r.label).join(", ")}`)
if (voided.length) console.log(`void rounds  : ${voided.map((r) => `${r.label} (failures=${r.failures})`).join(", ")}  [excluded]`)
console.log("")
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}  [got: ${c.got}]`)
console.log("")
if (anyTrip) {
  const bad = rounds.filter((r) => r.c0max > TRIPWIRE_MAX).map((r) => `${r.label} max=${r.c0max}`)
  console.log(`VERDICT: RETHRESHOLD — a round broke the ${TRIPWIRE_MAX} tripwire (${bad.join("; ")}). Derive a new threshold first; do NOT flip marginProvisional.`)
  process.exit(2)
}
const allPass = checks.every((c) => c.ok)
console.log(`VERDICT: ${allPass ? "GRADUATE — all invoice conditions met; flip marginProvisional=false and keep threshold at " + THRESHOLD : "HOLD — conditions outstanding: " + checks.filter((c) => !c.ok).map((c) => c.name).join(" | ")}`)
process.exit(allPass ? 0 : 1)
