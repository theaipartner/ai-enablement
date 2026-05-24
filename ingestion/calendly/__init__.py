"""Calendly ingestion module.

Mirrors Calendly scheduled events + invitees + event-type catalog into
Supabase. Idempotent on URI PKs.

Pattern mirrors `ingestion/close/`: thin client + parser + pipeline
orchestrator. Live ingestion is webhook-based (api/calendly_events.py);
backfill via scripts/backfill_calendly.py.

Spec: docs/specs/calendly-ingestion.md
Discovery: docs/reports/calendly-discovery.md
"""

# Closer-event-type set. The Engine sheet's "Total Closer Bookings" +
# "Closer Booking Next Day" + "Closer Booking Two Days Out" filter to
# events whose `name` (case-insensitive) is in this set. Drake confirmed
# "AI Partner Strategy Call" as the canonical closer type (2026-05-24);
# Aman/team may expand later — adding to this set is the one-line change.
#
# Aggregation layer reads this constant; ingestion stores everything
# regardless (per Core Principle #1). NOT a hot path.
CLOSER_EVENT_TYPE_NAMES: frozenset[str] = frozenset({
    "ai partner strategy call",
})
