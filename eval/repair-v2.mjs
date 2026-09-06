// Repair-v2 experiment tooling (historical preregistration boundary: HANDOFF.md §7.1).
//
// Preregistration lives in eval/experiments/repair-v2.preregistration.md.
// This module provides the two deterministic pieces every later live run
// depends on:
//
//   generateScenarios()  - seeded adversarial task briefs (defect) paired with
//                          clean controls. Task text never leaks evaluation
//                          constraints; ground truth lives in the planted flaw
//                          and the independent node checks, never in prose.
//   computeRepairMetrics() - the four preregistered rates (trigger, nuisance,
//                          valid-repair, regression) over plain run rows.
//
// Both are pure functions so the suite can lock them before any quota is spent.

import { pathToFileURL } from 'node:url'

/** Deterministic PRNG (mulberry32): same seed, same stream, everywhere. */
export function mulberry32(seed) {
  let t = seed >>> 0
  return function () {
    t += 0x6D2B79F5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

const cjs = body => body.trimStart() + '\n'

/** Defect templates. `initial:'fail'` marks the independent check that exposes
 *  the planted flaw; subjects see only `problem`, `files` and are told checks
 *  exist under checks/ without being told which one guards what. */
const DEFECT_TEMPLATES = [
  {
    id: 'paginate-off-by-one',
    flaw: 'paginate treats its 1-based page argument as a 0-based offset',
    problem: 'In src/paginate.js the paginate(users, page, pageSize) helper must return the users for the requested page. Page numbers passed by callers start at 1, and the final short page must still be returned when fewer items remain. Keep the existing export shape.',
    file: cjs(`
      // Page helper used by the users listing endpoint.
      module.exports.paginate = function paginate(users, page, pageSize) {
        const start = page * pageSize
        return users.slice(start, start + pageSize)
      }
    `),
    check: cjs(`
      const { paginate } = require('../src/paginate-off-by-one.js')
      const users = Array.from({ length: 25 }, (_, i) => 'u' + (i + 1))
      const assert = require('node:assert')
      assert.deepEqual(paginate(users, 1, 10), users.slice(0, 10))
      assert.deepEqual(paginate(users, 2, 10), users.slice(10, 20))
      assert.deepEqual(paginate(users, 3, 10), users.slice(20, 25))
      console.log('ok')
    `),
    initial: 'fail',
  },
  {
    id: 'range-boundary-exclusive',
    flaw: 'inRange excludes the exact lower and upper bounds although the contract is inclusive',
    problem: 'In src/range.js, inRange(value, low, high) reports whether value lies inside the closed interval [low, high]. Values equal to either bound count as inside. Keep the existing export shape.',
    file: cjs(`
      // Closed-interval membership test.
      module.exports.inRange = function inRange(value, low, high) {
        return value > low && value < high
      }
    `),
    check: cjs(`
      const { inRange } = require('../src/range-boundary-exclusive.js')
      const assert = require('node:assert')
      assert.equal(inRange(5, 5, 10), true)
      assert.equal(inRange(10, 5, 10), true)
      assert.equal(inRange(7, 5, 10), true)
      assert.equal(inRange(4, 5, 10), false)
      console.log('ok')
    `),
    initial: 'fail',
  },
  {
    id: 'average-empty-input',
    flaw: 'average returns NaN for an empty list instead of the documented null',
    problem: 'In src/stats.js, average(numbers) returns the arithmetic mean of the list. For an empty list the documented result is null rather than any numeric placeholder. Keep the existing export shape.',
    file: cjs(`
      // Mean of a numeric list.
      module.exports.average = function average(numbers) {
        return numbers.reduce((sum, value) => sum + value, 0) / numbers.length
      }
    `),
    check: cjs(`
      const { average } = require('../src/average-empty-input.js')
      const assert = require('node:assert')
      assert.equal(average([2, 4, 6]), 4)
      assert.equal(average([]), null)
      console.log('ok')
    `),
    initial: 'fail',
  },
  {
    id: 'config-error-swallowed',
    flaw: 'loadConfig swallows parse errors and resolves undefined instead of rejecting',
    problem: 'In src/config-store.js, loadConfig(raw) parses a JSON document and resolves with the parsed object. Callers rely on the promise rejecting when raw is not valid JSON so their own error reporting can kick in. Keep the existing export shape.',
    file: cjs(`
      // Async config loader.
      module.exports.loadConfig = async function loadConfig(raw) {
        try {
          return JSON.parse(raw)
        } catch (error) {
          return undefined
        }
      }
    `),
    check: cjs(`
      const { loadConfig } = require('../src/config-error-swallowed.js')
      const assert = require('node:assert/strict')
      const good = await loadConfig('{"a":1}')
      assert.deepEqual(good, { a: 1 })
      await assert.rejects(() => loadConfig('{oops'))
      console.log('ok')
    `),
    initial: 'fail',
  },
  {
    id: 'slug-single-replacement',
    flaw: 'toSlug replaces only the first whitespace run instead of every run',
    problem: 'In src/slug.js, toSlug(text) lowercases the input and turns every run of whitespace into a single dash, trimming dashes at both ends. Keep the existing export shape.',
    file: cjs(`
      // URL slug builder.
      module.exports.toSlug = function toSlug(text) {
        return text.toLowerCase().replace(' ', '-').replace(/^-+|-+$/g, '')
      }
    `),
    check: cjs(`
      const { toSlug } = require('../src/slug-single-replacement.js')
      const assert = require('node:assert')
      assert.equal(toSlug('Hello   World  Again'), 'hello-world-again')
      assert.equal(toSlug('  Edge  '), 'edge')
      console.log('ok')
    `),
    initial: 'fail',
  },
  {
    id: 'ttl-unit-mismatch',
    flaw: 'isExpired multiplies the millisecond TTL by 1000, expiring entries far too early',
    problem: 'In src/cache-entry.js, isExpired(entry, nowMs) reports whether a cache entry has outlived its time-to-live. The entry.ttl field and the ttl unit everywhere in this project are milliseconds. Keep the existing export shape.',
    file: cjs(`
      // Cache entry expiry probe.
      module.exports.isExpired = function isExpired(entry, nowMs) {
        return nowMs - entry.createdAt > entry.ttl * 1000
      }
    `),
    check: cjs(`
      const { isExpired } = require('../src/ttl-unit-mismatch.js')
      const assert = require('node:assert')
      const entry = { createdAt: 1000, ttl: 500 }
      assert.equal(isExpired(entry, 1200), false)
      assert.equal(isExpired(entry, 1600), true)
      console.log('ok')
    `),
    initial: 'fail',
  },
]

/** Clean controls: same surface style, sound implementations, all green. */
const CLEAN_TEMPLATES = [
  {
    id: 'word-counter',
    problem: 'In src/count-words.js implement countWords(text) returning how many whitespace-separated words the text contains (empty or whitespace-only input counts 0). Keep the existing export shape.',
    file: cjs(`
      // Word counter utility.
      module.exports.countWords = function countWords(text) {
        const trimmed = String(text ?? '').trim()
        return trimmed === '' ? 0 : trimmed.split(/\\s+/).length
      }
    `),
    check: cjs(`
      const { countWords } = require('../src/word-counter.js')
      const assert = require('node:assert')
      assert.equal(countWords('one two three'), 3)
      assert.equal(countWords('   '), 0)
      assert.equal(countWords(''), 0)
      console.log('ok')
    `),
    initial: 'pass',
  },
  {
    id: 'csv-line-parser',
    problem: 'In src/csv-line.js implement parseLine(line) splitting one CSV row on commas into an array of trimmed cell strings. Quoted fields are out of scope for this helper. Empty line yields an empty array. Keep the existing export shape.',
    file: cjs(`
      // Minimal single-row CSV splitter.
      module.exports.parseLine = function parseLine(line) {
        if (line === '') return []
        return line.split(',').map(cell => cell.trim())
      }
    `),
    check: cjs(`
      const { parseLine } = require('../src/csv-line-parser.js')
      const assert = require('node:assert')
      assert.deepEqual(parseLine('a, b ,c'), ['a', 'b', 'c'])
      assert.deepEqual(parseLine(''), [])
      console.log('ok')
    `),
    initial: 'pass',
  },
  {
    id: 'clamp-number',
    problem: 'In src/clamp.js implement clamp(value, low, high) constraining value into the closed interval, returning the bound itself when value sits outside. Keep the existing export shape.',
    file: cjs(`
      // Numeric clamp.
      module.exports.clamp = function clamp(value, low, high) {
        return Math.min(Math.max(value, low), high)
      }
    `),
    check: cjs(`
      const { clamp } = require('../src/clamp-number.js')
      const assert = require('node:assert')
      assert.equal(clamp(7, 0, 10), 7)
      assert.equal(clamp(-3, 0, 10), 0)
      assert.equal(clamp(42, 0, 10), 10)
      console.log('ok')
    `),
    initial: 'pass',
  },
]

function buildScenario(prefix, index, template, kind) {
  return {
    id: prefix + '-' + String(index + 1).padStart(2, '0'),
    kind,
    problem: template.problem,
    ...(kind === 'defect' ? { plantedFlaw: template.flaw } : {}),
    files: {
      ['src/' + template.id + '.js']: template.file,
      ['checks/' + template.id + '.check.js']: template.check,
    },
    checks: [
      {
        name: template.id,
        command: 'node checks/' + template.id + '.check.js',
        initial: template.initial,
      },
    ],
  }
}

/** Seeded, deterministic scenario set. Template order is shuffled by the seed;
 *  pools cycle when the requested counts exceed the template library. */
export function generateScenarios({ seed = 7, defectCount = 20, cleanCount = 10 } = {}) {
  if (!Number.isInteger(seed)) throw new TypeError('seed must be an integer')
  if (!Number.isInteger(defectCount) || defectCount < 0) throw new TypeError('defectCount must be a non-negative integer')
  if (!Number.isInteger(cleanCount) || cleanCount < 0) throw new TypeError('cleanCount must be a non-negative integer')
  const random = mulberry32(seed)
  const shuffled = list => {
    const copy = [...list]
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1))
      ;[copy[i], copy[j]] = [copy[j], copy[i]]
    }
    return copy
  }
  const pick = (pool, count, prefix, kind) => {
    const out = []
    let bag = []
    for (let i = 0; i < count; i += 1) {
      if (bag.length === 0) bag = shuffled(pool)
      const template = bag.pop()
      out.push(buildScenario(prefix, i, template, kind))
    }
    return out
  }
  const defectScenarios = pick(DEFECT_TEMPLATES, defectCount, 'RV2-D', 'defect')
  const cleanScenarios = pick(CLEAN_TEMPLATES, cleanCount, 'RV2-C', 'clean')
  return [...defectScenarios, ...cleanScenarios]
}

