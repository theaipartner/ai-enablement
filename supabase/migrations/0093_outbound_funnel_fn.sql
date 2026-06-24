-- 0093_outbound_funnel_fn.sql
-- SQL aggregation for the Outbound funnel — replaces the all-time JS "revival"
-- page (3 loaders, each re-scanning all close_leads for anchors + ~58 chunk
-- queries across 4 signal tables = ~600 round trips per load). One set-based
-- function instead, and it stops degrading as the campaign grows.
--
-- Parameterized by CAMPAIGN so future outbound campaigns (other lead tags) are a
-- registry row + a dropdown option, not a function rewrite. Today's "revival" CF
-- + Jun-3 floor are just the seed row.
--
-- Connected = a >=90s call ONLY (Drake 2026-06-24), matching the rest of the app
-- (the old "form-reached + any call" branch is dropped here too). Verified
-- cell-by-cell against funnel-revival.ts before apply.

create table if not exists outbound_campaigns (
  key          text primary key,
  label        text not null,
  close_cf_id  text not null,          -- Close custom-field id that flags the lead
  floor_at     timestamptz not null,   -- campaign start; per-lead anchor = greatest(date_created, floor_at)
  is_active    boolean not null default true,
  sort_order   int not null default 0
);

insert into outbound_campaigns (key, label, close_cf_id, floor_at, sort_order)
values ('revival', 'DC Revival', 'cf_QivXkWBvr34UIDkUBKXNCQo6woarc62wEbIacWWbN7P',
        timestamptz '2026-06-03T04:00:00Z', 0)
on conflict (key) do nothing;

