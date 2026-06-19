# oncehub_bookings

Raw mirror of OnceHub v2 bookings. One row per booking, `booking_id`-keyed,
idempotent (upsert). Migration `0092_oncehub_bookings.sql`.

## Purpose

The capture/discovery layer for the booking→close lifecycle (see
`docs/sales/booking-to-close.md`). OnceHub **replaces Calendly** for HT closer
bookings. The dashboard / future `booking_cycles` spine read THIS table, never
`api.oncehub.com` directly (core principle #1/#3). The normalized spine, the
per-leg pinger, and the Talent closer card are deferred — they read this mirror.

## What populates it

- **Webhook (real-time primary):** `api/oncehub_events.py` — `booking.*` events
  (`scheduled`/`rescheduled`/`reassigned`/`canceled`/`canceled_then_rescheduled`/
  `canceled_reschedule_requested`/`completed`/`no_show`). The event name is stored
  as `last_event_type` so a no-show/cancel is captured even when the booking's own
  `status` doesn't move.
- **API backstop:** `scripts/backfill_oncehub.py` (`-m scripts.backfill_oncehub`,
  `--smoke` does one booking) — initial load + heals anything a webhook missed.

Both go through `ingestion/oncehub/parser.parse_booking` → the same row shape.

## Key columns

| column | notes |
|---|---|
| `booking_id` | PK, the v2 `id` (`BKNG-…`). |
| `status` | OnceHub-cased: `scheduled` / `canceled` / `completed` / `no_show`. |
| `scheduled_at` | meeting start (`starting_time`) — the closing-leg clock. |
| `owner_user_id` | **the rep the round-robin landed on** (`USR-…`). The per-closer Books attribution that had no reliable source pre-OnceHub. |
| `booking_calendar_id` | `BKC-…` (the team calendar — `BKC-0NJDVMLVJK` = "Ai Partner Strategy Call"). |
| `invitee_name`/`_email`/`_phone` | from `form_submission` — **null on admin/reschedule-created bookings**; populated on real form bookings. Lead-match fallback. |
| `lead_id` | Close lead_id from the hidden custom field. **Null until the hidden field is configured in OnceHub** + links carry `?lead_id=`. Tamperable — validate against `close_leads` before trusting. |
| `custom_fields` | the raw `custom_fields` array (top-level + `form_submission`, merged). |
| `rescheduled_booking_id` | prior booking this one replaced (reschedule lineage). |
| `canceled_by`/`cancel_user_id`/`cancel_reason` | from `cancel_reschedule_information`. |
| `last_event_type` | last webhook `type` seen. |
| `raw_payload` | the full booking object (nothing lost). |
| `excluded_at` | creator-only soft-hide; the parser NEVER writes it. |

## Reads from it

Nothing yet — the `booking_cycles` spine + Talent closer card are deferred. This
table accumulates real bookings so those can be built against reality.

## Live OnceHub config (2026-06-19)

v2 account. Team **Closers** (`TM-LHNGDXC42R59`: Cobe, Aman). Team-hosted
**"Ai Partner Strategy Call"** calendar round-robins between them. Public master
page **"AI Partner - FB"** (`go.oncehub.com/AIPartner-FB`). A second webhook →
make.com (Zain's) coexists with ours. See `docs/sales/ingestion.md` § OnceHub.

## Example queries

```sql
-- Bookings by closer (the round-robin owner), most recent first.
select owner_user_id, status, scheduled_at, invitee_email
from oncehub_bookings
where excluded_at is null
order by scheduled_at desc;

-- No-shows captured via the native event (status may lag; last_event_type won't).
select booking_id, owner_user_id, scheduled_at
from oncehub_bookings
where last_event_type = 'booking.no_show' and excluded_at is null;
```
