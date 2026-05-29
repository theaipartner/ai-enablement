"""Tests for the Cortana pipeline's ET-day windowing.

Guards the off-by-one fix (2026-05-29): Cortana attributes a 24h ET
window to the calendar day *after* the one it spans, so `et_day_window`
sends the window that ENDS at `day` 00:00 ET to retrieve `day`'s metrics.
A regression here silently shifts every stored row one day off.
"""

from __future__ import annotations

from datetime import date

from ingestion.cortana.pipeline import et_day_window


def test_window_ends_at_target_day_midnight_edt():
    """EDT (summer, UTC-4): window for D ends at D 00:00 ET, starts D-1."""
    start, end = et_day_window(date(2026, 5, 28))
    # end = 2026-05-28 00:00 ET = 04:00Z; start = 2026-05-27 00:00 ET.
    assert start == "2026-05-27T04:00:00Z"
    assert end == "2026-05-28T04:00:00Z"


def test_window_dst_aware_est():
    """EST (winter, UTC-5): the ET→UTC offset shifts to 05:00Z."""
    start, end = et_day_window(date(2026, 1, 15))
    assert start == "2026-01-14T05:00:00Z"
    assert end == "2026-01-15T05:00:00Z"


def test_window_endpoint_is_target_day_midnight_et():
    """End boundary must be `day` 00:00 ET (the regression guard).

    Pre-fix the window ended at D+1 00:00 ET, which made Cortana return
    D+1's data under D's label. Reconstruct the expected UTC endpoint
    directly from `day` 00:00 ET so the assertion is DST-correct.
    """
    from datetime import datetime
    from zoneinfo import ZoneInfo

    et, utc = ZoneInfo("America/New_York"), ZoneInfo("UTC")
    for d in (date(2026, 5, 26), date(2026, 5, 27), date(2026, 11, 1)):
        _, end = et_day_window(d)
        expected = (
            datetime(d.year, d.month, d.day, tzinfo=et)
            .astimezone(utc)
            .strftime("%Y-%m-%dT%H:%M:%SZ")
        )
        assert end == expected
