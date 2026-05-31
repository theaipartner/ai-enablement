"""Airtable sync cron — reconciliation for missed webhook CREATIONS only.

Vercel Cron at `*/15 * * * *` (every 15 min — matches Typeform cadence
since Airtable webhook activation is gate-d-blocked at ship and the
cron is the primary creation-detection path until the webhook lights
up).

**The cron does NOT catch edits.** Per `0050_airtable_mirror.sql`'s
structural note: neither target Airtable table has a stored timestamp
field, so we can only filter on `CREATED_TIME()` — created-only. The
live webhook is the only edit-detection path.

Per-tick behavior:

  1. Validate `Authorization: Bearer ${CRON_SECRET}`.
  2. Build AirtableClient from env (`AIRTABLE_SALES_PAT`).
  3. For each of the 3 target sources (Setter Triage + Full Closer
     US + AUS), call `pipeline.sync_table(table_id, since=<6h ago>)`.
     6h window vs 15-min cadence → 24× overlap, plenty of room to
     absorb a webhook-disable + recovery cycle.
  4. Optionally refresh the webhook subscription if `AIRTABLE_WEBHOOK_ID`
     is set in env. Refreshes reset Airtable's 7-day idle expiry —
     cheap insurance against silent webhook death. Fail-soft (a refresh
     failure shouldn't halt the cron's read path).
  5. Write summary audit row to `webhook_deliveries`
     (source='airtable_sync_cron').

Spec: docs/specs/airtable-ingestion.md.
Runbook: docs/runbooks/airtable_ingestion.md.

Env vars (set in Vercel):
  CRON_SECRET                       — shared Bearer auth across all crons
  AIRTABLE_SALES_PAT                — PAT with data.records:read (and
                                       webhook:manage if AIRTABLE_WEBHOOK_ID
                                       is set, for the refresh)
  AIRTABLE_WEBHOOK_ID               — optional; webhook id to refresh
                                       each tick. If unset, refresh is
                                       skipped (the webhook may not be
                                       registered yet — gate (d) order
                                       of operations).
  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — shared.db

Manual trigger:
  curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \\
       https://ai-enablement-sigma.vercel.app/api/airtable_sync_cron
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

from ingestion.airtable import AUDIT_SOURCE_CRON  # noqa: E402
from ingestion.airtable.client import AirtableAPIError, AirtableClient  # noqa: E402
from ingestion.airtable.pipeline import sync_all  # noqa: E402
from shared.db import get_client  # noqa: E402

logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.airtable_sync_cron")
logger.setLevel(logging.INFO)


# 6 hours of overlap on a 15-min cadence = ~24 chances per record to
# land via the cron if the webhook is down. Tunable; matches Typeform.
_SINCE_WINDOW = timedelta(hours=6)


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        try:
            self._handle()
        except Exception as exc:
            logger.exception(
                "airtable_sync_cron: unhandled top-level error: %s", exc,
            )
            self._respond(500, {"error": "internal_error"})

    def do_GET(self) -> None:
        self.do_POST()

    def _handle(self) -> None:
        if not _verify_auth(self.headers):
            self._respond(401, {"error": "unauthorized"})
            return
        result = run_airtable_sync_cron()
        self._respond(200, result)

    def _respond(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)


def run_airtable_sync_cron() -> dict[str, Any]:
    """One cron tick. Returns the audit-payload dict."""
    db = get_client()

    try:
        client = AirtableClient.from_env()
    except RuntimeError as exc:
        _insert_audit(
            db,
            status="failed",
            payload={"error": "airtable_pat_unavailable", "detail": str(exc)},
            error=f"airtable_pat_unavailable: {exc}",
        )
        logger.warning("airtable_sync_cron: %s", exc)
        return {"error": "airtable_pat_unavailable", "detail": str(exc)}

    since_dt = datetime.now(timezone.utc) - _SINCE_WINDOW
    # Airtable's DATETIME_PARSE accepts ISO 8601 with millis + Z.
    since_iso = since_dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    outcome = sync_all(client, db, since=since_iso)

    # Maintain close_leads.reactivated_at from the forms just synced
    # (set-once; tag_reactivated_leads() only ever tags newly-eligible
    # leads — see migration 0064). Fail-soft: a tagging error must not
    # halt the cron's read path or its audit write.
    reactivation_tagged: int | None = None
    try:
        rpc_resp = db.rpc("tag_reactivated_leads").execute()
        reactivation_tagged = (
            rpc_resp.data if isinstance(rpc_resp.data, int) else None
        )
    except Exception as exc:  # noqa: BLE001 — fail-soft by design
        logger.warning(
            "airtable_sync_cron: reactivation tagging failed: %s", exc,
        )

    # Webhook refresh — cheap insurance. Only fires if AIRTABLE_WEBHOOK_ID
    # is set (post-gate-d). Failure here is non-fatal; the read path
    # already ran.
    refresh_result: dict[str, Any] = {"attempted": False}
    webhook_id = os.environ.get("AIRTABLE_WEBHOOK_ID")
    if webhook_id:
        refresh_result["attempted"] = True
        try:
            refresh_resp = client.refresh_webhook(webhook_id)
            refresh_result["status"] = "ok"
            refresh_result["expiration_time"] = refresh_resp.get(
                "expirationTime",
            )
        except (AirtableAPIError, Exception) as exc:
            refresh_result["status"] = "failed"
            refresh_result["error"] = str(exc)[:300]
            logger.warning(
                "airtable_sync_cron: webhook refresh failed: %s", exc,
            )

    audit_payload: dict[str, Any] = {
        "since_iso": since_iso,
        "tables_walked": outcome.tables_walked,
        "records_parsed": outcome.records_parsed,
        "records_upserted": outcome.records_upserted,
        "records_failed": outcome.records_failed,
        "parse_failures": outcome.parse_failures,
        "full_closer_records_seen": outcome.full_closer_records_seen,
        "setter_name_fill_count": outcome.setter_name_fill_count,
        "reactivation_tagged": reactivation_tagged,
        "webhook_refresh": refresh_result,
        "errors": outcome.errors[:10],
    }
    _insert_audit(
        db,
        status="processed",
        payload=audit_payload,
        error="; ".join(outcome.errors)[:2000] if outcome.errors else None,
    )

    logger.info(
        "airtable_sync_cron: since=%s parsed=%d upserted=%d failed=%d "
        "refresh=%s errors=%d",
        since_iso,
        outcome.records_parsed,
        outcome.records_upserted,
        outcome.records_failed,
        refresh_result.get("status", "skipped"),
        len(outcome.errors),
    )
    return audit_payload


def _insert_audit(
    db, *, status: str, payload: dict[str, Any], error: str | None,
) -> None:
    """Per-tick summary row. Same shape as api/meta_sheet_sync_cron.py."""
    delivery_id = f"{AUDIT_SOURCE_CRON}_{uuid.uuid4()}"
    row: dict[str, Any] = {
        "webhook_id": delivery_id,
        "source": AUDIT_SOURCE_CRON,
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
        logger.warning("airtable_sync_cron: audit insert failed: %s", exc)


def _verify_auth(headers: Any) -> bool:
    expected = os.environ.get("CRON_SECRET") or ""
    if not expected:
        logger.error("airtable_sync_cron: CRON_SECRET not configured")
        return False
    auth_header = (
        headers.get("Authorization") or headers.get("authorization") or ""
    )
    if not auth_header.startswith("Bearer "):
        return False
    presented = auth_header[len("Bearer "):]
    return hmac.compare_digest(presented, expected)
