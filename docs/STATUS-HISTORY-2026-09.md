# Status history (moved out of README.md by review R7, 2026-10-09)

> Verbatim copies of the dated status snapshots, the hand-written defaults table, and the
> Evidence Boundary section that README.md carried until review R7. They are records of what was
> true (or believed) on their dates, not current facts: counts, defaults and live state below are
> superseded. Current defaults are generated from the code (README.md, `scripts/doc-facts.mjs`);
> current test counts come from CI. See docs/reviews/R7-DOCS-PRODUCT-DIRECTION.md for why.

## Status snapshots (README.md lines 5–15 until R7)

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

## Hand-written defaults table (as of R6, before generation)


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
| margin gate | 0.03 (`selectionMarginThreshold`, range 0..0.5; provisional, calibrated only for kimi-k3@low, N=2, C=1, K=1, P=0 on synthetic fixtures) |
| uncalibrated margin condition | `flag` (`selectionUncalibratedMarginPolicy`; `abstain` refuses a verifier winner whenever the run's condition is not in `src/selection/calibration.ts`) |
| candidate model probing | on (`selectionProbeEnabled`) — dead catalog entries are dropped before planning |
| source post-audit tests | off (`selectionPostAuditTestCommand`, default empty) |

The source/finalizer model belongs to the original DSH session and is not fixed or recorded by the selection ledger. Historical 900000ms and preflight ranking failures used kimi-k3, not GPT.

## Evidence Boundary (README.md until R7)


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
