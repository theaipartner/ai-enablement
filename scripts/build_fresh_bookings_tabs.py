"""Build the 'Fresh Bookings' deliverable (4 tabs) + the pre-submission check.

Tabs:
  1. Summary            — headline counts
  2. Direct (qualified) — qualified closer-funnel leads who booked the direct
                          AI Partner Strategy Call link
  3. Setter-led         — closer-funnel leads with NO direct booking who have a
                          confirmed Slack booking (net-new setter; the 16)
  4. Anomalies          — UNqualified closer-funnel leads who booked a strategy
                          call (to review)

Window: Apr 28 onward. Bookings include canceled/rescheduled. Setter-led is
sourced from the #confirmed-booked-calls Slack log (authoritative, since some
setter links — e.g. Connor's — aren't in our Calendly mirror).

Also prints: qualified leads whose booking was created BEFORE their typeform
submission (same anomaly class as tab 4, but on the qualified side).
"""

from __future__ import annotations

import csv
import datetime as dt
import re
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(_REPO / ".env.local")

from shared.db import get_client  # noqa: E402
from ingestion.slack.client import SlackClient  # noqa: E402
from scripts.match_closer_funnel_bookings import norm_email, norm_event_name  # noqa: E402
from scripts.match_setter_bookings_may import load_leads  # noqa: E402
from scripts.slack_confirmed_bookings_xref import parse_bookings  # noqa: E402

WIN = dt.datetime(2026, 4, 28, tzinfo=dt.timezone.utc)
SETTER_URIS = ("95d96439e072", "656dbd6b6c1f", "488e20717063")
OUT = _REPO / "scripts" / "out"


def digits(s):
    d = re.sub(r"\D", "", s or "")
    return d[-10:] if len(d) >= 10 else ""


def kind(nm, uri):
    if (uri or "").endswith(SETTER_URIS):
        return "setter"
    if norm_event_name(nm) == "ai partner strategy call":
        return "direct"
    return "other"


def parse_submitted(s):
    try:
        return dt.datetime.strptime(s.strip(), "%Y-%m-%d %H:%M:%S").replace(tzinfo=dt.timezone.utc)
    except Exception:
        return None


