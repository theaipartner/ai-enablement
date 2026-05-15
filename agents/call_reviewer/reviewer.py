"""Call reviewer — generates a structured review for a single call.

Reads the transcript from `calls.transcript`, sends it to Claude with
the SYSTEM_PROMPT, parses the JSON response, returns the dict.
Persistence is the caller's responsibility — `upsert_call_review`
in this package handles writing the documents row.

Speed-mode V1: Sonnet only, single-shot, no chunking. Real Fathom
transcripts run ~10-30k tokens; Sonnet's 200k context handles that
comfortably with output capped at 4096 tokens.

Telemetry: each invocation opens an `agent_runs` row via
`start_agent_run("call_reviewer", "manual_backfill", ...)`. The
Claude call passes `run_id` so token / cost columns auto-populate.
The error path closes the row BEFORE re-raising so a backfill loop
that swallows the exception still leaves valid telemetry.
"""

from __future__ import annotations

import json
import logging
import re
import time
from typing import Any

from shared.claude_client import complete
from shared.logging import end_agent_run, start_agent_run

from agents.call_reviewer.prompt import PROMPT_VERSION, SYSTEM_PROMPT

logger = logging.getLogger("ai_enablement.call_reviewer")

# Output cap. Bumped to 8192 on 2026-05-15 with the v2 prompt: the
# new questions_asked field can produce 10+ items on dense calls,
# which combined with the existing four sections pushed output past
# 4096 tokens mid-JSON for one real call (Dhamen Hothi - Lou - 1 on 1,
# 2026-05-08; JSON truncated at ~15.1k chars / ~3800 tokens). Typical
# reviews still land at 600-1500 tokens; the higher cap is a safety
# net for long-transcript calls with many questions.
_MAX_OUTPUT_TOKENS = 8192

# Top-level keys the response must contain. Extra keys are tolerated;
# missing keys raise.
_REQUIRED_KEYS = (
    "pain_points",
    "wins",
    "dodged_questions",
    "sentiment_arc",
    "questions_asked",
)

# Optional markdown fence stripper. Sonnet usually obeys "no fences"
# but defends-in-depth: ```json\n{...}\n``` and bare ``` variants.
_MARKDOWN_FENCE_RE = re.compile(
    r"^```(?:json)?\s*\n(.*?)\n```\s*$", re.DOTALL
)


def review_call(
    db,
    call_id: str,
    *,
    model: str = "claude-sonnet-4-6",
    trigger_type: str = "manual_backfill",
) -> dict[str, Any]:
    """Generate a call review for the given call_id.

    Returns the parsed JSON dict
    (pain_points, wins, dodged_questions, sentiment_arc).
    Writes nothing — caller handles persistence.

    Args:
        trigger_type: tag for the agent_runs row's trigger_type column.
            Defaults to "manual_backfill" for the one-shot script;
            pipeline-fired auto-review passes "fathom_pipeline" so cost
            rollups can distinguish the two.

    Raises:
        ValueError: when the call doesn't exist, has no transcript,
            or Claude returns an unparseable / malformed response.
    """
    call = _fetch_call(db, call_id)
    transcript = (call.get("transcript") or "").strip()
    if not transcript:
        raise ValueError(
            f"call {call_id} has no transcript; cannot generate review"
        )

    started_ms = int(time.monotonic() * 1000)
    run_id = start_agent_run(
        agent_name="call_reviewer",
        trigger_type=trigger_type,
        trigger_metadata={
            "call_id": call_id,
            "model": model,
            "prompt_version": PROMPT_VERSION,
        },
        input_summary=f"call {call_id}",
    )

    try:
        result = complete(
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": transcript}],
            model=model,
            max_tokens=_MAX_OUTPUT_TOKENS,
            run_id=run_id,
        )
        review = _parse_review_text(result.text)
        _validate_review_shape(review)

        duration_ms = int(time.monotonic() * 1000) - started_ms
        end_agent_run(
            run_id,
            status="success",
            output_summary=(
                f"review: {len(review['pain_points'])} pain, "
                f"{len(review['wins'])} wins, "
                f"{len(review['dodged_questions'])} dodged"
            ),
            duration_ms=duration_ms,
        )
        return review
    except Exception as exc:
        # Close the run BEFORE re-raising so telemetry is correct even
        # when the caller (e.g. backfill loop) swallows the exception.
        duration_ms = int(time.monotonic() * 1000) - started_ms
        end_agent_run(
            run_id,
            status="error",
            error_message=str(exc)[:2000],
            duration_ms=duration_ms,
        )
        raise


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _fetch_call(db, call_id: str) -> dict[str, Any]:
    resp = (
        db.table("calls")
        .select(
            "id, transcript, primary_client_id, started_at, call_category"
        )
        .eq("id", call_id)
        .maybe_single()
        .execute()
    )
    row = resp.data
    if row is None:
        raise ValueError(f"call {call_id} not found")
    return row


def _parse_review_text(text: str) -> dict[str, Any]:
    """Parse the model's response text as a JSON object.

    Handles three known stray-output patterns:
      - markdown fences (```json\n{...}\n```)
      - leading / trailing prose around a single JSON object
      - bare JSON (the happy path)
    """
    cleaned = text.strip()

    fence_match = _MARKDOWN_FENCE_RE.match(cleaned)
    if fence_match:
        cleaned = fence_match.group(1).strip()

    # Trim to the outermost {...} span. Defensive against the model
    # adding an apologetic preamble or a trailing explanation despite
    # the prompt forbidding it.
    first_brace = cleaned.find("{")
    last_brace = cleaned.rfind("}")
    if first_brace == -1 or last_brace == -1 or last_brace <= first_brace:
        raise ValueError(
            f"call_reviewer response did not contain a JSON object; "
            f"got first 200 chars: {text[:200]!r}"
        )
    candidate = cleaned[first_brace : last_brace + 1]

    try:
        parsed = json.loads(candidate)
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"call_reviewer response was not valid JSON: {exc}; "
            f"first 200 chars: {candidate[:200]!r}"
        ) from exc

    if not isinstance(parsed, dict):
        raise ValueError(
            f"call_reviewer response was JSON but not an object "
            f"(got {type(parsed).__name__})"
        )
    return parsed


def _validate_review_shape(review: dict[str, Any]) -> None:
    missing = [k for k in _REQUIRED_KEYS if k not in review]
    if missing:
        raise ValueError(
            f"call_reviewer response missing required keys: {missing}"
        )
    for array_key in ("pain_points", "wins", "dodged_questions", "questions_asked"):
        if not isinstance(review[array_key], list):
            raise ValueError(
                f"call_reviewer response key {array_key!r} must be a list, "
                f"got {type(review[array_key]).__name__}"
            )
    if not isinstance(review["sentiment_arc"], str):
        raise ValueError(
            "call_reviewer response key 'sentiment_arc' must be a string, "
            f"got {type(review['sentiment_arc']).__name__}"
        )
