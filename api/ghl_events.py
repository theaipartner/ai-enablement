"""GHL webhook receiver — real-time contact + message events.

Receives GHL events and upserts them into the mirror so new leads + customer
replies (and calls) land within seconds instead of waiting for the */15
ghl_sync_cron (which stays as the reconciliation backstop). Mirrors the house
pattern (webhook live + cron backstop) used for Close / Typeform / Calendly /
Airtable.

Delivery path: because our GHL access is a Private Integration Token (not a
marketplace OAuth app), events arrive via a GHL **Workflow → Custom Webhook**
action that the team configures in the GHL UI (triggers: Contact Created,
Contact/Tag changed, Customer Replied). Those workflow webhooks aren't Ed25519-
signed (that's marketplace apps), so we authenticate with a shared secret the
workflow sends in a header.

Handles (by payload shape, since a workflow payload may omit `type`):
  - message events (InboundMessage / OutboundMessage) -> upsert ghl_messages
  - contact events (ContactCreate / Update / TagUpdate) -> upsert ghl_contacts
  - contact delete -> remove the contact row
Always responds 2xx on a handled error so GHL doesn't disable the webhook. Every
delivery's RAW payload is stored in webhook_deliveries (source='ghl_events') —
the first real delivery is captured there to confirm/adjust the parser shape.

Env vars:
  GHL_WEBHOOK_SECRET                       — shared secret; the workflow sends it
                                             as `Authorization: Bearer <secret>`
                                             or `X-GHL-Webhook-Secret: <secret>`
  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — shared.db

Runbook: docs/runbooks/ghl_ingestion.md § Webhooks.
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
from ingestion.ghl.pipeline import (  # noqa: E402
    looks_like_message,
    parse_webhook_contact,
    parse_webhook_message,
)

logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.ghl_events")
logger.setLevel(logging.INFO)

_AUDIT_SOURCE = "ghl_events"


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        try:
            self._handle()
        except Exception as exc:
            # Always 2xx on a handled error so GHL doesn't disable the webhook;
            # the failure is logged + audited for debugging.
            logger.exception("ghl_events: unhandled error: %s", exc)
            self._audit(
                status="failed",
                payload={"error": str(exc)[:500]},
                error=str(exc)[:2000],
            )
            self._respond(200, {"ok": False, "error": "handled_error"})

    def _handle(self) -> None:
        if not _verify_auth(self.headers):
            self._respond(401, {"error": "unauthorized"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except Exception:
            self._respond(200, {"ok": False, "error": "bad_json"})
            return

        # GHL may wrap a single event or send a batch; normalize to a list.
        events = body if isinstance(body, list) else [body]
        results = [self._process(e) for e in events if isinstance(e, dict)]
        self._audit(
            status="processed",
            payload={"events": events, "results": results},
            error=None,
        )
        self._respond(200, {"ok": True, "processed": results})

    def _process(self, p: dict[str, Any]) -> dict[str, Any]:
        db = get_client()
        etype = str(p.get("type") or "").lower()

        # Contact delete.
        if etype.endswith("delete") and not looks_like_message(p):
            cid = p.get("id") or p.get("contactId")
            if cid:
                db.table("ghl_contacts").delete().eq("id", cid).execute()
            return {"action": "contact_delete", "id": cid}

        # Message event (InboundMessage / OutboundMessage).
        if looks_like_message(p):
            row = parse_webhook_message(p)
            if not row.get("id"):
                return {"action": "message_skip", "reason": "no_id"}
            db.table("ghl_messages").upsert(row, on_conflict="id").execute()
            return {
                "action": "message_upsert",
                "id": row["id"],
                "type": row["message_type"],
            }

        # Contact event (create / update / tag update).
        row = parse_webhook_contact(p)
        if not row.get("id"):
            return {"action": "contact_skip", "reason": "no_id"}
        db.table("ghl_contacts").upsert(row, on_conflict="id").execute()
        return {"action": "contact_upsert", "id": row["id"]}

    def _respond(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)

    def _audit(
        self, *, status: str, payload: dict[str, Any], error: str | None
    ) -> None:
        try:
            db = get_client()
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
            db.table("webhook_deliveries").insert(row).execute()
        except Exception as exc:
            logger.warning("ghl_events: audit insert failed: %s", exc)


def _verify_auth(headers: Any) -> bool:
    expected = os.environ.get("GHL_WEBHOOK_SECRET") or ""
    if not expected:
        logger.error("ghl_events: GHL_WEBHOOK_SECRET not configured")
        return False
    auth = headers.get("Authorization") or headers.get("authorization") or ""
    presented = auth[len("Bearer ") :] if auth.startswith("Bearer ") else ""
    if not presented:
        presented = (
            headers.get("X-GHL-Webhook-Secret")
            or headers.get("x-ghl-webhook-secret")
            or ""
        )
    return bool(presented) and hmac.compare_digest(presented, expected)
