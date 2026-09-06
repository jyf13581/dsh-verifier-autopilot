"""Protocol-conformant stub sidecar for offline bridge tests (no llm_verifier).

Behaviors driven by the problem text:
  HANG       sleep 60s (timeout / abort / dispose scenarios)
  CRASH      os._exit(3) (child-death scenario)
  ERRPROV    reply with provider_error (retriable) — error-frame passthrough
  otherwise  happy-path select result; verifies the api key env was injected
"""
import json
import os
import sys
import time


def w(frame):
    sys.stdout.write(json.dumps(frame) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except json.JSONDecodeError:
        w({"id": None, "ok": False,
           "error": {"code": "bad_frame", "message": "malformed",
                     "retriable": False}})
        continue
    rid = req.get("id")
    t = req.get("type")
    if t == "health":
        w({"id": rid, "ok": True,
           "result": {"python": "stub", "llm_verifier_version": "stub",
                      "select_available": True, "note": "stub",
                      "deepseek_effort": None}})
        continue
    if t == "shutdown":
        w({"id": rid, "ok": True, "result": {}})
        sys.exit(0)
    if t == "select":
        p = req.get("problem", "")
        key_name = req.get("api_key_env", "")
        if not os.environ.get(key_name):
            w({"id": rid, "ok": False,
               "error": {"code": "missing_api_key",
                         "message": "env var %s not set" % key_name,
                         "retriable": False}})
            continue
        if "HANG" in p:
            time.sleep(60)
            continue
        if "CRASH" in p:
            os._exit(3)
        if "ERRPROV" in p:
            w({"id": rid, "ok": False,
               "error": {"code": "provider_error",
                         "message": "relay said 500",
                         "retriable": True}})
            continue
        n = len(req["candidates"])
        if "TIE" in p or "tie" in str(req.get("base_url", "")).lower():
            scores = [1.0 for _ in range(n)]
        else:
            scores = [round(1.0 - i * 0.1, 4) for i in range(n)]
        w({"id": rid, "ok": True,
           "result": {"index": 0,
                      "best_preview": req["candidates"][0][:200],
                      "scores": scores,
                      "ranking": list(range(n)),
                      "n_comparisons": n,
                      "criteria": ["c1"],
                      "usage": {"calls": 1, "input_tokens": 10,
                                "cached_input_tokens": 0,
                                "uncached_input_tokens": 10,
                                "output_tokens": 5, "reasoning_tokens": 0,
                                "cache_hit_rate": 0.0}}})
        continue
    w({"id": rid, "ok": False,
       "error": {"code": "invalid_request",
                 "message": "unknown type", "retriable": False}})
sys.exit(0)
