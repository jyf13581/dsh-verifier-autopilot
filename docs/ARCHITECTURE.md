# Architecture

This document is the change map for `@dsh-external/dsh-verifier-autopilot`. It
explains where behavior belongs, which dependency directions are allowed, and
which boundaries must remain explicit when the plugin evolves.

## 1. System shape

The package contains two related but deliberately separate workflows:

1. **Legacy verification** observes a completed source-session turn, extracts
   bounded evidence, asks independent verifier lanes to score it, records the
   result, and may post corrective feedback into that same source session.
2. **Best-of-N selection** runs isolated candidate agents, captures their
   trajectories and repository evidence, checks and compares the candidates,
   retains a winner when the result is decisive, and reports settlement back to
   the source session.

`src/index.ts` is the composition root. It preserves the DSH plugin metadata
exports (`name`, `inject`, and `apply`), constructs one `VerifierHost`, installs
settings, and registers the routes produced by `src/api.ts`.

The browser is a separate bundle. It communicates with the Host only through
HTTP/SSE contracts declared in `src/protocol.ts`; it never imports Host or API
implementation code.

## 2. Module map

### Shared and composition modules

| Module | Responsibility |
| --- | --- |
| `src/index.ts` | Public package entry, plugin metadata, dependency injection, settings and route registration. |
| `src/constants.ts` | Dependency-free cross-layer invariant constants. |
| `src/config.ts` | Config schema, schema-derived defaults, validation, settings-source hooks, and config-owned policy primitives. No selection/runtime lifecycle dependency. |
| `src/protocol.ts` | Canonical Host/client wire types, structural web transport types, API prefix, and model catalog. |
| `src/util.ts` | Dependency-light boundary helpers: credentials, API-key resolution, base-URL normalization, and secret redaction. |
| `src/ledger.ts` | Shared versioned JSONL reading/appending/compaction and same-directory atomic replacement. |
| `src/diagnostics.ts` | Bounded, redacted degradation ledger (warnings ring + counters). Every layer reports its best-effort failures here; the snapshot rides in `/state`. Leaf: imports only `util`. |
| `src/dsh-context.ts` | Runtime-checked views of the DSH/cordis contexts the plugin is handed: the hook surface (`on`), an agent's scoped context (`get`, session append), and the one `create` call into the agent registry. Type predicates, no casts. Leaf: imports nothing. |
| `src/payload.ts` | Checked readers for schemaless JSON (`read`, `readArray`, `readString`, `isRecord`) and the one declared session-event shape (`EventRecord`, `data?: unknown`) that evidence, coordinator, and selection trajectories share. Every read is total and returns `unknown`; no payload field is ever reached through `any`. Leaf: imports nothing. |

### Legacy verifier path

| Module | Responsibility |
| --- | --- |
| `src/host.ts` | Runtime lifecycle, session subscriptions, scheduling, state snapshots, feedback delivery, persistence, and ownership of `SelectionHost`. |
| `src/coordinator.ts` | Per-session ordering, deduplication, cancellation, and verification scheduling. `ScheduledEvent` is the shared `EventRecord`; the coordinator never reads payloads. |
| `src/evidence.ts` | Pure event rendering, task attribution, turn gates, trace compaction, and citation audits. Reads event payloads only through `payload.ts`, tolerant of every persisted shape. |
| `src/verifier.ts` | Verifier prompts, lane calls, score parsing, aggregation, and feedback decisions. It compatibility-re-exports boundary helpers now owned by `src/util.ts`. |
| `src/api.ts` | HTTP/SSE transport only: routing, body parsing, rate limits, response serialization, and delegation to Host methods. |

### Best-of-N selection path

