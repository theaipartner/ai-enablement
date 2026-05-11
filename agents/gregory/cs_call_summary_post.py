"""Per-call CS Slack summary post (Batch A — M6.1).

Posts a one-message call summary to the cross-CSM Slack channel on every
successful Fathom webhook delivery for a `call_category='client'` call.
Hooked into `ingestion.fathom.pipeline.ingest_call` after the summary
document is written and after the call_review auto-generation hook,
before the IngestOutcome return.

Design constraints (per Drake's spec):
  - Only client calls trigger the post; other categories skip silently.
  - Edge cases (archived client, no primary_csm) post anyway with
    sentinel labels — "if they become a problem we will remove."
  - Only the review-shaped message is posted. When no usable review
    exists (missing / malformed / degenerate), NO Slack post is made;
    an audit row records the skip. The earlier Fathom-`default_summary`
    fallback was retired because its shape was too cluttered for Slack
    and isn't the format CSMs rely on.
  - Slack-post failure is NEVER fatal to the Fathom webhook delivery.
    Exceptions are caught + logged; the call row + summary doc are
    more important than the Slack message.
  - Audit trail via `webhook_deliveries` with
    `source='cs_call_summary_slack_post'` so debugging "did the post
    happen for call X" doesn't require grepping Vercel logs. Audit
    payload's `content_source` field is one of:
      - 'call_review'        — review-shaped post fired
      - 'skipped_no_review'  — no usable review, no Slack post
    ('fathom_summary_fallback' is retired — old rows keep their value;
    no new rows carry it.)
  - Skip-path note: migration 0011's CHECK constraint on
    `webhook_deliveries.processing_status` only allows
    {'received','processed','failed','duplicate','malformed'} — adding
    'skipped' would require a migration. Skip rows therefore use
    `processing_status='malformed'` + `processing_error='no_review_available'`
    as the dual discriminator, with `payload.content_source='skipped_no_review'`
    as the authoritative tag. This overloads 'malformed' slightly (the
    existing `no_summary_text` skip path uses the same pattern) but
    keeps SQL queries clean and avoids a migration round-trip.

Message format (sentiment-only — the only shape):

    *[CSM Name] / [Client Name]*

    *Sentiment*
    [sentiment_arc]

    <https://ai-enablement-sigma.vercel.app/calls/[call_id]|View in Gregory>

The previous review-shape post additionally rendered Pain points, Wins,
and Conversation pivots sections. Those were dropped 2026-05-11 — CSMs
click through to Gregory for the full review; the Slack post is a
sentiment-only at-a-glance signal. When `sentiment_arc` is missing or
empty, the post is skipped entirely (same shape as the degenerate-review
check). The whole message passes through `markdown_to_mrkdwn` so any
rogue Markdown the LLM emitted gets cleaned before it hits Slack.

Sentinel labels:
  - `[unassigned]` when no active primary_csm
  - `[unknown client]` when primary_client_id resolves to no row

Why headers are emitted as `**Header**` Markdown rather than `*Header*`
mrkdwn directly: `markdown_to_mrkdwn` normalizes `**Header**` cleanly
via its bold-stash mechanism, but a single-asterisk `*Header*` is also
matched by the converter's italic regex and would be re-written to
`_Header_`. Feeding Markdown source through the converter gets us the
intended mrkdwn output AND keeps the safety-net pass active for any
LLM-emitted rogue Markdown in the description / evidence text.
"""

from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any

from agents.call_reviewer.persistence import find_review_by_call_external_id
from shared.slack_format import markdown_to_mrkdwn
from shared.slack_post import post_message

logger = logging.getLogger("ai_enablement.cs_call_summary_post")

# Public-dashboard host for the deep-link. Hardcoded — every deployment
# of this code targets the production Vercel project; if we ever spin up
# a staging deploy we'd want this to derive from env.
_GREGORY_CALL_PATH = "https://ai-enablement-sigma.vercel.app/calls/{call_id}"

# webhook_deliveries source label. Searchable by SQL; do not change
# without updating any audit dashboards.
_DELIVERY_SOURCE = "cs_call_summary_slack_post"

# Audit content_source values. Tagged on the audit-row payload so the
# split between "review available" and "skipped, no usable review" is
# queryable. Treat as enum.
#   'call_review'        — review-shaped post fired
#   'skipped_no_review'  — no usable review, no Slack post
# 'fathom_summary_fallback' is retired — old rows keep their value; no
# new rows carry it.
_CONTENT_SOURCE_REVIEW = "call_review"
_CONTENT_SOURCE_SKIPPED_NO_REVIEW = "skipped_no_review"


