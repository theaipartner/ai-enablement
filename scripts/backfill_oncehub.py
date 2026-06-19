"""Backfill / reconcile OnceHub bookings into oncehub_bookings.

The API backstop for the webhook: initial load of existing bookings, and the
healer for anything a webhook missed. Idempotent (upsert on booking_id).

Usage:
  .venv/bin/python -m scripts.backfill_oncehub --smoke   # one booking, end-to-end
  .venv/bin/python -m scripts.backfill_oncehub           # all bookings

Reads ONCEHUB_API_KEY + SUPABASE_* from the environment. Per ingestion.md, the
ACTIVE SUPABASE_URL in .env.local points at LOCAL Docker — to write CLOUD, set
the https:// URL + cloud service-role key in the shell first.
"""

from __future__ import annotations

import argparse
import logging
import sys

from ingestion.oncehub.client import OnceHubClient
from ingestion.oncehub.pipeline import backfill_bookings, upsert_booking_from_payload
from shared.db import get_client

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("ai_enablement.scripts.backfill_oncehub")


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill OnceHub bookings.")
    parser.add_argument(
        "--smoke",
        action="store_true",
        help="Fetch + upsert exactly ONE booking end-to-end against the real DB.",
    )
    parser.add_argument(
        "--max", type=int, default=None, help="Cap the number of bookings processed.",
    )
    args = parser.parse_args()

    client = OnceHubClient.from_env()
    db = get_client()

    if args.smoke:
        first = next(iter(client.iter_bookings()), None)
        if not first:
            logger.warning("oncehub smoke: no bookings returned by the API.")
            return 1
        bid = upsert_booking_from_payload(db, first)
        logger.info("oncehub smoke: upserted booking_id=%s status=%s", bid, first.get("status"))
        return 0 if bid else 1

    outcome = backfill_bookings(client, db, max_bookings=args.max)
    logger.info(
        "oncehub backfill done: synced=%d failed=%d errors=%d",
        outcome.bookings_synced, outcome.bookings_failed, len(outcome.errors),
    )
    for err in outcome.errors[:20]:
        logger.warning("  error: %s", err)
    return 0 if not outcome.errors else 2


if __name__ == "__main__":
    sys.exit(main())
