"""One-shot: match qualified Closer-funnel leads to AI Partner Strategy Call bookings.

Answers: of the qualified Closer-funnel typeform leads since Apr 27, how many
booked an "AI Partner Strategy Call" on Calendly?

- Lead source: the Typeform CSV export (Ending == "Qualified" → the 178).
  Used instead of typeform_responses because the DB mirror only covers the
  last few days; the CSV is the complete Apr-27-onward lead list.
- Booking source: calendly_invitees joined to calendly_scheduled_events,
  filtered to the three "AI Partner Strategy Call" name variants
  (case-insensitive, trailing-period stripped), rescheduled = false,
  event_created_at (booking-created) in the window.
- Match keys: email (primary), phone, name. A lead that matches a booking
  only via phone/name (email differs) is flagged "review" — booked under a
  different identity.

Outputs three CSVs under scripts/out/:
  closer_funnel_qualified_leads.csv     — 178 leads + booking status
  closer_funnel_unmatched_bookings.csv  — strategy-call bookings not tied to a qualified lead
  closer_funnel_summary.csv             — headline counts
"""

from __future__ import annotations

import csv
import re
import sys
from collections import Counter
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(_REPO / ".env.local")

from shared.db import get_client  # noqa: E402

CSV_PATH = _REPO / (
    "Closer Funnel Leads - responses-SFedWelr-"
    "01KSRAVZ62MZ3DH1GN4YJMK0K4-881NOMZ6YVCQEIRO8EG1OU17.csv"
)
WINDOW_START = "2026-04-27T00:00:00+00:00"  # booking-created floor (UTC)
OUT_DIR = _REPO / "scripts" / "out"

# The three casing/punctuation variants all normalize to this.
STRATEGY_CALL = "ai partner strategy call"


