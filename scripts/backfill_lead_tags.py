"""Backfill / full rebuild of lead tags. Thin wrapper over shared.lead_tagging
(the single source of truth). Dry-run reports the distribution; --apply wipes and
rebuilds lead_cycles + lead_cycle_stages for all in-scope leads and logs the run.

  .venv/bin/python scripts/backfill_lead_tags.py            # dry run (report only)
  .venv/bin/python scripts/backfill_lead_tags.py --apply    # rebuild + log
"""
import argparse
from collections import defaultdict

from shared.lead_tagging import _compute, _connect, retag


def main(apply):
    if apply:
        s = retag(lead_ids=None, trigger="backfill")
        print(f"APPLIED. ok={s['ok']} leads={s['lead_count']} anomalies={len(s['anomalies'])}")
        if s["anomalies"]:
            print("  anomalies:", s["anomalies"][:10])
        return

    conn = _connect()
    cur = conn.cursor()
    cr, sr = _compute(cur, None)
    cur.close()
    conn.close()
    dist = defaultdict(int)
    by_lead = defaultdict(int)
    for r in cr:
        by_lead[r[0]] += 1
    for n in by_lead.values():
        dist[n] += 1
    print(f"DRY RUN — leads={len(by_lead)} cycles={len(cr)} stage_rows={len(sr)}")
    print(f"  identity tags: direct={sum(1 for r in cr if r[4])} "
          f"reactive={sum(1 for r in cr if r[5])} dq={sum(1 for r in cr if r[7])}")
    print(f"  cycles-per-lead distribution: {dict(sorted(dist.items()))}")
    print(f"  HT closes (stage rows): {sum(1 for s in sr if s[8] == 'ht')}")
    print("  nothing written — re-run with --apply")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    main(ap.parse_args().apply)
