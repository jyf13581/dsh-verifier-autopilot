/**
 * Checked readers for schemaless JSON at the plugin's data seams.
 *
 * Three kinds of payload enter the plugin without a type the compiler can
 * vouch for: session event `data` (DSH's typed event union arrives through
 * the Agent seam, and persisted logs span schema versions — source-less user
 * messages, `message` vs `content` bodies), provider response bodies from
 * `response.json()`, and sidecar frames. All of them are `unknown` here and
 * are read through the accessors below instead of optional chains on `any`.
 *
 * Every reader is total: it never throws, a non-object at any step reads as
 * an absent field, and the result is `unknown` (or a narrowed primitive) so
 * the call site still has to say what it expects. That is exactly what
 * `value?.[key]` did on the old `any`, minus the TypeErrors on `null`
 * entries inside arrays.
 *
 * Leaf module: every layer reads payloads, so it may import nothing.
 */

export type JsonRecord = Record<string, unknown>

/** One durable session event as this plugin sees it. `data` is deliberately
 *  `unknown`: the legacy verifier path (evidence.ts), the coordinator, and
 *  the selection trajectory renderer all read it through `read()`, each
 *  tolerant of the payload shapes older logs still carry. */
export interface EventRecord {
  type: string
  seq?: number
  time?: number
  data?: unknown
}

/** A plain JSON object: arrays and `null` are not records. */
export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `value[k1][k2]…` following plain objects only; `undefined` as soon as the
 *  path leaves a record. With one key it is the checked form of `value?.[k]`. */
export function read(value: unknown, ...path: readonly string[]): unknown {
  let cursor = value
  for (const key of path) {
    if (!isRecord(cursor)) return undefined
    cursor = cursor[key]
  }
  return cursor
}

/** `read(value, ...path)` when it is an array, else an empty array. */
export function readArray(value: unknown, ...path: readonly string[]): unknown[] {
  const items = read(value, ...path)
  return Array.isArray(items) ? items : []
}

/** `read(value, ...path)` when it is a string, else `undefined`. */
export function readString(value: unknown, ...path: readonly string[]): string | undefined {
  const item = read(value, ...path)
  return typeof item === 'string' ? item : undefined
}
