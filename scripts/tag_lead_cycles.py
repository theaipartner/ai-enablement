"""Phase 3 — the lead tagger.

Reads lead_cycles (the spine) + raw signals, computes the identity tags
(direct / reactive / dq) on lead_cycles and the per-phase journey stages on
lead_cycle_stages. ONE place for all the rules. Dry-run by default; --apply
writes. Cloud per docs/runbooks/apply_migrations.md.

Rules:
  direct   = earliest "Ai Partner Strategy Call" booking in the cycle, only if
             at/before reactive_at (a direct booking after reactive is logged,
             not tagged — the excluded {opt_in,reactive,direct} edge).
  reactive = min of (A) cold: first >3-day gap between contacts (opt-in +
             inbound SMS + >=90s calls either direction) with no active future
             booking at the cold moment; (B) partnership re-book: a direct cycle
             that booked a "Partnership Call w/". BLOCKED if a DQ or close (HT or
             DC) happened at/before the candidate moment (no reactivation after a
             terminal).
  dq       = earliest DQ output (setter-triage DQ / confirmation DQ-Un-interested
             / closer-EOC DQ-Bad-Fit / DC Follow Up?=No). Stored always; HT-close
             suppression is read-time only.
  stages   = HT-ONLY journey, per phase (primary=pre-reactive, reactive=post),
             attributed by event-OR-filed time vs reactive_at, monotonic
             back-fill. connected lights from raw evidence OR confirmed/showed/
             closed (a confirm auto-lights connected, incl. direct); a pure
             UNconfirmed direct-primary booking does NOT light connected (skip).
             Digital College sales do NOT populate stages (HT-only funnel, DC
             branch later) — DC only feeds the DQ tag + the reactivation block.
             Aman's closer-EOC DC downsell ('Digital College Closed') DOES count
             as an HT showed (they were on the HT call) but not an HT close.
"""
import argparse
import re
import urllib.parse
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg2
from psycopg2.extras import execute_values

DIRECT_URI = "https://api.calendly.com/event_types/8f6795d3-992a-4cbd-b584-9ecaabb3938c"
CONNECTED_SEC = 90
COLD = timedelta(days=3)
NOW = datetime.now(timezone.utc)

GOLDEN = {
    "lead_GtB7zTmWgOsgLwSgqtNiEMhSKzpDfhdywUvjTWu29qY": "Presley Caillot (DQ via confirmation)",
    "lead_fm2oLHzaR2wzxHkoSDveGC7l0LRSqO2diB61FWuO3ty": "Jason Bright (DC close -> NOT reactive, NOT HT closed)",
    "lead_suEWwuazKBs7ev6ATnm7rNQi6qKi5PIaPtu4OWQ7LvN": "Richard Harper (DC show via Robby -> not in HT stages)",
    "lead_OTPPgwQb36KddHuDbp8CUt8Y6l13Iyj24sLifgsLZ7o": "Daniyal Qasim (3 opt-ins, multi-cycle)",
    "lead_hceyWL1wxBG9xoWBraa6x8iScDhDxXdhQUVqKkwJOUv": "Nand Modi (DQ -> NOT reactive)",
}


def digits10(s):
    d = re.sub(r"\D", "", s or "")
    return d[-10:] if len(d) >= 10 else None


def norm(s):
    return (s or "").strip().lower()


def connect():
    env = {}
    for ln in Path(".env.local").read_text().splitlines():
        if ln.strip() and not ln.startswith("#") and "=" in ln:
            k, _, v = ln.partition("=")
            env[k.strip()] = v.strip().strip('"').strip("'")
    pw = urllib.parse.quote(env["SUPABASE_DB_PASSWORD"], safe="")
    m = re.match(r"^(postgresql://[^@]+)@(.+)$", Path("supabase/.temp/pooler-url").read_text().strip())
    return psycopg2.connect(f"{m.group(1)}:{pw}@{m.group(2)}", sslmode="require", connect_timeout=20)


def outcome_close_type(co):
    v = norm(co)
    if "high ticket closed" in v:
        return "ht"
    if "digital college closed" in v:
        return "dc"
    return None


def outcome_showed(co):
    v = norm(co)
    if not v:
        return False
    return not any(x in v for x in ("ghost", "no show", "reschedul", "cancel"))


