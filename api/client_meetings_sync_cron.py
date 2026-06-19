"""Client Meetings — daily Google Calendar sync.

Maintains the `client_meetings` table: the durable, per-client record of
meetings that drives the client page's "meetings this month" metric + the
month-by-month history (which feed CSM pay).

A meeting is attributed to a client when that client's email (or one of its
metadata.alternate_emails) appears as an attendee on a CSM's calendar event
that has at least one external attendee. Unknown externals (prospects who
aren't yet clients) are ignored — no auto-creation here.

Per-run behavior (daily, late EST):
  1. Auth: validate `Authorization: Bearer ${CRON_SECRET}`.
  2. Resolve Drake's team_member_id (creator-tier identity); mint a valid
     Google access token via shared.google_oauth. CSMs share their calendars
     with Drake at the Workspace level, so his token reads all of them.
  3. Build an email -> client_id map from non-archived clients (email +
     alternate_emails, lowercased/trimmed).
  4. For each CSM, fetch calendar events over a rolling 14-day lookback
     (now-14d .. now — past meetings only). For each event with an external
     attendee, upsert one client_meetings row per matched client.
  5. Reconcile deletions: any client_meetings row whose start_time falls in
     the 14-day window but which was NOT seen in this run's fetch is deleted
     (the Google event was removed or moved). Rows older than 14 days are
     never touched — frozen, final for pay.
  6. Write a summary audit row to webhook_deliveries.

This cron is intentionally self-contained (it duplicates a few helpers from
teams_calendar_sync_cron) because the /teams Meeting Tracker — and its
30-minute cron — is slated for removal; this job must keep working after that.

Env vars required:
  CRON_SECRET                              — shared Bearer auth across crons
  GOOGLE_OAUTH_CLIENT_ID / _SECRET         — token-refresh path in shared.google_oauth
  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — shared.db

Manual trigger:
  curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \\
       https://ai-enablement-sigma.vercel.app/api/client_meetings_sync_cron
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from shared.db import get_client  # noqa: E402
from shared.google_oauth import (  # noqa: E402
    GoogleOAuthError,
    get_valid_access_token,
)

logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.client_meetings_sync_cron")
logger.setLevel(logging.INFO)

_DRAKE_EMAIL = "drake@theaipartner.io"
_AIP_DOMAIN = "@theaipartner.io"
_CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3/calendars"
_CALENDAR_API_TIMEOUT_SECONDS = 15.0
_AUDIT_SOURCE = "client_meetings_sync"

# Rolling reconciliation / lock window. Meetings whose start_time is within
# this many days of "now" are kept in sync with Google (deletions removed,
# moves re-synced); anything older is frozen.
_LOOKBACK_DAYS = 14

# Launch floor: never look back before this instant. Tracking began
# 2026-06-01, so the rolling window is clamped here until enough time passes
# that now-14d is naturally past it (~mid-June). Keeps us from materializing a
# misleading partial pre-launch month bucket on the client page.
_LAUNCH_FLOOR = datetime(2026, 6, 1, tzinfo=timezone.utc)

# Booking-link exclusions — events that must never enter Gregory, dropped
# alongside cancelled events / OOO blocks. The "Digital College Implementation
# Call with Nico" is booked on Nico's calendar through a separate program's
# booking link (api.leadconnectorhq.com) and must NOT count as a client meeting
# (Scott, 2026-06-19). Matched two ways so neither a title edit nor a missing
# booking-link in the payload defeats the exclusion:
#   - exact event title (case-insensitive, trimmed), and
#   - the booking-link URL anywhere in the event payload (forward-insurance —
#     today's calendar events carry the title but not the URL).
_IGNORED_EVENT_TITLES = frozenset(
    {
        "digital college implementation call with nico",
    }
)
_IGNORED_EVENT_URLS = (
    "api.leadconnectorhq.com/widget/bookings/coaching-call-with-nico",
)


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        try:
            self._handle()
        except Exception as exc:
            logger.exception(
                "client_meetings_sync_cron: unhandled top-level error: %s", exc
            )
            self._respond(500, {"error": "internal_error"})

    def do_GET(self) -> None:
        self.do_POST()

    def _handle(self) -> None:
        if not _verify_auth(self.headers):
            self._respond(401, {"error": "unauthorized"})
            return
        result = run_client_meetings_sync_cron()
        self._respond(200, result)

    def _respond(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)


def run_client_meetings_sync_cron() -> dict[str, Any]:
    """Entry point for one cron run. Returns the per-invocation summary."""
    db = get_client()

    drake = _fetch_drake(db)
    if not drake:
        _insert_audit(
            db,
            status="failed",
            payload={"error": "drake_team_member_not_found"},
            error="drake_team_member_not_found",
        )
        return {"error": "drake_team_member_not_found"}

    try:
        access_token = get_valid_access_token(drake["id"])
    except GoogleOAuthError as exc:
        _insert_audit(
            db,
            status="failed",
            payload={"error": "oauth_token_unavailable", "detail": str(exc)},
            error=f"oauth_token_unavailable: {exc}",
        )
        logger.warning(
            "client_meetings_sync_cron: oauth_token_unavailable — %s", exc
        )
        return {"error": "oauth_token_unavailable", "detail": str(exc)}

    csms = _fetch_csms(db)
    personal_emails = _fetch_personal_emails(db)
    email_to_client = _build_client_email_map(db)

    now = datetime.now(timezone.utc)
    window_start = max(now - timedelta(days=_LOOKBACK_DAYS), _LAUNCH_FLOOR)
    time_min = window_start.isoformat()
    time_max = now.isoformat()

    counts = {
        "csms_attempted": 0,
        "csms_succeeded": 0,
        "meetings_upserted": 0,
        "meetings_deleted": 0,
        "clients_matched": 0,
    }
    errors: list[dict[str, Any]] = []
    # (client_id, google_event_id) pairs seen this run — drives reconciliation.
    seen: set[tuple[str, str]] = set()

    for csm in csms:
        counts["csms_attempted"] += 1
        try:
            events = _fetch_calendar_events(
                access_token=access_token,
                calendar_id=csm["email"],
                time_min=time_min,
                time_max=time_max,
            )
        except _CalendarApiError as exc:
            errors.append(
                {
                    "team_member_id": csm["id"],
                    "calendar_id": csm["email"],
                    "error_code": exc.code,
                    "error_status": exc.http_status,
                }
            )
            logger.warning(
                "client_meetings_sync_cron: calendar API failed csm=%s status=%s code=%s",
                csm["email"],
                exc.http_status,
                exc.code,
            )
            continue

        upserted = _upsert_client_meetings(
            db,
            team_member_id=csm["id"],
            calendar_id=csm["email"],
            events=events,
            personal_emails=personal_emails,
            email_to_client=email_to_client,
            seen=seen,
        )
        counts["meetings_upserted"] += upserted
        counts["csms_succeeded"] += 1

    counts["clients_matched"] = len({client_id for client_id, _ in seen})

    # Reconcile deletions only when every CSM fetch succeeded — a partial
    # fetch would make legitimate meetings look "unseen" and wrongly delete
    # them. With errors present we skip reconciliation this run; the next
    # clean run catches up.
    if not errors:
        counts["meetings_deleted"] = _reconcile_deletions(
            db, window_start_iso=time_min, seen=seen
        )
    else:
        logger.warning(
            "client_meetings_sync_cron: skipping reconciliation — %d CSM fetch error(s)",
            len(errors),
        )

    _insert_audit(
        db,
        status="processed",
        payload={
            "counts": counts,
            "errors": errors,
            "window": {"time_min": time_min, "time_max": time_max},
            "reconciled": not errors,
        },
        error=None,
    )

    logger.info(
        "client_meetings_sync_cron: csms=%d/%d upserted=%d deleted=%d clients=%d errors=%d",
        counts["csms_succeeded"],
        counts["csms_attempted"],
        counts["meetings_upserted"],
        counts["meetings_deleted"],
        counts["clients_matched"],
        len(errors),
    )
    return {**counts, "errors": errors}


# ---------------------------------------------------------------------------
# Client attribution
# ---------------------------------------------------------------------------


def _build_client_email_map(db) -> dict[str, str]:
    """email (lowercased/trimmed) -> client_id for every non-archived client.

    Includes the primary `email` column and every metadata.alternate_emails
    entry (same resolution the Fathom classifier uses). On a collision the
    primary email wins over an alternate; first-write-wins otherwise (rare —
    duplicate emails across active clients shouldn't exist given the partial-
    unique constraint, but alternates can theoretically overlap).
    """
    resp = (
        db.table("clients")
        .select("id,email,metadata")
        .is_("archived_at", "null")
        .execute()
    )
    out: dict[str, str] = {}
    alternates: dict[str, str] = {}
    for row in resp.data or []:
        client_id = row["id"]
        email = (row.get("email") or "").strip().lower()
        if email:
            out.setdefault(email, client_id)
        metadata = row.get("metadata") or {}
        if isinstance(metadata, dict):
            for alt in metadata.get("alternate_emails") or []:
                if isinstance(alt, str) and alt.strip():
                    alternates.setdefault(alt.strip().lower(), client_id)
    # Primary emails take precedence over alternates.
    for alt_email, client_id in alternates.items():
        out.setdefault(alt_email, client_id)
    return out


def _upsert_client_meetings(
    db,
    *,
    team_member_id: str,
    calendar_id: str,
    events: list[dict[str, Any]],
    personal_emails: set[str],
    email_to_client: dict[str, str],
    seen: set[tuple[str, str]],
) -> int:
    """For each event with an external attendee, upsert one client_meetings
    row per matched client. Returns the count of rows upserted."""
    upserted = 0
    for ev in events:
        if ev.get("status") == "cancelled":
            continue
        if _is_ignored_event(ev):
            continue
        start = (ev.get("start") or {}).get("dateTime")
        end = (ev.get("end") or {}).get("dateTime")
        if not start or not end:
            continue
        if not _has_external_attendee(ev, personal_emails):
            continue

        google_event_id = ev.get("id")
        if not google_event_id:
            continue

        # Which known clients are on this event? One row per matched client.
        matched: dict[str, str] = {}  # client_id -> the email that matched
        for attendee in ev.get("attendees") or []:
            if attendee.get("resource"):
                continue
            email = (attendee.get("email") or "").strip().lower()
            if not email:
                continue
            client_id = email_to_client.get(email)
            if client_id and client_id not in matched:
                matched[client_id] = email

        for client_id, attendee_email in matched.items():
            row = {
                "client_id": client_id,
                "team_member_id": team_member_id,
                "google_event_id": google_event_id,
                "calendar_id": calendar_id,
                "title": ev.get("summary"),
                "start_time": start,
                "end_time": end,
                "attendee_email": attendee_email,
                "synced_at": datetime.now(timezone.utc).isoformat(),
            }
            try:
                (
                    db.table("client_meetings")
                    .upsert(row, on_conflict="client_id,google_event_id")
                    .execute()
                )
                upserted += 1
                seen.add((client_id, google_event_id))
            except Exception as exc:
                logger.warning(
                    "client_meetings_sync_cron: upsert failed event=%s client=%s: %s",
                    google_event_id,
                    client_id,
                    exc,
                )
    return upserted


def _reconcile_deletions(
    db, *, window_start_iso: str, seen: set[tuple[str, str]]
) -> int:
    """Delete client_meetings rows inside the lookback window that were NOT
    seen in this run — i.e. their Google event was deleted or moved. Rows
    older than the window are left frozen. Returns the delete count."""
    resp = (
        db.table("client_meetings")
        .select("id,client_id,google_event_id")
        .gte("start_time", window_start_iso)
        .execute()
    )
    stale_ids = [
        r["id"]
        for r in (resp.data or [])
        if (r["client_id"], r["google_event_id"]) not in seen
    ]
    deleted = 0
    for i in range(0, len(stale_ids), 100):
        batch = stale_ids[i : i + 100]
        try:
            db.table("client_meetings").delete().in_("id", batch).execute()
            deleted += len(batch)
        except Exception as exc:
            logger.warning(
                "client_meetings_sync_cron: reconcile delete failed: %s", exc
            )
    return deleted


# ---------------------------------------------------------------------------
# DB / calendar helpers (self-contained — see module docstring)
# ---------------------------------------------------------------------------


def _fetch_drake(db) -> dict[str, Any] | None:
    resp = (
        db.table("team_members")
        .select("id,email")
        .eq("email", _DRAKE_EMAIL)
        .is_("archived_at", "null")
        .limit(1)
        .execute()
    )
    rows = resp.data or []
    return rows[0] if rows else None


def _fetch_csms(db) -> list[dict[str, Any]]:
    resp = (
        db.table("team_members")
        .select("id,email,full_name,metadata")
        .eq("is_csm", True)
        .is_("archived_at", "null")
        .execute()
    )
    rows = resp.data or []
    out = []
    for r in rows:
        metadata = r.get("metadata") or {}
        if isinstance(metadata, dict) and metadata.get("sentinel") is True:
            continue
        out.append(r)
    out.sort(key=lambda r: (r.get("full_name") or "").lower())
    return out


def _fetch_personal_emails(db) -> set[str]:
    resp = (
        db.table("team_members")
        .select("metadata")
        .is_("archived_at", "null")
        .execute()
    )
    out: set[str] = set()
    for row in resp.data or []:
        metadata = row.get("metadata") or {}
        personal = metadata.get("personal_emails") or []
        for email in personal:
            if isinstance(email, str) and email.strip():
                out.add(email.strip().lower())
    return out


def _is_ignored_event(event: dict[str, Any]) -> bool:
    """True for events excluded from Gregory entirely — booking links that
    must never count as client meetings (see _IGNORED_EVENT_TITLES). Matches
    on the exact event title OR the booking-link URL anywhere in the payload."""
    title = (event.get("summary") or "").strip().lower()
    if title in _IGNORED_EVENT_TITLES:
        return True
    blob = json.dumps(event).lower()
    return any(url in blob for url in _IGNORED_EVENT_URLS)


def _has_external_attendee(
    event: dict[str, Any], personal_emails: set[str]
) -> bool:
    """True when the event has at least one attendee outside both the AIP
    Workspace domain AND every team member's personal-email list. Drops OOO
    blocks, focus time, and internal-only meetings."""
    attendees = event.get("attendees") or []
    if not attendees:
        return False
    for attendee in attendees:
        if attendee.get("resource"):
            continue
        email = (attendee.get("email") or "").strip().lower()
        if not email:
            continue
        if email in personal_emails:
            continue
        if not email.endswith(_AIP_DOMAIN):
            return True
    return False


class _CalendarApiError(Exception):
    def __init__(self, code: str, http_status: int | None = None):
        super().__init__(code)
        self.code = code
        self.http_status = http_status


def _fetch_calendar_events(
    *,
    access_token: str,
    calendar_id: str,
    time_min: str,
    time_max: str,
) -> list[dict[str, Any]]:
    params = urllib.parse.urlencode(
        {
            "timeMin": time_min,
            "timeMax": time_max,
            "singleEvents": "true",
            "orderBy": "startTime",
            "maxResults": "250",
        }
    )
    url = (
        f"{_CALENDAR_API_BASE}/"
        f"{urllib.parse.quote(calendar_id, safe='')}/events?{params}"
    )
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {access_token}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(
            req, timeout=_CALENDAR_API_TIMEOUT_SECONDS
        ) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        code = (
            "calendar_api_denied"
            if exc.code in (401, 403)
            else "calendar_api_http_error"
        )
        raise _CalendarApiError(code, http_status=exc.code) from exc
    except Exception as exc:
        raise _CalendarApiError(
            f"calendar_api_transport_error: {type(exc).__name__}",
            http_status=None,
        ) from exc

    parsed = json.loads(body)
    return list(parsed.get("items") or [])


# ---------------------------------------------------------------------------
# Audit ledger
# ---------------------------------------------------------------------------


def _insert_audit(
    db, *, status: str, payload: dict[str, Any], error: str | None
) -> None:
    delivery_id = f"client_meetings_sync_{uuid.uuid4()}"
    row: dict[str, Any] = {
        "webhook_id": delivery_id,
        "source": _AUDIT_SOURCE,
        "processing_status": status,
        "payload": payload,
        "headers": {},
        "processed_at": datetime.now(timezone.utc).isoformat(),
    }
    if error is not None:
        row["processing_error"] = error[:2000]
    try:
        db.table("webhook_deliveries").insert(row).execute()
    except Exception as exc:
        logger.warning(
            "client_meetings_sync_cron: audit insert failed: %s", exc
        )


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def _verify_auth(headers: Any) -> bool:
    expected = os.environ.get("CRON_SECRET") or ""
    if not expected:
        logger.error("client_meetings_sync_cron: CRON_SECRET not configured")
        return False
    auth_header = (
        headers.get("Authorization") or headers.get("authorization") or ""
    )
    if not auth_header.startswith("Bearer "):
        return False
    presented = auth_header[len("Bearer ") :]
    return hmac.compare_digest(presented, expected)
