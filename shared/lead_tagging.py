"""Lead tagging — the single source of truth for lead_cycles + lead_cycle_stages.

Reconstructs opt-in cycles (Typeform SFedWelr matched by email/phone, with a
close_leads.latest_opt_in_date fallback) and computes identity tags (direct /
reactive / dq) + HT-only journey stages. ONE place for all the rules.

Callers:
  - api/airtable_sync_cron.py   — periodic, scoped to active (non-terminal) leads
  - the webhook receivers        — per-lead, live (retag the payload's lead(s))
  - scripts/backfill_lead_tags.py — full rebuild (--apply)

Connection: the TRANSACTION pooler (port 6543) in Vercel via SUPABASE_DB_POOL_URL
(serverless-correct: many short-lived connections multiplexed onto few server
connections). Local falls back to supabase/.temp/pooler-url + SUPABASE_DB_PASSWORD.

Every retag is logged to lead_tag_runs; the exception-only admin page surfaces
runs that errored or produced an anomaly (a set-once identity tag that changed).

Rules (authoritative — mirror docs/sales-dashboard-architecture.md):
  direct   = earliest "Ai Partner Strategy Call" Calendly self-book in the cycle,
             only if at/before reactive_at.
  reactive = min of (A) cold: first >3-day gap between contacts (opt-in + inbound
             SMS + >=90s calls either direction) with no active future booking;
             (B) partnership re-book: a direct cycle gets a classic setter triage
             "High Ticket booking". BLOCKED if a dq/close happened at/before it.
  dq       = earliest DQ output (triage / confirmation / closer-EOC / DC Follow
             Up?=No). Stored always; HT-close suppression is read-time only.
  stages   = HT-only, per phase (primary / reactive). Setter-led booked comes from
             the triage FORM ("High Ticket booking"; "Digital College booking" and
             confirmation "Downsold" => connected only). Direct booked = the
             Calendly self-book. A confirm auto-lights connected (incl. direct); a
             pure unconfirmed direct-primary booking does NOT (the skip). DC sales
             never enter the HT stages (DQ tag + reactivation block only).
"""
from __future__ import annotations

import os
import re
import time
import traceback
import urllib.parse
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg2
from psycopg2.extras import Json, execute_values

EFFECTIVE_DATE = "2026-05-24"
OPT_IN_FORM = "SFedWelr"
DIRECT_URI = "https://api.calendly.com/event_types/8f6795d3-992a-4cbd-b584-9ecaabb3938c"
# Robby's dedicated Digital College call. A DC close is now copied onto the
# regular closer EOC form, so the Calendly event type is how we tell an Aman
# downsell (on a partnership/strat call → an HT show) from a Robby DC call
# (NOT an HT show).
ROBBY_DC_URI = "https://api.calendly.com/event_types/6f06c6ba-6ca2-48d2-ae17-a6c5c1ee75ec"
CONNECTED_SEC = 90
COLD = timedelta(days=3)

_REPO_ROOT = Path(__file__).resolve().parent.parent


def _now() -> datetime:
    return datetime.now(timezone.utc)


def digits10(s):
    d = re.sub(r"\D", "", s or "")
    return d[-10:] if len(d) >= 10 else None


def norm(s):
    return (s or "").strip().lower()


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


def _connect():
    """Connect to Postgres via the transaction pooler.

    Vercel (two env vars, foolproof against password special-chars):
      SUPABASE_DB_POOL_URL  — password-LESS, e.g.
        postgresql://postgres.<ref>@aws-...pooler.supabase.com:6543/postgres
      SUPABASE_DB_PASSWORD  — raw password; the module URL-encodes + injects it.
    A SUPABASE_DB_POOL_URL that already embeds a password is used verbatim.
    Local: no SUPABASE_DB_POOL_URL -> fall back to supabase/.temp/pooler-url +
    SUPABASE_DB_PASSWORD from .env.local (session pooler is fine for one-shots)."""
    url = os.getenv("SUPABASE_DB_POOL_URL")
    pw = os.getenv("SUPABASE_DB_PASSWORD")
    if url:
        # Inject the password into a password-less URL (userinfo has no ':pass').
        m = re.match(r"^(postgresql://)([^:@/]+)(:[^@]*)?@(.+)$", url)
        if m and not m.group(3) and pw:
            url = f"{m.group(1)}{m.group(2)}:{urllib.parse.quote(pw, safe='')}@{m.group(4)}"
        return psycopg2.connect(url, sslmode="require", connect_timeout=20)
    # Local fallback.
    env = {}
    env_path = _REPO_ROOT / ".env.local"
    if env_path.exists():
        for ln in env_path.read_text().splitlines():
            if ln.strip() and not ln.startswith("#") and "=" in ln:
                k, _, v = ln.partition("=")
                env[k.strip()] = v.strip().strip('"').strip("'")
    pw = urllib.parse.quote(env["SUPABASE_DB_PASSWORD"], safe="")
    m = re.match(r"^(postgresql://[^@]+)@(.+)$", (_REPO_ROOT / "supabase/.temp/pooler-url").read_text().strip())
    return psycopg2.connect(f"{m.group(1)}:{pw}@{m.group(2)}", sslmode="require", connect_timeout=20)


