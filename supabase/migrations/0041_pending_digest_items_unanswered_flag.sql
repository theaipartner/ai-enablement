-- 0041_pending_digest_items_unanswered_flag.sql
-- Ella unanswered-message flagger — schema support.
--
-- Adds the dedup + audit columns the real-time safety-net cron
-- (api/ella_unanswered_flagger_cron.py) needs. The cron scans
-- pending_digest_items every 15 minutes for rows that aged past 2h
-- without any team_member message in the source channel and posts
-- them to #unanswered-channels. This is a layer ON TOP of the daily
-- digest (0040) — independent state, no conflict with
-- sent_in_digest_at.
--
-- Spec: docs/specs/ella-unanswered-message-flagger.md.
--
-- Column semantics:
--   unanswered_posted_at            — dedup key. NULL = still eligible
--                                     for the 2h check. Set when the
--                                     cron either posts the item OR
--                                     marks it resolved-before-post.
--   unanswered_post_slack_channel_id / unanswered_post_slack_ts
--                                   — where the channel post landed.
--                                     Both NULL with a non-NULL
--                                     unanswered_posted_at means
--                                     "resolved before post" (a human
--                                     responded within the window).
--
-- Free-text channel/ts strings (same convention as the rest of the
-- table) — no CHECK constraints, no enums.

ALTER TABLE pending_digest_items
  ADD COLUMN unanswered_posted_at timestamptz,
  ADD COLUMN unanswered_post_slack_channel_id text,
  ADD COLUMN unanswered_post_slack_ts text;

-- Partial index for the cron's scan query: unposted items ordered by
-- age. Filtered to unanswered_posted_at IS NULL so the index stays
-- small as historical posted/resolved rows accumulate.
CREATE INDEX pending_digest_items_unanswered_scan_idx
  ON pending_digest_items (created_at)
  WHERE unanswered_posted_at IS NULL;
