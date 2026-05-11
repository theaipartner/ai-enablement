"""Per-minute Vercel Cron — drains the pending_ella_responses queue.

Ella V2 Batch 2.3. Posts here every minute. Per invocation:

  1. Auth: validate `Authorization: Bearer ${CRON_SECRET}`.
  2. Pick due rows: queued + respond_after_ts <= now(), oldest first,
     LIMIT 50 (caps catch-up traffic during backlog recovery).
  3. Per row:
     - Re-check global kill switch (ELLA_PASSIVE_MONITORING_ENABLED).
     - Re-check per-channel passive_monitoring_enabled.
     - CSM-intervention check: any team_member or Ella message in the
       channel since the triggering ts -> cancel.
     - Dispatch by haiku_decision:
        respond_substantive -> agents.ella.agent.respond_to_passive_trigger
        respond_general_inquiry -> agents.ella.agent.handle_passive_general_inquiry
     - Mark row terminal (responded / cancelled_* / error).
  4. Per-row fail-soft: a bad row never blocks the queue.
  5. Returns 200 with a small summary JSON.

Backlog recovery: if the global kill switch is off, every drained row
marks cancelled_kill_switch and the queue clears cleanly. Without the
kill switch a 60-minute outage backs up ~60 * 50 = 3000 rows; draining
at 50/min = 60 minutes of catch-up traffic. The kill switch is the
recovery lever.

Env vars required:
  CRON_SECRET                          — Vercel Cron Bearer auth
                                         (consolidated to single-var
                                         per project in M6.2).
  ELLA_PASSIVE_MONITORING_ENABLED      — must be 'true' (case-insensitive)
                                         for the cron to actually respond.
                                         Anything else cancels all due rows
                                         with status='cancelled_kill_switch'.
  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — shared.db
  SLACK_BOT_TOKEN                      — shared.slack_post
  ANTHROPIC_API_KEY                    — shared.claude_client (substantive
                                         path Sonnet generation)
  OPENAI_API_KEY                       — shared.kb_query (substantive
                                         path KB retrieval)

Manual trigger:
  curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \\
       https://ai-enablement-sigma.vercel.app/api/passive_ella_cron
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from shared.db import get_client  # noqa: E402
from shared.slack_identity import get_user_id_for_token  # noqa: E402

logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.passive_ella_cron")
logger.setLevel(logging.INFO)

# Max rows drained per invocation. Caps catch-up traffic.
_MAX_PER_RUN = 50


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        try:
            self._handle()
        except Exception as exc:
            logger.exception(
                "passive_ella_cron: unhandled top-level error: %s", exc
            )
            self._respond(500, {"error": "internal_error"})

    def do_GET(self) -> None:
        # Same auth + behavior as POST so a manual curl works the same
        # way Vercel Cron's POST does.
        self.do_POST()

    def _handle(self) -> None:
        if not _verify_auth(self.headers):
            self._respond(401, {"error": "unauthorized"})
            return
        result = run_passive_ella_cron()
        self._respond(200, result)

    def _respond(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------


def run_passive_ella_cron() -> dict[str, Any]:
    """Drain at most `_MAX_PER_RUN` due rows. Returns the per-invocation
    summary the HTTP layer serializes."""
    db = get_client()
    now_iso = datetime.now(timezone.utc).isoformat()

    due_rows = _select_due_rows(db, now_iso, limit=_MAX_PER_RUN)
    counts = {"processed": 0, "responded": 0, "cancelled": 0, "errored": 0}

    global_kill_switch_off = not _global_kill_switch_on()
    bot_user_id = _resolve_bot_user_id()
    ella_user_id = _resolve_ella_user_id()

    for row in due_rows:
        counts["processed"] += 1
        try:
            outcome = _process_row(
                db,
                row,
                global_kill_switch_off=global_kill_switch_off,
                bot_user_id=bot_user_id,
                ella_user_id=ella_user_id,
            )
            if outcome == "responded":
                counts["responded"] += 1
            elif outcome.startswith("cancelled_"):
                counts["cancelled"] += 1
            elif outcome == "error":
                counts["errored"] += 1
        except Exception as exc:
            logger.exception(
                "passive_ella_cron: row processing failed pending_id=%s: %s",
                row.get("id"),
                exc,
            )
            counts["errored"] += 1
            # Best-effort mark as error so the row doesn't get retried
            # in a tight loop. If THIS update also fails, the row stays
            # 'queued' and gets retried next minute — acceptable.
            try:
                _mark_row(
                    db,
                    row["id"],
                    status="error",
                    error_message=f"{type(exc).__name__}: {exc}"[:2000],
                )
            except Exception:
                logger.warning(
                    "passive_ella_cron: error-status update also failed for "
                    "pending_id=%s — row will be retried",
                    row.get("id"),
                )

    logger.info(
        "passive_ella_cron: drained processed=%d responded=%d "
        "cancelled=%d errored=%d",
        counts["processed"],
        counts["responded"],
        counts["cancelled"],
        counts["errored"],
    )
    return counts


# ---------------------------------------------------------------------------
# Per-row processing
# ---------------------------------------------------------------------------


def _process_row(
    db,
    row: dict[str, Any],
    *,
    global_kill_switch_off: bool,
    bot_user_id: str | None,
    ella_user_id: str | None,
) -> str:
    """Returns the terminal status string the row was marked with so
    the outer loop can tally the counts."""
    pending_id = row["id"]
    channel_id = row["slack_channel_id"]
    triggering_ts = row["triggering_message_ts"]

    # Re-check global kill switch first — cheapest gate, applies to all
    # rows uniformly.
    if global_kill_switch_off:
        _mark_row(db, pending_id, status="cancelled_kill_switch")
        return "cancelled_kill_switch"

    # Re-check per-channel toggle — Drake may have flipped this off
    # mid-window. Don't trust the snapshot taken at insert time.
    channel = _lookup_channel(db, channel_id)
    if not channel or not channel.get("passive_monitoring_enabled"):
        _mark_row(db, pending_id, status="cancelled_channel_disabled")
        return "cancelled_channel_disabled"

    # CSM-intervention check.
    if _csm_intervened(
        db,
        channel_id=channel_id,
        since_ts=triggering_ts,
        bot_user_id=bot_user_id,
        ella_user_id=ella_user_id,
    ):
        _mark_row(db, pending_id, status="cancelled_csm_intervened")
        return "cancelled_csm_intervened"

    # All gates passed — dispatch the response.
    haiku_decision = row.get("haiku_decision")
    if haiku_decision == "respond_substantive":
        from agents.ella.agent import respond_to_passive_trigger

        result = respond_to_passive_trigger(row)
    elif haiku_decision == "respond_general_inquiry":
        from agents.ella.agent import handle_passive_general_inquiry

        result = handle_passive_general_inquiry(row)
    else:
        _mark_row(
            db,
            pending_id,
            status="error",
            error_message=f"unknown_haiku_decision={haiku_decision!r}",
        )
        return "error"

    if result.posted:
        _mark_row(db, pending_id, status="responded")
        return "responded"
    _mark_row(
        db,
        pending_id,
        status="error",
        error_message=(
            f"slack_post_failed: {result.slack_error}"
            if result.slack_error
            else "slack_post_failed_no_error"
        ),
    )
    return "error"


# ---------------------------------------------------------------------------
# CSM-intervention check
# ---------------------------------------------------------------------------


def _csm_intervened(
    db,
    *,
    channel_id: str,
    since_ts: str,
    bot_user_id: str | None,
    ella_user_id: str | None,
) -> bool:
    """Return True if any team_member or Ella message landed in
    `channel_id` after `since_ts`.

    The query uses (slack_channel_id, sent_at) for the time scan but
    we need to filter on the slack_ts string (lexicographic ordering
    matches chronological because slack_ts is zero-padded
    seconds.microseconds). Slack thread replies have the same
    slack_channel_id as the main channel, so the check naturally
    covers thread interventions too.

    Excludes Ella's own posts (bot + user tokens) so a passive cron
    that posted in the channel for an EARLIER row doesn't suppress
    the NEXT row from firing.
    """
    resp = (
        db.table("slack_messages")
        .select("slack_user_id,author_type,slack_ts")
        .eq("slack_channel_id", channel_id)
        .gt("slack_ts", since_ts)
        .in_("author_type", ["team_member", "ella"])
        .limit(20)
        .execute()
    )
    rows = resp.data or []
    for row in rows:
        uid = row.get("slack_user_id")
        if uid and uid in {bot_user_id, ella_user_id}:
            continue
        return True
    return False


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------


def _select_due_rows(db, now_iso: str, *, limit: int) -> list[dict[str, Any]]:
    resp = (
        db.table("pending_ella_responses")
        .select("*")
        .eq("status", "queued")
        .lte("respond_after_ts", now_iso)
        .order("respond_after_ts", desc=False)
        .limit(limit)
        .execute()
    )
    return list(resp.data or [])


def _lookup_channel(db, slack_channel_id: str) -> dict[str, Any] | None:
    resp = (
        db.table("slack_channels")
        .select("id,slack_channel_id,passive_monitoring_enabled")
        .eq("slack_channel_id", slack_channel_id)
        .limit(1)
        .execute()
    )
    rows = resp.data or []
    return rows[0] if rows else None


def _mark_row(
    db,
    pending_id: str,
    *,
    status: str,
    error_message: str | None = None,
) -> None:
    update: dict[str, Any] = {"status": status}
    if status == "responded":
        update["responded_at"] = datetime.now(timezone.utc).isoformat()
    if error_message is not None:
        update["error_message"] = error_message[:2000]
    db.table("pending_ella_responses").update(update).eq(
        "id", pending_id
    ).execute()


# ---------------------------------------------------------------------------
# Kill switch + bot/Ella identity
# ---------------------------------------------------------------------------


def _global_kill_switch_on() -> bool:
    return (
        (os.environ.get("ELLA_PASSIVE_MONITORING_ENABLED") or "").lower()
        == "true"
    )


def _resolve_bot_user_id() -> str | None:
    """Resolve the bot's slack_user_id via auth.test (cached in
    shared.slack_identity). Mirrors realtime_ingest's resolution."""
    return get_user_id_for_token(os.environ.get("SLACK_BOT_TOKEN"))


def _resolve_ella_user_id() -> str | None:
    """Resolve Ella's human user id via auth.test against SLACK_USER_TOKEN.
    Matches the realtime ingest's `_load_resolvers` pattern."""
    return get_user_id_for_token(os.environ.get("SLACK_USER_TOKEN"))


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def _verify_auth(headers: Any) -> bool:
    expected = os.environ.get("CRON_SECRET") or ""
    if not expected:
        logger.error("passive_ella_cron: CRON_SECRET not configured")
        return False
    auth_header = (
        headers.get("Authorization") or headers.get("authorization") or ""
    )
    if not auth_header.startswith("Bearer "):
        return False
    presented = auth_header[len("Bearer "):]
    return hmac.compare_digest(presented, expected)
