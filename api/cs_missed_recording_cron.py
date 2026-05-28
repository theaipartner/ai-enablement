"""Missed-recording flagger cron → cs-call-summaries.

Vercel Cron POSTs here every 15 minutes. Surfaces calendar meetings
that should have produced a Fathom recording but didn't: a
`calendar_events` row whose `end_time + 30min` has passed with no
matching `calls` row gets one post to the cs-call-summaries channel —
`[title] — recording not available` — so the CSM team notices a call
that wasn't captured.

This is the time-based complement to `agents/gregory/cs_call_summary_post.py`:
that hook fires when a recording DOES arrive (on Fathom ingest); this
cron fires when one DOESN'T (the recording never comes, so no ingest
ever triggers). Both land in the same channel.

The detection mirrors the Fulfillment Dashboard's missed-recording
logic (`lib/db/fulfillment-dashboard.ts:getDashboardNotifications`):
calendar_events already contains only external-attendee meetings (the
teams sync filters internal blocks out), so every row is a meeting that
should have been recorded. A meeting is "missed" when its grace period
(end_time + 30min) has elapsed AND no client `calls` row matches it by
title (case-insensitive) within ±30min of the event start.

Pipeline (one audit row per posted item; one for disabled / config gap):

  1. Auth via `CRON_SECRET` bearer token (shared across crons).
  2. Resolve cs-call-summaries id from `SLACK_CS_CALL_SUMMARIES_CHANNEL_ID`
     (the same channel the per-call summary uses). Unset -> 500 + audit
     row noting the config gap (gate (d) — Drake sets it in Vercel).
  3. SELECT candidate events: `missing_recording_posted_at IS NULL`,
     end_time <= now-30min (grace elapsed), end_time >= now-7d (backstop
     against resurfacing ancient events on first run), capped at 100/tick.
  4. Fetch candidate client calls spanning the events' match windows.
  5. Per event: if a client call matches (normalized title equality +
     ±30min of event start), skip (recording exists; leave unstamped so
     it ages out via the backstop). Else post the "recording not
     available" line, stamp `missing_recording_posted_at`, write audit.
  6. Per-item Slack failure is isolated — audit + continue.
  7. Return 200 with checked / matched / posted summary.

Env vars required:

  CRON_SECRET                       — Vercel Cron Bearer auth (shared).
  SLACK_CS_CALL_SUMMARIES_CHANNEL_ID — destination channel id (required
                                       in production; gate (d)).
  SLACK_BOT_TOKEN                   — shared.slack_post.
  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — shared.db.

Manual trigger:
  curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \\
       https://ai-enablement-sigma.vercel.app/api/cs_missed_recording_cron
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from shared.db import get_client  # noqa: E402
from shared.slack_post import post_message  # noqa: E402

logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.cs_missed_recording_cron")
logger.setLevel(logging.INFO)

# Audit-row source label. Searchable from SQL; do not change without
# updating audit dashboards / recovery queries.
_DELIVERY_SOURCE = "cs_missed_recording"

# Grace period: a recording is "missed" only once the meeting has been
# over for this long with nothing ingested. Matches the dashboard rule.
_GRACE = timedelta(minutes=30)

# Title/time match tolerance — same ±30min the /teams page + dashboard
# use when joining calendar_events to calls.
_MATCH_TOLERANCE = timedelta(minutes=30)

# Don't resurface events older than this (first-run / cron-paused guard).
_BACKSTOP = timedelta(days=7)

# Cap events handled per tick so a backlog drains over several ticks.
_MAX_PER_TICK = 100

_CHANNEL_ENV_VAR = "SLACK_CS_CALL_SUMMARIES_CHANNEL_ID"


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------


class handler(BaseHTTPRequestHandler):
    """Vercel's Python runtime instantiates this per request."""

    def do_POST(self) -> None:
        try:
            self._handle()
        except Exception as exc:
            logger.exception(
                "cs_missed_recording_cron: unhandled top-level error: %s", exc
            )
            self._respond(500, {"error": "internal_error"})

    def do_GET(self) -> None:
        self.do_POST()

    def _handle(self) -> None:
        if not _verify_auth(self.headers):
            self._respond(401, {"error": "unauthorized"})
            return
        result = run_cs_missed_recording_cron()
        status_code = 500 if result["status"] == "failed" else 200
        self._respond(status_code, result)

    def _respond(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)


