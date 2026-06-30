# calendly_scheduled_events

Mirror of Calendly's `/scheduled_events`. URI-keyed; idempotent.

## Purpose

Source for the Engine sheet's six Calendly-sourced rows. Live ingestion via `api/calendly_events.py` (webhook receiver fetches the parent event on every invitee.created/canceled tick); 7-day backfill via `scripts/backfill_calendly.py`.

## ⭐ Booking link identities (CRITICAL — read before touching booking logic)

Several Calendly event types share near-identical names. Counting the wrong
one inflates or undercounts bookings. Confirmed 2026-05-29 against
live data. **The data layer keys on the `event_type_uri`, NOT the name** —
the only thing separating the direct link from the Aman-solo link by name
is casing (`Ai` vs `AI`), and Calendly drifts casing at booking time, so
the name is ambiguous here. The URI is unambiguous.

| What it is | Name (as booked) | `event_type_uri` (ends in) | Counts as |
|---|---|---|---|
| **Direct / funnel self-book** (LP Calendly widget) | `Ai Partner Strategy Call` | `8f6795d3-…-9ecaabb3938c` | **DIRECT BOOKINGS** ✅ |
| Aman solo call (`aman-theaipartner/strategy-call`) | `AI Partner Strategy Call` | `a596a1b1-…-53092036c2c5` | not direct ✗ |
| period variant | `AI Partner Strategy Call.` | `8ce6d7e4-…-8892b68ef205` | not the funnel link ✗ |
| **Setter-led** booking (a setter booked the prospect) | `Partnership Call w/ {closer}` (w/ Aman, w/ Adam, …) | — | setter-led, NOT direct ✗ |

The direct-bookings constant lives at
`lib/db/funnel-calendly.ts` → `DIRECT_BOOKING_EVENT_TYPE_URI`
(`getDirectBookings()`), which powers the LP page "Direct bookings" box and
the Pulse Landing-Page "Bookings" tile.

**Booking lead-time options.** When a lead self-books the direct link,
Calendly only offers **today, +1 day, or +2 days** (verified: a 45-day
sample was 8 today / 33 one-day / 23 two-day, nothing 3+). The day-out
split (`start_time.date − event_created_at.date` in ET — see § Date math
gotcha) is surfaced on the LP page.

**Scaling closers.** Because we key on the round-robin direct event type,
ANY closer the round-robin assigns is captured automatically — no per-closer
config. Setter-led "Partnership Call w/ {closer}" links are a *separate*
family that this metric deliberately excludes (they're setter bookings, not
direct). If setter-led bookings ever need their own per-rep metric, match
the `Partnership Call w/ %` name family.

## Columns

