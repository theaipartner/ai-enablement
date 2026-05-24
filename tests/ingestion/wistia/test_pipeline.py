"""Unit tests for ingestion.wistia.pipeline.

Pipeline is a thin orchestrator — most logic in parser. Tests focus
on the orchestration: fail-soft per media, error propagation, outcome
accounting, rolling window math.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import MagicMock, patch

import pytest

from ingestion.wistia.client import WistiaAPIError
from ingestion.wistia.pipeline import (
    SyncOutcome,
    sync_wistia,
    sync_wistia_rolling,
)


@pytest.fixture
def mock_db():
    db = MagicMock()
    db.table.return_value.upsert.return_value.execute.return_value = MagicMock(data=[])
    return db


@pytest.fixture
def mock_client():
    c = MagicMock()
    # Default: empty inventory + empty projects
    c.iter_medias.return_value = iter([])
    c.iter_projects.return_value = iter([])
    return c


def _make_media(hid: str, name: str = "Test", duration: float = 100.0, project: dict | None = None) -> dict:
    m = {"hashed_id": hid, "name": name, "duration": duration, "type": "Video"}
    if project:
        m["project"] = project
    return m


def _make_stats(plays: int = 0, avg_pct: int = 0) -> dict:
    return {
        "hashed_id": "x",
        "stats": {
            "pageLoads": 100, "visitors": 80,
            "percentOfVisitorsClickingPlay": 10,
            "plays": plays, "averagePercentWatched": avg_pct,
        },
    }


# ---------------------------------------------------------------------------
# sync_wistia — orchestration
# ---------------------------------------------------------------------------


def test_sync_happy_path(mock_db, mock_client):
    medias = [
        _make_media("hash1", "Video 1"),
        _make_media("hash2", "Video 2"),
    ]
    mock_client.iter_medias.return_value = iter(medias)
    mock_client.fetch_lifetime_stats.return_value = _make_stats(plays=100, avg_pct=25)
    mock_client.fetch_by_date.return_value = [
        {"date": "2026-05-22", "load_count": 10, "play_count": 5, "hours_watched": 0.1},
        {"date": "2026-05-23", "load_count": 12, "play_count": 6, "hours_watched": 0.12},
    ]
    outcome = sync_wistia(
        mock_client, mock_db,
        start_date=date(2026, 5, 22), end_date=date(2026, 5, 23),
    )
    assert outcome.medias_synced == 2
    assert outcome.medias_failed == 0
    assert outcome.daily_rows_upserted == 4  # 2 medias × 2 days
    assert outcome.daily_rows_failed == 0
    assert outcome.errors == []
    assert outcome.days_in_window == 2
    assert outcome.window == {"start_date": "2026-05-22", "end_date": "2026-05-23"}


def test_sync_lifetime_stats_failure_still_writes_inventory(mock_db, mock_client):
    """Per-media lifetime-stats 404 / 503 → warning, inventory still lands."""
    mock_client.iter_medias.return_value = iter([_make_media("hash1")])
    mock_client.fetch_lifetime_stats.side_effect = WistiaAPIError("stats 404")
    mock_client.fetch_by_date.return_value = []
    outcome = sync_wistia(
        mock_client, mock_db,
        start_date=date(2026, 5, 22), end_date=date(2026, 5, 23),
    )
    # Inventory still upserted (stats are a cross-check, not the source).
    assert outcome.medias_synced == 1
    assert outcome.medias_failed == 0
    assert any("lifetime_stats hash1" in w for w in outcome.warnings)


def test_sync_by_date_failure_fails_soft(mock_db, mock_client):
    """One media's by_date failing doesn't abort the run."""
    mock_client.iter_medias.return_value = iter([
        _make_media("hash1"),
        _make_media("hash2"),
    ])
    mock_client.fetch_lifetime_stats.return_value = _make_stats()
    # hash1 by_date raises; hash2 succeeds.
    mock_client.fetch_by_date.side_effect = [
        WistiaAPIError("by_date 500"),
        [{"date": "2026-05-23", "load_count": 5, "play_count": 2, "hours_watched": 0.05}],
    ]
    outcome = sync_wistia(
        mock_client, mock_db,
        start_date=date(2026, 5, 23), end_date=date(2026, 5, 23),
    )
    assert outcome.medias_synced == 2  # both inventory rows landed
    assert outcome.daily_rows_upserted == 1  # only hash2's day
    assert any("by_date hash1" in e for e in outcome.errors)


def test_sync_iter_medias_failure_returns_empty_outcome(mock_db, mock_client):
    """If we can't even list medias, fail loudly via outcome.errors."""
    mock_client.iter_medias.side_effect = WistiaAPIError("medias 503")
    outcome = sync_wistia(
        mock_client, mock_db,
        start_date=date(2026, 5, 23), end_date=date(2026, 5, 23),
    )
    assert outcome.medias_synced == 0
    assert outcome.daily_rows_upserted == 0
    assert any("iter_medias" in e for e in outcome.errors)