# --------------------------------------------------------------------------- #
# Core compute — returns (cycle_rows, stage_rows) for the given leads (or all   #
# in-scope when lead_ids is None). Pure read; no writes.                        #
# --------------------------------------------------------------------------- #
def _compute(cur, lead_ids):
    scoped = lead_ids is not None
    # 1. In-scope lead universe + identity.
    if scoped:
        cur.execute(
            "select close_id, display_name, contacts, latest_opt_in_date from close_leads "
            "where close_id = any(%s) and latest_opt_in_date >= %s and excluded_at is null",
            (list(lead_ids), EFFECTIVE_DATE),
        )
    else:
        cur.execute(
            "select close_id, display_name, contacts, latest_opt_in_date from close_leads "
            "where latest_opt_in_date >= %s and excluded_at is null",
            (EFFECTIVE_DATE,),
        )
    lead_emails, lead_phones, lead_name, lead_latest = {}, {}, {}, {}
    for cid, dname, contacts, latest in cur.fetchall():
        emails, phones = set(), set()
        for c in contacts or []:
            for e in c.get("emails") or []:
                if e.get("email"):
                    emails.add(norm(e["email"]))
            for p in c.get("phones") or []:
                d = digits10(p.get("phone"))
                if d:
                    phones.add(d)
        lead_emails[cid] = emails
        lead_phones[cid] = phones
        if dname:
            lead_name[cid] = norm(dname)
        lead_latest[cid] = latest
    ids = list(lead_emails.keys())
    if not ids:
        return [], []

    # 2. Cycle reconstruction — Typeform SFedWelr by email/phone, else fallback.
    cur.execute(
        """select submitted_at,
             lower(trim((select a->>'email' from jsonb_array_elements(answers) a where a->>'type'='email' limit 1))),
             (select a->>'phone_number' from jsonb_array_elements(answers) a where a->>'type'='phone_number' limit 1)
           from typeform_responses where form_id = %s and submitted_at >= %s""",
        (OPT_IN_FORM, EFFECTIVE_DATE),
    )
    tf_by_email, tf_by_phone = defaultdict(list), defaultdict(list)
    for submitted_at, email, phone in cur.fetchall():
        if email:
            tf_by_email[email].append(submitted_at)
        d = digits10(phone)
        if d:
            tf_by_phone[d].append(submitted_at)

    cycles_by_lead = {}
    for cid in ids:
        subs = []
        for e in lead_emails[cid]:
            subs += tf_by_email.get(e, [])
        for p in lead_phones[cid]:
            subs += tf_by_phone.get(p, [])
        by_min = {}
        for ts in subs:
            key = ts.replace(second=0, microsecond=0)
            if key not in by_min or ts < by_min[key]:
                by_min[key] = ts
        times = sorted(by_min.values())
        if times:
            cycles_by_lead[cid] = (sorted(times), "typeform")
        else:
            cycles_by_lead[cid] = ([lead_latest[cid]], "close_fallback")

    # 3. Matching maps for Calendly (utm global-unique; identity for in-scope leads).
    cur.execute("select close_id, utm_term from close_leads where utm_term is not null")
    term_to_lead = {}
    for cid, term in cur.fetchall():
        if term not in term_to_lead:
            term_to_lead[term] = cid
        elif term_to_lead[term] != cid:
            term_to_lead[term] = None
    email_to_lead, phone_to_lead, name_to_lead = {}, {}, {}
    for cid in ids:
        for e in lead_emails[cid]:
            email_to_lead.setdefault(e, cid)
        for p in lead_phones[cid]:
            phone_to_lead.setdefault(p, cid)
        if cid in lead_name:
            name_to_lead.setdefault(lead_name[cid], cid)

    def resolve(utm, email, phone, name):
        if utm and term_to_lead.get(utm):
            return term_to_lead[utm]
        for key, mp in ((norm(email), email_to_lead), (digits10(phone), phone_to_lead), (norm(name), name_to_lead)):
            if key and mp.get(key):
                return mp[key]
        return None

    cur.execute(
        """select e.event_type_uri, e.name, e.start_time, e.status, e.event_created_at,
                  i.email, i.name, i.raw_payload
           from calendly_scheduled_events e
           join calendly_invitees i on i.event_uri = e.uri
           where (e.event_type_uri = any(%s) or e.name ilike 'Partnership Call w/%%') and e.excluded_at is null""",
        ([DIRECT_URI, ROBBY_DC_URI],),
    )
    bookings = defaultdict(list)
    for etype, ename, start, status, created, iemail, iname, raw in cur.fetchall():
        utm = (raw or {}).get("tracking", {}).get("utm_term") if isinstance(raw, dict) else None
        phone = raw.get("text_reminder_number") if isinstance(raw, dict) else None
        cid = resolve(utm, iemail, phone, iname)
        if cid in cycles_by_lead:
            kind = "direct" if etype == DIRECT_URI else "dc_robby" if etype == ROBBY_DC_URI else "partnership"
            bookings[cid].append((kind, start, norm(status), created))

    # 4. Per-lead signals (forms / calls / sms).
    def fetch(table, cols, extra=""):
        cur.execute(f"select lead_id, {cols} from {table} where lead_id = any(%s) {extra}", (ids,))
        return cur.fetchall()

    calls90, sms_in = defaultdict(list), defaultdict(list)
    for lid, at in fetch("close_calls", "activity_at", f"and duration >= {CONNECTED_SEC} and activity_at is not null"):
        calls90[lid].append(at)
    for lid, at in fetch("close_sms", "date_created", "and direction = 'inbound' and date_created is not null"):
        sms_in[lid].append(at)
    triage, closer, dc = defaultdict(list), defaultdict(list), defaultdict(list)
    for lid, ft, cs, filed in fetch("airtable_setter_triage_calls", "form_type, call_status, airtable_created_at"):
        triage[lid].append((ft, norm(cs), filed))
    for lid, co, ev, filed, cnames in fetch("airtable_full_closer_report", "call_outcome, date_time_of_call, airtable_created_at, closer_names", "and form_type='New'"):
        closer[lid].append((co, ev, filed, cnames))
    for lid, cl, fu, ev, filed in fetch("airtable_digital_college_sales", "closed, follow_up, date_time_of_call, airtable_created_at", "and excluded_at is null"):
        dc[lid].append((norm(cl), norm(fu), ev, filed))

    # 5. Compute tags + stages per cycle (the verified logic).
    now = _now()
    cycle_rows, stage_rows = [], []
    for cid in ids:
        opt_ins, source = cycles_by_lead[cid]
        for idx, opt_in_at in enumerate(opt_ins):
            cyc_end = opt_ins[idx + 1] if idx + 1 < len(opt_ins) else now + timedelta(days=3650)

            def in_cycle(t):
                return t is not None and opt_in_at <= t < cyc_end

            cyc_bk = [b for b in bookings.get(cid, []) if in_cycle(b[3])]
            direct_bks = sorted([b[3] for b in cyc_bk if b[0] == "direct"])
            direct_candidate = direct_bks[0] if direct_bks else None
            contacts = sorted([opt_in_at]
                              + [t for t in calls90.get(cid, []) if in_cycle(t)]
                              + [t for t in sms_in.get(cid, []) if in_cycle(t)])

            dq_at = dq_source = None

            def setdq(t, src):
                nonlocal dq_at, dq_source
                if t is not None and in_cycle(t) and (dq_at is None or t < dq_at):
                    dq_at, dq_source = t, src

            ht_close_at = dc_close_at = setter_htbook_at = None
            for ft, cs, filed in triage.get(cid, []):
                if not in_cycle(filed):
                    continue
                if "dq" in cs:
                    setdq(filed, "confirmation" if ft == "Closer Triage Form" else "triage")
                if ft != "Closer Triage Form" and "high ticket booking" in cs:
                    setter_htbook_at = filed if setter_htbook_at is None or filed < setter_htbook_at else setter_htbook_at
            for co, ev, filed, _cnames in closer.get(cid, []):
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

            active_starts = [b[1] for b in cyc_bk if b[2] != "canceled" and b[1] is not None]

            def has_active_future(T):
                return any(s > T for s in active_starts)

            react_a = None
            for i, c in enumerate(contacts):
                gap_end = contacts[i + 1] if i + 1 < len(contacts) else min(cyc_end, now)
                if gap_end - c > COLD:
                    cold = c + COLD
                    if cold < cyc_end and not has_active_future(cold):
                        react_a = cold
                        break
            react_b = setter_htbook_at if (direct_candidate is not None and setter_htbook_at is not None) else None
            reactive_at = reactive_source = None
            for cand, src in ((react_a, "cold"), (react_b, "partnership_rebook")):
                if cand is not None and (reactive_at is None or cand < reactive_at):
                    reactive_at, reactive_source = cand, src
            if reactive_at is not None and terminal_time is not None and reactive_at >= terminal_time:
                reactive_at = reactive_source = None

            became_direct = direct_candidate if (direct_candidate is not None and (reactive_at is None or direct_candidate <= reactive_at)) else None
            is_direct = became_direct is not None

            def phase_of(event_t, filed_t=None):
                if reactive_at is None:
                    return "primary"
                if (event_t and event_t >= reactive_at) or (filed_t and filed_t >= reactive_at):
                    return "reactive"
                return "primary"

            ph = {"primary": dict(conn=[], book=[], confirm=[], show=[], close=[]),
                  "reactive": dict(conn=[], book=[], confirm=[], show=[], close=[])}
            for kind, start, status, created in cyc_bk:
                if kind == "direct":
                    ph[phase_of(created)]["book"].append(created)
            for t in calls90.get(cid, []):
                if in_cycle(t):
                    ph[phase_of(t)]["conn"].append(t)
            for ft, cs, filed in triage.get(cid, []):
                if not in_cycle(filed):
                    continue
                p = phase_of(filed, filed)
                reached = bool(cs) and "unresponsive" not in cs and "handover" not in cs
                if reached:
                    ph[p]["conn"].append(filed)
                if ft == "Closer Triage Form":
                    if cs.startswith("confirmed"):
                        ph[p]["confirm"].append(filed)
                        ph[p]["book"].append(filed)
                else:
                    if "high ticket booking" in cs or cs.startswith("confirmed"):
                        ph[p]["book"].append(filed)
            # Nearest Calendly event-kind to a call time (backup signal): a
            # "Call with Robby" (dc_robby) event near the form = a Robby DC call.
            def nearest_event_kind(when):
                if when is None:
                    return None
                cands = sorted(
                    (abs((s - when).total_seconds()), k)
                    for (k, s, _st, _cr) in bookings.get(cid, []) if s is not None
                )
                return cands[0][1] if cands and cands[0][0] <= 2 * 86400 else None

            for co, ev, filed, cnames in closer.get(cid, []):
                t = ev or filed
                if not in_cycle(t):
                    continue
                p = phase_of(ev, filed)
                # A "Digital College Closed" EOC is a DC sale (copied onto the
                # closer form). It's an HT SHOW only when it was an HT call — i.e.
                # NOT Robby's. Robby = the EOC submitter is Robby (closer_names),
                # or it sat on a "Call with Robby" Calendly event. Aman's downsell
                # on a strat/partnership call IS an HT show.
                if outcome_close_type(co) == "dc":
                    submitter_robby = any("robby" in norm(n) for n in (cnames or []))
                    robby_dc = submitter_robby or nearest_event_kind(ev or filed) == "dc_robby"
                    if not robby_dc:
                        ph[p]["show"].append(t)
                    continue
                if outcome_showed(co):
                    ph[p]["show"].append(t)
                if outcome_close_type(co) == "ht":
                    ph[p]["close"].append(t)

            cycle_rows.append((cid, opt_in_at, idx + 1, source, became_direct, reactive_at, reactive_source, dq_at, dq_source, dc_close_at))

            for p in ("primary", "reactive"):
                if reactive_at is None and p == "reactive":
                    continue
                e = ph[p]
                raw_conn = min(e["conn"]) if e["conn"] else None
                raw_book = min(e["book"]) if e["book"] else None
                raw_show = min(e["show"]) if e["show"] else None
                raw_close = min(e["close"]) if e["close"] else None
                raw_confirm = (min(e["confirm"]) if e["confirm"] else None) if (is_direct and p == "primary") else raw_book
                closed_at = raw_close
                close_type = "ht" if closed_at else None
                showed_at = raw_show or closed_at
                confirmed_at = raw_confirm or showed_at or closed_at
                booked_at = raw_book or confirmed_at or showed_at or closed_at
                connected_at = raw_conn or confirmed_at or showed_at or closed_at
                if any([connected_at, booked_at, confirmed_at, showed_at, closed_at]):
                    stage_rows.append((cid, opt_in_at, p, connected_at, booked_at, confirmed_at, showed_at, closed_at, close_type))

    return cycle_rows, stage_rows


