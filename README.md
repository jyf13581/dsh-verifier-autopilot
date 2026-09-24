# @dsh-external/dsh-verifier-autopilot

DSH plugin for adaptive best-of-N candidate generation, objective filtering, verifier ranking, and source-agent finalization.

> Domain status snapshot (2026-09-08): the 裁决9.8 evidence-semantics overhaul landed gate-green at that revision (191/191 tests). Selections now end in an explicit `outcome` state machine — `ranked_winner | objective_only_result | single_candidate_fallback | insufficient_evidence | abstain | verifier_unavailable` — guarded by a has-work gate (execution-class tool calls or a real worktree diff), a no-search-space dedupe, a **calibrated margin gate** (top-2 margin < 0.03 ⇒ abstain; 0.03 = 2.2× the measured identical-candidate noise ceiling, see below), and harness-error detection that stops broken check commands from eliminating candidates. Candidate models are probed for liveness before planning. A `single_candidate_fallback` is retained but never framed as a chosen best, and every outcome has its own relay contract. Every selection writes an audit pack under `.data/selection-artifacts/<id>/` (`record.json`, trajectories, and diffs) before any cleanup. Legacy five-lane citation audits now trust only prompt-visible evidence IDs, and trace compaction uses one shared 16000-char budget so the final answer cannot be truncated away.
>
> **Calibration round 1 (2026-09-08, `eval/calibration/run.mjs`, minimax-m3 @ effort=low, 36 select frames / 48 underlying calls, 0 failures):** C0 identical-pair noise sat at median 0.0039 / q95 0.0123 / max 0.0135 with **no positional bias** and no 0.5-pinning; C1 oracle-separated pairs (preflight good/bad, both orders) separated at margin ≈ 0.462 with 6/6 correct signs; C2 near pairs (5/5 vs 4/5 tests) separated at 0.31–0.42, 6/6 correct. The margin gate therefore moved 0.08 → **0.03** (still marked provisional until replicated across ≥5 fixtures). The relay's verifier does discriminate: same-candidate ≈ coin flip, real gaps ≈ 33× the noise floor.
>
> Live evidence boundary, kept honest: every pre-gate `winnerBasis=verifier` record sits inside the measured noise band (only sel-4fcbc905, margin 0.2985, clears even the old 0.08 bound). What is now proven: the pipeline cannot silently claim a winner from noise; what remains unproven: that its choices improve end-delivered quality on real tasks.
>
> Current usable defaults: free Kimi relay at `https://chat.holisthoom.top/v1`, verifier `nvidia/nemotron-3-super-120b-a12b`, and feedback off by default. The verifier route was re-probed on 2026-09-13 (HTTP 200, protocol tags + logprobs, ~6s per call); `z-ai/glm-5.3-flash` was retired as a default because at `effort=max` its reasoning phase ran for minutes and starved the lane deadline. Both verifier and candidate model IDs are operator-editable; the candidate provider catalog is discovery metadata, while configured custom IDs are probed directly. Automatic selection uses a small `N=2/K=1/P=0` standard tournament (`deep` uses N=3 and at least K=2) so the source turn is not blocked by a long relay call. The larger N/K/P values remain explicit operator controls.
>
> **Relay account-pool execution (2026-09-16):** the relay assigns its upstream accounts PER REQUEST round-robin, so plugin-side concurrency is what actually engages the pool — a serial verifier chain always hits "the current account" and stalls whole when it is rate-limited. Three knobs now implement the parallel/smooth/tiered model: `selectionVerifierWorkers` (tournament ThreadPool concurrency; `0`=auto 4 — concurrent calls land on independent accounts, call-count identity `calls = nComparisons × criteriaCount × K` unaffected), `verifierMinIntervalMs` (token-bucket dispatch spacing shared by the five-lane verifier and the tournament sidecar, `0`=off), and `verifierSmallModel` (mechanical session lanes — completion/evidence — run a cheap tier like `nvidia/nemotron-3-ultra-550b-a55b`; adversarial/repair lanes and the tournament keep the main model). Inside the tournament the sidecar also retries each HTTP 429 up to twice with small backoffs: the round-robin has already advanced, so the retry lands on a different account instead of waiting for the stuck one.

