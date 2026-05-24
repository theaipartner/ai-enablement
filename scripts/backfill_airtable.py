"""Manual Airtable backfill — 1-day window (Drake's spec default).

Usage:
    .venv/bin/python scripts/backfill_airtable.py             # dry-run preview
    .venv/bin/python scripts/backfill_airtable.py --smoke     # 1 table, 1 page, upsert (1 record)
    .venv/bin/python scripts/backfill_airtable.py --apply     # 1-day window, all 3 sources, upsert
    .venv/bin/python scripts/backfill_airtable.py --apply --hours 24
    .venv/bin/python scripts/backfill_airtable.py --apply --table tblYsh3fxTpXuPdIW
    .venv/bin/python scripts/backfill_airtable.py --apply --full     # NO since filter (last 1000 per table)

Real-API behavior:
  * `--smoke` exercises full fetch+parse+upsert against ONE record from
    ONE table, idempotent — the canonical pre-`--apply` gate per
    CLAUDE.md § Operational patterns. Also reports the observed
    Setter Name fill rate on Full Closer Report records (informs the
    attribution-hypothesis check per the discovery report).
  * `--apply` walks all 3 target sources with a CREATED_TIME() filter
    set to "last N hours" (default 24).
  * `--apply --full` drops the filter — useful only for the cold start
    or a recovery from a long outage. The mirror is created-only so
    pulling history doesn't gain you edits.

Loads .env.local for AIRTABLE_SALES_PAT + SUPABASE_*.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(_REPO / ".env.local")

from ingestion.airtable import TARGET_TABLES  # noqa: E402
from ingestion.airtable.client import AirtableAPIError, AirtableClient  # noqa: E402
from ingestion.airtable.pipeline import sync_all, sync_table  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description="Manual Airtable backfill wrapper")
    p.add_argument("--smoke", action="store_true",
                   help="One real API call (one table, one record), upsert.")
    p.add_argument("--apply", action="store_true",
                   help="Real-API + DB writes for the 1-day window.")
    p.add_argument("--hours", type=int, default=24,
                   help="Lookback hours for --apply (default 24).")
    p.add_argument("--table", metavar="TABLE_ID",
                   help="Restrict --apply to a single Airtable table id.")
    p.add_argument("--full", action="store_true",
                   help="Drop the since-window filter (no --hours).")
    args = p.parse_args()

    if args.smoke and args.apply:
        print("Pick one: --smoke OR --apply (not both)", file=sys.stderr)
        return 2

    if not (args.smoke or args.apply):
        print("Dry-run (no API call, no DB write). Re-run with --smoke or --apply.")
        print(f"Target sources ({len(TARGET_TABLES)}):")
        for tid, (label, region, target) in TARGET_TABLES.items():
            r = f", region={region}" if region else ""
            print(f"  {tid}  '{label}'{r}  → {target}")
        print()
        print(f"--apply window: last {args.hours}h via CREATED_TIME() filter")
        return 0

    try:
        client = AirtableClient.from_env()
    except RuntimeError as exc:
        print(f"HARD STOP: {exc}", file=sys.stderr)
        return 2

    if args.smoke:
        return _do_smoke(client)

    # --apply
    from shared.db import get_client
    db = get_client()

    since_iso: str | None = None
    if not args.full:
        since_dt = datetime.now(timezone.utc) - timedelta(hours=args.hours)
        since_iso = since_dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")
        print(f"--apply: window since {since_iso} ({args.hours}h)")
    else:
        print("--apply --full: NO since filter (last 1000 per table)")

    if args.table:
        if args.table not in TARGET_TABLES:
            print(f"--table {args.table!r} not in TARGET_TABLES", file=sys.stderr)
            return 2
        outcome = sync_table(client, db, args.table, since=since_iso)
    else:
        outcome = sync_all(client, db, since=since_iso)

    _print_outcome(outcome)
    return 0 if not outcome.errors else 1


def _do_smoke(client: AirtableClient) -> int:
    """Smoke walks ONE table, ONE record. Reports Setter Name fill rate
    observation if the smoke happens to land Full Closer Report records.
    """
    # Pick Full Closer US for the smoke — it's the higher-stakes table
    # AND it lets us observe the Setter Name fill rate.
    table_id = "tblYsh3fxTpXuPdIW"
    label, region, target = TARGET_TABLES[table_id]
    print(f"--smoke: 1 record from {label} ({table_id}) — full path, idempotent")

    from shared.db import get_client
    db = get_client()
    outcome = sync_table(client, db, table_id, limit=1)
    _print_outcome(outcome)

    # Setter Name fill-rate observation — useful even on N=1.
    if outcome.full_closer_records_seen > 0:
        fill = outcome.setter_name_fill_count / outcome.full_closer_records_seen
        print(f"\nSetter Name fill rate observation (N={outcome.full_closer_records_seen}): "
              f"{fill * 100:.0f}% — discovery hypothesis is 'populated = setter-led' "
              "(needs N>=100 to confirm).")
    return 0 if not outcome.errors else 1


def _print_outcome(outcome) -> None:
    print()
    print("Outcome:")
    print(json.dumps({
        "tables_walked": outcome.tables_walked,
        "records_parsed": outcome.records_parsed,
        "records_upserted": outcome.records_upserted,
        "records_failed": outcome.records_failed,
        "parse_failures": outcome.parse_failures,
        "full_closer_records_seen": outcome.full_closer_records_seen,
        "setter_name_fill_count": outcome.setter_name_fill_count,
        "errors": outcome.errors[:20],
    }, indent=2))


if __name__ == "__main__":
    sys.exit(main())
