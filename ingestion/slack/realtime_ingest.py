"""Realtime Slack `message` event ingestion (Ella V2 Batch 1).

Called from `api/slack_events.py` for every `event_callback` whose
inner event is `type='message'`. Mirrors the shape of the local
backfill (`ingestion.slack.pipeline.run_ingest`) so author resolution
and parsing stay consistent across paths, but is single-event rather
than per-channel.

Pipeline per event:
  1. Channel-allowlist gate. Look up `slack_channels` by
     `slack_channel_id`. Skip if no row, no `client_id`, or archived.
  2. Subtype gate. Skip ignorable subtypes from
     `parser._SYSTEM_SUBTYPES`.
  3. Parse via `parser.parse_message` with the freshly-fetched
     `client_user_ids` / `team_user_ids` sets and Ella's user_id.
  4. Upsert into `slack_messages` keyed on (channel, ts) — idempotent.
  5. Audit row in `webhook_deliveries` with `source='slack_message_ingest'`.
  6. Fail-soft: any exception is logged + recorded, never raised.

Audit-row contract (CRITICAL — migration 0011 CHECK only allows
`{'received','processed','failed','duplicate','malformed'}`):

  - Ingested:  status='processed', payload.content_source='ingested'
  - Skipped (non-client channel):
      status='processed', processing_error='skipped_non_client_channel',
      payload.skip_reason='non_client_channel'
  - Skipped (ignorable subtype):
      status='processed', processing_error='skipped_ignorable_subtype',
      payload.skip_reason='ignorable_subtype', payload.subtype=<...>
  - Exception path:
      status='failed', processing_error=<str(exc)[:2000]>

Debuggers query `payload.skip_reason` (or its absence) to disambiguate
"we processed and ingested" from "we processed and skipped".
"""

from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any

from ingestion.slack.parser import (
    SlackMessageRecord,
    _SYSTEM_SUBTYPES,
    parse_message,
)
from shared.slack_identity import get_user_id_for_token

logger = logging.getLogger("ai_enablement.slack_message_ingest")

_DELIVERY_SOURCE = "slack_message_ingest"
_CONTENT_SOURCE_INGESTED = "ingested"

# Skip-reason vocabulary. Pinned here so SQL queries
# `payload->>'skip_reason'` have a stable enum.
_SKIP_NON_CLIENT_CHANNEL = "non_client_channel"
_SKIP_IGNORABLE_SUBTYPE = "ignorable_subtype"

# Audit-row source label for the passive-monitor fork's exception path.
# Distinct from `_DELIVERY_SOURCE` so a failing passive branch doesn't
# muddy the ingest's own audit ledger — analytics can query the two
# sources separately.
_PASSIVE_MONITOR_ERROR_SOURCE = "ella_passive_monitor_error"