### Identity + core fields
| Column | Type | Notes |
|---|---|---|
| `uri` | `text` | PK. `https://api.calendly.com/scheduled_events/{uuid}`. |
| `name` | `text` | **Event-type name as recorded at booking time.** **PREFER THIS** over `event_type_uri` for filtering — 58% of historical events reference retired event_type URIs absent from `calendly_event_types`. Casing may drift (Calendly title-cases at booking time: "Ai Partner Strategy Call" vs catalog's "AI Partner Strategy Call"); aggregation must match case-insensitively. |
| `status` | `text` | `active` / `canceled`. |
| `start_time` | `timestamptz` | When the meeting happens. UTC. |
| `end_time` | `timestamptz` | When the meeting ends. UTC. |
| `event_created_at` | `timestamptz` | When the BOOKING was created in Calendly (i.e. when the invitee booked). **The Engine sheet metrics key on this column, not `start_time`.** UTC. |
| `event_updated_at` | `timestamptz` | Calendly's last-modified timestamp. |
| `event_type_uri` | `text` | Loose FK to `calendly_event_types.uri`. NOT enforced — see § Why no FK below. |

### Host (denormalized from first event_membership)
| Column | Type | Notes |
|---|---|---|
| `host_user_uri` | `text` | Calendly user URI. |
| `host_user_email` | `text` | E.g. `aman@theaipartner.io`. |
| `host_user_name` | `text` | E.g. `Aman Ali`. |

### Body fields (jsonb passthrough)
| Column | Type | Notes |
|---|---|---|
| `location` | `jsonb` | Calendly's location object (type + value). |
| `invitees_counter` | `jsonb` | `{active, limit, total}`. |
| `cancellation` | `jsonb` | NULL on active events; populated on canceled: `{canceled_by, canceler_type (host/invitee), created_at, reason}`. |
| `raw_payload` | `jsonb` | Full event payload for forensics / re-parse if the parser evolves. |

### Lifecycle
| Column | Type | Notes |
|---|---|---|
| `synced_at` | `timestamptz` | When ingestion last touched this row. |
| `created_at` / `updated_at` | `timestamptz` | Standard. `updated_at` trigger via `set_updated_at()`. |

## Why no FK on `event_type_uri`

Two reasons:

1. **58% of historical events reference RETIRED event-type URIs** that don't appear in the active `/event_types` catalog (proven in discovery). A hard FK would block ingestion of any such event. Loose-ref lets them land; aggregation matches by `name` instead.
2. **Webhook delivery order isn't guaranteed.** An `invitee.created` for an event using a brand-new event-type might arrive before the next backfill refreshes the catalog. Loose-ref tolerates the race.

## Date math gotcha: business timezone

**"Next Day" / "Two Days Out" metrics must compute `start_time.date - event_created_at.date` in `America/New_York`**, NOT UTC. A booking made at 22:00 EDT (= 02:00 UTC next day) for a meeting at 09:00 EDT the next morning shows as `delta=1d` in EDT (correct) but `delta=0d` in UTC (wrong). Same convention as ADR 0003.

Stored values stay UTC; aggregation views/queries convert at read time.

## Indexes

- PK on `uri`.
- `(status, event_created_at DESC)` — per-day New Scheduled counts.
- `(name, event_created_at DESC)` — closer-booking-by-day filtering.
- `(event_type_uri) WHERE NOT NULL` — for the rare cases where URI-based lookup is meaningful.
- `(event_created_at DESC)` — cohort window scans.

## Idempotency

`UPSERT ON CONFLICT (uri)`. Re-running backfill or webhook delivery is a no-op-equivalent — values refresh, no duplicates.

## What populates it

- `ingestion.calendly.pipeline.upsert_event_from_payload()` — per-event upsert.
- `ingestion.calendly.pipeline.sync_invitee_and_event()` — webhook orchestration that fetches the parent event alongside an invitee.
- `ingestion.calendly.pipeline.sync_recent_events_with_invitees()` — backfill walker.

## Example queries

New Scheduled Meetings (Engine row 93) — last 7 days, in EDT:
```sql
SELECT (event_created_at AT TIME ZONE 'America/New_York')::date AS booking_day_edt,
       count(*) AS new_scheduled
FROM calendly_scheduled_events e
JOIN calendly_invitees i ON i.event_uri = e.uri
WHERE e.status = 'active'
  AND i.rescheduled = false
  AND e.event_created_at >= now() - interval '7 days'
GROUP BY 1
ORDER BY 1 DESC;
```

Total Closer Bookings (Engine row 34) — last 7 days, EDT:
```sql
SELECT (event_created_at AT TIME ZONE 'America/New_York')::date AS booking_day_edt,
       count(*) AS closer_bookings
FROM calendly_scheduled_events e
JOIN calendly_invitees i ON i.event_uri = e.uri
WHERE e.status = 'active'
  AND i.rescheduled = false
  AND LOWER(e.name) IN ('ai partner strategy call')  -- see CLOSER_EVENT_TYPE_NAMES
  AND e.event_created_at >= now() - interval '7 days'
GROUP BY 1
ORDER BY 1 DESC;
```

Closer Booking Next Day (Engine row 35) — last 30 days, EDT:
```sql
SELECT (event_created_at AT TIME ZONE 'America/New_York')::date AS booking_day_edt,
       count(*) AS next_day_bookings
FROM calendly_scheduled_events e
JOIN calendly_invitees i ON i.event_uri = e.uri
WHERE e.status = 'active'
  AND i.rescheduled = false
  AND LOWER(e.name) IN ('ai partner strategy call')
  AND (e.start_time AT TIME ZONE 'America/New_York')::date
    - (e.event_created_at AT TIME ZONE 'America/New_York')::date = 1
  AND e.event_created_at >= now() - interval '30 days'
GROUP BY 1
ORDER BY 1 DESC;
```