| Module | Responsibility |
| --- | --- |
| `src/selection/host.ts` | Selection lifecycle, single-run admission, history, audit artifacts, sidecar ownership, winner retention, and source-session settlement. |
| `src/selection/autopilot.ts` | Admission policy and bounded task/context planning for automatic selection. |
| `src/selection/candidates.ts` | Candidate runner and selection state machine. |
| `src/selection/live.ts` | Live DSH candidate adapters and isolated Git-worktree management (prepare, remove, enumerate). |
| `src/selection/proc.ts` | Bounded child-process runner shared by the Git helpers and the check harness: capped output (head or tail), timeout/abort with kill escalation, flush-bounded completion, spawn failure distinct from exit. Leaf: imports Node only. |
| `src/selection/trajectory.ts` | Candidate trajectory rendering plus shared context/handoff bounding. The candidate runner depends here rather than back on autopilot orchestration. |
| `src/selection/checks.ts` | Objective check execution and normalization. Resolves one shell per process from a platform chain (`pwsh`, then Windows PowerShell or `/bin/sh`); a shell that cannot start, a command it cannot parse (parse-only probe in a temp dir), or a leading program that does not resolve is a harness error, never evidence against a candidate; output text is never classified (review R2 2.2). |
| `src/selection/bridge.ts` | Framed subprocess client for the Python verifier sidecar, and the only place a sidecar frame becomes a typed value: `parseHealthResult` / `parseSelectResult` / `parseProgressResult` / `parseErrorFrame` (malformed shape → `bridge_protocol`). |
| `src/selection/retry.ts` | Bounded retry policy for transient bridge failures. |
| `src/selection/probe.ts` | Availability/capability probing. |
| `bridge/llm_verifier_sidecar.py` | JSON-lines process boundary around the optional Python `llm_verifier` library. |

### Browser path

| Module | Responsibility |
| --- | --- |
| `src/client/index.ts` | UI, API calls, SSE refresh, and operator actions. Shared state/selection/model types come from `src/protocol.ts`; no duplicate handwritten wire models belong here. |
| `tsdown.config.ts` | Browser bundle wrapper and external dependency policy. |

## 3. Dependency rules

The intended runtime dependency graph is acyclic and points inward toward pure,
shared modules:

```text
index
  ├─ config
  ├─ api ───────────────┐
  └─ host               │
       ├─ coordinator   │
       ├─ evidence      ├─> protocol (types/constants only)
       ├─ verifier      ├─> util
       ├─ ledger        │
       ├─ diagnostics ──┤ (protocol imports its snapshot type only)
       └─ selection/host
            ├─ candidates / autopilot / live / checks / trajectory
            ├─ bridge / retry / probe
            └─ ledger / diagnostics

client ─────────────────────> protocol
```

Follow these rules:

1. **`index.ts` composes; it does not implement domain behavior.** Keep plugin
   exports stable and add public re-exports intentionally.
2. **`api.ts` depends on Host interfaces, never the reverse.** The Host must be
   usable in tests without an HTTP server.
3. **`protocol.ts` must not import Host, API, or browser runtime modules.** Its
   domain imports are type-only so the browser cannot pull Node code into the
   bundle.
4. **`constants.ts`, `util.ts`, `ledger.ts`, `payload.ts`, and `evidence.ts`
   remain dependency-light.** They are reusable boundaries, not alternate
   composition roots (`evidence.ts` imports only `constants` and the payload
   readers at runtime).
5. **Selection implementation must not depend on legacy-verifier scheduling or
   feedback internals.** Integration happens through `VerifierHost` ownership,
   shared utilities/persistence, and typed snapshots.
6. **Use `import type` across domain boundaries whenever only shape is needed.**
   An erased type edge must not become an accidental runtime cycle.
7. **The client consumes the protocol, not server classes.** Never recreate
   the API prefix, `State`, `LaneView`, `SelectionView`, request, or response
   interfaces in the browser module.
