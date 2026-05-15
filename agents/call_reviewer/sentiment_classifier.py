"""Sentiment-tier classifier for call_review documents.

Reads a `sentiment_arc` string (already produced by the reviewer agent
on the full transcript) and asks Haiku to bucket it into one of three
tiers — `green`, `yellow`, `red` — for visual display on the dashboard.

Display-only signal: never load-bearing on any retrieval or
classification path. Failures fall back to `yellow` so a write that
goes through this path always lands with a value present.

Telemetry: each invocation opens its own `agent_runs` row with
`agent_name='call_reviewer'` (so it joins the call-review cost
attribution alongside the Sonnet review pass) and
`trigger_type='sentiment_classifier'` (so audit queries can split
the Haiku sentiment spend from the Sonnet review spend within the
same agent). The cost hub's Call Review Haiku bucket reads this.
Telemetry is fail-soft — a logging failure must never break the
display-only classification or its fallback-to-yellow contract;
if the run can't be opened the classification still happens, just
untracked (degrades to the pre-2026-05-15 behavior).
"""

from __future__ import annotations

import logging
import time

from shared.claude_client import complete
from shared.logging import end_agent_run, start_agent_run

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

    # Open a telemetry row. Fail-soft: if this raises, run_id stays
    # None, complete() skips the cost write, and the classification
    # still happens — same as the pre-telemetry behavior.
    run_id: str | None = None
    started_ms = int(time.monotonic() * 1000)
    try:
        run_id = start_agent_run(
            agent_name="call_reviewer",
            trigger_type="sentiment_classifier",
            trigger_metadata={"model": _MODEL},
            input_summary=f"sentiment_arc: {sentiment_arc[:200]}",
        )
    except Exception as exc:
        logger.warning(
            "sentiment_classifier: start_agent_run failed (%s); "
            "proceeding untracked",
            exc,
        )

    try:
        result = complete(
            system="",
            messages=[{"role": "user", "content": prompt}],
            model=_MODEL,
            max_tokens=_MAX_TOKENS,
            run_id=run_id,
        )
    except Exception as exc:
        # The Haiku call itself failed. Close the run as error (cost
        # stays $0 — no tokens were billed) then re-raise so the
        # caller (upsert_call_review) keeps its existing
        # write-without-sentiment_tier fallback.
        if run_id is not None:
            try:
                end_agent_run(
                    run_id,
                    status="error",
                    error_message=f"{type(exc).__name__}: {exc}"[:2000],
                    duration_ms=int(time.monotonic() * 1000) - started_ms,
                )
            except Exception:
                pass
        raise

    tier = result.text.strip().lower()
    resolved = tier if tier in _VALID_TIERS else _FALLBACK_TIER
    if tier not in _VALID_TIERS:
        logger.warning(
            "sentiment_classifier: unexpected response %r — falling back to %r",
            result.text,
            _FALLBACK_TIER,
        )

    if run_id is not None:
        try:
            end_agent_run(
                run_id,
                status="success",
                output_summary=f"tier={resolved}",
                duration_ms=int(time.monotonic() * 1000) - started_ms,
            )
        except Exception as exc:
            logger.warning(
                "sentiment_classifier: end_agent_run failed (%s)", exc
            )

    return resolved
