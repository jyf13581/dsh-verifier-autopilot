// Checked JSON readers: the one vocabulary every layer uses to read session
// event payloads, provider bodies, and sidecar frames typed as `unknown`.
//
// Part of the offline regression suite: `npm test` runs every scripts/tests/*.test.mjs
// in its own process; this file also runs alone with `node --test scripts/tests/payload.test.mjs`.

import test from "node:test"
import assert from "node:assert/strict"
import { isRecord, read, readArray, readString } from "../../lib/payload.js"

test("payload: read follows plain objects only and is total at every depth", () => {
  const data = { message: { content: "hi", parts: ["a", "b"] }, turn: 3, source: null }
  assert.equal(read(data, "turn"), 3, "one key is the checked form of data?.turn")
  assert.equal(read(data, "message", "content"), "hi")
  assert.deepEqual(read(data, "message", "parts"), ["a", "b"], "arrays are returned as values")
  assert.equal(read(data, "message", "parts", "0"), undefined, "but never traversed: an array is not a record")
  assert.equal(read(data, "source", "kind"), undefined, "null ends the path")
  assert.equal(read(data, "missing", "deeper"), undefined)
  assert.equal(read(data), data, "no keys reads the value itself")
  for (const scalar of [undefined, null, "text", 42, true, ["x"]]) {
    assert.equal(read(scalar, "content"), undefined, "non-record payload " + JSON.stringify(scalar) + " reads as absent")
    assert.equal(read(scalar, "message", "content"), undefined)
  }
})

test("payload: readArray and readString narrow or default, never throw", () => {
  const body = { choices: [{ finish_reason: "stop" }], error: "nope", logprobs: null }
  assert.deepEqual(readArray(body, "choices"), [{ finish_reason: "stop" }])
  assert.deepEqual(readArray(body, "error"), [], "a string is not an array")
  assert.deepEqual(readArray(body, "logprobs", "content"), [], "a null step reads as an empty array")
  assert.deepEqual(readArray(null, "choices"), [])
  assert.equal(readString(body, "error"), "nope")
  assert.equal(readString(body, "choices"), undefined, "an array is not a string")
  assert.equal(readString(body, "choices", "0", "finish_reason"), undefined, "index keys do not enter arrays")
  assert.equal(readString(undefined, "x"), undefined)
})

test("payload: isRecord accepts plain objects and rejects null, arrays, and scalars", () => {
  assert.equal(isRecord({}), true)
  assert.equal(isRecord({ a: 1 }), true)
  assert.equal(isRecord(Object.create(null)), true)
  for (const value of [null, undefined, [], [1], "s", 1, true]) assert.equal(isRecord(value), false, JSON.stringify(value))
})
