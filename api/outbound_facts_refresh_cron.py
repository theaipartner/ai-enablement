"""Outbound funnel facts refresh cron.

Recomputes `outbound_lead_facts` for every active campaign in
`outbound_campaigns` by calling `refresh_outbound_facts(key)` (migration 0095).
This is the heavy per-lead aggregation — it runs HERE, off the page load, so the
`/sales-dashboard/outbound` page only ever reads the small materialized table
(`outbound_funnel()`, sub-second). See docs/sales/surfaces.md § Outbound.

Why psycopg2 (not the supabase client): the refresh takes ~15s, past PostgREST's
8s statement timeout. A direct pooler connection (shared.lead_tagging._connect,
same path the tagger uses) has no such cap. The DELETE+INSERT is one transaction,
so concurrent page reads see the previous committed snapshot until it commits —
never an empty/partial table.

Per-tick behavior:
  1. Auth: validate `Authorization: Bearer ${CRON_SECRET}`.
  2. For each active campaign → `select refresh_outbound_facts(key)`.
  3. Audit row to `webhook_deliveries` with source='outbound_facts_refresh'.

Env vars (set in Vercel):
  CRON_SECRET             — shared Bearer auth across all crons
  SUPABASE_DB_POOL_URL    — pooler URL for the psycopg2 refresh
  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — shared.db (audit insert)

Manual trigger:
  curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \\
       https://ai-enablement-sigma.vercel.app/api/outbound_facts_refresh_cron
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
from shared.lead_tagging import _connect  # noqa: E402  (pooler psycopg2 connection)

logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.outbound_facts_refresh_cron")
logger.setLevel(logging.INFO)

_AUDIT_SOURCE = "outbound_facts_refresh"


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        try:
            self._handle()
        except Exception as exc:  # noqa: BLE001
            logger.exception("outbound_facts_refresh_cron: unhandled error: %s", exc)
            self._respond(500, {"error": "internal_error"})

    def do_GET(self) -> None:
        self.do_POST()

    def _handle(self) -> None:
        if not _verify_auth(self.headers):
            self._respond(401, {"error": "unauthorized"})
            return
        self._respond(200, run_refresh())

    def _respond(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)


def run_refresh() -> dict[str, Any]:
    """One cron tick: refresh each active campaign's facts. Returns a summary."""
    refreshed: dict[str, int] = {}
    error: str | None = None
    conn = None
    try:
        conn = _connect()
        cur = conn.cursor()
        cur.execute("select key from outbound_campaigns where is_active order by sort_order")
        keys = [r[0] for r in cur.fetchall()]
        for key in keys:
            cur.execute("select refresh_outbound_facts(%s)", (key,))
            refreshed[key] = cur.fetchone()[0]
        conn.commit()
        cur.close()
    except Exception as exc:  # noqa: BLE001
        error = str(exc)[:2000]
        logger.exception("outbound_facts_refresh_cron: refresh failed: %s", exc)
        if conn is not None:
            conn.rollback()
    finally:
        if conn is not None:
            conn.close()

    payload = {"refreshed": refreshed, "campaigns": len(refreshed)}
    _insert_audit(
        status="failed" if error else "processed",
        payload=payload,
        error=error,
    )
    logger.info("outbound_facts_refresh_cron: refreshed=%s", refreshed)
    return {**payload, **({"error": error} if error else {})}


def _insert_audit(*, status: str, payload: dict[str, Any], error: str | None) -> None:
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
        get_client().table("webhook_deliveries").insert(row).execute()
    except Exception as exc:  # noqa: BLE001
        logger.warning("outbound_facts_refresh_cron: audit insert failed: %s", exc)


def _verify_auth(headers: Any) -> bool:
    expected = os.environ.get("CRON_SECRET") or ""
    if not expected:
        logger.error("outbound_facts_refresh_cron: CRON_SECRET not configured")
        return False
    auth_header = headers.get("Authorization") or headers.get("authorization") or ""
    if not auth_header.startswith("Bearer "):
        return False
    return hmac.compare_digest(auth_header[len("Bearer ") :], expected)
