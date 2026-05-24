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


def _ts_entry(day: str, **fields) -> dict:
    """Build a timeseries entry shaped like Wistia's response.
    Default zeros for fields not specified."""
    return {
        "timestamp": f"{day} 05:00:00.000Z",
        "plays": fields.get("plays", 0),
        "unique_plays": fields.get("unique_plays", 0),
        "unique_loads": fields.get("unique_loads", 0),
        "unique_visitors": fields.get("unique_visitors", 0),
        "played_time": fields.get("played_time", 0),
        "engagement_rate": fields.get("engagement_rate", 0.0),
        "play_rate": fields.get("play_rate", 0.0),
        "cta_impressions": 0, "cta_conversions": 0,
        "cta_conversion_rate": 0.0, "form_conversions": 0,
    }


def test_sync_happy_path(mock_db, mock_client):
    medias = [
        _make_media("hash1", "Video 1"),
        _make_media("hash2", "Video 2"),
    ]
    mock_client.iter_medias.return_value = iter(medias)
    mock_client.fetch_lifetime_stats.return_value = _make_stats(plays=100, avg_pct=25)
    mock_client.fetch_timeseries.return_value = [
        _ts_entry("2026-05-22", plays=5, played_time=120, engagement_rate=0.10),
        _ts_entry("2026-05-23", plays=6, played_time=150, engagement_rate=0.12),
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
    mock_client.fetch_timeseries.return_value = []
    outcome = sync_wistia(
        mock_client, mock_db,
        start_date=date(2026, 5, 22), end_date=date(2026, 5, 23),
    )
    # Inventory still upserted (stats are a cross-check, not the source).
    assert outcome.medias_synced == 1
    assert outcome.medias_failed == 0
    assert any("lifetime_stats hash1" in w for w in outcome.warnings)


def test_sync_timeseries_failure_fails_soft(mock_db, mock_client):
    """One media's timeseries failing doesn't abort the run."""
    mock_client.iter_medias.return_value = iter([
        _make_media("hash1"),
        _make_media("hash2"),
    ])
    mock_client.fetch_lifetime_stats.return_value = _make_stats()
    # hash1 timeseries raises; hash2 succeeds.
    mock_client.fetch_timeseries.side_effect = [
        WistiaAPIError("timeseries 500"),
        [_ts_entry("2026-05-23", plays=2, played_time=60, engagement_rate=0.05)],
    ]
    outcome = sync_wistia(
        mock_client, mock_db,
        start_date=date(2026, 5, 23), end_date=date(2026, 5, 23),
    )
    assert outcome.medias_synced == 2  # both inventory rows landed
    assert outcome.daily_rows_upserted == 1  # only hash2's day
    assert any("timeseries hash1" in e for e in outcome.errors)


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


def test_sync_max_medias_caps_timeseries_calls(mock_db, mock_client):
    """--smoke / --limit path: only N medias get the timeseries stage."""
    medias = [_make_media(f"hash{i}") for i in range(5)]
    mock_client.iter_medias.return_value = iter(medias)
    mock_client.fetch_lifetime_stats.return_value = _make_stats()
    mock_client.fetch_timeseries.return_value = []
    outcome = sync_wistia(
        mock_client, mock_db,
        start_date=date(2026, 5, 23), end_date=date(2026, 5, 23),
        max_medias=2,
    )
    # All 5 medias get inventory rows...
    assert outcome.medias_synced == 5
    # ...but only 2 get the timeseries call.
    assert mock_client.fetch_timeseries.call_count == 2


def test_sync_post_cutover_does_not_overwrite_legacy_columns(mock_db, mock_client):
    """The cutover upsert must NOT include load_count / play_count /
    hours_watched in the row dict — leaving pre-cutover values intact."""
    mock_client.iter_medias.return_value = iter([_make_media("hash1")])
    mock_client.fetch_lifetime_stats.return_value = _make_stats()
    mock_client.fetch_timeseries.return_value = [
        _ts_entry("2026-05-23", plays=10, played_time=400, engagement_rate=0.15),
    ]
    sync_wistia(
        mock_client, mock_db,
        start_date=date(2026, 5, 23), end_date=date(2026, 5, 23),
    )
    # Find the daily-row upsert call (vs the inventory upsert).
    upsert_calls = [
        c for c in mock_db.table.return_value.upsert.call_args_list
        if isinstance(c.args[0], dict) and c.args[0].get("day")
    ]
    assert upsert_calls, "expected at least one daily-row upsert"
    daily_row = upsert_calls[0].args[0]
    for legacy in ("load_count", "play_count", "hours_watched"):
        assert legacy not in daily_row, (
            f"legacy column {legacy!r} leaked into post-cutover upsert"
        )
    # New columns DO land.
    assert daily_row["played_time_seconds"] == 400
    assert daily_row["engagement_rate"] == 0.15
    assert daily_row["plays_filtered"] == 10


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
