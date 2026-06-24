-- 0095_outbound_lead_facts.sql
-- Materialize the Outbound funnel — the live aggregation in outbound_funnel()
-- (0093/0094) scanned all close_sms (66k) + close_calls (20k) + a JSONB filter on
-- close_leads (13k) on EVERY page load → ~23s, past the 8s PostgREST timeout, so
-- the page crashed. Doesn't scale as outbound grows.
--
-- Fix (mirrors lead_cycles for the HT funnel): precompute one row per (campaign,
-- lead) into outbound_lead_facts via refresh_outbound_facts() (run off-page on a
-- cron); outbound_funnel() then reads that small table → sub-second, independent
-- of raw-signal volume. Indexes keep the refresh fast.
--
-- Connected = a >=90s call only. Verified cell-by-cell vs funnel-revival.ts.

-- 1. Indexes that make the refresh's heavy scans fast (and the JSONB filter).
create index if not exists ix_close_leads_cf_gin on close_leads using gin (custom_fields_raw);
create index if not exists ix_close_sms_lead_act_dir on close_sms (lead_id, activity_at, direction);
create index if not exists ix_close_calls_lead_act_dir on close_calls (lead_id, activity_at, direction, duration);

-- 2. Per-lead materialized facts (one row per campaign lead).
create table if not exists outbound_lead_facts (
  campaign_key    text not null,
  close_id        text not null,
  anchor          timestamptz not null,   -- greatest(date_created, campaign floor)
  first_reply     timestamptz,            -- first inbound SMS since anchor
  has_inbound     boolean not null default false,
  any_call        boolean not null default false,
  call90          boolean not null default false,  -- a >=90s call (either direction) = CONNECTED
  first_dial      timestamptz,            -- first outbound call after first_reply
  booked          boolean not null default false,
  booked_dc       boolean not null default false,
  booked_ht       boolean not null default false,
  showed          boolean not null default false,
  closed          boolean not null default false,  -- a DC plan was sold (dc_plans filled)
  plan_units      int not null default 0,
  base44_monthly  int not null default 0,
  base44_yearly   int not null default 0,
  wix_monthly     int not null default 0,
  wix_yearly      int not null default 0,
  marked_no_plan  int not null default 0,  -- "DC Closed" forms with no plan (a show, not a close)
  reply_bucket    smallint,               -- 2-hour ET bucket (0-11) of first_reply
  dial_bucket     smallint,               -- ... of first_dial
  conn_bucket     smallint,               -- ... of the connecting call (call90 leads)
  updated_at      timestamptz not null default now(),
  primary key (campaign_key, close_id)
);

-- 3. Recompute + replace all facts for one campaign (full refresh). plpgsql so the
-- CF id is a variable → the GIN index applies to `custom_fields_raw ? v_cf`.
create or replace function refresh_outbound_facts(p_campaign_key text default 'revival')
returns int language plpgsql as $$
declare
  v_cf text; v_floor timestamptz; v_count int;
begin
  select close_cf_id, floor_at into v_cf, v_floor from outbound_campaigns where key = p_campaign_key;
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

-- 4. Read the funnel from the materialized facts (sub-second). Monotonic backfill
-- (closed -> showed -> booked -> connected -> called -> responded) at read time.
create or replace function outbound_funnel(p_campaign_key text default 'revival')
returns jsonb language sql stable as $$
with f as (select * from outbound_lead_facts where campaign_key = p_campaign_key),
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
$$;

comment on table outbound_lead_facts is
  'Materialized per-lead Outbound funnel facts (one row per campaign lead). Refreshed by refresh_outbound_facts() off the page load; read by outbound_funnel().';
