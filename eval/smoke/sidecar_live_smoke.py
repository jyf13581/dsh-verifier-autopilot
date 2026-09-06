"""Phase 1 live acceptance: sidecar select() against the real NVIDIA relay.

One real 2-candidate selection (1 criterion, n_evaluations=1, on_error=raise).
Reads KIMI_API_KEY from the DSH credentials file and injects it into the
sidecar's process env (the key never appears in frames or output).
"""
import json
import os
import re
import subprocess
import sys

PY = sys.executable
SIDECAR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "..", "..", "bridge", "llm_verifier_sidecar.py")
CRED = r"C:\Users\Admin\.dsh\.credentials.yaml"

raw = open(CRED, encoding="utf-8").read()
m = re.search(r"^KIMI_API_KEY:[ \t]*(\S+)[ \t]*$", raw, re.M)
assert m, "KIMI_API_KEY not found"
KEY = m.group(1)

env = dict(os.environ)
env["KIMI_API_KEY"] = KEY

proc = subprocess.Popen([PY, SIDECAR], stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                        text=True, env=env)


def rpc(frame):
    proc.stdin.write(json.dumps(frame) + "\n")
    proc.stdin.flush()
    line = proc.stdout.readline()
    if not line:
        raise RuntimeError("sidecar closed stdout")
    return json.loads(line)


problem = ("Create a tiny Python module calc.py with a function add(a, b) "
           "returning the sum, then verify it by running an assertion script.")
traces = [
    ("[E01] USER: create calc.py with add(a,b) and verify it\n"
     "[E02] TOOL write calc.py -> def add(a, b): return a + b\n"
     "[E03] TOOL pwsh python -c \"import calc; assert calc.add(2,3)==5\" -> exit 0\n"
     "[E04] ASSISTANT: implemented add() and verified with an assertion run (exit 0)."),
    ("[E01] USER: create calc.py with add(a,b) and verify it\n"
     "[E02] ASSISTANT: def add(a, b): return a - b (I think this is right)\n"
     "[E03] ASSISTANT: done, all tests pass (no verification was run)."),
]
out = {"health": None, "select": None}
try:
    out["health"] = rpc({"id": "h", "type": "health"})
    out["select"] = rpc({
        "id": "sel1", "type": "select", "problem": problem,
        "candidates": traces,
        "criteria": [{"id": "c1",
                      "name": "Objective correctness with verification evidence",
                      "description": "Reward objective correctness backed by executed checks; unverified claims fail."}],
        "ground_truth_note": None, "n_evaluations": 1, "pivots": 1,
        "seed": 42, "model": "nvidia/nemotron-3-super-120b-a12b",
        "base_url": "https://chat.holisthoom.top/v1",
        "api_key_env": "KIMI_API_KEY", "cache": None, "on_error": "raise",
        "max_workers": 2, "progress": False})
finally:
    try:
        rpc({"id": "x", "type": "shutdown"})
    except Exception:
        pass
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()

sel = out["select"]
res = sel.get("result") or {}
passed = (sel.get("ok") is True and res.get("index") == 0
          and res.get("ranking") == [0, 1]
          and res.get("n_comparisons", 0) >= 2
          and (res.get("usage") or {}).get("calls", 0) >= 2)
out["pass"] = passed
print(json.dumps(out, indent=2, ensure_ascii=False))
sys.exit(0 if passed else 1)
