# oncehub_bookings

Raw mirror of OnceHub v2 bookings. One row per booking, `booking_id`-keyed,
idempotent (upsert). Migration `0092_oncehub_bookings.sql`.

## Purpose

The OnceHub booking mirror. OnceHub **replaces Calendly** as the scheduling platform
(additive — the dashboard reads Calendly + OnceHub). The dashboard reads THIS table,
never `api.oncehub.com` directly (core principle #1/#3). The persisted `booking_cycles`
spine is **shelved** — read-time reconstruction + `lead_cycles` cover the booking→close
linkage (see `docs/sales/booking-to-close.md` for the decision + revisit trigger).

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
| `owner_user_id` | **the rep the round-robin landed on** (`USR-…`). The per-closer Books attribution that had no reliable source pre-OnceHub. Resolved owner→closer in `lib/db/oncehub-bookings.ts`. |
| `master_page_id` | `BP-MVKDFLP85W` ("AI Partner - FB" funnel) → **direct**. Checked FIRST (a direct booking also carries a partnership `booking_page` underneath). |
| `booking_page_id` | `BP-UBK4DVGWFX` (Aman) / `BP-182H3QCWET` (Cobe) "Partnership Call w/" → **setter**, but only when `master_page_id` is NULL. |
| `booking_calendar_id` | `BKC-…` — `BKC-0NJDVMLVJK` = "Ai Partner Strategy Call" (team, direct); "Meeting with X" calendars = internal (dropped). |
| `invitee_name`/`_email`/`_phone` | from `form_submission` — **null on admin/reschedule-created bookings**; populated on real form bookings. Lead-match fallback. |
| `lead_id` | Close lead_id from the hidden custom field. **Null until the hidden field is configured in OnceHub** + links carry `?lead_id=`. Tamperable — validate against `close_leads` before trusting. |
| `custom_fields` | the raw `custom_fields` array (top-level + `form_submission`, merged). |
| `rescheduled_booking_id` | prior booking this one replaced (reschedule lineage). |
| `canceled_by`/`cancel_user_id`/`cancel_reason` | from `cancel_reschedule_information`. |
| `last_event_type` | last webhook `type` seen. |
| `raw_payload` | the full booking object (nothing lost). |
| `excluded_at` | creator-only soft-hide; the parser NEVER writes it. |

## Reads from it

All via the read foundation `lib/db/oncehub-bookings.ts` (classify role → resolve
booking→lead → resolve owner→closer), unioned **additively** with Calendly:

- **`shared/lead_tagging.py`** (the tagger) — OnceHub **direct** bookings feed the
  `lead_cycles` "booked" signal (setter rides the triage form). Lights up the funnel,
  roster, and per-lead booked stage via the materialized `lead_cycle_stages`.
- **`lib/db/funnel-closing.ts`** — the Talent booking tiles + per-closer scheduled tables
  (owner → the same `closerIdentity` as a Calendly host).
- **`lib/db/lead-detail.ts`** — the per-lead journey timeline + booked stage.
- **`lib/db/ceo-missing-forms.ts`** — the missing-form flagger.

## Live OnceHub config (2026-06-20)

v2 account. Team **Closers** (`TM-LHNGDXC42R59`: Cobe, Aman). **Direct:** team-hosted
**"Ai Partner Strategy Call"** calendar (`BKC-0NJDVMLVJK`, round-robin) behind the master
page **"AI Partner - FB"** (`BP-MVKDFLP85W`, `go.oncehub.com/AIPartner-FB`). **Setter:**
per-closer **"Partnership Call w/ {Aman,Cobe}"** pages (`BP-UBK4DVGWFX` / `BP-182H3QCWET`).
A second webhook → make.com (Zain's) coexists with ours. See `docs/sales/ingestion.md` §
OnceHub.

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
