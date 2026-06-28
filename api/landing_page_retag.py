"""On-demand landing-page retag endpoint — the "Retag now" button.

POST with {"form_ids": ["SFedWelr", ...]} (or {"slug": "main"}). Authenticated
with `Authorization: Bearer ${CRON_SECRET}` (the dashboard's server action calls
this internally). Retags every lead that submitted any of those Typeforms so a
newly-registered landing page picks up opt-ins that arrived BEFORE it was
registered (going-forward leads attribute automatically via the webhook/cron
tagger — see lead_tagging.retag_by_form).

Not scheduled (no cron entry) — invoked on demand only.
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

from shared.db import get_client  # noqa: E402
from shared.lead_tagging import retag_by_form  # noqa: E402

logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.landing_page_retag")
logger.setLevel(logging.INFO)


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        try:
            self._handle()
        except Exception as exc:
            logger.exception("landing_page_retag: unhandled error: %s", exc)
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

        form_ids = body.get("form_ids") or []
        slug = body.get("slug")
        if slug and not form_ids:
            form_ids = _form_ids_for_slug(slug)
        form_ids = [f for f in form_ids if f]
        if not form_ids:
            self._respond(400, {"error": "no_form_ids"})
            return

        result = retag_by_form(form_ids, trigger="lp_retag_now")
        self._respond(
            200,
            {
                "ok": result.get("ok", False),
                "form_ids": form_ids,
                "lead_count": result.get("lead_count", 0),
            },
        )

    def _respond(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)


def _form_ids_for_slug(slug: str) -> list[str]:
    db = get_client()
    resp = (
        db.table("landing_page_forms")
        .select("form_id")
        .eq("landing_page_slug", slug)
        .execute()
    )
    return [r["form_id"] for r in (resp.data or []) if r.get("form_id")]


def _verify_auth(headers: Any) -> bool:
    expected = os.environ.get("CRON_SECRET") or ""
    if not expected:
        logger.error("landing_page_retag: CRON_SECRET not configured")
        return False
    auth_header = headers.get("Authorization") or headers.get("authorization") or ""
    if not auth_header.startswith("Bearer "):
        return False
    presented = auth_header[len("Bearer ") :]
    return hmac.compare_digest(presented, expected)
