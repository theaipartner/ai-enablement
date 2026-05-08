"""Airtable NPS webhook endpoint.

Deployed by Vercel as a serverless Python function at
`/api/airtable_nps_webhook`. Make.com fires deliveries here when an
Airtable NPS Survey row is classified into a segment. The receiver is a
thin adapter — validate auth, normalize the segment string, hand off to
`update_client_from_nps_segment` (migration 0021) which does the work.

Full architecture: docs/agents/gregory.md § "Airtable NPS integration".

Sync flow (matches the api/fathom_events.py pattern):

  1. Validate AIRTABLE_NPS_WEBHOOK_SECRET env var is set.
     Missing → 500 (deploy misconfiguration). Fail loud BEFORE the
     header check so a missing env var doesn't masquerade as a 401.

  2. Validate X-Webhook-Secret header via hmac.compare_digest
     (constant-time). Missing or mismatch → 401, no DB write —
     same gate-before-DB pattern as Fathom's signature check.

  3. Read body bytes, parse JSON.
     Malformed JSON → 400 + webhook_deliveries row marked 'malformed'.

  4. Validate required payload fields (client_email, segment) —
     non-null, string-typed, non-empty after strip.
     Missing/wrong → 400 + 'malformed'.

  5. Normalize segment string: strip + lowercase, match against the
     three known Airtable forms. Unrecognized → 400 + 'malformed'.

  6. Generate webhook_id = "airtable_nps_<uuid4>". Insert
     webhook_deliveries row (status='received'). The prefixed UUID
     keeps the source visible when scanning the table by id alone.

  7. Call update_client_from_nps_segment(email, normalized_segment).
     RPC raises 'no active client matches email %' → 404 + 'failed'.
     RPC raises any other PostgrestAPIError → 500 + 'failed'.

  8. Mark webhook_deliveries row 'processed', return 200 with the
     structured response body documented below.

Env vars required (set in Vercel Production scope, NOT committed):

  AIRTABLE_NPS_WEBHOOK_SECRET   — shared secret with Make.com
  SUPABASE_URL                  — shared.db
  SUPABASE_SERVICE_ROLE_KEY     — shared.db

Payload shape (from Make.com):

  {
    "client_email": "...",          # required, non-empty string
    "segment": "...",               # required, one of the 3 known forms
    "airtable_record_id": "rec...", # optional, stored on webhook_deliveries
    "submitted_at": "ISO8601"       # optional, payload-only (not used today)
  }

Response shape (200 OK):

  {
    "status": "ok",
    "delivery_id": "airtable_nps_<uuid4>",
    "client_id": "<uuid>",
    "nps_standing": "<promoter|neutral|at_risk>",
    "csm_standing": "<happy|content|at_risk|problem|null>",
    "auto_derive_applied": true|false
  }

NOTE on `auto_derive_applied`: as of migration 0027 (NPS-is-gospel),
the RPC always auto-derives csm_standing from the segment on every
valid call — there's no override-sticky branch to potentially skip
the auto-write. The boolean is therefore always `true` on the 200
success path; preserved in the response shape because Make.com
consumers may rely on the field. Source of truth for actual writes
remains `client_standing_history.changed_by` — Gregory Bot UUID on
the most recent row indicates the auto-derive wrote that history
row. (The override-sticky semantics this flag was ambiguous about
were retired in 0027.)
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import traceback
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from typing import Any

from shared.db import get_client


# Vercel's Python runtime defaults the root logger to WARNING; INFO is
# what we want for operational lines. Same workaround as
# api/fathom_events.py and api/slack_events.py.
logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.airtable_nps_webhook")
logger.setLevel(logging.INFO)


# Cap for stored error strings on webhook_deliveries.processing_error.
_MAX_ERROR_CHARS = 2000

# Headers preserved in webhook_deliveries.headers. X-Webhook-Secret is
# the auth header — NEVER stored. Airtable / Make.com don't send a
# user-agent we particularly need, but capturing it costs nothing and
# helps diagnose "is this even Make.com calling us" forensically.
_HEADERS_TO_STORE = frozenset({
    "content-type",
    "content-length",
    "user-agent",
})

# Airtable raw segment string → normalized DB value. Keys are
# lowercase; we lowercase + strip the input before lookup so
# "Strong / Promoter", "STRONG / PROMOTER", " strong / promoter " all
# match. Defensive against future Airtable formula tweaks that might
# alter capitalization or padding.
_SEGMENT_NORMALIZATION: dict[str, str] = {
    "strong / promoter": "promoter",
    "neutral": "neutral",
    "at risk": "at_risk",
}

# Canonical user-facing forms — what Airtable actually emits, surfaced
# in the invalid_segment error response so Make.com configurators see
# the strings to send rather than the lowercased internal lookup keys.
_ACCEPTED_SEGMENT_DISPLAY: list[str] = [
    "Strong / Promoter",
    "Neutral",
    "At Risk",
]

# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------


class handler(BaseHTTPRequestHandler):
    """Vercel's Python runtime instantiates this per request."""

    def do_POST(self) -> None:
        try:
            self._handle_post()
        except Exception as exc:  # last-resort safety net
            logger.exception(
                "airtable_nps_webhook: unhandled top-level error: %s", exc
            )
            self._respond(500, {"error": "internal_error"})

    def do_GET(self) -> None:
        # Friendly hint for browser / uptime-check hits + post-deploy
        # smoke verification. Same shape as api/fathom_events.py and
        # api/slack_events.py.
        self._respond(
            200,
            {
                "status": "ok",
                "endpoint": "airtable_nps_webhook",
                "accepts": "POST",
            },
        )

    # ------------------------------------------------------------------
    # Main flow
    # ------------------------------------------------------------------

    def _handle_post(self) -> None:
        # 1. Misconfiguration check FIRST. A missing env var is our bug,
        #    not the caller's; surface as 500 not 401.
        secret = os.environ.get("AIRTABLE_NPS_WEBHOOK_SECRET")
        if not secret:
            logger.error(
                "airtable_nps_webhook: AIRTABLE_NPS_WEBHOOK_SECRET not configured"
            )
            self._respond(500, {"error": "misconfigured"})
            return

        # 2. Auth gate. Compare via hmac.compare_digest for constant time.
        provided = self.headers.get("X-Webhook-Secret", "") or ""
        if not provided or not hmac.compare_digest(provided, secret):
            logger.warning(
                "airtable_nps_webhook: unauthorized — header_present=%s",
                bool(provided),
            )
            self._respond(401, {"error": "unauthorized"})
            return

        # From here on every exit path writes a webhook_deliveries row.
        body = self._read_body()
        delivery_id = f"airtable_nps_{uuid.uuid4()}"
        sanitized_headers = _sanitize_headers(self.headers)

        # 3. Parse JSON. On failure we still write a webhook_deliveries
        #    row marked 'malformed' so the audit trail captures bad input.
        try:
            payload = json.loads(body.decode("utf-8")) if body else None
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            logger.warning(
                "airtable_nps_webhook: body not valid JSON: %s", exc
            )
            _insert_delivery(
                delivery_id,
                payload=None,
                headers=sanitized_headers,
                airtable_record_id=None,
                status="malformed",
                error=f"invalid_json: {exc}",
            )
            self._respond(400, {"error": "invalid_json"})
            return

        if not isinstance(payload, dict):
            logger.warning(
                "airtable_nps_webhook: body not a JSON object (got %s)",
                type(payload).__name__,
            )
            _insert_delivery(
                delivery_id,
                payload=payload,
                headers=sanitized_headers,
                airtable_record_id=None,
                status="malformed",
                error="payload_not_object",
            )
            self._respond(400, {"error": "payload_not_object"})
            return

        airtable_record_id = payload.get("airtable_record_id")
        if airtable_record_id is not None and not isinstance(
            airtable_record_id, str
        ):
            airtable_record_id = None

        # 4 + 5. Validate required fields. Build a single error message
        # listing all problems for easier debugging by Make.com side.
        validation_error = _validate_payload(payload)
        if validation_error is not None:
            error_code, detail = validation_error
            logger.warning(
                "airtable_nps_webhook: %s — %s", error_code, detail
            )
            _insert_delivery(
                delivery_id,
                payload=payload,
                headers=sanitized_headers,
                airtable_record_id=airtable_record_id,
                status="malformed",
                error=f"{error_code}: {detail}",
            )
            self._respond(
                400,
                {"error": error_code, "detail": detail}
                | (
                    {"accepted": _ACCEPTED_SEGMENT_DISPLAY}
                    if error_code == "invalid_segment"
                    else {}
                ),
            )
            return

        client_email = payload["client_email"].strip()
        normalized_segment = _SEGMENT_NORMALIZATION[
            payload["segment"].strip().lower()
        ]

        # 6. Insert the 'received' delivery row.
        _insert_delivery(
            delivery_id,
            payload=payload,
            headers=sanitized_headers,
            airtable_record_id=airtable_record_id,
            status="received",
            error=None,
        )

        # 7. Call the RPC.
        db = get_client()
        try:
            rpc_resp = db.rpc(
                "update_client_from_nps_segment",
                {
                    "p_client_email": client_email,
                    "p_segment": normalized_segment,
                },
            ).execute()
        except Exception as exc:
            error_message = str(exc)
            tb = _sanitize_traceback(traceback.format_exc())

            # Substring match on the RPC's RAISE EXCEPTION message.
            # Brittle by design — if the RPC's error text changes, the
            # test harness will catch the regression. Alternative
            # (structured error codes) is over-engineering for one path.
            if "no active client matches email" in error_message:
                logger.warning(
                    "airtable_nps_webhook: no client match — email=%s "
                    "delivery_id=%s",
                    _redact_email(client_email),
                    delivery_id,
                )
                _mark_delivery(
                    delivery_id,
                    status="failed",
                    error=error_message[:_MAX_ERROR_CHARS],
                )
                self._respond(
                    404,
                    {"error": "client_not_found", "email": client_email},
                )
                return

            logger.exception(
                "airtable_nps_webhook: RPC raised — delivery_id=%s",
                delivery_id,
            )
            _mark_delivery(
                delivery_id, status="failed", error=tb
            )
            self._respond(500, {"error": "rpc_failed"})
            return

        # 8. Success. Build the response from the returned clients row.
        returned = rpc_resp.data
        if not returned:
            logger.error(
                "airtable_nps_webhook: RPC returned no data — "
                "delivery_id=%s email=%s",
                delivery_id,
                _redact_email(client_email),
            )
            _mark_delivery(
                delivery_id,
                status="failed",
                error="rpc_returned_no_data",
            )
            self._respond(500, {"error": "rpc_returned_no_data"})
            return

        client_row = returned[0] if isinstance(returned, list) else returned
        client_id = client_row.get("id")
        nps_standing = client_row.get("nps_standing")
        csm_standing = client_row.get("csm_standing")

        # auto_derive_applied: post-0027 (NPS-is-gospel), the RPC
        # always auto-derives csm_standing from the segment on every
        # valid call. Always true on the 200 path. Preserved for
        # response-shape stability — see module docstring.
        auto_derive_applied = True

        _mark_delivery(
            delivery_id,
            status="processed",
            error=None,
            call_external_id_override=None,  # already set on insert
        )

        logger.info(
            "airtable_nps_webhook: processed delivery_id=%s client_id=%s "
            "segment=%s csm_standing=%s auto_derive_applied=%s",
            delivery_id,
            client_id,
            normalized_segment,
            csm_standing,
            auto_derive_applied,
        )

        self._respond(
            200,
            {
                "status": "ok",
                "delivery_id": delivery_id,
                "client_id": client_id,
                "nps_standing": nps_standing,
                "csm_standing": csm_standing,
                "auto_derive_applied": auto_derive_applied,
            },
        )

    # ------------------------------------------------------------------
    # HTTP helpers (mirror api/fathom_events.py)
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
# Validation
# ---------------------------------------------------------------------------


