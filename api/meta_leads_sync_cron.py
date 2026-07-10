"""Meta leadgen sync cron — pull instant-form opt-ins into the mirrors.

Vercel Cron every 15 minutes. One tick runs the full leadgen pass
(ingestion/meta_ads/leads_pipeline.py): adset scan → meta_leadgen_campaigns,
forms → meta_lead_forms, submissions → meta_form_leads (trailing 72h window —
lead rows never restate, the overlap is just cheap safety), then
refresh_dc_ads_facts() so the DC ads funnel page is fresh.

⚠ Meta retains leads only ~90 days via the API. The mirror is the durable
copy — if this cron dies for a long stretch the backfill
(scripts/backfill_meta_leads.py) can only recover what Meta still has.

Per-tick behavior:
  1. Auth: validate `Authorization: Bearer ${CRON_SECRET}`.
  2. Build MetaAdsClient from META_ACCESS_TOKEN + META_AD_ACCOUNT_ID.
  3. sync_meta_leads for META_LEADGEN_PAGE_ID, since = now - 72h.
  4. Audit row to `webhook_deliveries` with source='meta_leads_sync'.

Env vars required (set in Vercel):
  CRON_SECRET            — shared Bearer auth across all crons
  META_ACCESS_TOKEN      — Meta Graph API user token (ads_read +
                           leads_retrieval + pages_show_list/pages_manage_ads)
  META_AD_ACCOUNT_ID     — ad account id (act_… or bare numeric)
  META_LEADGEN_PAGE_ID   — Facebook page id owning the lead forms
                           (The AI Partner = 627212320483048)
  META_API_VERSION       — optional, defaults to v23.0
  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — shared.db

Manual trigger:
  curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \\
       https://ai-enablement-sigma.vercel.app/api/meta_leads_sync_cron
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from shared.db import get_client  # noqa: E402
from ingestion.meta_ads.client import MetaAdsClient  # noqa: E402
from ingestion.meta_ads.leads_pipeline import sync_meta_leads  # noqa: E402

logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.meta_leads_sync_cron")
logger.setLevel(logging.INFO)

_AUDIT_SOURCE = "meta_leads_sync"

# Trailing window re-pulled each tick. Lead rows are immutable at Meta; the
# overlap only guards against a missed tick or two.
_LOOKBACK_SECONDS = 72 * 3600


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        try:
            self._handle()
        except Exception as exc:  # noqa: BLE001
            logger.exception("meta_leads_sync_cron: unhandled error: %s", exc)
            self._respond(500, {"error": "internal_error"})

    def do_GET(self) -> None:
        self.do_POST()

    def _handle(self) -> None:
        if not _verify_auth(self.headers):
            self._respond(401, {"error": "unauthorized"})
            return
        self._respond(200, run_meta_leads_sync_cron())

    def _respond(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)


def run_meta_leads_sync_cron() -> dict[str, Any]:
    """One cron tick. Returns the per-invocation summary."""
    token = os.environ.get("META_ACCESS_TOKEN")
    account_id = os.environ.get("META_AD_ACCOUNT_ID")
    page_id = os.environ.get("META_LEADGEN_PAGE_ID")
    api_version = os.environ.get("META_API_VERSION") or "v23.0"
    if not token or not account_id or not page_id:
        db = get_client()
        _insert_audit(
            db,
            status="failed",
            payload={"error": "meta_leadgen_creds_missing"},
            error="meta_leadgen_creds_missing",
        )
        return {"error": "meta_leadgen_creds_missing"}

    db = get_client()
    client = MetaAdsClient(token, account_id, api_version=api_version)
    since_unix = int(time.time()) - _LOOKBACK_SECONDS
    outcome = sync_meta_leads(db, client, page_id, account_id, since_unix=since_unix)

    payload: dict[str, Any] = {
        "since_unix": since_unix,
        "campaigns_upserted": outcome.campaigns_upserted,
        "forms_upserted": outcome.forms_upserted,
        "leads_upserted": outcome.leads_upserted,
        "facts_rows": outcome.facts_rows,
        "errors": outcome.errors,
    }
    _insert_audit(
        db,
        status="processed" if not outcome.errors else "partial",
        payload=payload,
        error="; ".join(outcome.errors)[:2000] if outcome.errors else None,
    )
    logger.info(
        "meta_leads_sync_cron: campaigns=%d forms=%d leads=%d facts=%s errors=%d",
        outcome.campaigns_upserted,
        outcome.forms_upserted,
        outcome.leads_upserted,
        outcome.facts_rows,
        len(outcome.errors),
    )
    return payload


def _insert_audit(
    db, *, status: str, payload: dict[str, Any], error: str | None
) -> None:
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
        logger.warning("meta_leads_sync_cron: audit insert failed: %s", exc)


def _verify_auth(headers: Any) -> bool:
    expected = os.environ.get("CRON_SECRET") or ""
    if not expected:
        logger.error("meta_leads_sync_cron: CRON_SECRET not configured")
        return False
    auth_header = headers.get("Authorization") or headers.get("authorization") or ""
    if not auth_header.startswith("Bearer "):
        return False
    return hmac.compare_digest(auth_header[len("Bearer ") :], expected)