def retag_by_contact(emails=None, phones=None, utm_terms=None, trigger="manual"):
    """Resolve identity (utm token / email / phone) -> in-scope close_id(s) and
    retag them. For the Calendly/Typeform webhooks, whose payloads carry the
    per-lead utm token (aaid_<uuid>) or an email/phone rather than a Close id. No
    match (e.g. a brand-new opt-in whose Close lead doesn't exist yet) is a clean
    no-op — the Close webhook tags it once the lead lands."""
    em = [norm(e) for e in (emails or []) if e]
    ph = [d for d in (digits10(p) for p in (phones or [])) if d]
    ut = [t for t in (utm_terms or []) if t]
    if not em and not ph and not ut:
        return {"ok": True, "lead_count": 0, "anomalies": [], "trigger": trigger, "lead_ids": []}
    conn = _connect()
    cur = conn.cursor()
    ids = set()
    if ut:
        # utm token -> close_id, UNIQUE-mapping only (a token shared across leads
        # is ambiguous and dropped — same guard as the dashboard resolver).
        cur.execute("select utm_term, close_id from close_leads where utm_term = any(%s)", (ut,))
        by_term = defaultdict(set)
        for term, cid in cur.fetchall():
            by_term[term].add(cid)
        for cids in by_term.values():
            if len(cids) == 1:
                ids.update(cids)
    if em:
        cur.execute(
            """select cl.close_id from close_leads cl
               cross join lateral jsonb_array_elements(coalesce(cl.contacts,'[]'::jsonb)) c
               cross join lateral jsonb_array_elements(coalesce(c->'emails','[]'::jsonb)) e
               where lower(trim(e->>'email')) = any(%s) and cl.latest_opt_in_date >= %s""",
            (em, EFFECTIVE_DATE),
        )
        ids.update(r[0] for r in cur.fetchall())
    if ph:
        cur.execute(
            r"""select cl.close_id from close_leads cl
                cross join lateral jsonb_array_elements(coalesce(cl.contacts,'[]'::jsonb)) c
                cross join lateral jsonb_array_elements(coalesce(c->'phones','[]'::jsonb)) p
                where right(regexp_replace(p->>'phone','\D','','g'),10) = any(%s) and cl.latest_opt_in_date >= %s""",
            (ph, EFFECTIVE_DATE),
        )
        ids.update(r[0] for r in cur.fetchall())
    cur.close()
    conn.close()
    if not ids:
        return {"ok": True, "lead_count": 0, "anomalies": [], "trigger": trigger, "lead_ids": []}
    return retag(lead_ids=list(ids), trigger=trigger)


