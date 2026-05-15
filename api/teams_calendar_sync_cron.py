"""Teams Meeting Tracker — per-30-minute Calendar sync.

Pulls the current week's calendar events for every CSM
(`team_members WHERE is_csm=true`) using Drake's stored Google OAuth
token (the four CSMs share their calendars with Drake at the Workspace
level — confirmed 2026-05-14 per spec). Upserts each event into
`calendar_events` keyed by (team_member_id, google_event_id) so the
`/teams` page reads from a fresh local cache rather than calling
Google at render time.

Per-tick behavior:
  1. Auth: validate `Authorization: Bearer ${CRON_SECRET}`.
  2. Resolve Drake's team_member_id (creator-tier identity).
  3. Mint a valid access token via `shared.google_oauth.get_valid_access_token`.
     If refresh fails: write an audit row + return; no calendar sync this tick.
  4. Look up every CSM (`is_csm=true`, not archived).
  5. For each CSM: fetch this week's calendar events from Google,
     upsert into `calendar_events`. A failure on one CSM (4xx auth,
     network blip, parse error) doesn't crash the whole sync — that
     CSM gets a `calendar_api_denied` (or similar) audit row and the
     loop continues.
  6. Write a summary audit row with totals.

Spec: docs/specs/teams-meeting-tracker.md.

Env vars required:
  CRON_SECRET                         — shared Bearer auth across all crons
  GOOGLE_OAUTH_CLIENT_ID              — for the token-refresh path inside shared.google_oauth
  GOOGLE_OAUTH_CLIENT_SECRET          — same
  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — shared.db

Manual trigger:
  curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \\
       https://ai-enablement-sigma.vercel.app/api/teams_calendar_sync_cron
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
from zoneinfo import ZoneInfo

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from shared.db import get_client  # noqa: E402
from shared.google_oauth import (  # noqa: E402
    GoogleOAuthError,
    get_valid_access_token,
)

logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.teams_calendar_sync_cron")
logger.setLevel(logging.INFO)

# Drake is identified by email (canonical per migration 0032's backfill
# of access_tier='creator'). Hardcoded here to avoid the cron having to
# join through access_tier on every tick — there's exactly one creator
# in V1 and that's not changing without a code edit.
_DRAKE_EMAIL = "drake@theaipartner.io"

# AIP Workspace email domain. Events get filtered at fetch time —
# kept only if at least one attendee has an email outside this domain.
# Drops OOO blocks, work blocks, internal-only meetings, solo focus
# time. See docs/specs/teams-calendar-external-attendee-filter.md.
_AIP_DOMAIN = "@theaipartner.io"

# Calendar API endpoint shape:
#   https://www.googleapis.com/calendar/v3/calendars/<urlencoded calendarId>/events?...
_CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3/calendars"
_CALENDAR_API_TIMEOUT_SECONDS = 15.0

# Audit-ledger source label for the calendar sync. Mirrors the pattern
# from other crons (cs_call_summary_slack_post, ella_passive_escalation_dm).
_AUDIT_SOURCE = "teams_calendar_sync"

# Time zone for week-boundary calculation. America/New_York handles DST
# correctly across spring/fall transitions (UTC-5 in winter, UTC-4 in
# summer). Fixed UTC offsets would silently misframe the week twice a
# year.
_DISPLAY_TZ = ZoneInfo("America/New_York")


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        try:
            self._handle()
        except Exception as exc:
            logger.exception(
                "teams_calendar_sync_cron: unhandled top-level error: %s", exc
            )
            self._respond(500, {"error": "internal_error"})

    def do_GET(self) -> None:
        self.do_POST()

    def _handle(self) -> None:
        if not _verify_auth(self.headers):
            self._respond(401, {"error": "unauthorized"})
            return
        result = run_teams_calendar_sync_cron()
        self._respond(200, result)

    def _respond(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)


def run_teams_calendar_sync_cron() -> dict[str, Any]:
    """Entry point for one cron tick. Returns the per-invocation summary
    that the HTTP layer serializes back to Vercel."""
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
            "teams_calendar_sync_cron: oauth_token_unavailable — %s",
            exc,
        )
        return {"error": "oauth_token_unavailable", "detail": str(exc)}

    csms = _fetch_csms(db)
    time_min, time_max = _current_week_window()

    counts = {
        "csms_attempted": 0,
        "csms_succeeded": 0,
        "events_upserted": 0,
    }
    errors: list[dict[str, Any]] = []

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
                "teams_calendar_sync_cron: calendar API failed csm=%s status=%s code=%s",
                csm["email"],
                exc.http_status,
                exc.code,
            )
            continue

        upserted = _upsert_events(
            db,
            team_member_id=csm["id"],
            calendar_id=csm["email"],
            events=events,
        )
        counts["events_upserted"] += upserted
        counts["csms_succeeded"] += 1

    _insert_audit(
        db,
        status="processed" if not errors else "processed",
        payload={
            "counts": counts,
            "errors": errors,
            "week_window": {"time_min": time_min, "time_max": time_max},
        },
        error=None,
    )

    logger.info(
        "teams_calendar_sync_cron: csms_attempted=%d succeeded=%d "
        "events_upserted=%d errors=%d",
        counts["csms_attempted"],
        counts["csms_succeeded"],
        counts["events_upserted"],
        len(errors),
    )
    return {**counts, "errors": errors}


# ---------------------------------------------------------------------------
# DB helpers
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
    """Pull every `team_members` row eligible for calendar sync.
    Filters: is_csm=true AND not archived AND not a sentinel.
    Returns ordered by full_name for deterministic per-tick logging.
    """
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


def _upsert_events(
    db, *, team_member_id: str, calendar_id: str, events: list[dict[str, Any]]
) -> int:
    """Upsert each Google Calendar event into calendar_events keyed by
    (team_member_id, google_event_id). Returns the count of events
    upserted.

    Google's events.list returns cancelled events as `status=cancelled`
    with no usable start/end time — skipped here. Events without a
    start.dateTime (all-day events without time) are also skipped:
    the matching logic against `calls.started_at` only works with
    point-in-time events.
    """
    upserted = 0
    for ev in events:
        if ev.get("status") == "cancelled":
            continue
        start = (ev.get("start") or {}).get("dateTime")
        end = (ev.get("end") or {}).get("dateTime")
        if not start or not end:
            continue
        if not _has_external_attendee(ev):
            # Filter: keep only events with at least one external
            # attendee (someone outside the AIP Workspace domain).
            # Drops OOO blocks, work blocks, solo focus time, and
            # internal-only meetings — none of which belong on /teams.
            continue
        row = {
            "team_member_id": team_member_id,
            "google_event_id": ev["id"],
            "calendar_id": calendar_id,
            "title": ev.get("summary"),
            "start_time": start,
            "end_time": end,
            "attendees": _extract_attendees(ev.get("attendees") or []),
            "meeting_link": _extract_meeting_link(ev),
            "raw_payload": ev,
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        }
        try:
            (
                db.table("calendar_events")
                .upsert(row, on_conflict="team_member_id,google_event_id")
                .execute()
            )
            upserted += 1
        except Exception as exc:
            logger.warning(
                "teams_calendar_sync_cron: upsert failed event=%s csm=%s: %s",
                ev.get("id"),
                team_member_id,
                exc,
            )
    return upserted


def _has_external_attendee(event: dict[str, Any]) -> bool:
    """Return True if the event has at least one attendee outside the
    AIP Workspace domain.

    Filter rule used by `_upsert_events` to keep client-facing meetings
    and drop internal-only events (OOO blocks, work blocks, internal
    1:1s). Empty attendee lists return False — solo blocks have no
    external attendee by definition.

    Case-insensitive on the domain check (Google sometimes returns
    canonicalized lowercase; user-typed entries may have mixed case).
    Attendees without an `email` field (rare but legal in the API)
    are skipped, not treated as external.

    Resource calendars (conference rooms, equipment) get filtered out
    earlier by `_extract_attendees`, but THIS helper runs on the raw
    Google event so we also have to skip them here. Resources never
    qualify as external attendees.
    """
    attendees = event.get("attendees") or []
    if not attendees:
        return False
    for attendee in attendees:
        if attendee.get("resource"):
            continue
        email = (attendee.get("email") or "").strip().lower()
        if not email:
            continue
        if not email.endswith(_AIP_DOMAIN):
            return True
    return False


def _extract_attendees(raw: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Pull (email, displayName) pairs out of Google's attendee shape.
    Drops resource accounts (Calendar API marks these with
    `resource: true`) since they pollute the human-attendees view."""
    out = []
    for a in raw:
        if a.get("resource"):
            continue
        email = a.get("email")
        if not email:
            continue
        out.append({"email": email, "displayName": a.get("displayName") or ""})
    return out


