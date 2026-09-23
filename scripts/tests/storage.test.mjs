// Durable selection storage: the JSONL settlement ledger, running-row
// persistence, and artifact collection bound to the ledger window.
//
// Part of the offline regression suite: `npm test` runs every scripts/tests/*.test.mjs
// in its own process; this file also runs alone with `node --test scripts/tests/storage.test.mjs`.

import test from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, mkdtempSync, mkdirSync, existsSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SEL_TMP, fakeBridge, makeFakeFactory, realWorkspaces, settledRecord } from "./helpers/selection.mjs"
import { waitFor } from "./helpers/harness.mjs"

test("selhost: settlement file dedupes later discard lines over the original record", async () => {
  const { SelectionHost } = await import("../../lib/selection/host.js")
  const f = path.join(SEL_TMP, "sel-ledger-" + Date.now() + ".jsonl")
  const base = { selectionId: "sel-a", sourceSessionId: null, status: "completed", candidates: [], startedAt: 1, finishedAt: 2 }
  writeFileSync(f, JSON.stringify({ ...base, winner: { index: 0, sessionId: "s", workspace: "w" } }) + "\n"
    + JSON.stringify({ ...base, winner: { index: 0, sessionId: "s", workspace: "w", discardedAt: 9 } }) + "\n"
    + JSON.stringify({ ...base, selectionId: "sel-../../escape" }) + "\n")
  const host2 = new SelectionHost({ verifier: () => ({ model: "m", baseURL: "u", apiKeyEnv: "k" }), selectionsFile: f })
  const rec = host2.getSelection("sel-a")
  assert.equal(rec.winner.discardedAt, 9, "the later settlement line wins")
  assert.equal(host2.listSelections().length, 1, "no duplicate history entries and unsafe persisted ids are rejected")
  assert.equal(host2.getSelection("sel-../../escape"), undefined, "a ledger id can never become an audit-pack path traversal")
  await host2.dispose()
})

// ---------- round 5: storage lifecycle and platform portability ----------
//
// One bounded process runner under both the git helpers and the check
// harness; a check shell resolved from a platform chain instead of a
// hard-coded pwsh; audit packs and candidate directories that live exactly as
// long as the records that can still reach them; sidecar warm-up measured.

