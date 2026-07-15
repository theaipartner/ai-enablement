-- 0127_dc_ads_dc_sale_form_closes.sql
-- The DC ads page showed closed=0 while reps were closing. Root cause: DC-ads
-- closes are filed on the DC SALE FORM (airtable_digital_college_sales — the
-- dedicated low-ticket form, one row per pitch), but refresh_dc_ads_facts()
-- and dc_ads_funnel_by_rep only read airtable_full_closer_report. That report
-- has had ZERO DC rows since the full-program suspension (its newest row,
-- 2026-07-07, predates the 7/8 ads launch), so the whole close/show path was
-- dark. Fold the DC sale form into both readers:
--
--   * facts:  a filed DC sale form = the lead was pitched (showed) — same
--             doctrine as lib/db/leads.ts; Closed?=Yes with >=1 plan = a
--             close; Closed?=Yes with NO plan counts as a show only +
--             marked_no_plan (parity with the closer-report no-plan rule,
--             because cash is $300/plan-unit). Blank rows (no outcome, no
--             prospect name, no plans) are dropped, again per leads.ts.
--   * by-rep: closes/cash credit via the form's closer links — the same
--             team_members.airtable_user_id bridge the closer report uses.
--
-- Form timestamps use coalesce(date_time_of_call, airtable_created_at) — the
-- leads.ts stamp — so a back-dated call time lands on the right side of the
-- opt-in anchor. Everything else unchanged from 0126.

create or replace function refresh_dc_ads_facts()
returns integer
language plpgsql
as $function$
declare
  v_count int;
begin
  delete from dc_ads_lead_facts where true;

  insert into dc_ads_lead_facts (
    close_id, anchor, first_reply, has_inbound, any_call, call90, first_dial,
    booked, booked_dc, booked_ht, showed, closed,
    plan_units, base44_monthly, base44_yearly, wix_monthly, wix_yearly, marked_no_plan,
    optin_bucket, dial_bucket, conn_bucket, campaign_id, adset_id, ad_id, updated_at)
  with leads as (
    select cl.close_id,
      -- Anchor at the DC-campaign opt-in: the Meta→Close bridge matches
      -- returning phone numbers to their EXISTING Close lead and re-stamps
      -- latest_opt_in_date — date_created alone would anchor those leads at
      -- their original (pre-campaign) creation. greatest() also covers new
      -- leads, whose latest_opt_in_date is minute-truncated slightly BEFORE
      -- date_created.
      greatest(cl.date_created, coalesce(cl.latest_opt_in_date, cl.date_created)) as anchor,
      cl.campaign_id, cl.adset_id, cl.ad_id
    from close_leads cl
    where cl.excluded_at is null
      and cl.funnel_name = 'Digital College'
      and cl.campaign_id in (select campaign_id from meta_leadgen_campaigns)
  ),
  sms as (
    select l.close_id,
      min(s.activity_at) filter (where s.direction='inbound') as first_reply,
      bool_or(s.direction='inbound') as has_inbound
    from leads l join close_sms s on s.lead_id=l.close_id and s.activity_at >= l.anchor
    group by l.close_id
  ),
  calls as (
    select l.close_id, true as any_call, bool_or(c.duration>=90) as call90,
      min(c.activity_at) as earliest_call,
      min(c.activity_at) filter (where c.duration>=90) as earliest_call90,
      -- Ad opt-in IS the hand-raise: first outbound dial after the opt-in,
      -- no replied-first precondition (unlike outbound).
      min(c.activity_at) filter (where c.direction='outbound') as first_dial
    from leads l join close_calls c on c.lead_id=l.close_id and c.activity_at >= l.anchor
    group by l.close_id
  ),
  triage as (
    select l.close_id,
      bool_or(lower(t.call_status) like '%booking%') as booked,
      bool_or(lower(t.call_status) like '%digital college booking%') as booked_dc,
      bool_or(lower(t.call_status) like '%high ticket booking%') as booked_ht
    from leads l join airtable_setter_triage_calls t on t.lead_id=l.close_id
      and t.excluded_at is null and t.airtable_created_at >= l.anchor
    group by l.close_id
  ),
  cforms as (
    select l.close_id, f.dc_plans as plans,
      case when f.form_type='New'
        then (select count(*) from unnest(coalesce(f.dc_plans,'{}'::text[])) p where trim(p)<>'') > 0
        else lower(coalesce(f.closed,''))='yes' and lower(coalesce(f.payment_plan_type,'')) ~ 'base|wix|digital college'
      end as is_close,
      case when f.form_type='New'
        then coalesce(f.call_outcome,'')<>'' and lower(f.call_outcome) !~ 'ghost|no show|reschedul|cancel'
        else lower(coalesce(f.showed,''))='yes'
      end as is_showed,
      (f.form_type='New'
        and (select count(*) from unnest(coalesce(f.dc_plans,'{}'::text[])) p where trim(p)<>'') = 0
        and lower(coalesce(f.call_outcome,'')) like '%digital college%') as marked_no_plan
    from leads l join airtable_full_closer_report f on f.lead_id=l.close_id and f.airtable_created_at >= l.anchor
  ),
  -- The DC sale form: one row per pitch on these dial-up leads. A filed form
  -- = showed; Closed?=Yes needs >=1 plan to be a close (no-plan Yes = show +
  -- marked_no_plan). Blank rows are Airtable artifacts, not pitches.
  dcsale as (
    select l.close_id, s.plans,
      (lower(coalesce(s.closed,''))='yes'
        and (select count(*) from unnest(coalesce(s.plans,'{}'::text[])) p where trim(p)<>'') > 0) as is_close,
      true as is_showed,
      (lower(coalesce(s.closed,''))='yes'
        and (select count(*) from unnest(coalesce(s.plans,'{}'::text[])) p where trim(p)<>'') = 0) as marked_no_plan
    from leads l join airtable_digital_college_sales s
      on s.lead_id = l.close_id and s.excluded_at is null
      and coalesce(s.date_time_of_call, s.airtable_created_at) >= l.anchor
    where coalesce(s.closed,'') <> ''
       or coalesce(s.prospect_name,'') <> ''
       or (select count(*) from unnest(coalesce(s.plans,'{}'::text[])) p where trim(p)<>'') > 0
  ),
  allforms as (
    select close_id, plans, is_close, is_showed, marked_no_plan from cforms
    union all
    select close_id, plans, is_close, is_showed, marked_no_plan from dcsale
  ),
  closer as (
    select close_id, bool_or(is_showed) as showed, bool_or(is_close) as closed,
      count(*) filter (where marked_no_plan) as marked_no_plan
    from allforms group by close_id
  ),
  plan_per_lead as (
    select af.close_id,
      sum((lower(p) like '%base%' and lower(p) like '%month%')::int) as b44m,
      sum((lower(p) like '%base%' and (lower(p) like '%year%' or lower(p) like '%annual%'))::int) as b44y,
      sum((lower(p) like '%wix%'  and lower(p) like '%month%')::int) as wixm,
      sum((lower(p) like '%wix%'  and (lower(p) like '%year%' or lower(p) like '%annual%'))::int) as wixy
    from allforms af cross join lateral unnest(coalesce(af.plans,'{}'::text[])) p
    where af.is_close group by af.close_id
  )
  select l.close_id, l.anchor,
    sm.first_reply, coalesce(sm.has_inbound,false),
    coalesce(ca.any_call,false), coalesce(ca.call90,false), ca.first_dial,
    coalesce(tr.booked,false), coalesce(tr.booked_dc,false), coalesce(tr.booked_ht,false),
    coalesce(cl.showed,false), coalesce(cl.closed,false),
    coalesce(pp.b44m,0)+coalesce(pp.b44y,0)+coalesce(pp.wixm,0)+coalesce(pp.wixy,0),
    coalesce(pp.b44m,0), coalesce(pp.b44y,0), coalesce(pp.wixm,0), coalesce(pp.wixy,0),
    coalesce(cl.marked_no_plan,0),
    floor(extract(hour from (l.anchor at time zone 'America/New_York'))/2)::smallint,
    case when ca.first_dial is not null then floor(extract(hour from (ca.first_dial at time zone 'America/New_York'))/2)::smallint end,
    case when coalesce(ca.call90,false) then floor(extract(hour from (coalesce(ca.earliest_call90, ca.earliest_call) at time zone 'America/New_York'))/2)::smallint end,
    l.campaign_id, l.adset_id, l.ad_id,
    now()
  from leads l
  left join sms sm on sm.close_id=l.close_id
  left join calls ca on ca.close_id=l.close_id
  left join triage tr on tr.close_id=l.close_id
  left join closer cl on cl.close_id=l.close_id
  left join plan_per_lead pp on pp.close_id=l.close_id;

  get diagnostics v_count = row_count;
  return v_count;
