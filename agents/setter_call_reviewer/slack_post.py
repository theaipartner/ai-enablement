"""Slack post for setter-call reviews.

Posts a per-call summary message to the sales-reviews channel via the
shared Ella bot token (`SLACK_BOT_TOKEN`). Drake's call 2026-05-27:
reuse Ella's existing Slack app rather than spin up a sales-only one
— the bot lives in the sales-reviews channel as an invitee.

Channel ID is hardcoded as a module constant (the existing convention
across this codebase — see api/wistia_sync_cron.py docstrings for the
same prod URL hardcode). Easy to change in one place; doesn't require
a Vercel env-var rotation.

Idempotency: the caller passes the review row (which has slack_message_ts
nullable). When that column is already set, we skip — never double-post.
On successful post we update the row with channel + ts + posted_at so
re-runs are stable.

Failure shape mirrors shared.slack_post: NEVER raises. Returns the
ts on success, None on failure (with the failure logged).
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any

from shared.slack_post import post_message

logger = logging.getLogger("ai_enablement.setter_call_reviewer.slack")

# Sales review channel — Drake created the channel and invited Ella's
# bot 2026-05-27. Override via env var if rotated.
DEFAULT_CHANNEL_ID = "C0B6AU8KWLW"
_CHANNEL_ENV_VAR = "SETTER_REVIEWS_SLACK_CHANNEL"

# Production base URL for the Gregory dashboard. Used to deep-link
# from the Slack message to the full review page. Mirrors the hardcode
# pattern across api/*_cron.py docstrings rather than introducing a
# new env var for this.
_APP_BASE_URL = "https://ai-enablement-sigma.vercel.app"


def post_review_to_slack(
    db: Any,
    *,
    close_call_id: str,
    review_row: dict[str, Any],
    setter_name: str | None,
    prospect_name: str | None,
    duration_s: float | None,
    direction: str | None,
    is_revival: bool = False,
) -> str | None:
    """Post one review to the sales-reviews channel. Returns the Slack
    `ts` on success, None on failure or skip.

    Skips silently if review_row.slack_message_ts is already set —
    that's the don't-double-post contract. Updates the row's
    slack_channel / slack_message_ts / slack_posted_at columns on
    successful post.
    """
    if review_row.get("slack_message_ts"):
        logger.info(
            "setter_review.slack_skip_already_posted close_id=%s ts=%s",
            close_call_id, review_row.get("slack_message_ts"),
        )
        return review_row.get("slack_message_ts")

    channel = os.environ.get(_CHANNEL_ENV_VAR) or DEFAULT_CHANNEL_ID
    text, blocks = _build_message(
        close_call_id=close_call_id,
        review_row=review_row,
        setter_name=setter_name,
        prospect_name=prospect_name,
        duration_s=duration_s,
        direction=direction,
        is_revival=is_revival,
    )

    result = post_message(channel_id=channel, text=text, blocks=blocks)
    if not result.get("ok") or not result.get("ts"):
        logger.warning(
            "setter_review.slack_post_failed close_id=%s err=%s",
            close_call_id, result.get("slack_error"),
        )
        return None

    ts = result["ts"]
    # Update the row so we never repost. Best-effort — a missed update
    # would surface as a duplicate post on the next review run, but
    # find_pending_reviews would have already filtered it out so this
    # is a vanishingly rare path. Failing this update should not fail
    # the broader review.
    try:
        db.table("setter_call_reviews").update(
            {
                "slack_channel": channel,
                "slack_message_ts": ts,
                "slack_posted_at": datetime.now(timezone.utc).isoformat(),
            }
        ).eq("close_call_id", close_call_id).execute()
    except Exception as exc:
        logger.warning(
            "setter_review.slack_ts_persist_failed close_id=%s ts=%s err=%s",
            close_call_id, ts, exc,
        )

    logger.info(
        "setter_review.slack_posted close_id=%s ts=%s channel=%s",
        close_call_id, ts, channel,
    )
    return ts


# ---------------------------------------------------------------------------
# Message construction
# ---------------------------------------------------------------------------


def _build_message(
    *,
    close_call_id: str,
    review_row: dict[str, Any],
    setter_name: str | None,
    prospect_name: str | None,
    duration_s: float | None,
    direction: str | None,
    is_revival: bool = False,
) -> tuple[str, list[dict[str, Any]]]:
    """Compose the Slack mrkdwn message + Block Kit payload.

    Format philosophy: brief at-a-glance scannable line + sentiment as
    a quote + link to the full review. Score / DQ / booked encoded with
    emoji+text so the message is parseable even when blocks fail to
    render (rare in modern clients).
    """
    score = review_row.get("lead_score") or 0
    dq = bool(review_row.get("should_be_dqd"))
    sentiment = (review_row.get("sentiment") or "").strip()
    dq_reason = (review_row.get("dq_reason") or "").strip()

    # Outcome is call-type-dependent. Revival (Digital College) calls are
    # graded on closing on the phone — closed / no_close_reason. Outbound
    # setting calls are graded on booking — booked / no_book_reason.
    if is_revival:
        outcome_hit = bool(review_row.get("closed"))
        outcome_reason = (review_row.get("no_close_reason") or "").strip()
        outcome_yes, outcome_no = "Closed", "Not closed"
        outcome_reason_label = "Why didn't close"
    else:
        outcome_hit = bool(review_row.get("booked"))
        outcome_reason = (review_row.get("no_book_reason") or "").strip()
        outcome_yes, outcome_no = "Booked", "Not booked"
        outcome_reason_label = "Why didn't book"

    setter = setter_name or "Unknown setter"
    prospect = prospect_name or "Unknown prospect"
    duration_label = _format_duration(duration_s)
    direction_label = (direction or "").lower() or "—"

    # Plain-text fallback (used by mobile push, screen readers, and
    # any client that doesn't render the Block Kit payload). Keep
    # under ~250 chars so push notifications surface the gist.
    fallback_text = (
        f"{'🔁 REVIVAL  ·  ' if is_revival else ''}"
        f"{setter} → {prospect}  ·  Score {score}/10"
        f"{'  ·  DQ FLAGGED' if dq else ''}"
        f"  ·  {outcome_yes if outcome_hit else outcome_no}"
        f"  ·  {duration_label}"
    )

    detail_url = f"{_APP_BASE_URL}/sales-dashboard/calls/{close_call_id}"

    # ------------------------------------------------------------------
    # Block Kit payload
    # ------------------------------------------------------------------

    # Header line — bold setter → prospect, score chip, booked chip,
    # DQ chip when present.
    score_emoji = _score_emoji(score)
    outcome_emoji = ":white_check_mark:" if outcome_hit else ":no_entry_sign:"
    outcome_label = outcome_yes if outcome_hit else outcome_no
    headline_parts = [
        f"*{setter}* → *{prospect}*",
        f"{score_emoji} *{score}/10*",
        f"{outcome_emoji} {outcome_label}",
    ]
    if dq:
        headline_parts.append(":rotating_light: *DQ flagged*")
    # Revival chip — a call to a cold pre-horizon lead (re-engagement campaign).
    if is_revival:
        headline_parts.append(":repeat: *Revival*")
    headline = "  ·  ".join(headline_parts)

    # Sub-line — duration / direction / call-id (short).
    subline = (
        f":clock4: {duration_label}  ·  :telephone_receiver: {direction_label}"
        f"  ·  `{close_call_id[:18]}…`"
    )

    blocks: list[dict[str, Any]] = [
        {"type": "section", "text": {"type": "mrkdwn", "text": headline}},
        {
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": subline}],
        },
    ]

    if sentiment:
        blocks.append(
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": f">{_escape_mrkdwn(sentiment)}"},
            }
        )

    if dq and dq_reason:
        blocks.append(
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": f":rotating_light: *DQ reason:* {_escape_mrkdwn(dq_reason)}",
                },
            }
        )

    if not outcome_hit and outcome_reason:
        blocks.append(
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": f":no_entry_sign: *{outcome_reason_label}:* {_escape_mrkdwn(outcome_reason)}",
                },
            }
        )

    # Action row — link to the full review on Gregory.
    blocks.append(
        {
            "type": "actions",
            "elements": [
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "Open full review →"},
                    "url": detail_url,
                    "style": "primary",
                }
            ],
        }
    )

    return fallback_text, blocks


def _score_emoji(score: int) -> str:
    # Same tone contract as the UI: 0-3 red, 4-6 neutral, 7-10 green.
    if score <= 3:
        return ":red_circle:"
    if score <= 6:
        return ":white_circle:"
    return ":large_green_circle:"


def _format_duration(seconds: float | None) -> str:
    if seconds is None:
        return "—"
    m = int(seconds // 60)
    s = int(seconds - m * 60)
    return f"{m}:{s:02d}"


def _escape_mrkdwn(text: str) -> str:
    """Slack mrkdwn escape — only the characters that would break the
    blockquote / context line. Aggressive escaping makes messages ugly;
    we only need to stop accidental formatting.
    """
    return text.replace("<", "&lt;").replace(">", "&gt;")
