"""End-to-end orchestration for setter-call Sonnet review.

Public entry point: `review_call(close_call_id)`. It:

  1. Loads the transcript + diarized words from setter_call_transcripts.
  2. Sends the transcript to Sonnet 4.6 with the v1 prompt.
  3. Parses + validates the JSON response.
  4. Computes talk-time from the words array.
  5. Upserts everything to setter_call_reviews.

Idempotent on close_call_id. By default we skip re-reviewing rows
that already exist (a re-run with `force=True` overrides — useful
after a prompt iteration).

Cost telemetry: input/output tokens + USD cost are persisted directly
on the row. Does NOT write to agent_runs — sales LLM spend stays
self-contained inside the sales-dashboard.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from agents.setter_call_reviewer.prompt import PROMPT_VERSION, SYSTEM_PROMPT
from agents.setter_call_reviewer.slack_post import post_review_to_slack
from agents.setter_call_reviewer.talk_time import compute_talk_time
from shared.claude_client import DEFAULT_MODEL, complete

# Gregory's active-lead horizon. A lead whose latest opt-in is before this is a
# cold pre-horizon lead — a call to them is a "revival" (re-engagement) call.
REVIVAL_HORIZON = "2026-05-24"
from shared.db import get_client

logger = logging.getLogger("ai_enablement.setter_call_reviewer")

# Sonnet's output ceiling for this review. v1 prompt outputs ~500-800
# tokens typically; 2048 leaves headroom for chatty calls without
# inviting model verbosity.
_MAX_OUTPUT_TOKENS = 2048

_REQUIRED_KEYS = frozenset(
    {
        "sentiment",
        "lead_score",
        "lead_score_reason",
        "should_be_dqd",
        "dq_reason",
        "booked",
        "no_book_reason",
        "setter_strengths",
        "setter_weaknesses",
        "lead_attributes",
    }
)


class ReviewError(RuntimeError):
    """Raised when the reviewer can't produce a valid review.

    Cases: transcript missing, Sonnet returned non-JSON, JSON
    structurally invalid, required key missing, value out of range.
    The caller decides whether to retry, skip, or surface.
    """


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def review_call(
    close_call_id: str,
    *,
    db: Any | None = None,
    force: bool = False,
    post_to_slack: bool = True,
) -> dict[str, Any]:
    """Review one transcript end-to-end. Returns the upserted review row.

    When `post_to_slack=True` (the default), a Slack message is posted
    to the sales-reviews channel on first review. Re-runs skip the
    post if `slack_message_ts` is already set. Pass `False` to suppress
    Slack entirely (used for the initial backfill of 55 historical
    calls — we don't want to spam the channel with old reviews).
    """
    db = db or get_client()

    if not force:
        existing = _load_existing_review(db, close_call_id)
        if existing:
            logger.info(
                "setter_review.skip_existing close_call_id=%s",
                close_call_id,
            )
            # Existing row — Slack may or may not have posted before.
            # post_review_to_slack is itself idempotent on
            # slack_message_ts, so safe to call. Only call when the
            # caller opts in.
            if post_to_slack:
                _maybe_post_to_slack(db, close_call_id, existing)
            return existing

    transcript_row = _load_transcript(db, close_call_id)
    if not transcript_row:
        raise ReviewError(
            f"no transcript found for {close_call_id} — run transcribe_call first"
        )

    transcript_text = transcript_row["transcript_text"]
    words = transcript_row.get("words") or []

    logger.info(
        "setter_review.sonnet_request close_call_id=%s transcript_chars=%d words=%d",
        close_call_id, len(transcript_text), len(words),
    )

    result = complete(
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": transcript_text}],
        model=DEFAULT_MODEL,
        max_tokens=_MAX_OUTPUT_TOKENS,
        # No run_id — sales pipeline does NOT write to agent_runs.
        run_id=None,
    )

    review = _parse_and_validate(result.text, close_call_id)
    setter_words, prospect_words, talk_ratio = compute_talk_time(words)

    row = {
        "close_call_id": close_call_id,
        "sentiment": review["sentiment"],
        "lead_score": review["lead_score"],
        "lead_score_reason": review["lead_score_reason"],
        "should_be_dqd": review["should_be_dqd"],
        "dq_reason": review["dq_reason"],
        "booked": review["booked"],
        "no_book_reason": review["no_book_reason"],
        "setter_strengths": review["setter_strengths"],
        "setter_weaknesses": review["setter_weaknesses"],
        "lead_attributes": review["lead_attributes"],
        "setter_words": setter_words,
        "prospect_words": prospect_words,
        "talk_ratio_setter": talk_ratio,
        "model": DEFAULT_MODEL,
        "prompt_version": PROMPT_VERSION,
        "sonnet_input_tokens": result.input_tokens,
        "sonnet_output_tokens": result.output_tokens,
        "sonnet_cost_usd": float(result.cost_usd),
    }
    persisted = _upsert(db, row)

    if post_to_slack:
        _maybe_post_to_slack(db, close_call_id, persisted)

    return persisted


def _maybe_post_to_slack(
    db: Any,
    close_call_id: str,
    review_row: dict[str, Any],
) -> None:
    """Resolve setter / prospect context, then hand off to the Slack
    poster. Fail-soft: Slack failures never break the review.

    The context lookup (close_calls + team_members + close_leads) is
    deliberately separate from the persisted review row to keep the
    review table free of denormalized humanized labels — those would
    rot when team_members rows are renamed or merged.
    """
    try:
        ctx = _load_slack_context(db, close_call_id)
        post_review_to_slack(
            db,
            close_call_id=close_call_id,
            review_row=review_row,
            setter_name=ctx["setter_name"],
            prospect_name=ctx["prospect_name"],
            duration_s=ctx["duration_s"],
            direction=ctx["direction"],
            is_revival=ctx.get("is_revival", False),
        )
    except Exception as exc:
        # Defensive — post_review_to_slack already swallows Slack
        # transport errors; this catches anything in the context
        # resolution that went sideways.
        logger.warning(
            "setter_review.slack_context_failed close_call_id=%s err=%s",
            close_call_id, exc,
        )


def _load_slack_context(db: Any, close_call_id: str) -> dict[str, Any]:
    """Pull setter name, prospect name, duration, direction in 3 cheap
    round trips. Returns nullable strings when joins are unresolved.
    """
    # close_calls — the source of duration, direction, user_id, lead_id
    call_resp = (
        db.table("close_calls")
        .select("user_id, lead_id, duration, direction")
        .eq("close_id", close_call_id)
        .maybe_single()
        .execute()
    )
    call = (call_resp.data or {}) if call_resp else {}

    setter_name: str | None = None
    if call.get("user_id"):
        tm_resp = (
            db.table("team_members")
            .select("full_name")
            .eq("close_user_id", call["user_id"])
            .maybe_single()
            .execute()
        )
        if tm_resp and tm_resp.data:
            setter_name = tm_resp.data.get("full_name")

    prospect_name: str | None = None
    is_revival = False
    if call.get("lead_id"):
        ld_resp = (
            db.table("close_leads")
            .select("display_name, latest_opt_in_date")
            .eq("close_id", call["lead_id"])
            .maybe_single()
            .execute()
        )
        if ld_resp and ld_resp.data:
            prospect_name = ld_resp.data.get("display_name")
            # Revival = a cold pre-horizon lead being re-engaged (latest opt-in
            # before the Gregory horizon). Covers the revival SMS batch, since
            # every batch lead is pre-horizon by construction.
            opt_in = ld_resp.data.get("latest_opt_in_date")
            is_revival = bool(opt_in) and str(opt_in)[:10] < REVIVAL_HORIZON

    return {
        "setter_name": setter_name,
        "prospect_name": prospect_name,
        "duration_s": call.get("duration"),
        "direction": call.get("direction"),
        "is_revival": is_revival,
    }


def find_pending_reviews(
    db: Any | None = None,
    *,
    limit: int | None = None,
) -> list[str]:
    """Return close_call_ids that have a transcript but no review yet.

    NOT-EXISTS-style query: pull every transcript_id, exclude any that
    already have a review. Cheap at current volume (~55 rows). Add a
    SQL view if this ever scales past low thousands.
    """
    db = db or get_client()

    trx = (
        db.table("setter_call_transcripts")
        .select("close_call_id")
        .order("transcribed_at", desc=False)
        .execute()
    )
    candidates = [r["close_call_id"] for r in (trx.data or [])]
    if not candidates:
        return []

    done = (
        db.table("setter_call_reviews")
        .select("close_call_id")
        .in_("close_call_id", candidates)
        .execute()
    )
    done_ids = {r["close_call_id"] for r in (done.data or [])}
    pending = [c for c in candidates if c not in done_ids]
    if limit is not None:
        pending = pending[:limit]
    return pending


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _load_transcript(db: Any, close_call_id: str) -> dict[str, Any] | None:
    resp = (
        db.table("setter_call_transcripts")
        .select("close_call_id, transcript_text, words")
        .eq("close_call_id", close_call_id)
        .maybe_single()
        .execute()
    )
    return resp.data if resp and resp.data else None


def _load_existing_review(db: Any, close_call_id: str) -> dict[str, Any] | None:
    resp = (
        db.table("setter_call_reviews")
        .select("*")
        .eq("close_call_id", close_call_id)
        .execute()
    )
    return resp.data[0] if resp.data else None


def _parse_and_validate(text: str, close_call_id: str) -> dict[str, Any]:
    """Pull JSON out of the model response and structurally validate it.

    Sonnet occasionally wraps responses in markdown fences despite the
    prompt forbidding them. Strip those before parsing. After that the
    response must be a JSON object with all required keys and value
    types matching the prompt spec.
    """
    candidate = _strip_fences(text).strip()
    if not candidate:
        raise ReviewError(f"empty response from Sonnet for {close_call_id}")

    try:
        parsed = json.loads(candidate)
    except json.JSONDecodeError as exc:
        raise ReviewError(
            f"non-JSON response for {close_call_id}: {exc}; "
            f"first 200 chars: {candidate[:200]!r}"
        ) from exc

    if not isinstance(parsed, dict):
        raise ReviewError(
            f"response for {close_call_id} not a JSON object: {type(parsed).__name__}"
        )

    missing = _REQUIRED_KEYS - set(parsed.keys())
    if missing:
        raise ReviewError(
            f"response for {close_call_id} missing keys: {sorted(missing)}"
        )

    # Type / range checks. These mirror the prompt contract; if any
    # fails we treat the whole review as failed rather than persisting
    # half-bad data and surfacing it as truth.
    if not isinstance(parsed["lead_score"], int) or not 0 <= parsed["lead_score"] <= 10:
        raise ReviewError(
            f"lead_score out of range for {close_call_id}: {parsed['lead_score']!r}"
        )
    if not isinstance(parsed["should_be_dqd"], bool):
        raise ReviewError(
            f"should_be_dqd not bool for {close_call_id}: {parsed['should_be_dqd']!r}"
        )
    if parsed["should_be_dqd"] and not parsed.get("dq_reason"):
        # The model violated the "always provide reason when true" rule.
        # We could let the DB CHECK fail, but a clearer error here helps
        # the caller decide (retry vs. give up).
        raise ReviewError(
            f"should_be_dqd=true but no dq_reason for {close_call_id}"
        )
    if not isinstance(parsed["booked"], bool):
        raise ReviewError(
            f"booked not bool for {close_call_id}: {parsed['booked']!r}"
        )
    if parsed["booked"] is False and not parsed.get("no_book_reason"):
        raise ReviewError(
            f"booked=false but no no_book_reason for {close_call_id}"
        )
    for arr_key in ("setter_strengths", "setter_weaknesses"):
        if not isinstance(parsed[arr_key], list):
            raise ReviewError(
                f"{arr_key} not list for {close_call_id}: "
                f"{type(parsed[arr_key]).__name__}"
            )
        # 0-2 items per Drake. We hard-cap at the persistence layer
        # rather than retry — if the model returns 3, slice to 2
        # rather than reject (the first two are usually the strongest).
        if len(parsed[arr_key]) > 2:
            logger.warning(
                "setter_review.over_cap close_call_id=%s key=%s len=%d (truncating to 2)",
                close_call_id, arr_key, len(parsed[arr_key]),
            )
            parsed[arr_key] = parsed[arr_key][:2]
    if not isinstance(parsed["lead_attributes"], list):
        raise ReviewError(
            f"lead_attributes not list for {close_call_id}: "
            f"{type(parsed['lead_attributes']).__name__}"
        )

    return parsed


_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE | re.MULTILINE)


def _strip_fences(text: str) -> str:
    return _FENCE_RE.sub("", text)


def _upsert(db: Any, row: dict[str, Any]) -> dict[str, Any]:
    resp = (
        db.table("setter_call_reviews")
        .upsert(row, on_conflict="close_call_id", returning="representation")
        .execute()
    )
    if not resp.data:
        raise ReviewError(
            f"setter_call_reviews upsert returned no row for {row['close_call_id']}"
        )
    logger.info(
        "setter_review.persisted close_call_id=%s score=%s dq=%s booked=%s cost=$%s",
        row["close_call_id"], row["lead_score"], row["should_be_dqd"],
        row["booked"], row["sonnet_cost_usd"],
    )
    return resp.data[0]