def main(apply):
    conn = connect()
    cur = conn.cursor()

    # --- cycles (the spine) ---
    cur.execute("select close_id, opt_in_at from lead_cycles order by close_id, opt_in_at")
    cycles_by_lead = defaultdict(list)
    for close_id, opt_in_at in cur.fetchall():
        cycles_by_lead[close_id].append(opt_in_at)
    lead_ids = list(cycles_by_lead.keys())

    # --- identity maps for calendly matching ---
    cur.execute("select close_id, utm_term from close_leads where utm_term is not null")
    term_to_lead = {}
    for cid, term in cur.fetchall():
        if term not in term_to_lead:
            term_to_lead[term] = cid
        elif term_to_lead[term] != cid:
            term_to_lead[term] = None  # ambiguous
    email_to_lead, phone_to_lead, name_to_lead = {}, {}, {}
    cur.execute("select close_id, display_name, contacts from close_leads where close_id = any(%s)", (lead_ids,))
    for cid, dname, contacts in cur.fetchall():
        if dname:
            name_to_lead.setdefault(norm(dname), cid)
        for c in contacts or []:
            for e in c.get("emails") or []:
                if e.get("email"):
                    email_to_lead.setdefault(norm(e["email"]), cid)
            for p in c.get("phones") or []:
                d = digits10(p.get("phone"))
                if d:
                    phone_to_lead.setdefault(d, cid)

    def resolve(utm, email, phone, name):
        if utm and term_to_lead.get(utm):
            return term_to_lead[utm]
        for key, mp in ((norm(email), email_to_lead), (digits10(phone), phone_to_lead), (norm(name), name_to_lead)):
            if key and mp.get(key):
                return mp[key]
        return None

    # --- calendly bookings -> per lead ---
    cur.execute("""
        select e.event_type_uri, e.name, e.start_time, e.status, e.event_created_at,
               i.email, i.name, i.raw_payload
        from calendly_scheduled_events e
        join calendly_invitees i on i.event_uri = e.uri
        where (e.event_type_uri = %s or e.name ilike 'Partnership Call w/%%')
          and e.excluded_at is null
    """, (DIRECT_URI,))
    bookings = defaultdict(list)  # close_id -> [(kind, start_time, status, created_at)]
    for etype, ename, start, status, created, iemail, iname, raw in cur.fetchall():
        utm = (raw or {}).get("tracking", {}).get("utm_term") if isinstance(raw, dict) else None
        phone = raw.get("text_reminder_number") if isinstance(raw, dict) else None
        cid = resolve(utm, iemail, phone, iname)
        if not cid or cid not in cycles_by_lead:
            continue
        kind = "direct" if etype == DIRECT_URI else "partnership"
        bookings[cid].append((kind, start, norm(status), created))

    # --- calls (>=90s) + sms (inbound) ---
    calls90 = defaultdict(list)
    cur.execute("select lead_id, activity_at from close_calls where lead_id = any(%s) and duration >= %s and activity_at is not null", (lead_ids, CONNECTED_SEC))
    for lid, at in cur.fetchall():
        calls90[lid].append(at)
    sms_in = defaultdict(list)
    cur.execute("select lead_id, date_created from close_sms where lead_id = any(%s) and direction = 'inbound' and date_created is not null", (lead_ids,))
    for lid, at in cur.fetchall():
        sms_in[lid].append(at)

    # --- airtable forms ---
    triage = defaultdict(list)
    cur.execute("select lead_id, form_type, call_status, airtable_created_at from airtable_setter_triage_calls where lead_id = any(%s)", (lead_ids,))
    for lid, ft, cs, filed in cur.fetchall():
        triage[lid].append((ft, norm(cs), filed))
    closer = defaultdict(list)
    cur.execute("select lead_id, call_outcome, date_time_of_call, airtable_created_at from airtable_full_closer_report where form_type='New' and lead_id = any(%s)", (lead_ids,))
    for lid, co, ev, filed in cur.fetchall():
        closer[lid].append((co, ev, filed))
    dc = defaultdict(list)
    cur.execute("select lead_id, closed, follow_up, date_time_of_call, airtable_created_at from airtable_digital_college_sales where excluded_at is null and lead_id = any(%s)", (lead_ids,))
    for lid, cl, fu, ev, filed in cur.fetchall():
        dc[lid].append((norm(cl), norm(fu), ev, filed))

    cycle_rows, stage_rows, golden_out = [], [], {}

    for cid, opt_ins in cycles_by_lead.items():
        opt_ins = sorted(opt_ins)
        for idx, opt_in_at in enumerate(opt_ins):
            cyc_end = opt_ins[idx + 1] if idx + 1 < len(opt_ins) else NOW + timedelta(days=3650)

            def in_cycle(t):
                return t is not None and opt_in_at <= t < cyc_end

            cyc_bookings = [b for b in bookings.get(cid, []) if in_cycle(b[3])]
            direct_bks = sorted([b[3] for b in cyc_bookings if b[0] == "direct"])
            partner_bks = sorted([b[3] for b in cyc_bookings if b[0] == "partnership"])
            direct_candidate = direct_bks[0] if direct_bks else None
            partner_first = partner_bks[0] if partner_bks else None

            contacts = sorted([opt_in_at]
                              + [t for t in calls90.get(cid, []) if in_cycle(t)]
                              + [t for t in sms_in.get(cid, []) if in_cycle(t)])

            # --- pass 1: phase-agnostic dq tag + terminal (close/dq) times ---
            dq_at, dq_source = None, None

            def setdq(t, src):
                nonlocal dq_at, dq_source
                if t is not None and in_cycle(t) and (dq_at is None or t < dq_at):
                    dq_at, dq_source = t, src

            ht_close_at, dc_close_at = None, None
            for ft, cs, filed in triage.get(cid, []):
                if in_cycle(filed) and "dq" in cs:
                    setdq(filed, "confirmation" if ft == "Closer Triage Form" else "triage")
            for co, ev, filed in closer.get(cid, []):
                t = ev or filed
                if not in_cycle(t):
                    continue
                if "dq" in norm(co):
                    setdq(t, "closer_eoc")
                ct = outcome_close_type(co)
                if ct == "ht":
                    ht_close_at = t if ht_close_at is None or t < ht_close_at else ht_close_at
                elif ct == "dc":
                    dc_close_at = t if dc_close_at is None or t < dc_close_at else dc_close_at
            for cl, fu, ev, filed in dc.get(cid, []):
                t = ev or filed
                if not in_cycle(t):
                    continue
                if fu == "no":
                    setdq(t, "dc_followup_no")
                if cl == "yes":
                    dc_close_at = t if dc_close_at is None or t < dc_close_at else dc_close_at
            terminals = [x for x in (dq_at, ht_close_at, dc_close_at) if x is not None]
            terminal_time = min(terminals) if terminals else None

            # --- reactive (cold OR partnership-rebook), blocked after a terminal ---
            active_starts = [b[1] for b in cyc_bookings if b[2] != "canceled" and b[1] is not None]

            def has_active_future(T):
                return any(s > T for s in active_starts)

            react_a = None
            for i, c in enumerate(contacts):
                gap_end = contacts[i + 1] if i + 1 < len(contacts) else min(cyc_end, NOW)
                if gap_end - c > COLD:
                    cold = c + COLD
                    if cold < cyc_end and not has_active_future(cold):
                        react_a = cold
                        break
            react_b = partner_first if (direct_candidate is not None and partner_first is not None) else None
            reactive_at, reactive_source = None, None
            for cand, src in ((react_a, "cold"), (react_b, "partnership_rebook")):
                if cand is not None and (reactive_at is None or cand < reactive_at):
                    reactive_at, reactive_source = cand, src
            if reactive_at is not None and terminal_time is not None and reactive_at >= terminal_time:
                reactive_at, reactive_source = None, None  # no reactivation after a close/dq

            became_direct = None
            if direct_candidate is not None and (reactive_at is None or direct_candidate <= reactive_at):
                became_direct = direct_candidate
            is_direct = became_direct is not None

            def phase_of(event_t, filed_t=None):
                if reactive_at is None:
                    return "primary"
                if (event_t and event_t >= reactive_at) or (filed_t and filed_t >= reactive_at):
                    return "reactive"
                return "primary"

            # --- pass 2: HT-only journey stages per phase (DC sales excluded) ---
            ph = {"primary": dict(conn=[], book=[], confirm=[], show=[], close=[]),
                  "reactive": dict(conn=[], book=[], confirm=[], show=[], close=[])}
            for kind, start, status, created in cyc_bookings:
                ph[phase_of(created)]["book"].append(created)
            for t in calls90.get(cid, []):
                if in_cycle(t):
                    ph[phase_of(t)]["conn"].append(t)
            for ft, cs, filed in triage.get(cid, []):
                if not in_cycle(filed):
                    continue
                p = phase_of(filed, filed)
                if ft == "Closer Triage Form":
                    if cs.startswith("confirmed"):
                        ph[p]["confirm"].append(filed)
                    if cs and "unresponsive" not in cs and "handover" not in cs:
                        ph[p]["conn"].append(filed)
                else:
                    ph[p]["conn"].append(filed)
            for co, ev, filed in closer.get(cid, []):
                t = ev or filed
                if not in_cycle(t):
                    continue
                p = phase_of(ev, filed)
                if outcome_showed(co):
                    ph[p]["show"].append(t)
                if outcome_close_type(co) == "ht":
                    ph[p]["close"].append(t)

            cycle_rows.append((cid, opt_in_at, became_direct, reactive_at, reactive_source, dq_at, dq_source))

            for p in ("primary", "reactive"):
                if reactive_at is None and p == "reactive":
                    continue
                ev = ph[p]
                raw_conn = min(ev["conn"]) if ev["conn"] else None
                raw_book = min(ev["book"]) if ev["book"] else None
                raw_show = min(ev["show"]) if ev["show"] else None
                raw_close = min(ev["close"]) if ev["close"] else None
                raw_confirm = (min(ev["confirm"]) if ev["confirm"] else None) if (is_direct and p == "primary") else raw_book
                closed_at = raw_close
                close_type = "ht" if closed_at else None
                showed_at = raw_show or closed_at
                confirmed_at = raw_confirm or showed_at or closed_at
                booked_at = raw_book or confirmed_at or showed_at or closed_at
                connected_at = raw_conn or confirmed_at or showed_at or closed_at
                if any([connected_at, booked_at, confirmed_at, showed_at, closed_at]):
                    stage_rows.append((cid, opt_in_at, p, connected_at, booked_at, confirmed_at, showed_at, closed_at, close_type))

            if cid in GOLDEN:
                golden_out.setdefault(cid, []).append(dict(
                    opt_in=str(opt_in_at)[:10], direct=bool(became_direct),
                    reactive=str(reactive_at)[:16] if reactive_at else None, rsrc=reactive_source,
                    dq=str(dq_at)[:10] if dq_at else None, dqsrc=dq_source))

    # --- report ---
    print(f"cycles: {len(cycle_rows)}  | direct={sum(1 for r in cycle_rows if r[2])}  "
          f"reactive={sum(1 for r in cycle_rows if r[3])}  dq={sum(1 for r in cycle_rows if r[5])}")
    rsrc = defaultdict(int)
    for r in cycle_rows:
        if r[4]:
            rsrc[r[4]] += 1
    print(f"reactive_source: {dict(rsrc)}")
    stage_counts = {s: sum(1 for r in stage_rows if r[idx]) for idx, s in
                    [(3, "connected"), (4, "booked"), (5, "confirmed"), (6, "showed"), (7, "closed")]}
    print(f"stage rows: {len(stage_rows)}  | reached: {stage_counts}  "
          f"(ht closes={sum(1 for r in stage_rows if r[8]=='ht')})")
    print("\nGOLDEN leads:")
    for cid, desc in GOLDEN.items():
        print(f"  {desc}\n    {golden_out.get(cid, 'NOT FOUND')}")
        for sr in [r for r in stage_rows if r[0] == cid]:
            lit = [s for s, v in zip(["conn", "book", "confirm", "show", "close"], sr[3:8]) if v]
            print(f"      stages[{sr[2]}]: {lit}  close_type={sr[8]}")

    if not apply:
        print("\nDRY RUN — nothing written. Re-run with --apply.")
        cur.close(); conn.close()
        return

    execute_values(cur, """
        update lead_cycles c set
          became_direct_at = v.became_direct_at, reactive_at = v.reactive_at,
          reactive_source = v.reactive_source, dq_at = v.dq_at, dq_source = v.dq_source, updated_at = now()
        from (values %s) as v(close_id, opt_in_at, became_direct_at, reactive_at, reactive_source, dq_at, dq_source)
        where c.close_id = v.close_id and c.opt_in_at = v.opt_in_at
    """, cycle_rows, template="(%s,%s::timestamptz,%s::timestamptz,%s::timestamptz,%s,%s::timestamptz,%s)")
    execute_values(cur, """
        insert into lead_cycle_stages (close_id, opt_in_at, phase, connected_at, booked_at, confirmed_at, showed_at, closed_at, close_type)
        values %s
        on conflict (close_id, opt_in_at, phase) do update set
          connected_at=excluded.connected_at, booked_at=excluded.booked_at, confirmed_at=excluded.confirmed_at,
          showed_at=excluded.showed_at, closed_at=excluded.closed_at, close_type=excluded.close_type, updated_at=now()
    """, stage_rows, template="(%s,%s::timestamptz,%s,%s::timestamptz,%s::timestamptz,%s::timestamptz,%s::timestamptz,%s::timestamptz,%s)")
    conn.commit()
    print(f"\nAPPLIED. updated {len(cycle_rows)} cycles, wrote {len(stage_rows)} stage rows.")
    cur.close(); conn.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    main(ap.parse_args().apply)
