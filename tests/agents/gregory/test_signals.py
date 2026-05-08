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
# latest_nps — reads clients.nps_standing (Airtable mirror via NPS-is-gospel)
# ---------------------------------------------------------------------------


def test_latest_nps_promoter_scores_100():
    db = _FakeDB(resp_data=[{"nps_standing": "promoter"}])

    result = signals.compute_latest_nps(db, "client-x")

    assert result["name"] == "latest_nps"
    assert result["contribution"] == 100
    assert result["value"] == "promoter"
    assert "promoter" in result["note"].lower()


def test_latest_nps_neutral_scores_50_with_passive_note():
    """Real-data 'neutral' segment maps to contribution 50 — same value
    as the no-data neutral, but the note must distinguish them so the
    insufficient_data flag + dashboard rendering can tell which is
    which."""
    db = _FakeDB(resp_data=[{"nps_standing": "neutral"}])

    result = signals.compute_latest_nps(db, "client-x")

    assert result["contribution"] == 50
    assert result["value"] == "neutral"
    assert "passive" in result["note"].lower()
    assert "no nps standing" not in result["note"].lower()


def test_latest_nps_at_risk_scores_0():
    """A real at_risk segment is meaningfully bad, not 'no data'."""
    db = _FakeDB(resp_data=[{"nps_standing": "at_risk"}])

    result = signals.compute_latest_nps(db, "client-x")

    assert result["contribution"] == 0
    assert result["value"] == "at_risk"
    assert "at_risk" in result["note"].lower()


def test_latest_nps_null_standing_neutral():
    """nps_standing=None (column populated but value is null) →
    NEUTRAL_CONTRIBUTION with the 'no record' note."""
    db = _FakeDB(resp_data=[{"nps_standing": None}])

    result = signals.compute_latest_nps(db, "client-x")

    assert result["contribution"] == NEUTRAL_CONTRIBUTION
    assert result["value"] is None
    assert "no nps standing" in result["note"].lower()


def test_latest_nps_client_row_missing_neutral():
    """Defensive: empty resp.data (client_id not found) falls through
    to neutral. Shouldn't happen in production — agent.py only passes
    ids freshly iterated from clients — but cheap to handle."""
    db = _FakeDB(resp_data=[])

    result = signals.compute_latest_nps(db, "client-x")

    assert result["contribution"] == NEUTRAL_CONTRIBUTION
    assert result["value"] is None


def test_latest_nps_unexpected_value_falls_through_to_neutral():
    """Defense-in-depth past the migration 0021 CHECK constraint.
    Constraints get widened; we don't want a future
    'detractor' or 'sleeper' segment to crash the brain."""
    db = _FakeDB(resp_data=[{"nps_standing": "detractor"}])

    result = signals.compute_latest_nps(db, "client-x")

    assert result["contribution"] == NEUTRAL_CONTRIBUTION
    assert result["value"] == "detractor"
    assert "unexpected" in result["note"].lower()


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
