// Post-hoc analysis of one eval report (default: latest results-*.json).
// Usage: node eval/analyze.mjs [eval/results/results-....json]
import { readFileSync, readdirSync } from 'node:fs'

const arg = process.argv[2]
const file = arg || readdirSync('eval/results').filter(f => f.startsWith('results-')).sort().pop()
const j = JSON.parse(readFileSync('eval/results/' + file.replace(/^.*[\\/]/, ''), 'utf8'))

console.log('report:', file, '| run:', JSON.stringify(j.run))
console.log('metrics:', JSON.stringify(j.metrics))
for (const [name, v] of Object.entries(j.variance.byScenario)) {
  const f = s => s ? s.mean.toFixed(3) + (s.sd ? ('±' + s.sd.toFixed(3)) : '') : '-'
  console.log(name.padEnd(32), v.kind.padEnd(7), 'flagRate=' + v.flagRate.toFixed(2), 'viaDisp=' + v.flagsViaDispersion,
    'mean=' + f(v.mean), 'median=' + f(v.median), 'disp=' + f(v.dispersion))
}
console.log('strategySim:', JSON.stringify(j.strategySim))

const inv = {}
let flaggedRows = []
for (const x of j.scenarios) {
  for (const y of (x.invalidLanes || [])) inv[y] = (inv[y] || 0) + 1
  if (x.flagged && x.kind === 'clean') flaggedRows.push(x)
}
console.log('invalid lanes:', JSON.stringify(inv))
console.log('=== clean-row false positives, non-A lanes ===')
for (const x of flaggedRows) {
  const L = x.labels.split('')
  L.forEach((ch, i) => {
    if (ch !== 'A') console.log(x.name, 'r' + x.round, 'lane#' + (i + 1), '->', ch, '|', String((x.findings || [])[i]).slice(0, 150))
  })
}