create or replace function outbound_funnel(p_campaign_key text default 'revival')
returns jsonb language sql stable as $$
with cfg as (
  select close_cf_id, floor_at from outbound_campaigns where key = p_campaign_key
),
-- Revival-tagged, non-excluded leads + per-lead anchor (later of date_created, floor).
leads as (
  select cl.close_id, greatest(cl.date_created, c.floor_at) as anchor
  from close_leads cl cross join cfg c
  where cl.excluded_at is null
    and nullif(trim(cl.custom_fields_raw ->> c.close_cf_id), '') is not null
),
-- Inbound SMS: first reply (since anchor).
sms as (
  select l.close_id,
         min(s.activity_at) filter (where s.direction = 'inbound') as first_reply,
         bool_or(s.direction = 'inbound') as has_inbound
  from leads l
  join close_sms s on s.lead_id = l.close_id and s.activity_at >= l.anchor
  group by l.close_id
),
-- Calls (since anchor): any call, a >=90s call (either direction), first outbound
-- dial after the lead's first reply, and earliest-connect timestamps.
calls as (
  select l.close_id,
         true as any_call,
         bool_or(c.duration >= 90) as call90,
         min(c.activity_at) as earliest_call,
         min(c.activity_at) filter (where c.duration >= 90) as earliest_call90,
         min(c.activity_at) filter (where c.direction = 'outbound'
              and sm.first_reply is not null and c.activity_at >= sm.first_reply) as first_dial
  from leads l
  join close_calls c on c.lead_id = l.close_id and c.activity_at >= l.anchor
  left join sms sm on sm.close_id = l.close_id
  group by l.close_id
),
-- Triage forms (since anchor): booking flags.
triage as (
  select l.close_id,
         bool_or(lower(t.call_status) like '%booking%') as booked,
         bool_or(lower(t.call_status) like '%digital college booking%') as booked_dc,
         bool_or(lower(t.call_status) like '%high ticket booking%') as booked_ht
  from leads l
  join airtable_setter_triage_calls t on t.lead_id = l.close_id
    and t.excluded_at is null and t.airtable_created_at >= l.anchor
  group by l.close_id
),
-- Closer EOC forms (since anchor): per-form showed / close / marked-no-plan.
cforms as (
  select l.close_id, f.dc_plans,
    case when f.form_type = 'New'
      then (select count(*) from unnest(coalesce(f.dc_plans, '{}'::text[])) p where trim(p) <> '') > 0
      else lower(coalesce(f.closed,'')) = 'yes'
           and lower(coalesce(f.payment_plan_type,'')) ~ 'base|wix|digital college'
    end as is_close,
    case when f.form_type = 'New'
      then coalesce(f.call_outcome,'') <> '' and lower(f.call_outcome) !~ 'ghost|no show|reschedul|cancel'
      else lower(coalesce(f.showed,'')) = 'yes'
    end as is_showed,
    (f.form_type = 'New'
       and (select count(*) from unnest(coalesce(f.dc_plans, '{}'::text[])) p where trim(p) <> '') = 0
       and lower(coalesce(f.call_outcome,'')) like '%digital college%') as marked_no_plan
  from leads l
  join airtable_full_closer_report f on f.lead_id = l.close_id and f.airtable_created_at >= l.anchor
),
closer as (
  select close_id, bool_or(is_showed) as showed, bool_or(is_close) as closed
  from cforms group by close_id
),
-- Cash = $300 per plan unit; units = base/wix × monthly/yearly across ALL closing
-- forms' dc_plans (mirrors addPlan in funnel-dc.ts).
plan_units as (
  select coalesce(sum(
      (lower(p) like '%base%' and lower(p) like '%month%')::int
    + (lower(p) like '%base%' and (lower(p) like '%year%' or lower(p) like '%annual%'))::int
    + (lower(p) like '%wix%'  and lower(p) like '%month%')::int
    + (lower(p) like '%wix%'  and (lower(p) like '%year%' or lower(p) like '%annual%'))::int
  ), 0) as units
  from cforms cf cross join lateral unnest(coalesce(cf.dc_plans, '{}'::text[])) p
  where cf.is_close
),
marked as (select count(*) as c from cforms where marked_no_plan),
-- Per-lead base signals, then monotonic backfill (closed -> showed -> booked ->
-- connected -> called -> responded). Connected's DIRECT signal is a >=90s call.
flags as (
  select l.close_id,
    coalesce(cl.closed, false) as f_close,
    coalesce(cl.showed, false) as f_show_raw,
    coalesce(tr.booked, false) as f_book_raw,
    coalesce(ca.call90, false) as f_call90,
    coalesce(ca.any_call, false) as f_anycall,
    coalesce(sm.has_inbound, false) as f_inbound,
    coalesce(tr.booked_dc, false) as f_book_dc,
    coalesce(tr.booked_ht, false) as f_book_ht
  from leads l
  left join sms sm on sm.close_id = l.close_id
  left join calls ca on ca.close_id = l.close_id
  left join triage tr on tr.close_id = l.close_id
  left join closer cl on cl.close_id = l.close_id
),
roll as (
  select
    f_close as closed,
    (f_show_raw or f_close) as showed,
    (f_book_raw or f_show_raw or f_close) as booked,
    (f_call90 or f_book_raw or f_show_raw or f_close) as connected,
    (f_anycall or f_call90 or f_book_raw or f_show_raw or f_close) as called,
    (f_inbound or f_anycall or f_call90 or f_book_raw or f_show_raw or f_close) as responded,
    f_book_dc as booked_dc, f_book_ht as booked_ht
  from flags
),
-- Speed-to-dial population: leads outbound-dialed after their first reply.
speed as (
  select extract(epoch from (ca.first_dial - sm.first_reply)) / 60.0 as mins,
         coalesce(ca.call90, false) as conn
  from calls ca join sms sm on sm.close_id = ca.close_id
  where ca.first_dial is not null and sm.first_reply is not null
),
sb as (
  select case
      when mins < 5 then 0 when mins < 15 then 1 when mins < 30 then 2 when mins < 60 then 3
      when mins < 120 then 4 when mins < 360 then 5 when mins < 1440 then 6 else 7 end as idx,
    conn
  from speed
),
sb_lbl(idx, label) as (values (0,'<5m'),(1,'5–15m'),(2,'15–30m'),(3,'30–60m'),
                               (4,'1–2h'),(5,'2–6h'),(6,'6–24h'),(7,'>24h'))
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
    'cashUsd',      (select units from plan_units) * 300,
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

comment on function outbound_funnel(text) is
  'All-time Outbound funnel (funnel / called / timeOfDay) for one campaign in outbound_campaigns. Replaces the JS revival loaders. Connected = a >=90s call only.';
