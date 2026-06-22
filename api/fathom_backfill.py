"""Fathom backfill cron — daily safety net for the live webhook.

Deployed by Vercel as a serverless Python function at `/api/fathom_backfill`.
Vercel Cron POSTs here on a schedule (08:00 UTC daily, configured in
`vercel.json`). The handler queries Fathom's `GET /meetings` for any calls
in the lookback window we don't have yet, then ingests them through the
same adapter + pipeline the live webhook uses.

Design rationale (`docs/fulfillment/fathom_webhook.md` §f):

- The webhook is the live path. The cron is the safety net for the rare
  case where a delivery fails to stick (Vercel cold-start timeout, brief
  cloud Supabase outage, Fathom-side retry exhaustion).
- Both paths converge on `pipeline.ingest_call`, so a backfill-ingested
  call is bit-for-bit equivalent to a webhook-ingested one.
- Idempotent on `(source='fathom', external_id=<recording_id>)`: meetings
  already in our `calls` table are counted as `already_present` and
  skipped. The first sweep after deploy will return many such rows
  (proving idempotency end-to-end with the F1.4 backlog).

Sync flow:

  1. Auth check — bearer token in `Authorization` header, compared
     constant-time against `CRON_SECRET`. Fail → 401.
  2. Determine lookback window:
       since = MAX(received_at) FROM webhook_deliveries
                WHERE source LIKE 'fathom%' - 6h
       Default to 14 days if the table is empty (first run).
       Cap at 30 days regardless (runaway-sweep guard).
  3. Page through Fathom's `GET /meetings?created_after=<since>&include_*=true`
     until `next_cursor` is null. Accumulate.
  4. For each meeting: check `calls` for an existing row; skip if present.
     Else: adapter → `ingest_call` → write a `webhook_deliveries` row
     (`source='fathom_cron'`, synthetic `webhook_id`).
  5. Per-meeting `try/except` so one bad meeting doesn't kill the sweep.
     Failures land as `processing_status='failed'` rows with sanitized
     traceback in `processing_error`.
  6. Cap per-sweep ingest count at `_MAX_INGESTS_PER_SWEEP` (50) to stay
     under Vercel's `maxDuration`. If we hit the cap, return
     `more_remaining=true`. Tomorrow's cron picks up where we stopped.

Env vars required (set in the Vercel project — NOT committed):
  CRON_SECRET                  — random secret. Vercel Cron sends it as
                                 `Authorization: Bearer <token>`. Shared
                                 across ALL cron endpoints in this project
                                 (Vercel only supports one CRON_SECRET per
                                 project). Single source of truth.
  FATHOM_API_KEY               — Fathom team-account API key with read
                                 access to /meetings. Drake generates and
                                 sets in M1.2.5. Distinct from the
                                 webhook secret (`FATHOM_WEBHOOK_SECRET`).
  SUPABASE_URL                 — shared.db.
  SUPABASE_SERVICE_ROLE_KEY    — shared.db.
  OPENAI_API_KEY               — shared.kb_query.embed for chunk embeddings.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler
from typing import Any

from ingestion.fathom.pipeline import ingest_call, load_resolvers
from ingestion.fathom.webhook_adapter import AdapterError, record_from_webhook
from shared.db import get_client
from shared.kb_query import embed


# Same Vercel-Python logger workaround as api/slack_events.py and
# api/fathom_events.py — root logger defaults to WARNING and silently
# drops INFO without this.
logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.fathom_backfill")
logger.setLevel(logging.INFO)


_FATHOM_BASE_URL = "https://api.fathom.ai/external/v1"
_DEFAULT_FIRST_RUN_DAYS = 14
_MAX_LOOKBACK_DAYS = 30
_OVERLAP_HOURS = 6
_MAX_INGESTS_PER_SWEEP = 50
_MAX_PAGES = 50  # safety cap on Fathom pagination loop
_API_TIMEOUT_SECONDS = 30
_MAX_ERROR_CHARS = 2000


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------


class handler(BaseHTTPRequestHandler):
    """Vercel's Python runtime instantiates this per request.

    Both POST (Vercel Cron's default) and GET (manual trigger or
    browser-friendly hint) are accepted. Both auth-gated.
    """

    def do_POST(self) -> None:
        try:
            self._handle()
        except Exception as exc:  # pragma: no cover — last-resort safety net
            logger.exception("fathom_backfill: unhandled top-level error: %s", exc)
            self._respond(500, {"error": "internal_error"})

    def do_GET(self) -> None:
        # Same auth + behavior as POST so a manual trigger via curl works
        # the same way Vercel Cron's POST does.
        self.do_POST()

    # ------------------------------------------------------------------
    # Main flow
    # ------------------------------------------------------------------

    def _handle(self) -> None:
        if not _verify_auth(self.headers):
            self._respond(401, {"error": "unauthorized"})
            return

        api_key = os.environ.get("FATHOM_API_KEY")
        if not api_key:
            logger.error("fathom_backfill: FATHOM_API_KEY not configured")
            self._respond(500, {"error": "misconfigured"})
            return

        db = get_client()
        sweep_started = datetime.now(timezone.utc)

        # Step 1: determine lookback window
        since = _determine_since(db, now=sweep_started)
        sweep_id = sweep_started.strftime("%Y%m%dT%H%M%SZ")

        logger.info(
            "fathom_backfill: sweep started since=%s now=%s sweep_id=%s",
            since.isoformat(), sweep_started.isoformat(), sweep_id,
        )

        # Step 2: page through Fathom's meetings API
        try:
            meetings = _fetch_meetings_window(api_key, since)
        except _RateLimited:
            logger.warning("fathom_backfill: hit Fathom rate limit; aborting sweep")
            self._respond(200, {
                "ok": True,
                "rate_limited": True,
                "sweep_window_start": since.isoformat(),
                "sweep_window_end": sweep_started.isoformat(),
            })
            return
        except _FathomAPIError as exc:
            logger.error("fathom_backfill: Fathom API error: %s", exc)
            self._respond(500, {"error": "fathom_api_failure", "detail": str(exc)})
            return

        # Step 3: per-meeting decide & ingest
        client_resolver, team_resolver, _ = load_resolvers(db)

        already_present = 0
        ingested = 0
        failed = 0
        more_remaining = False

        for meeting in meetings:
            recording_id = meeting.get("recording_id")
            if recording_id is None:
                logger.warning("fathom_backfill: meeting without recording_id, skipping: %s",
                               {k: meeting.get(k) for k in ("title", "url")})
                continue
            external_id = str(recording_id)

            if _call_already_in_db(db, external_id):
                already_present += 1
                continue

            if ingested >= _MAX_INGESTS_PER_SWEEP:
                more_remaining = True
                break

            cron_webhook_id = f"fathom_cron_{external_id}_{sweep_id}"

            try:
                record = record_from_webhook(meeting)
                outcome = ingest_call(
                    record, db,
                    client_resolver=client_resolver,
                    team_resolver=team_resolver,
                    embed_fn=embed,
                    file_size_bytes=None,
                    dry_run=False,
                )
                _write_cron_delivery(
                    db, cron_webhook_id, external_id,
                    payload=meeting, status="processed",
                )
                ingested += 1
                logger.info(
                    "fathom_backfill: ingested external_id=%s action=%s chunks=%d",
                    external_id, outcome.action, outcome.chunks_written,
                )
            except AdapterError as exc:
                logger.warning(
                    "fathom_backfill: adapter rejected meeting %s: %s",
                    external_id, exc,
                )
                _write_cron_delivery(
                    db, cron_webhook_id, external_id,
                    payload=meeting, status="malformed",
                    error=str(exc),
                )
                failed += 1
            except Exception as exc:
                tb = _sanitize_traceback(traceback.format_exc())
                logger.exception(
                    "fathom_backfill: ingest failed for external_id=%s: %s",
                    external_id, exc,
                )
                _write_cron_delivery(
                    db, cron_webhook_id, external_id,
                    payload=meeting, status="failed",
                    error=tb,
                )
                failed += 1

        summary = {
            "ok": True,
            "sweep_window_start": since.isoformat(),
            "sweep_window_end": sweep_started.isoformat(),
            "meetings_seen": len(meetings),
            "already_present": already_present,
            "ingested": ingested,
            "failed": failed,
            "more_remaining": more_remaining,
        }
        logger.info("fathom_backfill: sweep complete %s", summary)
        self._respond(200, summary)

    # ------------------------------------------------------------------
    # HTTP helpers
    # ------------------------------------------------------------------

    def _respond(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)


# ---------------------------------------------------------------------------
# Auth — Bearer token, constant-time compare
# ---------------------------------------------------------------------------


def _verify_auth(headers: Any) -> bool:
    """Bearer-token auth for the cron endpoint.

    Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Single source
    of truth — Vercel only supports one CRON_SECRET per project, so all
    cron endpoints in this codebase validate against the same env var.
    Consolidated to this pattern in M6.2 (was per-source-named tokens
    before; the per-source-naming-for-independent-rotation rationale was
    never deliverable since Vercel only supports one CRON_SECRET).
    """
    expected = os.environ.get("CRON_SECRET") or ""
    if not expected:
        logger.error("fathom_backfill: CRON_SECRET not configured")
        return False
    auth_header = headers.get("Authorization") or headers.get("authorization") or ""
    if not auth_header.startswith("Bearer "):
        return False
    presented = auth_header[len("Bearer "):]
    return hmac.compare_digest(presented, expected)


# ---------------------------------------------------------------------------
# Lookback window
# ---------------------------------------------------------------------------


def _determine_since(db, *, now: datetime) -> datetime:
    """Compute the `created_after` cutoff for this sweep.

    Reads MAX(received_at) from `webhook_deliveries` for any fathom-source
    rows. If the table is empty (first run), defaults to 14 days ago.
    Subtracts a 6-hour overlap so any delivery still in flight at the
    boundary doesn't fall through. Caps at 30 days regardless to prevent
    a runaway sweep if the cron has been broken for weeks.
    """
    resp = (
        db.table("webhook_deliveries")
        .select("received_at")
        .like("source", "fathom%")
        .order("received_at", desc=True)
        .limit(1)
        .execute()
    )
    rows = resp.data or []
    if rows and rows[0].get("received_at"):
        last_received = _parse_iso(rows[0]["received_at"])
        since = last_received - timedelta(hours=_OVERLAP_HOURS)
    else:
        since = now - timedelta(days=_DEFAULT_FIRST_RUN_DAYS)

    earliest_allowed = now - timedelta(days=_MAX_LOOKBACK_DAYS)
    if since < earliest_allowed:
        logger.warning(
            "fathom_backfill: lookback %s clamped to %s (max %d days)",
            since.isoformat(), earliest_allowed.isoformat(), _MAX_LOOKBACK_DAYS,
        )
        since = earliest_allowed
    return since


def _parse_iso(value: str) -> datetime:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


# ---------------------------------------------------------------------------
# Fathom GET /meetings — paginated fetch
# ---------------------------------------------------------------------------


class _RateLimited(Exception):
    """Fathom returned 429."""


class _FathomAPIError(Exception):
    """Non-success, non-429 response from Fathom."""


def _fetch_meetings_window(api_key: str, since: datetime) -> list[dict[str, Any]]:
    """Page through `GET /meetings` until `next_cursor` is null.

    Inline includes (`include_transcript`, `include_summary`,
    `include_action_items`) match what we register webhooks with. CRM
    matches off — same default as the webhook registration.
    """
    meetings: list[dict[str, Any]] = []
    cursor: str | None = None

    for page_num in range(_MAX_PAGES):
        params = {
            "created_after": since.isoformat(),
            "include_transcript": "true",
            "include_summary": "true",
            "include_action_items": "true",
            "include_crm_matches": "false",
        }
        if cursor:
            params["cursor"] = cursor
        url = f"{_FATHOM_BASE_URL}/meetings?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(
            url,
            method="GET",
            headers={
                # Fathom's external API uses X-Api-Key, NOT Authorization:
                # Bearer. F2.1 doc read missed this; M1.2.5 deploy caught
                # it via real-curl probe. Verified 2026-04-27 against
                # GET /external/v1/meetings: X-Api-Key returns 200, Bearer
                # returns 401.
                "X-Api-Key": api_key,
                "Accept": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=_API_TIMEOUT_SECONDS) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code == 429:
                raise _RateLimited() from exc
            raise _FathomAPIError(f"HTTP {exc.code}: {exc.reason}") from exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise _FathomAPIError(str(exc)) from exc

        items = body.get("items") or []
        meetings.extend(items)
        cursor = body.get("next_cursor")
        logger.info(
            "fathom_backfill: page %d returned %d items, next_cursor=%s",
            page_num, len(items), bool(cursor),
        )
        if not cursor:
            return meetings

    logger.warning(
        "fathom_backfill: hit max page cap (%d) — likely missing data; "
        "increase _MAX_PAGES or run again",
        _MAX_PAGES,
    )
    return meetings


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------


def _call_already_in_db(db, external_id: str) -> bool:
    """True if a `calls` row exists for (source='fathom', external_id)."""
    resp = (
        db.table("calls")
        .select("id")
        .eq("source", "fathom")
        .eq("external_id", external_id)
        .limit(1)
        .execute()
    )
    return bool(resp.data)


def _write_cron_delivery(
    db,
    webhook_id: str,
    call_external_id: str,
    *,
    payload: dict[str, Any],
    status: str,
    error: str | None = None,
) -> None:
    """Insert a synthetic `webhook_deliveries` row for a cron-driven ingest.

    Webhook_id is unique by construction (`fathom_cron_<external_id>_<sweep_ts>`)
    so a plain INSERT won't conflict; using upsert with ignore_duplicates as
    a safety net for the once-in-a-blue-moon case where two cron sweeps run
    concurrently and pick the same sweep_ts.
    """
    now_iso = datetime.now(timezone.utc).isoformat()
    db.table("webhook_deliveries").upsert(
        {
            "webhook_id": webhook_id,
            "source": "fathom_cron",
            "received_at": now_iso,
            "processed_at": now_iso,
            "processing_status": status,
            "processing_error": (error or "")[:_MAX_ERROR_CHARS] if error else None,
            "call_external_id": call_external_id,
            "payload": payload,
        },
        on_conflict="webhook_id",
        ignore_duplicates=True,
    ).execute()


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------


def _sanitize_traceback(tb: str) -> str:
    """Same shape as `api/fathom_events.py:_sanitize_traceback` — strip
    lines containing the three secret prefixes we know about."""
    if not tb:
        return ""
    lines = [
        line for line in tb.splitlines()
        if "whsec_" not in line and "sk-" not in line and "eyJh" not in line
    ]
    return "\n".join(lines)[:_MAX_ERROR_CHARS]
