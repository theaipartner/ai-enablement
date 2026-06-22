"""One-shot backfill: generate call_review documents for May 2026 calls.

Selects every May 2026 client call with a non-empty transcript that
hasn't been reviewed yet, runs `agents.call_reviewer.reviewer.review_call`
on each, persists via `agents.call_reviewer.persistence.upsert_call_review`.

This is a ONE-SHOT script for the V1 quick-ship. Going forward, V2
will wire review generation into the Fathom ingestion pipeline so it
runs automatically per-call. If you need this script again (e.g.
after prompt iteration), the cleanest path is:

  -- delete existing reviews for the affected window
  delete from documents
   where source = 'fathom'
     and document_type = 'call_review'
     and metadata->>'started_at' >= '2026-05-01'
     and metadata->>'started_at' <  '2026-06-01';

  # then re-run --apply
  .venv/bin/python scripts/backfill_call_reviews.py --apply

Idempotent: re-runs with the same window skip already-reviewed calls
(filtered upstream via a documents table lookup), so a retry after
partial failure picks up exactly the calls that didn't land.

Usage:
    .venv/bin/python scripts/backfill_call_reviews.py            # dry-run
    .venv/bin/python scripts/backfill_call_reviews.py --smoke    # 1 call end-to-end
    .venv/bin/python scripts/backfill_call_reviews.py --apply
    .venv/bin/python scripts/backfill_call_reviews.py --apply --limit 3

Default mode is dry-run — prints the candidate count + the first 5
call titles, makes ZERO Claude API calls. --smoke processes exactly
one call end-to-end (fetch → Claude → parse → write document → cost
summary) so real-API surface bugs surface BEFORE a bulk run; see
CLAUDE.md § Working Norms § "Operational patterns Director is strict
about" for the working norm. --apply fires the real bulk work. --limit N caps
the number of calls processed (after the already-reviewed filter).

Env vars (loaded from .env.local):
  ANTHROPIC_API_KEY            — Claude
  SUPABASE_URL                 — db
  SUPABASE_SERVICE_ROLE_KEY    — db
"""

from __future__ import annotations

import argparse
import sys
from decimal import Decimal
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(_REPO / ".env.local")

from shared.db import get_client  # noqa: E402
from agents.call_reviewer.prompt import PROMPT_VERSION  # noqa: E402
from agents.call_reviewer.reviewer import review_call  # noqa: E402
from agents.call_reviewer.persistence import upsert_call_review  # noqa: E402


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Window. Inclusive lower, exclusive upper — matches the
# `started_at >= '2026-05-01' AND started_at < '2026-06-01'` SQL idiom.
WINDOW_START = "2026-05-01T00:00:00+00:00"
WINDOW_END = "2026-06-01T00:00:00+00:00"

MODEL = "claude-sonnet-4-6"


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------


class Report:
    def __init__(self) -> None:
        self.candidates_considered = 0
        self.already_reviewed_skipped = 0
        self.reviewed_success: list[tuple[str, str]] = []  # (call_id, title)
        self.failed: list[tuple[str, str, str]] = []  # (call_id, title, error)
        self.total_cost_usd: Decimal = Decimal("0")
        self.total_input_tokens = 0
        self.total_output_tokens = 0

    def print_summary(self, mode: str) -> None:
        print()
        print("=" * 72)
        print(f"Backfill report ({mode})")
        print("=" * 72)
        print(f"Total May 2026 client-call candidates:    {self.candidates_considered}")
        print(f"Already reviewed (skipped):                {self.already_reviewed_skipped}")
        print(f"Reviewed successfully:                     {len(self.reviewed_success)}")
        print(f"Failed:                                    {len(self.failed)}")
        print()
        if self.reviewed_success:
            print(f"Total input tokens:                        {self.total_input_tokens:,}")
            print(f"Total output tokens:                       {self.total_output_tokens:,}")
            print(f"Total LLM cost (USD):                      ${self.total_cost_usd:.4f}")
            print()
        if self.failed:
            print("Failed calls:")
            for call_id, title, err in self.failed:
                print(f"  {call_id}  {title!r}")
                print(f"    error: {err[:200]}")
            print()


