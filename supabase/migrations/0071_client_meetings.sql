-- 0071_client_meetings.sql
-- Persistent per-client meeting record sourced from Google Calendar.
--
-- A meeting is attributed to a client when that client's email (or one of
-- its metadata.alternate_emails) appears as an attendee on a CSM's calendar
-- event that has at least one external attendee. This table is the source of
-- truth for the per-client "meetings this month" metric and the
-- month-by-month history shown on the client page — both of which drive CSM
-- pay, so the data must be durable (unlike calendar_events, which is a
-- rolling current-week cache for the /teams tracker).
--
-- Populated by api/client_meetings_sync_cron.py once daily. The cron
-- reconciles a rolling 14-day lookback window: events deleted or moved in
-- Google within 14 days are removed here on the next run; rows whose meeting
-- start_time is older than 14 days are never touched again (frozen — final
-- for pay).
--
-- One row per (client_id, google_event_id): a single group call attended by
-- two known clients yields one row for each client.

create table if not exists client_meetings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  team_member_id uuid references team_members(id) on delete set null,
  google_event_id text not null,
  calendar_id text,
  title text,
  start_time timestamptz not null,
  end_time timestamptz,
  attendee_email text,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (client_id, google_event_id)
);

-- Per-client month rollups (client page history) and the inactivity/last
-- ordering paths hit (client_id, start_time desc).
create index if not exists client_meetings_client_start_idx
  on client_meetings (client_id, start_time desc);

-- The clients-list "meetings this month" aggregation scans by start_time
-- across all clients for the current month.
create index if not exists client_meetings_start_idx
  on client_meetings (start_time);
