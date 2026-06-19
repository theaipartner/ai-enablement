"""OnceHub ingestion orchestrator — webhook + backfill entry points.

All upserts idempotent on `booking_id`. Fail-soft per record (one bad booking
never sinks a batch). Mirrors `ingestion/calendly/pipeline.py`.

Two surfaces:
  - Webhook receiver (api/oncehub_events.py): `upsert_booking_from_payload`.
  - Backfill / API backstop (scripts/backfill_oncehub.py): `backfill_bookings`.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from ingestion.oncehub.client import OnceHubAPIError, OnceHubClient
from ingestion.oncehub.parser import parse_booking

logger = logging.getLogger("ai_enablement.oncehub.pipeline")

_TABLE = "oncehub_bookings"


@dataclass
class SyncOutcome:
    bookings_synced: int = 0
    bookings_failed: int = 0
    errors: list[str] = field(default_factory=list)

    def record_error(self, where: str, err: Exception) -> None:
        self.errors.append(f"{where}: {err}")


def upsert_booking_from_payload(
    db,
    booking: dict[str, Any],
    *,
    event_type: str | None = None,
) -> str | None:
    """Upsert a single booking row. Returns booking_id, or None if unusable.

    `event_type` is the webhook event name (stored as last_event_type so a
    no-show / cancel is recorded even when the booking's own status field
    doesn't move).
    """
    row = parse_booking(booking, event_type=event_type)
    if not row.get("booking_id"):
        return None
    db.table(_TABLE).upsert(row, on_conflict="booking_id").execute()
    return row["booking_id"]


def backfill_bookings(
    client: OnceHubClient,
    db,
    *,
    params: dict[str, Any] | None = None,
    max_bookings: int | None = None,
) -> SyncOutcome:
    """Pull bookings from the API and mirror them — initial load + the backstop
    that heals anything a webhook missed.

    `params` passes OnceHub /bookings query filters through verbatim (date
    windows etc.); None = all. Per-record fail-soft.
    """
    outcome = SyncOutcome()
    seen = 0
    try:
        for booking in client.iter_bookings(params=params):
            seen += 1
            try:
                bid = upsert_booking_from_payload(db, booking)
                if bid:
                    outcome.bookings_synced += 1
                else:
                    outcome.bookings_failed += 1
                    outcome.errors.append("booking missing id — skipped")
            except Exception as exc:  # noqa: BLE001 — fail-soft per record
                outcome.bookings_failed += 1
                outcome.record_error(f"upsert {booking.get('id')}", exc)
            if max_bookings is not None and seen >= max_bookings:
                break
    except OnceHubAPIError as exc:
        outcome.record_error("iter_bookings", exc)

    logger.info(
        "oncehub backfill: synced=%d failed=%d errors=%d",
        outcome.bookings_synced, outcome.bookings_failed, len(outcome.errors),
    )
    return outcome
