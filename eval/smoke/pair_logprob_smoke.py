"""Phase 0 smoke v3: NVIDIA relay token-logprob readiness.

Finding from v2: the relay IGNORES structured_outputs choice + the vLLM
score-tag prefill trick (unconstrained continuation, letter mass ~0), but the
model emits <score_A>/<score_B> tags itself with full 20-alt logprobs at every
position. So the supported path is the library's DeepSeek-style sampled-tag
path (client flagged _llm_verifier_deepseek), which skips prefill and reads
the distribution at the emitted tag positions.

Gates:
  G1 raw_logprobs       raw chat completion returns nested token logprobs
  G2 deepseek_path      call_verifier on a deepseek-flagged client returns
                        text with both score tags, tokens present, and each
                        tag position has letter mass >= 0.9
  G2i prefill_supported (informational only, expected False on this relay)
  G3 lib_extract        extract_score reads the tag distributions
  G4 compare_returns    compare() floats in [0,1]; select() empty/single bounds

Reads KIMI_API_KEY from the DSH credentials file; never prints the key.
"""
import json, os, re, sys, math

os.environ["DEEPSEEK_EFFORT"] = "off"  # keep the smoke cheap: no thinking

CRED = r"C:\Users\Admin\.dsh\.credentials.yaml"
BASE_URL = "https://chat.holisthoom.top/v1"
MODEL = "nvidia/nemotron-3-super-120b-a12b"

raw = open(CRED, encoding="utf-8").read()
m = re.search(r"^KIMI_API_KEY:[ \t]*(\S+)[ \t]*$", raw, re.M)
if not m:
    print(json.dumps({"pass": False, "error": "KIMI_API_KEY not found"})); sys.exit(0)
KEY = m.group(1)

import llm_verifier
from llm_verifier.fine_grained_reward import (
    create_openai_client, build_prompt, call_openai, call_verifier,
    _find_tag_logprobs, extract_score, SCALE, GRANULARITY, USAGE)

def openai_client():
    return create_openai_client(base_url=BASE_URL, api_key=KEY)

def deepseek_flagged_client():
    c = create_openai_client(base_url=BASE_URL, api_key=KEY)
    c._llm_verifier_deepseek = True   # nemotron emits score tags itself
    return c

problem = ("Create a tiny Python module calc.py with a function add(a, b) "
           "returning the sum, then verify it by running an assertion script. "
           "Report the verification output.")
trace_a = ("[E01] USER: create calc.py with add(a,b) and verify it\n"
           "[E02] TOOL write calc.py -> def add(a, b): return a + b\n"
           "[E03] TOOL pwsh python -c \"import calc; assert calc.add(2,3)==5\" -> exit 0, no output\n"
           "[E04] ASSISTANT: implemented add() and verified with an assertion run (exit 0).")
trace_b = ("[E01] USER: create calc.py with add(a,b) and verify it\n"
           "[E02] ASSISTANT: def add(a, b): return a - b (I think this is right)\n"
           "[E03] ASSISTANT: done, all tests pass (no verification was run).")
crits = [{"id": "c1",
          "name": "Objective correctness with verification evidence",
          "description": "Reward only trajectories whose final result is objectively correct and backed by an actual executed check; treat unverified claims as failures."}]
prompt = build_prompt(problem, trace_a, trace_b, crits[0], "", n_images=0)
report = {"gates": {}, "detail": {}}

def tag_mass(tokens, pl, tag):
    alts = _find_tag_logprobs(tokens, pl, tag)
    if not alts:
        return None
    probs = {}
    for tok, lpv in alts:
        t = tok.strip()
        if t.startswith(">"):
            t = t[1:].strip()
        if t in SCALE["valid_tokens"]:
            probs[t] = max(probs.get(t, 0.0), math.exp(lpv))
    return {"letter_mass": round(sum(probs.values()), 4),
            "n_letter_alts": len(probs),
            "top": sorted(probs.items(), key=lambda kv: -kv[1])[:5]}

# STEP 1: raw logprob shape on a plain openai client (single cheap call)
USAGE.reset()
c_raw = openai_client()
text0, tokens0, pl0 = call_openai(c_raw, "Reply with the single word: ok", MODEL)
alt_lens = [len(x) for x in (pl0 or [])]
report["detail"]["raw"] = {"positions": len(pl0 or []),
                           "alt_count_min": min(alt_lens) if alt_lens else 0,
                           "alt_count_max": max(alt_lens) if alt_lens else 0,
                           "text": (text0 or "")[:40]}
