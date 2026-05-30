-- 0061_calendly_event_soft_hide.sql
--
-- Creator-only "hide test booking" on the Closing page's per-closer
-- scheduled-calls drill (sales-dashboard → Funnel → Closing). A test
-- Calendly booking shows up as a row in the closer drill; the creator
-- can × it out.
--
-- Mirrors migration 0059 (triage-call soft-hide) but on the booking
-- source. The closer drill is keyed off calendly_scheduled_events
-- (CloserScheduledDrillRow.eventUri = the event URI), so the hide lives
-- on the event row, not the closer form. (0060 was taken by the
-- close_leads soft-hide; this is the next free number.)
--
-- Why soft-hide (not delete): calendly_scheduled_events is a mirror
-- (webhook + cron, upsert-only, no delete pass). A hard DELETE would be
-- re-created on the next sync. excluded_at survives because the Calendly
-- ingestion parser only writes its own columns and never touches this.
--
-- getClosingScheduledList filters `excluded_at is null` on its
-- calendly_scheduled_events read, so a hidden event drops out of BOTH
-- the per-closer drill and the per-closer aggregates (both derive from
-- that one read).
--
-- Scope note: other surfaces that read calendly_scheduled_events (the
-- Closing page's top "Calendly bookings" tiles, the funnel pulse) do NOT
-- yet filter this — extend per-surface if that's wanted later.

alter table calendly_scheduled_events
  add column if not exists excluded_at timestamptz,
  add column if not exists excluded_by text;

comment on column calendly_scheduled_events.excluded_at is
  'Soft-hide timestamp. Non-null = the booking was marked a test/bad entry and is excluded from the Closing per-closer drill + aggregates. Set by the creator-only "×" action; survives Calendly re-sync because ingestion never writes this column. Null = visible (normal).';

comment on column calendly_scheduled_events.excluded_by is
  'team_members.email of the creator who hid this booking (audit trail). Null when not excluded.';
