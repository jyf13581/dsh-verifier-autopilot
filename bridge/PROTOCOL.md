# LLM Verifier Sidecar Protocol

This document describes the JSON Lines protocol used by the llm_verifier_sidecar.py sidecar.

## Overview

The sidecar is a long-lived process that reads JSON Lines from stdin and writes JSON Lines to stdout.
Each request is a single JSON object terminated by a newline.
Each response is a single JSON object terminated by a newline.

Requests are processed serially in the order they are received.

## Request Frames

All requests must contain an `id` field (string) and a `type` field.

### Health Request

```json
{
  "id": "<unique string>",
  "type": "health"
}
```

Response: see [Health Response](#health-response).

### Select Request

```json
{
  "id": "<unique string>",
  "type": "select",
  "problem": "<string>",
  "candidates": ["<string>", ...],
  "criteria": <dict|list>,
  "ground_truth_note": "<string>|null",
  "n_evaluations": <integer >=1>,
  "pivots": <integer >=0>,
  "seed": <integer>,
  "effort": null | "off" | "low" | "high" | "max",
  "model": "<string>",
  "base_url": "<string>",
  "api_key_env": "<string>",  // name of environment variable containing the API key
  "cache": null,
  "on_error": "tie"|"raise",
  "max_workers": <integer>|null,
  "progress": false
}
```

- `problem`: The problem statement to evaluate.
- `candidates`: List of candidate solutions (non-empty strings).
- `criteria`: Either a dict mapping criterion ID to description, or a list of objects each with `id`, `name`, `description`.
- `ground_truth_note`: Optional note about ground truth (can be null).
- `n_evaluations`: Number of evaluations to run (>=1).
- `pivots`: Number of pivots for pairwise comparisons (>=0).
- `seed`: Random seed.
- `effort`: Verifier thinking strength. `null` keeps the sidecar process default (module fallback: the `DEEPSEEK_EFFORT` env, or `"off"`). A level applies to exactly this one request: the sidecar scopes `DEEPSEEK_EFFORT` around the call and restores it afterwards.
- `model`: Model name to use.
- `base_url`: Base URL of the OpenAI-compatible API endpoint.
- `api_key_env`: Name of the environment variable that holds the API key.
- `cache`: Must be null in requests. The sidecar still uses a per-run temp cache file internally: `select()` re-reads its score map through the cache across ring/pivot phases, so a null cache silently degrades ring aggregation (measured: exact 0.5 ties at pivots=0). The temp file is deleted after the run; nothing persists across requests, so model/endpoint cache-key obliviousness cannot cross-contaminate.
- `on_error`: How to handle errors during comparisons: "tie" (treat as tie) or "raise" (propagate error).
- `max_workers`: Maximum number of worker threads (null for default).
- `progress`: Must be false (progress reporting not implemented).

### Progress Request

```json
{
  "id": "<unique string>",
  "type": "progress",
  "problem": "<string>",
  "steps": ["<string>", ...],
  "model": "<string>",
  "base_url": "<string>",
  "api_key_env": "<string>",
  "n_evaluations": <integer >=1>,
  "effort": null | "off" | "low" | "high" | "max"
}
```

Online progress scoring (llm_verifier.track over a single final checkpoint):
"would the agent's CURRENT state already satisfy the task?" Response
`result` is `{ "score": <float 0..1>, "usage": {...} }` — score 0 = hopeless,
1 = essentially complete. Errors use the same codes as select
(invalid_request / missing_api_key / provider_error / timeout).

### Shutdown Request

```json
{
  "id": "<unique string>",
  "type": "shutdown"
}
```

Response: see [Shutdown Response](#shutdown-response).

## Response Frames

All responses contain the same `id` as the request (unless the request was malformed, then `id` is null).

### Success Response

```json
{
  "id": "<same as request>",
  "ok": true,
  "result": {
    "index": <integer>,  // index of the best candidate in the original candidates list
    "best_preview": "<string>",  // first 200 characters of the best candidate
    "scores": [<float>, ...],  // scores for each candidate (same order as input)
    "ranking": [<integer>, ...],  // ranking of candidate indices (0 = best)
    "n_comparisons": <integer>,  // number of comparisons performed
    "criteria": [<string>, ...],  // criterion IDs in the order of scores/ranking
    "usage": {
      "calls": <integer>,
      "input_tokens": <integer>,
      "cached_input_tokens": <integer>,
      "output_tokens": <integer>,
      "reasoning_tokens": <integer>,
      "cache_hit_rate": <float>,
      "uncached_input_tokens": <integer>
    }
  }
}
```

### Failure Response

```json
{
  "id": "<same as request, or null if malformed>",
  "ok": false,
  "error": {
    "code": "<string>",  // one of the error codes below
    "message": "<string>",  // <=500 characters, with API key redacted if present
    "retriable": <boolean>  // whether the request may be retried
  }
}
```

## Preflight (caller-side note)

The TS bridge offers `VerifierBridge.preflight()`: one tiny asymmetric pair must score strictly in favor of the present-output trajectory (mechanical + weak-semantic gate). Hosts memoize the pass per (baseURL, model, apiKeyEnv) and fail the selection before any candidate spend when it fails. This catches providers that return logprobs but never emit usable score tags — the residual case where scoring silently degenerates to 0.5 ties.

## Error Codes

- `bad_frame`: Malformed JSON line. `retriable`: false.
- `invalid_request`: Invalid request fields (missing, wrong type, etc.). `retriable`: false.
- `missing_api_key`: The API key environment variable is not set or empty. `retriable`: false.
- `client_init`: Failed to initialize the OpenAI client. `retriable`: false.
- `missing_logprobs`: The model response is missing score token logprobs (expected from the verifier relay). `retriable`: false.
- `timeout`: API request timed out. `retriable`: true.
- `provider_error`: Error from the API provider (e.g., 429, 500). `retriable`: true for 429 and >=500, false for other 4xx.
- `selection_failed`: Other unexpected error during selection. `retriable`: false.

## Notes

- The sidecar must be flagged for deepseek sampling: after creating the OpenAI client, set `client._llm_verifier_deepseek = True`.
- The verifier relay ignores the vLLM prefill/structured_outputs trick and emits `<score_A>`/`<score_B>` tags with full token logprobs.
- The sidecar does not print the API key or full trajectories; any trace text is truncated to 200 characters.
- On stdin EOF, the sidecar exits with status 0.

## Example Interaction

**Health request:**
```
{"id": "h1", "type": "health"}
```
**Response:**
```
{"id": "h1", "ok": true, "result": {"python": "3.11....", "llm_verifier_version": "0.2.0", "select_available": true, "note": "client must be deepseek-flagged: sampled score tags, no prefill support on this relay", "deepseek_effort": "off"}}
```

**Select request (single candidate, short-circuits):**
```
{"id": "s1", "type": "select", "problem": "What is 2+2?", "candidates": ["4"], "criteria": {"accuracy": "Is the answer correct?"}, "ground_truth_note": null, "n_evaluations": 1, "pivots": 0, "seed": 0, "model": "local-model", "base_url": "http://localhost:8000/v1", "api_key_env": "DUMMY_KEY", "cache": null, "on_error": "tie", "max_workers": null, "progress": false}
```
**Response (assuming API key env var DUMMY_KEY is set):**
```
{"id": "s1", "ok": true, "result": {"index": 0, "best_preview": "4", "scores": [1.0], "ranking": [0], "n_comparisons": 0, "criteria": ["accuracy"], "usage": {"calls": 0, ...}}}
```

**Shutdown request:**
```
{"id": "sh1", "type": "shutdown"}
```
**Response:**
```
{"id": "sh1", "ok": true, "result": {}}
```
Then the sidecar exits.