def active_lead_ids(cur):
    """In-scope leads whose tags can still change — the bounded set the cron retags
    each tick. Excludes only stable-terminal leads (closed/dq and not re-opted since),
    so it stays bounded as the lead base grows. Includes: leads with a non-terminal
    cycle (can progress / go cold), brand-new opt-ins with no cycle yet, and leads
    that re-opted since their last stored cycle (a terminal lead that came back)."""
    cur.execute(
        """select cl.close_id from close_leads cl
           where cl.latest_opt_in_date >= %s and cl.excluded_at is null and (
             exists (select 1 from lead_cycles c
                     where c.close_id = cl.close_id and c.dq_at is null
                       and not exists (select 1 from lead_cycle_stages s
                                       where s.close_id = c.close_id and s.opt_in_at = c.opt_in_at
                                         and s.closed_at is not null))
             or not exists (select 1 from lead_cycles c2 where c2.close_id = cl.close_id)
             or cl.latest_opt_in_date > (select max(c3.opt_in_at) from lead_cycles c3 where c3.close_id = cl.close_id)
           )""",
        (EFFECTIVE_DATE,),
    )
    return [r[0] for r in cur.fetchall()]


def _detect_anomalies(cur, cycle_rows):
    """Set-once identity tags that changed/cleared on recompute = a bug/drift signal."""
    new = {(r[0], r[1]): (r[4], r[5], r[7]) for r in cycle_rows}  # (became_direct, reactive_at, dq_at)
    keys = list({k[0] for k in new})
    if not keys:
        return []
    cur.execute("select close_id, opt_in_at, became_direct_at, reactive_at, dq_at from lead_cycles where close_id = any(%s)", (keys,))
    out = []
    for cid, opt_in_at, d_old, r_old, q_old in cur.fetchall():
        nd = new.get((cid, opt_in_at))
        if nd is None:
            continue
        d_new, r_new, q_new = nd
        for label, old, newv in (("direct", d_old, d_new), ("reactive", r_old, r_new), ("dq", q_old, q_new)):
            if old is not None and (newv is None or newv != old):
                out.append({"close_id": cid, "kind": f"{label}_changed",
                            "detail": f"{old} -> {newv}"})
    return out