def _extract_meeting_link(ev: dict[str, Any]) -> str | None:
    """Google Meet links live under `hangoutLink` OR
    `conferenceData.entryPoints[type=video].uri`. Prefer hangoutLink
    when present (more reliable across Workspace tenants)."""
    if ev.get("hangoutLink"):
        return ev["hangoutLink"]
    conf = ev.get("conferenceData") or {}
    for entry in conf.get("entryPoints", []):
        if entry.get("entryPointType") == "video":
            return entry.get("uri")
    return None


# ---------------------------------------------------------------------------
# Calendar API
# ---------------------------------------------------------------------------


class _CalendarApiError(Exception):
    """Raised by `_fetch_calendar_events` on any Google-side or transport
    failure. Captures both the HTTP status (for auth-denial detection)
    and a short error code for the audit row."""

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
    """Single page of events.list. The cron's week window is small
    enough (~hundreds of events at the tail) that pagination is unlikely
    to matter at V1 scale; we cap at maxResults=250 which is Google's
    server-side max. Future: page through `nextPageToken` if a CSM ever
    exceeds the cap."""
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
        # 401/403 are the auth-denial signals: the CSM either unshared
        # or our token doesn't have the right scope. Surface as
        # calendar_api_denied so the audit + UI banner can distinguish.
        code = "calendar_api_denied" if exc.code in (401, 403) else "calendar_api_http_error"
        raise _CalendarApiError(code, http_status=exc.code) from exc
    except Exception as exc:
        raise _CalendarApiError(
            f"calendar_api_transport_error: {type(exc).__name__}",
            http_status=None,
        ) from exc

    parsed = json.loads(body)
    return list(parsed.get("items") or [])


