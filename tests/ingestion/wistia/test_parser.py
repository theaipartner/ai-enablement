"""Unit tests for ingestion.wistia.parser.

The parser is pure projection — no derivations. Tests focus on the
two contracts: (1) raw fields land in the right column names, with
the right types; (2) graceful degrade when stats payloads are
missing or partial.
"""

from __future__ import annotations

import pytest

from ingestion.wistia.parser import (
    parse_by_date_entry,
    parse_media,
    parse_timeseries_entry,
)


# ---------------------------------------------------------------------------
# parse_media
# ---------------------------------------------------------------------------


def test_parse_media_happy_path():
    media_json = {
        "hashed_id": "v736s9n4th",
        "name": "VSL",
        "duration": 305.6,
        "type": "Video",
        "created": "2024-08-04T12:00:00Z",
        "updated": "2026-05-01T08:00:00Z",
        "project": {"id": 9922901, "name": "Old VSL"},
    }
    stats_json = {
        "hashed_id": "v736s9n4th",
        "stats": {
            "pageLoads": 69440,
            "visitors": 58651,
            "percentOfVisitorsClickingPlay": 19,
            "plays": 11759,
            "averagePercentWatched": 36,
        },
    }
    row = parse_media(media_json, stats_json)
    assert row["hashed_id"] == "v736s9n4th"
    assert row["name"] == "VSL"
    assert row["duration_seconds"] == 305.6
    assert row["project_id"] == "9922901"
    assert row["project_name"] == "Old VSL"
    assert row["media_type"] == "Video"
    assert row["lifetime_page_loads"] == 69440
    assert row["lifetime_visitors"] == 58651
    assert row["lifetime_plays"] == 11759
    assert row["lifetime_percent_of_visitors_clicking_play"] == 19
    assert row["lifetime_avg_percent_watched"] == 36
    assert row["wistia_created_at"] == "2024-08-04T12:00:00Z"
    assert row["wistia_updated_at"] == "2026-05-01T08:00:00Z"


def test_parse_media_missing_hashed_id_returns_empty():
    row = parse_media({"name": "no id"}, None)
    assert row == {}


def test_parse_media_no_stats_still_writes_inventory():
    """Lifetime stats are a cross-check — inventory row lands without."""
    media_json = {
        "hashed_id": "abc123",
        "name": "Test",
        "duration": 100.0,
        "type": "Video",
    }
    row = parse_media(media_json, None)
    assert row["hashed_id"] == "abc123"
    assert row["name"] == "Test"
    assert "lifetime_plays" not in row  # NULL in DB


def test_parse_media_partial_stats():
    """If stats payload is truncated, only the present fields land."""
    media_json = {"hashed_id": "abc", "name": "X", "duration": 50}
    stats_json = {"stats": {"plays": 100}}  # only plays
    row = parse_media(media_json, stats_json)
    assert row["lifetime_plays"] == 100
    # Other lifetime_* keys still get set but to None
    assert row.get("lifetime_page_loads") is None


def test_parse_media_project_name_fallback_via_lookup():
    """Some media payloads omit project.name; use the lookup map."""
    media_json = {
        "hashed_id": "xyz",
        "name": "Y",
        "duration": 60,
        "project": {"id": "10515824"},  # no name
    }
    project_lookup = {"10515824": "Confirmation Page Vids"}
    row = parse_media(media_json, None, project_lookup)
    assert row["project_id"] == "10515824"
    assert row["project_name"] == "Confirmation Page Vids"


def test_parse_media_project_id_coerced_to_string():
    """Wistia returns project.id as int; we store as text in DB."""
    media_json = {
        "hashed_id": "p1",
        "name": "P",
        "duration": 10,
        "project": {"id": 12345, "name": "Some project"},
    }
    row = parse_media(media_json, None)
    assert row["project_id"] == "12345"
    assert isinstance(row["project_id"], str)


def test_parse_media_no_project_leaves_nulls():
    media_json = {"hashed_id": "np", "name": "NP", "duration": 10}
    row = parse_media(media_json, None)
    assert row["project_id"] is None
    assert row["project_name"] is None