def retag(lead_ids=None, trigger="manual", active_only=False, log=True):
    """Recompute + persist tags for the given leads (None = all in-scope; active_only
    scopes to non-terminal leads — the cron default). Wipe-and-rebuild scoped to the
    lead set, so no stale rows. Logs the run to lead_tag_runs. Returns a summary dict.
    Best-effort logging never raises; the retag itself raises on failure (callers in
    webhooks wrap in try/except so ingestion is never broken)."""
    t0 = time.time()
    conn = _connect()
    conn.autocommit = False
    cur = conn.cursor()
    summary = {"trigger": trigger, "lead_ids": list(lead_ids) if lead_ids else None,
               "ok": False, "anomalies": [], "lead_count": 0}
    try:
        if active_only and lead_ids is None:
            lead_ids = active_lead_ids(cur)
        cycle_rows, stage_rows = _compute(cur, lead_ids)
        summary["anomalies"] = _detect_anomalies(cur, cycle_rows)
        summary["lead_count"] = len({r[0] for r in cycle_rows})

        touched = list({r[0] for r in cycle_rows}) or (list(lead_ids) if lead_ids else [])
        if touched:
            cur.execute("delete from lead_cycles where close_id = any(%s)", (touched,))  # cascades stages
        if cycle_rows:
            execute_values(cur,
                "insert into lead_cycles (close_id, opt_in_at, opt_in_seq, source, became_direct_at, reactive_at, reactive_source, dq_at, dq_source, dc_closed_at) values %s",
                cycle_rows,
                template="(%s,%s::timestamptz,%s,%s,%s::timestamptz,%s::timestamptz,%s,%s::timestamptz,%s,%s::timestamptz)")
        if stage_rows:
            execute_values(cur,
                "insert into lead_cycle_stages (close_id, opt_in_at, phase, connected_at, booked_at, confirmed_at, showed_at, closed_at, close_type) values %s",
                stage_rows,
                template="(%s,%s::timestamptz,%s,%s::timestamptz,%s::timestamptz,%s::timestamptz,%s::timestamptz,%s::timestamptz,%s)")
        conn.commit()
        summary["ok"] = True
    except Exception:
        conn.rollback()
        summary["error"] = traceback.format_exc()[-2000:]
        if log:
            _log_run(conn, summary, t0)
        cur.close(); conn.close()
        raise
    if log:
        _log_run(conn, summary, t0)
    cur.close(); conn.close()
    return summary


def _log_run(conn, summary, t0):
    try:
        cur = conn.cursor()
        cur.execute(
            "insert into lead_tag_runs (trigger, lead_ids, lead_count, ok, error, anomalies, duration_ms) "
            "values (%s,%s,%s,%s,%s,%s,%s)",
            (summary["trigger"], summary["lead_ids"], summary["lead_count"], summary["ok"],
             summary.get("error"), Json(summary["anomalies"]) if summary["anomalies"] else None,
             int((time.time() - t0) * 1000)),
        )
        conn.commit()
        cur.close()
    except Exception:
        pass  # logging is best-effort; never let it mask the real outcome