def main() -> int:
    db = get_client()
    ev = {}
    pg = 0
    while True:
        c = db.table("calendly_scheduled_events").select(
            "uri,name,event_type_uri,event_created_at,start_time,status"
        ).range(pg * 1000, pg * 1000 + 999).execute().data
        for e in c:
            ev[e["uri"]] = e
        if len(c) < 1000:
            break
        pg += 1
    invs = []
    pg = 0
    while True:
        c = db.table("calendly_invitees").select(
            "event_uri,email,first_name,last_name,name,status,rescheduled,old_invitee,raw_payload"
        ).range(pg * 1000, pg * 1000 + 999).execute().data
        invs.extend(c)
        if len(c) < 1000:
            break
        pg += 1
    bookings = []
    for v in invs:
        rp = v.get("raw_payload") or {}
        e = ev.get(v["event_uri"])
        if not e or not e.get("event_created_at"):
            continue
        created = dt.datetime.fromisoformat(e["event_created_at"])
        if created < WIN:
            continue
        ph = digits(rp.get("text_reminder_number") or "") or next(
            (digits(qa.get("answer")) for qa in (rp.get("questions_and_answers") or []) if digits(qa.get("answer"))), "")
        bookings.append({
            "kind": kind(e["name"], e["event_type_uri"]), "link": e["name"],
            "created": created, "meeting": (e.get("start_time") or "")[:16],
            "status": e.get("status"),
            "_email": norm_email(v.get("email")), "_phone": ph,
        })

    slack = [b for b in parse_bookings(SlackClient())
             if dt.datetime.fromtimestamp(float(b["ts"]), dt.timezone.utc) >= WIN]
    slack_by = {}
    for b in slack:
        if b["_email"]:
            slack_by.setdefault(b["_email"], []).append(b)

    leads = load_leads()

    def mine(l):
        return [x for x in bookings
                if (l["_email"] and x["_email"] == l["_email"]) or (l["_phone"] and x["_phone"] == l["_phone"])]

    OUT.mkdir(parents=True, exist_ok=True)

    # ---- Tab 2: Direct (qualified) ----
    direct_q = []
    for l in leads:
        if not l["qualified"]:
            continue
        d = sorted([x for x in mine(l) if x["kind"] == "direct"], key=lambda x: x["created"])
        if d:
            direct_q.append((l, d))
    with open(OUT / "fb_direct_qualified.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["First", "Last", "Email", "Phone", "Investment", "Lead submitted (UTC)",
                    "Booking link", "Booking created (UTC)", "Meeting (UTC)", "Status", "# bookings",
                    "Booked before submitting?"])
        for l, d in sorted(direct_q, key=lambda x: x[1][0]["created"]):
            b = d[0]
            sub = parse_submitted(l["submitted"])
            before = "YES" if (sub and b["created"] < sub) else "no"
            w.writerow([l["first"], l["last"], l["email"], l["phone"], l["invest"], l["submitted"],
                        b["link"], str(b["created"])[:19], b["meeting"], b["status"], len(d), before])

    # ---- Tab 3: Setter-led (no direct link) ----
    setter_led = []
    for l in leads:
        if any(x["kind"] == "direct" for x in mine(l)):
            continue
        if l["_email"] in slack_by:
            entry = sorted(slack_by[l["_email"]], key=lambda b: float(b["ts"]))[0]
            setter_led.append((l, entry))
    with open(OUT / "fb_setter_led.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["First", "Last", "Email", "Phone", "Investment", "Qualified?",
                    "Lead submitted (UTC)", "Setter", "Closer", "Funnel (Slack)", "Booking logged (UTC)"])
        for l, e in sorted(setter_led, key=lambda x: float(x[1]["ts"])):
            ts = dt.datetime.fromtimestamp(float(e["ts"]), dt.timezone.utc).isoformat()
            w.writerow([l["first"], l["last"], l["email"], l["phone"], l["invest"],
                        "Yes" if l["qualified"] else "No", l["submitted"],
                        e["setter"], e["closer"], e["funnel"].split("\n")[0], ts])

    # ---- Tab 4: Anomalies (unqualified who booked a strategy call) ----
    anomalies = []
    for l in leads:
        if l["qualified"]:
            continue
        d = sorted([x for x in mine(l) if x["kind"] == "direct"], key=lambda x: x["created"])
        if d:
            anomalies.append((l, d))
    with open(OUT / "fb_anomalies.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["First", "Last", "Email", "Phone", "Investment", "Lead submitted (UTC)",
                    "Booked before submitting?", "Strategy-call bookings (created | meeting | status)"])
        for l, d in sorted(anomalies, key=lambda x: x[0]["submitted"]):
            sub = parse_submitted(l["submitted"])
            before = any(sub and x["created"] < sub for x in d)
            detail = "; ".join(f"{str(x['created'])[:19]} | {x['meeting']} | {x['status']}" for x in d)
            w.writerow([l["first"], l["last"], l["email"], l["phone"], l["invest"], l["submitted"],
                        "YES" if before else "no", detail])

    # ---- pre-submission check on QUALIFIED leads ----
    q_before = []
    for l, d in direct_q:
        sub = parse_submitted(l["submitted"])
        earlier = [x for x in d if sub and x["created"] < sub]
        if earlier:
            q_before.append((l, sub, sorted(d, key=lambda x: x["created"])[0]))

    # ---- Tab 1: Summary ----
    n_direct_people = len(direct_q)
    n_direct_rows = sum(1 for l in leads if l["qualified"] and any(x["kind"] == "direct" for x in mine(l)))
    summary = [
        ("Window", "Apr 28, 2026 onward"),
        ("Closer-funnel leads (distinct people)", len({l["_email"] for l in leads})),
        ("FRESH BOOKINGS — total (direct-qualified + setter-led)", n_direct_people + len(setter_led)),
        ("  Direct bookings — qualified leads (distinct people)", n_direct_people),
        ("  Setter-led bookings — no direct link (net-new)", len(setter_led)),
        ("Anomalies — UNqualified leads who booked a strategy call (review, held separate)", len(anomalies)),
        ("Qualified leads who booked BEFORE their typeform submission (review)", len(q_before)),
        ("Note", "Setter-led sourced from #confirmed-booked-calls Slack log; Connor's Calendly link is not in our mirror, so a Calendly-only count undercounts setter bookings."),
    ]
    with open(OUT / "fb_summary.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Metric", "Value"])
        for k, v in summary:
            w.writerow([k, v])

    print("=== Fresh Bookings ===")
    for k, v in summary:
        print(f"  {v!s:>4}  {k}" if not isinstance(v, str) or v.isdigit() else f"  {k}: {v}")
    print(f"\n  (direct qualified: {n_direct_people} distinct / {n_direct_rows} submission-rows)")
    print(f"\n=== QUALIFIED leads with a booking created BEFORE typeform submission: {len(q_before)} ===")
    for l, sub, first in sorted(q_before, key=lambda x: x[0]["submitted"]):
        print(f"  {l['first']} {l['last']:16} submitted={l['submitted']:20} earliest_booking={str(first['created'])[:19]}  ({first['link']}, {first['status']})  {l['email']}")
    print(f"\n  wrote 4 CSVs to {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
