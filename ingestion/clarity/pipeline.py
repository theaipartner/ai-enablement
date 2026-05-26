"""Clarity ingestion orchestrator.

Pipeline: fetch (1 API call) → parse (no API) → upsert (per-row, idempotent).

Used by both the daily cron (`api/clarity_sync_cron.py`) and the
manual wrapper (`scripts/sync_clarity.py`). Single code path; no
separate backfill (none possible — Clarity's API only returns the
last 1-3 days).

Idempotent: PK is `(snapshot_date, metric_name, url)`, ON CONFLICT
DO UPDATE. Re-pulling the same 3-day window overwrites the latest
values for each (date, metric, url) row. Clarity may refine recent-
day aggregates and last-write-wins is the desired behavior.

Snapshot-date semantics: each cron tick uses ONE snapshot_date for
the whole pull (UTC date of the tick). The data IS a "last N days
rolled up" aggregate — there's no per-day breakdown inside Clarity's
response. The (date, metric, url) row therefore represents "the
3-day-rolling aggregate as observed on snapshot_date".
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from ingestion.clarity.client import ClarityAPIError, ClarityClient
from ingestion.clarity.parser import parse_response

logger = logging.getLogger("ai_enablement.clarity.pipeline")


@dataclass
class SyncOutcome:
    """Per-tick summary; serialized into the cron's audit row + HTTP response."""

    rows_parsed: int = 0
    rows_upserted: int = 0
    rows_failed: int = 0
    metric_blocks_seen: int = 0
    snapshot_date: str | None = None
    distinct_paths: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def sync_clarity_metrics_daily(
    db,
    client: ClarityClient,
    *,
    num_of_days: int = 3,
    snapshot_date: date | None = None,
    metric_name_suffix: str = "",
) -> SyncOutcome:
    """One full sync tick: fetch → parse → upsert. Returns SyncOutcome.

    `num_of_days` defaults to 3 for the self-healing window. Re-pulls
    are safe (idempotent).

    `snapshot_date` defaults to today in **ET** (America/New_York).
    Clarity itself returns aggregates in the caller's timezone (Vercel
    runs us-east-1 → ET) and the dashboard renders ET-anchored dates,
    so stamping snapshot_date in ET keeps the label aligned with what
    the data actually represents. Override for tests or historical
    synthesis.

    `metric_name_suffix` is appended to every metric_name on parsed
    rows. Use ``""`` (default) for the canonical rolling-3 snapshot
    (so Traffic, EngagementTime, etc. land under their bare names
    for backward compat); pass ``"_1d"`` or ``"_2d"`` to capture
    the numOfDays=1 / numOfDays=2 variants as sibling rows.
    """
    if snapshot_date is None:
        snapshot_date = datetime.now(ZoneInfo("America/New_York")).date()

    outcome = SyncOutcome(snapshot_date=snapshot_date.isoformat())

    try:
        metric_blocks = client.fetch_url_segmented(num_of_days=num_of_days)
    except ClarityAPIError as exc:
        outcome.errors.append(f"fetch_url_segmented: {exc}")
        logger.warning("clarity.sync: fetch failed — %s", exc)
        return outcome

    outcome.metric_blocks_seen = len(metric_blocks)

    rows, warnings = parse_response(metric_blocks, snapshot_date, metric_name_suffix)
    outcome.rows_parsed = len(rows)
    outcome.warnings.extend(warnings)

    # Batch upsert. The Supabase Python client wraps PostgREST which
    # accepts an array body — single API call inserts/updates all rows.
    # Why batched and not per-row: empirically the per-row loop hits
    # HTTP/2 ConnectionTerminated after ~96 sequential calls against
    # the pooler (httpx underlying transport drops streams when the
    # server is rate-limit-shedding). Batched is also dramatically
    # faster (one round-trip vs N).
    if rows:
        try:
            db.table("clarity_metrics_daily").upsert(
                rows,
                on_conflict="snapshot_date,metric_name,url",
            ).execute()
            outcome.rows_upserted = len(rows)
        except Exception as exc:
            outcome.rows_failed = len(rows)
            outcome.errors.append(
                f"batch upsert ({len(rows)} rows): {exc}"
            )

    # Distinct paths (sorted) — surfaces in the cron audit + smoke
    # output so Drake can spot a missing canonical path immediately.
    outcome.distinct_paths = sorted({r["url_path"] for r in rows})

    logger.info(
        "clarity.sync: snapshot=%s blocks=%d parsed=%d upserted=%d failed=%d "
        "paths=%d warnings=%d errors=%d",
        outcome.snapshot_date,
        outcome.metric_blocks_seen,
        outcome.rows_parsed,
        outcome.rows_upserted,
        outcome.rows_failed,
        len(outcome.distinct_paths),
        len(outcome.warnings),
        len(outcome.errors),
    )
    return outcome
