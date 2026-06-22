"""One-shot backfill for setter_call_transcripts.

Walks every eligible Close call since the backfill horizon
(2026-05-24 per V1 spec) and runs the transcription pipeline against
each one that doesn't already have a transcript.

Usage:

    # Smoke test — process ONE call, then exit
    python scripts/backfill_setter_call_transcripts.py --smoke

    # Full backfill — process everything pending
    python scripts/backfill_setter_call_transcripts.py --apply

Defaults to dry-run (lists what would be processed without calling
Deepgram or writing to the DB) so you can sanity-check before paying
for transcription.

Reads env from `.env.local` like the rest of the codebase. To run
against cloud Supabase instead of local Docker, set the cloud
SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env before invoking — the
script honours whatever env it sees at startup.

The pipeline is idempotent on close_call_id, so re-running this script
is safe; it will skip anything already transcribed.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time

from dotenv import load_dotenv

load_dotenv(".env.local")

from ingestion.setter_calls import (  # noqa: E402  (load env first)
    EligibilityError,
    RecordingFetchError,
    find_pending_calls,
    transcribe_call,
)
from ingestion.setter_calls.deepgram import DeepgramError  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s | %(message)s",
)
logger = logging.getLogger("backfill_setter_call_transcripts")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--smoke",
        action="store_true",
        help="Process exactly one pending call, then exit.",
    )
    group.add_argument(
        "--apply",
        action="store_true",
        help="Run the full backfill end-to-end.",
    )
    args = parser.parse_args()

    pending = find_pending_calls()
    logger.info("backfill.discovered count=%d", len(pending))
    if not pending:
        logger.info("backfill.nothing_to_do — every eligible call already has a transcript.")
        return 0

    if not args.smoke and not args.apply:
        logger.info("backfill.dry_run — re-run with --smoke or --apply to actually transcribe.")
        for close_id in pending[:10]:
            logger.info("  would transcribe %s", close_id)
        if len(pending) > 10:
            logger.info("  ... and %d more", len(pending) - 10)
        return 0

    target = pending[:1] if args.smoke else pending
    logger.info("backfill.starting target=%d", len(target))

    succeeded = 0
    skipped = 0
    failed: list[tuple[str, str]] = []
    t0 = time.time()
    for i, close_id in enumerate(target, start=1):
        try:
            row = transcribe_call(close_id)
            logger.info(
                "backfill.ok [%d/%d] close_id=%s duration_s=%s cost=$%s",
                i, len(target), close_id, row["duration_s"], row["deepgram_cost_usd"],
            )
            succeeded += 1
        except EligibilityError as e:
            # Sweep query and per-call eligibility disagree — bug in one of
            # them, or call state changed between query and processing.
            logger.warning("backfill.skip close_id=%s reason=%s", close_id, e)
            skipped += 1
        except (RecordingFetchError, DeepgramError) as e:
            logger.error("backfill.fail close_id=%s err=%s", close_id, e)
            failed.append((close_id, str(e)))

    elapsed = time.time() - t0
    logger.info(
        "backfill.done succeeded=%d skipped=%d failed=%d elapsed=%.1fs",
        succeeded, skipped, len(failed), elapsed,
    )
    if failed:
        logger.info("backfill.failures:")
        for close_id, err in failed:
            logger.info("  %s: %s", close_id, err[:200])

    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
