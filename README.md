# @dsh-external/dsh-verifier-autopilot

DSH plugin for adaptive best-of-N candidate generation, objective filtering, verifier ranking, and source-agent finalization.

> Current status (2026-09-05): the full candidate-selection pipeline has completed live end to end. `sel-1b5c286c` (manual, N=2, K=1, P=0, effort=max, verifier=minimaxai/minimax-m3, 202 Accepted) ran workspaces → preflight → two real candidate rollouts → objective checks → verifier tournament (2 comparisons, winnerBasis=verifier, scores 0.4934/0.5066, winner=c1) → winner retained → operator discard 200, workspaces gone. Earlier same-day runs pin the two failure modes that used to block this: ranking under kimi-k3 at max effort exceeded its budget (`sel-7fad98df`), and the legacy 300s selection-time budget was too small even for minimax-m3 at max effort (`sel-ac011a39`) — the ceiling is now 600s. The discard path itself was broken by a foreign-git-repo lease-discovery bug and is fixed with a regression test. HANDOFF.md remains the authoritative takeover document.
>
> Current usable defaults: free Kimi relay at `https://chat.holisthoom.top/v1`, verifier `minimaxai/minimax-m3`, `selectionMode=auto`, and feedback off by default. Automatic selection uses a small `N=2/K=1/P=0` standard tournament (`deep` uses N=3 and at least K=2) so the source turn is not blocked by a long relay call. The larger N/K/P values remain explicit operator controls. `kimi-k3` and the older DeepSeek route remain selectable, but are not sensible max-effort defaults while their relay latency is unstable.

## Architecture

~~~text
source task
  -> autopilot admission and standard/deep N/K policy
  -> isolated Git worktrees and real child rollouts
  -> turn/timeout/progress/check elimination
  -> Kimi verifier preflight and strict ranking validation
  -> bounded winner/finalist evidence relayed to the original source agent
  -> source agent inspects, integrates, tests, and delivers
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
| candidate models | minimaxai/minimax-m3,nvidia/nemotron-3-super-120b-a12b,nemotron-3-ultra-550b-a55b,kimi-k3,deepseek-ai/deepseek-v4-pro-0813 (quality order) |
| standard / deep | N=2 / N=3 |
| evaluation rounds K | 1 by default; deep is clamped to at least 2 |
| pivot iterations P | 0 by default (higher values are explicit quality runs) |
| verifier effort (思考强度) | low by default for automatic runs (off/low/high/max), shared by lane and tournament verifiers |
| lane timeout / output cap | 180000ms / 8192 tokens (max) |
| autopilot candidate timeout | 300000ms |
| selection timeout | 600000ms, clamped to 30000..600000ms (ceiling raised 2026-09-05 for max-effort ranking) |
| verifier | minimaxai/minimax-m3 via https://chat.holisthoom.top/v1 and KIMI_API_KEY |
| verifier workers | 1 |

The source/finalizer model belongs to the original DSH session and is not fixed or recorded by the selection ledger. Historical 900000ms and preflight ranking failures used kimi-k3, not GPT.

## Important Contracts

- Autopilot requires a resolvable Git repository and an exact dirty-worktree snapshot. Unknown ignored source/config files fail instead of disappearing.
- Candidate rollouts are parallel; worktree preparation and objective checks are sequential.
- Caller-supplied checks run through pwsh in the candidate cwd. They are not a command allowlist sandbox, and Windows timeout does not kill grandchildren.
- Multiple survivors require a valid verifier ranking. A sole survivor is explicitly objective-check-only or single-candidate and gets no synthetic score.
- All intensity knobs are operator-settable in the GUI, settings, or POST /config. The usable automatic defaults are deliberately small: standard N=2/K=1/P=0, deep N=3/K>=2, verifier effort 'low', lane budget 180s/8192 tokens, and selection budget 600s. Raise N/K/P or effort for deliberate quality runs; the source turn is no longer held open while automatic selection completes.
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
- Mutating/provider-spending endpoints require Bearer DSH_VA_API_TOKEN when that environment variable is set.
- /select is limited to 12 admitted starts per sliding hour.

The conversation panel contains Verifier and Candidate selection tabs. Verifier exposes lanes 轮数 / 思考强度 / 输出上限 / 验证模型; Candidate selection exposes 模式、质量策略、普通/深档 N、评估轮数 K、枢轴迭代 P、思考强度、provider 与模型池（全部即改即存）。Autopilot starts selection in the background and immediately returns the source decision; a completed winner is appended later as a plugin relay, and source idle/detach/dispose owns winner cleanup. The authoritative GUI is the existing http://127.0.0.1:3080/ instance; do not start a replacement server.

## Build and Verification

~~~text
bash scripts/build.sh
npm test
D:/tools/pyvenvs/llm-verifier-bridge/Scripts/python.exe bridge/self_test.py
git diff --check
~~~

The test runner imports lib, so build first. With no DSH_CHECKOUT, scripts/build.sh uses installed-runtime fallbacks under D:/tools/dsh-plugins and the installed DSH root. The bridge venv has Python 3.12.13 and openai; the explicit system Python does not have openai.

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
