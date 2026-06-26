-- 0104_outbound_funnel_by_rep.sql
-- Per-rep breakdown for the Outbound page (Revival + Jacob): Dials, Connections,
-- Closes, Cash per rep. Unlike the cohort funnel (which scopes by each lead's
-- campaign-entry anchor), this block is ACTIVITY-scoped — it answers "what did
-- each rep DO in the selected window," counting calls by their activity_at and
-- closes by their form date, regardless of when the lead entered. (Drake: for
-- per-rep we want "how many closes did they get today," not "for leads that
-- entered today.")
--
-- One combined row per rep bridges two systems via team_members:
--   - Dials/Connections come from close_calls.user_id  -> team_members.close_user_id
--   - Closes/Cash come from closer_record_ids          -> team_members.airtable_user_id
-- A rep mapped on both sides (e.g. Connor Malewicz) merges into one row. Reps not
-- in team_members (e.g. a bulk "export" account, or a not-yet-added person) fall
-- back to their raw name as their own row — nobody is dropped. Activity-scoping
-- naturally excludes departed reps whose only calls predate the campaign.
--
--   Dials       = outbound calls on the campaign's leads in [p_start, p_end)
--   Connections = calls >= 90s (either direction) on those leads in-window
--   Closes      = DC-close forms (form_type='New' + non-empty dc_plans) in-window
--   Cash        = $300 per DC plan unit on those closes

-- 1. Backfill the one missing closer bridge so Sierra's dials and closes merge
--    (she's in team_members with a close_user_id but her airtable_user_id was
--    never set — there's no airtable-user sync yet). recIPX… is the "Sierra"
--    closer record in the Airtable closer reports.
update team_members
   set airtable_user_id = 'recIPXrHdsUfyP0jF'
 where full_name = 'Sierra Anderson'
   and airtable_user_id is null;

-- 2. Per-rep RPC. p_start/p_end are required (the page always passes its range).
create or replace function outbound_funnel_by_rep(
  p_campaign_key text,
  p_start timestamptz,
  p_end timestamptz
)
returns jsonb language sql stable as $$
with leads as (
  select close_id from outbound_lead_facts where campaign_key = p_campaign_key
),
calls as (
  select cc.user_id,
    max(cc.raw_payload ->> 'user_name') as user_name,
    count(*) filter (where cc.direction = 'outbound') as dials,
    count(*) filter (where cc.duration >= 90)         as connections
  from close_calls cc
  join leads l on l.close_id = cc.lead_id
  where cc.activity_at >= p_start and cc.activity_at < p_end
    and cc.user_id is not null  -- drop system/unattributed calls
  group by cc.user_id
),
calls_rep as (
  select coalesce(tm.id::text, ca.user_id)                        as rep_key,
         coalesce(tm.full_name, ca.user_name, ca.user_id)         as rep_name,
         sum(ca.dials)::int as dials, sum(ca.connections)::int as connections
  from calls ca
  left join team_members tm on tm.close_user_id = ca.user_id
  group by 1, 2
),
-- One row per (closer, close-form). A lead can have >1 plan-form (e.g. Base +
-- Wix), so closes = distinct LEADS (deals) while cash sums every plan unit.
closes_raw as (
  select t.rid, t.nm, f.lead_id,
    (select count(*) from unnest(coalesce(f.dc_plans,'{}'::text[])) p where trim(p) <> '') as units
  from airtable_full_closer_report f
  join leads l on l.close_id = f.lead_id
  cross join lateral unnest(f.closer_record_ids, f.closer_names) as t(rid, nm)
  where f.form_type = 'New' and f.digital_college_closed = 'Yes'
    and f.airtable_created_at >= p_start and f.airtable_created_at < p_end
    -- A DC-closed form with NO plan is a show, not a close (matches the funnel).
    and (select count(*) from unnest(coalesce(f.dc_plans,'{}'::text[])) p where trim(p) <> '') > 0
),
closes_rep as (
  select coalesce(tm.id::text, cr.rid, cr.nm)  as rep_key,
         coalesce(tm.full_name, cr.nm)         as rep_name,
         count(distinct cr.lead_id)::int       as closes,
         (coalesce(sum(cr.units), 0) * 300)::int as cash
  from closes_raw cr
  left join team_members tm on tm.airtable_user_id = cr.rid
  group by 1, 2
),
merged as (
  select
    coalesce(cl.rep_key, co.rep_key)   as rep_key,
    coalesce(cl.rep_name, co.rep_name) as rep_name,
    coalesce(cl.dials, 0)       as dials,
    coalesce(cl.connections, 0) as connections,
    coalesce(co.closes, 0)      as closes,
    coalesce(co.cash, 0)        as cash
  from calls_rep cl
  full outer join closes_rep co on cl.rep_key = co.rep_key
)
select coalesce(jsonb_agg(jsonb_build_object(
    'rep', rep_name, 'dials', dials, 'connections', connections,
    'closes', closes, 'cash', cash
  ) order by closes desc, cash desc, connections desc, dials desc), '[]'::jsonb)
from merged
where closes > 0;  -- only reps who actually closed (drops bulk/system + dialer-only rows)
$$;

comment on function outbound_funnel_by_rep(text, timestamptz, timestamptz) is
  'Activity-scoped per-rep Outbound breakdown (dials/connections/closes/cash) for the Outbound page. Bridges close_calls (close_user_id) and closer reports (airtable_user_id) via team_members.';
