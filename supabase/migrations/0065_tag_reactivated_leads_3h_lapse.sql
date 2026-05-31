-- 0065_tag_reactivated_leads_3h_lapse.sql
--
-- Adds the 3h-lapse trigger (trigger 3) to tag_reactivated_leads() (see 0063 /
-- 0064 for the column + the original forms-only function). Mirrors the same
-- extension landing in scripts/backfill_reactivated_at.py.
--
-- A direct-booking lead (booked an Ai Partner Strategy Call) is tagged
-- reactivated at the EARLIEST of three ADDITIVE triggers:
--   1) confirmation / Closer Triage Form with call_status ~ 'Setter pipeline'
--      (setter handover; the no-answer case is recorded here too).
--   2) closer EOC form (airtable_full_closer_report) whose outcome is a
--      ghost / no-show or a cancel (NOT reschedule, NOT DQ, NOT a showed
--      outcome).
--   3) NEW — the strat meeting lapsed silently: the lead has a direct strat
--      booking, NO active (status != 'canceled') future strat booking, and the
--      latest non-canceled strat booking's start_time + 3h is in the past.
--      reactivated_at = that start_time + 3h. The 3h grace absorbs a
--      drag-dropped reschedule's cancel→recreate gap (a reschedule lands a new
--      future active booking, so the no-future-booking condition skips it).
--
-- SHOWED-BLOCK (trigger 3 only): if the lead has ANY closer EOC form indicating
-- they engaged with a strat meeting — a close / deposit / follow-up / DQ
-- outcome (new form), or legacy showed='Yes' / closed='Yes' / a follow_up
-- (old form) — trigger 3 does NOT fire. They used their spot; a past meeting
-- they attended is not a lapse. Triggers 1 & 2 already exclude showed outcomes
-- intrinsically, so the block is scoped to trigger 3. DQ never reactivates (a
-- DQ'd lead is a direct that DQ'd); reschedule never reactivates by itself.
--
-- Calendly→lead resolution mirrors the dashboard chain: per-lead utm_term token
-- (unique-mapping-only guard — a term shared across many leads is ambiguous and
-- dropped), then invitee email ∈ close_leads.contacts, then normalized
-- display_name. Email/name mappings are likewise restricted to unique ones so a
-- shared key can never mis-attribute a booking. Soft-hidden events
-- (excluded_at) are ignored.
--
-- Set ONCE; earliest-wins (updates a row only when currently null OR the new
-- timestamp is earlier than the stored one). Returns the count of rows changed.
-- Invoked via db.rpc('tag_reactivated_leads') from api/airtable_sync_cron.py.

create or replace function public.tag_reactivated_leads()
returns integer
language plpgsql
as $$
declare
  n integer;
  direct_uri constant text :=
    'https://api.calendly.com/event_types/8f6795d3-992a-4cbd-b584-9ecaabb3938c';
