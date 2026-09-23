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

### Legacy verifier path

| Module | Responsibility |
| --- | --- |
| `src/host.ts` | Runtime lifecycle, session subscriptions, scheduling, state snapshots, feedback delivery, persistence, and ownership of `SelectionHost`. |
| `src/coordinator.ts` | Per-session ordering, deduplication, cancellation, and verification scheduling. |
| `src/evidence.ts` | Pure event rendering, task attribution, turn gates, trace compaction, and citation audits. |
| `src/verifier.ts` | Verifier prompts, lane calls, score parsing, aggregation, and feedback decisions. It compatibility-re-exports boundary helpers now owned by `src/util.ts`. |
| `src/api.ts` | HTTP/SSE transport only: routing, body parsing, rate limits, response serialization, and delegation to Host methods. |

### Best-of-N selection path

| Module | Responsibility |
| --- | --- |
| `src/selection/host.ts` | Selection lifecycle, single-run admission, history, audit artifacts, sidecar ownership, winner retention, and source-session settlement. |
| `src/selection/autopilot.ts` | Admission policy and bounded task/context planning for automatic selection. |
| `src/selection/candidates.ts` | Candidate runner and selection state machine. |
| `src/selection/live.ts` | Live DSH candidate adapters and isolated Git-worktree management. |
| `src/selection/trajectory.ts` | Candidate trajectory rendering plus shared context/handoff bounding. The candidate runner depends here rather than back on autopilot orchestration. |
| `src/selection/checks.ts` | Objective repository/check execution and normalization. |
| `src/selection/bridge.ts` | Framed subprocess client for the Python verifier sidecar. |
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
       └─ selection/host
            ├─ candidates / autopilot / live / checks / trajectory
            ├─ bridge / retry / probe
            └─ ledger

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
4. **`constants.ts`, `util.ts`, `ledger.ts`, and `evidence.ts` remain
   dependency-light.** They are reusable boundaries, not alternate composition
   roots.
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
   schema so defaults cannot drift between composition and settings paths.

A cycle is a design signal. Move a shared shape to `protocol.ts`, a generic
boundary helper to `util.ts`, or a persistence primitive to `ledger.ts` rather
than introducing a reciprocal import. `npm run check:architecture` parses the
TypeScript module graph, rejects runtime **and type-only** cycles, and enforces
these layer restrictions in CI.

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

## 7. Lifecycle, cancellation, and secrets

`VerifierHost.start()` idempotently establishes subscriptions and scheduling;
`dispose()` is the ownership boundary that cancels in-flight work and disposes
the selection host. A disposed Host cannot be restarted. Selection disposal
must terminate sidecars, candidates, retained handles, and isolated workspaces. API disconnects and configured timeouts should flow
through existing abort signals instead of creating detached promises.

Credential references cross configuration and API boundaries; credential
values do not. Resolve them at the last responsible moment through
`resolveKey()`. Pass normalized provider URLs through `normalizeBaseUrl()` and
sanitize operator-visible errors with `redactSecrets()`. Logs, API errors,
records, audit packs, tests, and fixtures must contain neither live keys nor
internal endpoint credentials.

The Python verifier dependency is optional. Health reporting must truthfully
expose whether selection is available. Missing `llm_verifier` may disable
provider-backed comparison, but it must not make offline Host startup or the
sidecar's deterministic protocol gates dishonest.

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
  directions, and rejects runtime or type-only module cycles.
- `typecheck`: strict Host and client TypeScript checking without emit.
- `build:host`: emits Node modules, source maps, and declarations to `lib/`.
- `build:client`: bundles `src/client/index.ts` as the DSH browser module in
  `lib/client.js`; it deliberately does not clean Host output.
- `npm test`: deterministic Node regression suite over emitted modules,
  including evidence, verifier, API, Host, ledger, and selection behavior.
- `bridge/self_test.py`: offline framing, validation, shutdown, retry, and
  optional-provider gates for the Python boundary. Set
  `DSH_VA_REQUIRE_LLM_VERIFIER=1` in the real bridge venv to require provider
  availability and the provider-specific mojibake gate.
- `git diff --check "$(git merge-base origin/main HEAD)" HEAD`: whitespace/EOL
  guard over the committed change range. A bare `git diff --check` in a clean
  checkout checks nothing.

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
| Sidecar protocol | `src/selection/bridge.ts` + `bridge/llm_verifier_sidecar.py` | `bridge/self_test.py`, retry tests |
| History format/compaction | `src/ledger.ts` | Both Hosts, migration/reload tests |
| Credential/URL/redaction behavior | `src/util.ts` | Compatibility export and boundary tests |
| Browser presentation only | `src/client/index.ts` | Client build; no server-domain import |
| Public package surface | `src/index.ts` | Declaration build and compatibility review |
| Build or dependency policy | `package.json`, lockfile, CI | Architecture/README when workflow changes |

Before merging, inspect `git status --short` and the staged file list. A normal
architecture change must not include secrets, internal addresses, `.data`,
worktrees, bytecode, `node_modules`, or generated `lib` output.
