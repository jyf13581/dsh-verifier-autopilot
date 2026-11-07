# API Boundary Decisions

> Current contract: 2026-08-31. HANDOFF.md is the operational authority; this file isolates API, credential, egress, admission, and lifecycle decisions. The superseded 2026-08-27 memo is preserved verbatim in docs/API-BOUNDARY-HISTORY-2026-08-27.md.

## Scope

This is a single-user local DSH plugin, not a shared or multi-tenant service. It has two coexisting surfaces:

- Candidate selection: manual POST /select plus internal autopilot admission from the source agent pre-step.
- Legacy single-trajectory verification: /verify, /probe, /eval, records, and feedback settings.

Legacy scores, feedback conversion, and repair fixtures are not selection efficacy evidence.

## API Prefix and Routes

Prefix: /@dsh-external/dsh-verifier-autopilot/api

| Method/path | Boundary |
|---|---|
| GET /state | Local read of config, legacy verifier state, and selection snapshot |
| POST /config | Mutating allowlisted config patch |
| POST /select | Manual diagnostic selection; 202 Accepted after Host admission |
| GET /selections | Read active, retained handles, and up to 20 recent records; optional selectionId query |
| POST /selections/cancel | Abort the one active selection |
| POST /selections/release | Dispose a retained live handle but keep session/workspace; returns released or not-retained |
| POST /selections/discard | Delete a discardable winner handle/session/workspace and append discardedAt |
| GET /events | Local SSE state stream |
| POST /verify, /probe, /eval; GET /records | Legacy verifier surface |

Autopilot does not call HTTP POST /select. It calls the same SelectionHost internally after pre-step admission.

## Authentication and Admission

- If DSH_VA_API_TOKEN is set, provider-spending and mutating POST requests require Authorization: Bearer <token>. The token is optional in the current local deployment. The panel prompts for it on the first 403 and keeps it in that browser's localStorage (review R1 1.3).
- Every POST route shares one admission gate: authorization, then `Sec-Fetch-Site: cross-site` → 403 `cross-site-request`, then a non-JSON content type → 415 `json-required`. No POST route can be driven as a cross-site simple request (review R1 1.6).
- Privileged config fields over HTTP (review R1 1.4/1.5): `selectionPostAuditTestCommand` (non-empty) and any `baseURL`/`apiKeyEnv` tuple outside the shipped endpoint presets fail with 403 `privileged-config-field:*` unless DSH_VA_API_TOKEN is configured and presented. The DSH settings service remains the trusted channel for these fields.
- Manual /select validates `sourceCwd` (existing absolute directory), `agentPreset`, `groundTruthNote`, `algorithmSeed`, `candidateProvider`/`candidateModel`, check `timeoutMs`, and criteria size (≤ 8 entries) before admission (review R1 1.7).
- One selection may be active per Host. A concurrent start fails with selection-busy (429).
- /select uses a sliding-window 12 admitted starts/hour limiter. Busy, malformed route, missing credential, and other pre-admission failures do not consume a start.
- Manual /select rejects the internal orchestration fields trigger, policy, and taskKind (`reserved-selection-field`); callers cannot opt into autopilot sandbox or retention/relay behavior.
- An explicit marginThreshold must be a finite JSON number in [0, 0.5]. Strings, null, non-finite values, and out-of-range values fail with `margin-threshold-invalid` rather than being coerced or clamped.
- /eval is limited to 120/minute; /probe and /verify to 60/minute.
- Config updates accept only the allowlisted schema in src/config.ts; timeout/model fields are range-validated before commit.

## Credentials and Egress