def maybe_post_cs_call_summary(
    db,
    *,
    call_id: str,
    call_category: str,
    primary_client_id: str | None,
    summary_text: str | None,
    fathom_external_id: str,
) -> dict[str, Any]:
    """Post the CS call summary for a freshly-ingested call.

    Returns a structured result dict for the caller to log:
      {
        "posted": bool,
        "skipped_reason": str | None,
        "delivery_id": str,
        "slack_ok": bool,
        "slack_error": str | None,
        "content_source": "call_review" | "skipped_no_review" | None,
      }

    NEVER raises. Wraps every internal failure as
    `posted=False, skipped_reason='<reason>'` or in the audit row.
    Caller is the Fathom pipeline; the Fathom webhook delivery must
    not fail because Slack posting failed.

    `summary_text` is unused for posting (the Fathom-summary fallback
    was retired — see module docstring) but kept in the signature to
    avoid touching ingestion/fathom/pipeline.py at the call site.
    """
    delivery_id = f"cs_call_summary_{uuid.uuid4()}"

    # Skip non-client categories silently. No audit row — would clutter
    # webhook_deliveries with "we didn't do anything" for every internal/
    # external/unclassified call.
    if call_category != "client":
        return {
            "posted": False,
            "skipped_reason": "non_client_category",
            "delivery_id": delivery_id,
            "slack_ok": False,
            "slack_error": None,
            "content_source": None,
        }

    # Skip if no summary text (shouldn't happen post-F2.3 for webhook
    # path; possible for backlog re-ingest before summary docs land).
    # Audit row recorded so we can spot if this happens unexpectedly.
    # In the new no-fallback world this skip is redundant with the
    # downstream "no review available" skip (no summary → no review
    # generation → review_text is None → same skip outcome) but kept
    # because it produces a distinct `processing_error='no_summary_text'`
    # discriminator in the audit ledger, which is more diagnostic than
    # the generic "no review available" tag.
    if not summary_text or not summary_text.strip():
        _insert_delivery(
            delivery_id,
            payload={
                "call_id": call_id,
                "fathom_external_id": fathom_external_id,
                "skipped_reason": "no_summary_text",
            },
            status="malformed",
            error="no_summary_text",
            call_external_id=fathom_external_id,
        )
        return {
            "posted": False,
            "skipped_reason": "no_summary_text",
            "delivery_id": delivery_id,
            "slack_ok": False,
            "slack_error": None,
            "content_source": None,
        }

    channel_id = os.environ.get("SLACK_CS_CALL_SUMMARIES_CHANNEL_ID")
    if not channel_id:
        # Misconfiguration — log loudly but don't crash. Audit row
        # captures the gap for triage.
        logger.error(
            "cs_call_summary_post: SLACK_CS_CALL_SUMMARIES_CHANNEL_ID not set"
        )
        _insert_delivery(
            delivery_id,
            payload={
                "call_id": call_id,
                "fathom_external_id": fathom_external_id,
                "skipped_reason": "channel_not_configured",
            },
            status="failed",
            error="SLACK_CS_CALL_SUMMARIES_CHANNEL_ID not set",
            call_external_id=fathom_external_id,
        )
        return {
            "posted": False,
            "skipped_reason": "channel_not_configured",
            "delivery_id": delivery_id,
            "slack_ok": False,
            "slack_error": "channel_not_configured",
            "content_source": None,
        }

    # Resolve labels. Each lookup wrapped in its own try/except so a
    # single failed lookup doesn't break the post — sentinel labels are
    # acceptable per Drake's spec.
    csm_name = _resolve_primary_csm_name(db, primary_client_id)
    client_name = _resolve_client_full_name(db, primary_client_id)

    # Fetch the call_review and try to render the review-shaped message.
    # When no usable review exists (missing / malformed / degenerate),
    # `review_text` is None — we skip the Slack post entirely and record
    # the gap in the audit ledger. The Fathom-summary fallback was
    # retired (see module docstring).
    review, review_fetch_error = _try_get_review(db, fathom_external_id)
    review_text = (
        _format_review_message(
            csm_name=csm_name or "[unassigned]",
            client_name=client_name or "[unknown client]",
            review=review,
            call_id=call_id,
        )
        if review is not None
        else None
    )

    if review_text is None:
        # No usable review — record the skip and bail. No Slack call.
        # See module docstring for the
        # `processing_status='malformed' + processing_error='no_review_available'`
        # rationale (CHECK-constraint workaround; 'skipped' isn't in the
        # enum). `content_source='skipped_no_review'` in the payload is
        # the authoritative discriminator.
        payload: dict[str, Any] = {
            "call_id": call_id,
            "fathom_external_id": fathom_external_id,
            "csm_name": csm_name,
            "client_name": client_name,
            "content_source": _CONTENT_SOURCE_SKIPPED_NO_REVIEW,
        }
        if review_fetch_error is not None:
            payload["review_fetch_error"] = review_fetch_error
        _insert_delivery(
            delivery_id,
            payload=payload,
            status="malformed",
            error="no_review_available",
            call_external_id=fathom_external_id,
        )
        logger.info(
            "cs_call_summary_post: skipped (no review available) "
            "delivery_id=%s call_id=%s",
            delivery_id,
            call_id,
        )
        return {
            "posted": False,
            "skipped_reason": "no_review_available",
            "delivery_id": delivery_id,
            "slack_ok": False,
            "slack_error": None,
            "content_source": _CONTENT_SOURCE_SKIPPED_NO_REVIEW,
        }

    text = markdown_to_mrkdwn(review_text)
    content_source = _CONTENT_SOURCE_REVIEW

    payload = {
        "call_id": call_id,
        "fathom_external_id": fathom_external_id,
        "csm_name": csm_name,
        "client_name": client_name,
        "content_source": content_source,
    }

    # Insert the audit row BEFORE the post so even a Slack-side failure
    # leaves a record. UPDATE to terminal status after the post.
    _insert_delivery(
        delivery_id,
        payload=payload,
        status="received",
        error=None,
        call_external_id=fathom_external_id,
    )

    result = post_message(channel_id, text)
    if result["ok"]:
        _mark_delivery(delivery_id, status="processed", error=None)
        logger.info(
            "cs_call_summary_post: posted delivery_id=%s call_id=%s "
            "content_source=%s",
            delivery_id,
            call_id,
            content_source,
        )
        return {
            "posted": True,
            "skipped_reason": None,
            "delivery_id": delivery_id,
            "slack_ok": True,
            "slack_error": None,
            "content_source": content_source,
        }

    # Slack-side failure. Log + mark audit row failed; never raise.
    _mark_delivery(
        delivery_id,
        status="failed",
        error=str(result.get("slack_error"))[:2000],
    )
    logger.warning(
        "cs_call_summary_post: slack post failed delivery_id=%s slack_error=%s",
        delivery_id,
        result.get("slack_error"),
    )
    return {
        "posted": False,
        "skipped_reason": "slack_post_failed",
        "delivery_id": delivery_id,
        "slack_ok": False,
        "slack_error": result.get("slack_error"),
        "content_source": content_source,
    }


