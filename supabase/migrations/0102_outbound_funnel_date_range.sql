-- 0102_outbound_funnel_date_range.sql
-- Add an optional date range to the Outbound funnel + expose each campaign's
-- active date span. Read-only change: the materialized facts + refresh
-- (refresh_outbound_facts) are untouched — we only add a fast in-memory filter
-- on the already-materialized `anchor` (= when a lead entered the campaign, =
-- greatest(date_created, floor)) plus min/max anchor for the span label.
--
-- p_start/p_end default null → no filter → byte-identical to the prior all-time
-- funnel (verified before apply). Filtering `f` scopes funnel + called +
-- timeOfDay at once (all read `f`). DROP the 1-arg form first so the 3-arg form
-- with defaults isn't created as a second overload.

drop function if exists outbound_funnel(text);

create or replace function outbound_funnel(
  p_campaign_key text default 'revival',
  p_start timestamptz default null,
  p_end timestamptz default null
)
returns jsonb language sql stable as $$
with f as (
  select * from outbound_lead_facts
  where campaign_key = p_campaign_key
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
  'activeFrom', (select min(anchor) from outbound_lead_facts where campaign_key = p_campaign_key),
  'activeTo',   (select max(anchor) from outbound_lead_facts where campaign_key = p_campaign_key),
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
