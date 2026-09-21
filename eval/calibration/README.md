# Margin calibration (ruling I.4)

`run.mjs` measures the verifier's margin distribution on fixed candidate pairs
through the production sidecar, so the provisional `selectionMarginThreshold`
(default 0.08) can be replaced with an observed per-condition noise quantile.

## Experiments

- **C0** — identical candidate vs itself at two fixed seeds. This is the
  zero-hypothesis noise floor: every margin here is pure verifier noise plus
  positional bias. A sane calibration requires `q95(C0)` well below real
  margins, and the positional-bias mean near zero.
- **C1** — `PREFLIGHT_GOOD` vs `PREFLIGHT_BAD` (defined in
  `src/selection/bridge.ts`), both orders. The verifier must give the correct
  sign in essentially every run; less than 70% means the condition cannot rank
  at all, and the rule is to fix the ranking INPUT (deterministic evidence),
  not the model or effort.
- **C2** — "5/5 tests pass with tool evidence" vs "4/5 pass with one documented
  failure", both orders. Sets the discrimination floor: the smallest real gap
  whose margin still clears C0's q95.

## Run

```bash
node eval/calibration/run.mjs
# knobs: CAL_MODEL, CAL_EFFORT (default low), KIMI_BASE_URL
```

Requires `KIMI_API_KEY` (env or `~/.dsh/.credentials.yaml`). All calls go
through the real relay; they are logged one JSONL line per call to
`.data/calibration/<model@effort>.jsonl` and summarized to
`<condition>.summary.json`. Failed calls are recorded and counted, never
silently retried.
