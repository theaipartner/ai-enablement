"""Unit tests for ingestion.clarity.parser.

The parser is the boundary between Clarity's API shape and our DB row
shape. Tests pin down:
  - the 9 metric blocks → flat row dict mapping
  - url_path derivation (urlparse(url).path)
  - null-URL → TOTAL_SENTINEL handling
  - string→int casts on count fields
  - both totalTime AND activeTime captured
  - graceful handling of malformed blocks/rows
  - duplicate-key detection within a single response
  - the canonical paths from discovery survive the round-trip
"""

from __future__ import annotations

from datetime import date

import pytest

from ingestion.clarity import TOTAL_SENTINEL
from ingestion.clarity.parser import parse_response


SNAP = date(2026, 5, 24)


# ---------------------------------------------------------------------------
# Happy path — Traffic block
# ---------------------------------------------------------------------------


def test_traffic_row_maps_typed_columns():
    blocks = [{
        "metricName": "Traffic",
        "information": [
            {
                "totalSessionCount": "15",
                "totalBotSessionCount": "0",
                "distinctUserCount": "18",
                "pagesPerSessionPercentage": 1.0,
                "Url": "https://go.theaipartner.io/lp?utm_source=fb",
            },
        ],
    }]
    rows, warnings = parse_response(blocks, SNAP)
    assert len(rows) == 1
    assert warnings == []
    r = rows[0]
    assert r["snapshot_date"] == "2026-05-24"
    assert r["metric_name"] == "Traffic"
    assert r["url"] == "https://go.theaipartner.io/lp?utm_source=fb"
    assert r["url_path"] == "/lp"
    assert r["total_session_count"] == 15
    assert r["total_bot_session_count"] == 0
    assert r["distinct_user_count"] == 18
    assert r["pages_per_session_percentage"] == 1.0
    # EngagementTime fields not populated on Traffic rows.
    assert r["total_time"] is None
    assert r["active_time"] is None
    # Raw preserves the original dict.
    assert r["raw"]["totalSessionCount"] == "15"


# ---------------------------------------------------------------------------
# Happy path — EngagementTime block
# ---------------------------------------------------------------------------


def test_engagement_time_captures_both_time_fields():
    blocks = [{
        "metricName": "EngagementTime",
        "information": [
            {"totalTime": "85", "activeTime": "17",
             "Url": "https://go.theaipartner.io/lp?event_id=x"},
            {"totalTime": "58", "activeTime": "58",
             "Url": "https://go.theaipartner.io/confirmation?event_id=y"},
        ],
    }]
    rows, _ = parse_response(blocks, SNAP)
    assert len(rows) == 2

    lp = next(r for r in rows if r["url_path"] == "/lp")
    assert lp["total_time"] == 85
    assert lp["active_time"] == 17
    assert lp["total_session_count"] is None  # not a Traffic row

    conf = next(r for r in rows if r["url_path"] == "/confirmation")
    assert conf["total_time"] == 58
    assert conf["active_time"] == 58


# ---------------------------------------------------------------------------
# url_path derivation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("url,expected_path", [
    ("https://go.theaipartner.io/lp?utm=x", "/lp"),
    ("https://go.theaipartner.io/confirmation", "/confirmation"),
    ("https://go.theaipartner.io/course-success?event_id=abc&ip=1.2.3.4", "/course-success"),
    # The discovery showed `/lp` with very long querystrings — confirm
    # path extraction works on >800-char URLs.
    ("https://go.theaipartner.io/lp?" + "x=y&" * 200, "/lp"),
])
def test_url_path_derived_from_urlparse(url, expected_path):
    blocks = [{
        "metricName": "Traffic",
        "information": [{"totalSessionCount": "1", "Url": url}],
    }]
    rows, _ = parse_response(blocks, SNAP)
    assert rows[0]["url_path"] == expected_path
    assert rows[0]["url"] == url


# ---------------------------------------------------------------------------
# Null-URL aggregate row → TOTAL_SENTINEL
# ---------------------------------------------------------------------------


def test_null_url_becomes_total_sentinel():
    blocks = [{
        "metricName": "Traffic",
        "information": [
            {"totalSessionCount": "0", "distinctUserCount": "2", "Url": None},
        ],
    }]
    rows, _ = parse_response(blocks, SNAP)
    assert len(rows) == 1
    assert rows[0]["url"] == TOTAL_SENTINEL
    assert rows[0]["url_path"] == TOTAL_SENTINEL
    assert rows[0]["distinct_user_count"] == 2


