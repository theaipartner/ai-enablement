-- 0075_client_channel_signals_user_id.sql
-- Add slack_user_id to client_channel_signals (0074).
--
-- A client with no slack_user_id can't have their Slack messages attributed
-- to them (author_type resolves against clients.slack_user_id at ingest), so
-- they'd false-flag as a ghost and shouldn't count as "No Ella" either —
-- they belong in the dashboard's "Missing Slack IDs" section until their id
-- is added. Exposing slack_user_id lets getGhostClientFlags /
-- getUninstrumentedChannels exclude them.

drop function if exists client_channel_signals();

create function client_channel_signals()
returns table (
  client_id uuid,
  full_name text,
  slack_user_id text,
  slack_channel_id text,
  channel_name text,
  channel_created_at timestamptz,
  last_client_message_at timestamptz,
  ghost_dismissed_at timestamptz,
  channel_has_messages boolean
)
language sql
stable
as $$
  select
    c.id,
    c.full_name,
    c.slack_user_id,
    sc.slack_channel_id,
    sc.name as channel_name,
    sc.created_at as channel_created_at,
    (
      select max(sm.sent_at)
      from slack_messages sm
      where sm.slack_channel_id = sc.slack_channel_id
        and sm.author_type = 'client'
    ) as last_client_message_at,
    nullif(c.metadata->>'ghost_dismissed_at', '')::timestamptz as ghost_dismissed_at,
    exists (
      select 1 from slack_messages sm2
      where sm2.slack_channel_id = sc.slack_channel_id
    ) as channel_has_messages
  from clients c
  join lateral (
    select slack_channel_id, name, created_at
    from slack_channels
    where client_id = c.id and is_archived = false
    order by created_at desc
    limit 1
  ) sc on true
  where c.status = 'active'
    and c.archived_at is null;
$$;
