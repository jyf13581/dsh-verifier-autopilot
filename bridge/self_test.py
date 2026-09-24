"""Offline self-test for the llm-verifier sidecar (no network).

Run with the bridge venv:
  D:/tools/pyvenvs/llm-verifier-bridge/Scripts/python.exe bridge/self_test.py
Set DSH_VA_REQUIRE_LLM_VERIFIER=1 in that venv to make a missing/broken
llm_verifier installation fail health and provider-specific gates instead of
reporting an optional SKIP. Exit code 0 iff every required gate passes.

Frame-level gates come from bridge/protocol-fixtures.json (`conformance`): the
same file the TypeScript bridge tests and the stub sidecar consume, so a
protocol change is made once and every consumer sees it.
"""
import json
import os
import subprocess
import sys

PY = sys.executable
SIDECAR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "llm_verifier_sidecar.py")
FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "protocol-fixtures.json")


def rpc(proc, frame):
    proc.stdin.write(json.dumps(frame) + "\n")
    proc.stdin.flush()
    line = proc.stdout.readline()
    assert line, "sidecar closed stdout unexpectedly"
    return json.loads(line)


def _subset(expected, actual):
    """True when every key of `expected` matches `actual` (recursing into dicts)."""
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(
            k in actual and _subset(v, actual[k]) for k, v in expected.items())
    return expected == actual


def _resolve_placeholders(value, env):
    """`$NAME_OR_default` expands to env[NAME] or the default: the fixture stays
    literal JSON while a case can still depend on the ambient environment."""
    if isinstance(value, dict):
        return {k: _resolve_placeholders(v, env) for k, v in value.items()}
    if isinstance(value, list):
        return [_resolve_placeholders(v, env) for v in value]
    if isinstance(value, str) and value.startswith("$") and "_OR_" in value:
        name, default = value[1:].split("_OR_", 1)
        return env.get(name, default)
    return value


def run_conformance(proc, cases, env, require_llm_verifier):
    """Drive every fixture case through one sidecar process, in order. Returns
    (gates, llm_available). Every case is a gate; the health case additionally
    decides whether provider-dependent gates may SKIP."""
    gates = []
    llm_available = False
    for case in cases:
        name = case["name"]
        expect = _resolve_placeholders(case["expect"], env)
        try:
            if "raw" in case:
                proc.stdin.write(case["raw"] + "\n")
                proc.stdin.flush()
                r = json.loads(proc.stdout.readline())
            else:
                r = rpc(proc, case["request"])
        except Exception as exc:  # noqa: BLE001 - the harness reports, never dies
            gates.append((name, False, "harness exception " + repr(exc)))
            break
        problems = []
        if r.get("ok") is not expect["ok"]:
            problems.append("ok=%r" % r.get("ok"))
        if "id" in expect and r.get("id") != expect["id"]:
            problems.append("id=%r" % r.get("id"))
        if "error_code" in expect and (r.get("error") or {}).get("code") != expect["error_code"]:
            problems.append("error=%r" % r.get("error"))
        result = r.get("result")
        if "result_keys" in expect and (not isinstance(result, dict)
                                        or sorted(result) != sorted(expect["result_keys"])):
            problems.append("result keys=%r" % (sorted(result) if isinstance(result, dict) else result,))
        if "result" in expect and not _subset(expect["result"], result):
            problems.append("result=%r" % (result,))
        if "exit_code" in expect:
            rc = proc.wait(timeout=10)
            if rc != expect["exit_code"]:
                problems.append("rc=%r" % rc)
        if name == "health" and isinstance(result, dict):
            llm_available = result.get("select_available") is True
            # A plain CI Python environment may not carry the optional provider
            # library. Health passes when it reports that state truthfully unless
            # the bridge-venv strict switch explicitly requires provider support.
            if not isinstance(result.get("select_available"), bool):
                problems.append("select_available not boolean")
            elif require_llm_verifier and not llm_available:
                problems.append("strict mode requires select_available")
        gates.append((name, not problems, (", ".join(problems) or "ok") + "  " + json.dumps(r)[:160]))
    return gates, llm_available