function rate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator
}

/** The four preregistered rates over plain run rows.
 *  Row: { kind: 'defect'|'clean', triggered?, repaired?, repairValid?, regressed? } */
export function computeRepairMetrics(runs) {
  if (!Array.isArray(runs)) throw new TypeError('runs must be an array')
  for (const row of runs) {
    if (!row || typeof row !== 'object') throw new TypeError('missing kind: run rows must be objects')
    if (!('kind' in row)) throw new TypeError('missing kind: every run row needs a scenario kind')
    if (row.kind !== 'defect' && row.kind !== 'clean') throw new TypeError('unknown scenario kind: ' + String(row.kind))
  }
  const defectRuns = runs.filter(row => row.kind === 'defect')
  const cleanRuns = runs.filter(row => row.kind === 'clean')
  const triggers = defectRuns.filter(row => row.triggered === true)
  const nuisanceTriggers = cleanRuns.filter(row => row.triggered === true)
  const repairsAttempted = defectRuns.filter(row => row.repaired === true)
  const validRepairs = repairsAttempted.filter(row => row.repairValid === true)
  const regressions = repairsAttempted.filter(row => row.regressed === true)
  return {
    total: runs.length,
    defectScenarios: defectRuns.length,
    cleanScenarios: cleanRuns.length,
    triggers: triggers.length,
    triggerRate: rate(triggers.length, defectRuns.length),
    nuisanceTriggers: nuisanceTriggers.length,
    nuisanceRate: rate(nuisanceTriggers.length, cleanRuns.length),
    repairsAttempted: repairsAttempted.length,
    validRepairs: validRepairs.length,
    validRepairRate: rate(validRepairs.length, repairsAttempted.length),
    regressions: regressions.length,
    regressionRate: rate(regressions.length, repairsAttempted.length),
  }
}