def ingest_message_event(payload: dict[str, Any]) -> dict[str, Any]:
    """Process one Slack `message` event. Returns a structured result
    dict for the caller to log; never raises.

    `payload` is the full Events API outer envelope (`{"type":
    "event_callback", "event": {...}, ...}`). Caller already ensured
    `payload['event']['type'] == 'message'`; we re-verify defensively.

    Returns:
        {
          "ingested": bool,
          "skipped_reason": str | None,   # 'non_client_channel' / 'ignorable_subtype' / 'exception'
          "delivery_id": str,
          "error": str | None,
          "slack_channel_id": str | None,
          "slack_ts": str | None,
        }
    """
    delivery_id = f"slack_msg_ingest_{uuid.uuid4()}"
    event = payload.get("event") or {}
    slack_channel_id = event.get("channel")
    slack_ts = event.get("ts")
    subtype = event.get("subtype")

    result: dict[str, Any] = {
        "ingested": False,
        "skipped_reason": None,
        "delivery_id": delivery_id,
        "error": None,
        "slack_channel_id": slack_channel_id,
        "slack_ts": slack_ts,
    }

    try:
        from shared.db import get_client

        db = get_client()

        # ----- Channel-allowlist gate ----------------------------------
        channel_row = _lookup_channel(db, slack_channel_id)
        if (
            channel_row is None
            or channel_row.get("client_id") is None
            or channel_row.get("is_archived") is True
        ):
            _insert_audit(
                db,
                delivery_id=delivery_id,
                status="processed",
                error="skipped_non_client_channel",
                payload={
                    "slack_channel_id": slack_channel_id,
                    "slack_ts": slack_ts,
                    "slack_user_id": event.get("user"),
                    "author_type": None,
                    "message_type": None,
                    "subtype": subtype,
                    "skip_reason": _SKIP_NON_CLIENT_CHANNEL,
                },
            )
            logger.info(
                "slack_message_ingest: skipped non-client channel "
                "delivery_id=%s channel=%s",
                delivery_id,
                slack_channel_id,
            )
            result["skipped_reason"] = _SKIP_NON_CLIENT_CHANNEL
            return result

        # ----- Subtype gate -------------------------------------------
        if subtype in _SYSTEM_SUBTYPES:
            _insert_audit(
                db,
                delivery_id=delivery_id,
                status="processed",
                error="skipped_ignorable_subtype",
                payload={
                    "slack_channel_id": slack_channel_id,
                    "slack_ts": slack_ts,
                    "slack_user_id": event.get("user"),
                    "author_type": None,
                    "message_type": None,
                    "subtype": subtype,
                    "skip_reason": _SKIP_IGNORABLE_SUBTYPE,
                },
            )
            logger.info(
                "slack_message_ingest: skipped ignorable subtype "
                "delivery_id=%s channel=%s subtype=%s",
                delivery_id,
                slack_channel_id,
                subtype,
            )
            result["skipped_reason"] = _SKIP_IGNORABLE_SUBTYPE
            return result

        # ----- Parse + upsert -----------------------------------------
        # `message_changed` events carry the new message under
        # `event.message` rather than directly on the event dict; the
        # outer event has subtype='message_changed' and a `message` sub-
        # dict with type='message' + the updated text/ts. Unwrap so the
        # parser sees the inner shape it expects.
        event_for_parser = event
        if subtype == "message_changed":
            inner = event.get("message")
            if isinstance(inner, dict):
                event_for_parser = dict(inner)
                event_for_parser.setdefault("type", "message")
                # `channel` lives on the outer event for message_changed
                # but the parser uses channel_id parameter — fine.

        client_user_ids, team_user_ids = _load_resolvers(db)
        ella_user_id = get_user_id_for_token(os.environ.get("SLACK_USER_TOKEN"))

        record = parse_message(
            event_for_parser,
            channel_id=slack_channel_id,
            client_user_ids=client_user_ids,
            team_user_ids=team_user_ids,
            ella_user_id=ella_user_id,
        )

        if record is None:
            # Parser returned None for a reason that wasn't pre-filtered
            # by the subtype gate (e.g., missing ts on a message_changed
            # inner shape, or a subtype the parser knows about that we
            # don't). Treat as ignorable_subtype with whatever subtype
            # we can extract, so the audit ledger has a discriminator.
            inner_subtype = event_for_parser.get("subtype") or subtype
            _insert_audit(
                db,
                delivery_id=delivery_id,
                status="processed",
                error="skipped_ignorable_subtype",
                payload={
                    "slack_channel_id": slack_channel_id,
                    "slack_ts": slack_ts,
                    "slack_user_id": event.get("user"),
                    "author_type": None,
                    "message_type": None,
                    "subtype": inner_subtype,
                    "skip_reason": _SKIP_IGNORABLE_SUBTYPE,
                },
            )
            result["skipped_reason"] = _SKIP_IGNORABLE_SUBTYPE
            return result

        _upsert_message(db, record)

        _insert_audit(
            db,
            delivery_id=delivery_id,
            status="processed",
            error=None,
            payload={
                "slack_channel_id": record.slack_channel_id,
                "slack_ts": record.slack_ts,
                "slack_user_id": record.slack_user_id,
                "author_type": record.author_type,
                "message_type": record.message_type,
                "subtype": record.message_subtype,
                "content_source": _CONTENT_SOURCE_INGESTED,
            },
        )
        logger.info(
            "slack_message_ingest: ingested delivery_id=%s channel=%s ts=%s "
            "author_type=%s",
            delivery_id,
            record.slack_channel_id,
            record.slack_ts,
            record.author_type,
        )
        result["ingested"] = True

        # Passive-monitor fork. Fail-soft — exception path writes an
        # error audit row under a distinct source label and never
        # propagates, so the ingest itself always succeeds. Behavior
        # only activates when the channel has `passive_monitoring_enabled`
        # set AND the message is client-authored AND the global env-var
        # kill switch is on; the helper short-circuits all other cases.
        _maybe_dispatch_passive_monitor(
            db,
            channel_row=channel_row,
            record=record,
            delivery_id=delivery_id,
        )

        return result

    except Exception as exc:
        logger.exception(
            "slack_message_ingest: failed delivery_id=%s channel=%s ts=%s",
            delivery_id,
            slack_channel_id,
            slack_ts,
        )
        # Best-effort audit row for the failure. If THIS insert also
        # raises, swallow — the outer try/except already captured the
        # primary exception and we never propagate from this function.
        try:
            from shared.db import get_client

            db = get_client()
            _insert_audit(
                db,
                delivery_id=delivery_id,
                status="failed",
                error=str(exc)[:2000],
                payload={
                    "slack_channel_id": slack_channel_id,
                    "slack_ts": slack_ts,
                    "slack_user_id": event.get("user"),
                    "author_type": None,
                    "message_type": None,
                    "subtype": subtype,
                },
            )
        except Exception:
            logger.warning(
                "slack_message_ingest: audit-row insert during exception path "
                "also raised delivery_id=%s",
                delivery_id,
            )
        result["skipped_reason"] = "exception"
        result["error"] = str(exc)[:2000]
        return result


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------


