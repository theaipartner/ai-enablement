-- 0040_pending_digest_items.sql
-- Ella daily-digest queue.
--
-- Backs the new daily digest DM to Scott (head of fulfillment) + Drake
-- covering every message Ella's decision Haiku flagged across all
-- monitored channels (spec: docs/specs/ella-architecture-refactor-and-
-- daily-digest.md). Each row is inserted when the passive- or
-- reactive-path decision Haiku sets `digest_flag=true` on a message.
-- `api/ella_daily_digest_cron.py` drains all unsent rows in a 24h
-- window once daily, groups by client, formats a digest body, and
-- posts it to the recipients. `agents/ella/passive_dispatch.py`
-- (passive path) and `agents/ella/agent.py` (reactive path) populate
-- it.
--
-- Insert-once + a single `sent_in_digest_at` update; no updated_at
-- trigger needed. The unique index on (slack_channel_id,
-- triggering_message_ts) is the dedup key — same shape as
-- pending_ella_responses — so a re-processed message (Slack event
-- redelivery, message_changed, etc.) doesn't double-flag.
--
-- `agent_run_id` FK CASCADE: the digest item is dependent on its
-- source run; if the run is deleted (rare — typically only test
-- cleanup) the digest item goes with it. `client_id` FK SET NULL:
-- the digest is an audit-shaped surface and the row must survive a
-- client deletion.
--
-- `digest_category` is a free-text column (no enum CHECK) so new
-- categories can be added without a migration.
--
-- Spec: docs/specs/ella-architecture-refactor-and-daily-digest.md.

CREATE TABLE pending_digest_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_run_id uuid REFERENCES agent_runs(id) ON DELETE CASCADE,
  slack_channel_id text NOT NULL,
  triggering_message_ts text NOT NULL,
  triggering_message_slack_user_id text,
  client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
  message_text text,
  haiku_decision text NOT NULL,
  haiku_reasoning text,
  digest_category text,
  ella_responded boolean NOT NULL DEFAULT false,
  sent_in_digest_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX pending_digest_items_dedup_idx
  ON pending_digest_items (slack_channel_id, triggering_message_ts);

CREATE INDEX pending_digest_items_unsent_idx
  ON pending_digest_items (created_at)
  WHERE sent_in_digest_at IS NULL;