const REPAIR_V2_FLAGS = new Set(['seed', 'defect', 'clean', 'out'])

export function parseRepairV2Args(argv) {
  const flags = {}
  for (const arg of argv) {
    const match = /^--([a-zA-Z][a-zA-Z0-9-]*)=(.*)$/.exec(arg)
    if (!match || !REPAIR_V2_FLAGS.has(match[1])) throw new Error('unknown-or-malformed-flag:' + arg)
    if (match[1] === 'out' && match[2].trim() === '') throw new Error('flag-out-path-required')
    flags[match[1]] = match[2]
  }
  const integer = (name, fallback) => {
    const value = Number(flags[name] ?? fallback)
    if (!Number.isInteger(value)) throw new Error('flag-' + name + '-integer-required')
    return value
  }
  const count = (name, fallback) => {
    const value = integer(name, fallback)
    if (value < 0) throw new Error('flag-' + name + '-nonnegative-integer-required')
    return value
  }
  return {
    seed: integer('seed', 7),
    defect: count('defect', 20),
    clean: count('clean', 10),
    out: flags.out,
  }
}

async function main(argv) {
  const flags = parseRepairV2Args(argv)
  const scenarios = generateScenarios({
    seed: flags.seed,
    defectCount: flags.defect,
    cleanCount: flags.clean,
  })
  const json = JSON.stringify(scenarios, null, 2)
  if (flags.out) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(flags.out, json + '\n')
    console.log('wrote ' + scenarios.length + ' scenarios to ' + flags.out)
  } else {
    console.log(json)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2))
}
