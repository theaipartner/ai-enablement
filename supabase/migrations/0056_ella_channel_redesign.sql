-- 0056_ella_channel_redesign.sql
-- Ella three-channel redesign — schema support.
--
-- Two unrelated-but-bundled column adds for the redesign that routes
-- all Ella flagging to channels (no DMs):
--
-- 1. pending_digest_items.open_ended — the passive Haiku now emits a
--    second signal alongside digest_flag. open_ended=true marks a
--    client message that is open-ended / awaiting a human reply
--    (questions, requests, emotional-hanging), as opposed to closers,
--    gratitude (incl. "thanks so much, appreciate it!"), and pure
--    acknowledgments. The unanswered-channels cron filters its 2h scan
--    to open_ended=true so only genuinely-awaiting messages surface;
--    the daily digest is unchanged (it reads the broad digest_flag
--    set). Nullable — historical rows predate the signal and stay out
--    of the unanswered scan (safe under-flag during the transition).
--
-- 2. calendar_events.missing_recording_posted_at — dedup stamp for the
--    new missed-recording cron (api/cs_missed_recording_cron.py). When
--    a calendar event's end_time + 30min passes with no matching
--    Fathom call, the cron posts "[title] — recording not available"
--    to cs-call-summaries and stamps this column so the same event
--    never re-posts. The 30-minute teams_calendar_sync upsert does NOT
--    write this column, so its payload-scoped ON CONFLICT update leaves
--    the stamp intact across re-syncs.

ALTER TABLE pending_digest_items
  ADD COLUMN open_ended boolean;

ALTER TABLE calendar_events
  ADD COLUMN missing_recording_posted_at timestamptz;

-- Partial index for the missed-recording cron's scan: events whose
-- recording grace period may have lapsed, not yet posted. Filtered to
-- missing_recording_posted_at IS NULL so the index stays small as
-- posted rows accumulate.
CREATE INDEX calendar_events_missing_recording_scan_idx
  ON calendar_events (end_time)
  WHERE missing_recording_posted_at IS NULL;
