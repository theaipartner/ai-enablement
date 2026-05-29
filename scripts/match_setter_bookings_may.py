"""One-shot: fresh setter bookings among the May Closer-funnel leads.

Question (Drake, May 28): of the May Closer-funnel leads, how many booked
via the SETTER (the "Partnership" link) as a FRESH booking — i.e. they
booked the partnership call and did NOT also book direct via the ad-funnel
"AI Partner Strategy Call". Booking direct disqualifies a lead from being a
fresh setter booking.

Link definitions (verified 2026-05-28 against calendly_scheduled_events):
- SETTER / partnership link = event_type_uri ending '95d96439e072'. This
  one Calendly link was recorded as 'Strategy Call with Aman' early and
  renamed to 'Partnership Call w/ Aman' — same URI. Matching on the URI
  catches both recorded names.
- DIRECT / ad-funnel link = any event whose name normalizes to
  'ai partner strategy call' (the 3 closer-strategy-call variants).

Population = the May Closer-funnel CSV (form SFedWelr), deduped to distinct
people by email. Match leads -> bookings by email / phone / name.

Output: scripts/out/may_fresh_setter_bookings.csv (the fresh setter list)
plus a printed summary. New, non-rescheduled invitees only.
"""

from __future__ import annotations

import csv
import sys
from collections import Counter
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(_REPO / ".env.local")

from shared.db import get_client  # noqa: E402
from scripts.match_closer_funnel_bookings import (  # noqa: E402
    norm_email, norm_phone, norm_name_key, norm_event_name, _invitee_phone,
)

CSV_PATH = _REPO / "lead data" / (
    "Closer Funnel Leads - responses-SFedWelr-"
    "01KSRAVZ62MZ3DH1GN4YJMK0K4-881NOMZ6YVCQEIRO8EG1OU17.csv"
)
OUT_DIR = _REPO / "scripts" / "out"
# Setter/partnership links (event_type_uri suffixes). "Success AP"
# (success-theaipartner, ...488e20717063) has 0 bookings in our data —
# kept here for completeness; that path shows up only in the setters'
# Slack log, not Calendly.
SETTER_URI_SUFFIXES = (
    "95d96439e072",   # Partnership Call w/ Aman (renamed from "Strategy Call with Aman")
    "656dbd6b6c1f",   # Partnership Call w/ Adam
    "488e20717063",   # Success AP (success-theaipartner/30min) — 0 bookings so far
)
STRATEGY_CALL = "ai partner strategy call"


def load_leads() -> list[dict]:
    """All May Closer-funnel leads, deduped to distinct people by email."""
    rows = list(csv.reader(open(CSV_PATH, newline="", encoding="utf-8")))
    hdr, data = rows[0], rows[1:]
    ci = {h: i for i, h in enumerate(hdr)}
    iE, iF, iL, iP, iEnd, iSub, iInv = (
        ci["Email"], ci["First name"], ci["Last name"], ci["Phone number"],
        ci["Ending"], ci["Submit Date (UTC)"], ci[hdr[1]],
    )
    leads, seen = [], set()
    for r in data:
        if len(r) <= iEnd:
            continue
        key = norm_email(r[iE])
        if key and key in seen:
            continue
        if key:
            seen.add(key)
        leads.append({
            "first": r[iF].strip(), "last": r[iL].strip(),
            "email": r[iE].strip(), "phone": r[iP].strip(),
            "invest": r[iInv].strip(), "submitted": r[iSub].strip(),
            "qualified": r[iEnd].strip() == "Qualified",
            "_email": key, "_phone": norm_phone(r[iP]),
            "_name": norm_name_key(f"{r[iF]} {r[iL]}"),
        })
    return leads


