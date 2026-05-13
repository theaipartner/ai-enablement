"""Sentiment-tier classifier for call_review documents.

Reads a `sentiment_arc` string (already produced by the reviewer agent
on the full transcript) and asks Haiku to bucket it into one of three
tiers — `green`, `yellow`, `red` — for visual display on the dashboard.

Display-only signal: never load-bearing on any retrieval or
classification path. Failures fall back to `yellow` so a write that
goes through this path always lands with a value present.

The function is intentionally utility-shaped: no `run_id`, no
agent_runs telemetry. Per spec § A: cost is rolled into the
call-review pipeline's existing cost-attribution path if it cares, or
accepted as untracked otherwise.
"""

from __future__ import annotations

import logging

from shared.claude_client import complete

logger = logging.getLogger("ai_enablement.call_reviewer.sentiment_classifier")

_MODEL = "claude-haiku-4-5-20251001"
_MAX_TOKENS = 10
_VALID_TIERS = {"green", "yellow", "red"}
_FALLBACK_TIER = "yellow"

_PROMPT_TEMPLATE = """\
Classify the sentiment of this call summary as one of: green, yellow, or red.

Green = the call went well, the client relationship is healthy, momentum is building.
Yellow = mixed signals, some friction or concern surfaced but the relationship is intact.
Red = the call went poorly, the client is frustrated, the relationship needs attention.

Respond with only the word: green, yellow, or red.

Sentiment arc:
{sentiment_arc}"""


def classify_sentiment_tier(sentiment_arc: str) -> str:
    """Classify a call's sentiment arc as 'green', 'yellow', or 'red'.

    Args:
        sentiment_arc: the `sentiment_arc` field from a parsed call review.

    Returns:
        One of 'green', 'yellow', 'red'. On any unexpected model output
        (empty, multi-word, refusal, a synonym like "positive"), returns
        the safe middle default 'yellow' and logs a warning so a pattern
        of refusals is visible without breaking the writer.
    """
    prompt = _PROMPT_TEMPLATE.format(sentiment_arc=sentiment_arc)
    result = complete(
        system="",
        messages=[{"role": "user", "content": prompt}],
        model=_MODEL,
        max_tokens=_MAX_TOKENS,
    )
    tier = result.text.strip().lower()
    if tier in _VALID_TIERS:
        return tier
    logger.warning(
        "sentiment_classifier: unexpected response %r — falling back to %r",
        result.text,
        _FALLBACK_TIER,
    )
    return _FALLBACK_TIER