# ---------------------------------------------------------------------------
# DB queries
# ---------------------------------------------------------------------------


def fetch_candidate_calls(db) -> list[dict]:
    """Pull every May 2026 client call with a non-null transcript.

    The `length(transcript) > 0` predicate is enforced JS-side after
    the fetch — PostgREST doesn't expose a length filter directly and
    the read volume is small enough that a Python filter is fine.
    """
    resp = (
        db.table("calls")
        .select(
            "id, external_id, title, started_at, primary_client_id, "
            "call_category, transcript"
        )
        .eq("call_category", "client")
        .not_.is_("primary_client_id", None)
        .not_.is_("transcript", None)
        .gte("started_at", WINDOW_START)
        .lt("started_at", WINDOW_END)
        .order("started_at", desc=False)
        .execute()
    )
    rows = resp.data or []
    # JS-side empty-string filter (PostgREST `length` not exposed).
    return [r for r in rows if (r.get("transcript") or "").strip()]


def fetch_already_reviewed_external_ids(db) -> set[str]:
    """Return the set of calls.external_id values that already have a
    `call_review` documents row.

    Volume note: at most ~hundreds of rows; pulls in a single round
    trip with no pagination. If we ever push past the PostgREST
    default page size, switch to .range() pagination.
    """
    resp = (
        db.table("documents")
        .select("external_id")
        .eq("source", "fathom")
        .eq("document_type", "call_review")
        .execute()
    )
    rows = resp.data or []
    return {r["external_id"] for r in rows if r.get("external_id")}


# ---------------------------------------------------------------------------
# Per-call work
# ---------------------------------------------------------------------------


def review_and_persist(db, call: dict) -> None:
    """Review one call, write the documents row."""
    review = review_call(db, call["id"], model=MODEL)
    upsert_call_review(
        db,
        call["id"],
        review,
        call_external_id=call["external_id"],
        primary_client_id=call["primary_client_id"],
        call_category=call["call_category"],
        started_at=call["started_at"],
        model=MODEL,
        prompt_version=PROMPT_VERSION,
        title=call.get("title"),
    )


# ---------------------------------------------------------------------------
# Cost summing — window-based
# ---------------------------------------------------------------------------


def sum_cost_for_run_window(
    db,
    *,
    started_after_iso: str,
) -> tuple[Decimal, int, int]:
    """Sum agent_runs telemetry across this script invocation.

    Filter: agent_name='call_reviewer' AND created_at >= started_after.
    The time window is sufficient because nothing else fires
    call_reviewer during a backfill run (V1: no other surface invokes
    the agent yet).
    """
    resp = (
        db.table("agent_runs")
        .select("llm_cost_usd, llm_input_tokens, llm_output_tokens")
        .eq("agent_name", "call_reviewer")
        .gte("started_at", started_after_iso)
        .execute()
    )
    rows = resp.data or []
    total_cost = Decimal("0")
    total_in = 0
    total_out = 0
    for row in rows:
        cost = row.get("llm_cost_usd")
        if cost is not None:
            total_cost += Decimal(str(cost))
        total_in += int(row.get("llm_input_tokens") or 0)
        total_out += int(row.get("llm_output_tokens") or 0)
    return total_cost, total_in, total_out


# ---------------------------------------------------------------------------
# Smoke
# ---------------------------------------------------------------------------