def _lookup_channel(db, slack_channel_id: str | None) -> dict[str, Any] | None:
    if not slack_channel_id:
        return None
    resp = (
        db.table("slack_channels")
        .select(
            "id,slack_channel_id,client_id,is_archived,"
            "passive_monitoring_enabled,test_mode"
        )
        .eq("slack_channel_id", slack_channel_id)
        .limit(1)
        .execute()
    )
    rows = resp.data or []
    return rows[0] if rows else None


def _load_resolvers(db) -> tuple[set[str], set[str]]:
    """Per-request fetch (per spec decision (a)). Two small queries.

    Re-fetched per event rather than cached because:
      - Volume is realtime — a few events/sec at peak.
      - Membership changes (new client onboard, team_member added)
        are picked up immediately.
      - Caching would require TTL invalidation logic that adds bugs
        for marginal latency gains.
    """
    c = (
        db.table("clients")
        .select("slack_user_id")
        .is_("archived_at", "null")
        .execute()
    )
    clients = {
        row["slack_user_id"]
        for row in (c.data or [])
        if row.get("slack_user_id")
    }
    t = (
        db.table("team_members")
        .select("slack_user_id")
        .is_("archived_at", "null")
        .execute()
    )
    teams = {
        row["slack_user_id"]
        for row in (t.data or [])
        if row.get("slack_user_id")
    }
    return clients, teams


def _upsert_message(db, record: SlackMessageRecord) -> None:
    payload = {
        "slack_channel_id": record.slack_channel_id,
        "slack_ts": record.slack_ts,
        "slack_thread_ts": record.slack_thread_ts,
        "slack_user_id": record.slack_user_id,
        "author_type": record.author_type,
        "text": record.text,
        "message_type": record.message_type,
        "message_subtype": record.message_subtype,
        "raw_payload": record.raw_payload,
        "sent_at": record.sent_at.isoformat(),
    }
    db.table("slack_messages").upsert(
        payload, on_conflict="slack_channel_id,slack_ts"
    ).execute()


