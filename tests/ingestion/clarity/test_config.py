"""Canonical config constants — load-bearing for the aggregation layer.

These constants identify WHICH paths the named Engine-sheet metrics
compute from. Changing them is fine; deleting one would silently
break the metric. These tests are a tripwire on accidental removal.
"""

from __future__ import annotations

from ingestion.clarity import (
    DEFAULT_TIME_METRIC,
    LANDING_PAGE_PATH,
    THANK_YOU_PAGE_PATH,
    TOTAL_SENTINEL,
)


def test_landing_page_path_present_and_string():
    assert isinstance(LANDING_PAGE_PATH, str)
    assert LANDING_PAGE_PATH.startswith("/"), (
        f"LANDING_PAGE_PATH must be a path (starts with /), got {LANDING_PAGE_PATH!r}"
    )


def test_thank_you_page_path_present_and_string():
    assert isinstance(THANK_YOU_PAGE_PATH, str)
    assert THANK_YOU_PAGE_PATH.startswith("/")


def test_default_time_metric_is_one_of_supported_columns():
    # If this fails it means someone introduced a third option without
    # updating the column set in 0049_clarity_metrics_daily.sql.
    assert DEFAULT_TIME_METRIC in {"active_time", "total_time"}


def test_total_sentinel_is_distinct_string():
    # The sentinel must NOT be a URL path Clarity could plausibly
    # return; double-underscore convention guards against collision.
    assert isinstance(TOTAL_SENTINEL, str)
    assert TOTAL_SENTINEL.startswith("__")
    assert TOTAL_SENTINEL.endswith("__")
