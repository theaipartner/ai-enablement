"""Calendly ingestion orchestrator — backfill + webhook entry points.

Pattern mirrors `ingestion/close/pipeline.py`. All upserts idempotent
on URI PKs (Calendly's stable identifiers). Fail-soft per record.

Two surfaces:

  - **Backfill / batch:** `sync_event_types`, `sync_recent_events_with_invitees`
    used by scripts/backfill_calendly.py.

  - **Webhook receivers:** `upsert_event_from_payload`,
    `upsert_invitee_from_payload`, `upsert_invitee_uri` (when the
    payload carries only a URI). Used by api/calendly_events.py.

The webhook receiver typically gets an `invitee.created` or
`invitee.canceled` event with the invitee object inline. Best practice:
fetch the parent event fresh too (Calendly may not include it inline)
+ upsert both. That's `upsert_invitee_and_event_from_invitee_payload`.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

from ingestion.calendly.client import CalendlyAPIError, CalendlyClient
from ingestion.calendly.parser import (
    parse_event_type,
    parse_invitee,
    parse_scheduled_event,
)

logger = logging.getLogger("ai_enablement.calendly.pipeline")


@dataclass
class SyncOutcome:
    event_types_synced: int = 0
    events_synced: int = 0
    events_failed: int = 0
    invitees_synced: int = 0
    invitees_failed: int = 0
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def record_error(self, where: str, err: Exception) -> None:
        self.errors.append(f"{where}: {err}")


# ---------------------------------------------------------------------------
# Reference data
# ---------------------------------------------------------------------------


def sync_event_types(
    client: CalendlyClient,
    db,
    organization_uri: str,
    outcome: SyncOutcome | None = None,
) -> SyncOutcome:
    outcome = outcome or SyncOutcome()
    try:
        for et in client.iter_event_types(organization_uri):
            row = parse_event_type(et)
            if not row:
                continue
            try:
                db.table("calendly_event_types").upsert(
                    row, on_conflict="uri"
                ).execute()
                outcome.event_types_synced += 1
            except Exception as exc:
                outcome.record_error(f"upsert event_type {row.get('uri')}", exc)
    except CalendlyAPIError as exc:
        outcome.record_error("iter_event_types", exc)
    return outcome


# ---------------------------------------------------------------------------
# Per-row upsert helpers (used by both backfill + webhook)
# ---------------------------------------------------------------------------


def upsert_event_from_payload(db, payload: dict[str, Any]) -> str | None:
    """Upsert a single scheduled_event row from a Calendly payload.

    Returns the event URI on success, None if the payload is unusable.
    """
    row = parse_scheduled_event(payload)
    if not row.get("uri"):
        return None
    db.table("calendly_scheduled_events").upsert(
        row, on_conflict="uri"
    ).execute()
    return row["uri"]


def upsert_invitee_from_payload(db, payload: dict[str, Any]) -> str | None:
    """Upsert a single invitee row from a Calendly payload."""
    row = parse_invitee(payload)
    if not row.get("uri"):
        return None
    db.table("calendly_invitees").upsert(
        row, on_conflict="uri"
    ).execute()
    return row["uri"]


def upsert_event_type_from_payload(db, payload: dict[str, Any]) -> str | None:
    row = parse_event_type(payload)
    if not row.get("uri"):
        return None
    db.table("calendly_event_types").upsert(
        row, on_conflict="uri"
    ).execute()
    return row["uri"]


# ---------------------------------------------------------------------------
# Webhook orchestration — invitee event arrives, sync everything
# ---------------------------------------------------------------------------


def sync_invitee_and_event(
    client: CalendlyClient,
    db,
    invitee_payload: dict[str, Any],
    outcome: SyncOutcome | None = None,
) -> SyncOutcome:
    """Given an invitee payload (from a webhook), upsert the invitee +
    fetch + upsert the parent scheduled_event.

    Fail-soft: if the event fetch fails, the invitee still lands; the
    next webhook tick or a backfill heals the gap.

    Reschedule handling: the `invitee.canceled` event for the OLD
    invitee and the `invitee.created` event for the NEW invitee each
    trigger this function independently. Each upserts its own row;
    `rescheduled` + `old_invitee` / `new_invitee` carry the lineage
    so the aggregation layer doesn't double-count.
    """
    outcome = outcome or SyncOutcome()

    # 1. Upsert the invitee.
    try:
        inv_uri = upsert_invitee_from_payload(db, invitee_payload)
        if inv_uri:
            outcome.invitees_synced += 1
        else:
            outcome.invitees_failed += 1
            outcome.warnings.append(
                "invitee payload missing uri or event — skipped"
            )
    except Exception as exc:
        outcome.invitees_failed += 1
        outcome.record_error("upsert_invitee", exc)

    # 2. Fetch + upsert the parent event.
    event_uri = invitee_payload.get("event")
    if not event_uri:
        return outcome
    try:
        event_payload = client.get_scheduled_event(event_uri)
    except CalendlyAPIError as exc:
        outcome.record_error(f"get_event {event_uri}", exc)
        return outcome
    try:
        ev_uri = upsert_event_from_payload(db, event_payload)
        if ev_uri:
            outcome.events_synced += 1
        else:
            outcome.events_failed += 1
    except Exception as exc:
        outcome.events_failed += 1
        outcome.record_error(f"upsert_event {event_uri}", exc)

    return outcome


# ---------------------------------------------------------------------------
# Backfill orchestration
# ---------------------------------------------------------------------------


def sync_recent_events_with_invitees(
    client: CalendlyClient,
    db,
    organization_uri: str,
    *,
    lookback_days: int = 7,
    future_days: int = 60,
    max_events: int | None = None,
    statuses: Iterable[str] | None = ("active", "canceled"),
) -> SyncOutcome:
    """7-day backfill (per spec): pull events with start_time in
    [now - lookback_days, now + future_days], plus each event's invitees.

    `start_time` filter window is WIDER than 7 days because the Engine
    sheet metrics key off `event_created_at`, not `start_time` — but
    Calendly's API only supports filtering by start_time. The wider
    start window catches events that were booked recently but start
    further out. The aggregation layer buckets by `event_created_at`.

    Future window default = 60 days because closer-strategy-call
    bookings are typically scheduled days-to-weeks in advance.

    Statuses default to ("active", "canceled") because canceled events
    carry cancellation lineage we want to preserve. Pass None or [] to
    let Calendly default.
    """
    outcome = SyncOutcome()

    now = datetime.now(timezone.utc)
    min_start = (now - timedelta(days=lookback_days)).isoformat()
    max_start = (now + timedelta(days=future_days)).isoformat()

    # 1. Inventory refresh (cheap; ~14 rows).
    sync_event_types(client, db, organization_uri, outcome=outcome)

    # 2. Iterate scheduled events. We loop per-status because Calendly's
    #    /scheduled_events `status` param is single-valued; pulling
    #    active + canceled separately covers both.
    statuses = list(statuses) if statuses else [None]
    event_uris_seen: set[str] = set()
    for status in statuses:
        try:
            for ev_payload in client.iter_scheduled_events(
                organization_uri,
                min_start_time=min_start,
                max_start_time=max_start,
                status=status,
            ):
                uri = ev_payload.get("uri")
                if not uri or uri in event_uris_seen:
                    continue
                event_uris_seen.add(uri)
                try:
                    upsert_event_from_payload(db, ev_payload)
                    outcome.events_synced += 1
                except Exception as exc:
                    outcome.events_failed += 1
                    outcome.record_error(f"upsert_event {uri}", exc)

                # Pull invitees for this event.
                try:
                    for inv in client.iter_invitees_for_event(uri):
                        try:
                            upsert_invitee_from_payload(db, inv)
                            outcome.invitees_synced += 1
                        except Exception as exc:
                            outcome.invitees_failed += 1
                            outcome.record_error(
                                f"upsert_invitee {inv.get('uri')}", exc,
                            )
                except CalendlyAPIError as exc:
                    outcome.record_error(f"invitees {uri}", exc)

                if max_events is not None and len(event_uris_seen) >= max_events:
                    break
        except CalendlyAPIError as exc:
            outcome.record_error(f"iter_scheduled_events status={status}", exc)
        if max_events is not None and len(event_uris_seen) >= max_events:
            break

    logger.info(
        "calendly sync: event_types=%d events=%d invitees=%d errors=%d",
        outcome.event_types_synced,
        outcome.events_synced,
        outcome.invitees_synced,
        len(outcome.errors),
    )
    return outcome
