-- 0086_engagements.sql
-- Engagement tracking: one row per "engagement" — a rep's cluster of calls to a
-- lead (back-to-back redials collapse in) toward one disposition/form. Sticky
-- tag-timestamps (opened_at / overdue_at / final_at), mirroring lead_cycle_stages:
-- each is set ONCE and never cleared; the current state is read from the tags
--   final_at set        -> FINAL
--   overdue_at set, no final -> OVERDUE (currently pinging)
--   final_at null       -> still owed
-- Writers: the Close call webhook (open/grow), the Airtable form webhook (final),
-- and a cron (flip overdue + ping). See docs/schema/engagements.md.

create table if not exists public.engagements (
  id              uuid primary key default gen_random_uuid(),

  -- identity
  lead_id         text not null,                      -- Close lead (close_leads.close_id)
  rep_user_id     text not null,                      -- Close user_id of the caller
  rep_name        text,                               -- denormalized caller name (raw_payload.user_name)
  rep_slack_id    text,                               -- resolved via team_members, for the @-mention

  -- the calls in the engagement
  anchor_call_id  text not null,                      -- the >=90s call that OPENED it (close_calls.close_id)
  call_ids        text[] not null default '{}',       -- every call that joined the rolling 45-min window
  anchor_at       timestamptz not null,               -- seed-call time -> the "call at this time" in the ping
  last_call_at    timestamptz not null,               -- most recent call; drives the 45-min freeze

  -- the sticky tags (set once, never cleared)
  opened_at       timestamptz not null default now(), -- OPEN
  overdue_at      timestamptz,                        -- OVERDUE (45-min silence passed, no form)
  final_at        timestamptz,                        -- FINAL   (a form linked)

  -- the form
  form_id         text,                               -- linked Airtable form record_id (null until final)
  form_table      text,                               -- which Airtable form table it came from

  -- ping bookkeeping
  last_pinged_at  timestamptz,
  ping_count      integer not null default 0,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Webhook hot path: find/grow the open engagement for a (lead, rep).
create index if not exists engagements_lead_rep_idx on public.engagements (lead_id, rep_user_id);
-- Cron hot path + accountability read: engagements still awaiting a form.
create index if not exists engagements_awaiting_idx on public.engagements (overdue_at) where final_at is null;
-- Reverse lookup: which engagement holds a given call.
create index if not exists engagements_call_ids_gin on public.engagements using gin (call_ids);
-- Reverse lookup / dedup by linked form.
create index if not exists engagements_form_id_idx on public.engagements (form_id) where form_id is not null;

-- updated_at maintenance (matches the mirror tables' convention).
create or replace function public.engagements_set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists engagements_set_updated_at on public.engagements;
create trigger engagements_set_updated_at
  before update on public.engagements
  for each row execute function public.engagements_set_updated_at();
