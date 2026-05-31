#!/usr/bin/env python3
"""Backfill close_leads.reactivated_at (migrations 0063 / 0064 / 0065).

A direct-booking lead becomes "reactivated" the moment it loses its
strategy-call spot, at the EARLIEST of three additive triggers:

  Trigger A — confirmation/triage form (airtable_setter_triage_calls,
    form_type='Closer Triage Form') with call_status ~ 'Setter pipeline'
    (the setter handover, incl. the no-answer case). DQ does NOT trigger.

  Trigger B — closer EOC form (airtable_full_closer_report) for the strategy
    meeting whose outcome is a ghost/no-show or a cancel (NOT a reschedule,
    NOT a DQ, NOT a close/deposit/follow-up).

  Trigger C — the strat meeting lapsed silently: the lead has a direct strat
    booking, NO active (status != 'canceled') future strat booking, and the
    latest non-canceled strat booking's start_time + 3h is in the past.
    reactivated_at = that start_time + 3h. The 3h grace absorbs a drag-dropped
    reschedule's cancel→recreate gap. BLOCKED if the lead has any attended
    closer EOC form (close/deposit/follow-up/DQ) — they used their spot, so a
    past meeting they attended is not a lapse. Triggers A & B already exclude
    showed outcomes intrinsically, so the block is scoped to trigger C.

reactivated_at = the EARLIEST triggering timestamp. Set once / earliest-wins
(updates only where currently null OR the new value is earlier) — permanent.

Candidate gate (so a setter-led lead's partnership-meeting ghost can't trigger
B): the lead must have a confirmation form at all. Every direct booking gets a
confirmation form (the closer fills it even on a no-answer), so "has a Closer
Triage Form" reliably means "direct lead." The A trigger is self-gating (the
confirmation form only exists for direct leads). The C trigger is gated by the
lead actually having a direct strat booking in Calendly.

Calendly→lead resolution mirrors the dashboard chain: per-lead utm_term token
(unique-mapping-only guard), then invitee email ∈ close_leads.contacts, then
normalized display_name (email/name also unique-mapping-only). Soft-hidden
events (excluded_at) are ignored. This is the SQL twin of the
tag_reactivated_leads() RPC (0065).

Usage:
  python scripts/backfill_reactivated_at.py            # dry run (smoke): counts + sample, NO write
  python scripts/backfill_reactivated_at.py --apply    # full write
"""
import argparse
import re
import sys
import urllib.parse
from pathlib import Path

import psycopg2

# Confirmation-form handover status (DQ deliberately excluded).
CONF_TRIGGER = "%setter pipeline%"

# The funnel direct self-book event type ("Ai Partner Strategy Call"). Mirrors
# DIRECT_BOOKING_EVENT_TYPE_URI in lib/db/funnel-calendly.ts.
DIRECT_BOOKING_EVENT_TYPE_URI = (
    "https://api.calendly.com/event_types/8f6795d3-992a-4cbd-b584-9ecaabb3938c"
)

# CTE computing reactivated_at per lead (earliest of triggers A/B/C). Reused by
# smoke + apply. SQL twin of the tag_reactivated_leads() RPC (migration 0065).
# `%%` escapes are literal `%` for ilike (psycopg2 reserves bare `%` for params).
COMPUTE_CTE = f"""
with conf as (  -- trigger A: setter handover (confirmation form)
  select lead_id, min(airtable_created_at) as t
  from airtable_setter_triage_calls
  where form_type = 'Closer Triage Form'
    and lead_id is not null
    and call_status ilike %(conf)s
  group by lead_id
),
candidates as (  -- direct leads: have a confirmation form at all
  select distinct lead_id
  from airtable_setter_triage_calls
  where form_type = 'Closer Triage Form' and lead_id is not null
),
eoc as (  -- trigger B: closer EOC ghost / no-show / cancel
  select f.lead_id, min(f.airtable_created_at) as t
  from airtable_full_closer_report f
  join candidates c on c.lead_id = f.lead_id
  where f.lead_id is not null
    and (
      ( (f.call_outcome ilike '%%ghost%%' or f.call_outcome ilike '%%cancel%%' or f.call_outcome ilike '%%no show%%')
        and f.call_outcome not ilike '%%reschedul%%' )
      or
      ( (f.no_show_reason ilike '%%ghost%%' or f.no_show_reason ilike '%%cancel%%' or f.no_show_reason ilike '%%no show%%')
        and f.no_show_reason not ilike '%%reschedul%%' )
    )
  group by f.lead_id
),
attended as (  -- showed-block (trigger C guard): engaged with a strat meeting
  select distinct lead_id
  from airtable_full_closer_report
  where lead_id is not null
    and (
      ( form_type = 'New' and (
          call_outcome ilike '%%closed%%'
          or call_outcome ilike '%%deposit%%'
          or call_outcome ilike '%%follow%%'
          or call_outcome ilike '%%dq%%'
          or call_outcome ilike '%%bad fit%%'
      ))
      or
      ( form_type is distinct from 'New' and (
          showed ilike 'yes'
          or showed ilike '%%triage disqualified%%'
          or closed ilike 'yes'
          or coalesce(trim(follow_up), '') <> ''
      ))
    )
),
unique_utm as (  -- per-lead utm token, unique-mapping-only
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
  where event_type_uri = '{DIRECT_BOOKING_EVENT_TYPE_URI}'
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
lapse as (  -- trigger C: silent 3h lapse (showed-blocked)
  select ls.lead_id, ls.latest_active_start + interval '3 hours' as t
  from lead_strat ls
  left join attended a on a.lead_id = ls.lead_id
  where ls.has_future_active = false
    and ls.latest_active_start is not null
    and ls.latest_active_start + interval '3 hours' < now()
    and a.lead_id is null
),
per_trigger as (
  select lead_id, 'conf' as src, t from conf
  union all select lead_id, 'eoc'   as src, t from eoc
  union all select lead_id, 'lapse' as src, t from lapse
),
trig as (
  select lead_id,
         min(t) as reactivated_at,
         min(t) filter (where src = 'conf')  as conf_t,
         min(t) filter (where src = 'eoc')   as eoc_t,
         min(t) filter (where src = 'lapse') as lapse_t
  from per_trigger
  where t is not null
  group by lead_id
)
"""


