"""Protocol-conformant stub sidecar for offline bridge tests (no llm_verifier).

Every frame it emits comes from bridge/protocol-fixtures.json (`responses` and
`errors`), so the stub cannot drift from the documented protocol without the
fixture changing too. Behaviors are driven by the select problem text:
  HANG       sleep 60s (timeout / abort / dispose scenarios)
  CRASH      os._exit(3) (child-death scenario)
  ERRPROV    reply with the canonical provider_error frame (retriable)
  otherwise  the canonical select result, scores descending from 1.0 by 0.1
             per candidate (TIE, or a base_url containing "tie", scores every
             candidate 1.0); the api key env must have been injected.

When STUB_ECHO_FILE is set, every request frame received is appended to that
file as one JSON line, so a test can assert the exact wire frame the bridge
emitted.
"""
import json
import os
import sys
import time

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "..", "..", "..", "bridge", "protocol-fixtures.json")
with open(FIXTURES, "r", encoding="utf-8") as fh:
    FIX = json.load(fh)
RESPONSES = FIX["responses"]
ERRORS = FIX["errors"]
ECHO_FILE = os.environ.get("STUB_ECHO_FILE")


def w(frame):
    sys.stdout.write(json.dumps(frame) + "\n")
    sys.stdout.flush()


def ok(rid, result):
    w({"id": rid, "ok": True, "result": result})


def err(rid, code, **overrides):
    error = dict(ERRORS[code])
    error.update(overrides)
    w({"id": rid, "ok": False, "error": error})


def echo(req):
    if not ECHO_FILE:
        return
    with open(ECHO_FILE, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(req) + "\n")


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except json.JSONDecodeError:
        w(RESPONSES["bad_frame"])
        continue
    echo(req)
    rid = req.get("id")
    t = req.get("type")
    if t == "health":
        ok(rid, RESPONSES["health"]["result"])
        continue
    if t == "shutdown":
        ok(rid, RESPONSES["shutdown"]["result"])
        sys.exit(0)
    if t in ("select", "progress"):
        key_name = req.get("api_key_env", "")
        if not os.environ.get(key_name):
            err(rid, "missing_api_key", message="env var %s not set" % key_name)
            continue
    if t == "progress":
        ok(rid, RESPONSES["progress"]["result"])
        continue
    if t == "select":
        p = req.get("problem", "")
        if "HANG" in p:
            time.sleep(60)
            continue
        if "CRASH" in p:
            os._exit(3)
        if "ERRPROV" in p:
            err(rid, "provider_error")
            continue
        n = len(req["candidates"])
        if "TIE" in p or "tie" in str(req.get("base_url", "")).lower():
            scores = [1.0 for _ in range(n)]
        else:
            scores = [round(1.0 - i * 0.1, 4) for i in range(n)]
        canonical = RESPONSES["select"]["result"]
        ok(rid, {"index": 0,
                 "best_preview": req["candidates"][0][:200],
                 "scores": scores,
                 "ranking": list(range(n)),
                 "n_comparisons": n,
                 "criteria": list(canonical["criteria"]),
                 "usage": dict(canonical["usage"])})
        continue
    err(rid, "invalid_request", message="unknown type")
sys.exit(0)
