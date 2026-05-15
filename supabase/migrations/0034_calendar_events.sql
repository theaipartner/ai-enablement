-- Calendar event cache. Populated by the Teams Meeting Tracker's
-- 30-minute cron sync (api/teams_calendar_sync_cron.py); read by the
-- /teams page server-side. The page never calls Google directly at
-- render time — fast load + soft-fail on Calendar API outages.
--
-- One row per (team_member, google_event_id). The unique index is the
-- upsert key. start_time-by-team_member is a secondary index because
-- the page reads "this week's events for this CSM" on every render.
--
-- attendees stores a JSONB array of {email, displayName} pairs (or
-- partial subsets when Google returns less). raw_payload preserves
-- the full Calendar API response so future schema growth or
-- debugging doesn't require re-fetching.
--
-- Spec: docs/specs/teams-meeting-tracker.md.

CREATE TABLE calendar_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_member_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  google_event_id text NOT NULL,
  calendar_id text NOT NULL,
  title text,
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL,
  attendees jsonb NOT NULL DEFAULT '[]'::jsonb,
  meeting_link text,
  raw_payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX calendar_events_team_event_idx
  ON calendar_events (team_member_id, google_event_id);

CREATE INDEX calendar_events_start_time_idx
  ON calendar_events (team_member_id, start_time);
