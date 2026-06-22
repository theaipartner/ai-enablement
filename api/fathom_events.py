"""Fathom webhook endpoint.

Deployed by Vercel as a serverless Python function at `/api/fathom_events`.
Fathom's `new-meeting-content-ready` deliveries land here after each call's
post-processing finishes (transcript + summary + action items ready per the
`include_*` flags set at registration).

Sync flow (no background threads — Vercel kills them on response; same
reasoning as `api/slack_events.py`, see `docs/runbooks/slack_webhook.md`
for the smoke-test result that pinned this):

  1. Read raw body bytes. Signature verification needs them unparsed.
  2. Verify Standard Webhooks signature (HMAC-SHA256, 5-min replay window).
     On fail → 401, no DB write.
  3. Extract `webhook-id` header. Missing → 400.
  4. Parse JSON. Malformed → 400.
  5. Dedupe via UPSERT on `webhook_deliveries.webhook_id` with
     `ignore_duplicates=True`. Empty data return → this is a retry/dup →
     200 immediately. Non-empty return → we own this delivery.
  6. Adapt payload → FathomCallRecord via
     `ingestion.fathom.webhook_adapter.record_from_webhook`. On
     `AdapterError` (missing required field, bad timestamp) → mark the
     row `malformed`, return 400 (Fathom does not retry on 4xx — the
     payload itself is bad).
  7. `pipeline.ingest_call` (same entry point the backlog uses). Writes
     `calls`, `call_participants`, `documents` (`call_transcript_chunk`
     + `call_summary`), `document_chunks`, `call_action_items`. On any
     uncaught exception → mark `failed` (with sanitized traceback),
     return 500 so Fathom retries.
  8. Mark row `processed`, return 200.

Spec: docs/archive/historical/fathom_webhook.md.

Env vars required (set in the Vercel project — NOT committed):
  FATHOM_WEBHOOK_SECRET        — `whsec_<base64>` from Fathom's
                                 `POST /webhooks` response.
  SUPABASE_URL                 — shared.db.
  SUPABASE_SERVICE_ROLE_KEY    — shared.db.
  OPENAI_API_KEY               — shared.kb_query.embed for chunk embeddings.
"""

from __future__ import annotations

import base64
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

from ingestion.fathom.pipeline import ingest_call, load_resolvers
from ingestion.fathom.webhook_adapter import AdapterError, record_from_webhook
from shared.db import get_client
from shared.kb_query import embed


# Vercel's Python runtime pre-configures the root logger at WARNING; set it
# to INFO explicitly so our operational log lines land in the Vercel stream.
# Same workaround as api/slack_events.py — confirmed necessary during the
# Slack smoke test on 2026-04-23.
logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.fathom_webhook")
logger.setLevel(logging.INFO)


# Standard Webhooks replay-protection window. Deliveries older than this are
# rejected regardless of signature — an attacker who captured a valid signed
# request can't replay it hours later.
_REPLAY_WINDOW_SECONDS = 300

# Cap stored traceback strings so we never accidentally persist a giant env
# dump into webhook_deliveries.processing_error. 2000 chars is enough for
# type + top/bottom of stack, which is all we need for diagnosis.
_MAX_ERROR_CHARS = 2000

# Headers preserved in webhook_deliveries.headers for forensic use. Signature
# excluded — we never want that in the DB. Everything else in the incoming
# request is dropped.
_HEADERS_TO_STORE = frozenset({
    "webhook-id",
    "webhook-timestamp",
    "content-type",
    "content-length",
    "user-agent",
})


# ---------------------------------------------------------------------------
# HTTP handler — Vercel instantiates `handler` once per request
# ---------------------------------------------------------------------------