def test_empty_string_url_also_becomes_sentinel():
    # Defensive — API doesn't promise it won't return an empty string
    blocks = [{
        "metricName": "Traffic",
        "information": [{"totalSessionCount": "1", "Url": ""}],
    }]
    rows, _ = parse_response(blocks, SNAP)
    assert rows[0]["url"] == TOTAL_SENTINEL


def test_missing_url_field_becomes_sentinel():
    blocks = [{
        "metricName": "DeadClickCount",
        "information": [{"DeadClickCount": "3"}],  # no Url field at all
    }]
    rows, _ = parse_response(blocks, SNAP)
    assert rows[0]["url"] == TOTAL_SENTINEL


# ---------------------------------------------------------------------------
# Case-tolerant Url field lookup (defensive — discovery showed `Url`,
# but the dimension request is `URL`; if Clarity ever shifts capitalization
# the parser shouldn't silently lose everything).
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("field_name", ["Url", "URL", "url"])
def test_url_field_accepted_in_multiple_capitalizations(field_name):
    blocks = [{
        "metricName": "Traffic",
        "information": [{
            "totalSessionCount": "1",
            field_name: "https://go.theaipartner.io/lp",
        }],
    }]
    rows, _ = parse_response(blocks, SNAP)
    assert rows[0]["url_path"] == "/lp"


# ---------------------------------------------------------------------------
# String → int casts
# ---------------------------------------------------------------------------


def test_string_numeric_fields_cast_to_int():
    blocks = [{
        "metricName": "Traffic",
        "information": [{
            "totalSessionCount": "291942",   # large int as string
            "totalBotSessionCount": "31076",
            "distinctUserCount": "212836",
            "Url": "https://go.theaipartner.io/lp",
        }],
    }]
    rows, _ = parse_response(blocks, SNAP)
    r = rows[0]
    assert r["total_session_count"] == 291942
    assert isinstance(r["total_session_count"], int)
    assert r["total_bot_session_count"] == 31076
    assert r["distinct_user_count"] == 212836


def test_unparseable_numeric_becomes_none():
    blocks = [{
        "metricName": "Traffic",
        "information": [{
            "totalSessionCount": "not-a-number",
            "Url": "https://go.theaipartner.io/lp",
        }],
    }]
    rows, _ = parse_response(blocks, SNAP)
    assert rows[0]["total_session_count"] is None


# ---------------------------------------------------------------------------
# Quality-signal blocks (DeadClickCount, RageClickCount, etc.)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("metric", [
    "DeadClickCount", "RageClickCount", "QuickbackClick",
    "ExcessiveScroll", "ScriptErrorCount", "ErrorClickCount", "ScrollDepth",
])
def test_quality_block_stored_in_raw_only(metric):
    blocks = [{
        "metricName": metric,
        "information": [{
            metric: "5",
            "Url": "https://go.theaipartner.io/lp",
        }],
    }]
    rows, _ = parse_response(blocks, SNAP)
    r = rows[0]
    assert r["metric_name"] == metric
    # Typed columns NOT populated for quality blocks.
    assert r["total_session_count"] is None
    assert r["total_time"] is None
    assert r["active_time"] is None
    # The metric's own field survives in raw.
    assert r["raw"][metric] == "5"


# ---------------------------------------------------------------------------
# Malformed input — warnings, no crash
# ---------------------------------------------------------------------------


def test_block_without_metric_name_warned_and_skipped():
    blocks = [{"information": [{"Url": "https://x/y"}]}]
    rows, warnings = parse_response(blocks, SNAP)
    assert rows == []
    assert any("missing metricName" in w for w in warnings)


def test_block_with_non_list_information_warned():
    blocks = [{"metricName": "Traffic", "information": "oops"}]
    rows, warnings = parse_response(blocks, SNAP)
    assert rows == []
    assert any("no information list" in w for w in warnings)


def test_non_list_top_level_returns_empty_with_warning():
    rows, warnings = parse_response({"oops": True}, SNAP)
    assert rows == []
    assert any("not a list" in w for w in warnings)


