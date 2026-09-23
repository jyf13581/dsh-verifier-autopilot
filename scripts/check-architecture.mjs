// Static module-boundary gate for the architecture described in
// docs/ARCHITECTURE.md. It uses the TypeScript parser (not regexes), so mixed
// value/type imports and import() type expressions are classified correctly.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = path.join(root, 'src')
const slash = value => value.split(path.sep).join('/')
const relative = value => slash(path.relative(root, value))

const files = []
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(target)
    else if (entry.isFile() && target.endsWith('.ts') && !target.endsWith('.d.ts')) files.push(path.normalize(target))
  }
}
walk(sourceRoot)

const fileSet = new Set(files)
const edges = new Map()

function resolveLocal(from, specifier) {
  if (!specifier.startsWith('.')) return null
  const base = path.resolve(path.dirname(from), specifier.replace(/\.(?:mjs|cjs|js)$/, ''))
  for (const candidate of [base + '.ts', path.join(base, 'index.ts')]) {
    const normalized = path.normalize(candidate)
    if (fileSet.has(normalized)) return normalized
  }
  throw new Error(relative(from) + ': unresolved local module ' + JSON.stringify(specifier))
}

function addEdge(from, specifier, runtime) {
  const to = resolveLocal(from, specifier)
  if (!to) return
  const key = from + '\0' + to
  const previous = edges.get(key)
  edges.set(key, { from, to, runtime: Boolean(runtime || previous?.runtime) })
}

for (const file of files) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause
      let runtime = !clause || !clause.isTypeOnly
      if (clause && !clause.isTypeOnly) {
        if (!clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          runtime = clause.namedBindings.elements.some(element => !element.isTypeOnly)
        }
      }
      addEdge(file, statement.moduleSpecifier.text, runtime)
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      let runtime = !statement.isTypeOnly
      if (!statement.isTypeOnly && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        runtime = statement.exportClause.elements.some(element => !element.isTypeOnly)
      }
      addEdge(file, statement.moduleSpecifier.text, runtime)
    }
  }
  const visit = node => {
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      addEdge(file, node.argument.literal.text, false)
    }
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) addEdge(file, node.arguments[0].text, true)
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') addEdge(file, node.arguments[0].text, true)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

const problems = []
const isSelection = file => relative(file).startsWith('src/selection/')
for (const edge of edges.values()) {
  const from = relative(edge.from)
  const to = relative(edge.to)
  const kind = edge.runtime ? 'runtime' : 'type-only'
  const reject = reason => problems.push(from + ' -> ' + to + ' (' + kind + '): ' + reason)

  if ((from === 'src/constants.ts' || from === 'src/util.ts' || from === 'src/ledger.ts') && to.startsWith('src/')) {
    reject('leaf boundary modules may not import project modules')
  }
  if (from === 'src/protocol.ts' && edge.runtime && to !== 'src/constants.ts') {
    reject('the browser-safe protocol may only import the dependency-free constants module at runtime')
  }
  if (from === 'src/diagnostics.ts' && !['src/util.ts', 'src/constants.ts'].includes(to)) {
    reject('the diagnostics sink is a leaf: every layer reports into it, so it may import only util/constants')
  }
  if (from === 'src/selection/proc.ts' && to.startsWith('src/')) {
    reject('the bounded process runner is a leaf: live.ts and checks.ts both build on it, so it may import Node only')
  }
  if (from === 'src/config.ts' && isSelection(edge.to)) {
    reject('configuration owns policy types and may not depend on selection implementation')
  }
  if (from === 'src/evidence.ts' && edge.runtime && to !== 'src/constants.ts') {
    reject('evidence logic may only import dependency-free constants at runtime')
  }
  if (from === 'src/client/index.ts' && to !== 'src/protocol.ts') {
    reject('the browser may consume only the shared protocol boundary')
  }
  if (isSelection(edge.from) && ['src/host.ts', 'src/api.ts', 'src/index.ts', 'src/client/index.ts'].includes(to)) {
    reject('selection internals may not depend on Host, transport, composition, or browser layers')
  }
  if (from === 'src/host.ts' && ['src/api.ts', 'src/index.ts', 'src/client/index.ts'].includes(to)) {
    reject('Host lifecycle may not depend on transport, composition, or browser layers')
  }
  if (from === 'src/api.ts' && ['src/index.ts', 'src/client/index.ts'].includes(to)) {
    reject('transport may not depend on composition or browser layers')
  }
  if (to === 'src/index.ts' && from !== 'src/index.ts') {
    reject('no implementation module may import the composition root')
  }
}

// Detect cycles over both runtime and type-only edges. Type-only cycles do not
// crash ESM, but they still make ownership unclear and tend to become runtime
// cycles during later refactors.
const adjacency = new Map(files.map(file => [file, []]))
for (const edge of edges.values()) adjacency.get(edge.from).push(edge.to)
const state = new Map()
const stack = []
let cycle = null
function visitCycle(file) {
  if (cycle || state.get(file) === 2) return
  if (state.get(file) === 1) {
    const index = stack.indexOf(file)
    cycle = [...stack.slice(index), file]
    return
  }
  state.set(file, 1)
  stack.push(file)
  for (const target of adjacency.get(file) ?? []) visitCycle(target)
  stack.pop()
  state.set(file, 2)
}
for (const file of files) visitCycle(file)
if (cycle) problems.push('module cycle: ' + cycle.map(relative).join(' -> '))

if (problems.length > 0) {
  console.error('Architecture check failed:')
  for (const problem of problems) console.error('  - ' + problem)
  process.exitCode = 1
} else {
  const runtimeCount = [...edges.values()].filter(edge => edge.runtime).length
  console.log('Architecture check passed: ' + files.length + ' modules, ' + runtimeCount + ' runtime edges, ' + (edges.size - runtimeCount) + ' type-only edges, 0 cycles')
}
