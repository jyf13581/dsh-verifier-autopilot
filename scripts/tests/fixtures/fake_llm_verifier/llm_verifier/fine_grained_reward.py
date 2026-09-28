"""Score extraction copied VERBATIM from upstream llm-as-a-verifier
(https://github.com/llm-as-a-verifier/llm-as-a-verifier, commit 8db8a11,
llm_verifier/fine_grained_reward.py, MIT License) so the sidecar's
monkeypatches are exercised against the real upstream semantics without the
package installed. Everything below the copied block is a stub."""
import math
import re

GRANULARITY = 20

SCALE = {
    "scale_description": (
        "Rate how likely the agent correctly solved the task on a "
        "20-point scale using letters A through T:\n"
        "  A = clearly and completely succeeded with verified output (best)\n"
        "  B-D = succeeded with only minor issues\n"
        "  E-G = above average, mostly correct with some issues\n"
        "  H-J = uncertain, leans toward success\n"
        "  K-M = uncertain, leans toward failure\n"
        "  N-P = below average, significant issues remain\n"
        "  Q-S = failed with some partial progress\n"
        "  T = clearly and completely failed (worst)"
    ),
    "score_format": "LETTER_A_TO_T",
    "valid_tokens": {
        **{chr(65 + i): float(GRANULARITY - i) for i in range(GRANULARITY)},
        **{chr(97 + i): float(GRANULARITY - i) for i in range(GRANULARITY)},
    },
}


def _find_tag_logprobs(tokens, position_logprobs, tag):
    if not tokens or not position_logprobs:
        return None
    # Some tokenizers fuse the closing '>' with the score letter ('>A'), so
    # try the exact tag first, then the tag without its trailing '>'. Take
    # the LAST match: the verdict is the score block at the end of the reply,
    # not the model quoting the format mid-analysis.
    for suffix in (tag, tag[:-1]):
        found = None
        text_so_far = ""
        for i, tok in enumerate(tokens):
            text_so_far += tok
            # An empty or whitespace-only token (a reasoning parser swallowed
            # the letter, or the constrained sample landed on a bare space, a
            # legal prefix of " A") leaves the stripped text unchanged, so the
            # tag would match a SECOND time and shadow the distribution captured
            # at the previous position (#5, #10).
            if not tok.strip():
                continue
            if text_so_far.rstrip().endswith(suffix):
                if i + 1 < len(position_logprobs):
                    found = position_logprobs[i + 1]
        if found is not None:
            return found
    return None


def extract_score(text, tokens, position_logprobs, tag):
    """Expected score over the verifier's token distribution at `tag`,
    normalized to [0, 1]. Falls back to parsing the literal text token."""
    valid_tokens = SCALE["valid_tokens"]

    tag_lp = _find_tag_logprobs(tokens, position_logprobs, tag)
    probs = {}
    if tag_lp:
        for tok_str, logprob in tag_lp:
            tok = tok_str.strip()
            if tok.startswith(">"):  # DeepSeek fuses '>' with the letter
                tok = tok[1:].strip()
            if tok in valid_tokens:
                val = valid_tokens[tok]
                p = math.exp(logprob)
                probs[val] = max(probs.get(val, 0.0), p)

    if probs:
        unique_vals = sorted(set(valid_tokens.values()))
        min_val, max_val = min(unique_vals), max(unique_vals)
        total_p = sum(probs.values())
        expected = sum(v * p for v, p in probs.items()) / total_p
        return (expected - min_val) / (max_val - min_val) \
            if max_val > min_val else 0.5

    tag_name = tag.strip("<>")
    pattern = rf"<{re.escape(tag_name)}>\s*(.+?)\s*</{re.escape(tag_name)}>"
    # Last match again: the verdict is the score block at the end.
    matches = list(re.finditer(pattern, text or "", re.IGNORECASE))
    match = matches[-1] if matches else None
    if match:
        tok = match.group(1).strip()
        raw_val = valid_tokens.get(tok)
        if raw_val is None:
            for vt, val in valid_tokens.items():
                if tok.lower() == vt.lower():
                    raw_val = val
                    break
        if raw_val is not None:
            unique_vals = sorted(set(valid_tokens.values()))
            min_val, max_val = min(unique_vals), max(unique_vals)
            return (raw_val - min_val) / (max_val - min_val) \
                if max_val > min_val else 0.5

    return 0.5


class MissingAPIKeyError(Exception):
    pass


class _Usage:
    def reset(self):
        return None

    def snapshot(self):
        return {"calls": 0, "input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0}


USAGE = _Usage()


def create_openai_client(*args, **kwargs):
    raise RuntimeError("fake llm_verifier: no provider access in tests")
