"""Typeform reconciliation cron — backstop for the live webhook path.

Vercel Cron tick every 15 minutes. Mirrors Close's "webhooks live,
polling backstop retained" posture: any submission a webhook delivery
missed (provider hiccup, function cold-start error, fail-soft 2xx on
a transient bug) lands here within ~15 min.

Per-tick behavior:
  1. Auth: validate `Authorization: Bearer ${CRON_SECRET}`.
  2. `sync_all_form_definitions()` — cheap (~31 form defs), keeps the
     question-ref dictionary fresh as forms are edited.
  3. `sync_all_responses(since=<now - SAFETY_WINDOW_HOURS>)` — re-walks
     the last N hours of responses. Idempotent upserts on response_id
     make webhook-then-cron double-write a no-op.
  4. Audit row to webhook_deliveries with `source='typeform_sync_cron'`.

Cadence rationale (lean: */15):
  - Webhooks are the primary path; this is reconciliation.
  - Cadence tighter than the 3h Meta/Wistia default because Typeform
    is a real-time-relevant data source (closers may want fresh leads
    ASAP — see spec § Decision: webhooks for live + cron backstop).
  - 15-min cadence × 6-hour safety window = 24 overlapping passes,
    plenty of room to absorb a webhook-disable + recovery cycle.

Spec: docs/specs/typeform-ingestion.md.
Runbook: docs/runbooks/typeform_ingestion.md.

Env vars (set in Vercel):
  CRON_SECRET                  — shared Bearer auth across all crons.
  TYPEFORM_API_KEY             — PAT. gate (d); Drake adds to Vercel
                                 (also in .env.local for local/backfill).
  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — shared.db.

Manual trigger:
  curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \\
       https://ai-enablement-sigma.vercel.app/api/typeform_sync_cron
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

from shared.db import get_client  # noqa: E402
from ingestion.typeform.client import TypeformClient  # noqa: E402
from ingestion.typeform.pipeline import (  # noqa: E402
    SyncOutcome,
    sync_all_form_definitions,
    sync_all_responses,
)

logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.typeform_sync_cron")
logger.setLevel(logging.INFO)

_AUDIT_SOURCE = "typeform_sync_cron"
# Safety window: how far back the per-tick sync re-walks. 6 hours at a
# 15-min cadence = 24 overlapping passes — plenty for any plausible
# webhook-miss recovery scenario.
_SAFETY_WINDOW_HOURS = 6


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        try:
            self._handle()
        except Exception as exc:
            logger.exception(
                "typeform_sync_cron: unhandled top-level error: %s", exc,
            )
            self._respond(500, {"error": "internal_error"})

    def do_GET(self) -> None:
        self.do_POST()

    def _handle(self) -> None:
        if not _verify_auth(self.headers):
            self._respond(401, {"error": "unauthorized"})
            return
        result = run_typeform_sync_cron()
        self._respond(200, result)

    def _respond(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)


def run_typeform_sync_cron() -> dict[str, Any]:
    """Entry point for one cron tick. Returns the audit payload."""
    db = get_client()

    try:
        client = TypeformClient.from_env()
    except RuntimeError as exc:
        _insert_audit(
            db,
            status="failed",
            payload={"error": "typeform_token_unavailable", "detail": str(exc)},
            error=f"typeform_token_unavailable: {exc}",
        )
        logger.warning("typeform_sync_cron: token unavailable — %s", exc)
        return {"error": "typeform_token_unavailable", "detail": str(exc)}

    since_dt = datetime.now(timezone.utc) - timedelta(hours=_SAFETY_WINDOW_HOURS)
    since_iso = since_dt.strftime("%Y-%m-%dT%H:%M:%S")

    outcome = SyncOutcome()
    sync_all_form_definitions(client, db, outcome)
    sync_all_responses(client, db, since=since_iso, outcome=outcome)

    audit_payload: dict[str, Any] = {
        "since": since_iso,
        "forms_walked": outcome.forms_walked,
        "forms_synced": outcome.forms_synced,
        "forms_failed": outcome.forms_failed,
        "responses_synced": outcome.responses_synced,
        "responses_failed": outcome.responses_failed,
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
        "typeform_sync_cron: forms_synced=%d responses_synced=%d errors=%d since=%s",
        outcome.forms_synced,
        outcome.responses_synced,
        len(outcome.errors),
        since_iso,
    )
    return audit_payload


def _insert_audit(
    db, *, status: str, payload: dict[str, Any], error: str | None,
) -> None:
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
        logger.warning("typeform_sync_cron: audit insert failed: %s", exc)


def _verify_auth(headers: Any) -> bool:
    expected = os.environ.get("CRON_SECRET") or ""
    if not expected:
        logger.error("typeform_sync_cron: CRON_SECRET not configured")
        return False
    auth_header = (
        headers.get("Authorization") or headers.get("authorization") or ""
    )
    if not auth_header.startswith("Bearer "):
        return False
    presented = auth_header[len("Bearer "):]
    return hmac.compare_digest(presented, expected)
