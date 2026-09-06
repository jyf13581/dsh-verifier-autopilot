"""Offline self-test for the llm-verifier sidecar (no network).

Six gates: health / bad_frame / invalid_request / single-candidate
short-circuit / missing_api_key / shutdown. Run with the bridge venv:
  D:/tools/pyvenvs/llm-verifier-bridge/Scripts/python.exe bridge/self_test.py
Exit code 0 iff all gates pass.
"""
import json
import os
import subprocess
import sys

PY = sys.executable
SIDECAR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "llm_verifier_sidecar.py")


def rpc(proc, frame):
    proc.stdin.write(json.dumps(frame) + "\n")
    proc.stdin.flush()
    line = proc.stdout.readline()
    assert line, "sidecar closed stdout unexpectedly"
    return json.loads(line)


def main():
    env = dict(os.environ)
    env["SMOKE_KEY"] = "dummy-not-a-real-key"
    env.pop("DEFINITELY_MISSING_KEY", None)
    proc = subprocess.Popen([PY, SIDECAR], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, env=env)
    gates = []
    try:
        # (a) health
        r = rpc(proc, {"id": "h1", "type": "health"})
        gates.append(("health", r.get("ok") is True
                      and r["result"].get("select_available") is True
                      and "python" in r["result"], json.dumps(r)[:200]))
        # (b) malformed line
        proc.stdin.write("{not json\n")
        proc.stdin.flush()
        r = json.loads(proc.stdout.readline())
        gates.append(("bad_frame", r.get("ok") is False and r.get("id") is None
                      and r["error"]["code"] == "bad_frame", json.dumps(r)[:200]))
        # (c) empty candidates -> invalid_request, no network
        r = rpc(proc, {"id": "s1", "type": "select", "problem": "p",
                       "candidates": [], "criteria": {"c": "d"},
                       "ground_truth_note": None, "n_evaluations": 1,
                       "pivots": 0, "seed": 0, "model": "m",
                       "base_url": "http://127.0.0.1:9/v1",
                       "api_key_env": "SMOKE_KEY", "cache": None,
                       "on_error": "raise", "max_workers": None,
                       "progress": False})
        gates.append(("empty_candidates", r.get("ok") is False
                      and r["error"]["code"] == "invalid_request",
                      json.dumps(r)[:200]))
        # (d) single candidate -> index 0, no provider call
        r = rpc(proc, {"id": "s2", "type": "select", "problem": "p",
                       "candidates": ["only trace"], "criteria": {"c": "d"},
                       "ground_truth_note": None, "n_evaluations": 1,
                       "pivots": 0, "seed": 0, "model": "m",
                       "base_url": "http://127.0.0.1:9/v1",
                       "api_key_env": "SMOKE_KEY", "cache": None,
                       "on_error": "raise", "max_workers": None,
                       "progress": False})
        res = r.get("result", {})
        gates.append(("single_candidate", r.get("ok") is True
                      and res.get("index") == 0
                      and res.get("n_comparisons") == 0
                      and res.get("usage", {}).get("calls") == 0,
                      json.dumps(r)[:300]))
        # (e) api_key_env missing from env
        r = rpc(proc, {"id": "s3", "type": "select", "problem": "p",
                       "candidates": ["a", "b"], "criteria": {"c": "d"},
                       "ground_truth_note": None, "n_evaluations": 1,
                       "pivots": 0, "seed": 0, "model": "m",
                       "base_url": "http://127.0.0.1:9/v1",
                       "api_key_env": "DEFINITELY_MISSING_KEY", "cache": None,
                       "on_error": "raise", "max_workers": None,
                       "progress": False})
        gates.append(("missing_api_key", r.get("ok") is False
                      and r["error"]["code"] == "missing_api_key",
                      json.dumps(r)[:200]))
        # (e2) effort field: unknown level is invalid_request; a valid level on
        # a single candidate short-circuits offline AND is request-scoped —
        # the health probe afterwards must NOT observe the override.
        r = rpc(proc, {"id": "s4", "type": "select", "problem": "p",
                       "candidates": ["a", "b"], "criteria": {"c": "d"},
                       "ground_truth_note": None, "n_evaluations": 1,
                       "pivots": 0, "seed": 0, "model": "m",
                       "base_url": "http://127.0.0.1:9/v1",
                       "api_key_env": "SMOKE_KEY", "cache": None,
                       "on_error": "raise", "max_workers": None,
                       "progress": False, "effort": "turbo"})
        bad_level = r.get("ok") is False and r["error"]["code"] == "invalid_request"
        r = rpc(proc, {"id": "s5", "type": "select", "problem": "p",
                       "candidates": ["only"], "criteria": {"c": "d"},
                       "ground_truth_note": None, "n_evaluations": 1,
                       "pivots": 0, "seed": 0, "model": "m",
                       "base_url": "http://127.0.0.1:9/v1",
                       "api_key_env": "SMOKE_KEY", "cache": None,
                       "on_error": "raise", "max_workers": None,
                       "progress": False, "effort": "max"})
        good_ok = r.get("ok") is True and r.get("result", {}).get("index") == 0
        base_effort = os.environ.get("DEEPSEEK_EFFORT", "off")
        r = rpc(proc, {"id": "h2", "type": "health"})
        kept = r.get("result", {}).get("deepseek_effort") == base_effort
        gates.append(("effort_scoping", bad_level and good_ok and kept,
                      "bad=%s single=%s kept=%s (%r)" % (bad_level, good_ok, kept, base_effort)))
        # (f) shutdown -> exit 0
        r = rpc(proc, {"id": "x", "type": "shutdown"})
        rc = proc.wait(timeout=10)
        gates.append(("shutdown", r.get("ok") is True and rc == 0,
                      "rc=%s" % rc))
    except Exception as exc:
        gates.append(("harness_exception", False, repr(exc)))
        proc.kill()
    # (g2) progress frame validation: malformed -> invalid_request; missing key -> missing_api_key (no network)
    try:
        proc2 = subprocess.Popen([PY, SIDECAR], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True, env=env)
        try:
            r = rpc(proc2, {"id": "p0", "type": "progress", "problem": "x",
                            "steps": [], "model": "m",
                            "base_url": "http://127.0.0.1:9/v1",
                            "api_key_env": "SMOKE_KEY", "n_evaluations": 1})
            ok1 = r.get("ok") is False and r["error"]["code"] == "invalid_request"
            r = rpc(proc2, {"id": "p1", "type": "progress", "problem": "x",
                            "steps": ["s1"], "model": "m",
                            "base_url": "http://127.0.0.1:9/v1",
                            "api_key_env": "DEFINITELY_MISSING_KEY",
                            "n_evaluations": 1})
            ok2 = r.get("ok") is False and r["error"]["code"] == "missing_api_key"
            rpc(proc2, {"id": "p2", "type": "shutdown"})
            proc2.wait(timeout=10)
        finally:
            proc2.kill()
        gates.append(("progress_frame_validation", ok1 and ok2, ""))
    except Exception as exc:
        gates.append(("progress_frame_validation", False, repr(exc)))
    # (g) mojibake-tolerant tag lookup: import the patched sidecar module and
    # score a synthetic K3-shaped token stream (no '<' before the open tag).
    try:
        import math as _math
        sys.path.insert(0, os.path.dirname(SIDECAR))
        import llm_verifier_sidecar  # noqa: F401  (applies the monkey-patch)
        from llm_verifier.fine_grained_reward import extract_score
        # K3-shaped: open tag streams as bare 'score' '_A' '>'; letter token
        # next. Closing tag carries the '<' (' </score_A>').
        toks = ["analysis.", "score", "_A", ">", " A", " </", "score", "_A",
                ">\n", "score", "_B", ">", " T", " </", "score", "_B", ">"]
        logs = [_math.log(0.90), _math.log(0.05), _math.log(0.05)]
        alts_a = [(" A", logs[0]), (" T", logs[1]), (" B", logs[2])]
        alts_b = [(" T", logs[0]), (" S", logs[1]), (" A", logs[2])]
        plps = [[("x", 0.0)]] * len(toks)
        plps[4] = alts_a
        plps[12] = alts_b
        text = "".join(toks)
        ra = extract_score(text, toks, plps, "<score_A>")
        rb = extract_score(text, toks, plps, "<score_B>")
        gates.append(("mojibake_expectation",
                      ra > 0.9 and rb < 0.1,
                      "ra=%.4f rb=%.4f (want ra>0.9, rb<0.1)" % (ra, rb)))
    except Exception as exc:
        gates.append(("mojibake_expectation", False, repr(exc)))
    ok = True
    for name, passed, note in gates:
        print("%s %s  %s" % ("PASS" if passed else "FAIL", name, note))
        ok = ok and passed
    err = proc.stderr.read() if proc.stderr else ""
    if err.strip():
        print("--- stderr (last 400 chars) ---")
        print(err.strip()[-400:])
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
