-- 0064_tag_reactivated_leads_fn.sql
--
-- Ongoing maintenance of close_leads.reactivated_at (see 0063). Encodes the
-- same set-once reactivation logic as scripts/backfill_reactivated_at.py so the
-- Airtable ingestion cron can keep the tag current as new forms land.
--
-- A direct lead (candidate = has a confirmation / Closer Triage Form) is tagged
-- reactivated at the EARLIEST of:
--   A) a confirmation form with call_status ~ 'Setter pipeline' (handover; the
--      no-answer case is recorded here too). DQ does NOT trigger.
--   B) a closer EOC form (airtable_full_closer_report) whose outcome is a
--      ghost/no-show or cancel (NOT reschedule, NOT DQ, NOT close/deposit/
--      follow-up).
-- reactivated_at = that form's airtable_created_at. Set ONCE (only where null).
--
-- Returns the number of leads newly tagged this call. Idempotent — re-running
-- only ever sets rows that became eligible since the last run. Invoked via
-- db.rpc('tag_reactivated_leads') from api/airtable_sync_cron.py.

create or replace function public.tag_reactivated_leads()
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  with conf as (
    select lead_id, min(airtable_created_at) as t
    from airtable_setter_triage_calls
    where form_type = 'Closer Triage Form'
      and lead_id is not null
      and call_status ilike '%setter pipeline%'
    group by lead_id
  ),
  candidates as (  -- direct leads: have a confirmation form at all
    select distinct lead_id
    from airtable_setter_triage_calls
    where form_type = 'Closer Triage Form' and lead_id is not null
  ),
  eoc as (
    select f.lead_id, min(f.airtable_created_at) as t
    from airtable_full_closer_report f
    join candidates c on c.lead_id = f.lead_id
    where f.lead_id is not null
      and (
        ( (f.call_outcome ilike '%ghost%' or f.call_outcome ilike '%cancel%' or f.call_outcome ilike '%no show%')
          and f.call_outcome not ilike '%reschedul%' )
        or
        ( (f.no_show_reason ilike '%ghost%' or f.no_show_reason ilike '%cancel%' or f.no_show_reason ilike '%no show%')
          and f.no_show_reason not ilike '%reschedul%' )
      )
    group by f.lead_id
  ),
  trig as (
    select coalesce(conf.lead_id, eoc.lead_id) as lead_id,
           least(coalesce(conf.t, eoc.t), coalesce(eoc.t, conf.t)) as reactivated_at
    from conf
    full outer join eoc on conf.lead_id = eoc.lead_id
  )
  update close_leads cl
  set reactivated_at = trig.reactivated_at
  from trig
  where cl.close_id = trig.lead_id
    and trig.reactivated_at is not null
    and cl.reactivated_at is null;

  get diagnostics n = row_count;
  return n;
end;
$$;

comment on function public.tag_reactivated_leads() is
  'Set-once maintenance of close_leads.reactivated_at from the Airtable forms (confirmation Setter pipeline, or closer EOC ghost/cancel; DQ + reschedule excluded). Returns count newly tagged. Called by the Airtable sync cron.';