# ---------------------------------------------------------------------------
# Main flow (testable independently of the HTTP wrapper)
# ---------------------------------------------------------------------------


def run_cs_missed_recording_cron() -> dict[str, Any]:
    """Run one tick. Returns a structured result dict. NEVER raises —
    per-item Slack failures land in audit rows but don't fail the
    cron."""
    cron_run_id = f"cs_missed_recording_{uuid.uuid4()}"
    now_utc = datetime.now(timezone.utc)
    db = get_client()

    channel_id = (os.environ.get(_CHANNEL_ENV_VAR) or "").strip()
    if not channel_id:
        error_message = f"{_CHANNEL_ENV_VAR} not set"
        logger.error("cs_missed_recording_cron: %s", error_message)
        _insert_delivery(
            db,
            f"{cron_run_id}_config",
            payload={"config_gap": _CHANNEL_ENV_VAR},
            status="failed",
            error=error_message,
        )
        return {"status": "failed", "cron_run_id": cron_run_id, "error": error_message}

    try:
        events = _fetch_candidate_events(db, now_utc)
    except Exception as exc:
        error_message = f"event_fetch_failed: {type(exc).__name__}: {exc}"
        logger.exception("cs_missed_recording_cron: %s", error_message)
        _insert_delivery(
            db,
            f"{cron_run_id}_fetch",
            payload={"stage": "event_fetch"},
            status="failed",
            error=error_message,
        )
        return {"status": "failed", "cron_run_id": cron_run_id, "error": error_message}

    if not events:
        logger.info("cs_missed_recording_cron: no candidate events this tick")
        return {
            "status": "ok",
            "cron_run_id": cron_run_id,
            "checked": 0,
            "matched": 0,
            "posted": 0,
        }

    calls = _fetch_candidate_calls(db, events)

    matched = 0
    posted = 0
    post_failures = 0

    for ev in events:
        if _has_matching_call(ev, calls):
            # Recording exists — leave unstamped; it ages out via the
            # backstop. Stamping would mislabel it as "alert posted".
            matched += 1
            continue

        title = (ev.get("title") or "").strip() or "(untitled meeting)"
        body = f"{title} - recording not available"

        slack_result = post_message(channel_id, body)
        if not slack_result["ok"]:
            post_failures += 1
            _insert_delivery(
                db,
                f"cs_missed_recording_{uuid.uuid4()}",
                payload={
                    "calendar_event_id": ev.get("id"),
                    "google_event_id": ev.get("google_event_id"),
                    "title": title,
                    "slack_error": slack_result.get("slack_error"),
                },
                status="failed",
                error=f"slack_post_failed: {slack_result.get('slack_error')}",
            )
            logger.warning(
                "cs_missed_recording_cron: post failed event=%s err=%s",
                ev.get("id"),
                slack_result.get("slack_error"),
            )
            continue

        _mark_posted(db, ev.get("id"), now_utc)
        _insert_delivery(
            db,
            f"cs_missed_recording_{uuid.uuid4()}",
            payload={
                "calendar_event_id": ev.get("id"),
                "google_event_id": ev.get("google_event_id"),
                "title": title,
                "channel_post_ts": slack_result.get("ts"),
            },
            status="processed",
        )
        posted += 1

    logger.info(
        "cs_missed_recording_cron: complete checked=%d matched=%d posted=%d failures=%d",
        len(events),
        matched,
        posted,
        post_failures,
    )
    return {
        "status": "ok",
        "cron_run_id": cron_run_id,
        "checked": len(events),
        "matched": matched,
        "posted": posted,
        "post_failures": post_failures,
    }


# ---------------------------------------------------------------------------
# Fetch + match
# ---------------------------------------------------------------------------


