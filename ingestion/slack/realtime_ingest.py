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
import re
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

# Webhook_id prefixes for the three audit-row shapes (post-2026-05-21
# dedup-key restructure):
#   slack_msg_ingest_{channel}_{ts}           — happy-path through step 0
#   slack_msg_ingest_dup_{uuid}               — forensic-duplicate row
#   slack_msg_ingest_pre_dedup_{uuid}         — early-exit before step 0
_HAPPY_PATH_PREFIX = "slack_msg_ingest"
_PRE_DEDUP_PREFIX = "slack_msg_ingest_pre_dedup"

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
    event = payload.get("event") or {}
    slack_channel_id = event.get("channel")
    slack_ts = event.get("ts")
    subtype = event.get("subtype")

    # `delivery_id` is the cosmetic identifier returned to the caller +
    # used in log lines. The PHYSICAL webhook_id written into
    # `webhook_deliveries` depends on which branch fires:
    #   - Happy path through step 0: deterministic
    #     `slack_msg_ingest_{record.slack_channel_id}_{record.slack_ts}`
    #     (inner ts, stable across message_changed redeliveries).
    #   - Pre-dedup early exit (channel/subtype/parser-None):
    #     UUID-suffixed `slack_msg_ingest_pre_dedup_{uuid}`.
    #   - Forensic-duplicate row: UUID-suffixed `slack_msg_ingest_dup_{uuid}`.
    # The cosmetic `delivery_id` here is the outer-ts form so log lines
    # stay readable; it gets overwritten with the canonical inner-ts
    # form after the parser resolves the record.
    if slack_channel_id and slack_ts:
        delivery_id = f"{_HAPPY_PATH_PREFIX}_{slack_channel_id}_{slack_ts}"
    else:
        delivery_id = f"slack_msg_ingest_malformed_{uuid.uuid4()}"

    result: dict[str, Any] = {
        "ingested": False,
        "skipped_reason": None,
        "delivery_id": delivery_id,
        "error": None,
        "slack_channel_id": slack_channel_id,
        "slack_ts": slack_ts,
    }
    # Tracks whether step 0 wrote a `received` row that the exception
    # handler can UPDATE to `failed`. False until `_try_register_delivery`
    # returns True. When False, an exception falls through to a fresh
    # `_insert_audit_terminal` INSERT under the pre-dedup prefix.
    step_0_succeeded = False

    try:
        from shared.db import get_client

        db = get_client()

        # ----- Channel-allowlist gate (pre-dedup) ----------------------
        channel_row = _lookup_channel(db, slack_channel_id)
        if (
            channel_row is None
            or channel_row.get("client_id") is None
            or channel_row.get("is_archived") is True
        ):
            _insert_audit_terminal(
                db,
                delivery_id_prefix=_PRE_DEDUP_PREFIX,
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

        # ----- Subtype gate (pre-dedup) -------------------------------
        if subtype in _SYSTEM_SUBTYPES:
            _insert_audit_terminal(
                db,
                delivery_id_prefix=_PRE_DEDUP_PREFIX,
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

        # ----- Parse (pre-dedup) ---------------------------------------
        # `message_changed` events carry the new message under
        # `event.message` rather than directly on the event dict; the
        # outer event has subtype='message_changed' and a `message` sub-
        # dict with type='message' + the updated text/ts. Unwrap so the
        # parser sees the inner shape it expects — and critically,
        # `record.slack_ts` becomes the INNER message ts, which is
        # what step 0 below uses as the dedup key (so the second
        # delivery of an edited message dedups against the original).
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
            _insert_audit_terminal(
                db,
                delivery_id_prefix=_PRE_DEDUP_PREFIX,
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

        # ----- Step 0: Dedup gate (POST-PARSE, post-2026-05-21) -------
        # Atomic register against the webhook_deliveries PK using the
        # INNER/canonical message ts from `record.slack_ts`. This is
        # stable across `message_changed` redeliveries (the prior spec
        # `ella-realtime-ingest-idempotency` used the outer event ts,
        # which differed between original + edit deliveries — diagnostic
        # in `docs/reports/ella-duplicate-webhook-delivery-diagnostic.md`).
        delivery_id = (
            f"{_HAPPY_PATH_PREFIX}_{record.slack_channel_id}_{record.slack_ts}"
        )
        result["delivery_id"] = delivery_id
        result["slack_ts"] = record.slack_ts

        if not _try_register_delivery(
            db,
            delivery_id=delivery_id,
            slack_channel_id=record.slack_channel_id,
            slack_ts=record.slack_ts,
        ):
            logger.info(
                "slack_message_ingest: duplicate delivery_id=%s channel=%s ts=%s",
                delivery_id,
                record.slack_channel_id,
                record.slack_ts,
            )
            result["skipped_reason"] = "duplicate"
            return result
        step_0_succeeded = True

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
        # When step 0 fired (`received` row exists), UPDATE it to
        # `failed`. When it didn't (exception during channel lookup /
        # parser / etc.), INSERT a fresh terminal row under the
        # pre-dedup prefix.
        try:
            from shared.db import get_client

            db = get_client()
            failure_payload = {
                "slack_channel_id": slack_channel_id,
                "slack_ts": slack_ts,
                "slack_user_id": event.get("user"),
                "author_type": None,
                "message_type": None,
                "subtype": subtype,
            }
            if step_0_succeeded:
                _insert_audit(
                    db,
                    delivery_id=delivery_id,
                    status="failed",
                    error=str(exc)[:2000],
                    payload=failure_payload,
                )
            else:
                _insert_audit_terminal(
                    db,
                    delivery_id_prefix=_PRE_DEDUP_PREFIX,
                    status="failed",
                    error=str(exc)[:2000],
                    payload=failure_payload,
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
    c = db.table("clients").select("slack_user_id").is_("archived_at", "null").execute()
    clients = {
        row["slack_user_id"] for row in (c.data or []) if row.get("slack_user_id")
    }
    t = (
        db.table("team_members")
        .select("slack_user_id")
        .is_("archived_at", "null")
        .execute()
    )
    teams = {row["slack_user_id"] for row in (t.data or []) if row.get("slack_user_id")}
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


def _insert_audit_terminal(
    db,
    *,
    delivery_id_prefix: str,
    status: str,
    error: str | None,
    payload: dict[str, Any],
) -> None:
    """INSERT a single-state audit row for an early-exit branch that
    fires BEFORE step 0 (channel-skip, subtype-skip, parser-None).
    Those branches don't have a `received` row to UPDATE — the dedup
    gate hasn't fired yet — so they need a plain INSERT.

    Webhook_id format: `{delivery_id_prefix}_{uuid}` — UUID-suffixed so
    these rows never PK-collide. They aren't meant to participate in
    dedup; the message never reaches the pipeline anyway. The prefix
    distinguishes them from happy-path rows
    (`slack_msg_ingest_{channel}_{ts}`) and from forensic-duplicate
    rows (`slack_msg_ingest_dup_{uuid}`) so audit-ledger queries can
    filter by intent.

    Best-effort: a failure here is logged + swallowed."""
    row: dict[str, Any] = {
        "webhook_id": f"{delivery_id_prefix}_{uuid.uuid4()}",
        "source": _DELIVERY_SOURCE,
        "processing_status": status,
        "payload": payload,
        "headers": {},
        "processed_at": datetime.now(timezone.utc).isoformat(),
    }
    if error is not None:
        row["processing_error"] = error[:2000]
    try:
        db.table("webhook_deliveries").insert(row).execute()
    except Exception as exc:
        logger.warning(
            "slack_message_ingest: terminal audit insert failed "
            "delivery_id_prefix=%s: %s",
            delivery_id_prefix,
            exc,
        )


def _insert_audit(
    db,
    *,
    delivery_id: str,
    status: str,
    error: str | None,
    payload: dict[str, Any],
) -> None:
    """Update the `received` row written by `_try_register_delivery` to
    its terminal state (`processed`, `failed`, `malformed`). Was an
    INSERT pre-2026-05-20; now an UPDATE so the lifecycle matches the
    migration 0011 contract (`received → processed/failed/malformed`,
    one row per delivery). The legacy name is kept so callers don't
    care that the underlying op switched.

    Best-effort: a failure here is logged + swallowed. The dedup
    decision has already happened upstream; this row is for
    observability."""
    update_fields: dict[str, Any] = {
        "processing_status": status,
        "payload": payload,
        "headers": {},
    }
    if error is not None:
        update_fields["processing_error"] = error[:2000]
    if status != "received":
        update_fields["processed_at"] = datetime.now(timezone.utc).isoformat()
    try:
        db.table("webhook_deliveries").update(update_fields).eq(
            "webhook_id", delivery_id
        ).execute()
    except Exception as exc:
        logger.warning(
            "slack_message_ingest: audit row update failed delivery_id=%s: %s",
            delivery_id,
            exc,
        )


# ---------------------------------------------------------------------------
# Dedup gate (step 0 in `ingest_message_event`)
# ---------------------------------------------------------------------------


def _try_register_delivery(
    db,
    *,
    delivery_id: str,
    slack_channel_id: str | None,
    slack_ts: str | None,
) -> bool:
    """Atomically register a delivery in `webhook_deliveries`. Returns
    True on first-time delivery, False on duplicate.

    Uses the `webhook_deliveries.webhook_id` PK as the dedup primitive
    via UPSERT-with-`ignore_duplicates=True` — the same pattern proven
    in production by `api/fathom_events.py` (F2.4 smoke confirmed
    `data=[]` shape against PostgREST when the PK already exists).
    Two concurrent INSERTs serialize at the storage layer; exactly one
    wins. No exception-string matching required for PK collision
    detection — the empty-data return is the unambiguous signal.

    Duplicate-path side effect: a second audit row gets written via
    `_write_duplicate_audit_row` with a UUID-suffixed `webhook_id` so
    it doesn't itself PK-collide. Gives operational visibility into
    how often Slack actually redelivers (a non-zero count over a week
    of traffic confirms the gate is working).

    Fail-open on unexpected exceptions (DB outage etc.): log + return
    True. Better to process a possible-duplicate than to drop a
    legitimate client message on a transient DB blip.
    """
    row = {
        "webhook_id": delivery_id,
        "source": _DELIVERY_SOURCE,
        "processing_status": "received",
        "payload": {
            "slack_channel_id": slack_channel_id,
            "slack_ts": slack_ts,
        },
        "headers": {},
    }
    try:
        resp = (
            db.table("webhook_deliveries")
            .upsert(
                row,
                on_conflict="webhook_id",
                ignore_duplicates=True,
                returning="representation",
            )
            .execute()
        )
    except Exception as exc:
        logger.warning(
            "slack_message_ingest: _try_register_delivery failed "
            "delivery_id=%s: %s (failing open — treating as not-duplicate)",
            delivery_id,
            exc,
        )
        return True

    data = getattr(resp, "data", None)
    if data:
        return True

    # Empty data → PK already existed → duplicate delivery.
    _write_duplicate_audit_row(
        db,
        original_delivery_id=delivery_id,
        slack_channel_id=slack_channel_id,
        slack_ts=slack_ts,
    )
    return False


def _write_duplicate_audit_row(
    db,
    *,
    original_delivery_id: str,
    slack_channel_id: str | None,
    slack_ts: str | None,
) -> None:
    """Write the forensic audit row recording that a duplicate was
    caught. UUID-suffixed `webhook_id` avoids re-colliding with the
    original delivery's PK. Payload references `original_delivery_id`
    so operators can trace the duplicate back to its first delivery.

    Best-effort: if this insert also fails, swallow + log. The dedup
    decision has already happened (the caller treats this row's
    absence as fine); the row exists for observability."""
    row: dict[str, Any] = {
        "webhook_id": f"slack_msg_ingest_dup_{uuid.uuid4()}",
        "source": _DELIVERY_SOURCE,
        "processing_status": "duplicate",
        "processed_at": datetime.now(timezone.utc).isoformat(),
        "payload": {
            "slack_channel_id": slack_channel_id,
            "slack_ts": slack_ts,
            "skip_reason": "duplicate_delivery",
            "original_delivery_id": original_delivery_id,
        },
        "headers": {},
    }
    try:
        db.table("webhook_deliveries").insert(row).execute()
    except Exception as exc:
        logger.warning(
            "slack_message_ingest: duplicate-audit row insert failed "
            "original=%s: %s",
            original_delivery_id,
            exc,
        )


# ---------------------------------------------------------------------------
# Passive-monitor dispatch
# ---------------------------------------------------------------------------


_SLACK_MENTION_RE = re.compile(r"<@(U[A-Z0-9]+)>")


def detect_at_mentions(
    message_text: str,
    ella_bot_user_id: str | None,
    ella_human_user_id: str | None,
) -> dict[str, Any]:
    """Parse all `<@U...>` mentions from a Slack message and classify
    the routing intent.

    Returns:
        {
          "mentions":            list[str] — distinct user IDs in order,
          "is_ella_mentioned":   bool — True if any of the IDs is Ella's
                                  bot OR human user_id,
          "is_routed_to_others": bool — True if mentions is non-empty
                                  AND is_ella_mentioned is False.
        }

    The three states (`no mentions`, `is_ella_mentioned`,
    `is_routed_to_others`) are mutually exclusive on the routing
    decision: when Ella appears in the mention list the classifier path
    wins; when only non-Ella mentions appear the pre-LLM routing gate
    fires; otherwise the decision Haiku runs.

    Defensive on missing IDs: when `ella_bot_user_id` and
    `ella_human_user_id` are both falsy, every `<@U...>` mention is
    treated as non-Ella — Ella is presumed not configured, so any
    routing-to-someone is routed to non-Ella by definition.
    """
    pattern = _SLACK_MENTION_RE
    raw = pattern.findall(message_text or "")
    mentions = list(dict.fromkeys(raw))  # dedup, preserve order
    ella_ids = {uid for uid in (ella_bot_user_id, ella_human_user_id) if uid}
    is_ella_mentioned = any(uid in ella_ids for uid in mentions)
    is_routed_to_others = bool(mentions) and not is_ella_mentioned
    return {
        "mentions": mentions,
        "is_ella_mentioned": is_ella_mentioned,
        "is_routed_to_others": is_routed_to_others,
    }


def _at_mentions_for_record(text: str) -> dict[str, Any]:
    """Wrap `detect_at_mentions` with the env-var-based Ella ID
    resolution + fail-soft semantics that the live ingest path needs.

    Token-resolution errors collapse the result to "no detection" —
    `is_ella_mentioned=False` and `is_routed_to_others=False` —
    matching the prior `_detect_ella_mention` behavior on the same
    error class. A missed routing signal here degrades to the decision
    Haiku path (which has its own skip default), never a crash."""
    try:
        ella_bot_id = get_user_id_for_token(os.environ.get("SLACK_BOT_TOKEN"))
        ella_human_id = get_user_id_for_token(os.environ.get("SLACK_USER_TOKEN"))
        return detect_at_mentions(text or "", ella_bot_id, ella_human_id)
    except Exception as exc:
        logger.warning("slack_message_ingest: at-mention detection raised: %s", exc)
        return {
            "mentions": [],
            "is_ella_mentioned": False,
            "is_routed_to_others": False,
        }


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

        mention_result = _at_mentions_for_record(record.text or "")
        payload = PassiveTriggerPayload(
            slack_channel_id=record.slack_channel_id,
            triggering_message_ts=record.slack_ts,
            triggering_message_slack_user_id=record.slack_user_id,
            triggering_message_text=record.text or "",
            author_type=record.author_type,
            channel_client_id=channel_client_id,
            is_ella_mentioned=mention_result["is_ella_mentioned"],
            is_routed_to_others=mention_result["is_routed_to_others"],
            test_mode=bool(channel_row.get("test_mode")),
        )

        # Split-path fork (2026-05-23): @-mentions go through the
        # restored synchronous @ handler; non-@-mention messages stay
        # on the passive observation path (decision Haiku → digest
        # item, no in-channel voice). The two paths share the same
        # PassiveTriggerPayload shape but never co-fire.
        if payload.is_ella_mentioned:
            # client-authored mentions are by far the common case;
            # team_member mentions also route through here (an advisor
            # asking Ella in a client channel).
            if payload.author_type in ("client", "team_member"):
                from agents.ella.agent import handle_at_mention

                handle_at_mention(payload)
            return

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