> **Architecture/build review (2026-09-21):** Host configuration, evidence, persistence, lifecycle, transport, wire contracts, and boundary utilities now live in focused modules. The locked Ubuntu CI builds both Host and browser bundles and runs all 203 regressions. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for dependency rules, persistence semantics, and the change-location guide.

## Architecture

~~~text
source task
  -> autopilot admission and standard/deep N/K policy (task kind classification filters status reports)
  -> isolated Git worktrees and real child rollouts
  -> turn/timeout/progress/check elimination (shell-parse errors never eliminate)
  -> has-work gate: code/file tasks need exec-class tool calls or a real diff
  -> no-search-space dedupe when survivors produce identical diffs
  -> Kimi verifier preflight and strict ranking validation
  -> margin gate: noise-band ties abstain; only a cleared margin is a winner
  -> outcome-labeled relay to the original source agent (winner / fallback / abstain / insufficient_evidence)
  -> source agent inspects, integrates, tests, and delivers
  -> autopilot winner/fallback audited (HEAD before/after) and cleaned on source idle/dispose
~~~

The plugin does not merge candidate files by itself. It injects a finalizer contract into the original source turn. Candidate workspaces and excerpts are untrusted evidence.

Two paths coexist:

- Candidate selection: src/selection/{autopilot,candidates,host,live,bridge,retry,trajectory,checks}.ts plus bridge/llm_verifier_sidecar.py.
- Legacy single-trajectory verifier/feedback: verifyFive, /verify, /probe, /eval, autoFeedback, and records.jsonl. Legacy lane scores and fixtures are not candidate-ranking evidence.

## Current Defaults

| Setting | Value |
|---|---|
| selectionMode | auto |
| candidate provider | kimi |
| candidate model strategy | quality-first (default); exploration is explicit opt-in |
| candidate models | nvidia/nemotron-3-super-120b-a12b (default; quality order is fully operator-editable; custom IDs are probed directly even when absent from `/models`) |
| standard / deep | N=2 / N=3 |
| evaluation rounds K | 1 by default; deep is clamped to at least 2 |
| pivot iterations P | 0 by default (higher values are explicit quality runs) |
| verifier effort (思考强度) | low by default for automatic runs (off/low/high/max), shared by lane and tournament verifiers |
| lane timeout / output cap | 180000ms / 64000 tokens by default (configurable up to 65536) |
| autopilot candidate timeout | 600000ms |
| selection timeout | 600000ms, clamped to 30000..600000ms (ceiling raised 2026-09-05 for max-effort ranking) |
| verifier | nvidia/nemotron-3-super-120b-a12b via https://chat.holisthoom.top/v1 and KIMI_API_KEY |
| selection verifier workers | `0` = auto 4 (explicit range 1..16) |
| margin gate | 0.03 (`selectionMarginThreshold`, range 0..0.5; calibration round 1, still provisional) |
| candidate model probing | on (`selectionProbeEnabled`) — dead catalog entries are dropped before planning |
| source post-audit tests | off (`selectionPostAuditTestCommand`, default empty) |

The source/finalizer model belongs to the original DSH session and is not fixed or recorded by the selection ledger. Historical 900000ms and preflight ranking failures used kimi-k3, not GPT.

## Important Contracts

