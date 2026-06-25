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

Rules (authoritative — mirror docs/sales/sales-dashboard-architecture.md):
  direct   = earliest "Ai Partner Strategy Call" Calendly self-book in the cycle,
             only if at/before reactive_at.
  reactive = min of (A) cold: first >3-day gap between contacts (opt-in + inbound
             SMS + >=90s calls either direction) with no active future booking;
             (B) partnership re-book: a direct cycle gets a classic setter triage
             "High Ticket booking". BLOCKED if a dq/close happened at/before it.
  dq       = earliest DQ output (triage / confirmation / closer-EOC / DC Follow
             Up?=No). Stored always; HT-close suppression is read-time only.
  stages   = HT-only, per phase (primary / reactive). CONNECTED = a >=90s call
             (either direction) ONLY (Drake 2026-06-24) — a triage/confirmation FORM
             no longer lights connected; it back-fills from confirmed/showed/closed.
             Setter-led booked comes from the triage FORM ("High Ticket booking");
             direct booked = the Calendly self-book. A confirm still lights connected
             (via the confirmed->connected back-fill); a pure unconfirmed direct-primary
             booking does NOT (booked does not back-fill connected — so a self-booked
             direct lead is booked-but-not-connected). DC sales never enter the HT
             stages (DQ tag + reactivation block only).
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
# Typeform SFedWelr "how much are you willing to invest" choice field. Drives
# per-cycle qualification (>= $2,000 = qualified), replacing the stale
# close_leads.marketing_qualified flag.
INVEST_FIELD_REF = "5138f17b-eb31-4d36-bacb-88a8c83326ed"


def qual_from_investment(inv):
    """Typeform investment answer -> qualified flag. None when no/blank answer
    (treated as 'unknown'); 'Under $2,000' -> False; anything else -> True."""
    if not inv or not str(inv).strip():
        return None
    return "under" not in str(inv).lower()
# "DC Revival Lead" Close custom field. The re-engagement SMS auto-creates these
# leads in Close as New Opt-ins; the dashboard excludes them everywhere (the
# funnel cohort already filters them in getSpeedToLeadCohort). Exclude them from
# the tag universe too so lead_cycles never carries a revival lead (Drake
# 2026-06-05).
REVIVAL_CF = "cf_QivXkWBvr34UIDkUBKXNCQo6woarc62wEbIacWWbN7P"
DIRECT_URI = "https://api.calendly.com/event_types/8f6795d3-992a-4cbd-b584-9ecaabb3938c"
# Robby's dedicated Digital College call. A DC close is now copied onto the
# regular closer EOC form, so the Calendly event type is how we tell an Aman
# downsell (on a partnership/strat call → an HT show) from a Robby DC call
# (NOT an HT show).
ROBBY_DC_URI = "https://api.calendly.com/event_types/6f06c6ba-6ca2-48d2-ae17-a6c5c1ee75ec"

CONNECTED_SEC = 90
COLD = timedelta(days=3)

# Closer-identity routing (Drake 2026-06-05): the closer name on a form decides
# which funnel its outcome feeds. DC closers (low-ticket) are the named
# exception; everyone else is an HT closer. An HT closer can dip into DC via a
# downsell; a DC closer never touches HT.
# DC (low-ticket) closer name tokens. Current active DC closers: Adam, Bradley,
# Josh. Robby is INACTIVE but stays here so his ~50 historical DC forms remain
# classified as DC (dropping him would leak his non-close forms into the HT
# funnel). Everyone NOT listed is an HT closer by default (Aman + Cobe are the
# current HT closers; Jan/Seth/Joey/etc. are former HT closers kept HT for their
# historical closes). MUST stay in sync with lib/db/funnel-dc.ts DC_CLOSER_TOKENS.
DC_CLOSER_NAMES = ("robby", "bradley", "josh", "adam")


def is_dc_closer(names):
    """True if any closer name on the form is a Digital College closer."""
    return any(any(d in norm(n) for d in DC_CLOSER_NAMES) for n in (names or []))