def _validate_payload(
    payload: dict[str, Any],
) -> tuple[str, str] | None:
    """Validate required fields. Returns (error_code, detail) on
    failure or None on success. Checks type AND non-empty-after-strip
    for both required fields, then segment-vocab membership."""
    client_email = payload.get("client_email")
    segment = payload.get("segment")

    if client_email is None:
        return ("missing_field", "client_email is required")
    if not isinstance(client_email, str):
        return (
            "wrong_type",
            f"client_email must be a string, got {type(client_email).__name__}",
        )
    if not client_email.strip():
        return ("missing_field", "client_email cannot be empty")

    if segment is None:
        return ("missing_field", "segment is required")
    if not isinstance(segment, str):
        return (
            "wrong_type",
            f"segment must be a string, got {type(segment).__name__}",
        )
    if not segment.strip():
        return ("missing_field", "segment cannot be empty")

    if segment.strip().lower() not in _SEGMENT_NORMALIZATION:
        return ("invalid_segment", f"unknown segment value {segment!r}")

    return None


# ---------------------------------------------------------------------------
# webhook_deliveries lifecycle helpers
# ---------------------------------------------------------------------------


def _insert_delivery(
    delivery_id: str,
    *,
    payload: Any,
    headers: dict[str, str],
    airtable_record_id: str | None,
    status: str,
    error: str | None,
) -> None:
    """Insert the initial delivery row. Status can be 'received' (happy
    path will UPDATE later) or 'malformed' (terminal, no UPDATE).
    Stores airtable_record_id on call_external_id (per the M5.4 receiver
    spec — column is generic text + already partial-indexed; minor
    naming cross-purpose accepted in exchange for free queryability)."""
    db = get_client()
    row: dict[str, Any] = {
        "webhook_id": delivery_id,
        "source": "airtable_nps_webhook",
        "processing_status": status,
        "payload": payload,
        "headers": headers,
        "call_external_id": airtable_record_id,
    }
    if error is not None:
        row["processing_error"] = error[:_MAX_ERROR_CHARS]
    if status != "received":
        row["processed_at"] = datetime.now(timezone.utc).isoformat()
    db.table("webhook_deliveries").insert(row).execute()


