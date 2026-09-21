"""llm-verifier selection sidecar (DSH bridge, protocol v1).

Long-lived worker spawned by the DSH plugin host. Speaks framed JSON Lines
over stdin/stdout: one request per line, exactly one response line per
request, serial in arrival order. stdout carries response frames ONLY;
diagnostics go to stderr. The API key never appears on stdout/stderr.

Protocol: see bridge/PROTOCOL.md.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from typing import Any, Dict, List, NoReturn, Optional

os.environ.setdefault("DEEPSEEK_EFFORT", "off")

try:
    import llm_verifier
    from llm_verifier.fine_grained_reward import (
        MissingAPIKeyError, USAGE, create_openai_client)
except ImportError as exc:  # fatal: nothing to do without the library
    print("llm_verifier import failed: %s" % exc, file=sys.stderr)
    sys.exit(1)

# --- mojibake-tolerant tag distribution lookup (kimi-k3 over this relay) ----
# kimi-k3's stream never materialises a '<' before the score tag: the tag
# arrives as bare tokens 'score' '_A' '>' (evidence: _trace-dump probe
# probe_k3_tokens.py, K3 native logprobs 20 alts/position). The library's
# suffix matcher keys on '<score_A>' and therefore misses, silently dropping
# to literal letter parsing (single draw, no expectation). Patch: when the
# stock lookup misses, accept the tag's INNER name at a non-'<' boundary —
# '<' or '/' immediately preceding means the CLOSING tag and is skipped —
# and read the token distribution right after it. Stock library behaviour is
# untouched whenever the '<'-formed tag is present.
import re as _re

from llm_verifier import fine_grained_reward as _fgr

_ORIG_FIND_TAG_LOGPROBS = _fgr._find_tag_logprobs


def _find_tag_logprobs_tolerant(tokens, position_logprobs, tag):
    found = _ORIG_FIND_TAG_LOGPROBS(tokens, position_logprobs, tag)
    if found is not None:
        return found
    if not tokens or not position_logprobs:
        return None
    inner = tag.strip("<>").strip()  # e.g. 'score_A'
    if not _re.match(r"^score_[A-Za-z]$", inner):
        return None
    name = inner
    best = None
    text_so_far = ""
    for i, tok in enumerate(tokens):
        text_so_far += tok
        if not tok.strip():
            continue
        tail = text_so_far[-(len(name) + 16):]
        if _re.search(r"(?<![</A-Za-z_])" + _re.escape(name) + r">?\s*$", tail):
            if i + 1 < len(position_logprobs):
                best = position_logprobs[i + 1]
    return best


_fgr._find_tag_logprobs = _find_tag_logprobs_tolerant

MAX_MSG = 500

# --- relay account-pool resilience -------------------------------------------
# The operator's relay (chat.holisthoom.top) fronts a POOL of upstream NVIDIA
# accounts and assigns one PER REQUEST round-robin. Two consequences:
#   * concurrency spreads calls across independent accounts — one rate-limited
#     account stalls only its own call (max_workers > 1);
#   * a 429 on one call is recovered by an immediate small backoff retry: the
#     round-robin has already advanced, so the retry lands on a DIFFERENT
#     account instead of waiting for the stuck one to recover.
# _ResilientClient wraps the OpenAI client for exactly this per-call behaviour
# (bounded retries + optional dispatch spacing) without touching the library.

import threading as _threading
import time as _time


def _sleep_ms(ms: float) -> None:
    _time.sleep(max(0.0, ms) / 1000.0)


def _is_rate_limited(exc: BaseException) -> bool:
    """429 detection that works with real openai errors and test fakes."""
    status = getattr(exc, "status_code", None)
    if isinstance(status, int) and status == 429:
        return True
    try:
        import openai as _openai
        if isinstance(exc, _openai.RateLimitError):
            return True
    except Exception:
        pass
    return False


class _ResilientClient:
    """Drop-in wrapper: client.chat.completions.create gains bounded per-call
    429 retries with small backoffs, plus an optional min-interval dispatch
    smoother (token bucket). Unknown attributes delegate to the base client."""

    def __init__(self, base, min_interval_ms: int = 0, call_retries: int = 2):
        self._base = base
        self._min_interval_ms = max(0, int(min_interval_ms))
        self._call_retries = max(0, min(5, int(call_retries)))
        self._lock = _threading.Lock()
        self._last_dispatch = 0.0
        self.chat = _ResilientChat(self)

    def __getattr__(self, name):
        # Instance attributes (e.g. the _llm_verifier_deepseek flag) resolve
        # normally; everything else delegates to the wrapped client.
        return getattr(self.__dict__["_base"], name)

    def _pace_dispatch(self) -> None:
        """Token bucket: serialise dispatches so they land >= min_interval_ms
        apart (self-inflicted bursts are a common rate-limit trigger)."""
        if self._min_interval_ms <= 0:
            return
        while True:
            with self._lock:
                now = _time.monotonic()
                earliest = self._last_dispatch + self._min_interval_ms / 1000.0
                if now >= earliest:
                    self._last_dispatch = now
                    return
                wait = earliest - now
            _time.sleep(min(wait, 0.25))

    def create_completion(self, **kwargs):
        self._pace_dispatch()
        attempts = self._call_retries + 1
        for attempt in range(attempts):
            try:
                return self._base.chat.completions.create(**kwargs)
            except Exception as exc:
                if attempt + 1 >= attempts or not _is_rate_limited(exc):
                    raise
                # Round-robin has moved on: retrying re-enters the relay on a
                # different account. Small, fixed backoffs keep it bounded.
                _sleep_ms(300.0 if attempt == 0 else 900.0)


class _ResilientChat:
    def __init__(self, owner: "_ResilientClient"):
        self._owner = owner
        self.completions = _ResilientCompletions(owner)


class _ResilientCompletions:
    def __init__(self, owner: "_ResilientClient"):
        self._owner = owner

    def create(self, **kwargs):
        return self._owner.create_completion(**kwargs)

# Verifier thinking strength ('思考强度'). A request may pin it via its
# per-request "effort" field; absent means the process env decides. The
# plugin default is "max" (plugin-side config default), so this module-level
# fallback only guards bare direct calls.
EFFORT_LEVELS = ("off", "low", "high", "max")


def _write(frame: Dict[str, Any]) -> None:
    """Emit one response frame; stdout is response-only."""
    sys.stdout.write(json.dumps(frame) + "\n")
    sys.stdout.flush()


def _error(req_id: Optional[str], code: str, message: str,
           retriable: bool, secret: Optional[str] = None) -> None:
    msg = message[:MAX_MSG]
    if secret and secret in msg:
        msg = msg.replace(secret, "[REDACTED]")
    _write({"id": req_id, "ok": False,
            "error": {"code": code, "message": msg, "retriable": retriable}})


def _ok(req_id: Optional[str], result: Dict[str, Any]) -> None:
    _write({"id": req_id, "ok": True, "result": result})


def _handle_health(req_id: Optional[str]) -> None:
    _ok(req_id, {
        "python": sys.version,
        "llm_verifier_version": getattr(llm_verifier, "__version__", "unknown"),
        "select_available": True,
        "note": ("client must be deepseek-flagged: sampled score tags, "
                 "no prefill support on this relay"),
        "deepseek_effort": os.environ.get("DEEPSEEK_EFFORT"),
    })


def _require(cond: bool, message: str) -> None:
    if not cond:
        raise ValueError(message)

def _validate(req: Dict[str, Any]) -> Dict[str, Any]:
    """Type-check a select frame; raises ValueError on any violation."""
    v: Dict[str, Any] = {}
    v["problem"] = req.get("problem")
    _require(isinstance(v["problem"], str) and bool(v["problem"]),
             "problem must be a non-empty string")
    candidates = req.get("candidates")
    _require(isinstance(candidates, list) and len(candidates) >= 1,
             "candidates must be a list of >=1 strings")
    for i, c in enumerate(candidates):
        _require(isinstance(c, str) and bool(c),
                 "candidates[%d] must be a non-empty string" % i)
    v["candidates"] = candidates
    criteria = req.get("criteria")
    _require(isinstance(criteria, (dict, list)) and bool(criteria),
             "criteria must be a non-empty dict or list")
    v["criteria"] = criteria
    note = req.get("ground_truth_note")
    _require(note is None or isinstance(note, str),
             "ground_truth_note must be a string or null")
    v["ground_truth_note"] = note
    for name, lo in (("n_evaluations", 1), ("pivots", 0), ("seed", None)):
        val = req.get(name)
        _require(isinstance(val, int) and not isinstance(val, bool),
                 "%s must be an integer" % name)
        if lo is not None:
            _require(val >= lo, "%s must be >= %d" % (name, lo))
        v[name] = val
    for name in ("model", "base_url", "api_key_env"):
        val = req.get(name)
        _require(isinstance(val, str) and bool(val),
                 "%s must be a non-empty string" % name)
        v[name] = val
    _require(req.get("on_error") in ("tie", "raise"),
             "on_error must be 'tie' or 'raise'")
    v["on_error"] = req.get("on_error")
    mw = req.get("max_workers")
    _require(mw is None or (isinstance(mw, int) and not isinstance(mw, bool)
                            and mw >= 1),
             "max_workers must be null or an integer >= 1")
    v["max_workers"] = mw
    effort = req.get("effort")
    _require(effort is None or
             (isinstance(effort, str) and effort in EFFORT_LEVELS),
             "effort must be null or one of off|low|high|max")
    v["effort"] = effort
    mim = req.get("min_interval_ms", 0)
    _require(isinstance(mim, int) and not isinstance(mim, bool) and mim >= 0,
             "min_interval_ms must be an integer >= 0")
    v["min_interval_ms"] = mim
    cr = req.get("call_retries", 2)
    _require(isinstance(cr, int) and not isinstance(cr, bool) and 0 <= cr <= 5,
             "call_retries must be an integer in [0, 5]")
    v["call_retries"] = cr
    return v


def _validate_effort(value):
    _require(value is None or
             (isinstance(value, str) and value in EFFORT_LEVELS),
             "effort must be null or one of off|low|high|max")
    return value


class _effort_scoped:
    """Temporarily point DEEPSEEK_EFFORT at the request's effort level.

    llm_verifier.deepseek_reasoning_params() re-reads the environment on every
    verifier call, so the request-scoped override covers the whole comparison
    fan-out WITHOUT leaking into the next request (or the health probe)."""

    def __init__(self, effort):
        self.effort = effort
        self.previous = None

    def __enter__(self):
        if self.effort is None:
            return
        self.previous = os.environ.get("DEEPSEEK_EFFORT")
        os.environ["DEEPSEEK_EFFORT"] = self.effort

    def __exit__(self, *exc):
        if self.effort is None:
            return
        if self.previous is None:
            os.environ.pop("DEEPSEEK_EFFORT", None)
        else:
            os.environ["DEEPSEEK_EFFORT"] = self.previous

def _map_exception(exc: BaseException) -> "tuple[str, bool]":
    """Map a library/provider failure to (code, retriable)."""
    if isinstance(exc, ValueError):
        return "invalid_request", False
    if isinstance(exc, MissingAPIKeyError):
        return "missing_api_key", False
    if "logprob" in str(exc).lower():
        return "missing_logprobs", False
    try:  # openai exception taxonomy (installed in the venv)
        import openai
        if isinstance(exc, openai.APITimeoutError):
            return "timeout", True
        if isinstance(exc, openai.APIConnectionError):
            return "provider_error", True
        if isinstance(exc, openai.APIStatusError):
            status = getattr(exc, "status_code", None)
            if status == 429 or (isinstance(status, int) and status >= 500):
                return "provider_error", True
            return "provider_error", False
    except Exception:
        pass
    if "timeout" in str(exc).lower():
        return "timeout", True
    return "selection_failed", False


def _handle_select(req_id: Optional[str], req: Dict[str, Any]) -> None:
    secret: Optional[str] = None
    try:
        v = _validate(req)
    except ValueError as exc:
        _error(req_id, "invalid_request", str(exc), False)
        return
    try:
        key = os.environ.get(v["api_key_env"])
        if not key:
            _error(req_id, "missing_api_key",
                   "env var %s is not set or empty" % v["api_key_env"], False)
            return
        secret = key
        try:
            client = create_openai_client(base_url=v["base_url"], api_key=key)
        except Exception as exc:
            _error(req_id, "client_init", str(exc), False, secret)
            return
        # This relay emits the score tags itself and cannot do the vLLM
        # prefill; the deepseek path reads sampled tag distributions and
        # RAISES when score-token logprobs are missing (no silent 0.5).
        client._llm_verifier_deepseek = True  # type: ignore[attr-defined]
        # Relay account-pool execution mode (see _ResilientClient): bounded
        # per-call 429 retries (each retry lands on the round-robin's NEXT
        # account) and an optional dispatch smoother. Off when both are 0.
        if v["min_interval_ms"] > 0 or v["call_retries"] > 0:
            client = _ResilientClient(client, v["min_interval_ms"],
                                      v["call_retries"])
        # The library's tournament re-reads the score map through its cache
        # file across ring/pivot phases; select(cache=None) silently degrades
        # ring accumulation (observed: exact 0.5 ties). A per-run temp cache is
        # both the correct semantics AND the required isolation (fresh file,
        # deleted after the run; cache keys never leak across model/endpoint).
        # An untouched PATH (not an empty file): select() treats a missing
        # cache as empty and writes it back, while an EMPTY file crashes its
        # first json.load.
        cache_dir = tempfile.mkdtemp(prefix="llv-cache-")
        cache_path = os.path.join(cache_dir, "scores.json")
        USAGE.reset()
        try:
            with _effort_scoped(v["effort"]):
                result = llm_verifier.select(
                    v["problem"], v["candidates"], criteria=v["criteria"],
                    ground_truth_note=v["ground_truth_note"],
                    n_evaluations=v["n_evaluations"], pivots=v["pivots"],
                    seed=v["seed"], max_workers=v["max_workers"],
                    model=v["model"], cache=cache_path, progress=False,
                    on_error=v["on_error"], client=client)
        finally:
            try:
                import shutil
                shutil.rmtree(cache_dir, ignore_errors=True)
            except Exception:
                pass
        _ok(req_id, {
            "index": result.index,
            "best_preview": (result.best or "")[:200],
            "scores": [float(s) for s in result.scores],
            "ranking": list(result.ranking),
            "n_comparisons": result.n_comparisons,
            "criteria": list(result.criteria),
            "usage": USAGE.snapshot(),
        })
    except Exception as exc:
        code, retriable = _map_exception(exc)
        _error(req_id, code, str(exc), retriable, secret)

def _handle_progress(req_id: Optional[str], req: Dict[str, Any]) -> None:
    """One-shot online progress score: where does this trajectory stand vs the
    task, right now? Wraps llm_verifier.track over a single final checkpoint —
    the library's ProgressTracker semantic ("would the CURRENT state already
    satisfy the task") without multi-checkpoint fan-out."""
    secret: Optional[str] = None
    try:
        problem = req.get("problem")
        steps = req.get("steps")
        model = req.get("model")
        base_url = req.get("base_url")
        api_key_env = req.get("api_key_env")
        n_eval = req.get("n_evaluations")
        if not (isinstance(problem, str) and problem):
            raise ValueError("problem must be a non-empty string")
        if not (isinstance(steps, list) and len(steps) >= 1
                and all(isinstance(s, str) for s in steps)):
            raise ValueError("steps must be a list of >=1 strings")
        if not (isinstance(model, str) and model):
            raise ValueError("model must be a non-empty string")
        if not (isinstance(base_url, str) and base_url):
            raise ValueError("base_url must be a non-empty string")
        if not (isinstance(api_key_env, str) and api_key_env):
            raise ValueError("api_key_env must be a non-empty string")
        if not (isinstance(n_eval, int) and not isinstance(n_eval, bool)
                and n_eval >= 1):
            raise ValueError("n_evaluations must be an integer >= 1")
        effort = _validate_effort(req.get("effort"))
    except ValueError as exc:
        _error(req_id, "invalid_request", str(exc), False)
        return
    try:
        key = os.environ.get(api_key_env)
        if not key:
            _error(req_id, "missing_api_key",
                   "env var %s is not set or empty" % api_key_env, False)
            return
        secret = key
        client = create_openai_client(base_url=base_url, api_key=key)
        client._llm_verifier_deepseek = True  # type: ignore[attr-defined]
        USAGE.reset()
        # Single final checkpoint: n verifier calls = n_evaluations.
        from llm_verifier.progress import track
        with _effort_scoped(effort):
            result = track(problem=problem, steps=steps,
                           checkpoint_steps=[len(steps)], n_evaluations=n_eval,
                           model=model, client=client)
        _ok(req_id, {
            "score": float(result.scores[-1]),
            "usage": USAGE.snapshot(),
        })
    except Exception as exc:
        code, retriable = _map_exception(exc)
        _error(req_id, code, str(exc), retriable, secret)

def main() -> NoReturn:
    """Serial read-dispatch loop; stdin EOF exits 0."""
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            sys.exit(0)
        line = line.strip()
        if not line:
            continue
        try:
            frame = json.loads(line.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            _error(None, "bad_frame", "malformed JSON line", False)
            continue
        if not isinstance(frame, dict):
            _error(None, "bad_frame", "frame must be a JSON object", False)
            continue
        req_id = frame.get("id")
        req_type = frame.get("type")
        if req_type == "health":
            _handle_health(req_id)
        elif req_type == "select":
            _handle_select(req_id, frame)
        elif req_type == "progress":
            _handle_progress(req_id, frame)
        elif req_type == "shutdown":
            _ok(req_id, {})
            sys.exit(0)
        else:
            _error(req_id, "invalid_request",
                   "unknown request type: %s" % (req_type,), False)


if __name__ == "__main__":
    main()
