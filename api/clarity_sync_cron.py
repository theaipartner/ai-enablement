"""Microsoft Clarity sync cron — pull page metrics into clarity_metrics_daily.

Vercel Cron tick once per day: one API call to Clarity's project-live-
insights endpoint with `numOfDays=3` (self-healing window), parses the
9 metric blocks, idempotently upserts per (snapshot_date, metric_name,
url).

Why daily (not more frequent): Clarity data is daily-grained, and the
3-day re-pull means a 1- or 2-day cron outage self-heals on the next
tick. Cron uses 1 of the 10-req/day project cap — massive headroom.

Per-tick behavior:
  1. Auth: validate `Authorization: Bearer ${CRON_SECRET}`.
  2. Build ClarityClient from env (CLARITY_API_KEY).
  3. Run `ingestion.clarity.pipeline.sync_clarity_metrics_daily(db, client)`.
  4. Write summary audit row to `webhook_deliveries` with
     `source='clarity_sync'`.

Spec: docs/specs/clarity-ingestion.md.
Runbook: docs/runbooks/clarity_ingestion.md.

Env vars (set in Vercel):
  CRON_SECRET                              — shared Bearer auth across all crons
  CLARITY_API_KEY                          — admin-only Clarity token (gate d add)
  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — shared.db

Manual trigger:
  curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \\
       https://ai-enablement-sigma.vercel.app/api/clarity_sync_cron
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
from ingestion.clarity.client import ClarityClient  # noqa: E402
from ingestion.clarity.pipeline import sync_clarity_metrics_daily  # noqa: E402

logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.clarity_sync_cron")
logger.setLevel(logging.INFO)

_AUDIT_SOURCE = "clarity_sync"


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        try:
            self._handle()
        except Exception as exc:
            logger.exception(
                "clarity_sync_cron: unhandled top-level error: %s", exc
            )
            self._respond(500, {"error": "internal_error"})

    def do_GET(self) -> None:
        self.do_POST()

    def _handle(self) -> None:
        if not _verify_auth(self.headers):
            self._respond(401, {"error": "unauthorized"})
            return
        result = run_clarity_sync_cron()
        self._respond(200, result)

    def _respond(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)


def run_clarity_sync_cron() -> dict[str, Any]:
    """One cron tick. Returns the audit-payload dict."""
    db = get_client()

    try:
        client = ClarityClient.from_env()
    except RuntimeError as exc:
        _insert_audit(
            db,
            status="failed",
            payload={"error": "clarity_token_unavailable", "detail": str(exc)},
            error=f"clarity_token_unavailable: {exc}",
        )
        logger.warning("clarity_sync_cron: %s", exc)
        return {"error": "clarity_token_unavailable", "detail": str(exc)}

    outcome = sync_clarity_metrics_daily(db, client)

    audit_payload: dict[str, Any] = {
        "snapshot_date": outcome.snapshot_date,
        "metric_blocks_seen": outcome.metric_blocks_seen,
        "rows_parsed": outcome.rows_parsed,
        "rows_upserted": outcome.rows_upserted,
        "rows_failed": outcome.rows_failed,
        "distinct_path_count": len(outcome.distinct_paths),
        "distinct_paths": outcome.distinct_paths,
        "warnings": outcome.warnings,
        "errors": outcome.errors,
    }
    # `processed` even when errors is non-empty (per meta_sheet_sync_cron
    # precedent — partial success is still progress; the error list
    # surfaces the failures for debugging without failing the cron).
    status = "processed"
    _insert_audit(
        db,
        status=status,
        payload=audit_payload,
        error="; ".join(outcome.errors)[:2000] if outcome.errors else None,
    )

    logger.info(
        "clarity_sync_cron: parsed=%d upserted=%d failed=%d errors=%d",
        outcome.rows_parsed,
        outcome.rows_upserted,
        outcome.rows_failed,
        len(outcome.errors),
    )
    return audit_payload


def _insert_audit(
    db, *, status: str, payload: dict[str, Any], error: str | None,
) -> None:
    """Per-cron-invocation summary row. Same shape as api/meta_sheet_sync_cron.py."""
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
        logger.warning("clarity_sync_cron: audit insert failed: %s", exc)


def _verify_auth(headers: Any) -> bool:
    expected = os.environ.get("CRON_SECRET") or ""
    if not expected:
        logger.error("clarity_sync_cron: CRON_SECRET not configured")
        return False
    auth_header = (
        headers.get("Authorization") or headers.get("authorization") or ""
    )
    if not auth_header.startswith("Bearer "):
        return False
    presented = auth_header[len("Bearer ") :]
    return hmac.compare_digest(presented, expected)
