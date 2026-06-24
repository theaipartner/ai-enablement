-- 0094_outbound_funnel_plans.sql
-- Adds `closedPlans` (Base44/Wix × Monthly/Yearly breakdown) to outbound_funnel's
-- funnel object — the Outbound page's closes bracket renders it (PlanChip).
-- create-or-replace of the 0093 function; everything else identical.

create or replace function outbound_funnel(p_campaign_key text default 'revival')
returns jsonb language sql stable as $$
with cfg as (
  select close_cf_id, floor_at from outbound_campaigns where key = p_campaign_key
),
leads as (
  select cl.close_id, greatest(cl.date_created, c.floor_at) as anchor
  from close_leads cl cross join cfg c
  where cl.excluded_at is null
    and nullif(trim(cl.custom_fields_raw ->> c.close_cf_id), '') is not null
),
sms as (
  select l.close_id,
         min(s.activity_at) filter (where s.direction = 'inbound') as first_reply,
         bool_or(s.direction = 'inbound') as has_inbound
  from leads l join close_sms s on s.lead_id = l.close_id and s.activity_at >= l.anchor
  group by l.close_id
),
calls as (
  select l.close_id, true as any_call,
         bool_or(c.duration >= 90) as call90,
         min(c.activity_at) as earliest_call,
         min(c.activity_at) filter (where c.duration >= 90) as earliest_call90,
         min(c.activity_at) filter (where c.direction = 'outbound'
              and sm.first_reply is not null and c.activity_at >= sm.first_reply) as first_dial
  from leads l join close_calls c on c.lead_id = l.close_id and c.activity_at >= l.anchor
  left join sms sm on sm.close_id = l.close_id
  group by l.close_id
),
triage as (
  select l.close_id,
         bool_or(lower(t.call_status) like '%booking%') as booked,
         bool_or(lower(t.call_status) like '%digital college booking%') as booked_dc,
         bool_or(lower(t.call_status) like '%high ticket booking%') as booked_ht
  from leads l join airtable_setter_triage_calls t on t.lead_id = l.close_id
    and t.excluded_at is null and t.airtable_created_at >= l.anchor
  group by l.close_id
),
cforms as (
  select l.close_id, f.dc_plans,
    case when f.form_type = 'New'
      then (select count(*) from unnest(coalesce(f.dc_plans, '{}'::text[])) p where trim(p) <> '') > 0
      else lower(coalesce(f.closed,'')) = 'yes' and lower(coalesce(f.payment_plan_type,'')) ~ 'base|wix|digital college'
    end as is_close,
    case when f.form_type = 'New'
      then coalesce(f.call_outcome,'') <> '' and lower(f.call_outcome) !~ 'ghost|no show|reschedul|cancel'
      else lower(coalesce(f.showed,'')) = 'yes'
    end as is_showed,
    (f.form_type = 'New'
       and (select count(*) from unnest(coalesce(f.dc_plans, '{}'::text[])) p where trim(p) <> '') = 0
       and lower(coalesce(f.call_outcome,'')) like '%digital college%') as marked_no_plan
  from leads l join airtable_full_closer_report f on f.lead_id = l.close_id and f.airtable_created_at >= l.anchor
),
closer as (select close_id, bool_or(is_showed) as showed, bool_or(is_close) as closed from cforms group by close_id),
-- Plan breakdown across ALL closing forms (mirrors addPlan in funnel-dc.ts).
plan_counts as (
  select
    coalesce(sum((lower(p) like '%base%' and lower(p) like '%month%')::int), 0) as b44m,
    coalesce(sum((lower(p) like '%base%' and (lower(p) like '%year%' or lower(p) like '%annual%'))::int), 0) as b44y,
    coalesce(sum((lower(p) like '%wix%'  and lower(p) like '%month%')::int), 0) as wixm,
    coalesce(sum((lower(p) like '%wix%'  and (lower(p) like '%year%' or lower(p) like '%annual%'))::int), 0) as wixy
  from cforms cf cross join lateral unnest(coalesce(cf.dc_plans, '{}'::text[])) p where cf.is_close
),
marked as (select count(*) as c from cforms where marked_no_plan),
flags as (
  select l.close_id,
    coalesce(cl.closed, false) as f_close, coalesce(cl.showed, false) as f_show_raw,
    coalesce(tr.booked, false) as f_book_raw, coalesce(ca.call90, false) as f_call90,
    coalesce(ca.any_call, false) as f_anycall, coalesce(sm.has_inbound, false) as f_inbound,
    coalesce(tr.booked_dc, false) as f_book_dc, coalesce(tr.booked_ht, false) as f_book_ht
  from leads l
  left join sms sm on sm.close_id = l.close_id
  left join calls ca on ca.close_id = l.close_id
  left join triage tr on tr.close_id = l.close_id
  left join closer cl on cl.close_id = l.close_id
),
roll as (
  select f_close as closed, (f_show_raw or f_close) as showed,
    (f_book_raw or f_show_raw or f_close) as booked,
    (f_call90 or f_book_raw or f_show_raw or f_close) as connected,
    (f_anycall or f_call90 or f_book_raw or f_show_raw or f_close) as called,
    (f_inbound or f_anycall or f_call90 or f_book_raw or f_show_raw or f_close) as responded,
    f_book_dc as booked_dc, f_book_ht as booked_ht
  from flags
),
speed as (
  select extract(epoch from (ca.first_dial - sm.first_reply)) / 60.0 as mins, coalesce(ca.call90, false) as conn
  from calls ca join sms sm on sm.close_id = ca.close_id
  where ca.first_dial is not null and sm.first_reply is not null
),
sb as (
  select case when mins<5 then 0 when mins<15 then 1 when mins<30 then 2 when mins<60 then 3
    when mins<120 then 4 when mins<360 then 5 when mins<1440 then 6 else 7 end as idx, conn from speed
),
sb_lbl(idx, label) as (values (0,'<5m'),(1,'5–15m'),(2,'15–30m'),(3,'30–60m'),(4,'1–2h'),(5,'2–6h'),(6,'6–24h'),(7,'>24h'))
select jsonb_build_object(
  'funnel', jsonb_build_object(
    'leads',        (select count(*) from leads),
    'responded',    (select count(*) filter (where responded) from roll),
    'called',       (select count(*) filter (where called) from roll),
    'connected',    (select count(*) filter (where connected) from roll),
    'booked',       (select count(*) filter (where booked) from roll),
    'bookedDc',     (select count(*) filter (where booked_dc) from roll),
    'bookedHt',     (select count(*) filter (where booked_ht) from roll),
    'showed',       (select count(*) filter (where showed) from roll),
    'closed',       (select count(*) filter (where closed) from roll),
    'closedPlans',  (select jsonb_build_object('base44Monthly',b44m,'base44Yearly',b44y,'wixMonthly',wixm,'wixYearly',wixy) from plan_counts),
    'cashUsd',      (select (b44m+b44y+wixm+wixy)*300 from plan_counts),
    'markedNoPlan', (select c from marked)
  ),
  'called', jsonb_build_object(
    'responded',      (select count(*) from sms where first_reply is not null),
    'called',         (select count(*) from calls where first_dial is not null),
    'connected',      (select count(*) from calls where call90),
    'notCalled',      (select count(*) from sms where first_reply is not null)
                      - (select count(*) from calls where first_dial is not null),
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
        'replies',  (select count(*) from sms s where s.first_reply is not null
                       and floor(extract(hour from (s.first_reply at time zone 'America/New_York')) / 2) = b),
        'dials',    (select count(*) from calls c where c.first_dial is not null
                       and floor(extract(hour from (c.first_dial at time zone 'America/New_York')) / 2) = b),
        'connects', (select count(*) from calls c where c.call90
                       and floor(extract(hour from (coalesce(c.earliest_call90, c.earliest_call) at time zone 'America/New_York')) / 2) = b)
      ) order by b)
    from generate_series(0, 11) b
  )
)
$$;
