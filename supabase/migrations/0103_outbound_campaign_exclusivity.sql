-- 0103_outbound_campaign_exclusivity.sql
-- Make the outbound campaign pools MUTUALLY EXCLUSIVE in the funnel.
--
-- Problem: the ECJ "Jacob" batch is run through the same Close SMS reactivation
-- workflow that stamps every lead it touches with the "DC Revival Lead" custom
-- field. So all 8,640 Jacob-tagged leads ALSO carry the Revival CF, and
-- refresh_outbound_facts (0095) — which keys each campaign purely off its own CF
-- — materialized them into BOTH the revival and jacob fact sets. Result: every
-- Jacob lead (and its closes) was double-counted, inflating the Revival funnel.
-- This violates the design contract ("excluded from every other surface — the
-- only place they're counted", docs/sales/README.md + surfaces.md).
--
-- Fix: a lead belongs to exactly ONE campaign — the most specific one it carries.
-- "Most specific" = highest outbound_campaigns.sort_order (campaigns are added in
-- increasing specificity: revival=0 is the broad re-engagement pool, jacob=1 is
-- the named ECJ sub-pool). When building facts for campaign C we now EXCLUDE any
-- lead that also carries the CF of an active campaign with a higher sort_order.
-- So revival drops every jacob lead; jacob (the highest) keeps all of its own.
--
-- Read-only to the schema: only the `leads` CTE filter changes (+ v_sort). The
-- caller must re-run refresh_outbound_facts() for every campaign after apply
-- (the */15 cron does this anyway); outbound_funnel() is unchanged.

create or replace function refresh_outbound_facts(p_campaign_key text default 'revival')
returns int language plpgsql as $$
declare
  v_cf text; v_floor timestamptz; v_count int; v_sort int;
begin
  select close_cf_id, floor_at, sort_order into v_cf, v_floor, v_sort
    from outbound_campaigns where key = p_campaign_key;
  if v_cf is null then raise exception 'unknown outbound campaign: %', p_campaign_key; end if;

  delete from outbound_lead_facts where campaign_key = p_campaign_key;

  insert into outbound_lead_facts (
    campaign_key, close_id, anchor, first_reply, has_inbound, any_call, call90, first_dial,
    booked, booked_dc, booked_ht, showed, closed,
    plan_units, base44_monthly, base44_yearly, wix_monthly, wix_yearly, marked_no_plan,
    reply_bucket, dial_bucket, conn_bucket, updated_at)
  with leads as (
    select cl.close_id, greatest(cl.date_created, v_floor) as anchor
    from close_leads cl
    where cl.excluded_at is null
      and cl.custom_fields_raw ? v_cf
      and nullif(trim(cl.custom_fields_raw ->> v_cf), '') is not null
      -- Mutual exclusivity: drop leads owned by a more specific campaign.
      and not exists (
        select 1 from outbound_campaigns oc
        where oc.is_active
          and oc.sort_order > v_sort
          and cl.custom_fields_raw ? oc.close_cf_id
          and nullif(trim(cl.custom_fields_raw ->> oc.close_cf_id), '') is not null
      )
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
      min(c.activity_at) filter (where c.direction='outbound'
           and sm.first_reply is not null and c.activity_at >= sm.first_reply) as first_dial
    from leads l join close_calls c on c.lead_id=l.close_id and c.activity_at >= l.anchor
    left join sms sm on sm.close_id=l.close_id
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
    select l.close_id, f.dc_plans,
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
  closer as (
    select close_id, bool_or(is_showed) as showed, bool_or(is_close) as closed,
      count(*) filter (where marked_no_plan) as marked_no_plan
    from cforms group by close_id
  ),
  plan_per_lead as (
    select cf.close_id,
      sum((lower(p) like '%base%' and lower(p) like '%month%')::int) as b44m,
      sum((lower(p) like '%base%' and (lower(p) like '%year%' or lower(p) like '%annual%'))::int) as b44y,
      sum((lower(p) like '%wix%'  and lower(p) like '%month%')::int) as wixm,
      sum((lower(p) like '%wix%'  and (lower(p) like '%year%' or lower(p) like '%annual%'))::int) as wixy
    from cforms cf cross join lateral unnest(coalesce(cf.dc_plans,'{}'::text[])) p
    where cf.is_close group by cf.close_id
  )
  select p_campaign_key, l.close_id, l.anchor,
    sm.first_reply, coalesce(sm.has_inbound,false),
    coalesce(ca.any_call,false), coalesce(ca.call90,false), ca.first_dial,
    coalesce(tr.booked,false), coalesce(tr.booked_dc,false), coalesce(tr.booked_ht,false),
    coalesce(cl.showed,false), coalesce(cl.closed,false),
    coalesce(pp.b44m,0)+coalesce(pp.b44y,0)+coalesce(pp.wixm,0)+coalesce(pp.wixy,0),
    coalesce(pp.b44m,0), coalesce(pp.b44y,0), coalesce(pp.wixm,0), coalesce(pp.wixy,0),
    coalesce(cl.marked_no_plan,0),
    case when sm.first_reply is not null then floor(extract(hour from (sm.first_reply at time zone 'America/New_York'))/2)::smallint end,
    case when ca.first_dial is not null then floor(extract(hour from (ca.first_dial at time zone 'America/New_York'))/2)::smallint end,
    case when coalesce(ca.call90,false) then floor(extract(hour from (coalesce(ca.earliest_call90, ca.earliest_call) at time zone 'America/New_York'))/2)::smallint end,
    now()
  from leads l
  left join sms sm on sm.close_id=l.close_id
  left join calls ca on ca.close_id=l.close_id
  left join triage tr on tr.close_id=l.close_id
  left join closer cl on cl.close_id=l.close_id
  left join plan_per_lead pp on pp.close_id=l.close_id;

  get diagnostics v_count = row_count;
  return v_count;
end $$;
