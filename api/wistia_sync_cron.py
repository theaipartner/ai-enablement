"""Wistia analytics sync cron — pull per-day stats into wistia_media_daily.

Vercel Cron tick every 3 hours. Refreshes the media inventory + pulls
a rolling 14-day window of per-day stats for every media. Wistia has
no event-push for view activity; this is the "live" mechanism. New
views land within ~3h; restated days self-heal on every tick via
last-write-wins on the (hashed_id, day) PK.

Per-tick behavior:
  1. Auth: validate `Authorization: Bearer ${CRON_SECRET}`.
  2. Instantiate WistiaClient from `WISTIA_API_TOKEN` env var.
  3. `sync_wistia_rolling(client, db, window_days=14)`. Fail-soft
     per media.
  4. Audit row to webhook_deliveries with `source='wistia_sync'`.

Spec: docs/specs/wistia-ingestion.md.
Runbook: docs/runbooks/wistia_ingestion.md.

Env vars required (set in Vercel):
  CRON_SECRET                 — shared Bearer auth across all crons
  WISTIA_API_TOKEN            — gate (d); Drake adds to Vercel env
                                (it's in .env.local for local/backfill)
  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — shared.db

Manual trigger:
  curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \\
       https://ai-enablement-sigma.vercel.app/api/wistia_sync_cron
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
from ingestion.wistia.client import WistiaClient  # noqa: E402
from ingestion.wistia.pipeline import sync_wistia_rolling  # noqa: E402

logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.wistia_sync_cron")
logger.setLevel(logging.INFO)

_AUDIT_SOURCE = "wistia_sync"
# 14-day rolling window — newer views land within hours and Wistia's
# late-arriving event counts (visitors finishing a video days later)
# self-heal on every tick.
_WINDOW_DAYS = 14


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        try:
            self._handle()
        except Exception as exc:
            logger.exception(
                "wistia_sync_cron: unhandled top-level error: %s", exc
            )
            self._respond(500, {"error": "internal_error"})

    def do_GET(self) -> None:
        self.do_POST()

    def _handle(self) -> None:
        if not _verify_auth(self.headers):
            self._respond(401, {"error": "unauthorized"})
            return
        result = run_wistia_sync_cron()
        self._respond(200, result)

    def _respond(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)


def run_wistia_sync_cron() -> dict[str, Any]:
    """Entry point for one cron tick. Returns the audit payload."""
    db = get_client()

    try:
        client = WistiaClient.from_env()
    except RuntimeError as exc:
        _insert_audit(
            db,
            status="failed",
            payload={"error": "wistia_token_unavailable", "detail": str(exc)},
            error=f"wistia_token_unavailable: {exc}",
        )
        logger.warning("wistia_sync_cron: token unavailable — %s", exc)
        return {"error": "wistia_token_unavailable", "detail": str(exc)}

    outcome = sync_wistia_rolling(client, db, window_days=_WINDOW_DAYS)

    audit_payload: dict[str, Any] = {
        "medias_synced": outcome.medias_synced,
        "medias_failed": outcome.medias_failed,
        "daily_rows_upserted": outcome.daily_rows_upserted,
        "daily_rows_failed": outcome.daily_rows_failed,
        "days_in_window": outcome.days_in_window,
        "window": outcome.window,
        "warnings": outcome.warnings,
        # Cap errors to keep the audit row reasonable in size.
        "errors": outcome.errors[:50],
        "errors_truncated": len(outcome.errors) > 50,
    }
    _insert_audit(
        db,
        status="processed",
        payload=audit_payload,
        error="; ".join(outcome.errors)[:2000] if outcome.errors else None,
    )
    logger.info(
        "wistia_sync_cron: medias=%d daily_upserted=%d errors=%d",
        outcome.medias_synced,
        outcome.daily_rows_upserted,
        len(outcome.errors),
    )
    return audit_payload


def _insert_audit(
    db, *, status: str, payload: dict[str, Any], error: str | None,
) -> None:
    """Same shape as api/meta_sheet_sync_cron.py:_insert_audit."""
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
        logger.warning("wistia_sync_cron: audit insert failed: %s", exc)


def _verify_auth(headers: Any) -> bool:
    expected = os.environ.get("CRON_SECRET") or ""
    if not expected:
        logger.error("wistia_sync_cron: CRON_SECRET not configured")
        return False
    auth_header = (
        headers.get("Authorization") or headers.get("authorization") or ""
    )
    if not auth_header.startswith("Bearer "):
        return False
    presented = auth_header[len("Bearer "):]
    return hmac.compare_digest(presented, expected)