# ---------------------------------------------------------------------------
# Label resolution
# ---------------------------------------------------------------------------


def _resolve_primary_csm_name(db, client_id: str | None) -> str | None:
    """Return the active primary_csm's full_name for a client, or None.

    Mirrors api/accountability_roster.py's lookup pattern: query
    client_team_assignments with role='primary_csm' AND unassigned_at
    IS NULL, JOIN to team_members for the full_name.
    """
    if not client_id:
        return None
    try:
        resp = (
            db.table("client_team_assignments")
            .select("team_members(full_name)")
            .eq("client_id", client_id)
            .eq("role", "primary_csm")
            .is_("unassigned_at", "null")
            .limit(1)
            .execute()
        )
    except Exception as exc:
        logger.warning(
            "cs_call_summary_post: primary_csm lookup failed for client_id=%s: %s",
            client_id,
            exc,
        )
        return None
    rows = resp.data or []
    if not rows:
        return None
    tm = rows[0].get("team_members")
    if isinstance(tm, dict):
        return tm.get("full_name")
    return None


def _resolve_client_full_name(db, client_id: str | None) -> str | None:
    """Return the client's full_name (or None). Includes archived rows
    so an archived client still gets a name in the message."""
    if not client_id:
        return None
    try:
        resp = (
            db.table("clients")
            .select("full_name")
            .eq("id", client_id)
            .limit(1)
            .execute()
        )
    except Exception as exc:
        logger.warning(
            "cs_call_summary_post: client lookup failed for client_id=%s: %s",
            client_id,
            exc,
        )
        return None
    rows = resp.data or []
    if not rows:
        return None
    return rows[0].get("full_name")


