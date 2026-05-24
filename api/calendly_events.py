"""Calendly webhook endpoint.

Deployed by Vercel as a serverless Python function at `/api/calendly_events`.
Calendly pushes events here in real time after the subscription is
registered (see `scripts/register_calendly_webhook.py`).

Sync flow (mirrors `api/close_events.py`):

  1. Read raw body bytes (signature verification needs them unparsed).
  2. Verify Calendly-Webhook-Signature header. Format is Stripe-style:
     `t=<unix_ts>,v1=<hex>`. HMAC input is `<timestamp>.<body>` (period
     separator, UTF-8 bytes); algorithm SHA256; signing key is the
     plain string returned at subscription creation, encoded UTF-8.
     On fail → 401.
  3. Replay-window check (5 min) against `t=` timestamp.
  4. Dedup via webhook_deliveries upsert keyed on synthesized
     `calendly:{timestamp}:{sha256(body)[:16]}`. (Calendly doesn't
     ship a stable per-delivery id header.)
  5. Parse JSON, extract `event` + `payload`. Route by event:
       - `invitee.created` / `invitee.canceled` → fetch event +
         upsert both via sync_invitee_and_event.
       - `invitee_no_show.created` / `.deleted` → upsert invitee
         (no_show flag changes).
       - any other event → audit-row written, no upsert (Drake's
         mirror-everything principle; future-proof by logging
         unknown types without failing).
  6. Mark `processed` + return 200. Any handler exception → mark
     `failed`, log, STILL return 200 so Calendly's auto-disable
     doesn't fire on a single bad payload.

In-scope event types (per docs/specs/calendly-ingestion.md + the
register script's EVENTS_IN_SCOPE):

  - invitee.created       → invitee upsert + event refresh
  - invitee.canceled      → same path; status changes
  - invitee_no_show.created → invitee upsert (no_show flag updated)
  - invitee_no_show.deleted → same

Env vars (set in Vercel — NOT committed):
  CALENDLY_WEBHOOK_SECRET    — returned ONCE by POST /webhook_subscriptions
  CALENDLY_API_KEY           — for the parent-event fetch on each tick
  SUPABASE_URL               — shared.db
  SUPABASE_SERVICE_ROLE_KEY  — shared.db

NOTE on signature format: Calendly's exact `Calendly-Webhook-Signature`
header format wasn't pasted directly in their docs at design time.
Implementation here follows the Stripe-style `t=<ts>,v1=<hex>` pattern
which is what Calendly's signature verification docs describe in
prose. If the first real delivery 401s, inspect the actual header in
webhook_deliveries.headers and adjust. The runbook calls this out
under the activation steps.
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

from ingestion.calendly.client import CalendlyAPIError, CalendlyClient
from ingestion.calendly.pipeline import (
    sync_invitee_and_event,
    upsert_invitee_from_payload,
)
from shared.db import get_client


logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.calendly_webhook")
logger.setLevel(logging.INFO)


_REPLAY_WINDOW_SECONDS = 300
_MAX_ERROR_CHARS = 2000

_HEADERS_TO_STORE = frozenset({
    "calendly-webhook-signature",  # store the WHOLE header for forensics,
                                   # but redact the signature portion before
                                   # persisting — only the timestamp is kept
    "content-type",
    "content-length",
    "user-agent",
})


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        try:
            self._handle_post()
        except Exception as exc:
            logger.exception("calendly_webhook: unhandled top-level: %s", exc)
            # Always 200 on top-level crash so Calendly doesn't auto-disable.
            self._respond(200, {"status": "error_swallowed"})

    def do_GET(self) -> None:
        self._respond(
            200,
            {"status": "ok", "endpoint": "calendly_events", "accepts": "POST"},
        )

    def _handle_post(self) -> None:
        body = self._read_body()

        secret = os.environ.get("CALENDLY_WEBHOOK_SECRET")
        if not secret:
            logger.error("calendly_webhook: CALENDLY_WEBHOOK_SECRET not configured")
            self._respond(500, {"error": "misconfigured"})
            return

        sig_header = (
            self.headers.get("calendly-webhook-signature")
            or self.headers.get("Calendly-Webhook-Signature")
            or ""
        )
        wh_ts, sig_v1 = _parse_signature_header(sig_header)
        if not (wh_ts and sig_v1):
            logger.warning(
                "calendly_webhook: signature header missing/malformed: %r",
                sig_header[:80],
            )
            self._respond(401, {"error": "signature_invalid"})
            return

        if not _verify_signature(body, wh_ts, sig_v1, secret):
            logger.warning(
                "calendly_webhook: signature verification failed (ts=%s)",
                wh_ts,
            )
            self._respond(401, {"error": "signature_invalid"})
            return

        if not _check_replay_window(wh_ts):
            logger.warning("calendly_webhook: replay window exceeded (ts=%s)", wh_ts)
            self._respond(401, {"error": "stale_timestamp"})
            return

        try:
            envelope = json.loads(body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            logger.warning("calendly_webhook: invalid JSON: %s", exc)
            self._respond(400, {"error": "invalid_json"})
            return

        webhook_id = _synthesize_webhook_id(wh_ts, body)
        db = get_client()
        sanitized_headers = _sanitize_headers(self.headers)
        event_name = envelope.get("event") or ""
        payload = envelope.get("payload") or {}
        # `payload` for invitee.* is the invitee object; `payload.event` is
        # the parent event URI. For invitee_no_show.* it's similar.
        primary_uri = payload.get("uri") if isinstance(payload, dict) else None

        insert_resp = (
            db.table("webhook_deliveries")
            .upsert(
                {
                    "webhook_id": webhook_id,
                    "source": "calendly_webhook",
                    "processing_status": "received",
                    "call_external_id": primary_uri,
                    "payload": envelope,
                    "headers": sanitized_headers,
                },
                on_conflict="webhook_id",
                ignore_duplicates=True,
                returning="representation",
            )
            .execute()
        )
        if not insert_resp.data:
            logger.info(
                "calendly_webhook: duplicate delivery key=%s event=%s",
                webhook_id[:32], event_name,
            )
            self._respond(200, {"deduplicated": True})
            return

        try:
            upserted_id, route = _route_event(db, event_name, payload)
        except Exception as exc:
            tb = _sanitize_traceback(traceback.format_exc())
            logger.exception(
                "calendly_webhook: routing raised event=%s key=%s: %s",
                event_name, webhook_id[:32], exc,
            )
            _mark_failed(db, webhook_id, tb)
            self._respond(200, {"status": "logged_and_failed"})
            return

        _mark_processed(db, webhook_id, upserted_id or primary_uri)
        logger.info(
            "calendly_webhook: processed event=%s route=%s upserted=%s",
            event_name, route, upserted_id,
        )
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
# Signature verification — Calendly's scheme
# ---------------------------------------------------------------------------


def _parse_signature_header(header_value: str) -> tuple[str, str]:
    """Parse `t=<ts>,v1=<hex>` into (timestamp, signature).

    Header values from Calendly observed empirically (Stripe-style).
    Returns ('', '') on malformed input — caller treats as failure.
    """
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
        elif k == "v1":
            sig = v
    return ts, sig


def _verify_signature(body: bytes, wh_ts: str, sig_v1: str, secret: str) -> bool:
    """Calendly HMAC-SHA256 over `<timestamp>.<body>` (period separator).

    Signing key is the UTF-8 bytes of the secret returned at subscription
    creation. Signature is hex-encoded. Constant-time compare via
    `hmac.compare_digest`.

    If Calendly's actual scheme differs from this Stripe-style assumption
    (e.g. no separator, different field encoding), the first real
    delivery will 401 and we can adjust based on the captured header in
    webhook_deliveries.headers. See module docstring.
    """
    if not (wh_ts and sig_v1 and secret):
        return False
    try:
        timestamp_bytes = wh_ts.encode("utf-8")
        secret_bytes = secret.encode("utf-8")
    except Exception:
        return False
    signed = timestamp_bytes + b"." + body
    expected = hmac.new(secret_bytes, signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig_v1, expected)


def _check_replay_window(wh_ts: str) -> bool:
    try:
        ts_int = int(wh_ts)
    except ValueError:
        return False
    return abs(time.time() - ts_int) <= _REPLAY_WINDOW_SECONDS


def _synthesize_webhook_id(wh_ts: str, body: bytes) -> str:
    """Same shape as the Close receiver — Calendly doesn't ship a
    stable per-delivery id header, so we synthesize one for dedup."""
    body_hash = hashlib.sha256(body).hexdigest()[:16]
    return f"calendly:{wh_ts}:{body_hash}"


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------


def _route_event(
    db,
    event_name: str,
    payload: dict[str, Any],
) -> tuple[str | None, str]:
    """Dispatch one webhook event. Returns (upserted_id, route_label).
    Unknown events are audited (caller handles webhook_deliveries) but
    not routed — return (None, 'unknown:<event>').
    """
    if event_name in ("invitee.created", "invitee.canceled"):
        # Need the API client to fetch the parent event. Init lazily
        # so unit tests can run without env vars.
        try:
            client = CalendlyClient.from_env()
        except RuntimeError as exc:
            raise CalendlyAPIError(f"calendly client init failed: {exc}") from exc
        outcome = sync_invitee_and_event(client, db, payload)
        # Surface the invitee URI as the upserted_id for the audit row.
        return payload.get("uri"), "invitee+event"

    if event_name in ("invitee_no_show.created", "invitee_no_show.deleted"):
        # no_show events carry an invitee-shaped payload with the flag
        # updated. Just upsert the invitee.
        try:
            inv_uri = upsert_invitee_from_payload(db, payload)
            return inv_uri, "invitee (no_show)"
        except Exception:
            raise

    logger.info(
        "calendly_webhook: unrouted event=%s — audit row written, no upsert",
        event_name,
    )
    return None, f"unknown:{event_name}"


# ---------------------------------------------------------------------------
# webhook_deliveries lifecycle helpers (same shape as fathom/close)
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
    """Preserve only safe debugging headers. The signature header is
    KEPT but with the v1 portion redacted — the timestamp is useful
    for forensics; the actual signature is a secret we don't store."""
    out: dict[str, str] = {}
    for key in _HEADERS_TO_STORE:
        val = headers.get(key)
        if val is None:
            continue
        s = str(val)
        if key == "calendly-webhook-signature":
            # Strip the v1=<hex> portion; keep t=<ts> + any other field
            # for forensic timestamp inspection without persisting the
            # actual signature bytes.
            parts = [p for p in s.split(",") if not p.strip().startswith("v1=")]
            s = ",".join(parts) + ",v1=<REDACTED>"
        out[key] = s
    return out


def _sanitize_traceback(tb: str) -> str:
    if not tb:
        return ""
    lines = tb.splitlines()
    filtered = [
        line for line in lines
        if "whsec_" not in line
        and "sk-" not in line
        and "eyJh" not in line
        and "CALENDLY_WEBHOOK_SECRET" not in line
        and "CALENDLY_API_KEY" not in line
    ]
    return "\n".join(filtered)[:_MAX_ERROR_CHARS]
