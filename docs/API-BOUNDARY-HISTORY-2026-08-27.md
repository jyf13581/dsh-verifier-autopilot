# API Boundary Decisions 历史快照（2026-08-27）

> 归档说明：以下内容逐字保留自重写前的 API-BOUNDARY-DECISIONS.md。它记录迁移期设计，不是当前 API 契约；现行边界见 ../API-BOUNDARY-DECISIONS.md 和 ../HANDOFF.md。

# API Boundary Decisions

> Status: legacy boundary memo parked outside the current efficacy path. The current product target is DSH best-of-N candidate selection; this file must not drive new security or API work during that migration.

## Current Demo Boundary

This is a single-user local DSH demo. The current checked-in plugin has legacy provider-spending routes and optional boundary checks, but it is not a shared service or multi-tenant API.

Keep the existing implementation behavior stable until the selector migration replaces the old routes. Do not add a new auth model, permission system, budget framework, host allowlist or browser security layer as part of candidate selection.

Existing legacy facts:

- The plugin resolves a configured credential and sends a trajectory to a configured OpenAI-compatible `baseURL`.
- Basic egress redaction and HTTP(S) validation already exist in the old implementation.
- `DSH_VA_API_TOKEN` is optional and is not set in the recorded local environment.
- The old `/config`, `/verify`, `/eval` and `/probe` routes are legacy routes. If they remain during migration, label them legacy and do not use them as selector evidence.
- The old rate limits, `allowLabelFallback`, `divergenceGuard` and `autoFeedback` settings do not define the new selection contract.

## Candidate Selector Boundary (implemented 2026-08-27)

The selector has one narrow API boundary, now live:

- Host owns candidate creation, session/workspace provenance, artifact/check collection and child lifecycle.
- Python sidecar owns the call to `llm_verifier.select()` and its native score/cache/error semantics (cache disabled in v1).
- DSH sends the model and endpoint configuration per request; the API key is injected into the sidecar's process environment at spawn — never serialized into a JSONL frame.
- The sidecar never logs API keys or full trajectories; stderr is diagnostics-only.
- A missing token-level logprob is a provider/selection failure, not a label-only success. On this relay the client runs deepseek-flagged because the vLLM prefill trick is unsupported (measured: unconstrained continuations, letter mass ~0).
- Candidate count N, `n_evaluations`, `pivots` and concurrency are selector parameters, unrelated to legacy `routes=5`.
- Admission: one active selection per host (`selection-busy` 429), 12 starts/hour rate limit, DSH_VA_API_TOKEN gating when configured.
- Runs abort cleanly on cancel, dispose and plugin reload: candidates disposed, loser workspaces removed, sidecar reaped.

Implemented `POST /select` input (202 Accepted; body subset):

~~~json
{
  "sourceSessionId": "session-...",
  "candidateCount": 3,
  "problem": "optional; falls back to the source session's latest direct user task",
  "criteria": [{"id": "correctness", "name": "Correctness", "description": "..."}],
  "checks": [{"name": "smoke", "command": "pwsh -Command ...", "timeoutMs": 15000}],
  "nEvaluations": 1,
  "pivots": 1,
  "algorithmSeed": 0,
  "candidateTimeoutMs": 900000,
  "selectTimeoutMs": 300000
}
~~~

Status/history: `GET /selections(?selectionId=)`; control: `POST /selections/cancel`, `POST /selections/release`.

Implemented selection result:

- `selectionId`;
- source session and parent provenance;
- candidate id/session/workspace for every candidate;
- candidate completion state and objective check results;
- winner index and winner session/workspace;
- scores, ranking, `n_comparisons`, model and timing;
- provider/bridge error when no reliable winner exists.

Empty, single-candidate, duplicate-candidate, partial-failure, cancellation and no-logprob behavior must be explicit and tested. Do not turn failed comparisons into evidence without recording the target library `on_error` behavior.

## Workspace Boundary

Candidate coding runs never share a mutable `cwd`. Implemented semantics (IsolatedWorkspaceManager): when the source cwd is inside a git worktree, candidates get detached git worktrees of it; otherwise each candidate gets a fresh empty directory under .data/selection-workspaces/<selectionId>/c<i> and the run record marks the workspace as such. Each candidate's own directory keeps the trajectory↔artifact correspondence intact, which is the correctness requirement.

Deliberate divergence from the earlier "stop if not isolatable" stance: a fresh directory keeps isolation, so the run continues; what is forbidden is two candidates sharing one mutable directory. Non-git source workspaces therefore do NOT share the source file state with candidates (a fidelity limitation, recorded, not hidden).

Losers: workspace removed + agent disposed at selection end; winners: both retained until `/selections/release` or plugin dispose.

## Python Sidecar Boundary

Use the existing Python package rather than translating it into TypeScript:

- Target library: `D:/tools/llm-as-a-verifier-main`.
- Entry behavior: `llm_verifier.select(problem, candidates, criteria=..., model=..., client=...)`.
- Environment mapping: DSH endpoint to `OPENAI_BASE_URL`; resolved key to `OPENAI_API_KEY`.
- Required response shape: nested token logprobs with score-token positions, as required by the target library.
- Sidecar transport: long-lived framed JSONL over stdin/stdout, with request id and one response per request.
- Sidecar lifecycle: start with the plugin, stop on plugin dispose/reload, report process exit and stderr as diagnostics.
- Cache: isolate by model, endpoint and criteria/prompt version, or disable it during the first smoke.

Current environment prerequisite:

- Explicit Python: `D:/tools/python/cpython-3.12.13-windows-x86_64-none/python.exe`.
- uv: `D:/tools/uv/uv.exe`.
- `openai` is not installed in the explicit Python yet.
- The NVIDIA endpoint `https://chat.holisthoom.top/v1` and model `nvidia/nemotron-3-super-120b-a12b` have only legacy probe evidence; the Python selector path still needs a one-pair live smoke.

## Parked Decisions

The following old proposals are explicitly deferred and must not expand this demo:

- `DSH_VA_ALLOWED_HOSTS` baseURL allowlist;
- Origin/Host checks;
- GUI token injection;
- an independent `/eval` auth or quota tier;
- multi-user or multi-tenant source authorization;
- additional per-provider budget accounting or GUI token-authentication plumbing.

These can be reconsidered only if the product becomes a shared service. They do not improve candidate ranking or winner quality for the current one-user demo.

## Evidence Rules

Do not use these as new selector efficacy evidence:

- old `strictReady` probe;
- old `verifyFive` route scores;
- old mean/median/dispersion or divergence guard;
- old `[Verifier feedback]` conversion;
- `repair-v2` trigger/repair rates;
- fixture results such as 4/4, 0/3 or the 99/99 regression count.

New evidence must show real candidates, isolated workspaces, objective checks, target-library selection output and a winner that maps to the correct DSH child session. No security decision is complete merely because a route returns 403, and no efficacy claim is complete merely because a test suite passes.