def test_sync_max_medias_caps_by_date_calls(mock_db, mock_client):
    """--smoke / --limit path: only N medias get the by_date stage."""
    medias = [_make_media(f"hash{i}") for i in range(5)]
    mock_client.iter_medias.return_value = iter(medias)
    mock_client.fetch_lifetime_stats.return_value = _make_stats()
    mock_client.fetch_by_date.return_value = []
    outcome = sync_wistia(
        mock_client, mock_db,
        start_date=date(2026, 5, 23), end_date=date(2026, 5, 23),
        max_medias=2,
    )
    # All 5 medias get inventory rows...
    assert outcome.medias_synced == 5
    # ...but only 2 get the by_date call.
    assert mock_client.fetch_by_date.call_count == 2


def test_sync_projects_failure_is_warning_not_error(mock_db, mock_client):
    """Project fetch is a fallback for project_name resolution — non-fatal."""
    mock_client.iter_projects.side_effect = WistiaAPIError("projects 503")
    mock_client.iter_medias.return_value = iter([_make_media("hash1")])
    mock_client.fetch_lifetime_stats.return_value = _make_stats()
    mock_client.fetch_by_date.return_value = []
    outcome = sync_wistia(
        mock_client, mock_db,
        start_date=date(2026, 5, 23), end_date=date(2026, 5, 23),
    )
    # Still completes; project fetch failure is a warning.
    assert outcome.medias_synced == 1
    assert any("projects" in w for w in outcome.warnings)
    # Not an error — sync continued.
    assert all("iter_medias" not in e for e in outcome.errors)


def test_sync_upsert_failure_per_media_counted(mock_db, mock_client):
    """DB upsert exception on a single media → medias_failed += 1."""
    mock_client.iter_medias.return_value = iter([_make_media("hash1")])
    mock_client.fetch_lifetime_stats.return_value = _make_stats()
    mock_db.table.return_value.upsert.return_value.execute.side_effect = Exception("db boom")
    outcome = sync_wistia(
        mock_client, mock_db,
        start_date=date(2026, 5, 23), end_date=date(2026, 5, 23),
    )
    assert outcome.medias_failed == 1
    assert any("upsert media hash1" in e for e in outcome.errors)


# ---------------------------------------------------------------------------
# sync_wistia_rolling — convenience wrapper
# ---------------------------------------------------------------------------


def test_sync_wistia_rolling_computes_14_day_window(mock_db, mock_client):
    """The cron entry point. Window should be [today-13, today] inclusive."""
    mock_client.iter_medias.return_value = iter([])  # empty inventory
    mock_client.iter_projects.return_value = iter([])
    outcome = sync_wistia_rolling(mock_client, mock_db, window_days=14)
    assert outcome.days_in_window == 14
    # Window end = today, start = today - 13 days = 14 days inclusive.
    today = date.today()
    expected_start = (today - __import__("datetime").timedelta(days=13)).isoformat()
    assert outcome.window["end_date"] == today.isoformat()
    assert outcome.window["start_date"] == expected_start


# ---------------------------------------------------------------------------
# SyncOutcome defaults
# ---------------------------------------------------------------------------


def test_sync_outcome_defaults_sane():
    o = SyncOutcome()
    assert o.medias_synced == 0
    assert o.medias_failed == 0
    assert o.daily_rows_upserted == 0
    assert o.daily_rows_failed == 0
    assert o.days_in_window == 0
    assert o.window == {}
    assert o.warnings == []
    assert o.errors == []
