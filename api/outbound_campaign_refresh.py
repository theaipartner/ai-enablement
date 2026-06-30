"""On-demand outbound-campaign refresh endpoint — the "Re-tag / Refresh" button.

POST {"key": "<campaign_key>"} → recompute outbound_lead_facts for that one
campaign via refresh_outbound_facts(key). Authenticated with
`Authorization: Bearer ${CRON_SECRET}` (the dashboard's server action calls this
internally — same pattern as api/landing_page_retag.py).

Why psycopg2 (not the supabase client): the refresh can take seconds, past
PostgREST's 8s statement timeout. A direct pooler connection (shared.lead_tagging
._connect, the same path the */15 outbound_facts_refresh_cron uses) has no such
cap. Re-running is idempotent — refresh_outbound_facts does DELETE+INSERT in one
transaction, so concurrent page reads see the prior committed snapshot until it
commits.

Used after adding a campaign or changing its match field/value so the funnel
re-matches immediately instead of waiting for the next cron tick.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from shared.lead_tagging import _connect  # noqa: E402

logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.outbound_campaign_refresh")
logger.setLevel(logging.INFO)


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        try:
            self._handle()
        except Exception as exc:
            logger.exception("outbound_campaign_refresh: unhandled error: %s", exc)
            self._respond(500, {"error": "internal_error"})

    def _handle(self) -> None:
        if not _verify_auth(self.headers):
            self._respond(401, {"error": "unauthorized"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except Exception:
            self._respond(400, {"error": "bad_json"})
            return

        key = (body.get("key") or "").strip()
        if not key:
            self._respond(400, {"error": "no_key"})
            return

        conn = _connect()
        try:
            conn.autocommit = True
            with conn.cursor() as cur:
                cur.execute("select refresh_outbound_facts(%s)", (key,))
                lead_count = cur.fetchone()[0]
        finally:
            conn.close()

        logger.info("outbound_campaign_refresh key=%s lead_count=%s", key, lead_count)
        self._respond(200, {"ok": True, "key": key, "lead_count": lead_count})

    def _respond(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)


def _verify_auth(headers: Any) -> bool:
    expected = os.environ.get("CRON_SECRET") or ""
    if not expected:
        logger.error("outbound_campaign_refresh: CRON_SECRET not configured")
        return False
    auth_header = headers.get("Authorization") or headers.get("authorization") or ""
    if not auth_header.startswith("Bearer "):
        return False
    presented = auth_header[len("Bearer ") :]
    return hmac.compare_digest(presented, expected)
