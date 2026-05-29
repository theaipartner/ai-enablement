"""Cortana attribution sync cron — pull Meta ad data into the mirrors.

Vercel Cron every 3 hours. Re-pulls a trailing 4-ET-day window across
three groupings and idempotently upserts into meta_ad_daily,
cortana_campaign_daily, cortana_ad_daily. The trailing window absorbs
Meta's ~72h spend/conversion restatements (last-write-wins on the
upsert keys).

Replaces api/meta_sheet_sync_cron.py (the Google-Sheet path). The Sheet
code stays in the repo for instant revert, but is no longer scheduled.

Per-tick behavior:
  1. Auth: validate `Authorization: Bearer ${CRON_SECRET}`.
  2. Build CortanaClient from CORTANA_API_KEY + CORTANA_BUSINESS_ID.
  3. sync_cortana_range over [today-3, today] (ET).
  4. Audit row to `webhook_deliveries` with source='cortana_sync'.

Env vars required (set in Vercel):
  CRON_SECRET            — shared Bearer auth across all crons
  CORTANA_API_KEY        — sk-ak-... Attribution API key
  CORTANA_BUSINESS_ID    — business uuid
  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — shared.db

Manual trigger:
  curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \\
       https://ai-enablement-sigma.vercel.app/api/cortana_sync_cron

Runbook: docs/runbooks/cortana_ingestion.md.
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
from zoneinfo import ZoneInfo

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from shared.db import get_client  # noqa: E402
from ingestion.cortana.client import CortanaClient  # noqa: E402
from ingestion.cortana.pipeline import sync_cortana_range  # noqa: E402

logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.cortana_sync_cron")
logger.setLevel(logging.INFO)

_ET = ZoneInfo("America/New_York")
_AUDIT_SOURCE = "cortana_sync"

# Trailing window (ET days incl today) re-pulled each tick to catch
# Meta's delayed restatements. 4 days = today + 3 prior.
_TRAILING_DAYS = 4


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        try:
            self._handle()
        except Exception as exc:  # noqa: BLE001
            logger.exception("cortana_sync_cron: unhandled error: %s", exc)
            self._respond(500, {"error": "internal_error"})

    def do_GET(self) -> None:
        self.do_POST()

    def _handle(self) -> None:
        if not _verify_auth(self.headers):
            self._respond(401, {"error": "unauthorized"})
            return
        self._respond(200, run_cortana_sync_cron())

    def _respond(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)


def run_cortana_sync_cron() -> dict[str, Any]:
    """One cron tick. Returns the per-invocation summary."""
    api_key = os.environ.get("CORTANA_API_KEY")
    business_id = os.environ.get("CORTANA_BUSINESS_ID")
    if not api_key or not business_id:
        db = get_client()
        _insert_audit(db, status="failed", payload={"error": "cortana_creds_missing"}, error="cortana_creds_missing")
        return {"error": "cortana_creds_missing"}

    db = get_client()
    client = CortanaClient(api_key, business_id)

    end_day = datetime.now(_ET).date()
    start_day = end_day - timedelta(days=_TRAILING_DAYS - 1)
    outcome = sync_cortana_range(db, client, start_day, end_day)

    payload: dict[str, Any] = {
        "window": [start_day.isoformat(), end_day.isoformat()],
        "days_covered": len(outcome.days_covered),
        "meta_ad_daily_upserts": outcome.meta_ad_daily_upserts,
        "campaign_upserts": outcome.campaign_upserts,
        "ad_upserts": outcome.ad_upserts,
        "errors": outcome.errors,
    }
    _insert_audit(
        db,
        status="processed",
        payload=payload,
        error="; ".join(outcome.errors)[:2000] if outcome.errors else None,
    )
    logger.info(
        "cortana_sync_cron: days=%d meta=%d campaign=%d ad=%d errors=%d",
        len(outcome.days_covered),
        outcome.meta_ad_daily_upserts,
        outcome.campaign_upserts,
        outcome.ad_upserts,
        len(outcome.errors),
    )
    return payload


def _insert_audit(db, *, status: str, payload: dict[str, Any], error: str | None) -> None:
    row: dict[str, Any] = {
        "webhook_id": f"{_AUDIT_SOURCE}_{uuid.uuid4()}",
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
    except Exception as exc:  # noqa: BLE001
        logger.warning("cortana_sync_cron: audit insert failed: %s", exc)


def _verify_auth(headers: Any) -> bool:
    expected = os.environ.get("CRON_SECRET") or ""
    if not expected:
        logger.error("cortana_sync_cron: CRON_SECRET not configured")
        return False
    auth_header = headers.get("Authorization") or headers.get("authorization") or ""
    if not auth_header.startswith("Bearer "):
        return False
    return hmac.compare_digest(auth_header[len("Bearer ") :], expected)
