"""GHL ingestion orchestrator — backfill + incremental.

Idempotent upserts keyed on GHL's stable ids; re-running never duplicates. Fail-
soft per record — one bad contact/message doesn't kill the run.

Entry points:
  - sync_contacts(client, db, outcome, max_pages=None)
  - sync_conversations_and_messages(client, db, outcome, full=False, ...)
  - run_sync(client, db, full=False) — the cron's one call (contacts, then convos
    + their messages incrementally)

Incremental model: contacts are cheap (~1.2k) so we upsert every one each run.
Conversation message pulls are the expensive part (one request per conversation),
so we only re-pull a conversation's messages when its last_message_date is newer
than the stored messages_synced_at watermark (or it's new / `full=True`).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from urllib.parse import unquote

from ingestion.ghl.client import GHLAPIError, GHLClient
from shared.logging import logger

# Matches the Airtable closer-form "Lead ID" prefilled into the "EOC From" custom
# field value, e.g. ...?prefill_Lead%20ID=MFMWbEpWVQ5yfj90U8Iu&prefill_... — the
# closer-report join key. Tolerates both encoded (%20) and literal spaces.
_EOC_LEAD_ID_RE = re.compile(
    r"[?&]prefill_Lead(?:%20|\+|\s)?ID=([^&\s]+)", re.IGNORECASE
)


@dataclass
class SyncOutcome:
    """Summary of one sync run for the cron audit row."""

    contacts_synced: int = 0
    contacts_failed: int = 0
    conversations_synced: int = 0
    conversations_scanned_for_messages: int = 0
    messages_synced: int = 0
    messages_failed: int = 0
    errors: list[str] = field(default_factory=list)

    def record_error(self, where: str, err: Exception) -> None:
        self.errors.append(f"{where}: {err}")


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def _ts(value: Any) -> str | None:
    """Normalize a GHL timestamp to an ISO-8601 UTC string.

    GHL is inconsistent: contacts/messages use ISO strings ("2026-..Z"), while
    conversation list fields (lastMessageDate) use epoch milliseconds (int).
    """
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value / 1000.0, tz=timezone.utc).isoformat()
    return str(value)


def extract_eoc_lead_id(custom_fields: list[dict[str, Any]] | None) -> str | None:
    """Pull the Airtable closer-form Lead ID out of the contact's custom fields.

    Scans every custom-field value for the prefill_Lead ID query param (the value
    is the Airtable "EOC From" form URL). Field-id agnostic, so it survives a
    custom-field-id change across locations.
    """
    for cf in custom_fields or []:
        val = cf.get("value")
        if not isinstance(val, str) or "prefill_Lead" not in val:
            continue
        m = _EOC_LEAD_ID_RE.search(val)
        if m:
            return unquote(m.group(1)).strip() or None
    return None


def parse_contact(raw: dict[str, Any]) -> dict[str, Any]:
    cfs = raw.get("customFields") or []
    return {
        "id": raw.get("id"),
        "location_id": raw.get("locationId"),
        "source": raw.get("source"),
        "first_name": raw.get("firstName"),
        "last_name": raw.get("lastName"),
        "contact_name": raw.get("contactName"),
        "email": raw.get("email"),
        "phone": raw.get("phone"),
        "tags": raw.get("tags") or [],
        "assigned_to": raw.get("assignedTo"),
        "eoc_lead_id": extract_eoc_lead_id(cfs),
        "date_added": _ts(raw.get("dateAdded")),
        "date_updated": _ts(raw.get("dateUpdated")),
        "custom_fields": cfs,
        "raw": raw,
    }


def parse_conversation(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": raw.get("id"),
        "contact_id": raw.get("contactId"),
        "location_id": raw.get("locationId"),
        "type": raw.get("type"),
        "last_message_date": _ts(raw.get("lastMessageDate")),
        "last_message_type": raw.get("lastMessageType"),
        "date_added": _ts(raw.get("dateAdded")),
        "date_updated": _ts(raw.get("dateUpdated")),
        "raw": raw,
    }


def parse_message(raw: dict[str, Any]) -> dict[str, Any]:
    call = ((raw.get("meta") or {}).get("call")) or {}
    duration = call.get("duration")
    return {
        "id": raw.get("id"),
        "conversation_id": raw.get("conversationId"),
        "contact_id": raw.get("contactId"),
        "location_id": raw.get("locationId"),
        "message_type": raw.get("messageType"),
        "direction": raw.get("direction"),
        "status": raw.get("status"),
        "user_id": raw.get("userId"),
        "call_duration": int(duration) if isinstance(duration, (int, float)) else None,
        "call_status": call.get("status"),
        "body": raw.get("body"),
        "date_added": _ts(raw.get("dateAdded")),
        "raw": raw,
    }


# ---------------------------------------------------------------------------
# Sync
# ---------------------------------------------------------------------------


def sync_contacts(
    client: GHLClient, db, outcome: SyncOutcome, *, max_pages: int | None = None
) -> None:
    """Upsert every contact (idempotent on id)."""
    for raw in client.iter_contacts(max_pages=max_pages):
        row = parse_contact(raw)
        if not row.get("id"):
            continue
        try:
            db.table("ghl_contacts").upsert(row, on_conflict="id").execute()
            outcome.contacts_synced += 1
        except Exception as e:  # fail-soft per record
            outcome.contacts_failed += 1
            outcome.record_error(f"contact:{row.get('id')}", e)


def _stored_message_watermarks(db) -> dict[str, str]:
    """conversation_id -> messages_synced_at (ISO) for incremental decisions."""
    out: dict[str, str] = {}
    page = 0
    while True:
        resp = (
            db.table("ghl_conversations")
            .select("id, messages_synced_at")
            .range(page * 1000, page * 1000 + 999)
            .execute()
        )
        rows = resp.data or []
        for r in rows:
            if r.get("messages_synced_at"):
                out[r["id"]] = r["messages_synced_at"]
        if len(rows) < 1000:
            break
        page += 1
    return out


def sync_conversations_and_messages(
    client: GHLClient,
    db,
    outcome: SyncOutcome,
    *,
    full: bool = False,
    max_conv_pages: int | None = None,
) -> None:
    """Upsert conversations, then (re-)pull messages for changed/new conversations.

    A conversation's messages are re-pulled when `full`, when it has no stored
    watermark, or when last_message_date > messages_synced_at.
    """
    watermarks = {} if full else _stored_message_watermarks(db)

    for raw in client.iter_conversations(max_pages=max_conv_pages):
        conv = parse_conversation(raw)
        cid = conv.get("id")
        if not cid:
            continue
        try:
            db.table("ghl_conversations").upsert(conv, on_conflict="id").execute()
            outcome.conversations_synced += 1
        except Exception as e:
            outcome.record_error(f"conversation:{cid}", e)
            continue

        last_msg = conv.get("last_message_date")
        prev = watermarks.get(cid)
        needs_pull = full or prev is None or (last_msg is not None and last_msg > prev)
        if not needs_pull:
            continue

        outcome.conversations_scanned_for_messages += 1
        pulled_ok = True
        try:
            for mraw in client.iter_messages(cid):
                mrow = parse_message(mraw)
                if not mrow.get("id"):
                    continue
                try:
                    db.table("ghl_messages").upsert(mrow, on_conflict="id").execute()
                    outcome.messages_synced += 1
                except Exception as e:
                    outcome.messages_failed += 1
                    outcome.record_error(f"message:{mrow.get('id')}", e)
        except GHLAPIError as e:
            pulled_ok = False
            outcome.record_error(f"messages_fetch:{cid}", e)

        # Advance the watermark only if the message pull completed cleanly, so a
        # mid-pull failure re-pulls next run instead of silently skipping.
        if pulled_ok:
            try:
                db.table("ghl_conversations").update(
                    {"messages_synced_at": datetime.now(timezone.utc).isoformat()}
                ).eq("id", cid).execute()
            except Exception as e:
                outcome.record_error(f"watermark:{cid}", e)


def run_sync(client: GHLClient, db, *, full: bool = False) -> SyncOutcome:
    """One sync run: contacts, then conversations + their messages (incremental)."""
    outcome = SyncOutcome()
    try:
        sync_contacts(client, db, outcome)
    except GHLAPIError as e:
        outcome.record_error("contacts", e)
    try:
        sync_conversations_and_messages(client, db, outcome, full=full)
    except GHLAPIError as e:
        outcome.record_error("conversations", e)
    logger.info(
        "ghl.sync contacts=%d/%d convos=%d msg_pulls=%d messages=%d errors=%d full=%s",
        outcome.contacts_synced,
        outcome.contacts_synced + outcome.contacts_failed,
        outcome.conversations_synced,
        outcome.conversations_scanned_for_messages,
        outcome.messages_synced,
        len(outcome.errors),
        full,
    )
    return outcome