def load_bookings(db) -> list[dict]:
    """All new (non-rescheduled) invitees joined to their event, tagged
    setter / direct / other."""
    events, p = {}, 0
    while True:
        c = db.table("calendly_scheduled_events").select(
            "uri,name,event_type_uri,status,start_time,event_created_at"
        ).range(p * 1000, p * 1000 + 999).execute().data
        for e in c:
            events[e["uri"]] = e
        if len(c) < 1000:
            break
        p += 1
    bookings, p = [], 0
    while True:
        c = db.table("calendly_invitees").select(
            "event_uri,email,name,first_name,last_name,status,no_show,"
            "rescheduled,raw_payload"
        ).range(p * 1000, p * 1000 + 999).execute().data
        for v in c:
            if v.get("rescheduled"):
                continue
            ev = events.get(v["event_uri"])
            if not ev:
                continue
            uri = ev.get("event_type_uri") or ""
            nm = norm_event_name(ev["name"])
            if uri.endswith(SETTER_URI_SUFFIXES):
                kind = "setter"
            elif nm == STRATEGY_CALL:
                kind = "direct"
            else:
                kind = "other"
            rp = v.get("raw_payload") or {}
            fn = v.get("first_name") or rp.get("first_name") or ""
            ln = v.get("last_name") or rp.get("last_name") or ""
            full = (f"{fn} {ln}".strip() or v.get("name") or rp.get("name") or "")
            bookings.append({
                "kind": kind, "link": ev["name"],
                "booking_created": ev.get("event_created_at"),
                "meeting_time": ev.get("start_time"),
                "event_status": ev.get("status"), "no_show": v.get("no_show"),
                "invitee_email": v.get("email") or "", "invitee_name": full,
                "invitee_phone": _invitee_phone(rp),
                "_email": norm_email(v.get("email")),
                "_phone": norm_phone(_invitee_phone(rp)),
                "_name": norm_name_key(full),
            })
        if len(c) < 1000:
            break
        p += 1
    return bookings


def matches(lead, b) -> bool:
    return bool(
        (lead["_email"] and lead["_email"] == b["_email"])
        or (lead["_phone"] and lead["_phone"] == b["_phone"])
        or (lead["_name"] and lead["_name"] == b["_name"])
    )


def main() -> int:
    db = get_client()
    leads = load_leads()
    bookings = load_bookings(db)

    for lead in leads:
        lead["_setter"] = [b for b in bookings if b["kind"] == "setter" and matches(lead, b)]
        lead["_direct"] = [b for b in bookings if b["kind"] == "direct" and matches(lead, b)]

    booked_setter = [l for l in leads if l["_setter"]]
    fresh = [l for l in booked_setter if not l["_direct"]]
    excluded = [l for l in booked_setter if l["_direct"]]

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUT_DIR / "may_fresh_setter_bookings.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow([
            "First name", "Last name", "Email", "Phone", "Willing to invest",
            "Closer-funnel qualified?", "Lead submitted (UTC)",
            "Setter booking link", "Setter booking created (UTC)",
            "Meeting time (UTC)", "Booking status", "No-show",
        ])
        for l in sorted(fresh, key=lambda x: x["_setter"][0]["booking_created"] or ""):
            b = l["_setter"][0]
            w.writerow([
                l["first"], l["last"], l["email"], l["phone"], l["invest"],
                "Yes" if l["qualified"] else "No", l["submitted"],
                b["link"], b["booking_created"], b["meeting_time"],
                b["event_status"], b["no_show"],
            ])

    print("=== MAY FRESH SETTER BOOKINGS ===")
    print(f"  May Closer-funnel leads (distinct people): {len(leads)}")
    print(f"  Booked the setter/partnership link:        {len(booked_setter)}")
    print(f"  ...of those, ALSO booked direct (excluded): {len(excluded)}")
    print(f"  FRESH setter bookings (setter, no direct):  {len(fresh)}")
    qy = sum(1 for l in fresh if l["qualified"])
    print(f"     - of fresh: closer-funnel qualified={qy}, unqualified={len(fresh)-qy}")
    print(f"\n  (setter links = Aman/Adam/Success-AP, uris ...{SETTER_URI_SUFFIXES})")
    setter_links = Counter(l["_setter"][0]["link"] for l in fresh)
    print("  fresh by link:", dict(setter_links))
    print(f"  Wrote {OUT_DIR/'may_fresh_setter_bookings.csv'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
