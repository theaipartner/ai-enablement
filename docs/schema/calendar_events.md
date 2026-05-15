# calendar_events

Cached Google Calendar events per team member. Populated by the Teams Meeting Tracker's 30-minute sync cron; read by the `/teams` page server-side at render time.

## Purpose

Local mirror of every CSM's current-week meetings so the `/teams` page never calls Google's API at render time. Survives Calendar API outages — when Google is down, the page renders the most recently cached events with a slightly stale `fetched_at`. Soft-fail by design.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | PK, default `gen_random_uuid()` |
| `team_member_id` | `uuid` | Not null. FK → `team_members.id` ON DELETE CASCADE |
| `google_event_id` | `text` | Not null. Google's stable event id; the upsert key |
| `calendar_id` | `text` | Not null. The Calendar API `calendarId` used to fetch — today, the CSM's primary calendar email |
| `title` | `text` | Optional. Google `summary` field |
| `start_time` | `timestamptz` | Not null. Event start; the indexed time-filter column |
| `end_time` | `timestamptz` | Not null. Event end |
| `attendees` | `jsonb` | Not null, default `'[]'`. Array of `{email, displayName}` pairs. Resource calendars dropped during upsert |
| `meeting_link` | `text` | Optional. Google Meet link if present (prefers `hangoutLink`, falls back to `conferenceData.entryPoints[type=video].uri`) |
| `raw_payload` | `jsonb` | Not null. Full Calendar API event response — preserves attributes we haven't promoted to columns |
| `fetched_at` | `timestamptz` | Default `now()`. Stamped on every cron upsert; tells the UI how fresh the cache is |
| `created_at` | `timestamptz` | Default `now()` |

## Indexes

- `calendar_events_team_event_idx` — `UNIQUE (team_member_id, google_event_id)`. Upsert key.
- `calendar_events_start_time_idx` — `(team_member_id, start_time)`. The `/teams` page's primary query path: "this week's events for this team_member."

## Relationships

- FK to `team_members` via `team_member_id` (cascade delete).
- No FK to `calls`. The Teams page joins these two tables in JS at render time via case-insensitive title equality + ±30 minute time window against `calls.title` + `calls.started_at`. Title is the working V1 join key; a more stable mapping (e.g. Google Meet link → Fathom's link field) is future work.

## Populated By

- `api/teams_calendar_sync_cron.py` — every 30 minutes. Per CSM, pulls `events.list` for the current Mon-Sun EST week, upserts each non-cancelled point-in-time event keyed by `(team_member_id, google_event_id)`. Cancelled events + all-day events (no `start.dateTime`) are dropped. **External-attendee filter (2026-05-15):** also dropped at upsert time are events with zero non-`@theaipartner.io` attendees — OOO blocks, focus time, internal-only 1:1s. Only events with at least one external attendee land in the table. See `_has_external_attendee` in the cron and `docs/specs/teams-calendar-external-attendee-filter.md`.

## Read By

- `lib/db/teams.ts:getTeamsThisWeek` — the `/teams` page's primary data fetch.

## Maintenance

- No automatic pruning in V1. Rows pile up over weeks; at four CSMs × ~30 events/week × 52 weeks = ~6k rows/year. Trivial.
- A future cleanup cron could prune anything older than, say, the trailing 90 days. Not in scope today.

## Example Queries

Lou's meetings for this week:

```sql
select google_event_id, title, start_time, end_time, attendees
from calendar_events
where team_member_id = (select id from team_members where email = 'lou@theaipartner.io')
  and start_time >= date_trunc('week', now() at time zone 'America/New_York')
  and start_time < date_trunc('week', now() at time zone 'America/New_York') + interval '7 days'
order by start_time;
```

Most-recent sync timestamp per CSM (audit query):

```sql
select team_member_id, max(fetched_at) as last_synced
from calendar_events
group by team_member_id
order by last_synced desc;
```

## Spec

`docs/specs/teams-meeting-tracker.md`, migration `0034_calendar_events.sql`.