def test_row_that_isnt_dict_warned_and_skipped():
    blocks = [{
        "metricName": "Traffic",
        "information": ["broken", {"totalSessionCount": "1", "Url": "https://go/lp"}],
    }]
    rows, warnings = parse_response(blocks, SNAP)
    assert len(rows) == 1
    assert any("not a dict" in w for w in warnings)


# ---------------------------------------------------------------------------
# Duplicate key detection within one response
# ---------------------------------------------------------------------------


def test_duplicate_metric_url_within_response_emits_warning():
    blocks = [{
        "metricName": "Traffic",
        "information": [
            {"totalSessionCount": "1", "Url": "https://go/lp"},
            {"totalSessionCount": "2", "Url": "https://go/lp"},  # same key
        ],
    }]
    rows, warnings = parse_response(blocks, SNAP)
    assert len(rows) == 2  # both kept, but warning emitted
    assert any("duplicate" in w.lower() for w in warnings)


# ---------------------------------------------------------------------------
# Multi-block end-to-end (mini fixture from real discovery shape)
# ---------------------------------------------------------------------------


def test_multi_block_response_with_canonical_paths():
    blocks = [
        {"metricName": "Traffic", "information": [
            {"totalSessionCount": "15", "distinctUserCount": "18",
             "Url": "https://go.theaipartner.io/lp?utm=x"},
            {"totalSessionCount": "2", "distinctUserCount": "3",
             "Url": "https://go.theaipartner.io/confirmation?event_id=a"},
            {"totalSessionCount": "0", "distinctUserCount": "2", "Url": None},
        ]},
        {"metricName": "EngagementTime", "information": [
            {"totalTime": "551", "activeTime": "79",
             "Url": "https://go.theaipartner.io/lp?utm=x"},
            {"totalTime": "66", "activeTime": "63",
             "Url": "https://go.theaipartner.io/confirmation?event_id=a"},
        ]},
    ]
    rows, warnings = parse_response(blocks, SNAP)
    assert warnings == []
    assert len(rows) == 5

    # The canonical landing and thank-you paths are present in both
    # Traffic and EngagementTime — aggregation needs this.
    paths_per_metric = {(r["metric_name"], r["url_path"]) for r in rows}
    assert ("Traffic", "/lp") in paths_per_metric
    assert ("Traffic", "/confirmation") in paths_per_metric
    assert ("Traffic", TOTAL_SENTINEL) in paths_per_metric
    assert ("EngagementTime", "/lp") in paths_per_metric
    assert ("EngagementTime", "/confirmation") in paths_per_metric


# ---------------------------------------------------------------------------
# Real-world fixture (the captured probe response)
# ---------------------------------------------------------------------------


def test_real_probe_fixture_round_trip():
    """End-to-end against the actual response captured during discovery.

    Locked-in expectations from .probe-out/clarity/url-segmented-3d.json:
      - 9 metric blocks
      - 174 total rows
      - 8 distinct paths (no __total__ except possibly Traffic)
      - /lp and /confirmation both present
    """
    import json
    from pathlib import Path

    fixture = Path(".probe-out/clarity/url-segmented-3d.json")
    if not fixture.exists():
        pytest.skip("probe fixture not present; run scripts/explore_clarity_api.py first")

    body = json.loads(fixture.read_text())["response"]["body"]
    rows, warnings = parse_response(body, SNAP)

    assert len(body) == 9, f"expected 9 metric blocks, got {len(body)}"
    metric_names = {r["metric_name"] for r in rows}
    assert "Traffic" in metric_names
    assert "EngagementTime" in metric_names

    paths = {r["url_path"] for r in rows}
    assert "/lp" in paths, "landing page path missing — canonical config breaks"
    assert "/confirmation" in paths, "thank-you path missing — canonical config breaks"

    # The null-URL aggregate row in Traffic should have become the sentinel.
    traffic_paths = {r["url_path"] for r in rows if r["metric_name"] == "Traffic"}
    assert TOTAL_SENTINEL in traffic_paths

    # All EngagementTime rows have both time fields populated as ints.
    for r in rows:
        if r["metric_name"] == "EngagementTime":
            assert r["total_time"] is not None and isinstance(r["total_time"], int)
            assert r["active_time"] is not None and isinstance(r["active_time"], int)