end $function$;


-- Same signature as 0126 — create or replace is safe. Only the dc_forms CTE
-- (close detection) changes: union in the DC sale form's closes.
create or replace function dc_ads_funnel_by_rep(
  p_start timestamptz,
  p_end timestamptz,
  p_campaign_id text default null,
  p_adset_id text default null,
  p_ad_id text default null
)
returns jsonb
language sql
stable
as $function$
with leads as (
  select close_id from dc_ads_lead_facts
  where (p_campaign_id is null or campaign_id = p_campaign_id)
    and (p_adset_id is null or adset_id = p_adset_id)
    and (p_ad_id is null or ad_id = p_ad_id)
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
-- DC closes in window (with a plan; a no-plan form is a show, not a close),
-- from BOTH form sources: the closer report and the DC sale form.
dc_forms as (
  select f.lead_id, f.closer_record_ids, f.closer_names, f.dc_plans as plans
  from airtable_full_closer_report f
  join leads l on l.close_id = f.lead_id
  where f.form_type = 'New' and f.digital_college_closed = 'Yes'
    and f.airtable_created_at >= p_start and f.airtable_created_at < p_end
    and (select count(*) from unnest(coalesce(f.dc_plans,'{}'::text[])) p where trim(p) <> '') > 0
  union all
  select s.lead_id, s.closer_record_ids, s.closer_names, s.plans
  from airtable_digital_college_sales s
  join leads l on l.close_id = s.lead_id
  where lower(coalesce(s.closed,'')) = 'yes' and s.excluded_at is null
    and coalesce(s.date_time_of_call, s.airtable_created_at) >= p_start
    and coalesce(s.date_time_of_call, s.airtable_created_at) < p_end
    and (select count(*) from unnest(coalesce(s.plans,'{}'::text[])) p where trim(p) <> '') > 0
),
closes_raw as (
  select t.rid, t.nm, f.lead_id,
    (select count(*) from unnest(coalesce(f.plans,'{}'::text[])) p where trim(p) <> '') as units
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
plan_units as (
  select p from dc_forms f cross join lateral unnest(coalesce(f.plans,'{}'::text[])) p where trim(p) <> ''
)
select jsonb_build_object(
  'reps', (
    select coalesce(jsonb_agg(jsonb_build_object(
        'rep', rep_name, 'dials', dials, 'connections', connections,
        'closes', closes, 'cash', cash
      ) order by closes desc, cash desc, connections desc, dials desc), '[]'::jsonb)
    from merged where dials > 0 or connections > 0 or closes > 0
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


-- Rebuild the facts so the DC sale form's shows/closes land immediately.
select refresh_dc_ads_facts();