def main():
    env = dict(os.environ)
    require_llm_verifier = env.get("DSH_VA_REQUIRE_LLM_VERIFIER") == "1"
    env["SMOKE_KEY"] = "dummy-not-a-real-key"
    env.pop("DEFINITELY_MISSING_KEY", None)
    with open(FIXTURES, "r", encoding="utf-8") as fh:
        fixtures = json.load(fh)
    proc = subprocess.Popen([PY, SIDECAR], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, env=env)
    # Protocol conformance: the canonical cases in bridge/protocol-fixtures.json,
    # shared with the TypeScript bridge tests and the stub sidecar, so the three
    # sides of the pipe cannot drift apart silently.
    try:
        gates, llm_available = run_conformance(proc, fixtures["conformance"], env, require_llm_verifier)
    finally:
        if proc.poll() is None:
            proc.kill()
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
    except ModuleNotFoundError as exc:
        if (not require_llm_verifier and not llm_available
                and exc.name == "llm_verifier"):
            gates.append(("mojibake_expectation", True,
                          "SKIP optional llm_verifier is not installed"))
        else:
            gates.append(("mojibake_expectation", False,
                          "required provider gate unavailable: %r" % exc))
    except Exception as exc:
        gates.append(("mojibake_expectation", False, repr(exc)))
    # (h) relay account-pool resilience: _ResilientClient per-call 429 retry,
    # bounded exhaustion, non-429 passthrough, dispatch smoothing, and
    # attribute delegation — fully offline against a fake base client.
    try:
        import time as _time
        import llm_verifier_sidecar as _sc  # already importable per gate (g)

        class _RateLimited(Exception):
            status_code = 429

        class _FakeBase:
            def __init__(self, fail_first, exc=None):
                self.calls = 0
                self.started = []
                self.fail_first = fail_first
                self.exc = exc
                self.timeout = 30  # delegation probe attribute
                outer = self

                class _Completions:
                    def create(self, **kwargs):
                        outer.calls += 1
                        outer.started.append(_time.monotonic())
                        if outer.calls <= outer.fail_first:
                            raise outer.exc or _RateLimited("upstream 429")
                        return "resp-%d" % outer.calls

                class _Chat:
                    completions = _Completions()

                self.chat = _Chat()

        def _wrap(base, **kw):
            return _sc._ResilientClient(base, **kw)

        # h1: two 429s then success — retry re-enters the round-robin (new
        # account), so the third attempt lands.
        base = _FakeBase(fail_first=2)
        out = _wrap(base, call_retries=2).chat.completions.create(model="m")
        h1 = out == "resp-3" and base.calls == 3

        # h2: retries exhausted -> the 429 surfaces to the existing taxonomy.
        base = _FakeBase(fail_first=99)
        try:
            _wrap(base, call_retries=1).chat.completions.create(model="m")
            h2 = False
        except _RateLimited:
            h2 = base.calls == 2

        # h3: non-429 failures are never retried per-call.
        base = _FakeBase(fail_first=1, exc=ValueError("bad request"))
        try:
            _wrap(base, call_retries=3).chat.completions.create(model="m")
            h3 = False
        except ValueError:
            h3 = base.calls == 1

        # h4: dispatch smoothing — three calls spaced >= min_interval apart.
        base = _FakeBase(fail_first=0)
        wrap = _wrap(base, min_interval_ms=120, call_retries=0)
        wrap.chat.completions.create(model="m")
        wrap.chat.completions.create(model="m")
        wrap.chat.completions.create(model="m")
        h4 = len(base.started) == 3 and (base.started[2] - base.started[0]) >= 0.2

        # h5: attribute delegation + protocol flag survives the wrapper.
        base = _FakeBase(fail_first=0)
        wrap = _wrap(base)
        wrap._llm_verifier_deepseek = True
        h5 = wrap.timeout == 30 and getattr(wrap, "_llm_verifier_deepseek", False) is True

        gates.append(("resilient_client",
                      h1 and h2 and h3 and h4 and h5,
                      "retry=%s exhausted=%s passthrough=%s smooth=%s delegate=%s"
                      % (h1, h2, h3, h4, h5)))
    except Exception as exc:
        gates.append(("resilient_client", False, repr(exc)))
    ok = True
    for name, passed, note in gates:
        status = "SKIP" if passed and note.startswith("SKIP ") else ("PASS" if passed else "FAIL")
        print("%s %s  %s" % (status, name, note))
        ok = ok and passed
    err = proc.stderr.read() if proc.stderr else ""
    if err.strip():
        print("--- stderr (last 400 chars) ---")
        print(err.strip()[-400:])
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