begin
  with
  -- ── Trigger 1: setter handover (confirmation form) ──────────────────────
  conf as (
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
  -- ── Trigger 2: closer EOC ghost / no-show / cancel ──────────────────────
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
  -- ── Showed-block: leads who engaged with a strat meeting (trigger 3 guard) ─
  attended as (
    select distinct lead_id
    from airtable_full_closer_report
    where lead_id is not null
      and (
        ( form_type = 'New' and (
            call_outcome ilike '%closed%'
            or call_outcome ilike '%deposit%'
            or call_outcome ilike '%follow%'
            or call_outcome ilike '%dq%'
            or call_outcome ilike '%bad fit%'
        ))
        or
        ( form_type is distinct from 'New' and (
            showed ilike 'yes'
            or showed ilike '%triage disqualified%'
            or closed ilike 'yes'
            or coalesce(trim(follow_up), '') <> ''
        ))
      )
  ),
  -- ── Calendly → lead resolution (unique-mapping-only on every key) ───────
  unique_utm as (
    select utm_term, min(close_id) as close_id
    from close_leads
    where utm_term is not null
    group by utm_term
    having count(distinct close_id) = 1
  ),
  lead_emails as (
    select cl.close_id, lower(trim(e->>'email')) as email
    from close_leads cl
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(cl.contacts) = 'array' then cl.contacts else '[]'::jsonb end
    ) as c
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(c->'emails') = 'array' then c->'emails' else '[]'::jsonb end
    ) as e
    where coalesce(trim(e->>'email'), '') <> ''
  ),
  unique_email as (
    select email, min(close_id) as close_id
    from lead_emails
    group by email
    having count(distinct close_id) = 1
  ),
  unique_name as (
    select lower(trim(display_name)) as name, min(close_id) as close_id
    from close_leads
    where coalesce(trim(display_name), '') <> ''
    group by lower(trim(display_name))
    having count(distinct close_id) = 1
  ),
  direct_events as (
    select uri, start_time, status
    from calendly_scheduled_events
    where event_type_uri = direct_uri
      and excluded_at is null
  ),
  event_lead as (
    select de.start_time, de.status,
           coalesce(uu.close_id, ue.close_id, un.close_id) as lead_id
    from direct_events de
    join calendly_invitees inv on inv.event_uri = de.uri
    left join unique_utm uu on uu.utm_term = (inv.raw_payload->'tracking'->>'utm_term')
    left join unique_email ue on ue.email = lower(trim(inv.email))
    left join unique_name un on un.name = lower(trim(inv.name))
  ),
  lead_strat as (
    select lead_id,
           bool_or(status is distinct from 'canceled' and start_time > now()) as has_future_active,
           max(start_time) filter (where status is distinct from 'canceled') as latest_active_start
    from event_lead
    where lead_id is not null
    group by lead_id
  ),
  -- ── Trigger 3: silent 3h lapse (showed-blocked) ─────────────────────────
  lapse as (
    select ls.lead_id, ls.latest_active_start + interval '3 hours' as t
    from lead_strat ls
    left join attended a on a.lead_id = ls.lead_id
    where ls.has_future_active = false
      and ls.latest_active_start is not null
      and ls.latest_active_start + interval '3 hours' < now()
      and a.lead_id is null
  ),
  -- ── Earliest across all triggers ────────────────────────────────────────
  trig as (
    select lead_id, min(t) as reactivated_at
    from (
      select lead_id, t from conf
      union all
      select lead_id, t from eoc
      union all
      select lead_id, t from lapse
    ) u
    where t is not null
    group by lead_id
  )
  update close_leads cl
  set reactivated_at = trig.reactivated_at
  from trig
  where cl.close_id = trig.lead_id
    and trig.reactivated_at is not null
    and (cl.reactivated_at is null or trig.reactivated_at < cl.reactivated_at);

  get diagnostics n = row_count;
  return n;
end;
$$;

comment on function public.tag_reactivated_leads() is
  'Set-once / earliest-wins maintenance of close_leads.reactivated_at. Three additive triggers: (1) confirmation form Setter pipeline handover, (2) closer EOC ghost/no-show/cancel, (3) direct strat meeting lapsed silently (no active future strat booking, latest non-canceled start_time + 3h in the past) — trigger 3 blocked when the lead has an attended EOC form (close/deposit/follow-up/DQ). DQ + reschedule never trigger. Returns count of rows changed. Called by the Airtable sync cron.';

comment on column close_leads.reactivated_at is
  'When a direct-booking lead (booked an Ai Partner Strategy Call) lost that strat-call spot, at the EARLIEST of: confirmation form call_status ~ Setter pipeline; first closer EOC form ghost/no-show/cancel; or the strat meeting lapsing silently (no active future strat booking + latest non-canceled start_time + 3h in the past). A lead that attended a strat meeting (close/deposit/follow-up/DQ EOC outcome) is never lapse-reactivated; DQ + reschedule never trigger. Set once, permanent (never cleared). null = never reactivated. Populated by scripts/backfill_reactivated_at.py + maintained by tag_reactivated_leads() via the Airtable cron. Drives the /sales-dashboard/leads reactivation funnel + scopes that funnel''s post-handover activity.';