def _fetch_candidate_events(db, now_utc: datetime) -> list[dict[str, Any]]:
    """Events whose recording grace has elapsed, not yet posted, within
    the backstop window. Oldest-ended first, capped at _MAX_PER_TICK."""
    grace_cutoff = (now_utc - _GRACE).isoformat()
    backstop_after = (now_utc - _BACKSTOP).isoformat()
    resp = (
        db.table("calendar_events")
        .select("id, google_event_id, title, start_time, end_time")
        .is_("missing_recording_posted_at", "null")
        .lte("end_time", grace_cutoff)
        .gte("end_time", backstop_after)
        .order("end_time", desc=False)
        .limit(_MAX_PER_TICK)
        .execute()
    )
    return list(resp.data or [])


def _fetch_candidate_calls(db, events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """All client calls spanning the events' ±tolerance match windows,
    fetched in one query (min event start - tol → max event start + tol)."""
    starts = [
        _parse_dt(e.get("start_time")) for e in events if e.get("start_time")
    ]
    starts = [s for s in starts if s is not None]
    if not starts:
        return []
    lo = (min(starts) - _MATCH_TOLERANCE).isoformat()
    hi = (max(starts) + _MATCH_TOLERANCE).isoformat()
    resp = (
        db.table("calls")
        .select("title, started_at")
        .eq("call_category", "client")
        .gte("started_at", lo)
        .lte("started_at", hi)
        .execute()
    )
    return list(resp.data or [])


def _has_matching_call(ev: dict[str, Any], calls: list[dict[str, Any]]) -> bool:
    """True when a client call matches this event by normalized-title
    equality within ±_MATCH_TOLERANCE of the event start."""
    ev_title = _normalize_title(ev.get("title"))
    if not ev_title:
        # No title to match on — treat as missed (can't confirm a
        # recording). A titleless calendar event is an edge case.
        return False
    ev_start = _parse_dt(ev.get("start_time"))
    if ev_start is None:
        return False
    for call in calls:
        if _normalize_title(call.get("title")) != ev_title:
            continue
        call_start = _parse_dt(call.get("started_at"))
        if call_start is None:
            continue
        if abs((call_start - ev_start).total_seconds()) <= _MATCH_TOLERANCE.total_seconds():
            return True
    return False


def _normalize_title(t: str | None) -> str:
    return " ".join((t or "").strip().lower().split())


def _parse_dt(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# calendar_events dedup stamp
# ---------------------------------------------------------------------------


def _mark_posted(db, event_id: str | None, now_utc: datetime) -> None:
    if not event_id:
        return
    try:
        (
            db.table("calendar_events")
            .update({"missing_recording_posted_at": now_utc.isoformat()})
            .eq("id", event_id)
            .execute()
        )
    except Exception as exc:
        logger.warning(
            "cs_missed_recording_cron: mark-posted failed event=%s: %s",
            event_id,
            exc,
        )


# ---------------------------------------------------------------------------
# webhook_deliveries audit
# ---------------------------------------------------------------------------


def _insert_delivery(
    db, delivery_id: str, *, payload: Any, status: str, error: str | None = None
) -> None:
    try:
        row: dict[str, Any] = {
            "webhook_id": delivery_id,
            "source": _DELIVERY_SOURCE,
            "processing_status": status,
            "payload": payload,
            "headers": {},
        }
        if error is not None:
            row["processing_error"] = error[:2000]
        if status != "received":
            row["processed_at"] = datetime.now(timezone.utc).isoformat()
        db.table("webhook_deliveries").insert(row).execute()
    except Exception as exc:
        logger.warning(
            "cs_missed_recording_cron: audit insert failed id=%s: %s",
            delivery_id,
            exc,
        )


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def _verify_auth(headers: Any) -> bool:
    expected = os.environ.get("CRON_SECRET") or ""
    if not expected:
        logger.error("cs_missed_recording_cron: CRON_SECRET not configured")
        return False
    auth_header = headers.get("Authorization") or headers.get("authorization") or ""
    if not auth_header.startswith("Bearer "):
        return False
    presented = auth_header[len("Bearer ") :]
    return hmac.compare_digest(presented, expected)
