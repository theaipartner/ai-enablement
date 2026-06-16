"""Engagement missing-form pinger — Vercel cron (every 5 min).

Each run: flip overdue engagements, then (inside the 10am-10pm ET window) ping
the rep in Slack for every engagement still owing a form, every 15 min until
they fill it. See docs/schema/engagements.md + shared/engagements.run_ping_cycle.

Auth: shared CRON_SECRET (Authorization: Bearer $CRON_SECRET), same as every
cron in this project. Vercel Cron sends it automatically when CRON_SECRET is set.

  curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \
       https://<deploy>/api/engagement_ping_cron

Env (Vercel): SALES_FORM_NOTIFY_SLACK_CHANNEL (unset => dry-run, no posts),
ENGAGEMENT_PING_FLOOR (go-live timestamp — only ping engagements overdue at/after
it), SETTER_TRIAGE_FORM_URL, CLOSER_TRIAGE_FORM_URL, SLACK_BOT_TOKEN, CRON_SECRET.
"""

from __future__ import annotations

import json
import logging
import os
from http.server import BaseHTTPRequestHandler
from typing import Any

# NOTE: shared.engagements is imported LAZILY inside _handle (not at module
# level). It resolves _REPO_ROOT via Path(__file__).parent.parent; a module-level
# import makes Vercel's function tracer bundle the whole repo root (incl the built
# .next/, ~246 MB) and blow past the 250 MB function-size cap. Same reason
# close_events.py / airtable_events.py import their shared.* hooks lazily.

logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.engagement_ping_cron")
logger.setLevel(logging.INFO)


def _verify_auth(headers: Any) -> bool:
    secret = os.environ.get("CRON_SECRET")
    if not secret:
        logger.error("engagement_ping_cron: CRON_SECRET not configured")
        return False
    return headers.get("Authorization", "") == f"Bearer {secret}"


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        try:
            self._handle()
        except Exception as exc:  # pragma: no cover — last-resort safety
            logger.exception("engagement_ping_cron: unhandled error: %s", exc)
            self._respond(500, {"error": "internal_error"})

    def do_GET(self) -> None:
        # Manual curl debug path — same auth + behavior as the cron POST.
        self.do_POST()

    def _handle(self) -> None:
        if not _verify_auth(self.headers):
            self._respond(401, {"error": "unauthorized"})
            return
        from shared.engagements import run_ping_cycle  # lazy — see module note

        result = run_ping_cycle()
        logger.info("engagement_ping_cron: %s", json.dumps(result, default=str)[:500])
        self._respond(200, result)

    def _respond(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)