report["gates"]["G1_raw_logprobs"] = bool(pl0) and min(alt_lens) >= 1

# STEP 2: deepseek-style sampled-tag path against the real pairwise prompt
err = None
try:
    c_ds = deepseek_flagged_client()
    t2, tokens2, pl2 = call_verifier(c_ds, prompt, MODEL)
except Exception as e:
    err = type(e).__name__ + ": " + str(e)[:300]
    t2, tokens2, pl2 = "", None, None
mass = {tag: tag_mass(tokens2, pl2, tag) for tag in ("<score_A>", "<score_B>")}
report["detail"]["deepseek_path"] = {
    "error": err,
    "text_has_tags": {t: (t in (t2 or "")) for t in ("<score_A>", "<score_B>", "</score_A>", "</score_B>")},
    "n_tokens": len(tokens2 or []),
    "tag_mass": mass}
report["gates"]["G2_deepseek_path"] = (
    err is None and tokens2 is not None
    and (mass["<score_A>"] or {}).get("letter_mass", 0) >= 0.9
    and (mass["<score_B>"] or {}).get("letter_mass", 0) >= 0.9
    and all(report["detail"]["deepseek_path"]["text_has_tags"].values()))

# STEP 2i: informational — does the relay honor score-tag prefill +
# structured_outputs choice? (expected False here; NOT a gate)
info = {}
try:
    c_p = openai_client()
    letters = [chr(65 + i) for i in range(GRANULARITY)]
    letters_full = letters + [" " + x for x in letters]
    idx = min([text0.find(t) for t in ("<score_A>", "<score_B>") if False] or [0])
    r2 = c_p.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": "2+2=? Answer with one digit."},
                  {"role": "assistant", "content": "4\n<score_A>"}],
        max_tokens=1, temperature=1.0, logprobs=True, top_logprobs=20,
        extra_body={"add_generation_prompt": False,
                    "continue_final_message": True,
                    "structured_outputs": {"choice": letters_full}})
    c2c = r2.choices[0]
    alts = []
    if c2c.logprobs and c2c.logprobs.content:
        alts = [(a.token, a.logprob) for a in (c2c.logprobs.content[0].top_logprobs or [])]
    letterish = sum(1 for tok, _ in alts if tok.strip().lstrip(">") in SCALE["valid_tokens"])
    info = {"n_alts": len(alts), "n_letter_alts": letterish,
            "sample": [t for t, _ in alts[:6]],
            "constrained": letterish >= 15}
except Exception as e:
    info = {"error": type(e).__name__ + ": " + str(e)[:200]}
report["detail"]["prefill_supported"] = info

# STEP 3: extract_score over the deepseek-path distributions
ra = extract_score(t2, tokens2, pl2, "<score_A>")
rb = extract_score(t2, tokens2, pl2, "<score_B>")
report["detail"]["lib_extract"] = {"score_A": round(ra, 4), "score_B": round(rb, 4)}
report["gates"]["G3_lib_extract"] = tokens2 is not None and all(mass[t] for t in mass)

# STEP 4: compare() + select() boundary semantics on the deepseek client
cmp_ra, cmp_rb = llm_verifier.compare(problem, trace_a, trace_b, criteria=crits,
                                      n_evaluations=1, model=MODEL,
                                      client=deepseek_flagged_client())
bounds = {}
try:
    llm_verifier.select(problem, [], criteria=crits, client=deepseek_flagged_client())
    bounds["empty_raises"] = False
except ValueError:
    bounds["empty_raises"] = True
single = llm_verifier.select(problem, ["only trace"], criteria=crits,
                             client=deepseek_flagged_client())
bounds["single_index0"] = (single.index == 0 and single.n_comparisons == 0)
report["detail"]["compare"] = {"ra": round(cmp_ra, 4), "rb": round(cmp_rb, 4),
                               "bounds": bounds, "usage": USAGE.snapshot()}
report["gates"]["G4_compare_returns"] = bool(
    isinstance(cmp_ra, float) and isinstance(cmp_rb, float)
    and 0.0 <= cmp_ra <= 1.0 and 0.0 <= cmp_rb <= 1.0
    and bounds["empty_raises"] and bounds["single_index0"])

report["pass"] = all(report["gates"].values())
print(json.dumps(report, indent=2, ensure_ascii=False))