# ---------------------------------------------------------------------------
# Review fetch
# ---------------------------------------------------------------------------


def _try_get_review(
    db, fathom_external_id: str
) -> tuple[dict[str, Any] | None, str | None]:
    """Return (parsed_review_or_None, fetch_error_or_None).

    Wraps `find_review_by_call_external_id` so DB errors during the
    review lookup don't break the post path. The review is value-add;
    the Fathom summary fallback always exists. On exception we return
    (None, str(exc)) so the caller can record the error in the audit
    payload while still falling through to fallback.
    """
    try:
        return find_review_by_call_external_id(db, fathom_external_id), None
    except Exception as exc:
        logger.warning(
            "cs_call_summary_post: review fetch failed for external_id=%s: %s",
            fathom_external_id,
            exc,
        )
        return None, str(exc)[:500]


# ---------------------------------------------------------------------------
# Message formatting
# ---------------------------------------------------------------------------


def _format_review_message(
    *,
    csm_name: str,
    client_name: str,
    review: dict[str, Any],
    call_id: str,
) -> str | None:
    """Render the sentiment-only Slack message.

    Returns None when `sentiment_arc` is missing or empty — caller treats
    that as a degenerate review and skips the Slack post entirely.

    Headers emitted as `**Header**` Markdown so `markdown_to_mrkdwn`
    normalizes them to mrkdwn bold via its bold-stash mechanism.
    Single-asterisk `*Header*` would survive the bold step but get
    eaten by the italic regex; double-asterisk Markdown is the safe
    input shape — applies to both the top `**CSM / Client**` header
    and the `**Sentiment**` section header.
    """
    sections: list[str] = []

    sentiment_arc = review.get("sentiment_arc")
    if isinstance(sentiment_arc, str) and sentiment_arc.strip():
        sections.append(f"**Sentiment**\n{sentiment_arc.strip()}")

    if not sections:
        # Missing or empty sentiment — degenerate render. Caller skips.
        return None

    deep_link = _GREGORY_CALL_PATH.format(call_id=call_id)
    body = "\n\n".join(sections)
    return (
        f"**{csm_name} / {client_name}**\n"
        f"\n"
        f"{body}\n"
        f"\n"
        f"<{deep_link}|View in Gregory>"
    )


# ---------------------------------------------------------------------------
# webhook_deliveries audit (mirrors api/airtable_nps_webhook.py pattern)
# ---------------------------------------------------------------------------


def _insert_delivery(
    delivery_id: str,
    *,
    payload: Any,
    status: str,
    error: str | None,
    call_external_id: str | None,
) -> None:
    """Insert the initial audit row. Caught broadly so an audit failure
    never propagates."""
    try:
        from shared.db import get_client

        db = get_client()
        row: dict[str, Any] = {
            "webhook_id": delivery_id,
            "source": _DELIVERY_SOURCE,
            "processing_status": status,
            "payload": payload,
            "headers": {},
            "call_external_id": call_external_id,
        }
        if error is not None:
            row["processing_error"] = error[:2000]
        if status != "received":
            row["processed_at"] = datetime.now(timezone.utc).isoformat()
        db.table("webhook_deliveries").insert(row).execute()
    except Exception as exc:
        logger.warning(
            "cs_call_summary_post: audit row insert failed delivery_id=%s: %s",
            delivery_id,
            exc,
        )


def _mark_delivery(
    delivery_id: str,
    *,
    status: str,
    error: str | None,
) -> None:
    """UPDATE the audit row to a terminal status."""
    try:
        from shared.db import get_client

        db = get_client()
        update: dict[str, Any] = {
            "processing_status": status,
            "processed_at": datetime.now(timezone.utc).isoformat(),
        }
        if error is not None:
            update["processing_error"] = error[:2000]
        db.table("webhook_deliveries").update(update).eq(
            "webhook_id", delivery_id
        ).execute()
    except Exception as exc:
        logger.warning(
            "cs_call_summary_post: audit row update failed delivery_id=%s: %s",
            delivery_id,
            exc,
        )