- Autopilot requires a resolvable Git repository and an exact dirty-worktree snapshot. Unknown ignored source/config files fail instead of disappearing. Admission refuses status reports and session-control messages; the task kind (code-change / analysis-text) is classified deterministically at admission and stored in the record.
- Candidate rollouts are parallel; worktree preparation and objective checks are sequential.
- Caller-supplied checks run in the candidate cwd through the first shell of the platform chain that starts (`pwsh` where installed, else Windows PowerShell on win32 or `/bin/sh` elsewhere); each result records which shell ran. They are not a command allowlist sandbox, and a timeout does not kill grandchildren. A check whose shell could not start, or failed to parse the command (harness error), is marked invalid and never eliminates a candidate.
- Selections conclude with exactly one `outcome`: `ranked_winner` (margin cleared the gate), `objective_only_result` (verifier unavailable, strictly ordered by passing checks), `single_candidate_fallback` (one survivor, never compared — retained but never called a winner), `insufficient_evidence` (survivors without verifiable work), `abstain` (margin inside the noise band), or `verifier_unavailable` (infrastructure failure with full objective pass). Historical `winnerBasis=verifier` records predate this gate and are retrospectively abstains (only sel-4fcbc905, margin 0.2985, survives the provisional 0.08 gate).
- The margin gate is 0.03 (`selectionMarginThreshold`) after the first C0/C1/C2 calibration round and remains marked provisional pending broader fixtures; each record carries `margin`, `marginThreshold`, `marginCondition`, and `marginProvisional` so later reviews know exactly which gate produced the verdict.
- Analysis-text tasks have no deterministic evidence layer and are exempt from the has-work gate (capped at `llmOnly`, never `verified`); every other task that gets a worktree is held to executable evidence.
- Multiple survivors require a valid verifier ranking WITH a cleared margin. A sole survivor is an explicit fallback with no synthetic score and an explicitly different relay contract.
- Every settled selection and every discard writes an audit pack under `.data/selection-artifacts/<selectionId>/` BEFORE its workspace can be reclaimed: `record.json`, bounded candidate trajectories, captured diffs, the effective config snapshot (immune to later reload drift), margin/threshold/condition, outcome, and source-integration post-audit.
- All intensity knobs are operator-settable in the GUI, settings, or POST /config. The usable automatic defaults are deliberately small: standard N=2/K=1/P=0, deep N=3/K>=2, verifier effort 'low', lane budget 180s/64000 tokens, and selection budget 600s. Raise N/K/P or effort for deliberate quality runs; the source turn is no longer held open while automatic selection completes.
- verifierEffort reaches BOTH verifier paths: lane calls carry thinking/reasoning_effort fields (off explicitly disables), and the selection sidecar scopes DEEPSEEK_EFFORT per request (never leaks across requests).
- Preflight and ranking each use their own absolute deadline derived from the same normalized timeout value; transient retries are capped at two attempts.
- Manual and autopilot winners have different lifecycle rules. See HANDOFF.md §2.5 before changing cleanup code.
- Scores are relative tournament strength, not calibrated probabilities.
- In quality-first mode, every candidate uses the first available model in the configured quality order; exploration is the explicit heterogeneous-rotation mode. The Kimi `/models` probe on 2026-08-31 returned `deepseek-ai/deepseek-v4-pro-0813`; `z-ai/glm-5.2` remains registered but is not in the default pool.

## API and UI

API prefix: /@dsh-external/dsh-verifier-autopilot/api

- POST /select starts a manual diagnostic selection; autopilot starts internally from pre-step.
- GET /selections lists active, retained handles, and recent records.
- POST /selections/cancel, /release, and /discard manage lifecycle.
- GET /state and /events drive the GUI.
- Mutating/provider-spending endpoints require Bearer DSH_VA_API_TOKEN when that environment variable is set (the panel prompts for it once). Every POST requires a JSON content type and refuses `Sec-Fetch-Site: cross-site`.
- Without a token, HTTP cannot set `selectionPostAuditTestCommand` or point `baseURL`/`apiKeyEnv` outside the shipped endpoint presets; use the DSH settings service for those.
- /select is limited to 12 admitted starts per sliding hour.

The conversation panel contains Verifier and Candidate selection tabs. Verifier exposes lanes 轮数 / 思考强度 / 输出上限 / 验证模型; Candidate selection exposes 模式、质量策略、普通/深档 N、评估轮数 K、枢轴迭代 P、思考强度、provider 与模型池（全部即改即存）。Autopilot starts selection in the background and immediately returns the source decision; a completed winner is appended later as a plugin relay, and source idle/detach/dispose owns winner cleanup. The authoritative GUI is the existing http://127.0.0.1:3080/ instance; do not start a replacement server.

