# Margin calibration (ruling I.4)

`run.mjs` measures the verifier's margin distribution on fixed candidate pairs
through the production sidecar. The shipped `selectionMarginThreshold` (0.03,
provisional) rests on rounds 2–5 of the `kimi-k3@low` condition; graduation is
judged by `graduate.mjs` against `docs/MARGIN-GRADUATION-INVOICE.md` (C0 max,
cumulative frames, days, bias; the old q95 agreement rule is retired).

**Scope (review R3 3.1/3.2).** A round measures exactly one condition:
verifier model@effort, N=2, C=1 (`task_fidelity`), K=1, P=0, synthetic
300–700-char fixtures. That condition is the single entry in
`src/selection/calibration.ts`; runs under any other verifier, criteria count,
candidate count or real-trajectory inputs are recorded as `uncalibrated`. C0
compares a candidate with ITSELF, so (A,B) and (B,A) are the same prompt: it
measures sampling noise only and is structurally blind to order effects
between two different texts. See `docs/reviews/R3-EVIDENCE-VALIDITY.md`.

## Experiments

- **C0** — identical candidate vs itself at two fixed seeds. This is the
  zero-hypothesis noise floor: every margin here is pure verifier noise plus
  positional bias. A sane calibration requires the C0 maximum well below real
  margins, and the positional-bias mean near zero.
- **C1** — `PREFLIGHT_GOOD` vs `PREFLIGHT_BAD` (defined in
  `src/selection/bridge.ts`), both orders. The verifier must give the correct
  sign in essentially every run; less than 70% means the condition cannot rank
  at all, and the rule is to fix the ranking INPUT (deterministic evidence),
  not the model or effort.
- **C2** — "5/5 tests pass with tool evidence" vs "4/5 pass with one documented
  failure", both orders. Sets the discrimination floor: the smallest real gap
  whose margin still clears the C0 noise ceiling.

## Run

```bash
node eval/calibration/run.mjs
# knobs: CAL_MODEL (default kimi-k3), CAL_EFFORT (default low), CAL_C0_REPS,
#        CAL_LABEL, KIMI_BASE_URL (default: the plugin's baseURL)
node eval/calibration/graduate.mjs kimi-k3@low   # offline verdict
```

Requires `KIMI_API_KEY` (env, or the file named by `DSH_CREDENTIALS`, default
`~/.dsh/.credentials.yaml`). All calls go
through the real relay; they are logged one JSONL line per call to
`.data/calibration/<model@effort>.jsonl` and summarized to
`<condition>.summary.<label>.json` (with the full `conditionKey`). Failed calls are recorded and counted, never
silently retried.