class handler(BaseHTTPRequestHandler):
    """Vercel's Python runtime instantiates this per request."""

    def do_POST(self) -> None:
        try:
            self._handle_post()
        except Exception as exc:  # pragma: no cover — last-resort safety net
            logger.exception("fathom_webhook: unhandled top-level error: %s", exc)
            self._respond(500, {"error": "internal_error"})

    def do_GET(self) -> None:
        # Friendly hint for browser / uptime-check hits. Same shape as
        # api/slack_events.py.
        self._respond(
            200,
            {"status": "ok", "endpoint": "fathom_events", "accepts": "POST"},
        )

    # ------------------------------------------------------------------
    # Main flow
    # ------------------------------------------------------------------

    def _handle_post(self) -> None:
        body = self._read_body()

        # Signature verification is the gate. Do this BEFORE any DB writes
        # so a flood of bad signatures can't bloat webhook_deliveries with
        # junk rows. Bad signature → 401, drop the request entirely.
        secret = os.environ.get("FATHOM_WEBHOOK_SECRET")
        if not secret:
            logger.error("fathom_webhook: FATHOM_WEBHOOK_SECRET not configured")
            self._respond(500, {"error": "misconfigured"})
            return
        if not _verify_signature(body, self.headers, secret):
            webhook_id_prefix = (self.headers.get("webhook-id", "") or "")[:16]
            logger.warning(
                "fathom_webhook: signature verification failed webhook-id=%s...",
                webhook_id_prefix,
            )
            self._respond(401, {"error": "signature_invalid"})
            return

        webhook_id = self.headers.get("webhook-id", "")
        if not webhook_id:
            logger.warning("fathom_webhook: delivery missing webhook-id header")
            self._respond(400, {"error": "missing_webhook_id"})
            return

        try:
            payload = json.loads(body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            logger.warning("fathom_webhook: body not valid JSON: %s", exc)
            self._respond(400, {"error": "invalid_json"})
            return

        db = get_client()
        sanitized_headers = _sanitize_headers(self.headers)
        call_external_id = (
            str(payload.get("recording_id"))
            if payload.get("recording_id") is not None
            else None
        )

        # UPSERT with ignore_duplicates=True: first insert returns the row,
        # a duplicate webhook_id returns data=[]. Empirical test (F2.4)
        # confirmed this shape against PostgREST.
        insert_resp = (
            db.table("webhook_deliveries")
            .upsert(
                {
                    "webhook_id": webhook_id,
                    "source": "fathom_webhook",
                    "processing_status": "received",
                    "call_external_id": call_external_id,
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
            # Retry or concurrent second invocation — the other invocation
            # is handling ingest. Acking 200 quickly stops Fathom's retry
            # cascade; idempotency at the DB layer handles the rest.
            logger.info(
                "fathom_webhook: duplicate webhook-id=%s — acking without re-ingest",
                webhook_id[:16],
            )
            self._respond(
                200,
                {"deduplicated": True, "webhook_id": webhook_id},
            )
            return

        # Now we own this delivery. From here on, every exit path must
        # update webhook_deliveries so the row never sits at
        # processing_status='received' after the function exits.

        try:
            record = record_from_webhook(payload)
        except AdapterError as exc:
            logger.warning(
                "fathom_webhook: adapter rejected payload webhook-id=%s: %s",
                webhook_id[:16], exc,
            )
            _mark_malformed(db, webhook_id, str(exc))
            self._respond(400, {"error": "malformed_payload", "detail": str(exc)})
            return

        try:
            client_resolver, team_resolver, _ = load_resolvers(db)
            outcome = ingest_call(
                record,
                db,
                client_resolver=client_resolver,
                team_resolver=team_resolver,
                embed_fn=embed,
                file_size_bytes=None,
                dry_run=False,
            )
        except Exception as exc:
            # Catch everything. A single bad ingest must not take the
            # function down for the next delivery. Fathom will retry on
            # 500; the pipeline is idempotent; the cron backfill (F2.6)
            # is the backstop for non-transient failures.
            tb = _sanitize_traceback(traceback.format_exc())
            logger.exception(
                "fathom_webhook: ingest raised for webhook-id=%s: %s",
                webhook_id[:16], exc,
            )
            _mark_failed(db, webhook_id, tb)
            self._respond(500, {"error": "ingest_failed"})
            return

        _mark_processed(db, webhook_id, record.external_id)
        logger.info(
            "fathom_webhook: processed webhook-id=%s external_id=%s action=%s "
            "chunks_written=%d",
            webhook_id[:16],
            record.external_id,
            outcome.action,
            outcome.chunks_written,
        )
        self._respond(
            200,
            {
                "delivered": webhook_id,
                "external_id": record.external_id,
                "action": outcome.action,
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
        encoded = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)


# ---------------------------------------------------------------------------
# Signature verification — Standard Webhooks spec
# ---------------------------------------------------------------------------


def _verify_signature(body: bytes, headers: Any, secret: str) -> bool:
    """Verify a Standard Webhooks signature. Returns False on any failure.

    Algorithm (per docs/archive/historical/fathom_webhook.md §b):
      1. Concatenate `f"{webhook-id}.{webhook-timestamp}.".encode() + body`.
      2. HMAC-SHA256 that with the base64-decoded secret (strip `whsec_`).
      3. Base64-encode the digest.
      4. Split `webhook-signature` on whitespace; each token is
         `<version>,<base64-sig>`. Constant-time compare each v1
         signature to our computed one.
      5. Reject if `|now - timestamp| > _REPLAY_WINDOW_SECONDS`.
    """
    wh_id = headers.get("webhook-id", "") or ""
    wh_ts = headers.get("webhook-timestamp", "") or ""
    wh_sig = headers.get("webhook-signature", "") or ""
    if not (wh_id and wh_ts and wh_sig):
        return False
    if not secret.startswith("whsec_"):
        return False

    try:
        ts_int = int(wh_ts)
    except ValueError:
        return False
    if abs(time.time() - ts_int) > _REPLAY_WINDOW_SECONDS:
        return False

    try:
        secret_bytes = base64.b64decode(secret[len("whsec_") :])
    except Exception:
        return False

    signed_payload = f"{wh_id}.{wh_ts}.".encode("utf-8") + body
    expected = base64.b64encode(
        hmac.new(secret_bytes, signed_payload, hashlib.sha256).digest()
    ).decode()

    for candidate in wh_sig.split():
        _, _, sig_b64 = candidate.partition(",")
        if sig_b64 and hmac.compare_digest(sig_b64, expected):
            return True
    return False


# ---------------------------------------------------------------------------
# webhook_deliveries row lifecycle helpers
# ---------------------------------------------------------------------------


def _mark_malformed(db, webhook_id: str, error_message: str) -> None:
    db.table("webhook_deliveries").update(
        {
            "processing_status": "malformed",
            "processing_error": error_message[:_MAX_ERROR_CHARS],
            "processed_at": datetime.now(timezone.utc).isoformat(),
        }
    ).eq("webhook_id", webhook_id).execute()


def _mark_failed(db, webhook_id: str, traceback_text: str) -> None:
    db.table("webhook_deliveries").update(
        {
            "processing_status": "failed",
            "processing_error": traceback_text[:_MAX_ERROR_CHARS],
            "processed_at": datetime.now(timezone.utc).isoformat(),
        }
    ).eq("webhook_id", webhook_id).execute()


def _mark_processed(db, webhook_id: str, call_external_id: str) -> None:
    db.table("webhook_deliveries").update(
        {
            "processing_status": "processed",
            "processed_at": datetime.now(timezone.utc).isoformat(),
            "call_external_id": call_external_id,
        }
    ).eq("webhook_id", webhook_id).execute()


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------


def _sanitize_headers(headers: Any) -> dict[str, str]:
    """Preserve only safe debugging headers. Signature ALWAYS excluded."""
    out: dict[str, str] = {}
    for key in _HEADERS_TO_STORE:
        val = headers.get(key)
        if val is not None:
            out[key] = str(val)
    return out


def _sanitize_traceback(tb: str) -> str:
    """Trim the traceback before persisting to the DB.

    Keeps the most recent exception's class + message + the first + last
    few frames. Drops anything containing a clear secret pattern
    (whsec_, sk-, eyJh — the three shapes we most commonly see). Belt-
    and-suspenders; the pipeline shouldn't log secrets to begin with,
    but a rare traceback path could include an env value.
    """
    if not tb:
        return ""
    lines = tb.splitlines()
    filtered = [
        line for line in lines
        if "whsec_" not in line and "sk-" not in line and "eyJh" not in line
    ]
    return "\n".join(filtered)[:_MAX_ERROR_CHARS]