def _run_smoke(
    db,
    *,
    pending: list[dict],
    started_at_iso: str,
) -> int:
    """Process exactly one call end-to-end as a real-API smoke test.

    Picks the most recent unreviewed call from the candidate list
    (pending is already sorted started_at asc; -1 is most recent).
    Runs the full path: fetch → Claude → parse → write document →
    cost summary. Prints the success line and exits 0; on any
    exception, prints the full traceback and exits 1.

    The chosen call leaves a real call_review documents row behind,
    so a subsequent --apply correctly skips it (idempotent
    already-reviewed filter).
    """
    import traceback

    if not pending:
        print(
            "Smoke test skipped — every candidate already has a review row. "
            "Delete one or widen the window before --smoke."
        )
        return 0

    call = pending[-1]  # most recent
    title = call.get("title") or "(untitled)"
    print(f"Smoke: reviewing {title!r} ({call['id']}) {call['started_at'][:10]}...")

    try:
        review_and_persist(db, call)
    except Exception:
        print()
        print("Smoke test FAILED:")
        traceback.print_exc()
        return 1

    cost, in_tok, out_tok = sum_cost_for_run_window(
        db,
        started_after_iso=started_at_iso,
    )
    print()
    print(
        f"Smoke test passed — 1 call reviewed, ${cost:.4f} cost "
        f"({in_tok:,} in / {out_tok:,} out tokens). "
        f"Re-run with --apply to process all {len(pending)}."
    )
    return 0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually run reviews. Default is dry-run (count only).",
    )
    parser.add_argument(
        "--smoke",
        action="store_true",
        help=(
            "Process exactly 1 call end-to-end (most recent client call "
            "with non-empty transcript, no existing review). Real-API "
            "smoke test before any bulk --apply."
        ),
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Cap the number of calls processed (after already-reviewed filter).",
    )
    args = parser.parse_args()
    if args.smoke and args.apply:
        parser.error("--smoke and --apply are mutually exclusive")

    db = get_client()

    # Capture wall-clock start so the cost-sum query at the end can
    # filter agent_runs to this script's invocation.
    from datetime import datetime, timezone
    started_at_iso = datetime.now(timezone.utc).isoformat()

    print("=" * 72)
    print(f"Call review backfill — window {WINDOW_START} to {WINDOW_END}")
    print(f"Mode: {'APPLY' if args.apply else 'DRY-RUN'}")
    print(f"Started at: {started_at_iso}")
    if args.limit is not None:
        print(f"Limit: {args.limit}")
    print("=" * 72)

    candidates = fetch_candidate_calls(db)
    already = fetch_already_reviewed_external_ids(db)
    pending = [c for c in candidates if c["external_id"] not in already]

    report = Report()
    report.candidates_considered = len(candidates)
    report.already_reviewed_skipped = len(candidates) - len(pending)

    if args.limit is not None:
        pending = pending[: args.limit]

    print()
    print(f"Candidates total:              {len(candidates)}")
    print(f"Already reviewed (skipped):    {report.already_reviewed_skipped}")
    print(f"To review this run:            {len(pending)}")
    print()

    if args.smoke:
        return _run_smoke(
            db,
            pending=pending,
            started_at_iso=started_at_iso,
        )

    if not args.apply:
        print("First 5 titles that WOULD be reviewed (dry-run):")
        for call in pending[:5]:
            title = call.get("title") or "(untitled)"
            print(f"  {call['id']}  {call['started_at'][:10]}  {title}")
        if len(pending) > 5:
            print(f"  ... and {len(pending) - 5} more")
        print()
        print("Re-run with --smoke to verify the full path on 1 call,")
        print("then --apply to process all candidates.")
        return 0

    if not pending:
        print("Nothing to do — every candidate already has a review row.")
        return 0

    total = len(pending)
    for index, call in enumerate(pending, start=1):
        title = call.get("title") or "(untitled)"
        print(
            f"[{index}/{total}] Reviewing {title!r} "
            f"({call['id']}) {call['started_at'][:10]}..."
        )
        try:
            review_and_persist(db, call)
            report.reviewed_success.append((call["id"], title))
        except Exception as exc:
            # Per-call error isolation: log, count, continue. The agent_runs
            # row was already closed by review_call's except path, so
            # telemetry is intact.
            err = str(exc)
            print(f"  FAILED: {err[:200]}")
            report.failed.append((call["id"], title, err))

    cost, in_tok, out_tok = sum_cost_for_run_window(
        db,
        started_after_iso=started_at_iso,
    )
    report.total_cost_usd = cost
    report.total_input_tokens = in_tok
    report.total_output_tokens = out_tok

    report.print_summary(mode="APPLY")
    return 0 if not report.failed else 1


if __name__ == "__main__":
    sys.exit(main())
