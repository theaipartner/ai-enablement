"""One-shot: re-review existing revival setter calls under the DC rubric.

Migration 0121 split the setter-review rubric by call_type. Reviews
written before it all defaulted to call_type='outbound' (graded on
booking). The revival (Digital College reactivation) calls among them
should be graded on closing-on-the-phone instead — closed /
no_close_reason, not booked / no_book_reason.

This walks every existing review whose lead is a cold pre-horizon
(revival) lead and re-runs the reviewer with force=True. The reviewer's
own is_revival check re-classifies them to call_type='revival' and
writes the close-outcome columns. Slack is OFF — these rows already
posted once, and a re-grade shouldn't re-notify (the upsert preserves
slack_message_ts regardless).

Usage:

    python scripts/rereview_revival_setter_calls.py            # dry-run: list
    python scripts/rereview_revival_setter_calls.py --smoke    # 1 call
    python scripts/rereview_revival_setter_calls.py --apply    # all

Idempotent: re-running re-grades the same set. Safe to repeat.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time

from dotenv import load_dotenv

load_dotenv(".env.local")

from agents.setter_call_reviewer import ReviewError, review_call  # noqa: E402
from agents.setter_call_reviewer.reviewer import REVIVAL_HORIZON  # noqa: E402
from shared.db import get_client  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s | %(message)s",
)
logger = logging.getLogger("rereview_revival_setter_calls")


def _find_revival_reviews(db) -> list[str]:
    """Return close_call_ids of existing reviews whose lead opted in
    before REVIVAL_HORIZON (i.e. revival calls). Mirrors the reviewer's
    is_revival logic, batched: reviews → close_calls.lead_id →
    close_leads.latest_opt_in_date.
    """
    reviews = db.table("setter_call_reviews").select("close_call_id").execute()
    review_ids = [r["close_call_id"] for r in (reviews.data or [])]
    if not review_ids:
        return []

    # close_call_id → lead_id
    lead_by_call: dict[str, str] = {}
    for chunk in _chunks(review_ids, 200):
        calls = (
            db.table("close_calls")
            .select("close_id, lead_id")
            .in_("close_id", chunk)
            .execute()
        )
        for c in calls.data or []:
            if c.get("lead_id"):
                lead_by_call[c["close_id"]] = c["lead_id"]

    # lead_id → latest_opt_in_date
    lead_ids = list(set(lead_by_call.values()))
    opt_in_by_lead: dict[str, str | None] = {}
    for chunk in _chunks(lead_ids, 200):
        leads = (
            db.table("close_leads")
            .select("close_id, latest_opt_in_date")
            .in_("close_id", chunk)
            .execute()
        )
        for l in leads.data or []:
            opt_in_by_lead[l["close_id"]] = l.get("latest_opt_in_date")

    revival: list[str] = []
    for call_id, lead_id in lead_by_call.items():
        opt_in = opt_in_by_lead.get(lead_id)
        if opt_in and str(opt_in)[:10] < REVIVAL_HORIZON:
            revival.append(call_id)
    return sorted(revival)


def _chunks(items: list, n: int):
    for i in range(0, len(items), n):
        yield items[i : i + n]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--smoke", action="store_true", help="Re-review exactly one revival call.")
    group.add_argument("--apply", action="store_true", help="Re-review every revival call.")
    args = parser.parse_args()

    db = get_client()
    targets = _find_revival_reviews(db)
    logger.info("rereview.discovered revival_count=%d horizon=%s", len(targets), REVIVAL_HORIZON)
    if not targets:
        logger.info("rereview.nothing_to_do")
        return 0

    if not args.smoke and not args.apply:
        logger.info("rereview.dry_run — re-run with --smoke or --apply.")
        for cid in targets[:10]:
            logger.info("  would re-review %s", cid)
        if len(targets) > 10:
            logger.info("  ... and %d more", len(targets) - 10)
        return 0

    target = targets[:1] if args.smoke else targets
    logger.info("rereview.starting target=%d", len(target))

    succeeded = 0
    failed: list[tuple[str, str]] = []
    total_cost = 0.0
    t0 = time.time()
    for i, cid in enumerate(target, start=1):
        try:
            # force=True re-grades an existing row; post_to_slack=False so a
            # re-grade never re-notifies the channel.
            row = review_call(cid, force=True, post_to_slack=False)
            cost = float(row.get("sonnet_cost_usd") or 0)
            total_cost += cost
            logger.info(
                "rereview.ok [%d/%d] close_id=%s call_type=%s score=%s closed=%s cost=$%.4f",
                i, len(target), cid, row.get("call_type"), row.get("lead_score"),
                row.get("closed"), cost,
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