def norm_name_key(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def norm_email(s: str) -> str:
    return (s or "").strip().lower()


def norm_phone(s: str) -> str:
    """Digits only, last 10 (US matching). Empty if no usable phone."""
    digits = re.sub(r"\D", "", s or "")
    return digits[-10:] if len(digits) >= 10 else ""


def norm_event_name(s: str) -> str:
    return (s or "").strip().lower().rstrip(".").strip()


def load_qualified_leads() -> list[dict]:
    rows = list(csv.reader(open(CSV_PATH, newline="", encoding="utf-8")))
    hdr, data = rows[0], rows[1:]
    ci = {h: i for i, h in enumerate(hdr)}
    iE, iF, iL, iP, iEnd, iSub, iInv = (
        ci["Email"], ci["First name"], ci["Last name"], ci["Phone number"],
        ci["Ending"], ci["Submit Date (UTC)"], ci[hdr[1]],
    )
    leads = []
    for r in data:
        if len(r) <= iEnd or r[iEnd] != "Qualified":
            continue
        leads.append({
            "first": r[iF].strip(), "last": r[iL].strip(),
            "email": r[iE].strip(), "phone": r[iP].strip(),
            "invest": r[iInv].strip(), "submitted": r[iSub].strip(),
            "_email": norm_email(r[iE]), "_phone": norm_phone(r[iP]),
            "_name": norm_name_key(f"{r[iF]} {r[iL]}"),
        })
    return leads


def _invitee_phone(rp: dict) -> str:
    cand = rp.get("text_reminder_number") or ""
    if not norm_phone(cand):
        for qa in rp.get("questions_and_answers") or []:
            ans = qa.get("answer") or ""
            if norm_phone(ans):
                cand = ans
                break
    return cand


def load_strategy_bookings(db) -> list[dict]:
    # Events: strategy-call variants, created in window.
    events = db.table("calendly_scheduled_events").select(
        "uri,name,status,start_time,event_created_at,host_user_name"
    ).gte("event_created_at", WINDOW_START).execute().data
    events = {e["uri"]: e for e in events
             if norm_event_name(e["name"]) == STRATEGY_CALL}
    if not events:
        return []
    # Invitees on those events, new bookings only. The invitee table is
    # small, so fetch all (paginated) and filter locally — an .in_() over
    # ~400 event URIs overruns PostgREST's URL length limit (HTTP 414).
    bookings = []
    invs, page, size = [], 0, 1000
    while True:
        chunk = db.table("calendly_invitees").select(
            "uri,event_uri,email,name,first_name,last_name,status,no_show,"
            "rescheduled,raw_payload,invitee_created_at"
        ).range(page * size, page * size + size - 1).execute().data
        invs.extend(chunk)
        if len(chunk) < size:
            break
        page += 1
    for v in invs:
        if v.get("rescheduled"):
            continue
        ev = events.get(v["event_uri"])
        if not ev:
            continue
        rp = v.get("raw_payload") or {}
        fn = v.get("first_name") or rp.get("first_name") or ""
        ln = v.get("last_name") or rp.get("last_name") or ""
        full = (f"{fn} {ln}".strip() or v.get("name") or rp.get("name") or "")
        phone = _invitee_phone(rp)
        bookings.append({
            "invitee_email": v.get("email") or "",
            "invitee_name": full,
            "invitee_phone": phone,
            "link": ev["name"],
            "booking_created": ev.get("event_created_at"),
            "meeting_time": ev.get("start_time"),
            "event_status": ev.get("status"),
            "no_show": v.get("no_show"),
            "_email": norm_email(v.get("email")),
            "_phone": norm_phone(phone),
            "_name": norm_name_key(full),
        })
    return bookings


def match(leads, bookings):
    matched_booking_ids = set()
    for lead in leads:
        hit = None
        basis = ""
        # 1. email (clean)
        for i, b in enumerate(bookings):
            if lead["_email"] and lead["_email"] == b["_email"]:
                hit, basis = b, "email"
                matched_booking_ids.add(i)
                break
        # 2. phone or name (review — possibly different email)
        if hit is None:
            for i, b in enumerate(bookings):
                if lead["_phone"] and lead["_phone"] == b["_phone"]:
                    hit, basis = b, "phone"
                    matched_booking_ids.add(i)
                    break
                if lead["_name"] and lead["_name"] == b["_name"]:
                    hit, basis = b, "name"
                    matched_booking_ids.add(i)
                    break
        lead["_match"] = hit
        lead["_basis"] = basis
    unmatched = [b for i, b in enumerate(bookings) if i not in matched_booking_ids]
    return leads, unmatched


def main() -> int:
    db = get_client()
    leads = load_qualified_leads()
    bookings = load_strategy_bookings(db)
    leads, unmatched = match(leads, bookings)

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    booked_email = [l for l in leads if l["_basis"] == "email"]
    booked_review = [l for l in leads if l["_basis"] in ("phone", "name")]
    not_booked = [l for l in leads if not l["_basis"]]

    # 1. Qualified leads sheet
    with open(OUT_DIR / "closer_funnel_qualified_leads.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow([
            "First name", "Last name", "Email", "Phone", "Willing to invest",
            "Lead submitted (UTC)", "Booked?", "Match basis",
            "Booking link", "Booking created (UTC)", "Meeting time (UTC)",
            "Booking status", "No-show", "Booked email", "Booked name",
            "Booked phone", "Review flag",
        ])
        for l in leads:
            m = l["_match"] or {}
            if l["_basis"] == "email":
                booked = "Yes"
            elif l["_basis"]:
                booked = "Yes (review)"
            else:
                booked = "No"
            flag = ""
            if l["_basis"] in ("phone", "name"):
                flag = f"booked under different email (matched on {l['_basis']})"
            w.writerow([
                l["first"], l["last"], l["email"], l["phone"], l["invest"],
                l["submitted"], booked, l["_basis"],
                m.get("link", ""), m.get("booking_created", ""),
                m.get("meeting_time", ""), m.get("event_status", ""),
                m.get("no_show", ""), m.get("invitee_email", ""),
                m.get("invitee_name", ""), m.get("invitee_phone", ""), flag,
            ])

    # 2. Unmatched bookings sheet
    with open(OUT_DIR / "closer_funnel_unmatched_bookings.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow([
            "Invitee name", "Invitee email", "Invitee phone", "Booking link",
            "Booking created (UTC)", "Meeting time (UTC)", "Booking status", "No-show",
        ])
        for b in unmatched:
            w.writerow([
                b["invitee_name"], b["invitee_email"], b["invitee_phone"], b["link"],
                b["booking_created"], b["meeting_time"], b["event_status"], b["no_show"],
            ])

    # 3. Summary
    distinct_lead_emails = {l["_email"] for l in leads if l["_email"]}
    distinct_booked = {l["_email"] for l in leads if l["_basis"] and l["_email"]}
    n_dist = len(distinct_lead_emails)
    rate_rows = (len(booked_email) + len(booked_review)) / len(leads) * 100 if leads else 0
    rate_people = len(distinct_booked) / n_dist * 100 if n_dist else 0
    link_counts = Counter(l["_match"]["link"] for l in leads if l["_match"])
    summary = [
        ("Qualified opt-in submissions (Ending = Qualified)", len(leads)),
        ("Distinct qualified people (dedup by email)", n_dist),
        ("Distinct qualified people who BOOKED a strategy call", len(distinct_booked)),
        ("Booking rate — distinct people (%)", round(rate_people, 1)),
        ("Qualified leads who booked — by submission row", len(booked_email) + len(booked_review)),
        ("  ...email match (clean)", len(booked_email)),
        ("  ...phone/name only (booked under different identity — review)", len(booked_review)),
        ("Booking rate — by submission row (%)", round(rate_rows, 1)),
        ("Qualified leads with NO booking found", len(not_booked)),
        ("Total strategy-call bookings in window (new, non-rescheduled)", len(bookings)),
        ("Strategy-call bookings NOT matched to any qualified lead", len(unmatched)),
    ]
    for link, c in link_counts.most_common():
        summary.append((f"  matched-lead bookings on link {link!r}", c))
    with open(OUT_DIR / "closer_funnel_summary.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Metric", "Value"])
        for k, v in summary:
            w.writerow([k, v])

    print("=== SUMMARY ===")
    for k, v in summary:
        print(f"  {v:>6}  {k}")
    print(f"\nWrote 3 CSVs to {OUT_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
