"""One-shot: call Clarity API three times (numOfDays=1, 2, 3) and store
the results with suffixed metric_names so the LP page can derive
clean per-day values.

Each call writes rows keyed by (snapshot_date, metric_name + suffix, url):
  * numOfDays=1 → suffix "_1d"  (today only)
  * numOfDays=2 → suffix "_2d"  (today + yesterday)
  * numOfDays=3 → suffix ""     (the canonical rolling-3, backward compat)

Idempotent — PK + on-conflict-update. Burns 3 of 10 daily API reqs.
Local-only by default; same code path as the cron once we deploy.
"""

from __future__ import annotations

import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(_REPO / ".env.local")

from ingestion.clarity.client import ClarityClient  # noqa: E402
from ingestion.clarity.pipeline import sync_clarity_metrics_daily  # noqa: E402
from shared.db import get_client  # noqa: E402


def main() -> int:
    db = get_client()
    client = ClarityClient.from_env()

    for num_of_days, suffix in ((1, "_1d"), (2, "_2d"), (3, "")):
        print(f"\n=== numOfDays={num_of_days}  metric_name_suffix={suffix!r} ===")
        outcome = sync_clarity_metrics_daily(
            db, client, num_of_days=num_of_days, metric_name_suffix=suffix,
        )
        print(f"  rows_parsed={outcome.rows_parsed}  rows_upserted={outcome.rows_upserted}")
        print(f"  distinct_paths={outcome.distinct_paths}")
        if outcome.errors:
            print(f"  ERRORS: {outcome.errors}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
