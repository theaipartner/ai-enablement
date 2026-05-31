#!/usr/bin/env python3
"""Backfill close_leads.reactivated_at (migration 0063).

A direct-booking lead becomes "reactivated" the moment it loses its
strategy-call spot. We detect that purely from the Airtable forms:

  Trigger A — confirmation/triage form (airtable_setter_triage_calls,
    form_type='Closer Triage Form') with call_status ~ 'Setter pipeline'
    (the setter handover, incl. the no-answer case). DQ does NOT trigger.

  Trigger B — closer EOC form (airtable_full_closer_report) for the strategy
    meeting whose outcome is a ghost/no-show or a cancel (NOT a reschedule,
    NOT a DQ, NOT a close/deposit/follow-up).

reactivated_at = the EARLIEST triggering form's airtable_created_at. Set once
(only where currently null) — permanent.

Candidate gate (so a setter-led lead's partnership-meeting ghost can't trigger
B): the lead must have a confirmation form at all. Every direct booking gets a
confirmation form (the closer fills it even on a no-answer), so "has a Closer
Triage Form" reliably means "direct lead." The A trigger is self-gating (the
confirmation form only exists for direct leads).

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

# CTE computing reactivated_at per lead. Reused by smoke + apply.
COMPUTE_CTE = """
with conf as (
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
eoc as (
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
trig as (
  select coalesce(conf.lead_id, eoc.lead_id) as lead_id,
         least(coalesce(conf.t, eoc.t), coalesce(eoc.t, conf.t)) as reactivated_at,
         conf.t as conf_t, eoc.t as eoc_t
  from conf
  full outer join eoc on conf.lead_id = eoc.lead_id
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
          count(*) filter (where conf_t is not null) as via_conf,
          count(*) filter (where eoc_t is not null) as via_eoc,
          count(*) filter (where conf_t is not null and eoc_t is not null) as via_both
        from trig
        where reactivated_at is not null
    """, {"conf": CONF_TRIGGER})
    trig_leads, via_conf, via_eoc, via_both = cur.fetchone()

    cur.execute(COMPUTE_CTE + """
        select count(*)
        from trig
        join close_leads cl on cl.close_id = trig.lead_id
        where trig.reactivated_at is not null and cl.reactivated_at is null
    """, {"conf": CONF_TRIGGER})
    would_set = cur.fetchone()[0]

    print("=== reactivated_at backfill ===")
    print(f"trigger-positive leads (by form):      {trig_leads}")
    print(f"  via confirmation 'Setter pipeline':  {via_conf}")
    print(f"  via closer EOC ghost/cancel:         {via_eoc}")
    print(f"  via both (earliest wins):            {via_both}")
    print(f"matched to a close_leads row & null:   {would_set}  <- rows this run would set")

    # Sample for eyeballing.
    cur.execute(COMPUTE_CTE + """
        select cl.close_id, cl.display_name, trig.reactivated_at,
               (trig.conf_t is not null) as via_conf, (trig.eoc_t is not null) as via_eoc
        from trig
        join close_leads cl on cl.close_id = trig.lead_id
        where trig.reactivated_at is not null and cl.reactivated_at is null
        order by trig.reactivated_at desc
        limit 8
    """, {"conf": CONF_TRIGGER})
    rows = cur.fetchall()
    if rows:
        print("\nsample (most recent):")
        for cid, name, at, vc, ve in rows:
            src = "conf+eoc" if (vc and ve) else "conf" if vc else "eoc"
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
          and cl.reactivated_at is null
    """, {"conf": CONF_TRIGGER})
    updated = cur.rowcount
    conn.commit()
    print(f"\nAPPLIED — set reactivated_at on {updated} lead(s).")

    cur.execute("select count(*) from close_leads where reactivated_at is not null")
    print(f"total close_leads with reactivated_at now: {cur.fetchone()[0]}")
    cur.close(); conn.close()


if __name__ == "__main__":
    sys.exit(main())