def _current_week_window() -> tuple[str, str]:
    """Return (time_min, time_max) RFC3339 timestamps bracketing the
    current Mon-Sun week in America/New_York. Both are UTC-encoded
    (Google's API accepts any zone-aware RFC3339).

    Adds a one-day buffer on the end so events spilling into Monday
    morning of next week (rare but possible for late-Sunday-night
    bookings entered on Sunday) still surface.
    """
    now_local = datetime.now(_DISPLAY_TZ)
    # Monday is 0; Sunday is 6.
    monday_local = (now_local - timedelta(days=now_local.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    next_monday_local = monday_local + timedelta(days=7)
    return (
        monday_local.astimezone(timezone.utc).isoformat(),
        next_monday_local.astimezone(timezone.utc).isoformat(),
    )


# ---------------------------------------------------------------------------
# Audit ledger
# ---------------------------------------------------------------------------


def _insert_audit(
    db, *, status: str, payload: dict[str, Any], error: str | None
) -> None:
    """Write one summary audit row per cron invocation. Pattern matches
    other crons: source label pinned, payload carries the structured
    counts + errors block."""
    delivery_id = f"teams_calendar_sync_{uuid.uuid4()}"
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
            "teams_calendar_sync_cron: audit insert failed: %s", exc
        )


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def _verify_auth(headers: Any) -> bool:
    expected = os.environ.get("CRON_SECRET") or ""
    if not expected:
        logger.error("teams_calendar_sync_cron: CRON_SECRET not configured")
        return False
    auth_header = (
        headers.get("Authorization") or headers.get("authorization") or ""
    )
    if not auth_header.startswith("Bearer "):
        return False
    presented = auth_header[len("Bearer ") :]
    return hmac.compare_digest(presented, expected)