## Build and Verification

~~~text
npm ci --force --ignore-scripts
npm run check:architecture
npm run typecheck
npm run build:host
npm run build:client
npm test
python3 bridge/self_test.py
git diff --check "$(git merge-base origin/main HEAD)" HEAD
~~~

The test runner imports `lib`, so build both targets first. Tests live in `scripts/tests/<domain>.test.mjs` (one process per file; run one with `node --test scripts/tests/<domain>.test.mjs`). Published DSH release-candidate peer ranges currently conflict; the complete lockfile plus `--force` is intentional and is validated in CI. `scripts/build.sh` remains the installed-DSH packaging route with host-specific fallbacks; `build:host` plus `build:client` is the portable repository build. Provider-backed sidecar selection additionally needs the optional `llm_verifier` environment; offline protocol gates report its absence transparently. In the real bridge venv, run `DSH_VA_REQUIRE_LLM_VERIFIER=1 python bridge/self_test.py` (using that venv's Python) so a missing or broken provider installation is a hard failure rather than an optional skip.

Client HMR requires a running pnpm run dev:web watcher from the DSH source checkout. No watcher is currently running, so client changes require build, plugin reload, and a GUI refresh.

## Evidence Boundary

- 2026-09-05 update: intensity knobs (rounds / iterations / model / thinking effort) are operator-settable; the first genuine multi-survivor verifier ranking completed (`sel-cd6590de`), followed by a full manual real-work run (`sel-1b5c286c`: two candidates wrote and verified `result.txt`, objective checks passed, ranking separated 0.4934/0.5066, winnerBasis=verifier, discard clean). This revision also makes the usable free Kimi defaults persistent in source, enables autopilot by default, gates noisy feedback on independent tool evidence, and runs autopilot selection in the background so source turns are not blocked. The new automatic source integration path still needs a fresh live fixture; historical records are not upgraded into that claim.
- Current runtime state (2026-09-04): active=null, retainedWinners=[]. Ledger `.data/selections.jsonl` is 35 lines / 85944 bytes / 31 unique selection ids; `.data/selection-workspaces` holds 17 roots (12 non-empty).
- `sel-a79f6c44-502a-4264-a4d4-fbfaa4d46f23` (autopilot, standard N=2/K=2, both kimi-k3) is the one complete live closure: c0 hit `candidate-timeout`, c1 survived, and the source agent integrated the money-cents tool into `D:/tools/.autopilot-live-chain`, committed `3003e9f`, and `node --test` passes 8/8. The winner workspace was reclaimed by source-idle cleanup. Its `winnerBasis` is `single-candidate` with `nComparisons=0`, so it proves the finalizer chain, not ranking quality.
- `sel-52963163-c8a7-4077-bd1b-145c8f85e6c7` (same session, 43 minutes later) is the first run where both candidates finished, and it failed with `verifier selection exceeded its absolute budget` at `rankingAttempts=1` inside the 180s `selectionSelectTimeoutMs`. Multi-survivor ranking still has no success record.
- Earlier attempts `sel-5e84f540...` and `sel-bbc7de5a...` (2026-08-31) never reached ranking: one had its objective check invalidated by a malformed outer PowerShell command, the other had a candidate timeout plus a failed check.
- These are operational evidence, not a quality comparison: no heterogeneous run was started, GLM quota was untouched, and no model-quality uplift is proven.
- `sel-290185b9...` is a historical winner from an earlier runtime and cannot prove the current finalizer chain.
- Legacy stage4 and repair-v2 evidence is not Best-of-N acceptance evidence.
- Historical details are preserved verbatim in docs/HANDOFF-HISTORY-2026-08-30.md.

Read HANDOFF.md before implementation or live testing. It contains the exact model roles, workspace residue, ledger state, environment, evidence limits, and next-session procedure.