8. **Config owns config policy types and defaults.** Selection may consume
   `AutopilotMode` and `CandidateModelStrategy`; config must not import the
   selection implementation. `DEFAULT_CONFIG` is derived from the Schemastery
   schema so defaults cannot drift between composition and settings paths, and
   `validateConfigPatch()` reads field kinds, numeric bounds, integrality, and
   union choices from the same schema: a bound lives in exactly one place.
   Per-key string policy (URL egress rules, env-var grammar, length caps) is
   the only validation that stays hand-written, because it is policy, not
   shape.
9. **`diagnostics.ts` is a leaf, and "best-effort" means "reported", not
   "silent".** Every layer (Host, selection, sidecar bridge) writes into the
   same bounded `Diagnostics` sink, so the sink may import only `util.ts` /
   `constants.ts` — an import in the other direction would make the failure
   reporter depend on the code that fails. A `catch` that swallows an error on
   a path the operator cannot otherwise observe (ledger append, artifact
   write, loser cleanup, progress sample, notice/relay delivery, sidecar
   exit, verifier retry) must call `diagnostics.warn(scope, error, detail)`.
   Two exceptions are deliberate: subscriber-loop catches inside `emit()` only
   `count()`, because a warning notifies subscribers and would re-enter the
   loop; and shutdown-path catches (`dispose()`) stay quiet, because the
   snapshot can no longer be read. Messages are redacted and length-bounded
   before they are stored, consecutive identical entries coalesce into a
   count, and the ring evicts oldest-first, so the sink can never grow without
   bound or leak a credential into `/state`.
10. **`selection/proc.ts` is a leaf.** `live.ts` (worktrees, diffs) and
    `checks.ts` (objective checks) both spawn processes and must not depend on
    each other, so the one bounded runner they share may import Node only.
    Anything that needs a child process with a timeout, an output cap, or a
    spawn-failure distinction uses `runProcess()`; the `execCapture` streaming
    helper in `live.ts` is the single deliberate exception (it streams a
    tracked file list from stdin and returns raw bytes for shell-free diffs).

11. **Type seams are declared once and checked at runtime, never cast.**
    Four kinds of value enter the plugin without a compile-time type: DSH
    contexts and agents (DSH augments the cordis event map and brands its
    identifiers at link time, which this build does not see), sidecar frames
    (JSON Lines from a Python process), provider bodies (`fetch().json()`),
    and session event payloads (persisted logs span schema versions:
    source-less user messages, `message` vs `content` bodies). Each has
    exactly one narrowing point: `dsh-context.ts` type predicates
    (`isHookSource`, `isAgentScope`, `requireHookSource`) for contexts,
    `bridge.ts` frame parsers (`parseHealthResult`, `parseSelectResult`,
    `parseProgressResult`, `parseErrorFrame`) for the sidecar — a shape the
    protocol does not allow is a `bridge_protocol` error, never a `TypeError`
    inside a mapping — `validateConfigPatch()` for configuration, which
    builds an untyped record against the schema-derived field table and takes
    the `Config` type in one documented place, and the `payload.ts` readers
    for event `data` and provider bodies, which are `unknown` from the first
    line and stay `unknown` until a call site says what it expects (a
    malformed logprob entry is `missing_score_logprobs`, not a `TypeError`
    retried as `request_failed`). A cast through `never` or `unknown`
    (`x as never`, `x as unknown as T`) re-opens a seam at an arbitrary call
    site with no check behind it, and an explicit `any` anywhere — a cast, a
    type argument such as `Record<string, any>`, a parameter or property
    annotation — turns every later read into an unchecked one; the
    architecture gate rejects every occurrence of either in `src/`. Narrow
    with a predicate, a parser, or a reader, or widen the declared interface
    (as `HostContext.agents.create` and `SelectionsAgentProvider` were) so the
    structural types actually meet.

A cycle is a design signal. Move a shared shape to `protocol.ts`, a generic
boundary helper to `util.ts`, or a persistence primitive to `ledger.ts` rather
than introducing a reciprocal import. `npm run check:architecture` parses the
TypeScript module graph, rejects runtime **and type-only** cycles, enforces
these layer restrictions, and rejects blind casts and explicit `any` (rule 11)
in CI.