# ---------------------------------------------------------------------------
# parse_by_date_entry
# ---------------------------------------------------------------------------


def test_parse_by_date_entry_happy_path():
    entry = {
        "date": "2026-05-23",
        "load_count": 12,
        "play_count": 5,
        "hours_watched": 0.085,
    }
    row = parse_by_date_entry("v736s9n4th", entry)
    assert row["hashed_id"] == "v736s9n4th"
    assert row["day"] == "2026-05-23"
    assert row["load_count"] == 12
    assert row["play_count"] == 5
    # hours_watched stored as-is (HOURS, not seconds — load-bearing!)
    assert row["hours_watched"] == 0.085


def test_parse_by_date_entry_zero_activity_day():
    """Wistia returns zeros (not nulls) on no-activity days. Stored as-is."""
    entry = {"date": "2026-05-10", "load_count": 0, "play_count": 0, "hours_watched": 0}
    row = parse_by_date_entry("abc", entry)
    assert row["load_count"] == 0
    assert row["play_count"] == 0
    assert row["hours_watched"] == 0


def test_parse_by_date_entry_missing_date_returns_empty():
    row = parse_by_date_entry("abc", {"load_count": 1})
    assert row == {}


def test_parse_by_date_entry_missing_counts_default_to_zero():
    """Defensive — if Wistia ever returns nulls for unactivated medias."""
    entry = {"date": "2026-05-23"}
    row = parse_by_date_entry("abc", entry)
    assert row["load_count"] == 0
    assert row["play_count"] == 0
    assert row["hours_watched"] == 0


def test_parse_by_date_entry_none_values_coalesce_to_zero():
    entry = {"date": "2026-05-23", "load_count": None, "play_count": None, "hours_watched": None}
    row = parse_by_date_entry("abc", entry)
    assert row["load_count"] == 0
    assert row["play_count"] == 0
    assert row["hours_watched"] == 0


def test_parse_by_date_hours_watched_units_are_hours_not_seconds():
    """LOAD-BEARING contract: hours_watched stays in HOURS as float.

    Discovery report example: 0.08515... = ~5 minutes 6 seconds.
    Aggregation layer converts to seconds via × 3600. Pre-converting
    here would silently double-multiply downstream.
    """
    entry = {"date": "2026-05-10", "load_count": 15, "play_count": 4, "hours_watched": 0.08515294392903645}
    row = parse_by_date_entry("2zsih4xrkv", entry)
    assert row["hours_watched"] == 0.08515294392903645
    # Sanity: × 3600 = ~306s = ~5m6s — matches the discovery sample.
    assert abs(row["hours_watched"] * 3600 - 306.5506) < 0.01


# ---------------------------------------------------------------------------
# parse_timeseries_entry — post-2026-05-24 cutover source
# ---------------------------------------------------------------------------


def test_parse_timeseries_entry_happy_path():
    """Verbatim entry shape from the watchtime-verify probe (live data
    on i1173gx76b 2026-04-27)."""
    entry = {
        "timestamp": "2026-04-27 05:00:00.000Z",
        "plays": 23,
        "unique_plays": 19,
        "unique_loads": 8,
        "unique_visitors": 16,
        "played_time": 494,
        "engagement_rate": 0.09078344712810592,
        "play_rate": 0.75,
        "cta_impressions": 0,
        "cta_conversions": 0,
        "cta_conversion_rate": 0.0,
        "form_conversions": 0,
    }
    row = parse_timeseries_entry("i1173gx76b", entry)
    assert row["hashed_id"] == "i1173gx76b"
    assert row["day"] == "2026-04-27"
    # NEW filtered plays — distinct from legacy play_count (NOT mapped).
    assert row["plays_filtered"] == 23
    assert "play_count" not in row  # legacy column preserved by NOT including
    assert "load_count" not in row  # same — preserved on existing rows
    assert "hours_watched" not in row  # same — deprecated, preserved
    # Real per-day watch-time in SECONDS as integer
    assert row["played_time_seconds"] == 494
    # Real per-day engagement rate as 0-1 float — NOT ×100
    assert row["engagement_rate"] == 0.09078344712810592
    assert row["play_rate"] == 0.75
    assert row["unique_plays"] == 19
    assert row["unique_loads"] == 8
    assert row["unique_visitors"] == 16
    assert row["cta_impressions"] == 0
    assert row["cta_conversions"] == 0
    assert row["cta_conversion_rate"] == 0.0
    assert row["form_conversions"] == 0


