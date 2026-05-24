"""Typeform webhook endpoint — receives `form_response` deliveries.

Deployed by Vercel as a serverless Python function at `/api/typeform_events`.
Typeform pushes one event per submission after the subscription is
registered via `scripts/register_typeform_webhooks.py`.

Sync flow (matches `api/close_events.py` shape — no background threads;
Vercel kills them on response):

  1. Read raw body bytes (signature verification needs them unparsed).
  2. Verify `Typeform-Signature` header:
       HMAC-SHA256(raw_body, TYPEFORM_WEBHOOK_SECRET) → base64
       header format: `sha256=<base64>`
       Constant-time compare via `hmac.compare_digest`.
     Per Typeform docs (and confirmed against the live PUT flow during
     discovery 2026-05-24). On fail → 401, no DB write.
  3. Dedup via `webhook_deliveries` upsert keyed on the envelope's
     `event_id` (Typeform's idempotency key). True duplicates → fast
     200, no-op downstream.
  4. Parse JSON, extract `form_response`, call
     `pipeline.upsert_response_from_webhook()`. Same parser the backfill
     uses — backfill ↔ webhook ↔ cron-backstop all converge on the same
     idempotent upsert (response_id PK).
  5. Mark `processed` + return 2xx. On any handler exception → mark
     `failed`, log, BUT STILL return 200 so Typeform's auto-disable-on-
     repeated-failure doesn't fire. The cron backstop heals any miss.

In-scope event types: only `form_response`. Other types (if Typeform
ever adds them to this subscription) land as `unknown:<type>` audit
rows + 200.

Env vars (set in Vercel — NOT committed):
  TYPEFORM_WEBHOOK_SECRET   — caller-supplied shared secret; same value
                              used by scripts/register_typeform_webhooks.py
                              when registering subscriptions.
  TYPEFORM_API_KEY          — used for the receiver's lazy form-definition
                              sync if a response arrives for a not-yet-
                              mirrored form. Best-effort; not required
                              for the primary upsert path.
  SUPABASE_URL              — shared.db
  SUPABASE_SERVICE_ROLE_KEY — shared.db
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import sys
import traceback
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from ingestion.typeform.client import TypeformClient  # noqa: E402
from ingestion.typeform.pipeline import (  # noqa: E402
    upsert_response_from_webhook,
)
from shared.db import get_client  # noqa: E402


# Vercel's Python runtime pre-configures the root logger at WARNING; bump
# to INFO so operational lines land in the log stream.
logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.typeform_webhook")
logger.setLevel(logging.INFO)


_MAX_ERROR_CHARS = 2000

# Headers we preserve in webhook_deliveries.headers for forensic use.
# Signature header explicitly excluded — never store the signature itself.
_HEADERS_TO_STORE = frozenset({
    "content-type",
    "content-length",
    "user-agent",
})


# ---------------------------------------------------------------------------
# HTTP handler — Vercel instantiates per request
# ---------------------------------------------------------------------------


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        try:
            self._handle_post()
        except Exception as exc:  # pragma: no cover — last-resort safety
            logger.exception(
                "typeform_webhook: unhandled top-level error: %s", exc,
            )
            # Still 200 so Typeform doesn't auto-disable.
            self._respond(200, {"status": "error_swallowed"})

    def do_GET(self) -> None:
        self._respond(
            200,
            {"status": "ok", "endpoint": "typeform_events", "accepts": "POST"},
        )

    def _handle_post(self) -> None:
        body = self._read_body()

        secret = os.environ.get("TYPEFORM_WEBHOOK_SECRET")
        if not secret:
            logger.error("typeform_webhook: TYPEFORM_WEBHOOK_SECRET not configured")
            self._respond(500, {"error": "misconfigured"})
            return

        sig_header = (
            self.headers.get("Typeform-Signature")
            or self.headers.get("typeform-signature")
            or ""
        )
        if not _verify_signature(body, sig_header, secret):
            logger.warning(
                "typeform_webhook: signature verification failed sig_prefix=%s",
                sig_header[:16],
            )
            self._respond(401, {"error": "signature_invalid"})
            return

        try:
            payload = json.loads(body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            logger.warning("typeform_webhook: body not valid JSON: %s", exc)
            self._respond(400, {"error": "invalid_json"})
            return

        event_id = payload.get("event_id") or ""
        event_type = payload.get("event_type") or ""
        form_response = payload.get("form_response") or {}
        response_id = form_response.get("token") or form_response.get("response_id") or ""
        form_id = form_response.get("form_id") or (form_response.get("definition") or {}).get("id")

        if not event_id:
            # Typeform delivers event_id on every payload; absence means
            # the envelope shape changed. Synthesize a stable key so we
            # still have an audit row.
            body_hash = hashlib.sha256(body).hexdigest()[:16]
            event_id = f"typeform_no_event_id:{body_hash}"
            logger.warning(
                "typeform_webhook: missing event_id event_type=%s synth=%s",
                event_type, event_id[:32],
            )

        webhook_id = f"typeform_response_webhook:{event_id}"

        db = get_client()
        sanitized_headers = _sanitize_headers(self.headers)

        # Audit-first upsert. True duplicate → empty .data → fast 200.
        insert_resp = (
            db.table("webhook_deliveries")
            .upsert(
                {
                    "webhook_id": webhook_id,
                    "source": "typeform_response_webhook",
                    "processing_status": "received",
                    "call_external_id": response_id or None,
                    "payload": payload,
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
                "typeform_webhook: duplicate delivery key=%s response_id=%s",
                webhook_id[:48], response_id,
            )
            self._respond(200, {"deduplicated": True})
            return

        # Route. Only form_response is in scope.
        if event_type != "form_response":
            logger.info(
                "typeform_webhook: unrouted event_type=%s — audit row written, no upsert",
                event_type,
            )
            _mark_processed(db, webhook_id, response_id or None)
            self._respond(
                200,
                {"delivered": True, "event_type": event_type, "routed": False},
            )
            return

        # Process. Fail-soft: mark `failed` but return 200.
        try:
            # Best-effort lazy form-definition sync — pass a client if
            # the API key is in env. Caller will skip if it can't build.
            client = _safe_client()
            upserted_id = upsert_response_from_webhook(
                db, form_response, client=client,
            )
        except Exception as exc:
            tb = _sanitize_traceback(traceback.format_exc())
            logger.exception(
                "typeform_webhook: upsert raised response_id=%s key=%s: %s",
                response_id, webhook_id[:48], exc,
            )
            _mark_failed(db, webhook_id, tb)
            self._respond(200, {"status": "logged_and_failed"})
            return

        _mark_processed(db, webhook_id, upserted_id or response_id or None)
        logger.info(
            "typeform_webhook: processed event_type=%s response_id=%s form_id=%s",
            event_type, upserted_id, form_id,
        )
        self._respond(
            200,
            {
                "delivered": True,
                "event_type": event_type,
                "response_id": upserted_id,
                "form_id": form_id,
            },
        )

    # ------------------------------------------------------------------
    # HTTP helpers
    # ------------------------------------------------------------------

    def _read_body(self) -> bytes:
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            return b""
        return self.rfile.read(length) if length > 0 else b""

    def _respond(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)


# ---------------------------------------------------------------------------
# Signature verification — Typeform's scheme
# ---------------------------------------------------------------------------


def _verify_signature(body: bytes, sig_header: str, secret: str) -> bool:
    """Typeform signs deliveries with:

        HMAC-SHA256(raw_body, secret) → base64
        Header: `Typeform-Signature: sha256=<base64>`

    Constant-time compare. Tolerates the legacy bare-base64 form (no
    `sha256=` prefix) defensively — the prefix has been the default
    for years but some old SDK examples show the bare form.
    """
    if not (sig_header and secret):
        return False
    if sig_header.startswith("sha256="):
        presented = sig_header[len("sha256=") :]
    else:
        presented = sig_header
    expected = base64.b64encode(
        hmac.new(secret.encode("utf-8"), body, hashlib.sha256).digest()
    ).decode("ascii")
    return hmac.compare_digest(presented, expected)


# ---------------------------------------------------------------------------
# webhook_deliveries row lifecycle helpers
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
    update: dict[str, Any] = {
        "processing_status": "processed",
        "processed_at": datetime.now(timezone.utc).isoformat(),
    }
    if external_id:
        update["call_external_id"] = external_id
    db.table("webhook_deliveries").update(update).eq("webhook_id", webhook_id).execute()


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------


def _safe_client() -> TypeformClient | None:
    """Build a TypeformClient if env is configured; None otherwise.
    Used for best-effort lazy form-definition sync. Never raises."""
    try:
        return TypeformClient.from_env()
    except Exception:
        return None


def _sanitize_headers(headers: Any) -> dict[str, str]:
    out: dict[str, str] = {}
    for key in _HEADERS_TO_STORE:
        val = headers.get(key)
        if val is not None:
            out[key] = str(val)
    return out


def _sanitize_traceback(tb: str) -> str:
    if not tb:
        return ""
    lines = tb.splitlines()
    filtered = [
        line for line in lines
        if "TYPEFORM_WEBHOOK_SECRET" not in line
        and "TYPEFORM_API_KEY" not in line
        and "Bearer " not in line
    ]
    return "\n".join(filtered)[:_MAX_ERROR_CHARS]
