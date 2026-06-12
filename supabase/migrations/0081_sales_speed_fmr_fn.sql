-- 0081_sales_speed_fmr_fn.sql
-- Read-only SQL aggregation for the leads-page speed-to-lead boxes + FMR blocks,
-- replacing the live close_sms/close_calls scans (getSpeedToLeadCohort /
-- getFmrSignals / buildFmrBlocks). Reads the per-cycle facts materialized by the
-- tagger (migration 0080) off each cohort person's earliest in-window Typeform
-- cycle. Connected rate stays tag-based (Section 1), not here. Verified
-- cell-for-cell against the live computation before apply.
create or replace function sales_speed_fmr(
  p_start timestamptz, p_end timestamptz, p_start_date date, p_end_date date
) returns jsonb language sql stable as $$
with ftf as (
  select close_id, min(opt_in_at) opt_in_at
  from lead_cycles where source='typeform' and opt_in_at >= p_start and opt_in_at < p_end
  group by close_id),
facts as (
  select f.opt_in_at, lc.first_call_at, lc.intensity, lc.earliest_inbound_at, lc.earliest_connect_at,
    extract(epoch from (lc.first_call_at - f.opt_in_at)) speed_sec,
    floor(extract(hour from (f.opt_in_at at time zone 'America/New_York'))/4)::int blk
  from close_leads cl
  join ftf f on f.close_id = cl.close_id
  join lead_cycles lc on lc.close_id = cl.close_id and lc.opt_in_at = f.opt_in_at
  where cl.excluded_at is null
    and cl.date_first_opted_in >= p_start_date and cl.date_first_opted_in <= p_end_date
    and coalesce(cl.custom_fields_raw->>'cf_QivXkWBvr34UIDkUBKXNCQo6woarc62wEbIacWWbN7P','')=''),
agg as (select
    count(*) cs,
    count(*) filter (where first_call_at is not null) called,
    avg(least(speed_sec,86400)) filter (where first_call_at is not null) avgsp,
    avg(speed_sec) filter (where first_call_at is not null and speed_sec < 10800) avgu3,
    count(*) filter (where first_call_at is not null and speed_sec < 10800) lu3,
    avg(intensity) filter (where first_call_at is not null) avgint
  from facts),
blocks as (select blk, count(*) cs,
    count(*) filter (where earliest_inbound_at is not null or earliest_connect_at is not null) ever,
    count(*) filter (where (earliest_inbound_at is not null and earliest_inbound_at <= opt_in_at + interval '24 hours')
                       or (earliest_connect_at is not null and earliest_connect_at <= opt_in_at + interval '24 hours')) w24
  from facts group by blk)
select jsonb_build_object(
  'cohortSize',(select cs from agg), 'leadsCalled',(select called from agg),
  'avgSpeedToLeadSec',(select avgsp from agg), 'avgSpeedToLeadSecUnder3h',(select avgu3 from agg),
  'leadsUnder3h',(select lu3 from agg), 'avgIntensity',(select avgint from agg),
  'fmrBlocks',(select coalesce(jsonb_object_agg(blk, jsonb_build_array(cs, ever, w24)), '{}'::jsonb) from blocks))
$$;
