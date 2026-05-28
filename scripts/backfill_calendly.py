"""Calendly 7-day backfill — bulk-mirror recent scheduled events + invitees.

Spec: docs/specs/calendly-ingestion.md.
Runbook: docs/runbooks/calendly_ingestion.md.

Three modes per CLAUDE.md § Operational patterns:

    .venv/bin/python scripts/backfill_calendly.py             # dry-run
    .venv/bin/python scripts/backfill_calendly.py --smoke     # 1 event end-to-end
    .venv/bin/python scripts/backfill_calendly.py --apply
    .venv/bin/python scripts/backfill_calendly.py --apply --limit 10

**Dry-run** — auth check + org URI + first page of /scheduled_events
(active only). Zero upserts.

**--smoke** — full event-types refresh + ONE event + its invitees.
Idempotent; safe to re-run. Required before any bulk --apply.

**--apply** — 7-day backfill window (events with start_time in
[now - 7d, now + 60d]; the wider future window catches bookings
recently made for far-out meetings — Engine sheet keys on
event_created_at, not start_time). Drake-gated at first invocation.
Volume tiny — discovery saw ~100 events over 30 days, so 7-day = ~25.

Env vars (loaded from .env.local):
  CALENDLY_API_KEY              — Calendly Data API (or CALENDLY_API_TOKEN)
  SUPABASE_URL                  — db
  SUPABASE_SERVICE_ROLE_KEY     — db
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(_REPO / ".env.local")

from shared.db import get_client  # noqa: E402
from ingestion.calendly.client import CalendlyClient  # noqa: E402
from ingestion.calendly.pipeline import (  # noqa: E402
    SyncOutcome,
    sync_event_types,
    sync_recent_events_with_invitees,
    upsert_event_from_payload,
    upsert_invitee_from_payload,
)


BACKFILL_LOOKBACK_DAYS = 7
BACKFILL_FUTURE_DAYS = 60


def _print_outcome(label: str, outcome: SyncOutcome) -> None:
    print(f"\n=== {label} ===")
    print(f"  event_types_synced:  {outcome.event_types_synced}")
    print(f"  events_synced:       {outcome.events_synced}")
    print(f"  events_failed:       {outcome.events_failed}")
    print(f"  invitees_synced:     {outcome.invitees_synced}")
    print(f"  invitees_failed:     {outcome.invitees_failed}")
    if outcome.warnings:
        print(f"  warnings ({len(outcome.warnings)}):")
        for w in outcome.warnings[:10]:
            print(f"    - {w}")
    if outcome.errors:
        print(f"  errors ({len(outcome.errors)}):")
        for e in outcome.errors[:20]:
            print(f"    - {e}")


def dry_run(client: CalendlyClient) -> int:
    print("Dry-run: auth + org + 1 page of /scheduled_events.")
    me = client.me()
    user = me.get("resource") or me
    print(f"  user: {user.get('name')!r} <{user.get('email')}>")
    org = user.get("current_organization")
    print(f"  org:  {org}")
    if not org:
        print("  ERROR: no current_organization on /users/me")
        return 2
    # Peek at first page of events (active in next 60 days).
    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)
    min_start = (now - timedelta(days=BACKFILL_LOOKBACK_DAYS)).isoformat()
    max_start = (now + timedelta(days=BACKFILL_FUTURE_DAYS)).isoformat()
    count = 0
    for ev in client.iter_scheduled_events(
        org,
        min_start_time=min_start,
        max_start_time=max_start,
        status="active",
        page_size=20,
        max_pages=1,
    ):
        count += 1
        print(f"  {ev.get('uri', '')[-44:]}  {ev.get('name')!r}  "
              f"status={ev.get('status')}  start={ev.get('start_time')}")
    print(f"\n  peeked at {count} active events")
    print("\n[dry-run] Zero upserts. Use --smoke or --apply.")
    return 0


def smoke(client: CalendlyClient, db) -> int:
    """Event-types refresh + ONE event + its invitees end-to-end."""
    print("Smoke mode: event-types + ONE event + invitees.")
    outcome = SyncOutcome()

    print("\nStep 1/3: sync event types")
    org = client.get_organization_uri()
    sync_event_types(client, db, org, outcome=outcome)
    print(f"  event_types_synced: {outcome.event_types_synced}")

    print("\nStep 2/3: pick one recent event")
    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)
    min_start = (now - timedelta(days=BACKFILL_LOOKBACK_DAYS)).isoformat()
    max_start = (now + timedelta(days=BACKFILL_FUTURE_DAYS)).isoformat()
    target_ev = None
    for ev in client.iter_scheduled_events(
        org, min_start_time=min_start, max_start_time=max_start,
        status="active", page_size=10, max_pages=1,
    ):
        target_ev = ev
        break
    if not target_ev:
        print("  ERROR: no recent events to smoke against")
        return 2
    print(f"  using event: {target_ev.get('uri')}  {target_ev.get('name')!r}")

    print("\nStep 3/3: upsert event + its invitees")
    try:
        upsert_event_from_payload(db, target_ev)
        outcome.events_synced += 1
    except Exception as exc:
        outcome.events_failed += 1
        outcome.record_error(f"upsert_event {target_ev.get('uri')}", exc)
    for inv in client.iter_invitees_for_event(target_ev["uri"]):
        try:
            upsert_invitee_from_payload(db, inv)
            outcome.invitees_synced += 1
        except Exception as exc:
            outcome.invitees_failed += 1
            outcome.record_error(f"upsert_invitee {inv.get('uri')}", exc)

    _print_outcome("Smoke outcome", outcome)
    if outcome.events_failed > 0 or outcome.invitees_failed > 0 or outcome.errors:
        print("\nSMOKE FAILED — do NOT proceed to --apply. Review above.")
        return 3
    print("\nSmoke OK. Re-run with --apply (Drake-gated) for the bulk backfill.")
    return 0


def apply_bulk(
    client: CalendlyClient, db, *, max_events: int | None,
    lookback_days: int = BACKFILL_LOOKBACK_DAYS,
) -> int:
    print(f"Bulk backfill: lookback={lookback_days}d "
          f"future={BACKFILL_FUTURE_DAYS}d max_events={max_events}")
    org = client.get_organization_uri()
    outcome = sync_recent_events_with_invitees(
        client, db, org,
        lookback_days=lookback_days,
        future_days=BACKFILL_FUTURE_DAYS,
        max_events=max_events,
    )
    _print_outcome("Bulk apply outcome", outcome)
    if outcome.errors:
        print(f"\nApply completed WITH {len(outcome.errors)} errors — review above.")
        return 1
    print("\nApply OK.")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Calendly 7-day backfill")
    p.add_argument("--smoke", action="store_true",
                   help="One event + invitees end-to-end. Idempotent.")
    p.add_argument("--apply", action="store_true",
                   help="Bulk 7-day backfill (Drake-gated at first run).")
    p.add_argument("--limit", type=int, default=None,
                   help="Cap events processed in --apply mode.")
    p.add_argument("--lookback-days", type=int, default=BACKFILL_LOOKBACK_DAYS,
                   help="Days back to pull (by start_time). Default 7.")
    args = p.parse_args()

    if args.smoke and args.apply:
        print("--smoke and --apply are mutually exclusive.", file=sys.stderr)
        return 2

    try:
        client = CalendlyClient.from_env()
    except RuntimeError as e:
        print(f"HARD STOP: {e}", file=sys.stderr)
        return 2

    if args.smoke:
        return smoke(client, get_client())
    if args.apply:
        return apply_bulk(
            client, get_client(),
            max_events=args.limit, lookback_days=args.lookback_days,
        )
    return dry_run(client)


if __name__ == "__main__":
    sys.exit(main())