## 4. Evidence boundary: verification is not selection

The two workflows can inspect the same task but answer different questions.
Their evidence and conclusions must not be mixed.

### Legacy verification

The input is an already completed source-session turn. `evidence.ts`:

- attributes the current direct human task;
- removes injected plumbing and historical verifier verdict text;
- numbers visible evidence;
- compacts the trace under one shared budget while retaining late tool evidence;
- records which evidence IDs survived compaction; and
- audits defect citations against only that visible set.

`verifier.ts` scores that bounded trace. `host.ts` may post feedback only after
its independent-evidence, citation, quota, and suppression gates allow it.
A legacy record describes a source turn; it does not describe candidate
competition or establish a winning workspace.

### Best-of-N selection

The input is a task plus bounded source context. Candidates run through
isolated agent/workspace handles. Selection evidence can include trajectories,
objective checks, Git state, diff summaries, and captured patches. The Python
sidecar compares candidate outputs; the TypeScript runner owns admission,
timeouts, cancellation, state transitions, and winner-retention policy.

A selection may end without a retained winner. A fallback ranking, unavailable
optional provider, failed check, insufficient margin, timeout, or cancellation
must remain visible as such; none may be relabeled as a verified winner.

### Integration boundary

The Host may start selection before ordinary work or expose it through a manual
route, and selection settlement may be posted back to the source session. That
coordination does **not** make candidate trajectories valid legacy-turn
citations, nor does a legacy aggregate validate a candidate workspace. Preserve
separate record types, ledgers, gates, and audit artifacts.

## 5. Host/client wire contract

`src/protocol.ts` is the single source of truth for:

- `/state` snapshots;
- `/selections` list and item responses;
- verification records;
- config, verification, and selection request/response bodies;
- minimal `WebRequest`, `WebResponse`, and `WebRoute` shapes; and
- the API prefix and model catalog displayed by the client.

Both snapshot producers (`VerifierHost.snapshot()` and
`SelectionHost.snapshot()`) and the browser consumer must use these shared
contracts. The structural web types keep `api.ts` type-safe without coupling it
to one concrete HTTP server implementation.

### Changing a field or endpoint

1. Add or change the canonical request/response shape in `protocol.ts`.
2. Update the Host/selection producer and normalization at the domain boundary.
3. Update route parsing and status/error mapping in `api.ts`.
4. Update `src/client/index.ts` by importing the shared type; do not add a local
   mirror interface.
5. Add regression coverage for malformed input, the successful response, and
   any persistence/reload behavior.
6. Run both the Node TypeScript build and the browser build. A Host-only
   typecheck is not enough to prove the wire contract remains consumable.

When adding a public protocol export, re-export it from `src/index.ts` if package
consumers need it. Do not remove an existing package-entry export as collateral
for an internal refactor.

`SelectionStartRequest` intentionally excludes `trigger`, `policy`, and
`taskKind`. Those are trusted Host orchestration metadata; the manual HTTP route
rejects them so a caller cannot opt itself into autopilot retention/relay rules.

The model catalog uses complete endpoint tuples (`id`, `baseURL`, `apiKeyEnv`,
`note`). Selecting a model must replace the whole tuple so credentials or URLs
cannot silently leak across providers.

## 6. Persistence contract

Verifier and selection histories use the helpers in `src/ledger.ts`.

### JSONL format

Each new line is a complete JSON object with a top-level version stamp:

```json
{"id":"example","v":1}
```

Current rules:

- `LEDGER_VERSION` is `1`.
- On disk, rows are oldest to newest; in memory, histories are newest first.
- Readers accept legacy unstamped rows for migration compatibility.
- Readers reject unknown future versions rather than guessing.
- Blank, malformed, torn, or schema-invalid rows are skipped so one bad tail
  cannot prevent Host startup.