def _insert_audit(
    db,
    *,
    delivery_id: str,
    status: str,
    error: str | None,
    payload: dict[str, Any],
) -> None:
    row: dict[str, Any] = {
        "webhook_id": delivery_id,
        "source": _DELIVERY_SOURCE,
        "processing_status": status,
        "payload": payload,
        "headers": {},
    }
    if error is not None:
        row["processing_error"] = error[:2000]
    if status != "received":
        row["processed_at"] = datetime.now(timezone.utc).isoformat()
    try:
        db.table("webhook_deliveries").insert(row).execute()
    except Exception as exc:
        logger.warning(
            "slack_message_ingest: audit row insert failed delivery_id=%s: %s",
            delivery_id,
            exc,
        )


# ---------------------------------------------------------------------------
# Passive-monitor dispatch
# ---------------------------------------------------------------------------


def _maybe_dispatch_passive_monitor(
    db,
    *,
    channel_row: dict[str, Any],
    record: SlackMessageRecord,
    delivery_id: str,
) -> None:
    """Fork into Ella's passive-monitor pipeline after a successful
    ingest. Wrapped in a single try/except — any exception is logged
    and audited under `_PASSIVE_MONITOR_ERROR_SOURCE`; never raised.

    Channel-level gate: `slack_channels.passive_monitoring_enabled`
    must be True. (The global env-var kill switch and the author-type
    gate are checked inside `evaluate_passive_trigger` so the gate
    logic stays in one place.)
    """
    try:
        if not channel_row.get("passive_monitoring_enabled"):
            return
        channel_client_id = channel_row.get("client_id")
        if not channel_client_id:
            # Belt-and-suspenders: a channel marked passive but missing
            # a client mapping shouldn't exist (the earlier allowlist
            # gate rejects unmapped channels), but skip rather than
            # crash if we somehow get one.
            return

        from agents.ella.passive_monitor import (
            PassiveTriggerPayload,
            evaluate_passive_trigger,
        )
        from agents.ella.passive_dispatch import persist_passive_evaluation

        payload = PassiveTriggerPayload(
            slack_channel_id=record.slack_channel_id,
            triggering_message_ts=record.slack_ts,
            triggering_message_slack_user_id=record.slack_user_id,
            triggering_message_text=record.text or "",
            author_type=record.author_type,
            channel_client_id=channel_client_id,
            test_mode=bool(channel_row.get("test_mode")),
        )
        evaluation = evaluate_passive_trigger(payload)
        persist_passive_evaluation(evaluation)
    except Exception as exc:
        logger.exception(
            "slack_message_ingest: passive-monitor fork failed "
            "delivery_id=%s channel=%s ts=%s: %s",
            delivery_id,
            record.slack_channel_id,
            record.slack_ts,
            exc,
        )
        try:
            error_audit_row: dict[str, Any] = {
                "webhook_id": f"passive_monitor_{delivery_id}",
                "source": _PASSIVE_MONITOR_ERROR_SOURCE,
                "processing_status": "failed",
                "processing_error": str(exc)[:2000],
                "processed_at": datetime.now(timezone.utc).isoformat(),
                "payload": {
                    "slack_channel_id": record.slack_channel_id,
                    "slack_ts": record.slack_ts,
                    "slack_user_id": record.slack_user_id,
                    "author_type": record.author_type,
                    "ingest_delivery_id": delivery_id,
                },
                "headers": {},
            }
            db.table("webhook_deliveries").insert(error_audit_row).execute()
        except Exception as audit_exc:
            logger.warning(
                "slack_message_ingest: passive-monitor error-audit insert "
                "also failed delivery_id=%s: %s",
                delivery_id,
                audit_exc,
            )
