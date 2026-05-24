"""Unit tests for ingestion.meta.pipeline.

Pipeline is a thin orchestrator — most logic lives in the parser
(tested separately) and the sheets_client (HTTP, exercised live
during build). Tests here focus on the orchestration: error
propagation, upsert dispatch, outcome accounting.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from ingestion.meta.pipeline import SyncOutcome, sync_meta_ad_daily
from ingestion.meta.sheets_client import SheetsAPIError


_LIVE_HEADER = [
    "Day", "Frequency", "Amount Spent", "Impressions", "Clicks (All)",
    "Link Clicks", "Unique Link Clicks", "CPM (Cost per 1,000 Impressions)",
    "Cost per Unique Link Click", "CTR (Link Click-Through Rate)",
]


@pytest.fixture
def mock_db():
    db = MagicMock()
    db.table.return_value.upsert.return_value.execute.return_value = MagicMock(data=[])
    return db


def test_sync_happy_path(mock_db):
    sheet_values = [
        _LIVE_HEADER,
        ["2026-05-23", "1.16", "450.9", "6088", "183", "105", "102", "74.06", "4.42", "1899-12-31"],
        ["2026-05-22", "1.20", "500.0", "7000", "200", "120", "115", "71.43", "4.17", "1899-12-31"],
    ]
    with patch("ingestion.meta.pipeline.fetch_first_tab_title", return_value="Sheet1"), \
         patch("ingestion.meta.pipeline.fetch_values", return_value=sheet_values):
        outcome = sync_meta_ad_daily(mock_db, "fake-token")

    assert outcome.rows_parsed == 2
    assert outcome.rows_upserted == 2
    assert outcome.rows_failed == 0
    assert outcome.errors == []
    assert "2026-05-22" in outcome.days_covered
    assert "2026-05-23" in outcome.days_covered
    # Upsert was called once per row.
    assert mock_db.table.return_value.upsert.call_count == 2
    # Each upsert targeted the meta_ad_daily table with on_conflict=day.
    mock_db.table.assert_called_with("meta_ad_daily")


def test_sync_propagates_tab_discovery_error_via_outcome(mock_db):
    """A Sheets API error during tab discovery doesn't crash — it
    surfaces in outcome.errors and the upsert step is skipped."""
    with patch(
        "ingestion.meta.pipeline.fetch_first_tab_title",
        side_effect=SheetsAPIError("sheets api http 403 ..."),
    ):
        outcome = sync_meta_ad_daily(mock_db, "fake-token")
    assert outcome.rows_upserted == 0
    assert any("discover_tab_title" in e for e in outcome.errors)
    mock_db.table.return_value.upsert.assert_not_called()


def test_sync_propagates_fetch_values_error_via_outcome(mock_db):
    with patch("ingestion.meta.pipeline.fetch_first_tab_title", return_value="Sheet1"), \
         patch(
             "ingestion.meta.pipeline.fetch_values",
             side_effect=SheetsAPIError("sheets api http 500 ..."),
         ):
        outcome = sync_meta_ad_daily(mock_db, "fake-token")
    assert outcome.rows_upserted == 0
    assert any("fetch_values" in e for e in outcome.errors)


def test_sync_fail_soft_per_row(mock_db):
    """One bad upsert doesn't crash the whole tick — counted in
    outcome.rows_failed + outcome.errors."""
    sheet_values = [
        _LIVE_HEADER,
        ["2026-05-23", "1.16", "450.9", "6088", "183", "105", "102", "74.06", "4.42", "1899-12-31"],
        ["2026-05-22", "1.20", "500.0", "7000", "200", "120", "115", "71.43", "4.17", "1899-12-31"],
    ]
    # First upsert raises, second succeeds.
    mock_db.table.return_value.upsert.return_value.execute.side_effect = [
        Exception("db boom"),
        MagicMock(data=[]),
    ]
    with patch("ingestion.meta.pipeline.fetch_first_tab_title", return_value="Sheet1"), \
         patch("ingestion.meta.pipeline.fetch_values", return_value=sheet_values):
        outcome = sync_meta_ad_daily(mock_db, "fake-token")
    assert outcome.rows_parsed == 2
    assert outcome.rows_upserted == 1
    assert outcome.rows_failed == 1
    assert any("db boom" in e for e in outcome.errors)


def test_sync_warnings_propagate_to_outcome(mock_db):
    """Parser warnings (bad numeric, missing column, skipped row) land
    in outcome.warnings without failing the tick."""
    sheet_values = [
        _LIVE_HEADER,
        # amount_spent is junk → warning, row still ingests.
        ["2026-05-23", "1.16", "garbage", "6088", "183", "105", "102", "74.06", "4.42", "1899-12-31"],
    ]
    with patch("ingestion.meta.pipeline.fetch_first_tab_title", return_value="Sheet1"), \
         patch("ingestion.meta.pipeline.fetch_values", return_value=sheet_values):
        outcome = sync_meta_ad_daily(mock_db, "fake-token")
    assert outcome.rows_upserted == 1
    assert any("amount_spent" in w for w in outcome.warnings)


def test_sync_outcome_defaults():
    """SyncOutcome dataclass defaults are sane."""
    o = SyncOutcome()
    assert o.rows_parsed == 0
    assert o.rows_upserted == 0
    assert o.rows_failed == 0
    assert o.days_covered == []
    assert o.warnings == []
    assert o.errors == []
