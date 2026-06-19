"""OnceHub webhook endpoint.

Deployed by Vercel as a serverless Python function at `/api/oncehub_events`.
OnceHub pushes booking lifecycle events here in real time once the subscription
is registered (see scripts/register_oncehub_webhook.py).

Sync flow (mirrors api/calendly_events.py):

  1. Read raw body bytes (signature verification needs them unparsed).
  2. Verify the `Oncehub-Signature` header. Format: `t=<unix_ts>,s=<hex>`
     (comma-separated). HMAC-SHA256 over `<timestamp>.<body>` (period
     separator, UTF-8); signing key is the per-endpoint secret returned at
     webhook creation. On fail -> 401.
  3. Replay-window check (5 min) against `t=`.
  4. Dedup via webhook_deliveries upsert keyed on the envelope `id`
     (EVNT-... — OnceHub ships a stable per-delivery event id, unlike Calendly).
  5. Parse JSON. Envelope: {id, object:"event", type, api_version, creation_time,
     data:{...}}. Route by `type`:
       - booking.*  -> upsert the booking object (data) into oncehub_bookings.
       - conversation.* / anything else -> audit row only, no upsert
         (mirror-everything; future-proof by logging unknown types).
  6. Mark processed + 200. Any handler exception -> mark failed, log, STILL
     return 200 so OnceHub's retry/auto-disable doesn't fire on one bad payload.

Env vars (set in Vercel — NOT committed):
  ONCEHUB_WEBHOOK_SECRET   — the per-endpoint secret (from webhook creation /
                             OnceHub UI "View secret"; readable via /v2/webhooks)
  SUPABASE_URL             — shared.db
  SUPABASE_SERVICE_ROLE_KEY— shared.db

NOTE: only v2 webhooks are signed. If the first real delivery 401s, inspect the
captured `Oncehub-Signature` in webhook_deliveries.headers and confirm the
endpoint is v2 (api_version on the envelope).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import time
import traceback
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from typing import Any

from ingestion.oncehub.pipeline import upsert_booking_from_payload
from shared.db import get_client

logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.oncehub_webhook")
logger.setLevel(logging.INFO)

_REPLAY_WINDOW_SECONDS = 300
_MAX_ERROR_CHARS = 2000

_HEADERS_TO_STORE = frozenset({
    "oncehub-signature",  # stored with the s=<hex> portion redacted (timestamp kept)
    "content-type",
    "content-length",
    "user-agent",
})


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        try:
            self._handle_post()
        except Exception as exc:  # noqa: BLE001
            logger.exception("oncehub_webhook: unhandled top-level: %s", exc)
            # Always 200 on top-level crash so OnceHub doesn't auto-disable.
            self._respond(200, {"status": "error_swallowed"})

    def do_GET(self) -> None:
        self._respond(
            200,
            {"status": "ok", "endpoint": "oncehub_events", "accepts": "POST"},
        )

    def _handle_post(self) -> None:
        body = self._read_body()

        secret = os.environ.get("ONCEHUB_WEBHOOK_SECRET")
        if not secret:
            logger.error("oncehub_webhook: ONCEHUB_WEBHOOK_SECRET not configured")
            self._respond(500, {"error": "misconfigured"})
            return

        sig_header = (
            self.headers.get("oncehub-signature")
            or self.headers.get("Oncehub-Signature")
            or ""
        )
        wh_ts, sig_s = _parse_signature_header(sig_header)
        if not (wh_ts and sig_s):
            logger.warning(
                "oncehub_webhook: signature header missing/malformed: %r",
                sig_header[:80],
            )
            self._respond(401, {"error": "signature_invalid"})
            return

        if not _verify_signature(body, wh_ts, sig_s, secret):
            logger.warning("oncehub_webhook: signature verification failed (ts=%s)", wh_ts)
            self._respond(401, {"error": "signature_invalid"})
            return

        if not _check_replay_window(wh_ts):
            logger.warning("oncehub_webhook: replay window exceeded (ts=%s)", wh_ts)
            self._respond(401, {"error": "stale_timestamp"})
            return

        try:
            envelope = json.loads(body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            logger.warning("oncehub_webhook: invalid JSON: %s", exc)
            self._respond(400, {"error": "invalid_json"})
            return

        event_id = envelope.get("id") or _synthesize_event_id(wh_ts, body)
        webhook_id = f"oncehub:{event_id}"
        event_name = envelope.get("event") or envelope.get("type") or ""
        data = envelope.get("data") or {}
        booking_id = data.get("id") if isinstance(data, dict) else None

        db = get_client()
        insert_resp = (
            db.table("webhook_deliveries")
            .upsert(
                {
                    "webhook_id": webhook_id,
                    "source": "oncehub_webhook",
                    "processing_status": "received",
                    "call_external_id": booking_id,
                    "payload": envelope,
                    "headers": _sanitize_headers(self.headers),
                },
                on_conflict="webhook_id",
                ignore_duplicates=True,
                returning="representation",
            )
            .execute()
        )
        if not insert_resp.data:
            logger.info(
                "oncehub_webhook: duplicate delivery key=%s event=%s",
                webhook_id[:40], event_name,
            )
            self._respond(200, {"deduplicated": True})
            return

        try:
            upserted_id, route = _route_event(db, event_name, data)
        except Exception as exc:  # noqa: BLE001
            tb = _sanitize_traceback(traceback.format_exc())
            logger.exception(
                "oncehub_webhook: routing raised event=%s key=%s: %s",
                event_name, webhook_id[:40], exc,
            )
            _mark_failed(db, webhook_id, tb)
            self._respond(200, {"status": "logged_and_failed"})
            return

        _mark_processed(db, webhook_id, upserted_id or booking_id)
        logger.info(
            "oncehub_webhook: processed event=%s route=%s upserted=%s",
            event_name, route, upserted_id,
        )

        # Live re-tag of the booking's lead so lead_cycles updates immediately
        # (the OnceHub analog of api/calendly_events.py's retag). A booking carries
        # the invitee email/phone; retag_by_contact resolves identity → in-scope
        # close_id(s) and recomputes their cycle. Fail-soft; a brand-new lead whose
        # Close row doesn't exist yet is a clean no-op (the Close webhook tags it).
        if isinstance(event_name, str) and event_name.startswith("booking."):
            form = data.get("form_submission") if isinstance(data, dict) else None
            if isinstance(form, dict):
                email = form.get("email")
                phone = form.get("phone") or form.get("mobile_phone")
                if email or phone:
                    try:
                        from shared.lead_tagging import retag_by_contact

                        retag_by_contact(
                            emails=[email] if email else None,
                            phones=[phone] if phone else None,
                            trigger="webhook:oncehub",
                        )
                    except Exception as exc:  # noqa: BLE001 — fail-soft by design
                        logger.warning("oncehub_webhook: lead retag failed: %s", exc)

        self._respond(
            200,
            {"delivered": True, "event": event_name, "upserted_id": upserted_id},
        )

    def _read_body(self) -> bytes:
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            return b""
        return self.rfile.read(length) if length > 0 else b""

    def _respond(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)


# ---------------------------------------------------------------------------
# Signature verification — OnceHub's scheme
# ---------------------------------------------------------------------------


def _parse_signature_header(header_value: str) -> tuple[str, str]:
    """Parse `t=<ts>,s=<hex>` into (timestamp, signature). ('', '') on bad input."""
    if not header_value:
        return "", ""
    ts = ""
    sig = ""
    for part in header_value.split(","):
        kv = part.strip().split("=", 1)
        if len(kv) != 2:
            continue
        k, v = kv[0].strip(), kv[1].strip()
        if k == "t":
            ts = v
        elif k == "s":
            sig = v
    return ts, sig


def _verify_signature(body: bytes, wh_ts: str, sig_s: str, secret: str) -> bool:
    """OnceHub HMAC-SHA256 over `<timestamp>.<body>` (period separator).

    Signing key = UTF-8 bytes of the per-endpoint secret. Signature hex-encoded.
    Constant-time compare.
    """
    if not (wh_ts and sig_s and secret):
        return False
    try:
        signed = wh_ts.encode("utf-8") + b"." + body
        expected = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()
    except Exception:
        return False
    return hmac.compare_digest(sig_s, expected)


def _check_replay_window(wh_ts: str) -> bool:
    try:
        ts_int = int(wh_ts)
    except ValueError:
        return False
    return abs(time.time() - ts_int) <= _REPLAY_WINDOW_SECONDS


def _synthesize_event_id(wh_ts: str, body: bytes) -> str:
    """Fallback dedup key if an envelope ever lacks `id`."""
    return f"{wh_ts}:{hashlib.sha256(body).hexdigest()[:16]}"


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------


def _route_event(db, event_name: str, data: dict[str, Any]) -> tuple[str | None, str]:
    """Dispatch one event. Returns (upserted_id, route_label).

    booking.* events carry the booking object in `data` -> upsert. Everything
    else (conversation.*, unknown) is audited via webhook_deliveries but not
    routed.
    """
    if isinstance(event_name, str) and event_name.startswith("booking."):
        if not isinstance(data, dict) or not data.get("id"):
            logger.warning("oncehub_webhook: %s with no booking data — audited", event_name)
            return None, f"{event_name}:no_data"
        bid = upsert_booking_from_payload(db, data, event_type=event_name)
        return bid, event_name

    logger.info("oncehub_webhook: unrouted event=%s — audit row written, no upsert", event_name)
    return None, f"unknown:{event_name}"


# ---------------------------------------------------------------------------
# webhook_deliveries lifecycle helpers (same shape as calendly/close)
# ---------------------------------------------------------------------------


def _mark_failed(db, webhook_id: str, traceback_text: str) -> None:
    db.table("webhook_deliveries").update(
        {
            "processing_status": "failed",
            "processing_error": traceback_text[:_MAX_ERROR_CHARS],
            "processed_at": datetime.now(timezone.utc).isoformat(),
        }
    ).eq("webhook_id", webhook_id).execute()


def _mark_processed(db, webhook_id: str, external_id: str | None) -> None:
    update = {
        "processing_status": "processed",
        "processed_at": datetime.now(timezone.utc).isoformat(),
    }
    if external_id:
        update["call_external_id"] = external_id
    db.table("webhook_deliveries").update(update).eq("webhook_id", webhook_id).execute()


def _sanitize_headers(headers: Any) -> dict[str, str]:
    """Keep safe debugging headers. The signature header is kept with the
    s=<hex> portion redacted — the timestamp is useful, the signature is not
    something we persist."""
    out: dict[str, str] = {}
    for key in _HEADERS_TO_STORE:
        val = headers.get(key)
        if val is None:
            continue
        s = str(val)
        if key == "oncehub-signature":
            parts = [p for p in s.split(",") if not p.strip().startswith("s=")]
            s = ",".join(parts) + ",s=<REDACTED>"
        out[key] = s
    return out


def _sanitize_traceback(tb: str) -> str:
    if not tb:
        return ""
    filtered = [
        line for line in tb.splitlines()
        if "ONCEHUB_WEBHOOK_SECRET" not in line
        and "ONCEHUB_API_KEY" not in line
        and "API-Key" not in line
    ]
    return "\n".join(filtered)[:_MAX_ERROR_CHARS]