def has_dc_plan(dc_plans):
    """A DC close is real only when a PLAN is actually selected — not just a
    'Digital College Closed' outcome (Robby marks that on everything). dc_plans
    is the closer-report 'What plan did we get them on?' text[] field."""
    return bool(dc_plans) and any((p or "").strip() for p in dc_plans)


def _earliest(*ts):
    vals = [t for t in ts if t is not None]
    return min(vals) if vals else None

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


def classify_plan(plan):
    """Offer for a LEGACY closer form's close, from payment_plan_type. Legacy
    closer-report closes predate DC-on-the-closer-form, so default to HT unless
    the plan explicitly names Digital College / Base44 / Wix."""
    v = norm(plan)
    if v and ("digital college" in v or "base44" in v or "base 44" in v or "wix" in v):
        return "dc"
    return "ht"


def closer_form_outcome(form_type, call_outcome, showed, closed, plan):
    """Normalize a closer EOC form to (showed_bool, close_type, is_dq). New forms
    use Call Outcome; legacy/old forms (form_type not 'New') use the Showed? /
    Closed? / Payment Plan Type fields the redesign replaced. Legacy forms have
    no clean DQ field, so is_dq is False for them (DQ still comes from the new
    Call Outcome, triage, and DC paths)."""
    if form_type == "New":
        return outcome_showed(call_outcome), outcome_close_type(call_outcome), ("dq" in norm(call_outcome))
    is_closed = norm(closed) == "yes"
    return (norm(showed) == "yes"), (classify_plan(plan) if is_closed else None), False


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
    # 1. In-scope lead universe + identity. The tagger universe IS the unique
    # leads list (Drake 2026-06-05): a lead is tagged only if it ORIGINALLY opted
    # in on/after EFFECTIVE_DATE (date_first_opted_in, not just latest_opt_in_date
    # — returning leads who first opted in earlier are excluded), is non-revival,
    # and is not soft-hidden. The Typeform-match requirement is enforced in the
    # cycle-reconstruction step below (no Typeform = not a high-ticket opt-in =
    # no cycle). So lead_cycles == the unique leads list; everything reads from it.
    if scoped:
        cur.execute(
            "select close_id, display_name, contacts, latest_opt_in_date, ad_id, ad_name, campaign_id from close_leads "
            "where close_id = any(%s) and date_first_opted_in >= %s and excluded_at is null "
            "and coalesce(custom_fields_raw->>%s, '') = ''",
            (list(lead_ids), EFFECTIVE_DATE, REVIVAL_CF),
        )
    else:
        cur.execute(
            "select close_id, display_name, contacts, latest_opt_in_date, ad_id, ad_name, campaign_id from close_leads "
            "where date_first_opted_in >= %s and excluded_at is null "
            "and coalesce(custom_fields_raw->>%s, '') = ''",
            (EFFECTIVE_DATE, REVIVAL_CF),
        )
    lead_emails, lead_phones, lead_name, lead_latest, lead_ad = {}, {}, {}, {}, {}
    for cid, dname, contacts, latest, ad_id, ad_name, campaign_id in cur.fetchall():
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
        lead_ad[cid] = (ad_id, ad_name, campaign_id)
    ids = list(lead_emails.keys())
    if not ids:
        return [], []

    # 2. Cycle reconstruction — Typeform SFedWelr by email/phone (REQUIRED).
    cur.execute(
        """select submitted_at,
             lower(trim((select a->>'email' from jsonb_array_elements(answers) a where a->>'type'='email' limit 1))),
             (select a->>'phone_number' from jsonb_array_elements(answers) a where a->>'type'='phone_number' limit 1),
             (select a->'choice'->>'label' from jsonb_array_elements(answers) a where a->'field'->>'ref' = %s limit 1)
           from typeform_responses where form_id = %s and submitted_at >= %s""",
        (INVEST_FIELD_REF, OPT_IN_FORM, EFFECTIVE_DATE),
    )
    tf_by_email, tf_by_phone = defaultdict(list), defaultdict(list)
    for submitted_at, email, phone, investment in cur.fetchall():
        if email:
            tf_by_email[email].append((submitted_at, investment))
        d = digits10(phone)
        if d:
            tf_by_phone[d].append((submitted_at, investment))

    cycles_by_lead = {}
    cycle_qual = {}  # (cid, opt_in_at) -> qualified bool/None, from THAT cycle's submission
    for cid in ids:
        subs = []
        for e in lead_emails[cid]:
            subs += tf_by_email.get(e, [])
        for p in lead_phones[cid]:
            subs += tf_by_phone.get(p, [])
        by_min = {}  # minute -> (submitted_at, investment), earliest in the minute wins
        for ts, inv in subs:
            key = ts.replace(second=0, microsecond=0)
            if key not in by_min or ts < by_min[key][0]:
                by_min[key] = (ts, inv)
        pairs = sorted(by_min.values())  # by submitted_at
        times = [ts for ts, _ in pairs]
        for ts, inv in pairs:
            cycle_qual[(cid, ts)] = qual_from_investment(inv)
        # Unique leads only: a lead with NO Typeform SFedWelr match is not a
        # high-ticket opt-in, so it gets NO cycle (the old `close_fallback` path
        # is removed). Combined with the date_first_opted_in universe filter,
        # lead_cycles now IS exactly the unique leads list (Drake 2026-06-05).
        if times:
            cycles_by_lead[cid] = (sorted(times), "typeform")

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
           where (e.event_type_uri = any(%s) or e.name ilike 'Partnership Call w/%%'
                  or e.name ilike 'AI Partner Sync%%') and e.excluded_at is null""",
        ([DIRECT_URI, ROBBY_DC_URI],),
    )
    bookings = defaultdict(list)
    # "AI Partner Sync" follow-up calls, kept SEPARATE from `bookings` so the
    # existing direct/dc_robby/partnership logic (nearest_event_kind, direct-book)
    # is untouched — these only feed the follow-up disposition backup.
    sync_bookings = defaultdict(list)
    for etype, ename, start, status, created, iemail, iname, raw in cur.fetchall():
        utm = (raw or {}).get("tracking", {}).get("utm_term") if isinstance(raw, dict) else None
        phone = raw.get("text_reminder_number") if isinstance(raw, dict) else None
        cid = resolve(utm, iemail, phone, iname)
        if cid not in cycles_by_lead:
            continue
        if ename and "ai partner sync" in norm(ename):
            sync_bookings[cid].append((start, norm(status), created))
        else:
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
    # ALL closer forms (not just New) — legacy/old forms record the outcome in
    # Showed?/Closed?/Payment Plan Type instead of Call Outcome, and were being
    # dropped entirely (Mush Eli's HT close + show, May 29). closer_form_outcome
    # normalizes both shapes downstream.
    for lid, ft, co, sh, cl, pl, dcpl, ev, filed, cnames in fetch(
        "airtable_full_closer_report",
        "form_type, call_outcome, showed, closed, payment_plan_type, dc_plans, date_time_of_call, airtable_created_at, closer_names",
    ):
        closer[lid].append((ft, co, sh, cl, pl, dcpl, ev, filed, cnames))
    for lid, cl, fu, ev, filed in fetch("airtable_digital_college_sales", "closed, follow_up, date_time_of_call, airtable_created_at", "and excluded_at is null"):
        dc[lid].append((norm(cl), norm(fu), ev, filed))

    # Speed-to-lead + FMR raw signals (materialized per cycle below). ALL outbound
    # calls (not just >=90s) for first-call / intensity / connect facts, and inbound
    # SMS by activity_at for the FMR signal. Kept SEPARATE from calls90/sms_in (which
    # the stage logic uses) so existing tags are untouched.
    out_calls = defaultdict(list)
    for lid, at, dur, uid in fetch(
        "close_calls", "activity_at, duration, user_id",
        "and direction='outbound' and activity_at is not null",
    ):
        out_calls[lid].append((at, dur, uid))
    for lid in out_calls:
        out_calls[lid].sort(key=lambda x: x[0])
    sms_in_act = defaultdict(list)
    for lid, at in fetch("close_sms", "activity_at", "and direction='inbound' and activity_at is not null"):
        sms_in_act[lid].append(at)

    # 5. Compute tags + stages per cycle (the verified logic).
    now = _now()
    cycle_rows, stage_rows = [], []
    for cid in ids:
        if cid not in cycles_by_lead:
            continue  # no Typeform match → not a unique lead → no cycle/stages
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
            for ft, co, sh, cl, pl, dcpl, ev, filed, _cnames in closer.get(cid, []):
                t = ev or filed
                if not in_cycle(t):
                    continue
                _showed, ct, is_dq = closer_form_outcome(ft, co, sh, cl, pl)
                if is_dq:
                    setdq(t, "closer_eoc")
                if ct == "ht":
                    ht_close_at = t if ht_close_at is None or t < ht_close_at else ht_close_at
            for cl, fu, ev, filed in dc.get(cid, []):
                # DC sale form (airtable_digital_college_sales): keep its DQ
                # contribution only. The DC funnel itself is sourced from the
                # main closer EOC form (per Drake), computed in the DC block below.
                t = ev or filed
                if not in_cycle(t):
                    continue
                if fu == "no":
                    setdq(t, "dc_followup_no")

            # --- Digital College funnel (closer-identity routed; Drake 2026-06-05).
            # Sourced from the main closer EOC form (airtable_full_closer_report),
            # NOT the DC-sale form. DC closer (Robby) = the main DC funnel; an HT
            # closer (Aman) with a DC plan, or a confirmation "Downsold", = a
            # downsell. SHOWED = a DC-closer form is present; CLOSED = a real PLAN
            # is selected (not the unreliable "Digital College Closed" output).
            dc_book_at = dc_show_at = dc_closer_close_at = None
            downsell_meeting_at = downsell_confirm_at = None
            for ft, cs, filed in triage.get(cid, []):
                if not in_cycle(filed):
                    continue
                if ft != "Closer Triage Form" and "digital college booking" in cs:
                    dc_book_at = _earliest(dc_book_at, filed)        # setter booked a DC call
                if ft == "Closer Triage Form" and "downsold" in cs:
                    downsell_confirm_at = _earliest(downsell_confirm_at, filed)  # Aman downsell at confirmation
            for ft, co, sh, cl, pl, dcpl, ev, filed, cnames in closer.get(cid, []):
                t = ev or filed
                if not in_cycle(t):
                    continue
                if is_dc_closer(cnames):
                    dc_show_at = _earliest(dc_show_at, t)            # DC-closer form present = showed
                    dc_book_at = _earliest(dc_book_at, t)
                    if has_dc_plan(dcpl):
                        dc_closer_close_at = _earliest(dc_closer_close_at, t)
                elif has_dc_plan(dcpl):
                    downsell_meeting_at = _earliest(downsell_meeting_at, t)  # HT closer downsold on the meeting
            # DC close + origin. A downsell (HT closer) wins over dc_closer — the
            # sale ORIGINATED from the downsell even if Robby later processed it.
            dc_close_origin = None
            if downsell_meeting_at is not None:
                dc_close_at, dc_close_origin = downsell_meeting_at, "downsell_ht_meeting"
            elif downsell_confirm_at is not None:
                dc_close_at, dc_close_origin = downsell_confirm_at, "downsell_confirmation"
            elif dc_closer_close_at is not None:
                dc_close_at, dc_close_origin = dc_closer_close_at, "dc_closer"
            # Monotonic back-fill on the dc_closer (main-funnel) path only.
            if dc_close_origin == "dc_closer":
                dc_show_at = dc_show_at or dc_close_at
                dc_book_at = dc_book_at or dc_show_at
            digital_college_at = _earliest(dc_book_at, dc_show_at, dc_closer_close_at,
                                           downsell_meeting_at, downsell_confirm_at, dc_close_at)

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

            ph = {"primary": dict(conn=[], book=[], confirm=[], show=[], close=[], no_show=[], follow_up=[]),
                  "reactive": dict(conn=[], book=[], confirm=[], show=[], close=[], no_show=[], follow_up=[])}
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
                # Connected = a >=90s CALL only (Drake 2026-06-24). A triage form
                # "reaching" a lead no longer lights connected — a text-DQ or a
                # sub-90s touch is not a conversation. The >=90s-call path (calls90,
                # above) is the sole DIRECT connect signal; connected still
                # back-fills from confirmed/showed/closed in the phase rollup below.
                if ft == "Closer Triage Form":
                    # A confirmation form is a CONFIRM when it records the HT
                    # booking itself ("High Ticket booking") OR an explicit
                    # "Confirmed Booking" — both mean the HT booking is locked in
                    # (Drake 2026-06-05). Previously only "Confirmed*" counted, so
                    # an HT-booking marked on a confirmation form (Jason Bright)
                    # was dropped.
                    if cs.startswith("confirmed") or "high ticket booking" in cs:
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

            had_ht_closer_form = False
            for ft, co, sh, cl, pl, dcpl, ev, filed, cnames in closer.get(cid, []):
                t = ev or filed
                if not in_cycle(t):
                    continue
                # A DC (low-ticket) closer is NOT an HT closer. Any form a DC
                # closer submitted means the lead went to the DC track — they
                # didn't show for / were handed off from the HT call — so NONE of
                # their forms count toward HT show/close (Drake 2026-06-05).
                # Previously only DC-CLOSE forms were excluded, so a DC closer's
                # "Short-Term Follow Up" leaked in as an HT show (Tyler King,
                # Hovannes Jarkezian). Generalized from the literal "robby" to the
                # full DC_CLOSER_NAMES list 2026-06-15 (Bradley/Josh). DQ + the DC
                # close tally are computed in the earlier loop and are unaffected.
                if is_dc_closer(cnames):
                    continue
                p = phase_of(ev, filed)
                had_ht_closer_form = True
                showed_b, ct, _is_dq = closer_form_outcome(ft, co, sh, cl, pl)
                # Disposition overlays (no-show / follow-up) off the SAME closer
                # form — independent of the stage flags below; the disposition
                # column reads the latest-timestamp event, these don't back-fill
                # and don't touch the funnel. Form-primary (Calendly is a backup
                # added after this loop). New → Call Outcome; Old → Showed?=No.
                co_n = norm(co)
                if (ft == "New" and ("ghost" in co_n or "no show" in co_n)) or (ft != "New" and norm(sh) == "no"):
                    ph[p]["no_show"].append(t)
                if ft == "New" and "follow" in co_n:
                    ph[p]["follow_up"].append(t)
                # A "Digital College Closed" EOC by a NON-Robby closer = Aman's
                # downsell on an HT strat/partnership call → an HT SHOW. Still drop
                # it if it sat on a "Call with Robby" Calendly event.
                if ct == "dc":
                    if nearest_event_kind(ev or filed) != "dc_robby":
                        ph[p]["show"].append(t)
                    continue
                if showed_b:
                    ph[p]["show"].append(t)
                if ct == "ht":
                    ph[p]["close"].append(t)

            # No-show backup (Calendly): the call was booked but NO closer form was
            # filed — a direct/partnership booking whose start passed >4h with no
            # EOC form and no show. Form-primary, so this only fills that gap.
            if not had_ht_closer_form:
                for bkind, bstart, bstatus, bcreated in cyc_bk:
                    if bkind in ("direct", "partnership") and bstart is not None \
                       and bstatus != "canceled" and bstart < now - timedelta(hours=4):
                        bp = phase_of(bstart, bcreated)
                        if not ph[bp]["show"] and not ph[bp]["close"]:
                            ph[bp]["no_show"].append(bstart)
            # Follow-up backup (Calendly): an "AI Partner Sync" booking with no
            # follow-up FORM. Form-primary, so only when no form follow-up exists.
            if not (ph["primary"]["follow_up"] or ph["reactive"]["follow_up"]):
                for sstart, sstatus, screated in sync_bookings.get(cid, []):
                    anchor = screated or sstart
                    if anchor is not None and sstatus != "canceled" and in_cycle(anchor):
                        ph[phase_of(sstart, screated)]["follow_up"].append(sstart or anchor)

            row_ad_id, row_ad_name, row_campaign_id = lead_ad.get(cid, (None, None, None))
            # Speed-to-lead + FMR facts for this cycle, anchored at opt_in_at (counted
            # to now — matches the page's per-person computation; intensity being
            # cumulative-forward, not per-cycle-bounded, is preserved here and a later
            # change). Verified per-lead in Phase 1.
            cyc_calls = [c for c in out_calls.get(cid, []) if c[0] >= opt_in_at]
            conn_calls = [c for c in cyc_calls if (c[1] or 0) >= CONNECTED_SEC]
            fcall = cyc_calls[0] if cyc_calls else None
            scall = cyc_calls[1] if len(cyc_calls) > 1 else None
            first_call_at = fcall[0] if fcall else None
            intensity = len(cyc_calls)
            any_conn = len(conn_calls) > 0
            first_two = bool((fcall and (fcall[1] or 0) >= CONNECTED_SEC)
                             or (scall and (scall[1] or 0) >= CONNECTED_SEC))
            caller_uid = fcall[2] if fcall else None
            tot_conn_dur = sum((c[1] or 0) for c in conn_calls)
            conn_cnt = len(conn_calls)
            earliest_connect = conn_calls[0][0] if conn_calls else None
            cyc_inbound = [a for a in sms_in_act.get(cid, []) if a >= opt_in_at]
            earliest_inbound = min(cyc_inbound) if cyc_inbound else None

            qualified = cycle_qual.get((cid, opt_in_at))
            cycle_rows.append((cid, opt_in_at, idx + 1, source, became_direct, reactive_at, reactive_source, dq_at, dq_source, dc_close_at, digital_college_at, dc_book_at, dc_show_at, dc_close_origin, row_ad_id, row_ad_name, row_campaign_id, first_call_at, intensity, any_conn, first_two, caller_uid, tot_conn_dur, conn_cnt, earliest_inbound, earliest_connect, qualified))

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
                # Disposition events — the LATEST occurrence. Read only by the
                # disposition column (not the monotonic ladder), so they don't
                # back-fill and don't feed the funnel.
                no_show_at = max(e["no_show"]) if e["no_show"] else None
                follow_up_at = max(e["follow_up"]) if e["follow_up"] else None
                if any([connected_at, booked_at, confirmed_at, showed_at, closed_at, no_show_at, follow_up_at]):
                    stage_rows.append((cid, opt_in_at, p, connected_at, booked_at, confirmed_at, showed_at, closed_at, close_type, no_show_at, follow_up_at))

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

        # Delete-then-insert. On a FULL retag (lead_ids is None) wipe the whole
        # table so leads that fell OUT of the universe (e.g. no longer a unique
        # lead) don't keep stale cycles. On a scoped retag, delete exactly the
        # passed leads (whether or not they re-tagged), same reason.
        if lead_ids is None:
            cur.execute("delete from lead_cycles")  # cascades stages
        else:
            cur.execute("delete from lead_cycles where close_id = any(%s)", (list(lead_ids),))  # cascades stages
        if cycle_rows:
            execute_values(cur,
                "insert into lead_cycles (close_id, opt_in_at, opt_in_seq, source, became_direct_at, reactive_at, reactive_source, dq_at, dq_source, dc_closed_at, digital_college_at, dc_booked_at, dc_showed_at, dc_close_origin, ad_id, ad_name, campaign_id, first_call_at, intensity, any_call_connected, first_two_dials_connected, caller_user_id, total_connected_duration_sec, connected_call_count, earliest_inbound_at, earliest_connect_at, qualified) values %s",
                cycle_rows,
                template="(%s,%s::timestamptz,%s,%s,%s::timestamptz,%s::timestamptz,%s,%s::timestamptz,%s,%s::timestamptz,%s::timestamptz,%s::timestamptz,%s::timestamptz,%s,%s,%s,%s,%s::timestamptz,%s,%s,%s,%s,%s,%s,%s::timestamptz,%s::timestamptz,%s)")
        if stage_rows:
            execute_values(cur,
                "insert into lead_cycle_stages (close_id, opt_in_at, phase, connected_at, booked_at, confirmed_at, showed_at, closed_at, close_type, no_show_at, follow_up_at) values %s",
                stage_rows,
                template="(%s,%s::timestamptz,%s,%s::timestamptz,%s::timestamptz,%s::timestamptz,%s::timestamptz,%s::timestamptz,%s,%s::timestamptz,%s::timestamptz)")
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