- Selection ledgers can deduplicate by ID; the last valid row for an ID wins.
- Persisted selection IDs must match the path-safe `sel-*` identifier grammar
  before they can address an audit-pack directory.
- Histories are bounded and oversized files are compacted from the current
  in-memory view.

Changing the persisted shape requires a deliberate version/migration decision,
a validator update, and tests for both old and new rows. Do not silently change
the meaning of an existing `v:1` field.

### Atomic replacement

Compaction and standalone audit artifacts use `atomicWriteFile()`:

1. create a uniquely named sibling temporary file;
2. write the complete UTF-8 content;
3. rename it over the destination; and
4. best-effort remove the temporary file on error.

Using a sibling is important: rename atomicity is only dependable within the
same filesystem. Callers must not hand-roll direct truncating rewrites for
ledger compaction or selection audit files. Normal JSONL additions use one
append operation per encoded row; startup still tolerates a torn final row.

Runtime state belongs under `.data/` and is ignored. It must never be committed.

### Storage lifecycle

Nothing under `.data/` is append-only forever; every artifact is bound to a
record that can still reach it.

- **Selection audit packs** (`selection-artifacts/<selectionId>/`) live exactly
  as long as their record is in the history window (the newest
  `SELECTIONS_HISTORY_LIMIT` records). A record outside the window can no
  longer be listed, discarded, or relayed, so its pack is unreachable evidence.
  `SelectionHost.collectArtifacts()` removes packs — directories and the legacy
  flat `<id>.json` — whose id is not in the window; it runs after a successful
  ledger load and whenever a new run evicts a record. A ledger that could not
  be read proves nothing about what is stale, so a failed or empty load never
  collects. Only entries shaped like a selection id are considered; anything
  else in the directory is not the host's to touch.
- **Candidate directories** (`selection-workspaces/<selectionId>/c<i>`) are
  removed when a loser is disposed or a winner is discarded. Directories a dead
  process left behind are handled by `reclaimOrphanWorkspaces()` at Host start,
  under two rules: a directory whose record is in the window is reclaimed
  unless it is that record's retained (`discardedAt` unset) winner/fallback
  slot or the selection is running; a directory with **no** record is reported
  (`workspaces.unknown`) and never deleted, because it may be a retained manual
  winner whose record aged out, and deleting an operator's live worktree is the
  one outcome worse than a leak. The manager only ever enumerates the
  `sel-*/c<i>` shape it creates, so enumeration can never widen removal.
- **The running row is persisted at admission**, not only at settlement. A
  process that dies mid-run leaves an `interrupted-by-reload` record on the
  next load, so the gap is explained and the orphaned directories are
  attributable to a known selection.

## 7. Lifecycle, cancellation, and secrets

`VerifierHost.start()` idempotently establishes subscriptions and scheduling;
`dispose()` is the ownership boundary that cancels in-flight work and disposes
the selection host. A disposed Host cannot be restarted. Selection disposal
must terminate sidecars, candidates, retained handles, and isolated workspaces. API disconnects and configured timeouts should flow
through existing abort signals instead of creating detached promises: the
provider-spending routes (`/eval`, `/probe`) derive an abort signal from the
response's `close` event, so a caller that hangs up stops the lane fan-out
instead of leaving it to run to completion.

The autopilot pre-step sits on the source turn's critical path. Work there is
bounded and concurrent: the preferred pool is probed in parallel (one probe
timeout at worst, never one per model), concurrent probes of the same model
share one request, and the wait is abort-aware so a cancelled turn stops
waiting immediately while late verdicts still populate the prober cache.

Five concurrency and evidence invariants are pinned by regression tests and
must survive future refactors:

1. **Admission claims are atomic.** In `SelectionHost.start()` everything that
   can throw or await (validation, credential resolution, factory/runner
   construction, the source HEAD read) happens *before* the busy re-check; from
   the claim of `this.active` to `this.active.run = run` the code is
   synchronous and cannot fail. A refused start therefore never leaves a
   `running` placeholder or a claim that no run will ever clear.
2. **Retained-candidate operations are serialized per selection.** `release`,
   `discard`, and shutdown disposal go through one FIFO per selection ID, so
   concurrent callers (GUI double-click, idle racing `agent/disposed`,
   `dispose()` during a discard) observe sequential semantics: one worktree
   removal, one journal purge, and the second discard answers `false`.
3. **Autopilot cleanup is fenced per source session.** `VerifierHost` runs at
   most one `cleanupAutopilotWinners` pass per source at a time; triggers that
   arrive mid-pass request exactly one follow-up pass instead of a concurrent
   one, so the post-audit (including the configured test command in the user's
   repository) never executes twice for the same retained slot.
4. **Progress samples are serialized per run.** The sidecar is one serial
   pipe, so `SelectionRunner` feeds progressGuard samples through a run-scoped
   FIFO with at most one pending sample per candidate: never more than one
   `progress` frame is in flight, a slow verifier cannot push the tail frame
   past the bridge timeout (which would tear the sidecar down for everyone),
   and every live candidate is still sampled in turn.
5. **Evidence capture never mutates the evidence.** `gitDiffFull` records its
   intent-to-add entries in a scratch `GIT_INDEX_FILE` copy; the candidate's
   real index, `git status`, and the retained winner's worktree stay exactly as
   the candidate left them.

A runner must also treat an already-aborted signal as an abort *before* it
provisions anything: `abort` events do not replay, and a selection started
after its host was cancelled must not create worktrees or agents.

Credential references cross configuration and API boundaries; credential
values do not. Resolve them at the last responsible moment through
`resolveKey()`. Pass normalized provider URLs through `normalizeBaseUrl()` and
sanitize operator-visible errors with `redactSecrets()`. Logs, API errors,
records, audit packs, tests, and fixtures must contain neither live keys nor
internal endpoint credentials. On the transport, every unexpected failure
leaves through one helper (`internalFailure`): a JSON 500 whose message is
redacted and bounded. Routes answer with typed codes for expected conditions
and never forward a raw `error.message`.

The Python verifier dependency is optional. Health reporting must truthfully
expose whether selection is available. Missing `llm_verifier` may disable
provider-backed comparison, but it must not make offline Host startup or the
sidecar's deterministic protocol gates dishonest. The bridge measures each
spawn's warm-up (spawn to first answered frame, via a bridge-internal health
probe that is never counted as a caller's request) into the
`sidecar.warmups` / `sidecar.warmup_ms` counters and warns once per slow spawn
(`sidecar.warmup`, above 10 s) or when the sidecar reports
`select_available=false` (`sidecar.select_unavailable`).

Portability is a boundary, not an afterthought. The objective-check harness
names no shell at its call sites: `checks.ts` resolves the first startable
shell from `defaultCheckShells(platform)` (`pwsh` everywhere it exists, then
Windows PowerShell on win32 or `/bin/sh` elsewhere), records which shell ran
on every result, and treats "no shell could start" as a harness error for
every check — the candidate is kept with `checksInvalid`, exactly like a
command the shell could not parse. Tests write their check fixtures in the
dialect of whichever shell won, so the same suite runs on a pwsh-less runner
and a Windows workstation.

Degradation is observable. Best-effort paths keep their contract (a failed
ledger append, a stuck loser worktree, a dead sidecar, an undeliverable relay
never fail the operation that owns them) but they report into the shared
`Diagnostics` sink: a ring of the last 200 warnings (consecutive repeats
coalesced, one scope capped at a fifth of the ring, redacted and bounded text)
plus monotonic counters. `VerifierHost.snapshot()` carries the snapshot, so
`/state` and the `/events` stream expose it, and the panel shows it in a
folded "诊断" section. The Host subscribes to the sink: every new warning
pushes a state frame to connected panels, while counters stay silent so they
are safe to bump from inside `emit()` and snapshot paths. The browser panels
consume `/events` as their primary feed and keep polling only as the initial
load, the no-stream fallback, and a slow (15 s) reconciliation sweep.