def connect():
    env = {}
    for ln in Path(".env.local").read_text().splitlines():
        if ln.strip() and not ln.startswith("#") and "=" in ln:
            k, _, v = ln.partition("=")
            env[k.strip()] = v.strip().strip('"').strip("'")
    pw = urllib.parse.quote(env["SUPABASE_DB_PASSWORD"], safe="")
    m = re.match(r"^(postgresql://[^@]+)@(.+)$", Path("supabase/.temp/pooler-url").read_text().strip())
    url = f"{m.group(1)}:{pw}@{m.group(2)}"
    return psycopg2.connect(url, sslmode="require", connect_timeout=15)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write reactivated_at (default: dry run)")
    args = ap.parse_args()

    conn = connect()
    conn.autocommit = False
    cur = conn.cursor()

    # How many leads the triggers identify, and how many are matched to a real
    # close_leads row and currently null (i.e. would be set).
    cur.execute(COMPUTE_CTE + """
        select
          count(*) as trig_leads,
          count(*) filter (where conf_t is not null)  as via_conf,
          count(*) filter (where eoc_t is not null)   as via_eoc,
          count(*) filter (where lapse_t is not null) as via_lapse
        from trig
        where reactivated_at is not null
    """, {"conf": CONF_TRIGGER})
    trig_leads, via_conf, via_eoc, via_lapse = cur.fetchone()

    # Rows this run would change: never-set, OR an earlier timestamp than stored.
    cur.execute(COMPUTE_CTE + """
        select count(*)
        from trig
        join close_leads cl on cl.close_id = trig.lead_id
        where trig.reactivated_at is not null
          and (cl.reactivated_at is null or trig.reactivated_at < cl.reactivated_at)
    """, {"conf": CONF_TRIGGER})
    would_set = cur.fetchone()[0]

    print("=== reactivated_at backfill ===")
    print(f"trigger-positive leads (any trigger):  {trig_leads}")
    print(f"  via confirmation 'Setter pipeline':  {via_conf}")
    print(f"  via closer EOC ghost/cancel:         {via_eoc}")
    print(f"  via 3h strat-meeting lapse:          {via_lapse}")
    print(f"  (a lead can be positive on several; earliest timestamp wins)")
    print(f"matched & null-or-earlier:             {would_set}  <- rows this run would set")

    # Sample for eyeballing.
    cur.execute(COMPUTE_CTE + """
        select cl.close_id, cl.display_name, trig.reactivated_at,
               (trig.conf_t is not null) as via_conf,
               (trig.eoc_t is not null) as via_eoc,
               (trig.lapse_t is not null) as via_lapse
        from trig
        join close_leads cl on cl.close_id = trig.lead_id
        where trig.reactivated_at is not null
          and (cl.reactivated_at is null or trig.reactivated_at < cl.reactivated_at)
        order by trig.reactivated_at desc
        limit 8
    """, {"conf": CONF_TRIGGER})
    rows = cur.fetchall()
    if rows:
        print("\nsample (most recent):")
        for cid, name, at, vc, ve, vl in rows:
            src = "+".join([s for s, on in (("conf", vc), ("eoc", ve), ("lapse", vl)) if on])
            print(f"  {cid}  {(name or '(no name)')[:28]:28}  {at}  [{src}]")

    if not args.apply:
        print("\nDRY RUN — no write. Re-run with --apply to set the column.")
        conn.rollback()
        cur.close(); conn.close()
        return

    cur.execute(COMPUTE_CTE + """
        update close_leads cl
        set reactivated_at = trig.reactivated_at
        from trig
        where cl.close_id = trig.lead_id
          and trig.reactivated_at is not null
          and (cl.reactivated_at is null or trig.reactivated_at < cl.reactivated_at)
    """, {"conf": CONF_TRIGGER})
    updated = cur.rowcount
    conn.commit()
    print(f"\nAPPLIED — set reactivated_at on {updated} lead(s).")

    cur.execute("select count(*) from close_leads where reactivated_at is not null")
    print(f"total close_leads with reactivated_at now: {cur.fetchone()[0]}")
    cur.close(); conn.close()


if __name__ == "__main__":
    sys.exit(main())
