"""Close CRM webhook endpoint.

Deployed by Vercel as a serverless Python function at `/api/close_events`.
Close pushes events here in real time after the subscription is registered
(see `scripts/register_close_webhook.py` for setup).

Sync flow (matches `api/fathom_events.py` shape — no background threads;
Vercel kills them on response):

  1. Read raw body bytes (signature verification needs them unparsed).
  2. Verify Close signature: `hmac_sha256(bytes.fromhex(secret),
     close-sig-timestamp + body).hexdigest()` == `close-sig-hash` header.
     On fail → 401. No DB write.
  3. Replay-window check (5 min) against `close-sig-timestamp`.
  4. Dedup via `webhook_deliveries` upsert keyed on a synthesized
     webhook_id = `close:{close-sig-timestamp}:{sha256(body)[:16]}`.
     Close doesn't mint a stable delivery-id header (Standard Webhooks
     style); the synthesized key gives us idempotency against true
     duplicates (same timestamp + same body bytes) while letting
     legitimate retries with a new timestamp re-attempt.
  5. Parse JSON, extract `event.object_type` + `event.action`, route
     to the matching `ingestion.close.pipeline` upsert helper.
  6. Mark `processed` + return 2xx. On any handler exception → mark
     `failed`, log, but STILL return 200 so Close's auto-disable
     (3 days of failures) doesn't fire on a single bad payload.
     Operationally: re-process via the polling cron's `sync_recently_
     updated_leads` if anything truly fails to land.

In-scope event types (per docs/specs/close-live-webhooks.md +
Drake 2026-05-23 override re: opportunities):

  - lead.created / lead.updated / lead.merged
  - opportunity.created / opportunity.updated
  - activity.call.created / activity.call.updated
  - activity.sms.created / activity.sms.updated
  - activity.lead_status_change.created

Unknown event types (anything Close sends that we haven't routed) → log
+ mark `processed` + return 200. Drake's principle: "mirror everything
Close emits"; unknown types get the audit-trail row so we can decide
later what to do with them.

Env vars (set in Vercel — NOT committed):
  CLOSE_WEBHOOK_SECRET       — hex string; from POST /api/v1/webhook/
                               response when the subscription is created.
                               See scripts/register_close_webhook.py.
  SUPABASE_URL               — shared.db.
  SUPABASE_SERVICE_ROLE_KEY  — shared.db.
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

from ingestion.close.pipeline import (
    load_lead_cf_id_to_name,
    upsert_call_from_payload,
    upsert_lead_from_payload,
    upsert_lead_status_change_from_payload,
    upsert_opportunity_from_payload,
    upsert_sms_from_payload,
)
from ingestion.setter_calls import (
    EligibilityError,
    RecordingFetchError,
    transcribe_call,
)
from ingestion.setter_calls.deepgram import DeepgramError
from shared.db import get_client


# Vercel's Python runtime pre-configures the root logger at WARNING; bump
# to INFO so operational lines land in the Vercel log stream. Same
# workaround as api/fathom_events.py.
logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.close_webhook")
logger.setLevel(logging.INFO)


# Close doesn't document a replay window; 5 minutes is the same window
# Fathom/Standard-Webhooks uses. An attacker who captures a valid signed
# request can't replay it hours later. Aligns with the 72h Close retry
# window not extending that far back per-attempt.
_REPLAY_WINDOW_SECONDS = 300

_MAX_ERROR_CHARS = 2000

# Headers we preserve in webhook_deliveries.headers for forensic use.
# Signature explicitly excluded — never store it.
_HEADERS_TO_STORE = frozenset({
    "close-sig-timestamp",
    "content-type",
    "content-length",
    "user-agent",
})

# Event-type → handler dispatch. Each handler receives (db, event_data,
# cf_id_to_name_or_none) and returns either the upserted close_id or None
# (if the payload was unusable — logged but not failed). Unknown types
# land in the catch-all path below.
_EVENT_TYPE_PREFIX_SEP = "."


# ---------------------------------------------------------------------------
# HTTP handler — Vercel instantiates per request
# ---------------------------------------------------------------------------


class handler(BaseHTTPRequestHandler):
    """Vercel's Python runtime instantiates this per request."""

    def do_POST(self) -> None:
        try:
            self._handle_post()
        except Exception as exc:  # pragma: no cover — last-resort safety
            logger.exception("close_webhook: unhandled top-level error: %s", exc)
            # Still 200 so Close doesn't auto-disable; the audit row
            # will say `failed` if it landed before the crash.
            self._respond(200, {"status": "error_swallowed"})

    def do_GET(self) -> None:
        self._respond(
            200,
            {"status": "ok", "endpoint": "close_events", "accepts": "POST"},
        )

    # ------------------------------------------------------------------
    # Main flow
    # ------------------------------------------------------------------

    def _handle_post(self) -> None:
        body = self._read_body()

        secret = os.environ.get("CLOSE_WEBHOOK_SECRET")
        if not secret:
            logger.error("close_webhook: CLOSE_WEBHOOK_SECRET not configured")
            self._respond(500, {"error": "misconfigured"})
            return

        wh_ts = self.headers.get("close-sig-timestamp", "") or ""
        wh_sig = self.headers.get("close-sig-hash", "") or ""
        if not _verify_signature(body, wh_ts, wh_sig, secret):
            logger.warning(
                "close_webhook: signature verification failed (ts=%s)",
                wh_ts[:20],
            )
            self._respond(401, {"error": "signature_invalid"})
            return

        if not _check_replay_window(wh_ts):
            logger.warning("close_webhook: replay window exceeded (ts=%s)", wh_ts)
            self._respond(401, {"error": "stale_timestamp"})
            return

        try:
            payload = json.loads(body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            logger.warning("close_webhook: body not valid JSON: %s", exc)
            self._respond(400, {"error": "invalid_json"})
            return

        # Synthesized stable dedup key. Same body+timestamp → same key →
        # PK collision → fast-ack as duplicate. Different retry timestamp
        # → different key → re-attempt processing (idempotent upserts
        # downstream make this safe).
        webhook_id = _synthesize_webhook_id(wh_ts, body)

        db = get_client()
        sanitized_headers = _sanitize_headers(self.headers)

        # Extract event metadata for the audit row even before processing.
        event = payload.get("event") or {}
        object_type = event.get("object_type") or ""
        action = event.get("action") or ""
        event_type = f"{object_type}{_EVENT_TYPE_PREFIX_SEP}{action}" if object_type else ""
        event_data = event.get("data") or {}
        event_object_id = event_data.get("id") if isinstance(event_data, dict) else None

        # Audit-first upsert. If a true duplicate (same key), data=[] →
        # fast-ack 200. Otherwise we own this delivery and process below.
        insert_resp = (
            db.table("webhook_deliveries")
            .upsert(
                {
                    "webhook_id": webhook_id,
                    "source": "close_webhook",
                    "processing_status": "received",
                    "call_external_id": event_object_id,
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
                "close_webhook: duplicate delivery key=%s event_type=%s",
                webhook_id[:24], event_type,
            )
            self._respond(200, {"deduplicated": True})
            return

        # Process. Fail-soft: an exception marks `failed` but we still
        # return 200 so Close doesn't auto-disable the subscription. The
        # polling cron / next webhook on the same object will heal the gap.
        try:
            upserted_id, route = _route_event(db, event_type, event_data)
        except Exception as exc:
            tb = _sanitize_traceback(traceback.format_exc())
            logger.exception(
                "close_webhook: routing/upsert raised event_type=%s key=%s: %s",
                event_type, webhook_id[:24], exc,
            )
            _mark_failed(db, webhook_id, tb)
            self._respond(200, {"status": "logged_and_failed"})
            return

        _mark_processed(db, webhook_id, upserted_id or event_object_id)
        logger.info(
            "close_webhook: processed event_type=%s route=%s upserted_id=%s",
            event_type, route, upserted_id,
        )

        # Live transcription trigger. When the upsert touched close_calls
        # AND the call is eligible (>=90s + has recording + not expired),
        # fire the Deepgram pipeline synchronously. Cheap eligibility
        # check first (~50ms DB read) so non-eligible calls don't block
        # the webhook response. For eligible calls the round-trip is
        # ~3-5s — within Close's webhook timeout window (~30s) and well
        # under our Vercel function budget (60s). Errors here are
        # logged but do NOT fail the webhook (returning non-200 would
        # tell Close to retry, which doesn't help — eligibility issues
        # are usually "recording hasn't been uploaded yet" and will
        # resolve when activity.call.updated fires later).
        transcription_meta: dict[str, Any] = {"attempted": False}
        if route == "close_calls" and upserted_id:
            transcription_meta = _maybe_transcribe(db, upserted_id)

        self._respond(
            200,
            {
                "delivered": True,
                "event_type": event_type,
                "upserted_id": upserted_id,
                "transcription": transcription_meta,
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
# Signature verification — Close's scheme
# ---------------------------------------------------------------------------


def _verify_signature(body: bytes, wh_ts: str, wh_sig: str, secret_hex: str) -> bool:
    """HMAC-SHA256 of timestamp+body using hex-decoded secret. Hex compare.

    Per Close docs (verbatim Python example, fetched 2026-05-23):

        key = '058bfb6a3d8cfdc4da7c3be5901b16ae11da982b46a25fb2cd7016e97a140a1c'
        data = headers['close-sig-timestamp'] + payload
        signature = hmac.new(bytearray.fromhex(key), data.encode('utf-8'),
                             hashlib.sha256).hexdigest()
        valid = hmac.compare_digest(headers['close-sig-hash'], signature)

    Constant-time compare via `hmac.compare_digest`.
    """
    if not (wh_ts and wh_sig and secret_hex):
        return False
    try:
        key_bytes = bytes.fromhex(secret_hex)
    except ValueError:
        return False
    # Mirror Close's "timestamp + payload concatenated" — operate on bytes
    # throughout so we don't depend on the body being valid UTF-8.
    data = wh_ts.encode("utf-8") + body
    expected = hmac.new(key_bytes, data, hashlib.sha256).hexdigest()
    return hmac.compare_digest(wh_sig, expected)


def _check_replay_window(wh_ts: str) -> bool:
    """Reject deliveries older than _REPLAY_WINDOW_SECONDS."""
    try:
        ts_int = int(wh_ts)
    except ValueError:
        return False
    return abs(time.time() - ts_int) <= _REPLAY_WINDOW_SECONDS


def _synthesize_webhook_id(wh_ts: str, body: bytes) -> str:
    """Stable dedup key derived from timestamp + body bytes.

    Close doesn't ship a Standard-Webhooks-style `webhook-id` header, so
    we synthesize one. Two true duplicates (same body, same delivery)
    produce identical keys; legitimate retries land with a new timestamp
    and re-attempt processing (downstream upserts handle the actual
    object-level idempotency via `ON CONFLICT (close_id)`).
    """
    body_hash = hashlib.sha256(body).hexdigest()[:16]
    return f"close:{wh_ts}:{body_hash}"


# ---------------------------------------------------------------------------
# Event-type routing
# ---------------------------------------------------------------------------


def _route_event(
    db,
    event_type: str,
    event_data: dict[str, Any],
) -> tuple[str | None, str]:
    """Dispatch one event to its pipeline helper.

    Returns (upserted_close_id_or_None, route_label).
    Raises only on unhandled exceptions — unknown event types are not
    failures; they return (None, 'unknown:<type>').

    `event_data` is the FULL new object per Close's webhook docs — we
    upsert directly without an extra API fetch.
    """
    # Leads + lead merges land in close_leads. Merged events also include
    # the lead's new state in `data`, so the same upsert path applies.
    if event_type in ("lead.created", "lead.updated", "lead.merged"):
        cf_map = load_lead_cf_id_to_name(db)
        return upsert_lead_from_payload(db, event_data, cf_map), "close_leads"

    # Opportunities (Drake-override 2026-05-23 — IN scope).
    if event_type in ("opportunity.created", "opportunity.updated"):
        return upsert_opportunity_from_payload(db, event_data), "close_opportunities"

    # Call activities — every variant carries the full call object in `data`.
    # Includes .answered / .completed so secondary lifecycle events refresh
    # `status` / `duration` columns without missing an update.
    if event_type in (
        "activity.call.created",
        "activity.call.updated",
        "activity.call.answered",
        "activity.call.completed",
    ):
        return upsert_call_from_payload(db, event_data), "close_calls"

    # SMS activities.
    if event_type in (
        "activity.sms.created",
        "activity.sms.updated",
        "activity.sms.sent",
    ):
        return upsert_sms_from_payload(db, event_data), "close_sms"

    # Lead status changes — the funnel-spine event stream.
    if event_type in (
        "activity.lead_status_change.created",
        "activity.lead_status_change.updated",
    ):
        return upsert_lead_status_change_from_payload(db, event_data), "close_lead_status_changes"

    # Unknown / unrouted. Audit-row already exists; log so we can decide
    # later whether to start routing it. Drake's principle: "mirror
    # everything Close sends"; receiver-side observability is the first
    # step toward that.
    logger.info(
        "close_webhook: unrouted event_type=%s — audit row written, no upsert",
        event_type,
    )
    return None, f"unknown:{event_type}"


# ---------------------------------------------------------------------------
# Live setter-call transcription trigger
# ---------------------------------------------------------------------------


def _maybe_transcribe(db: Any, close_call_id: str) -> dict[str, Any]:
    """Fire Deepgram transcription if this call is eligible.

    Returns a small metadata dict describing what happened — surfaced
    in the webhook response body for observability without leaking
    transcript content.

    Failure modes, in order of likelihood:
      1. EligibilityError — call doesn't meet criteria yet (no
         recording uploaded, <90s, expired). Silent skip; Close will
         fire activity.call.updated later when state changes.
      2. RecordingFetchError — Close's `/recording/` endpoint didn't
         hand us an S3 URL. Logged + skipped; cron sweep retries.
      3. DeepgramError — Deepgram API failure. Logged + skipped;
         cron sweep retries.
      4. Unexpected — caught + logged so the webhook still 200s. The
         cron sweep is the safety net here.
    """
    try:
        row = transcribe_call(close_call_id, db=db)
        # row may be a freshly-transcribed result OR the cached row
        # transcribe_call returns when one already exists (it's
        # idempotent on close_call_id). We don't try to distinguish in
        # the response — the logger.info inside transcribe_call already
        # emits `setter_calls.skip_existing` vs `setter_calls.persisted`
        # so audit visibility is preserved.
        logger.info(
            "close_webhook.setter_call_ok close_id=%s duration_s=%s",
            close_call_id, row.get("duration_s"),
        )
        return {"attempted": True, "status": "ok"}
    except EligibilityError as e:
        # Expected steady-state: most call activity events are for
        # calls that don't qualify (short, no-answer, no recording yet).
        # INFO not WARN — this is not an error.
        logger.info(
            "close_webhook.setter_call_skip close_id=%s reason=%s",
            close_call_id, e,
        )
        return {"attempted": True, "status": "ineligible", "reason": str(e)[:200]}
    except (RecordingFetchError, DeepgramError) as e:
        logger.warning(
            "close_webhook.setter_call_failed close_id=%s err=%s",
            close_call_id, e,
        )
        return {"attempted": True, "status": "failed", "error": str(e)[:200]}
    except Exception as exc:  # pragma: no cover — defensive
        logger.exception(
            "close_webhook.setter_call_unexpected close_id=%s",
            close_call_id,
        )
        return {"attempted": True, "status": "unexpected_error", "error": str(exc)[:200]}


# ---------------------------------------------------------------------------
# webhook_deliveries row lifecycle helpers (same shape as fathom_events)
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


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------


def _sanitize_headers(headers: Any) -> dict[str, str]:
    out: dict[str, str] = {}
    for key in _HEADERS_TO_STORE:
        val = headers.get(key)
        if val is not None:
            out[key] = str(val)
    return out


def _sanitize_traceback(tb: str) -> str:
    """Trim the traceback before persisting; strip lines that mention
    common secret shapes as a belt-and-suspenders measure."""
    if not tb:
        return ""
    lines = tb.splitlines()
    filtered = [
        line for line in lines
        if "whsec_" not in line
        and "sk-" not in line
        and "eyJh" not in line
        and "CLOSE_WEBHOOK_SECRET" not in line
    ]
    return "\n".join(filtered)[:_MAX_ERROR_CHARS]