## 8. Build and test topology

Use the locked dependency graph. Published DSH release-candidate packages have
incompatible peer ranges, so CI intentionally asks npm to honor the complete
lock with `--force`:

```sh
npm ci --force --ignore-scripts
npm run check:architecture
npm run typecheck
npm run build:host
npm run build:client
npm test
python3 bridge/self_test.py
git diff --check "$(git merge-base origin/main HEAD)" HEAD
```

What each gate covers:

- `check:architecture`: parses project imports, enforces allowed layer
  directions, rejects runtime or type-only module cycles, and rejects blind
  casts (`as never`, `as unknown as`) and explicit `any` anywhere in `src/`.
- `typecheck`: strict Host and client TypeScript checking without emit.
- `build:host`: emits Node modules, source maps, and declarations to `lib/`.
- `build:client`: bundles `src/client/index.ts` as the DSH browser module in
  `lib/client.js`; it deliberately does not clean Host output.
- `npm test`: deterministic Node regression suite over emitted modules, one
  file per domain under `scripts/tests/` (layout below). `node --test` runs
  every file in its own process, so a leaked timer, handle, or rejection is
  attributable to one domain, and a single file runs alone with
  `node --test scripts/tests/<domain>.test.mjs`.
- `bridge/self_test.py`: offline framing, validation, shutdown, retry, and
  optional-provider gates for the Python boundary. The frame-level gates are
  the `conformance` cases of `bridge/protocol-fixtures.json`. Set
  `DSH_VA_REQUIRE_LLM_VERIFIER=1` in the real bridge venv to require provider
  availability and the provider-specific mojibake gate.
- `git diff --check "$(git merge-base origin/main HEAD)" HEAD`: whitespace/EOL
  guard over the committed change range. A bare `git diff --check` in a clean
  checkout checks nothing.

### Test layout

```text
scripts/tests/
  evidence.test.mjs          trace rendering, evidence ids, citation audit, turn gating
  verifier-scoring.test.mjs  prompt protocol, score-tag parsing, effort, feedback math
  verifier-lanes.test.mjs    lane retry taxonomy, redaction on egress, workers, smoothing
  host.test.mjs              VerifierHost lifecycle, coordinator seam, record persistence
  api.test.mjs               route validation, rate-limit buckets, probe, disconnects, 500s
  config.test.mjs            settings-source sync, schema-derived patch validation
  repair-v2.test.mjs         preregistered eval tooling (eval/repair-v2.mjs)
  bridge.test.mjs            sidecar framing (stub + real, offline), parsers, retry, preflight
  selection-runner.test.mjs  candidate batch: checks gate, winner gate, progress guard, cleanup
  selection-host.test.mjs    /select admission, options, snapshots, discard, audit packs
  autopilot.test.mjs         admission policy, route planning, prober, pre-step lifecycle
  workspaces.test.mjs        isolated Git workspaces, snapshots, orphan reclamation
  storage.test.mjs           settlement ledger, running rows, artifact GC
  process-checks.test.mjs    bounded process runner, check shell chain, portability
  diagnostics.test.mjs       degradation sink, redaction, /events, leaf boundary
  payload.test.mjs           checked JSON readers: total reads, array/string narrowing
  helpers/                   harness (timing, rejection collector), provider (mocked
                             verifier), host (fake DSH context), selection (fake
                             factories/bridges, real workspaces), sidecar, git
  fixtures/stub_sidecar.py   protocol-conformant stub sidecar (answers from the fixtures)
```

