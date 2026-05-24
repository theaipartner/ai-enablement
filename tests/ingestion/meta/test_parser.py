"""Unit tests for ingestion.meta.parser.

The parser is the load-bearing layer — it handles the Sheet's broken
CTR column + Cortana's duplicate-day restatements + defensive numeric
parsing. Tests use the EXACT header set + sample rows from the live
Sheet (read 2026-05-23) so a future Cortana export drift breaks
loudly.
"""

from __future__ import annotations

import pytest

from ingestion.meta.parser import (
    HEADER_TO_COLUMN,
    _derive_ctr,
    parse_sheet_values,
)


# Exact header order observed in the live Sheet 2026-05-23.
LIVE_HEADER = [
    "Day",
    "Frequency",
    "Amount Spent",
    "Impressions",
    "Clicks (All)",
    "Link Clicks",
    "Unique Link Clicks",
    "CPM (Cost per 1,000 Impressions)",
    "Cost per Unique Link Click",
    "CTR (Link Click-Through Rate)",
]


# ---------------------------------------------------------------------------
# Happy path against live-shape data
# ---------------------------------------------------------------------------


def test_parse_live_shape_single_row():
    """Verbatim row from the live Sheet on 2026-05-23."""
    values = [
        LIVE_HEADER,
        ["2026-05-23", "1.16", "450.9", "6088", "183", "105", "102", "74.06", "4.42", "1899-12-31"],
    ]
    rows, warnings = parse_sheet_values(values)
    assert warnings == []
    assert len(rows) == 1
    row = rows[0]
    assert row["day"] == "2026-05-23"
    assert row["frequency"] == 1.16
    assert row["amount_spent"] == 450.9
    assert row["impressions"] == 6088
    assert row["clicks_all"] == 183
    assert row["link_clicks"] == 105
    assert row["unique_link_clicks"] == 102
    assert row["cpm"] == 74.06
    assert row["cost_per_unique_link_click"] == 4.42
    # CTR derived = 105 / 6088 * 100 ≈ 1.7247...
    assert row["ctr"] == pytest.approx(1.7247, abs=1e-3)
    # Broken Sheet value preserved verbatim:
    assert row["ctr_source_raw"] == "1899-12-31"


def test_parse_multiple_rows_preserves_order_and_derives_ctr_per_row():
    values = [
        LIVE_HEADER,
        ["2026-05-23", "1.16", "450.9", "6088", "183", "105", "102", "74.06", "4.42", "1899-12-31"],
        ["2026-05-02", "1.26", "1632.6", "27328", "781", "471", "425", "59.74", "3.84", "1899-12-31"],
    ]
    rows, warnings = parse_sheet_values(values)
    assert warnings == []
    assert len(rows) == 2
    assert rows[0]["day"] == "2026-05-23"
    assert rows[1]["day"] == "2026-05-02"
    assert rows[0]["ctr"] == pytest.approx(105 / 6088 * 100, abs=1e-3)
    assert rows[1]["ctr"] == pytest.approx(471 / 27328 * 100, abs=1e-3)


# ---------------------------------------------------------------------------
# CTR derivation edge cases
# ---------------------------------------------------------------------------


def test_derive_ctr_normal():
    assert _derive_ctr(100, 5000) == 2.0


def test_derive_ctr_zero_impressions_returns_none():
    """Division-by-zero guard. Empty ad days happen."""
    assert _derive_ctr(0, 0) is None
    assert _derive_ctr(5, 0) is None  # impressions=0 even with clicks


def test_derive_ctr_missing_inputs_returns_none():
    assert _derive_ctr(None, 100) is None
    assert _derive_ctr(50, None) is None
    assert _derive_ctr(None, None) is None


# ---------------------------------------------------------------------------
# Defensive numeric parsing
# ---------------------------------------------------------------------------


def test_parse_strips_dollar_signs_and_commas():
    """Sample data was clean but Cortana exports can drift; if a day
    comes through as `$1,632.60` we should still parse it."""
    values = [
        LIVE_HEADER,
        ["2026-05-02", "1.26", "$1,632.60", "27,328", "781", "471", "425", "59.74", "3.84", "1899-12-31"],
    ]
    rows, warnings = parse_sheet_values(values)
    assert rows[0]["amount_spent"] == 1632.60
    assert rows[0]["impressions"] == 27328


def test_parse_empty_numeric_cell_becomes_none():
    """A blank cell (e.g. Cortana hasn't written today's value yet) →
    NULL in DB, not 0 (which would silently corrupt aggregates)."""
    values = [
        LIVE_HEADER,
        ["2026-05-23", "", "", "", "", "", "", "", "", ""],
    ]
    rows, warnings = parse_sheet_values(values)
    assert len(rows) == 1
    assert rows[0]["day"] == "2026-05-23"
    assert rows[0]["frequency"] is None
    assert rows[0]["amount_spent"] is None
    assert rows[0]["impressions"] is None
    # CTR derivation guard: impressions=None → ctr=None, no crash.
    assert rows[0]["ctr"] is None


def test_parse_non_numeric_junk_logs_warning_and_leaves_null():
    values = [
        LIVE_HEADER,
        ["2026-05-23", "1.16", "not-a-number", "6088", "183", "105", "102", "74.06", "4.42", "1899-12-31"],
    ]
    rows, warnings = parse_sheet_values(values)
    assert rows[0]["amount_spent"] is None
    # CTR still derived because link_clicks + impressions parsed cleanly.
    assert rows[0]["ctr"] == pytest.approx(105 / 6088 * 100, abs=1e-3)
    assert any("amount_spent" in w for w in warnings)


