"""Cross-reference the #confirmed-booked-calls Slack channel against the
May closer-funnel CSV.

Question (Drake, May 28): the setters log every confirmed booking (both
funnels) into #confirmed-booked-calls. Of those bookings since Apr 27:
  - how many were DIRECT vs setter-led, and
  - how many CLOSER-FUNNEL leads (verified against the closer CSV) had a
    setter-led booking.

The bot messages are structured:
  *<Name> (<mailto:email|email>) just booked a Confirmed call with us.*
  *Closer:* <name>   *Tag:* <tag>   *Setter:* <name>
  *Funnel:* <Direct Closer Funnel | Closer Funnel | Setter Funnel>
  Start Time: <dd Mon yyyy HH:MM EST>   [Ad Name: ...]

Funnel label is the booking's own classification:
  'Direct Closer Funnel' = direct ad-funnel book (no setter)
  'Closer Funnel'        = setter-led booking of a closer-funnel lead
  'Setter Funnel'        = setter-funnel lead

Reads the channel live (no permanent mirror) and writes
scripts/out/slack_confirmed_bookings_xref.csv plus a printed summary.
"""

from __future__ import annotations

import csv
import datetime as dt
import re
import sys
from collections import Counter
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(_REPO / ".env.local")

from ingestion.slack.client import SlackClient  # noqa: E402
from scripts.match_closer_funnel_bookings import norm_email  # noqa: E402

CHANNEL = "C0A7QJP2QGZ"   # #confirmed-booked-calls (private)
SINCE = dt.datetime(2026, 4, 27, tzinfo=dt.timezone.utc)
CLOSER_CSV = _REPO / "lead data" / (
    "Closer Funnel Leads - responses-SFedWelr-"
    "01KSRAVZ62MZ3DH1GN4YJMK0K4-881NOMZ6YVCQEIRO8EG1OU17.csv"
)
OUT_DIR = _REPO / "scripts" / "out"


def _field(text: str, label: str) -> str:
    m = re.search(rf"\*{label}:\*\s*([^\n*]*)", text)
    return m.group(1).strip() if m else ""


def load_closer_emails() -> dict[str, bool]:
    """email -> qualified?  for the May closer-funnel CSV."""
    rows = list(csv.reader(open(CLOSER_CSV, newline="", encoding="utf-8")))
    hdr, data = rows[0], rows[1:]
    iE, iEnd = hdr.index("Email"), hdr.index("Ending")
    out = {}
    for r in data:
        if len(r) <= iEnd:
            continue
        e = norm_email(r[iE])
        if e:
            out[e] = (r[iEnd].strip() == "Qualified") or out.get(e, False)
    return out


def parse_bookings(client: SlackClient) -> list[dict]:
    bookings = []
    for m in client.conversations_history(CHANNEL, oldest=str(SINCE.timestamp())):
        t = m.get("text") or ""
        if "just booked" not in t:
            continue
        em = re.search(r"<mailto:([^|>]+)", t)
        funnel = _field(t, "Funnel")
        setter = _field(t, "Setter")
        name_m = re.match(r"\*([^(]+?)\s*\(", t)
        bookings.append({
            "ts": m.get("ts"),
            "name": name_m.group(1).strip() if name_m else "",
            "email": (em.group(1).strip() if em else ""),
            "_email": norm_email(em.group(1)) if em else "",
            "closer": _field(t, "Closer"),
            "setter": setter,
            "funnel": funnel,
        })
    return bookings


def classify(b: dict) -> str:
    """direct | setter_led | unlabeled, from the Funnel label (+ setter)."""
    f = b["funnel"].lower()
    if f.startswith("direct"):
        return "direct"
    if "closer funnel" in f or "setter funnel" in f:
        return "setter_led"
    # older messages with no Funnel field: fall back to setter presence
    return "setter_led" if b["setter"] else "direct"


def main() -> int:
    client = SlackClient()
    closer = load_closer_emails()
    bookings = parse_bookings(client)
    for b in bookings:
        b["kind"] = classify(b)
        b["in_closer_csv"] = b["_email"] in closer
        b["closer_qualified"] = closer.get(b["_email"], None)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUT_DIR / "slack_confirmed_bookings_xref.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow([
            "Name", "Email", "Funnel (Slack label)", "Direct vs setter-led",
            "Setter", "Closer", "In closer-funnel CSV?",
            "Closer-funnel qualified?", "Booked ts (UTC)",
        ])
        for b in sorted(bookings, key=lambda x: x["ts"] or ""):
            ts = dt.datetime.fromtimestamp(float(b["ts"]), dt.timezone.utc).isoformat() if b["ts"] else ""
            w.writerow([
                b["name"], b["email"], b["funnel"].split("\n")[0], b["kind"],
                b["setter"], b["closer"],
                "Yes" if b["in_closer_csv"] else "No",
                "" if b["closer_qualified"] is None else ("Yes" if b["closer_qualified"] else "No"),
                ts,
            ])

    n = len(bookings)
    direct = [b for b in bookings if b["kind"] == "direct"]
    setter_led = [b for b in bookings if b["kind"] == "setter_led"]
    print("=== #confirmed-booked-calls — bookings since Apr 27 ===")
    print(f"  total confirmed bookings: {n}")
    print(f"  DIRECT (no setter):       {len(direct)}")
    print(f"  SETTER-LED:               {len(setter_led)}")
    print("\n-- by Slack Funnel label --")
    for v, c in Counter(b["funnel"].split("\n")[0] or "(none)" for b in bookings).most_common():
        print(f"  {c:4d}  {v!r}")
    print("\n-- cross-reference vs closer-funnel CSV --")
    in_csv = [b for b in bookings if b["in_closer_csv"]]
    print(f"  bookings whose email IS in the closer CSV: {len(in_csv)}")
    csv_setter = [b for b in in_csv if b["kind"] == "setter_led"]
    csv_direct = [b for b in in_csv if b["kind"] == "direct"]
    print(f"     - of those, setter-led: {len(csv_setter)}   direct: {len(csv_direct)}")
    print(f"\n  >>> CLOSER-FUNNEL LEADS WITH SETTER-LED BOOKINGS: {len(csv_setter)} <<<")
    print(f"\n  (emails matched: {sum(1 for b in bookings if b['_email'])}/{n}; "
          f"distinct closer-CSV people booked = {len(set(b['_email'] for b in in_csv))})")
    print(f"  Wrote {OUT_DIR/'slack_confirmed_bookings_xref.csv'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