Helpers are plain functions with no registration side effects, with two
documented exceptions: `helpers/harness.mjs` installs an unhandled-rejection
collector that records the reason **and** fails the file, and
`helpers/selection.mjs` creates one temp workspace root per process and
removes it at exit.

### Sidecar protocol fixtures

`bridge/protocol-fixtures.json` is the single source for the wire protocol's
canonical frames. Three consumers read it: `bridge/self_test.py` drives its
`conformance` cases through the real sidecar; `scripts/tests/fixtures/stub_sidecar.py`
answers with its `responses`/`errors` frames; and `scripts/tests/bridge.test.mjs`
asserts that the TypeScript bridge emits exactly the `requests` frames (via the
stub's echo file), parses every canonical response, rejects every
`malformed_results` entry as `bridge_protocol`, and that `PROTOCOL.md`'s error
codes and request/result keys match the fixtures and `SIDECAR_ERROR_CODES`.
A protocol change is therefore made in the fixture and the document first, and
each side of the pipe fails until it follows.

Some regression fixtures invoke PowerShell and require `pwsh`. Run the complete
suite on the Ubuntu CI image when a local environment lacks it. The historical
`scripts/build.sh` remains the installed DSH packaging path and may depend on
host-specific dependency locations; use `build:host` plus `build:client` for a
portable repository build.

Generated `lib/`, `node_modules/`, Python bytecode/cache directories, `.data/`,
selection workspaces, and transient sidecar output are not source artifacts and
must remain untracked.

## 9. Where should a change go?

| Change | Primary location | Usually also update |
| --- | --- | --- |
| Config field/default/validation | `src/config.ts` | `protocol.ts`, client UI, Host wiring, tests |
| New HTTP endpoint | `src/protocol.ts` + `src/api.ts` | Host method, client, route tests |
| `/state` or `/selections` field | `src/protocol.ts` | Both producer and consumer, persistence if durable |
| Event filtering or evidence budget | `src/evidence.ts` | Evidence/citation regression tests |
| Verifier prompt, parser, lane score, feedback math | `src/verifier.ts` | Host integration and tests |
| Session scheduling or plugin lifecycle | `src/host.ts` / `src/coordinator.ts` | `src/index.ts` only for composition |
| Candidate policy/admission | `src/selection/autopilot.ts` | Selection Host and policy tests |
| Candidate execution/state transition | `src/selection/candidates.ts` | Live adapters and selection tests |
| Git workspace or live agent behavior | `src/selection/live.ts` | Cleanup/cancellation tests |
| Objective check | `src/selection/checks.ts` | Request validation and audit output |
| Sidecar protocol | `bridge/protocol-fixtures.json` + `bridge/PROTOCOL.md` first, then `src/selection/bridge.ts` + `bridge/llm_verifier_sidecar.py` | `bridge/self_test.py`, `scripts/tests/bridge.test.mjs`, the stub sidecar |
| DSH context shape (hooks, agent registry, scoped services) | `src/dsh-context.ts` | `HostContext` in `host.ts`, live adapter in `selection/live.ts` |
| Reading a new field from event payloads or provider bodies | the call site, via `src/payload.ts` readers | `EventRecord` in `payload.ts` only if the envelope changes; tolerance tests in the reading domain |
| History format/compaction | `src/ledger.ts` | Both Hosts, migration/reload tests |
| Credential/URL/redaction behavior | `src/util.ts` | Compatibility export and boundary tests |
| Browser presentation only | `src/client/index.ts` | Client build; no server-domain import |
| Public package surface | `src/index.ts` | Declaration build and compatibility review |
| Build or dependency policy | `package.json`, lockfile, CI | Architecture/README when workflow changes |

Before merging, inspect `git status --short` and the staged file list. A normal
architecture change must not include secrets, internal addresses, `.data`,
worktrees, bytecode, `node_modules`, or generated `lib` output.
