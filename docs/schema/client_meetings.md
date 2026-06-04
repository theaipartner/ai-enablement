# client_meetings

Durable, per-client record of meetings sourced from Google Calendar. This is
the source of truth for the per-client **meetings this month** metric and the
month-by-month history on the client page — both of which drive CSM pay.

Distinct from `calendar_events` (the `/teams` Meeting Tracker's rolling
current-week cache): `client_meetings` persists indefinitely and is attributed
to a **client**, not a CSM.

## Purpose

A meeting is attributed to a client when that client's email — its `email`
column or any `metadata.alternate_emails` entry — appears as an attendee on a
CSM's calendar event that has at least one external attendee. Meetings whose
external attendee matches no known client (e.g. prospects) are ignored; nothing
is auto-created here.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | `gen_random_uuid()` |
| `client_id` | uuid NOT NULL | FK → `clients.id`, `on delete cascade` |
| `team_member_id` | uuid | FK → `team_members.id`, `on delete set null`. The CSM whose calendar the event came from. |
| `google_event_id` | text NOT NULL | Google Calendar event id. Stable across attendees' calendars. |
| `calendar_id` | text | The CSM email the event was read from. |
| `title` | text | Event summary. |
| `start_time` | timestamptz NOT NULL | Meeting start (UTC). Counted in EST months by the read layer. |
| `end_time` | timestamptz | Meeting end. |
| `attendee_email` | text | The client attendee email that matched. |
| `synced_at` | timestamptz NOT NULL | Last cron touch. |
| `created_at` | timestamptz NOT NULL | First insert. |

**Unique:** `(client_id, google_event_id)` — a group call with two known
clients yields one row per client; re-syncs are idempotent upserts.

**Indexes:** `(client_id, start_time desc)` for per-client rollups;
`(start_time)` for the all-clients current-month scan.

## What populates it

`api/client_meetings_sync_cron.py`, daily at `30 4 * * *` UTC (≈11:30pm EST /
12:30am EDT). See `docs/runbooks/client_meetings_sync.md`. The cron reconciles a
rolling **14-day** lookback: events deleted or moved in Google within 14 days
are removed here; rows older than 14 days are frozen (final for pay).
Reconciliation is skipped on any run where a CSM calendar fetch errored, to
avoid deleting meetings that merely failed to fetch.

## What reads from it

- `lib/db/client-meetings.ts`
  - `getCurrentMonthMeetingCounts()` — `client_id → count` for the current EST
    month; powers the clients-list **meetings this month** column.
  - `getClientMeetingMonths(clientId, months=12)` — newest-first per-EST-month
    series; powers `meetings_this_month` + the month picker on the client page.
- `lib/db/clients.ts` consumes both (replacing the prior Fathom-calls count).
- `components/client-detail/meetings-month-picker.tsx` renders the picker.

## Example queries

```sql
-- This month's meetings for one client (EST month boundary computed app-side)
select count(*) from client_meetings
where client_id = '...' and start_time >= '2026-06-01T04:00:00Z';

-- Per-month history for a client
select date_trunc('month', start_time at time zone 'America/New_York') as m,
       count(*)
from client_meetings where client_id = '...'
group by 1 order by 1 desc;
```
