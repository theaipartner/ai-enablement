"""Parse the Clarity response array → list of row dicts ready for upsert.

Input shape (from `ClarityClient.fetch_url_segmented`):

    [
      {"metricName": "Traffic",        "information": [{...row}, ...]},
      {"metricName": "EngagementTime", "information": [{...row}, ...]},
      ... 9 metric blocks total ...
    ]

Each `information` row carries metric-specific fields (Traffic has
totalSessionCount/distinctUserCount/etc; EngagementTime has
totalTime/activeTime; the 6 quality blocks have a single
same-as-metricName count field) PLUS the `Url` dimension value.

This parser flattens to one row per (snapshot_date, metric_name, url):

    {
      "snapshot_date": "2026-05-24",
      "metric_name":   "Traffic",
      "url":           "https://...?utm=...",  # raw; '__total__' if Url was null
      "url_path":      "/lp",                   # derived; '__total__' for sentinel
      "total_session_count":           15,
      "total_bot_session_count":        0,
      "distinct_user_count":           18,
      "pages_per_session_percentage": 1.0,
      "total_time":  None,
      "active_time": None,
      "raw":         {...full row dict...},
    }

The hot typed columns (Traffic + EngagementTime fields) are populated
when the source metric exposes them; otherwise NULL. The full row dict
goes into `raw` regardless of metric_name so the 6 quality blocks
have a non-NULL data column.

Snapshot date: the API gives no per-row date, so the caller (cron)
passes the snapshot_date for the whole pull. Clarity's response is
"last N days aggregated" — there's no per-day breakdown inside the
response. Each cron tick records ONE snapshot per metric per URL;
re-pulls within the same day cleanly overwrite via the PK.
"""

from __future__ import annotations

import logging
from datetime import date
from typing import Any
from urllib.parse import urlparse

from ingestion.clarity import TOTAL_SENTINEL

logger = logging.getLogger("ai_enablement.clarity.parser")


# String→int casts: Clarity ships count fields as strings ("15"). The
# numeric percentage field arrives as a number already. Defensive: if
# a field is missing or non-numeric, store None and let aggregation
# treat it as no-data.
def _to_int(v: Any) -> int | None:
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _to_numeric(v: Any) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _derive_url_and_path(raw_url: Any) -> tuple[str, str]:
    """Returns (url, url_path). Null URL → both become TOTAL_SENTINEL.
    Empty-string URL is treated as null (defensive; shouldn't occur in
    practice but the API contract doesn't promise it won't)."""
    if raw_url is None or (isinstance(raw_url, str) and raw_url == ""):
        return TOTAL_SENTINEL, TOTAL_SENTINEL
    url = str(raw_url)
    try:
        path = urlparse(url).path or "/"
    except Exception:
        # Defensive — urlparse is very forgiving but if it ever raised,
        # store something queryable rather than crashing the whole row.
        path = "<unparseable>"
    return url, path


def parse_response(
    metric_blocks: list[dict[str, Any]],
    snapshot_date: date,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Flatten the Clarity metric-block array into per-row upsert dicts.

    Returns (rows, warnings). Warnings are non-fatal observations
    (block missing metricName, row missing Url field, dropped rows
    that couldn't yield a useful dedup key, etc.).

    The (snapshot_date, metric_name, url) tuple is the natural key and
    the parser deduplicates within a single response — if the API
    returns two rows with the same (metric, url) tuple in one block
    (shouldn't happen but defensive), the last one wins with a warning.
    """
    rows: list[dict[str, Any]] = []
    warnings: list[str] = []
    seen_keys: set[tuple[str, str]] = set()

    if not isinstance(metric_blocks, list):
        warnings.append(
            f"top-level body is not a list "
            f"(got {type(metric_blocks).__name__}); nothing to parse"
        )
        return rows, warnings

    for block_idx, block in enumerate(metric_blocks):
        if not isinstance(block, dict):
            warnings.append(
                f"block[{block_idx}] is not a dict (got "
                f"{type(block).__name__}); skipping"
            )
            continue

        metric_name = block.get("metricName")
        if not metric_name or not isinstance(metric_name, str):
            warnings.append(
                f"block[{block_idx}] missing metricName; skipping"
            )
            continue

        information = block.get("information")
        if not isinstance(information, list):
            warnings.append(
                f"block[{block_idx}] (metric={metric_name!r}) has no "
                f"information list; skipping"
            )
            continue

        for row_idx, row in enumerate(information):
            if not isinstance(row, dict):
                warnings.append(
                    f"block[{block_idx}].information[{row_idx}] "
                    f"(metric={metric_name!r}) is not a dict; skipping"
                )
                continue

            # Url field on rows is `Url` (capital U, lowercase rl) per
            # discovery — accept a few capitalizations defensively in
            # case Clarity ever shifts.
            raw_url: Any = None
            for cand in ("Url", "URL", "url"):
                if cand in row:
                    raw_url = row[cand]
                    break
            url_value, url_path = _derive_url_and_path(raw_url)

            key = (metric_name, url_value)
            if key in seen_keys:
                warnings.append(
                    f"duplicate (metric={metric_name!r}, url={url_value[:60]!r}) "
                    f"within one response; last-wins"
                )
            seen_keys.add(key)

            parsed = {
                "snapshot_date": snapshot_date.isoformat(),
                "metric_name": metric_name,
                "url": url_value,
                "url_path": url_path,
                "total_session_count": _to_int(row.get("totalSessionCount")),
                "total_bot_session_count": _to_int(
                    row.get("totalBotSessionCount")
                ),
                "distinct_user_count": _to_int(row.get("distinctUserCount")),
                "pages_per_session_percentage": _to_numeric(
                    row.get("pagesPerSessionPercentage")
                ),
                "total_time": _to_int(row.get("totalTime")),
                "active_time": _to_int(row.get("activeTime")),
                "raw": row,
            }
            rows.append(parsed)

    logger.info(
        "clarity.parse_response: %d metric blocks → %d rows, %d warnings",
        len(metric_blocks), len(rows), len(warnings),
    )
    return rows, warnings
