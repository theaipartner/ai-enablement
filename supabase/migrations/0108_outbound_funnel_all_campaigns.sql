-- 0108_outbound_funnel_all_campaigns.sql
-- Add an "All" view to the Outbound page. The page's campaign dropdown gains an
-- "All" option (default) alongside Revival / Jacob. When "All" is selected the
-- page passes p_campaign_key = NULL, and both funnel RPCs then aggregate across
-- EVERY campaign's leads (pools are mutually exclusive — migration 0103 — so
-- "All" is a clean union, no double-counting). Only change vs the prior defs:
-- `campaign_key = p_campaign_key` -> `(p_campaign_key is null or campaign_key = p_campaign_key)`.

CREATE OR REPLACE FUNCTION public.outbound_funnel(p_campaign_key text DEFAULT 'revival'::text, p_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_end timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
with f as (
  select * from outbound_lead_facts
  where (p_campaign_key is null or campaign_key = p_campaign_key)
    and (p_start is null or anchor >= p_start)
    and (p_end is null or anchor < p_end)
),
roll as (
  select
    closed,
    (showed or closed) as showed,
    (booked or showed or closed) as booked,
    (call90 or booked or showed or closed) as connected,
    (any_call or call90 or booked or showed or closed) as called,
    (has_inbound or any_call or call90 or booked or showed or closed) as responded,
    booked_dc, booked_ht
  from f
),
speed as (
  select extract(epoch from (first_dial - first_reply)) / 60.0 as mins, call90 as conn
  from f where first_dial is not null and first_reply is not null
),
sb as (
  select case when mins<5 then 0 when mins<15 then 1 when mins<30 then 2 when mins<60 then 3
    when mins<120 then 4 when mins<360 then 5 when mins<1440 then 6 else 7 end as idx, conn from speed
),
sb_lbl(idx, label) as (values (0,'<5m'),(1,'5–15m'),(2,'15–30m'),(3,'30–60m'),(4,'1–2h'),(5,'2–6h'),(6,'6–24h'),(7,'>24h'))
select jsonb_build_object(
  'activeFrom', (select min(anchor) from outbound_lead_facts where (p_campaign_key is null or campaign_key = p_campaign_key)),
  'activeTo',   (select max(anchor) from outbound_lead_facts where (p_campaign_key is null or campaign_key = p_campaign_key)),
  'funnel', jsonb_build_object(
    'leads',        (select count(*) from f),
    'responded',    (select count(*) filter (where responded) from roll),
    'called',       (select count(*) filter (where called) from roll),
    'connected',    (select count(*) filter (where connected) from roll),
    'booked',       (select count(*) filter (where booked) from roll),
    'bookedDc',     (select count(*) filter (where booked_dc) from roll),
    'bookedHt',     (select count(*) filter (where booked_ht) from roll),
    'showed',       (select count(*) filter (where showed) from roll),
    'closed',       (select count(*) filter (where closed) from roll),
    'closedPlans',  (select jsonb_build_object('base44Monthly',coalesce(sum(base44_monthly),0),'base44Yearly',coalesce(sum(base44_yearly),0),'wixMonthly',coalesce(sum(wix_monthly),0),'wixYearly',coalesce(sum(wix_yearly),0)) from f),
    'cashUsd',      (select coalesce(sum(plan_units),0)*300 from f),
    'markedNoPlan', (select coalesce(sum(marked_no_plan),0) from f)
  ),
  'called', jsonb_build_object(
    'responded',      (select count(*) from f where first_reply is not null),
    'called',         (select count(*) from f where first_dial is not null),
    'connected',      (select count(*) from f where call90),
    'notCalled',      (select count(*) from f where first_reply is not null) - (select count(*) from f where first_dial is not null),
    'speedN',         (select count(*) from speed),
    'speedMedianMin', (select round(percentile_cont(0.5) within group (order by mins))::int from speed),
    'buckets',        (select coalesce(jsonb_agg(jsonb_build_object(
                          'label', l.label,
                          'count', (select count(*) from sb where sb.idx = l.idx),
                          'connected', (select count(*) from sb where sb.idx = l.idx and sb.conn)
                        ) order by l.idx), '[]'::jsonb) from sb_lbl l)
  ),
  'timeOfDay', (
    select jsonb_agg(jsonb_build_object(
        'replies',  (select count(*) from f where reply_bucket = b),
        'dials',    (select count(*) from f where dial_bucket = b),
        'connects', (select count(*) from f where conn_bucket = b)
      ) order by b)
    from generate_series(0, 11) b
  )
)
$function$;

CREATE OR REPLACE FUNCTION public.outbound_funnel_by_rep(p_campaign_key text, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
with leads as (
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
  from calls_rep cl
  full outer join closes_rep co on cl.rep_key = co.rep_key
),
-- Unit mix across the same forms (one row per plan line), matching the funnel.
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
$function$;
