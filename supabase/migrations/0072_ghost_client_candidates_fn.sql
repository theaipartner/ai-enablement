-- 0072_ghost_client_candidates_fn.sql
-- Read-only helper for the dashboard "Ghost" client flag.
--
-- The dashboard needs, per active client, the timestamp of their most recent
-- Slack message (author_type='client') in their channel. Doing this from the
-- app layer required fetching a window of slack_messages and reducing in JS —
-- but PostgREST caps any single fetch at 1000 rows, so with ~80 client
-- messages/day the reducer silently saw only a slice and wrongly flagged
-- actively-messaging clients as ghosts. Pushing the per-channel max() into
-- Postgres removes the cap entirely: one row per active client, computed
-- against the (slack_channel_id, sent_at desc) index.
--
-- Business logic (14-day threshold, channel-age guard, dismissal) stays in
-- lib/db/fulfillment-dashboard.ts getGhostClientFlags(); this function only
-- supplies the raw aggregates. SECURITY INVOKER + accessed only via the
-- service role from the server.

create or replace function ghost_client_candidates()
returns table (
  client_id uuid,
  full_name text,
  channel_created_at timestamptz,
  last_client_message_at timestamptz,
  ghost_dismissed_at timestamptz
)
language sql
stable
as $$
  select
    c.id,
    c.full_name,
    sc.created_at as channel_created_at,
    (
      select max(sm.sent_at)
      from slack_messages sm
      where sm.slack_channel_id = sc.slack_channel_id
        and sm.author_type = 'client'
    ) as last_client_message_at,
    nullif(c.metadata->>'ghost_dismissed_at', '')::timestamptz as ghost_dismissed_at
  from clients c
  -- The client's current channel: most recently created non-archived one.
  join lateral (
    select slack_channel_id, created_at
    from slack_channels
    where client_id = c.id and is_archived = false
    order by created_at desc
    limit 1
  ) sc on true
  where c.status = 'active'
    and c.archived_at is null;
$$;