def test_parse_timeseries_entry_engagement_rate_is_raw_0_to_1():
    """LOAD-BEARING: engagement_rate stays 0-1 float, NOT ×100.

    Schema doc states this loudly; aggregation/display layer formats
    to percentage. Pre-converting here would silently double-multiply
    downstream.
    """
    entry = {"timestamp": "2026-05-23 05:00:00.000Z", "engagement_rate": 0.2538}
    row = parse_timeseries_entry("x", entry)
    assert row["engagement_rate"] == 0.2538
    # NOT 25.38. Display layer formats: f"{r['engagement_rate']*100:.1f}%"


def test_parse_timeseries_entry_played_time_is_seconds_integer():
    """LOAD-BEARING: played_time stays in SECONDS as integer.

    The verify probe showed e.g. 7161 seconds = ~2h watched on a
    high-traffic day. Distinct from the deprecated by_date
    hours_watched (which was hours as float). Storing seconds-as-int
    is cleaner; display layer divides for hours.
    """
    entry = {"timestamp": "2026-05-23 05:00:00.000Z", "played_time": 7161}
    row = parse_timeseries_entry("x", entry)
    assert row["played_time_seconds"] == 7161
    assert isinstance(row["played_time_seconds"], int)


def test_parse_timeseries_entry_extracts_date_from_timestamp():
    """Wistia returns ISO8601 bucket-start timestamps. The day is the
    date portion (account-local calendar day; verified to match the
    legacy by_date `date` field exactly, so the cutover boundary
    doesn't introduce a one-day shift)."""
    entry = {"timestamp": "2026-05-23 05:00:00.000Z", "plays": 1}
    row = parse_timeseries_entry("x", entry)
    assert row["day"] == "2026-05-23"


def test_parse_timeseries_entry_missing_timestamp_returns_empty():
    row = parse_timeseries_entry("x", {"plays": 5})
    assert row == {}


def test_parse_timeseries_entry_short_timestamp_returns_empty():
    """A malformed/short timestamp shouldn't poison the upsert."""
    row = parse_timeseries_entry("x", {"timestamp": "bad"})
    assert row == {}


def test_parse_timeseries_entry_zero_activity_day_preserves_nulls():
    """A no-activity day may have nulls or zeros for the metric fields.
    Either case: row lands with whatever Wistia sent (we don't coalesce
    to defaults — column defaults handle the DB side; missing keys come
    out as None in the row dict and upsert skips them)."""
    entry = {"timestamp": "2026-05-23 05:00:00.000Z"}
    row = parse_timeseries_entry("x", entry)
    assert row["hashed_id"] == "x"
    assert row["day"] == "2026-05-23"
    # All metric fields present in the dict but None when missing.
    assert row["played_time_seconds"] is None
    assert row["engagement_rate"] is None
    assert row["plays_filtered"] is None


def test_parse_timeseries_does_not_touch_legacy_columns():
    """Critical contract: post-cutover upserts must NOT include the
    legacy load_count / play_count / hours_watched columns so existing
    pre-cutover values are preserved on those columns.
    """
    entry = {
        "timestamp": "2026-05-23 05:00:00.000Z",
        "plays": 202,
        "played_time": 7161,
        "engagement_rate": 0.1473,
    }
    row = parse_timeseries_entry("x", entry)
    for legacy_col in ("load_count", "play_count", "hours_watched"):
        assert legacy_col not in row, f"legacy column {legacy_col!r} leaked into timeseries row"
