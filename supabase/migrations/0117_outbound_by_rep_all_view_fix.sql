-- 0117_outbound_by_rep_all_view_fix.sql
-- Second-order fix to outbound_funnel_by_rep. 0116 restored the { reps, totals }
-- shape but rebuilt the leads CTE from 0105 (`where campaign_key = p_campaign_key`)
-- — missing that 0108 had changed it to `(p_campaign_key is null or campaign_key =
-- p_campaign_key)` for the "All" view (the page passes p_campaign_key = NULL for
-- the combined view). So 0116 left the **All** per-rep table empty (a NULL key
-- matched no facts). Root cause both times: redefining the function against an
-- older migration than the latest one that touched it (the latest was 0108, not
-- 0105/0104).
--
-- This is the canonical definition: 0108's body (incl. the NULL = all-campaigns
-- handling) + 0115's GHL call arm. Per-campaign (Revival, Jacob, any new-model
-- campaign) AND the All view all return { reps, totals } with the per-rep forms.

create or replace function outbound_funnel_by_rep(
  p_campaign_key text,
  p_start timestamptz,
  p_end timestamptz
)
returns jsonb language sql stable as $$
with leads as (
  -- NULL p_campaign_key = the "All" view → every campaign's facts (migration 0108).
  select close_id from outbound_lead_facts where (p_campaign_key is null or campaign_key = p_campaign_key)
),
calls as (
  select cc.user_id,
    max(cc.raw_payload ->> 'user_name') as user_name,
    count(*) filter (where cc.direction = 'outbound') as dials,
    count(*) filter (where cc.duration >= 90)         as connections
  from close_calls cc
  join leads l on l.close_id = cc.lead_id
  where cc.activity_at >= p_start and cc.activity_at < p_end
    and cc.user_id is not null
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
-- GHL call arm (0115): outbound calls from ghl_messages, rep via ghl_user_id.
calls_ghl as (
  select gm.user_id,
    count(*) filter (where gm.direction = 'outbound') as dials,
    count(*) filter (where gm.call_status = 'completed' and gm.call_duration >= 90) as connections
  from ghl_messages gm
  join leads l on l.close_id = gm.contact_id
  where gm.message_type = 'TYPE_CALL'
    and gm.date_added >= p_start and gm.date_added < p_end
    and gm.user_id is not null
  group by gm.user_id
),
calls_ghl_rep as (
  select coalesce(tm.id::text, 'ghl:' || cg.user_id) as rep_key,
         coalesce(tm.full_name, cg.user_id)          as rep_name,
         sum(cg.dials)::int as dials, sum(cg.connections)::int as connections
  from calls_ghl cg
  left join team_members tm on tm.ghl_user_id = cg.user_id
  group by 1, 2
),
calls_all as (
  select rep_key, rep_name, sum(dials)::int as dials, sum(connections)::int as connections
  from (select * from calls_rep union all select * from calls_ghl_rep) u
  group by rep_key, rep_name
),
-- DC-close forms in window (with a plan; a no-plan form is a show, not a close).
dc_forms as (
  select f.lead_id, f.closer_record_ids, f.closer_names, f.dc_plans
  from airtable_full_closer_report f
  join leads l on l.close_id = f.lead_id
  where f.form_type = 'New' and f.digital_college_closed = 'Yes'
    and f.airtable_created_at >= p_start and f.airtable_created_at < p_end
    and (select count(*) from unnest(coalesce(f.dc_plans,'{}'::text[])) p where trim(p) <> '') > 0
),
closes_raw as (
  select t.rid, t.nm, f.lead_id,
    (select count(*) from unnest(coalesce(f.dc_plans,'{}'::text[])) p where trim(p) <> '') as units
  from dc_forms f
  cross join lateral unnest(f.closer_record_ids, f.closer_names) as t(rid, nm)
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
  from calls_all cl
  full outer join closes_rep co on cl.rep_key = co.rep_key
),
plan_units as (
  select p from dc_forms f cross join lateral unnest(coalesce(f.dc_plans,'{}'::text[])) p where trim(p) <> ''
)
select jsonb_build_object(
  'reps', (
    select coalesce(jsonb_agg(jsonb_build_object(
        'rep', rep_name, 'dials', dials, 'connections', connections,
        'closes', closes, 'cash', cash
      ) order by closes desc, cash desc, connections desc, dials desc), '[]'::jsonb)
    from merged where closes > 0
  ),
  'totals', jsonb_build_object(
    'closes',        (select count(distinct lead_id) from dc_forms),
    'base44Monthly', (select coalesce(sum((lower(p) like '%base%' and lower(p) like '%month%')::int),0) from plan_units),
    'base44Yearly',  (select coalesce(sum((lower(p) like '%base%' and (lower(p) like '%year%' or lower(p) like '%annual%'))::int),0) from plan_units),
    'wixMonthly',    (select coalesce(sum((lower(p) like '%wix%' and lower(p) like '%month%')::int),0) from plan_units),
    'wixYearly',     (select coalesce(sum((lower(p) like '%wix%' and (lower(p) like '%year%' or lower(p) like '%annual%'))::int),0) from plan_units)
  )
);
$$;