def _mark_delivery(
    delivery_id: str,
    *,
    status: str,
    error: str | None,
    call_external_id_override: str | None = None,
) -> None:
    """UPDATE a previously-inserted delivery row to a terminal status."""
    db = get_client()
    update: dict[str, Any] = {
        "processing_status": status,
        "processed_at": datetime.now(timezone.utc).isoformat(),
    }
    if error is not None:
        update["processing_error"] = error[:_MAX_ERROR_CHARS]
    if call_external_id_override is not None:
        update["call_external_id"] = call_external_id_override
    db.table("webhook_deliveries").update(update).eq(
        "webhook_id", delivery_id
    ).execute()


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------


def _sanitize_headers(headers: Any) -> dict[str, str]:
    """Preserve only the safe debugging headers. X-Webhook-Secret is
    NEVER included. Lower-case the keys for predictable querying."""
    out: dict[str, str] = {}
    for key in _HEADERS_TO_STORE:
        val = headers.get(key)
        if val is not None:
            out[key] = str(val)
    return out


def _sanitize_traceback(tb: str) -> str:
    """Trim the traceback before persisting to the DB. Filters out lines
    containing common secret prefixes (whsec_, sk-, eyJh) — belt-and-
    suspenders; the receiver shouldn't log secrets to begin with."""
    if not tb:
        return ""
    lines = tb.splitlines()
    filtered = [
        line
        for line in lines
        if "whsec_" not in line and "sk-" not in line and "eyJh" not in line
    ]
    return "\n".join(filtered)[:_MAX_ERROR_CHARS]


def _redact_email(email: str) -> str:
    """For logs: keep enough to identify the right pattern but not the
    full address. 'foo@bar.com' → 'f***@bar.com'."""
    if "@" not in email:
        return "***"
    local, _, domain = email.partition("@")
    if not local:
        return f"***@{domain}"
    return f"{local[0]}***@{domain}"
