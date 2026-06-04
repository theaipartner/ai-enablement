-- 0074_client_channel_signals_fn.sql
-- Generalize ghost_client_candidates (0072/0073) into client_channel_signals.
--
-- The same per-active-client / per-channel aggregate now feeds two dashboard
-- sections: Ghost (channel_has_messages=true + silent) and Channel flags
-- (channel_has_messages=false → the bot/Ella isn't in the channel, so we have
-- no visibility). Adds slack_channel_id + channel_name so the Channel-flags
-- list can name the channel. Renamed for accuracy; drop the old function.

drop function if exists ghost_client_candidates();

create function client_channel_signals()
returns table (
  client_id uuid,
  full_name text,
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
