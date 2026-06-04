-- 0073_ghost_candidates_has_messages.sql
-- Extend ghost_client_candidates (migration 0072) with channel_has_messages.
--
-- The Slack Events API only delivers messages from channels the bot is a
-- member of, so a client channel with ZERO ingested messages of any kind
-- means the bot isn't in it — we have no visibility and must not call the
-- client a "ghost". getGhostClientFlags() excludes these. As soon as the bot
-- is added and a message ingests, channel_has_messages flips true and the
-- client becomes eligible for the flag again.

-- Adding an OUT column changes the return signature, which create-or-replace
-- can't do — drop first.
drop function if exists ghost_client_candidates();

create function ghost_client_candidates()
returns table (
  client_id uuid,
  full_name text,
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
    select slack_channel_id, created_at
    from slack_channels
    where client_id = c.id and is_archived = false
    order by created_at desc
    limit 1
  ) sc on true
  where c.status = 'active'
    and c.archived_at is null;
$$;