- The Host resolves the configured key. A key is never serialized in a JSONL request and is never returned by /state.
- The bridge starts the Python child with only the selected key copied into the child environment under apiKeyEnv.
- JSONL frames carry model, base_url, and api_key_env name, never the key value.
- Sidecar stderr is diagnostics-only; full trajectories and keys must not be logged.
- Endpoint validation and egress redaction remain part of the legacy and selector boundary. Unauthenticated HTTP callers are limited to the shipped endpoint tuples (see above); the settings service and token-authorized callers may configure any http(s) endpoint. There is no multi-user source authorization.
- Objective checks and the post-audit command run with credential-shaped environment variables (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_CREDENTIALS`, `*_AUTH*`) and the configured `apiKeyEnv` withheld (review R1 1.2). Candidate agents themselves run inside the DSH runtime and inherit its environment; see docs/reviews/R1-TRUST-BOUNDARY.md for that residual risk.

## Selection Boundary

Host responsibilities:

1. Resolve the source session/task/provider route and credential.
2. Enforce one-active admission and create a durable placeholder record.
3. Prepare isolated workspaces and wire real DSH child agents.
4. Run verifier preflight before child creation.
5. Collect candidate status, objective checks, trajectories, and lifecycle records.
6. Validate and persist the terminal selection result.

Python sidecar responsibilities:

1. Adapt select/progress/preflight to the upstream llm_verifier implementation.
2. Preserve native token-logprob/tag scoring; missing evidence is failure, not label fallback.
3. Use a per-run temporary cache required by the upstream ring/pivot algorithm, then delete it.
4. Process framed JSONL requests serially.

The bridge is lazy and long-lived: it starts on first request, restarts after request timeout/abort when routing safety requires it, and is reaped on plugin dispose/reload.

## Workspace Boundary

- Autopilot requires a uniquely resolvable Git repository and strict dirty-worktree snapshot. It must fail/fallback when source fidelity cannot be established.
- Manual diagnostics may run in a fresh empty non-Git workspace, but that mode does not mirror source files and must not be presented as autopilot fidelity.
- Candidate workspaces never share one mutable cwd. Git worktree preparation is sequential; child rollouts are parallel.
- Unknown ignored source/config input, path escape, unsafe symlink, or special untracked file fails strict snapshot.
- Objective checks run caller-supplied commands through the check-shell chain (pwsh when installed, else Windows PowerShell or /bin/sh) in the candidate cwd, with credential variables withheld. They are not a command allowlist sandbox; commands must remain self-contained and candidate-local.

## Result and Ranking Boundary

A terminal record carries selectionId, source provenance, every candidate session/workspace/status/check result, verifier model, timing, and an explicit winner basis when one exists.

- Multiple survivors require a genuine, structurally valid verifier ranking.
- A sole survivor may only be objective-check-only; an explicit N=1 manual run may be single-candidate.
- Missing logprob/tag evidence, malformed scores/ranking, zero comparisons, timeout, and exhausted transient retries fail closed.
- Relative scores are not calibrated probabilities.
- The selection record proves ranking and relay only. It does not prove that the source agent later integrated, tested, and delivered.

## Lifecycle Boundary

- Losers are disposed, their managed workspace is removed, and candidate session storage is purged best-effort after disposal.
- Manual winner live handles are disposed at finish; their session/workspace remain for inspection. Generic settlement notification is non-autopilot only.
- Autopilot winner handles remain temporarily available for the source relay and are automatically discarded on source idle, detach, or plugin dispose. Autopilot does not emit the generic settlement notice.
- /release only disposes a retained live handle. It is not artifact deletion and not an always-released response.
- /discard owns winner artifact/session deletion and records discardedAt; repeated discard returns no-discardable-winner.
- Historical manual workspaces have no blanket automatic GC. Cleanup requires ledger-aware review.

## Persistence Boundary

- SelectionHost keeps at most 200 records in memory and compacts selections.jsonl above 4MiB. Terminal records append once; discard appends a later record for the same selectionId, and load keeps the last occurrence. In-flight updates are emitted to subscribers but are not each persisted.
- A persisted running record loaded after reload is normalized to failed/interrupted-by-reload.
- Legacy records.jsonl is a separate 500-record/4MiB ledger. Do not mix it with selection evidence.

## Parked Decisions

The following remain intentionally out of scope for the local plugin unless it becomes shared infrastructure:

- DSH_VA_ALLOWED_HOSTS or a provider-host allowlist;
- Origin/Host policy and browser token injection;
- multi-user source authorization;
- a new cross-provider budget service;
- automatic candidate merge/test enforcement after the source turn;
- blanket deletion of historical winner/workspace artifacts.

## Evidence Rules

A current efficacy claim requires real candidates, isolated source-faithful workspaces, objective checks where applicable, valid target-library comparisons, a winner mapped to its real child session/workspace, source integration diff, tests, final source answer, and lifecycle cleanup. Route success, an offline test suite, a legacy five-lane score, or an older winner is not sufficient by itself.
