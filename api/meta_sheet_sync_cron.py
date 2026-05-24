"""Meta ad-spend sync cron — pull the Cortana Google Sheet into `meta_ad_daily`.

Vercel Cron tick every 3 hours: fetches the entire first tab of the
Sheet (the Sheet IS the history — one pull loads everything currently
there) and idempotently upserts each day's row. Cortana restates the
current day with corrected numbers across the day; the 3-hour cadence
picks those restatements up while staying cheap.

Per-tick behavior:
  1. Auth: validate `Authorization: Bearer ${CRON_SECRET}`.
  2. Resolve Drake's team_member_id (creator-tier).
  3. Mint a valid access token via `shared.google_oauth.get_valid_access_token`.
     The token now carries calendar.readonly + spreadsheets.readonly
     (Drake re-consented 2026-05-24 — see commit e54a602 SCOPE widening +
     docs/reports/meta-sheet-ingestion.md).
  4. Run `ingestion.meta.pipeline.sync_meta_ad_daily(db, token)`. Fail-soft
     per row.
  5. Write a summary audit row to `webhook_deliveries` with
     `source='meta_sheet_sync'`.

Spec: docs/specs/meta-sheet-ingestion.md.
Runbook: docs/runbooks/meta_sheet_ingestion.md.

Env vars required (set in Vercel):
  CRON_SECRET                         — shared Bearer auth across all crons
  GOOGLE_OAUTH_CLIENT_ID              — for token refresh inside shared.google_oauth
  GOOGLE_OAUTH_CLIENT_SECRET          — same
  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — shared.db

Manual trigger:
  curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \\
       https://ai-enablement-sigma.vercel.app/api/meta_sheet_sync_cron
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import sys
import uuid
from datetime import datetime, timezone
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
from ingestion.meta.pipeline import sync_meta_ad_daily  # noqa: E402

logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.meta_sheet_sync_cron")
logger.setLevel(logging.INFO)

# Drake is the creator-tier OAuth holder. Same hardcoded identity the
# calendar cron uses for the same reason (one creator in V1; not
# changing without a code edit).
_DRAKE_EMAIL = "drake@theaipartner.io"

_AUDIT_SOURCE = "meta_sheet_sync"


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        try:
            self._handle()
        except Exception as exc:
            logger.exception(
                "meta_sheet_sync_cron: unhandled top-level error: %s", exc
            )
            self._respond(500, {"error": "internal_error"})

    def do_GET(self) -> None:
        self.do_POST()

    def _handle(self) -> None:
        if not _verify_auth(self.headers):
            self._respond(401, {"error": "unauthorized"})
            return
        result = run_meta_sheet_sync_cron()
        self._respond(200, result)

    def _respond(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)


def run_meta_sheet_sync_cron() -> dict[str, Any]:
    """Entry point for one cron tick. Returns the per-invocation summary."""
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
            "meta_sheet_sync_cron: oauth_token_unavailable — %s", exc,
        )
        return {"error": "oauth_token_unavailable", "detail": str(exc)}

    outcome = sync_meta_ad_daily(db, access_token)

    status = "processed" if not outcome.errors else "processed"
    audit_payload: dict[str, Any] = {
        "rows_parsed": outcome.rows_parsed,
        "rows_upserted": outcome.rows_upserted,
        "rows_failed": outcome.rows_failed,
        "days_covered_count": len(outcome.days_covered),
        "days_range": (
            [outcome.days_covered[0], outcome.days_covered[-1]]
            if outcome.days_covered
            else []
        ),
        "warnings": outcome.warnings,
        "errors": outcome.errors,
    }
    _insert_audit(
        db,
        status=status,
        payload=audit_payload,
        error="; ".join(outcome.errors)[:2000] if outcome.errors else None,
    )

    logger.info(
        "meta_sheet_sync_cron: parsed=%d upserted=%d failed=%d errors=%d",
        outcome.rows_parsed,
        outcome.rows_upserted,
        outcome.rows_failed,
        len(outcome.errors),
    )
    return audit_payload


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


def _insert_audit(
    db, *, status: str, payload: dict[str, Any], error: str | None,
) -> None:
    """Write one summary audit row per cron invocation. Same shape as
    `api/teams_calendar_sync_cron.py:_insert_audit`."""
    delivery_id = f"{_AUDIT_SOURCE}_{uuid.uuid4()}"
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
            "meta_sheet_sync_cron: audit insert failed: %s", exc,
        )


def _verify_auth(headers: Any) -> bool:
    expected = os.environ.get("CRON_SECRET") or ""
    if not expected:
        logger.error("meta_sheet_sync_cron: CRON_SECRET not configured")
        return False
    auth_header = (
        headers.get("Authorization") or headers.get("authorization") or ""
    )
    if not auth_header.startswith("Bearer "):
        return False
    presented = auth_header[len("Bearer ") :]
    return hmac.compare_digest(presented, expected)
