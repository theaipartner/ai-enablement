"""Meta ad-spend ingestion orchestrator.

Pipeline: fetch the Sheet's first tab → parse to row dicts → upsert
into `meta_ad_daily` keyed on `day`. Idempotent; re-running is a
no-op-equivalent.

Used by both the daily cron (`api/meta_sheet_sync_cron.py`) and any
ad-hoc backfill (the Sheet IS the history, so one pull loads
everything currently in it — same code path, no separate backfill
script).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from ingestion.meta.parser import parse_sheet_values
from ingestion.meta.sheets_client import (
    SheetsAPIError,
    fetch_first_tab_title,
    fetch_values,
)

logger = logging.getLogger("ai_enablement.meta.pipeline")

# Source-of-truth Sheet id (Cortana → Meta ads). Hardcoded rather than
# an env var because (a) it's stable, (b) it's not a secret (anyone
# with the OAuth scope + share access can read it), (c) env-var sprawl
# has bitten this repo before. If the source ever splits across
# multiple Sheets, parametrize then.
SHEET_ID = "1XX6MV7dqAsjlWOiwkuKe9d1uWc1qFR4Dt1CfCVfK8d4"


@dataclass
class SyncOutcome:
    """Per-tick summary; serialized into the cron's audit row + HTTP response."""

    rows_parsed: int = 0
    rows_upserted: int = 0
    rows_failed: int = 0
    days_covered: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def sync_meta_ad_daily(
    db,
    access_token: str,
    *,
    spreadsheet_id: str = SHEET_ID,
) -> SyncOutcome:
    """One full pull: fetch sheet, parse, upsert. Returns SyncOutcome.

    `access_token` is a live Google OAuth bearer with the sheets scope;
    caller (the cron) gets it from `shared.google_oauth.get_valid_access_token`.
    """
    outcome = SyncOutcome()

    try:
        tab = fetch_first_tab_title(spreadsheet_id, access_token)
    except SheetsAPIError as exc:
        outcome.errors.append(f"discover_tab_title: {exc}")
        return outcome

    try:
        # A:J covers all 10 columns the spec listed. Reading the entire
        # column range catches every row Cortana has written (the Sheet
        # IS the history — no separate backfill API).
        values = fetch_values(spreadsheet_id, access_token, f"{tab}!A:J")
    except SheetsAPIError as exc:
        outcome.errors.append(f"fetch_values: {exc}")
        return outcome

    rows, warnings = parse_sheet_values(values)
    outcome.rows_parsed = len(rows)
    outcome.warnings.extend(warnings)

    for row in rows:
        try:
            db.table("meta_ad_daily").upsert(row, on_conflict="day").execute()
            outcome.rows_upserted += 1
            outcome.days_covered.append(row["day"])
        except Exception as exc:
            outcome.rows_failed += 1
            outcome.errors.append(f"upsert day={row.get('day')}: {exc}")

    if outcome.days_covered:
        outcome.days_covered.sort()
        logger.info(
            "meta_ad_daily sync: parsed=%d upserted=%d failed=%d days=%s..%s",
            outcome.rows_parsed,
            outcome.rows_upserted,
            outcome.rows_failed,
            outcome.days_covered[0],
            outcome.days_covered[-1],
        )
    return outcome
