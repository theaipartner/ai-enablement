"""Airtable webhook endpoint — pull-payload model with cursor persistence.

Deployed by Vercel as a serverless Python function at `/api/airtable_events`.
Airtable POSTs a notification ping here whenever the base changes; the
ping body does NOT contain record data. The receiver:

  1. Verifies the ping's MAC against AIRTABLE_WEBHOOK_MAC_SECRET (the
     `macSecretBase64` returned by `register_airtable_webhook.py` at
     subscription creation).
  2. Reads the persisted cursor from webhook_deliveries
     (source='airtable_webhook_cursor', single sentinel row per
     webhook_id).
  3. Calls `GET /v0/bases/{baseId}/webhooks/{id}/payloads?cursor=<n>` to
     fetch every payload since the cursor, looping while `mightHaveMore`.
  4. For each payload, extracts `changedTablesById` → maps to our target
     tables → for each changed record fetches its current state via
     `client.get_record()` and upserts.
  5. Advances + persists the cursor on success.
  6. Audits one row per ping (source='airtable_webhook',
     dedup-keyed on synthesized notification id).
  7. Returns 2xx. On handler exception: marks audit `failed`, STILL
     returns 200 (Airtable doesn't auto-disable like Typeform, but
     the same fail-soft principle applies).

The CRITICAL design fact: NEITHER target Airtable table has a stored
timestamp field, so the cron backstop cannot reconcile edits — only
this webhook can. Cursor durability matters: a lost cursor + missed
ping = silently dropped edits.

Env vars (set in Vercel — NOT committed):
  AIRTABLE_WEBHOOK_MAC_SECRET  — base64; returned once at subscription
                                  creation (gate d). Used to verify the
                                  ping MAC.
  AIRTABLE_WEBHOOK_ID          — Airtable webhook id (achXXX) returned at
                                  subscription creation; identifies which
                                  webhook to fetch payloads from. Single
                                  webhook covers all 3 target tables on
                                  this base.
  AIRTABLE_SALES_PAT           — PAT with data.records:read for the
                                  records fetch (and the payloads pull).
  SUPABASE_URL                 — shared.db
  SUPABASE_SERVICE_ROLE_KEY    — shared.db
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

from ingestion.airtable import (  # noqa: E402
    AUDIT_SOURCE_WEBHOOK,
    TARGET_TABLES,
)
from ingestion.airtable.client import AirtableAPIError, AirtableClient  # noqa: E402
from ingestion.airtable.pipeline import (  # noqa: E402
    SyncOutcome,
    upsert_changed_records,
)
from shared.db import get_client  # noqa: E402


logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.airtable_webhook")
logger.setLevel(logging.INFO)


_MAX_ERROR_CHARS = 2000

# Cursor sentinel — one row per Airtable webhook id, persisted in
# webhook_deliveries. The webhook_id column carries the sentinel key;
# the cursor value lives in payload.cursor. Single-row, last-write-wins.
_CURSOR_SOURCE = "airtable_webhook_cursor"

# Notification headers we preserve for forensic audit. The MAC header
# itself is NOT stored (it's a signature; not useful post-verification).
_HEADERS_TO_STORE = frozenset({
    "content-type",
    "content-length",
    "user-agent",
})


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        try:
            self._handle_post()
        except Exception as exc:  # pragma: no cover — last-resort safety
            logger.exception(
                "airtable_webhook: unhandled top-level: %s", exc,
            )
            self._respond(200, {"status": "error_swallowed"})

    def do_GET(self) -> None:
        self._respond(
            200,
            {"status": "ok", "endpoint": "airtable_events", "accepts": "POST"},
        )

    def _handle_post(self) -> None:
        body = self._read_body()

        mac_secret_b64 = os.environ.get("AIRTABLE_WEBHOOK_MAC_SECRET")
        if not mac_secret_b64:
            logger.error("airtable_webhook: AIRTABLE_WEBHOOK_MAC_SECRET not configured")
            self._respond(500, {"error": "misconfigured"})
            return

        webhook_id = os.environ.get("AIRTABLE_WEBHOOK_ID")
        if not webhook_id:
            logger.error("airtable_webhook: AIRTABLE_WEBHOOK_ID not configured")
            self._respond(500, {"error": "misconfigured"})
            return

        # Airtable's MAC header — verify against the body BEFORE parsing
        # JSON, so a hostile body can't influence parsing.
        sig_header = (
            self.headers.get("X-Airtable-Content-MAC")
            or self.headers.get("x-airtable-content-mac")
            or ""
        )
        if not _verify_mac(body, sig_header, mac_secret_b64):
            logger.warning(
                "airtable_webhook: MAC verification failed sig_prefix=%s",
                sig_header[:16],
            )
            self._respond(401, {"error": "signature_invalid"})
            return

        # Parse the notification ping. Body is small JSON:
        #   {"base": {"id": "appXXX"}, "webhook": {"id": "achXXX"}, "timestamp": "..."}
        try:
            ping = json.loads(body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            logger.warning("airtable_webhook: ping body not valid JSON: %s", exc)
            self._respond(400, {"error": "invalid_json"})
            return

        ping_webhook_id = (ping.get("webhook") or {}).get("id") or ""
        ping_timestamp = ping.get("timestamp") or ""

        # Defense: a ping for a different webhook should not happen
        # (Vercel routes by URL, and one URL = one webhook in our
        # setup). But guard anyway — if the env var and ping disagree,
        # the env var wins (since that's what we'll pull payloads from).
        if ping_webhook_id and ping_webhook_id != webhook_id:
            logger.warning(
                "airtable_webhook: ping webhook_id=%s != AIRTABLE_WEBHOOK_ID=%s — using env",
                ping_webhook_id, webhook_id,
            )

        # Synthesize a stable notification key for dedup. Airtable's
        # ping doesn't carry a per-notification id, so we use
        # (webhook_id, timestamp, body_hash[:16]) to dedupe rapid-
        # fire pings without re-pulling payloads.
        body_hash = hashlib.sha256(body).hexdigest()[:16]
        notification_id = f"airtable:{webhook_id}:{ping_timestamp}:{body_hash}"

        db = get_client()
        sanitized_headers = _sanitize_headers(self.headers)

        # Audit-first upsert. Duplicate → fast 200, no payload pull.
        insert_resp = (
            db.table("webhook_deliveries")
            .upsert(
                {
                    "webhook_id": notification_id,
                    "source": AUDIT_SOURCE_WEBHOOK,
                    "processing_status": "received",
                    "call_external_id": webhook_id,
                    "payload": ping,
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
                "airtable_webhook: duplicate ping notification=%s",
                notification_id[:48],
            )
            self._respond(200, {"deduplicated": True})
            return

        # Pull + process payloads. Fail-soft.
        try:
            client = AirtableClient.from_env()
            outcome, new_cursor, payload_count = _pull_and_process_payloads(
                client, db, webhook_id,
            )
        except Exception as exc:
            tb = _sanitize_traceback(traceback.format_exc())
            logger.exception(
                "airtable_webhook: payload pull/process raised: %s", exc,
            )
            _mark_failed(db, notification_id, tb)
            self._respond(200, {"status": "logged_and_failed"})
            return

        _mark_processed(
            db,
            notification_id,
            external_id=webhook_id,
            extra_payload={
                "payload_count": payload_count,
                "records_upserted": outcome.records_upserted,
                "records_failed": outcome.records_failed,
                "parse_failures": outcome.parse_failures,
                "new_cursor": new_cursor,
                "errors": outcome.errors[:10],  # cap to keep audit row sane
            },
        )
        logger.info(
            "airtable_webhook: processed notification=%s payloads=%d "
            "upserted=%d failed=%d new_cursor=%d",
            notification_id[:48], payload_count,
            outcome.records_upserted, outcome.records_failed, new_cursor,
        )

        # Live re-tag of the leads whose forms just changed (the lead_ids the
        # pulled records already carry — no new fetch). Forms drive booked/
        # confirmed/showed/closed/dq, so this is the most important live path.
        # Fail-soft: never affect the webhook ack.
        if outcome.touched_lead_ids:
            try:
                from shared.lead_tagging import retag

                retag(lead_ids=list(outcome.touched_lead_ids), trigger="webhook:airtable")
            except Exception as exc:  # noqa: BLE001 — fail-soft by design
                logger.warning("airtable_webhook: lead retag failed: %s", exc)
        self._respond(
            200,
            {
                "delivered": True,
                "payloads_processed": payload_count,
                "records_upserted": outcome.records_upserted,
                "new_cursor": new_cursor,
            },
        )

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
# MAC verification — Airtable's scheme
# ---------------------------------------------------------------------------


def _verify_mac(body: bytes, sig_header: str, mac_secret_b64: str) -> bool:
    """Airtable signs notification pings with:

        digest = HMAC-SHA256(raw_body, base64_decode(macSecretBase64))
        header = `X-Airtable-Content-MAC: hmac-sha256=<HEX(digest)>`

    Verified against the Web API webhooks-overview docs 2026-05-24:
    Airtable's reference implementation uses `hmac.digest('hex')`,
    NOT base64. The `macSecretBase64` returned at webhook creation
    IS base64 — that's just the wire format for transporting the key
    bytes; it must be base64-decoded BEFORE use as the HMAC key.

    History note (2026-05-24): the original implementation base64-
    encoded the digest, which silently rejected every real Airtable
    ping (cursor advanced to 21 with 20+ queued payloads, all 401'd).
    Fixed to hex in `airtable-webhook-mac-fix`.

    Constant-time compare via `hmac.compare_digest`.
    """
    if not (sig_header and mac_secret_b64):
        return False

    presented = sig_header
    if presented.startswith("hmac-sha256="):
        presented = presented[len("hmac-sha256="):]

    try:
        secret_bytes = base64.b64decode(mac_secret_b64)
    except Exception:
        logger.error("airtable_webhook: macSecretBase64 not valid base64")
        return False

    expected = hmac.new(secret_bytes, body, hashlib.sha256).hexdigest()
    # Lowercase both sides — Airtable's hex is lowercase per
    # `hmac.digest('hex')` semantics, but normalize defensively against
    # a future case-flip on either side.
    return hmac.compare_digest(presented.lower(), expected.lower())


# ---------------------------------------------------------------------------
# Payload pull + process loop
# ---------------------------------------------------------------------------


def _pull_and_process_payloads(
    client: AirtableClient,
    db,
    webhook_id: str,
) -> tuple[SyncOutcome, int, int]:
    """Loop GET /payloads from the persisted cursor until exhausted,
    extract changed (table, record) pairs, dispatch to the pipeline.

    Returns (outcome, new_cursor, payload_count).
    """
    cursor = _load_cursor(db, webhook_id)
    outcome = SyncOutcome()
    payload_count = 0
    safety_max_loops = 50  # guards against a runaway payloads endpoint

    while safety_max_loops > 0:
        safety_max_loops -= 1
        resp = client.get_webhook_payloads(webhook_id, cursor=cursor)
        payloads = resp.get("payloads") or []
        for p in payloads:
            payload_count += 1
            changes = _extract_changes(p)
            if changes:
                upsert_changed_records(client, db, changes, outcome=outcome)
        next_cursor = resp.get("cursor")
        might_have_more = bool(resp.get("mightHaveMore"))
        if isinstance(next_cursor, int):
            cursor = next_cursor
        if not might_have_more:
            break

    _save_cursor(db, webhook_id, cursor)
    return outcome, cursor, payload_count


def _extract_changes(payload: dict[str, Any]) -> dict[str, set[str]]:
    """Extract `{table_id: {record_id, ...}}` from one webhook payload.

    Airtable payload shape includes `changedTablesById` keyed by
    Airtable table id; each entry has `changedRecordsById` and
    `createdRecordsById` (and `destroyedRecordIds` for deletes — we
    ignore deletes for now; soft-delete on the mirror would be a
    future feature).

    Filters to TARGET_TABLES — changes outside our scope are dropped
    silently (other tables in the base could be in the same webhook
    spec; we just don't mirror them)."""
    out: dict[str, set[str]] = {}
    changed_by_table = payload.get("changedTablesById") or {}
    for table_id, table_change in changed_by_table.items():
        if table_id not in TARGET_TABLES:
            continue
        record_ids: set[str] = set()
        for source_key in ("changedRecordsById", "createdRecordsById"):
            for rid in (table_change.get(source_key) or {}).keys():
                record_ids.add(rid)
        if record_ids:
            out.setdefault(table_id, set()).update(record_ids)
    return out


# ---------------------------------------------------------------------------
# Cursor persistence — single sentinel row per webhook_id in
# webhook_deliveries. source='airtable_webhook_cursor'.
# ---------------------------------------------------------------------------


def _cursor_row_key(webhook_id: str) -> str:
    return f"airtable_webhook_cursor:{webhook_id}"


def _load_cursor(db, webhook_id: str) -> int:
    """Read the persisted cursor, default 1 on first-ever call (Airtable's
    cursors are 1-indexed). Defensive against malformed payloads."""
    try:
        resp = (
            db.table("webhook_deliveries")
            .select("payload")
            .eq("webhook_id", _cursor_row_key(webhook_id))
            .limit(1)
            .execute()
        )
    except Exception as e:
        logger.warning("airtable_webhook: cursor load failed: %s", e)
        return 1
    rows = resp.data or []
    if not rows:
        return 1
    payload = rows[0].get("payload") or {}
    cursor = payload.get("cursor")
    if isinstance(cursor, int) and cursor >= 1:
        return cursor
    return 1


def _save_cursor(db, webhook_id: str, cursor: int) -> None:
    """Upsert the cursor sentinel row last-write-wins."""
    try:
        db.table("webhook_deliveries").upsert(
            {
                "webhook_id": _cursor_row_key(webhook_id),
                "source": _CURSOR_SOURCE,
                "processing_status": "processed",
                "processing_error": "cursor_state",
                "payload": {"cursor": cursor, "webhook_id": webhook_id},
                "headers": {},
                "processed_at": datetime.now(timezone.utc).isoformat(),
            },
            on_conflict="webhook_id",
        ).execute()
    except Exception as e:
        # Surface — a missed cursor save means we'll re-pull the same
        # payloads next ping (idempotent at the record level, just
        # wasted budget).
        logger.warning("airtable_webhook: cursor save failed: %s", e)


# ---------------------------------------------------------------------------
# webhook_deliveries row lifecycle
# ---------------------------------------------------------------------------


def _mark_failed(db, notification_id: str, traceback_text: str) -> None:
    db.table("webhook_deliveries").update(
        {
            "processing_status": "failed",
            "processing_error": traceback_text[:_MAX_ERROR_CHARS],
            "processed_at": datetime.now(timezone.utc).isoformat(),
        }
    ).eq("webhook_id", notification_id).execute()


def _mark_processed(
    db,
    notification_id: str,
    *,
    external_id: str | None,
    extra_payload: dict[str, Any] | None = None,
) -> None:
    update: dict[str, Any] = {
        "processing_status": "processed",
        "processed_at": datetime.now(timezone.utc).isoformat(),
    }
    if external_id:
        update["call_external_id"] = external_id
    if extra_payload is not None:
        # Merge with the existing ping payload — read current then write.
        try:
            current = (
                db.table("webhook_deliveries")
                .select("payload")
                .eq("webhook_id", notification_id)
                .limit(1)
                .execute()
            )
            if current.data:
                merged = dict(current.data[0].get("payload") or {})
                merged["processing_summary"] = extra_payload
                update["payload"] = merged
        except Exception as e:
            logger.warning(
                "airtable_webhook: payload merge for %s failed: %s",
                notification_id[:48], e,
            )
    db.table("webhook_deliveries").update(update).eq(
        "webhook_id", notification_id,
    ).execute()


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
    if not tb:
        return ""
    lines = tb.splitlines()
    filtered = [
        line for line in lines
        if "AIRTABLE_SALES_PAT" not in line
        and "AIRTABLE_WEBHOOK_MAC_SECRET" not in line
        and "Bearer " not in line
        and "patXC" not in line  # PAT prefix
    ]
    return "\n".join(filtered)[:_MAX_ERROR_CHARS]
