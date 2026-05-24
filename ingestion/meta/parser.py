"""Parse a Sheet values array into typed `meta_ad_daily` row dicts.

Design rules (per spec + observed Sheet shape on 2026-05-23):

  - **Header-name-keyed**, not positional. The first row of the values
    array IS the header; map column NAMES → column indices so a future
    Cortana export tweak (column re-order, column added) doesn't
    silently break parsing.

  - **CTR is DERIVED.** The Sheet's "CTR (Link Click-Through Rate)"
    column is broken (formats as date serial "1899-12-31"). We compute
    `ctr = link_clicks / impressions * 100` and store the broken raw
    string in `ctr_source_raw` for forensic transparency.

  - **Defensive numeric parsing.** Sample data was clean but Cortana
    exports can drift — strip currency markers ($) and thousand
    separators (,) before float-casting. Empty strings / None →
    None (NULL in DB). Non-numeric junk → None + log warning (don't
    crash; one bad day shouldn't take down the cron).

  - **Day parse**: ISO date string (YYYY-MM-DD per the Sheet). Invalid
    → row skipped (with a warning) so a header-row-as-data or empty
    row at the bottom doesn't poison the upsert.

  - **Unknown columns are tolerated**, not errors. Columns in the
    header that don't map to a `meta_ad_daily` field are dropped
    silently; columns we expect but don't find come out as None.
"""

from __future__ import annotations

import logging
import re
from datetime import date as date_type
from typing import Any

logger = logging.getLogger("ai_enablement.meta.parser")

# Sheet header text → `meta_ad_daily` column name. Source of truth for
# what we mirror; add a header here to start mirroring it (also requires
# a migration to add the DB column).
HEADER_TO_COLUMN: dict[str, str] = {
    "Day": "day",
    "Frequency": "frequency",
    "Amount Spent": "amount_spent",
    "Impressions": "impressions",
    "Clicks (All)": "clicks_all",
    "Link Clicks": "link_clicks",
    "Unique Link Clicks": "unique_link_clicks",
    "CPM (Cost per 1,000 Impressions)": "cpm",
    "Cost per Unique Link Click": "cost_per_unique_link_click",
    # The Sheet's CTR column is broken — we don't map it to the `ctr`
    # column (which is derived). Instead capture the raw broken value
    # in `ctr_source_raw` for forensics.
    "CTR (Link Click-Through Rate)": "ctr_source_raw",
}

# Columns that get int(...) coercion rather than float(...). All other
# numeric columns coerce to float.
_INTEGER_COLUMNS = frozenset({"impressions", "clicks_all", "link_clicks", "unique_link_clicks"})

# Columns that stay as raw text (no numeric coercion). The day is a
# date (separate parse); ctr_source_raw is captured verbatim.
_TEXT_COLUMNS = frozenset({"day", "ctr_source_raw"})


def parse_sheet_values(
    values: list[list[str]],
) -> tuple[list[dict[str, Any]], list[str]]:
    """Project the Sheet's row-array shape into a list of `meta_ad_daily`
    row dicts ready for upsert.

    Returns `(rows, warnings)`. Warnings is a list of human-readable
    strings collected during parsing — appended to the cron's audit
    payload but NOT raised; one bad row doesn't crash the pull.
    """
    warnings: list[str] = []

    if not values:
        return [], ["sheet returned zero rows (not even header)"]

    header = values[0]
    column_index: dict[str, int] = {}
    for sheet_header, column_name in HEADER_TO_COLUMN.items():
        try:
            column_index[column_name] = header.index(sheet_header)
        except ValueError:
            warnings.append(
                f"header {sheet_header!r} not found in sheet — column {column_name!r} will be NULL on every row"
            )

    rows: list[dict[str, Any]] = []
    for i, raw_row in enumerate(values[1:], start=1):
        if not raw_row:
            continue
        # Right-pad short rows so index lookups don't IndexError. The
        # Sheets API trims trailing empty cells; a row where the last
        # column was blank comes back shorter than the header.
        padded = list(raw_row) + [""] * max(0, len(header) - len(raw_row))

        row: dict[str, Any] = {}
        for col_name, idx in column_index.items():
            raw_val = padded[idx] if idx < len(padded) else ""
            row[col_name] = _coerce(col_name, raw_val, warnings, row_index=i)

        # Skip rows where Day didn't parse (header echo, blank row at
        # bottom, malformed date string).
        if not row.get("day"):
            warnings.append(
                f"row {i}: Day value {padded[column_index.get('day', 0)]!r} did not parse as date — row skipped"
            )
            continue

        # Derive CTR from link_clicks + impressions. Stored separately
        # in 'ctr' column; the Sheet's raw broken CTR is in 'ctr_source_raw'.
        row["ctr"] = _derive_ctr(
            row.get("link_clicks"), row.get("impressions"),
        )

        rows.append(row)

    return rows, warnings


def _coerce(
    col_name: str,
    raw_val: Any,
    warnings: list[str],
    *,
    row_index: int,
) -> Any:
    """Project one raw cell value to its typed form for the column.

    Day → ISO date string (Sheet values are already 'YYYY-MM-DD'; we
    keep the string and let psycopg2/supabase serialize to date).
    Integer columns → int or None. Float columns → float or None.
    Text columns → str (as-is).
    """
    if raw_val is None:
        return None
    if isinstance(raw_val, str) and raw_val.strip() == "":
        return None

    if col_name == "day":
        # Validate as a real date so a header echo or junk row gets
        # caught here. We re-emit the ISO string for consistency.
        s = str(raw_val).strip()
        try:
            return date_type.fromisoformat(s).isoformat()
        except ValueError:
            return None

    if col_name in _TEXT_COLUMNS:
        return str(raw_val)

    # Numeric. Strip currency markers + thousand separators defensively.
    cleaned = re.sub(r"[$,]", "", str(raw_val)).strip()
    if not cleaned:
        return None

    try:
        if col_name in _INTEGER_COLUMNS:
            # int() doesn't accept "12.0"; round-trip through float first.
            return int(float(cleaned))
        return float(cleaned)
    except (ValueError, TypeError):
        warnings.append(
            f"row {row_index}: column {col_name!r} value {raw_val!r} not parseable as number — left NULL"
        )
        return None


def _derive_ctr(link_clicks: int | None, impressions: int | None) -> float | None:
    """CTR = link_clicks / impressions * 100, as a percentage.

    Returns None when either input is missing OR impressions is 0
    (division-by-zero).
    """
    if link_clicks is None or impressions is None or impressions == 0:
        return None
    return (link_clicks / impressions) * 100.0
