"""One-shot: re-grade setter reviews whose call_type is wrong.

Migration 0121 split the setter-review rubric by call_type. The first
cut keyed revival off an opt-in-date proxy, which missed the bulk of
revival leads (SMS-created DC Revival leads often have no opt-in date)
and mislabeled a couple of non-revival leads. The reviewer now detects
revival off the canonical REVIVAL_CF "DC Revival Lead" custom field
(`agents/setter_call_reviewer/reviewer._is_revival_call`).

This walks every existing review, recomputes the correct call_type via
that same detector, and re-runs the reviewer (force=True) on any row
whose stored call_type disagrees — flipping book↔close in both
directions. Slack is OFF (these rows already posted; a re-grade
shouldn't re-notify, and the upsert preserves slack_message_ts).

Usage:

    python scripts/rereview_revival_setter_calls.py            # dry-run: list
    python scripts/rereview_revival_setter_calls.py --smoke    # 1 call
    python scripts/rereview_revival_setter_calls.py --apply    # all mismatched

Idempotent: once a row's stored call_type matches the detector it's no
longer a target, so re-running converges. Safe to repeat.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time

from dotenv import load_dotenv

load_dotenv(".env.local")

from agents.setter_call_reviewer import ReviewError, review_call  # noqa: E402
from agents.setter_call_reviewer.reviewer import _is_revival_call  # noqa: E402
from shared.db import get_client  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s | %(message)s",
)
logger = logging.getLogger("rereview_revival_setter_calls")


def _find_mismatched_reviews(db) -> list[tuple[str, str, str]]:
    """Return (close_call_id, stored_call_type, correct_call_type) for every
    review whose stored call_type disagrees with the canonical detector.
    """
    reviews = (
        db.table("setter_call_reviews").select("close_call_id, call_type").execute()
    )
    out: list[tuple[str, str, str]] = []
    for r in reviews.data or []:
        cid = r["close_call_id"]
        stored = r.get("call_type")
        correct = "revival" if _is_revival_call(db, cid) else "outbound"
        if stored != correct:
            out.append((cid, stored, correct))
    return sorted(out)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--smoke", action="store_true", help="Re-grade exactly one mismatched call.")
    group.add_argument("--apply", action="store_true", help="Re-grade every mismatched call.")
    args = parser.parse_args()

    db = get_client()
    targets = _find_mismatched_reviews(db)
    flip_to_revival = sum(1 for _, _, c in targets if c == "revival")
    flip_to_outbound = sum(1 for _, _, c in targets if c == "outbound")
    logger.info(
        "rereview.discovered mismatched=%d (→revival=%d, →outbound=%d)",
        len(targets), flip_to_revival, flip_to_outbound,
    )
    if not targets:
        logger.info("rereview.nothing_to_do — every call_type already matches the detector.")
        return 0

    if not args.smoke and not args.apply:
        logger.info("rereview.dry_run — re-run with --smoke or --apply.")
        for cid, stored, correct in targets[:10]:
            logger.info("  %s  %s → %s", cid, stored, correct)
        if len(targets) > 10:
            logger.info("  ... and %d more", len(targets) - 10)
        return 0

    target = targets[:1] if args.smoke else targets
    logger.info("rereview.starting target=%d", len(target))

    succeeded = 0
    failed: list[tuple[str, str]] = []
    total_cost = 0.0
    t0 = time.time()
    for i, (cid, stored, correct) in enumerate(target, start=1):
        try:
            # force=True re-grades an existing row; post_to_slack=False so a
            # re-grade never re-notifies the channel.
            row = review_call(cid, force=True, post_to_slack=False)
            cost = float(row.get("sonnet_cost_usd") or 0)
            total_cost += cost
            logger.info(
                "rereview.ok [%d/%d] close_id=%s %s→%s score=%s closed=%s booked=%s cost=$%.4f",
                i, len(target), cid, stored, row.get("call_type"), row.get("lead_score"),
                row.get("closed"), row.get("booked"), cost,
            )
            succeeded += 1
        except ReviewError as e:
            logger.error("rereview.fail close_id=%s err=%s", cid, e)
            failed.append((cid, str(e)))
        except Exception as exc:  # noqa: BLE001
            logger.exception("rereview.unexpected close_id=%s", cid)
            failed.append((cid, f"unexpected: {type(exc).__name__}: {exc}"))

    elapsed = time.time() - t0
    logger.info(
        "rereview.done succeeded=%d failed=%d elapsed=%.1fs total_cost=$%.4f",
        succeeded, len(failed), elapsed, total_cost,
    )
    if failed:
        for cid, err in failed:
            logger.info("  %s: %s", cid, err[:200])

    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