test("artifacts: audit packs outside the history window are collected on load and on eviction; everything else in the directory is left alone", async () => {
  const { SelectionHost, SELECTIONS_HISTORY_LIMIT } = await import("../../lib/selection/host.js")
  const { Diagnostics } = await import("../../lib/index.js")
  const base = mkdtempSync(path.join(tmpdir(), "va-gc-"))
  try {
    const ledger = path.join(base, "selections.jsonl")
    const artifacts = path.join(base, "selection-artifacts")
    const lines = []
    for (let i = 0; i <= SELECTIONS_HISTORY_LIMIT; i += 1) lines.push(JSON.stringify(settledRecord("sel-" + i, i)))
    writeFileSync(ledger, lines.join("\n") + "\n")
    const pack = (name) => { mkdirSync(path.join(artifacts, name), { recursive: true }); writeFileSync(path.join(artifacts, name, "record.json"), "{}") }
    pack("sel-0"); pack("sel-1"); pack("sel-" + SELECTIONS_HISTORY_LIMIT); pack("sel-gone")
    writeFileSync(path.join(artifacts, "sel-legacy.json"), "{}")
    writeFileSync(path.join(artifacts, "notes.txt"), "operator notes")
    mkdirSync(path.join(artifacts, "unrelated-dir"))
    const diag = new Diagnostics()
    const factory = makeFakeFactory({})
    const host = new SelectionHost({
      verifier: () => ({ model: "m", baseURL: "u", apiKeyEnv: "k" }),
      resolveKey: async () => "dummy",
      selectionsFile: ledger, artifactsDir: artifacts, diagnostics: diag,
      testing: { factory, workspaces: realWorkspaces, bridge: fakeBridge() },
    })
    try {
    assert.equal(host.listSelections().length, SELECTIONS_HISTORY_LIMIT, "fixture: the window is full")
    assert.equal(host.getSelection("sel-0"), undefined, "fixture: the oldest record fell out of the window at load")
    assert.equal(await host.collectArtifacts(), 0, "the pass started by the constructor already ran; a second pass finds nothing")
    assert.equal(diag.snapshot().counters["artifacts.gc_removed"], 3)
    for (const gone of ["sel-0", "sel-gone", "sel-legacy.json"]) assert.ok(!existsSync(path.join(artifacts, gone)), gone + " is outside the window and was removed")
    for (const kept of ["sel-1", "sel-" + SELECTIONS_HISTORY_LIMIT, "notes.txt", "unrelated-dir"]) assert.ok(existsSync(path.join(artifacts, kept)), kept + " is kept")

    // A new selection evicts the oldest retained record; its pack goes with it.
    const started = await host.start({ problem: "task", candidateCount: 1 })
    assert.equal(host.getSelection("sel-1"), undefined, "fixture: sel-1 was evicted by the new run")
    await host.collectArtifacts()
    assert.ok(!existsSync(path.join(artifacts, "sel-1")), "the evicted record's pack is collected")
    await waitFor(() => { const s = host.getSelection(started.selectionId); return s && s.status !== "running" ? s : null })
    assert.ok(existsSync(path.join(artifacts, started.selectionId, "record.json")), "the new selection's own pack is written and kept")
    } finally { await host.dispose() }
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test("artifacts: a ledger that could not be read, or is empty, proves nothing — no pack is collected", async () => {
  const { SelectionHost } = await import("../../lib/selection/host.js")
  const base = mkdtempSync(path.join(tmpdir(), "va-gc-empty-"))
  try {
    const artifacts = path.join(base, "selection-artifacts")
    mkdirSync(path.join(artifacts, "sel-precious"), { recursive: true })
    const verifier = () => ({ model: "m", baseURL: "u", apiKeyEnv: "k" })
    const absent = new SelectionHost({ verifier, selectionsFile: path.join(base, "missing.jsonl"), artifactsDir: artifacts })
    assert.equal(await absent.collectArtifacts(), 0, "no ledger yet: an explicit pass is a no-op too")
    assert.ok(existsSync(path.join(artifacts, "sel-precious")), "no ledger yet: nothing is collected")
    await absent.dispose()
    writeFileSync(path.join(base, "empty.jsonl"), "")
    const empty = new SelectionHost({ verifier, selectionsFile: path.join(base, "empty.jsonl"), artifactsDir: artifacts })
    assert.equal(await empty.collectArtifacts(), 0, "an empty ledger proves nothing about what is stale")
    await empty.dispose()
    const unreadable = path.join(base, "dir-as-ledger.jsonl")
    mkdirSync(unreadable)
    const failed = new SelectionHost({ verifier, selectionsFile: unreadable, artifactsDir: artifacts })
    await failed.collectArtifacts()
    assert.ok(existsSync(path.join(artifacts, "sel-precious")), "a failed load never turns into a purge")
    await failed.dispose()
    const off = new SelectionHost({ verifier, selectionsFile: null, artifactsDir: null })
    assert.equal(await off.collectArtifacts(), 0, "no artifact directory: a no-op")
    await off.dispose()
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test("selhost: the running row is persisted at start, so a crash mid-run leaves an attributable interrupted record", async () => {
  const { SelectionHost } = await import("../../lib/selection/host.js")
  const base = mkdtempSync(path.join(tmpdir(), "va-placeholder-"))
  try {
    const ledger = path.join(base, "selections.jsonl")
    const factory = makeFakeFactory({ scripts: { 0: { hang: true } } })
    const host = new SelectionHost({
      verifier: () => ({ model: "m", baseURL: "u", apiKeyEnv: "k" }),
      resolveKey: async () => "dummy",
      selectionsFile: ledger,
      testing: { factory, workspaces: realWorkspaces, bridge: fakeBridge() },
    })
    try {
      const started = await host.start({ problem: "task", candidateCount: 1 })
      const rows = readFileSync(ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      assert.equal(rows.length, 1)
      assert.equal(rows[0].selectionId, started.selectionId)
      assert.equal(rows[0].status, "running", "the admission claim is on disk before any candidate runs")
      // A reader that loads the ledger now (a replacement process) sees an
      // explained failure, not a gap.
      const reader = new SelectionHost({ verifier: () => ({ model: "m", baseURL: "u", apiKeyEnv: "k" }), selectionsFile: ledger })
      assert.equal(reader.getSelection(started.selectionId).status, "failed")
      assert.equal(reader.getSelection(started.selectionId).error, "interrupted-by-reload")
      await reader.dispose()
      const release = await waitFor(() => factory.handles[0]?.agent._release)
      release()
      const settled = await waitFor(() => { const s = host.getSelection(started.selectionId); return s && s.status !== "running" ? s : null })
      assert.equal(settled.status, "completed")
      const after = readFileSync(ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      assert.equal(after.length, 2, "the settled row is appended, not rewritten in place")
      assert.equal(after[1].status, "completed")
      const reloaded = new SelectionHost({ verifier: () => ({ model: "m", baseURL: "u", apiKeyEnv: "k" }), selectionsFile: ledger })
      assert.equal(reloaded.getSelection(started.selectionId).status, "completed", "the later settled row wins on reload")
      assert.equal(reloaded.listSelections().length, 1)
      await reloaded.dispose()
    } finally {
      await host.dispose()
      rmSync(base, { recursive: true, force: true })
    }
  } finally { rmSync(base, { recursive: true, force: true }) }
})
