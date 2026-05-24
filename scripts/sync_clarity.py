"""Manual Clarity sync wrapper — local invocation of what the cron runs.

Usage:
    .venv/bin/python scripts/sync_clarity.py                # dry-run (no API call, no DB write)
    .venv/bin/python scripts/sync_clarity.py --smoke        # 1 real API call, parse, NO DB write
    .venv/bin/python scripts/sync_clarity.py --apply        # 1 real API call, parse, UPSERT
    .venv/bin/python scripts/sync_clarity.py --apply --days 1   # narrower window

Real-API behavior:
  * --smoke and --apply each burn 1 of the 10-reqs/project/day cap.
    Use sparingly during dev; the cron uses 1/day on its own.
  * --apply re-pulls the full N-day window and upserts; idempotent
    (PK = snapshot_date, metric_name, url).
  * --smoke is the canonical pre-`--apply` gate per CLAUDE.md
    § Operational patterns. It exercises the FULL fetch+parse path
    without touching the DB.

Loads .env.local for CLARITY_API_KEY + SUPABASE_*.

Per CLAUDE.md § Operational patterns: real-API smoke before bulk apply.
For Clarity that's important because we can't observe the parser's
real-API behavior without spending budget — every test burns a daily
req.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(_REPO / ".env.local")

from ingestion.clarity import (  # noqa: E402
    DEFAULT_TIME_METRIC,
    LANDING_PAGE_PATH,
    THANK_YOU_PAGE_PATH,
)
from ingestion.clarity.client import ClarityAPIError, ClarityClient  # noqa: E402
from ingestion.clarity.parser import parse_response  # noqa: E402
from ingestion.clarity.pipeline import sync_clarity_metrics_daily  # noqa: E402


def _show_canonical_summary(rows: list[dict], snapshot_date_iso: str) -> None:
    """Sanity check Drake eyeballs after every run — does the data look real?"""
    print("\n--- Canonical metric preview (per spec § What success looks like) ---")
    print(f"snapshot_date={snapshot_date_iso}")
    print(f"LANDING_PAGE_PATH={LANDING_PAGE_PATH!r}  THANK_YOU_PAGE_PATH={THANK_YOU_PAGE_PATH!r}")
    print(f"DEFAULT_TIME_METRIC={DEFAULT_TIME_METRIC!r}")

    # Landing page traffic
    lp_traffic = [
        r for r in rows
        if r["metric_name"] == "Traffic" and r["url_path"] == LANDING_PAGE_PATH
    ]
    lp_sessions = sum((r["total_session_count"] or 0) for r in lp_traffic)
    lp_users = sum((r["distinct_user_count"] or 0) for r in lp_traffic)
    print(
        f"\nLanding ({LANDING_PAGE_PATH}) Traffic — {len(lp_traffic)} URL+QS rows; "
        f"sum totalSessionCount={lp_sessions}, distinctUserCount={lp_users}"
    )

    # Landing page engagement time
    lp_eng = [
        r for r in rows
        if r["metric_name"] == "EngagementTime" and r["url_path"] == LANDING_PAGE_PATH
    ]
    lp_active = sum((r["active_time"] or 0) for r in lp_eng)
    lp_total = sum((r["total_time"] or 0) for r in lp_eng)
    print(
        f"Landing ({LANDING_PAGE_PATH}) EngagementTime — {len(lp_eng)} rows; "
        f"sum active_time={lp_active}s, total_time={lp_total}s"
    )

    # Thank-you page engagement time
    ty_eng = [
        r for r in rows
        if r["metric_name"] == "EngagementTime" and r["url_path"] == THANK_YOU_PAGE_PATH
    ]
    ty_active = sum((r["active_time"] or 0) for r in ty_eng)
    ty_total = sum((r["total_time"] or 0) for r in ty_eng)
    print(
        f"Thank-you ({THANK_YOU_PAGE_PATH}) EngagementTime — {len(ty_eng)} rows; "
        f"sum active_time={ty_active}s, total_time={ty_total}s"
    )

    distinct_paths = sorted({r["url_path"] for r in rows})
    print(f"\nAll distinct url_paths in this pull ({len(distinct_paths)}): {distinct_paths}")


def main() -> int:
    p = argparse.ArgumentParser(description="Manual Clarity sync wrapper")
    p.add_argument("--smoke", action="store_true",
                   help="One real API call + parse; NO DB write.")
    p.add_argument("--apply", action="store_true",
                   help="One real API call + parse + upsert. Idempotent.")
    p.add_argument("--days", type=int, default=3, choices=(1, 2, 3),
                   help="numOfDays for the Clarity call (1-3). Default 3.")
    args = p.parse_args()

    if args.smoke and args.apply:
        print("Pick one: --smoke OR --apply (not both)", file=sys.stderr)
        return 2

    if not (args.smoke or args.apply):
        print("Dry-run (no API call, no DB write). Re-run with --smoke or --apply.")
        print(f"Would call: ClarityClient.fetch_url_segmented(num_of_days={args.days})")
        print(f"Canonical config:")
        print(f"  LANDING_PAGE_PATH      = {LANDING_PAGE_PATH!r}")
        print(f"  THANK_YOU_PAGE_PATH    = {THANK_YOU_PAGE_PATH!r}")
        print(f"  DEFAULT_TIME_METRIC    = {DEFAULT_TIME_METRIC!r}")
        return 0

    try:
        client = ClarityClient.from_env()
    except RuntimeError as exc:
        print(f"HARD STOP: {exc}", file=sys.stderr)
        return 2

    if args.smoke:
        print(f"--smoke: fetching last {args.days} day(s) from Clarity (burns 1 req of 10/day)...")
        try:
            blocks = client.fetch_url_segmented(num_of_days=args.days)
        except ClarityAPIError as exc:
            print(f"HARD STOP: Clarity fetch failed: {exc}", file=sys.stderr)
            return 2

        from datetime import datetime, timezone
        today = datetime.now(timezone.utc).date()
        rows, warnings = parse_response(blocks, today)
        print(f"  → {len(blocks)} metric blocks, {len(rows)} rows parsed, "
              f"{len(warnings)} warnings")
        for w in warnings[:10]:
            print(f"    WARN: {w}")
        _show_canonical_summary(rows, today.isoformat())
        print("\n--smoke complete. NO DB writes performed.")
        return 0

    # --apply
    from shared.db import get_client
    db = get_client()
    print(f"--apply: fetching last {args.days} day(s) + upserting to "
          f"clarity_metrics_daily (burns 1 req of 10/day)...")
    outcome = sync_clarity_metrics_daily(db, client, num_of_days=args.days)

    print(f"\nOutcome:")
    print(json.dumps({
        "snapshot_date": outcome.snapshot_date,
        "metric_blocks_seen": outcome.metric_blocks_seen,
        "rows_parsed": outcome.rows_parsed,
        "rows_upserted": outcome.rows_upserted,
        "rows_failed": outcome.rows_failed,
        "distinct_path_count": len(outcome.distinct_paths),
        "distinct_paths": outcome.distinct_paths,
        "warnings": outcome.warnings,
        "errors": outcome.errors,
    }, indent=2))

    if outcome.errors:
        print("\nERRORS observed — see above. Exit 1.")
        return 1

    # Re-fetch rows from the DB to show canonical preview (round-trip check).
    # Uses a FRESH client because the one above has a stale HTTP/2 connection
    # after the big batch upsert — the postgrest client's underlying httpx
    # pool returns ConnectionTerminated on the next call against the pooler.
    # The cron doesn't have this problem (it doesn't re-query); this is a
    # manual-wrapper convenience only.
    fresh_db = get_client()
    db_rows = (
        fresh_db.table("clarity_metrics_daily")
        .select("metric_name,url_path,total_session_count,distinct_user_count,"
                "active_time,total_time")
        .eq("snapshot_date", outcome.snapshot_date)
        .execute()
    )
    _show_canonical_summary(db_rows.data or [], outcome.snapshot_date or "<unset>")

    return 0


if __name__ == "__main__":
    sys.exit(main())
