"""One-shot backfill for setter_call_reviews.

Walks every transcript in setter_call_transcripts that doesn't yet
have a review and runs the Sonnet reviewer against each one.

Usage:

    python scripts/backfill_setter_call_reviews.py --smoke   # 1 call
    python scripts/backfill_setter_call_reviews.py --apply   # all

Defaults to dry-run. Idempotent on close_call_id, so re-running is
safe — already-reviewed calls are skipped.

To run against cloud Supabase, override SUPABASE_URL +
SUPABASE_SERVICE_ROLE_KEY in env before invoking.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time

from dotenv import load_dotenv

load_dotenv(".env.local")

from agents.setter_call_reviewer import (  # noqa: E402
    ReviewError,
    find_pending_reviews,
    review_call,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s | %(message)s",
)
logger = logging.getLogger("backfill_setter_call_reviews")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--smoke", action="store_true", help="Process exactly one pending review.")
    group.add_argument("--apply", action="store_true", help="Run the full backfill.")
    # Slack posts are OFF by default for backfills — historical reviews
    # shouldn't fan out to the team channel. Live cron + webhook paths
    # keep their default post_to_slack=True.
    parser.add_argument(
        "--slack",
        action="store_true",
        help="Also post each review to Slack (off by default for backfills).",
    )
    args = parser.parse_args()

    pending = find_pending_reviews()
    logger.info("backfill.discovered count=%d", len(pending))
    if not pending:
        logger.info("backfill.nothing_to_do — every transcript already has a review.")
        return 0

    if not args.smoke and not args.apply:
        logger.info("backfill.dry_run — re-run with --smoke or --apply to actually review.")
        for cid in pending[:10]:
            logger.info("  would review %s", cid)
        if len(pending) > 10:
            logger.info("  ... and %d more", len(pending) - 10)
        return 0

    target = pending[:1] if args.smoke else pending
    logger.info("backfill.starting target=%d", len(target))

    succeeded = 0
    failed: list[tuple[str, str]] = []
    total_cost = 0.0
    t0 = time.time()
    for i, cid in enumerate(target, start=1):
        try:
            row = review_call(cid, post_to_slack=args.slack)
            cost = float(row.get("sonnet_cost_usd") or 0)
            total_cost += cost
            logger.info(
                "backfill.ok [%d/%d] close_id=%s score=%s dq=%s booked=%s cost=$%.4f",
                i, len(target), cid, row.get("lead_score"),
                row.get("should_be_dqd"), row.get("booked"), cost,
            )
            succeeded += 1
        except ReviewError as e:
            logger.error("backfill.fail close_id=%s err=%s", cid, e)
            failed.append((cid, str(e)))
        except Exception as exc:
            logger.exception("backfill.unexpected close_id=%s", cid)
            failed.append((cid, f"unexpected: {type(exc).__name__}: {exc}"))

    elapsed = time.time() - t0
    logger.info(
        "backfill.done succeeded=%d failed=%d elapsed=%.1fs total_cost=$%.4f",
        succeeded, len(failed), elapsed, total_cost,
    )
    if failed:
        logger.info("backfill.failures:")
        for cid, err in failed:
            logger.info("  %s: %s", cid, err[:200])

    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
