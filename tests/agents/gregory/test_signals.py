"""Tests for agents.gregory.signals.

Each signal gets a happy-path test (real value -> contribution band) and
a missing-data test (contribution = NEUTRAL). The signals layer is a
thin wrapper over Supabase queries; the tests stub the chained query
builder rather than hit the DB.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any

import pytest

from agents.gregory import signals
from agents.gregory.signals import NEUTRAL_CONTRIBUTION


# ---------------------------------------------------------------------------
# Fake Supabase client — just enough to satisfy the chained .table().select()
# pattern. Each test sets the resp_data / resp_count for the next call.
# ---------------------------------------------------------------------------


class _FakeQuery:
    def __init__(self, resp_data=None, resp_count=None):
        self._resp = SimpleNamespace(data=resp_data, count=resp_count)

    def select(self, *a, **kw):
        return self

    def eq(self, *a, **kw):
        return self

    def lt(self, *a, **kw):
        return self

    def order(self, *a, **kw):
        return self

    def limit(self, *a, **kw):
        return self

    def execute(self):
        return self._resp


class _FakeDB:
    def __init__(self, resp_data=None, resp_count=None):
        self._query = _FakeQuery(resp_data=resp_data, resp_count=resp_count)

    def table(self, name):
        return self._query


# ---------------------------------------------------------------------------
# call_cadence
# ---------------------------------------------------------------------------


def test_call_cadence_recent_call_scores_100():
    recent = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
    db = _FakeDB(resp_data=[{"started_at": recent}])

    result = signals.compute_call_cadence(db, "client-x")

    assert result["name"] == "call_cadence"
    assert result["contribution"] == 100
    assert result["weight"] == signals.WEIGHT_CALL_CADENCE


def test_call_cadence_mid_band_scores_50():
    mid = (datetime.now(timezone.utc) - timedelta(days=20)).isoformat()
    db = _FakeDB(resp_data=[{"started_at": mid}])

    result = signals.compute_call_cadence(db, "client-x")

    assert result["contribution"] == 50


def test_call_cadence_stale_scores_0():
    stale = (datetime.now(timezone.utc) - timedelta(days=45)).isoformat()
    db = _FakeDB(resp_data=[{"started_at": stale}])

    result = signals.compute_call_cadence(db, "client-x")

    assert result["contribution"] == 0


def test_call_cadence_no_calls_neutral():
    db = _FakeDB(resp_data=[])

    result = signals.compute_call_cadence(db, "client-x")

    assert result["contribution"] == NEUTRAL_CONTRIBUTION
    assert result["value"] is None
    assert "no calls" in result["note"].lower()


# ---------------------------------------------------------------------------
# overdue_action_items
# ---------------------------------------------------------------------------


def test_overdue_action_items_none_is_100():
    db = _FakeDB(resp_count=0)

    result = signals.compute_overdue_action_items(db, "client-x")

    assert result["contribution"] == 100


def test_overdue_action_items_subtracts_15_per_item():
    db = _FakeDB(resp_count=2)

    result = signals.compute_overdue_action_items(db, "client-x")

    assert result["contribution"] == 70  # 100 - 15*2


# ---------------------------------------------------------------------------
# latest_nps
# ---------------------------------------------------------------------------


def test_latest_nps_scales_0_to_10_onto_0_to_100():
    db = _FakeDB(resp_data=[{"score": 8, "submitted_at": "2026-04-01T00:00:00Z"}])

    result = signals.compute_latest_nps(db, "client-x")

    assert result["contribution"] == 80
    assert result["value"] == "8"


def test_latest_nps_zero_is_zero_not_neutral():
    """A real NPS of 0 is meaningfully bad, not 'no data'."""
    db = _FakeDB(resp_data=[{"score": 0, "submitted_at": "2026-04-01T00:00:00Z"}])

    result = signals.compute_latest_nps(db, "client-x")

    assert result["contribution"] == 0
    assert result["value"] == "0"


def test_latest_nps_no_data_neutral():
    db = _FakeDB(resp_data=[])

    result = signals.compute_latest_nps(db, "client-x")

    assert result["contribution"] == NEUTRAL_CONTRIBUTION
    assert result["value"] is None
    assert "nps" in result["note"].lower()


# ---------------------------------------------------------------------------
# compute_all_signals — composition + ordering
# ---------------------------------------------------------------------------


def test_compute_all_signals_returns_three_deterministic_signals_in_order():
    """V2 deterministic signals only — the AI call signal is composed
    into the final factors.signals[] array by agent.py (AI signal
    sorts first per the dashboard ordering)."""
    db = _FakeDB(resp_data=[], resp_count=0)

    results = signals.compute_all_signals(db, "client-x")

    assert [s["name"] for s in results] == [
        "call_cadence",
        "overdue_action_items",
        "latest_nps",
    ]