# ---------------------------------------------------------------------------
# Header-name keying (not positional)
# ---------------------------------------------------------------------------


def test_columns_reordered_still_parse_correctly():
    """If Cortana swaps two columns in a future export, header-name
    keying should keep us correct."""
    reordered_header = [
        "Impressions", "Day", "Frequency", "Amount Spent", "Clicks (All)",
        "Link Clicks", "Unique Link Clicks", "CPM (Cost per 1,000 Impressions)",
        "Cost per Unique Link Click", "CTR (Link Click-Through Rate)",
    ]
    # Day moved to column index 1; Impressions to 0.
    values = [
        reordered_header,
        ["6088", "2026-05-23", "1.16", "450.9", "183", "105", "102", "74.06", "4.42", "1899-12-31"],
    ]
    rows, warnings = parse_sheet_values(values)
    assert rows[0]["day"] == "2026-05-23"
    assert rows[0]["impressions"] == 6088


def test_missing_header_column_produces_warning_but_doesnt_crash():
    """If Cortana drops a column we expected, that column comes out
    NULL on every row + we log a warning."""
    header_minus_frequency = [h for h in LIVE_HEADER if h != "Frequency"]
    values = [
        header_minus_frequency,
        ["2026-05-23", "450.9", "6088", "183", "105", "102", "74.06", "4.42", "1899-12-31"],
    ]
    rows, warnings = parse_sheet_values(values)
    assert len(rows) == 1
    assert "frequency" not in rows[0] or rows[0].get("frequency") is None
    assert any("Frequency" in w for w in warnings)


def test_unknown_extra_column_is_silently_dropped():
    """If Cortana adds a new column we don't map, we drop it without
    error (additive — not a parse failure)."""
    header_plus_unknown = LIVE_HEADER + ["Something New"]
    values = [
        header_plus_unknown,
        ["2026-05-23", "1.16", "450.9", "6088", "183", "105", "102", "74.06", "4.42", "1899-12-31", "ignored"],
    ]
    rows, warnings = parse_sheet_values(values)
    assert len(rows) == 1
    assert rows[0]["day"] == "2026-05-23"
    # No warnings about Something New — it just isn't mapped.
    assert not any("Something New" in w for w in warnings)


# ---------------------------------------------------------------------------
# Day-parse + skip behavior
# ---------------------------------------------------------------------------


def test_row_with_invalid_day_is_skipped_with_warning():
    """Header-echo or trailing-blank rows shouldn't poison the upsert."""
    values = [
        LIVE_HEADER,
        ["not-a-date", "1.16", "450.9", "6088", "183", "105", "102", "74.06", "4.42", "1899-12-31"],
        ["2026-05-23", "1.16", "450.9", "6088", "183", "105", "102", "74.06", "4.42", "1899-12-31"],
    ]
    rows, warnings = parse_sheet_values(values)
    assert len(rows) == 1  # bad row dropped
    assert rows[0]["day"] == "2026-05-23"
    assert any("Day" in w for w in warnings)


def test_empty_row_skipped_silently():
    values = [
        LIVE_HEADER,
        [],
        ["2026-05-23", "1.16", "450.9", "6088", "183", "105", "102", "74.06", "4.42", "1899-12-31"],
    ]
    rows, warnings = parse_sheet_values(values)
    assert len(rows) == 1


def test_short_row_right_padded_handles_trailing_blank_cell():
    """Sheets API trims trailing empty cells. A row missing only the
    CTR column should still parse, with ctr_source_raw=None."""
    values = [
        LIVE_HEADER,
        ["2026-05-23", "1.16", "450.9", "6088", "183", "105", "102", "74.06", "4.42"],
    ]
    rows, warnings = parse_sheet_values(values)
    assert len(rows) == 1
    assert rows[0]["day"] == "2026-05-23"
    assert rows[0]["ctr_source_raw"] is None


# ---------------------------------------------------------------------------
# Empty-sheet edge case
# ---------------------------------------------------------------------------


def test_empty_values_returns_zero_rows_with_warning():
    rows, warnings = parse_sheet_values([])
    assert rows == []
    assert warnings == ["sheet returned zero rows (not even header)"]


# ---------------------------------------------------------------------------
# HEADER_TO_COLUMN map sanity
# ---------------------------------------------------------------------------


def test_header_map_includes_every_live_column():
    """The 2026-05-23 live header should fully map. If a column is
    missing from HEADER_TO_COLUMN, that's the deliberate
    `data not mirrored` choice; if it's missing AND we want it,
    add an entry + a migration column."""
    for h in LIVE_HEADER:
        assert h in HEADER_TO_COLUMN, f"live header {h!r} not in HEADER_TO_COLUMN"


def test_ctr_source_column_routes_to_raw_not_to_derived_ctr():
    """Critical: the Sheet's CTR column must NOT land in `ctr` (which
    is the derived numeric); it lands in `ctr_source_raw` (forensic)."""
    assert HEADER_TO_COLUMN["CTR (Link Click-Through Rate)"] == "ctr_source_raw"
    # Sanity: 'ctr' itself is never a source-mapped column.
    assert "ctr" not in HEADER_TO_COLUMN.values()
