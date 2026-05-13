"""One-shot backfill: classify sentiment_tier on existing call_review docs.

Iterates every `documents` row where document_type='call_review' AND
metadata.sentiment_tier IS NULL, parses the JSON content, extracts
the `sentiment_arc` field, runs the Haiku-backed
`classify_sentiment_tier`, and writes the result back into
`metadata.sentiment_tier` (merge — other metadata keys preserved).

Idempotent: the IS NULL filter means rerunning skips already-classified
rows. If Drake wants to reclassify, clear the field first:

  update documents
     set metadata = metadata - 'sentiment_tier'
   where document_type = 'call_review';

Usage:
    .venv/bin/python scripts/backfill_sentiment_tiers.py            # dry-run
    .venv/bin/python scripts/backfill_sentiment_tiers.py --smoke    # 1 row end-to-end
    .venv/bin/python scripts/backfill_sentiment_tiers.py --apply
    .venv/bin/python scripts/backfill_sentiment_tiers.py --apply --limit 5

Default mode is dry-run — prints the candidate count + the first 5
call_ids, makes ZERO Claude API calls. --smoke processes exactly one
row end-to-end so real-API surface bugs surface before a bulk run.
--apply fires the real bulk work. --limit N caps the row count.

Env vars (loaded from .env.local):
  ANTHROPIC_API_KEY            — Claude
  SUPABASE_URL                 — db
  SUPABASE_SERVICE_ROLE_KEY    — db
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(_REPO / ".env.local")

from shared.db import get_client  # noqa: E402
from agents.call_reviewer.sentiment_classifier import (  # noqa: E402
    classify_sentiment_tier,
)


def fetch_candidate_docs(db) -> list[dict]:
    """Pull every call_review row missing metadata.sentiment_tier.

    PostgREST exposes the `is.null` filter on jsonb paths via
    `metadata->>'sentiment_tier' IS NULL`. We pull id, content, and
    metadata so the per-row work can re-merge the dict locally.
    """
    resp = (
        db.table("documents")
        .select("id, content, metadata")
        .eq("document_type", "call_review")
        .is_("metadata->>sentiment_tier", None)
        .order("created_at", desc=False)
        .execute()
    )
    return resp.data or []


def classify_and_persist(db, row: dict) -> tuple[str | None, float, str | None]:
    """Classify one row and write the result.

    Returns (tier, latency_seconds, error_message).
    On parse / extraction failure: returns (None, 0.0, error) without
    calling Haiku — these rows need a writer fix, not a classification.
    """
    doc_id = row["id"]
    raw_content = row.get("content")
    if not isinstance(raw_content, str) or not raw_content.strip():
        return None, 0.0, "content empty or non-string"
    try:
        parsed = json.loads(raw_content)
    except (ValueError, TypeError) as exc:
        return None, 0.0, f"content not valid JSON: {exc}"
    if not isinstance(parsed, dict):
        return None, 0.0, "content not a JSON object"
    sentiment_arc = parsed.get("sentiment_arc")
    if not isinstance(sentiment_arc, str) or not sentiment_arc.strip():
        return None, 0.0, "sentiment_arc missing or empty"

    started = time.monotonic()
    tier = classify_sentiment_tier(sentiment_arc)
    latency = time.monotonic() - started

    existing_metadata = row.get("metadata") or {}
    merged = {**existing_metadata, "sentiment_tier": tier}
    db.table("documents").update({"metadata": merged}).eq("id", doc_id).execute()
    return tier, latency, None


def run(mode: str, limit: int | None) -> int:
    db = get_client()
    candidates = fetch_candidate_docs(db)
    if limit is not None:
        candidates = candidates[:limit]
    total = len(candidates)
    print(f"Candidates missing sentiment_tier: {total}")

    if mode == "dry-run":
        for row in candidates[:5]:
            call_id = (row.get("metadata") or {}).get("call_id", "?")
            print(f"  would classify call_id={call_id} doc_id={row['id']}")
        if total > 5:
            print(f"  ... +{total - 5} more")
        return 0

    process_n = 1 if mode == "smoke" else total
    print(f"Processing {process_n} row(s) in {mode} mode")

    tier_counts: Counter[str] = Counter()
    failures: list[tuple[str, str]] = []
    for row in candidates[:process_n]:
        call_id = (row.get("metadata") or {}).get("call_id", "?")
        tier, latency, err = classify_and_persist(db, row)
        if err is not None or tier is None:
            failures.append((row["id"], err or "unknown"))
            print(f"  FAIL doc_id={row['id']} call_id={call_id}: {err}")
            continue
        tier_counts[tier] += 1
        print(
            f"  OK   doc_id={row['id']} call_id={call_id} "
            f"tier={tier} latency={latency:.2f}s"
        )

    print()
    print("=" * 60)
    print(f"Backfill summary ({mode})")
    print("=" * 60)
    print(f"Processed:   {sum(tier_counts.values()) + len(failures)}")
    print(f"Classified:  {sum(tier_counts.values())}")
    print(f"Failures:    {len(failures)}")
    for tier in ("green", "yellow", "red"):
        print(f"  {tier}: {tier_counts.get(tier, 0)}")
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode_group = parser.add_mutually_exclusive_group()
    mode_group.add_argument(
        "--smoke", action="store_true", help="Process exactly one row end-to-end."
    )
    mode_group.add_argument(
        "--apply", action="store_true", help="Process every candidate row."
    )
    parser.add_argument(
        "--limit", type=int, default=None, help="Cap the number of rows processed."
    )
    args = parser.parse_args()

    if args.smoke:
        mode = "smoke"
    elif args.apply:
        mode = "apply"
    else:
        mode = "dry-run"
    return run(mode, args.limit)


if __name__ == "__main__":
    sys.exit(main())
