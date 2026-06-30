"""GHL (GoHighLevel) sync cron — mirror contacts + conversations + messages.

Vercel Cron tick: pull GHL contacts (full, idempotent) and conversations, then
re-pull messages only for conversations whose last_message_date moved past the
stored watermark (incremental — see ingestion/ghl/pipeline.py). Steady-state runs
touch only changed conversations, so they stay well inside maxDuration.

IMPORTANT: run the FIRST full backfill locally (`scripts/backfill_ghl.py --apply`)
before relying on the cron — a cold cron with no watermarks would try to pull
every conversation's messages in one tick.

Per-tick behavior:
  1. Auth: validate `Authorization: Bearer ${CRON_SECRET}`.
  2. Build GHLClient from env (GHL_PRIVATE_TOKEN + GHL_LOCATION_ID).
  3. run_sync(full=False) — incremental.
  4. Audit row to `webhook_deliveries` with source='ghl_sync'.

Env vars (set in Vercel):
  CRON_SECRET                              — shared Bearer auth across all crons
  GHL_PRIVATE_TOKEN                        — read-only Private Integration token
  GHL_LOCATION_ID                          — the sub-account / location id
  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — shared.db

Runbook: docs/runbooks/ghl_ingestion.md.

Manual trigger:
  curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \\
       https://ai-enablement-sigma.vercel.app/api/ghl_sync_cron
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
from ingestion.ghl.client import GHLClient  # noqa: E402
from ingestion.ghl.pipeline import run_sync  # noqa: E402

logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.ghl_sync_cron")
logger.setLevel(logging.INFO)

_AUDIT_SOURCE = "ghl_sync"


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        try:
            self._handle()
        except Exception as exc:
            logger.exception("ghl_sync_cron: unhandled top-level error: %s", exc)
            self._respond(500, {"error": "internal_error"})

    def do_GET(self) -> None:
        self.do_POST()

    def _handle(self) -> None:
        if not _verify_auth(self.headers):
            self._respond(401, {"error": "unauthorized"})
            return
        result = run_ghl_sync_cron()
        self._respond(200, result)

    def _respond(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)


def run_ghl_sync_cron() -> dict[str, Any]:
    """One cron tick. Returns the audit-payload dict."""
    db = get_client()

    try:
        client = GHLClient.from_env()
    except RuntimeError as exc:
        _insert_audit(
            db,
            status="failed",
            payload={"error": "ghl_creds_unavailable", "detail": str(exc)},
            error=f"ghl_creds_unavailable: {exc}",
        )
        logger.warning("ghl_sync_cron: %s", exc)
        return {"error": "ghl_creds_unavailable", "detail": str(exc)}

    outcome = run_sync(client, db, full=False)

    audit_payload: dict[str, Any] = {
        "contacts_synced": outcome.contacts_synced,
        "contacts_failed": outcome.contacts_failed,
        "conversations_synced": outcome.conversations_synced,
        "conversations_scanned_for_messages": outcome.conversations_scanned_for_messages,
        "messages_synced": outcome.messages_synced,
        "messages_failed": outcome.messages_failed,
        "error_count": len(outcome.errors),
        "errors": outcome.errors[:50],
    }
    _insert_audit(
        db,
        status="processed",
        payload=audit_payload,
        error="; ".join(outcome.errors)[:2000] if outcome.errors else None,
    )

    logger.info(
        "ghl_sync_cron: contacts=%d convos=%d messages=%d errors=%d",
        outcome.contacts_synced,
        outcome.conversations_synced,
        outcome.messages_synced,
        len(outcome.errors),
    )
    return audit_payload


def _insert_audit(
    db, *, status: str, payload: dict[str, Any], error: str | None
) -> None:
    """Per-cron-invocation summary row (same shape as the other sync crons)."""
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
        logger.warning("ghl_sync_cron: audit insert failed: %s", exc)


def _verify_auth(headers: Any) -> bool:
    expected = os.environ.get("CRON_SECRET") or ""
    if not expected:
        logger.error("ghl_sync_cron: CRON_SECRET not configured")
        return False
    auth_header = headers.get("Authorization") or headers.get("authorization") or ""
    if not auth_header.startswith("Bearer "):
        return False
    presented = auth_header[len("Bearer ") :]
    return hmac.compare_digest(presented, expected)
