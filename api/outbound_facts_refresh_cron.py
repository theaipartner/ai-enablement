"""Outbound funnel facts refresh cron.

Recomputes `outbound_lead_facts` for every active campaign in
`outbound_campaigns` by calling `refresh_outbound_facts(key)` (migration 0095).
This is the heavy per-lead aggregation — it runs HERE, off the page load, so the
`/sales-dashboard/outbound` page only ever reads the small materialized table
(`outbound_funnel()`, sub-second). See docs/sales/surfaces.md § Outbound.

Also refreshes the sibling `dc_ads_lead_facts` (migration 0123 — the DC ads
funnel page) each tick: its downstream stages come from the same Close/Airtable
mirrors, whose syncs land between ticks. meta_leads_sync_cron refreshes it too
on new opt-ins; both paths are idempotent full rebuilds.

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


# Guards added after the 2026-06-26 saturation incident (refreshes stacked on a
# nano instance until the DB maxed out):
#   - statement_timeout caps EACH campaign's refresh, so a runaway is killed
#     instead of pegging the DB and holding the lock forever.
#   - pg_try_advisory_lock means a tick whose predecessor is still running just
#     SKIPS — refreshes can never stack across */15 ticks.
#   - per-campaign error handling + autocommit: one slow/failed campaign doesn't
#     roll back or block the others.
_REFRESH_LOCK_KEY = 824113          # app-specific advisory-lock id
_REFRESH_TIMEOUT_MS = 240_000       # 4 min per campaign (2 campaigns × 4 < the 15-min tick)


def run_refresh() -> dict[str, Any]:
    """One cron tick: refresh each active campaign's facts. Returns a summary."""
    refreshed: dict[str, int] = {}
    errors: dict[str, str] = {}
    skipped = False
    conn = None
    try:
        conn = _connect()
        conn.autocommit = True  # advisory lock + each refresh commit independently
        cur = conn.cursor()
        cur.execute("select pg_try_advisory_lock(%s)", (_REFRESH_LOCK_KEY,))
        if not cur.fetchone()[0]:
            skipped = True
            logger.info("outbound_facts_refresh_cron: prior refresh still running — skipping tick")
        else:
            try:
                cur.execute(f"set statement_timeout = {_REFRESH_TIMEOUT_MS}")
                cur.execute("select key from outbound_campaigns where is_active order by sort_order")
                for (key,) in cur.fetchall():
                    try:
                        cur.execute("select refresh_outbound_facts(%s)", (key,))
                        refreshed[key] = cur.fetchone()[0]
                    except Exception as exc:  # noqa: BLE001 — one campaign can't sink the rest
                        errors[key] = str(exc)[:300]
                        logger.warning("refresh_outbound_facts(%s) failed: %s", key, exc)
                try:
                    cur.execute("select refresh_dc_ads_facts()")
                    refreshed["dc_ads"] = cur.fetchone()[0]
                except Exception as exc:  # noqa: BLE001 — sibling facts, same isolation
                    errors["dc_ads"] = str(exc)[:300]
                    logger.warning("refresh_dc_ads_facts() failed: %s", exc)
            finally:
                cur.execute("select pg_advisory_unlock(%s)", (_REFRESH_LOCK_KEY,))
        cur.close()
    except Exception as exc:  # noqa: BLE001
        errors["_run"] = str(exc)[:2000]
        logger.exception("outbound_facts_refresh_cron: run failed: %s", exc)
    finally:
        if conn is not None:
            conn.close()

    payload: dict[str, Any] = {"refreshed": refreshed, "campaigns": len(refreshed), "skipped": skipped}
    if errors:
        payload["errors"] = errors
    _insert_audit(
        status="failed" if errors else "processed",
        payload=payload,
        error="; ".join(f"{k}:{v}" for k, v in errors.items()) or None,
    )
    logger.info("outbound_facts_refresh_cron: refreshed=%s skipped=%s errors=%s", refreshed, skipped, errors)
    return payload


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
