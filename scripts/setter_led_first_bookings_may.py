"""Net-new setter-led FIRST bookings among May closer-funnel leads.

Question (Drake, May 28, refined): of the closer-funnel leads (the CSV list;
closer funnel started Apr 28), how many had a SETTER-LED booking that was
their FIRST booking — i.e. they never had any Calendly booking before it.
This isolates the setter's net-new contribution (a booking from someone who
hadn't booked), excluding leads a setter merely re-booked after they had
already self-booked direct.

Method (two authoritative sources, no fragile single-system inference):
  - SETTER-LED + booking time: the #confirmed-booked-calls Slack log
    (Funnel/Setter fields). 'Direct Closer Funnel' = direct; 'Closer Funnel'
    / 'Setter Funnel' (with a setter) = setter-led.
  - PRIOR BOOKING check: Calendly (calendly_scheduled_events/invitees). A
    lead is NET-NEW iff they have no Calendly booking created more than
    PRIOR_BUFFER before their earliest setter-led booking. The buffer
    excludes the setter booking itself (logged to Slack up to ~1h after the
    Calendly create); genuine prior bookings sit hours-to-days earlier, so
    the result is insensitive to the exact threshold (clean gap in the data).

Population: closer-funnel CSV leads only, deduped by email.
Output: scripts/out/may_setter_led_first_bookings.csv + printed summary.
"""

from __future__ import annotations

import csv
import datetime as dt
import sys
from collections import defaultdict
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(_REPO / ".env.local")

from shared.db import get_client  # noqa: E402
from ingestion.slack.client import SlackClient  # noqa: E402
from scripts.slack_confirmed_bookings_xref import parse_bookings, classify  # noqa: E402
from scripts.match_setter_bookings_may import load_leads, load_bookings, matches  # noqa: E402

OUT_DIR = _REPO / "scripts" / "out"
PRIOR_BUFFER = dt.timedelta(minutes=90)


def _pdt(iso: str):
    return dt.datetime.fromisoformat(iso) if iso else None


def main() -> int:
    leads = {l["_email"]: l for l in load_leads() if l["_email"]}
    cal = load_bookings(get_client())
    slack = parse_bookings(SlackClient())
    for b in slack:
        b["k"] = classify(b)

    # all confirmed bookings since Apr 27 — direct vs setter-led (overall)
    direct_all = sum(1 for b in slack if b["k"] == "direct")
    setter_all = sum(1 for b in slack if b["k"] == "setter_led")

    # earliest setter-led Slack booking per closer-funnel lead; and the set
    # of confirmed DIRECT booking times per email (to catch a self-booked
    # direct call that precedes the setter booking but isn't in Calendly).
    setter_ts = defaultdict(list)
    setter_entry = {}
    direct_ts = defaultdict(list)
    for b in slack:
        if b["_email"] not in leads:
            continue
        if b["k"] == "setter_led":
            setter_ts[b["_email"]].append(float(b["ts"]))
            cur = setter_entry.get(b["_email"])
            if cur is None or float(b["ts"]) < float(cur["ts"]):
                setter_entry[b["_email"]] = b
        elif b["k"] == "direct":
            direct_ts[b["_email"]].append(float(b["ts"]))

    rows = []
    for em, tss in setter_ts.items():
        t1 = dt.datetime.fromtimestamp(min(tss), dt.timezone.utc)
        lead = leads[em]
        cb = [c for c in cal if matches(lead, c) and c["booking_created"]]
        prior_cal = [c for c in cb if (t1 - _pdt(c["booking_created"])) > PRIOR_BUFFER]
        # a confirmed direct booking strictly before the setter booking
        prior_direct = any(
            dt.datetime.fromtimestamp(ts, dt.timezone.utc) < t1 - dt.timedelta(minutes=5)
            for ts in direct_ts.get(em, [])
        )
        rows.append({"lead": lead, "entry": setter_entry[em], "t1": t1,
                     "net_new": not prior_cal and not prior_direct,
                     "n_prior": len(prior_cal)})

    net = [r for r in rows if r["net_new"]]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUT_DIR / "may_setter_led_first_bookings.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow([
            "First name", "Last name", "Email", "Phone", "Willing to invest",
            "Closer-funnel qualified?", "Lead submitted (UTC)",
            "Setter", "Closer", "Funnel (Slack)", "Setter booking logged (UTC)",
        ])
        for r in sorted(net, key=lambda x: x["t1"]):
            l, e = r["lead"], r["entry"]
            w.writerow([
                l["first"], l["last"], l["email"], l["phone"], l["invest"],
                "Yes" if l["qualified"] else "No", l["submitted"],
                e["setter"], e["closer"], e["funnel"].split("\n")[0],
                r["t1"].isoformat(),
            ])

    qy = sum(1 for r in net if r["lead"]["qualified"])
    print("=== May — net-new setter-led FIRST bookings (closer-funnel leads) ===")
    print(f"  all confirmed bookings since Apr 27: direct={direct_all}  setter-led={setter_all}")
    print(f"  closer-funnel leads with a setter-led booking: {len(rows)}")
    print(f"     - re-booked (had earlier Calendly booking): {len(rows) - len(net)}")
    print(f"  >>> NET-NEW setter-led first bookings: {len(net)}  "
          f"(qualified={qy}, unqualified={len(net) - qy}) <<<")
    print(f"  Wrote {OUT_DIR/'may_setter_led_first_bookings.csv'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
