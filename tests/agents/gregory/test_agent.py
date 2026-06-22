"""End-to-end wiring test for agents.gregory.agent (V2).

Mocks every collaborator (compute_ai_call_signal, compute_all_signals,
agent_runs lifecycle, the Supabase insert) and verifies that:

  - start_agent_run / end_agent_run are called around the work
  - factors jsonb has the locked shape (signals[], concerns[],
    overall_reasoning) so the dashboard renderer doesn't break
  - AI call signal is sorted FIRST in factors.signals[] per V2 ordering
  - concerns flow from compute_ai_call_signal directly (concerns.py
    retired in V2)
  - client_health_scores row is inserted with the right fields
  - duration_ms is computed and passed to end_agent_run
  - per-client errors in the sweep don't halt the loop
  - SweepResult carries duration_ms + avg_per_client_ms (V2 telemetry
    for the cron-ceiling watchpoint)
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agents.gregory import agent
from agents.gregory.signals import Signal


def _signal(name: str, contribution: int, weight: float) -> Signal:
    return Signal(
        name=name,
        weight=weight,
        value=str(contribution),
        contribution=contribution,
        note=f"{name} note",
    )


@pytest.fixture
def fake_db_with_insert():
    """Minimal supabase stub that captures the insert payload + returns
    a fixed row id."""

    captured: dict[str, Any] = {}

    class _Insert:
        def __init__(self, payload):
            captured["payload"] = payload

        def execute(self):
            return SimpleNamespace(data=[{"id": "health-row-1"}])

    class _Table:
        def insert(self, payload):
            return _Insert(payload)

        def select(self, *a, **kw):
            return self

        def is_(self, *a, **kw):
            return self

        def order(self, *a, **kw):
            return self

        def execute(self):
            return SimpleNamespace(
                data=[
                    {"id": "client-1", "full_name": "Test Client"},
                    {"id": "client-2", "full_name": "Other Client"},
                ]
            )

    class _DB:
        def table(self, name):
            return _Table()

    return SimpleNamespace(db=_DB(), captured=captured)


def test_compute_health_for_client_writes_locked_factors_shape(
    mocker, fake_db_with_insert
):
    sample_concern = {
        "text": "Sample concern",
        "severity": "medium",
        "source_call_ids": ["c1"],
    }
    mocker.patch.object(
        agent,
        "compute_ai_call_signal",
        return_value=(
            _signal("ai_call_signal", 75, 0.50),
            [sample_concern],
        ),
    )
    mocker.patch.object(
        agent,
        "compute_all_signals",
        return_value=[
            _signal("call_cadence", 100, 0.20),
            _signal("overdue_action_items", 100, 0.10),
            _signal("latest_nps", 70, 0.20),
        ],
    )
    start = mocker.patch.object(agent, "start_agent_run", return_value="run-abc")
    end = mocker.patch.object(agent, "end_agent_run")

    result = agent.compute_health_for_client(
        client_id="client-1", db=fake_db_with_insert.db
    )

    # Lifecycle wired
    start.assert_called_once()
    assert start.call_args.kwargs["agent_name"] == "gregory"
    assert start.call_args.kwargs["trigger_type"] == "manual"
    end.assert_called_once()
    assert end.call_args.kwargs["status"] == "success"
    assert end.call_args.kwargs["duration_ms"] is not None
    assert end.call_args.kwargs["duration_ms"] >= 0

    # Insert payload matches schema + locked factors shape
    payload = fake_db_with_insert.captured["payload"]
    assert payload["client_id"] == "client-1"
    assert payload["computed_by_run_id"] == "run-abc"
    assert payload["tier"] in {"green", "yellow", "red"}
    assert 0 <= payload["score"] <= 100

    factors = payload["factors"]
    assert "signals" in factors
    assert "concerns" in factors
    assert "overall_reasoning" in factors
    # V2: 4 signals total (AI + 3 deterministic), AI sorted first.
    assert len(factors["signals"]) == 4
    assert factors["signals"][0]["name"] == "ai_call_signal"
    assert factors["signals"][1]["name"] == "call_cadence"
    # Concerns flow directly from compute_ai_call_signal in V2.
    assert factors["concerns"] == [sample_concern]

    # Returned shape carries the row id + run id
    assert result.client_id == "client-1"
    assert result.health_score_row_id == "health-row-1"
    assert result.agent_run_id == "run-abc"
    assert result.concerns_count == 1


def test_compute_health_for_client_error_path_closes_run_with_error(
    mocker, fake_db_with_insert
):
    # AI signal never raises by contract; simulate a hard failure
    # downstream (e.g. compute_all_signals db blip) to verify the
    # parent run's error path still closes telemetry properly.
    mocker.patch.object(
        agent,
        "compute_ai_call_signal",
        return_value=(_signal("ai_call_signal", 50, 0.50), []),
    )
    mocker.patch.object(
        agent, "compute_all_signals", side_effect=RuntimeError("boom")
    )
    start = mocker.patch.object(agent, "start_agent_run", return_value="run-err")
    end = mocker.patch.object(agent, "end_agent_run")

    with pytest.raises(RuntimeError, match="boom"):
        agent.compute_health_for_client(
            client_id="client-1", db=fake_db_with_insert.db
        )

    end.assert_called_once()
    assert end.call_args.kwargs["status"] == "error"
    assert "boom" in end.call_args.kwargs["error_message"]


def test_compute_health_for_all_active_isolates_per_client_errors(
    mocker, fake_db_with_insert
):
    """One client raising must not halt the rest of the sweep."""
    call_count = {"n": 0}

    def fake_compute(client_id, db, trigger_type):
        call_count["n"] += 1
        if client_id == "client-1":
            raise RuntimeError("client-1 broke")
        return agent.HealthComputeResult(
            client_id=client_id,
            score=80,
            tier="green",
            insufficient_data=False,
            concerns_count=0,
            health_score_row_id="row-x",
            agent_run_id="run-x",
        )

    mocker.patch.object(agent, "compute_health_for_client", side_effect=fake_compute)

    sweep = agent.compute_health_for_all_active(db=fake_db_with_insert.db)

    assert sweep.total_clients == 2
    assert sweep.succeeded == 1
    assert sweep.failed == 1
    assert len(sweep.errors) == 1
    assert sweep.errors[0]["client_id"] == "client-1"
    assert "broke" in sweep.errors[0]["error"]
    assert call_count["n"] == 2  # both attempted


def test_compute_health_for_all_active_counts_insufficient_data(
    mocker, fake_db_with_insert
):
    def fake_compute(client_id, db, trigger_type):
        return agent.HealthComputeResult(
            client_id=client_id,
            score=50,
            tier="yellow",
            insufficient_data=True,
            concerns_count=0,
            health_score_row_id="row-x",
            agent_run_id="run-x",
        )

    mocker.patch.object(agent, "compute_health_for_client", side_effect=fake_compute)

    sweep = agent.compute_health_for_all_active(db=fake_db_with_insert.db)

    assert sweep.succeeded == 2
    assert sweep.insufficient_data == 2


def test_compute_health_for_all_active_records_wall_clock_duration(
    mocker, fake_db_with_insert
):
    """V2 telemetry: SweepResult must carry duration_ms +
    avg_per_client_ms so the cron-ceiling watchpoint
    (docs/fulfillment/known-issues.md) has the data it needs to decide whether to
    re-architect."""
    def fake_compute(client_id, db, trigger_type):
        return agent.HealthComputeResult(
            client_id=client_id,
            score=80,
            tier="green",
            insufficient_data=False,
            concerns_count=0,
            health_score_row_id="row-x",
            agent_run_id="run-x",
        )

    mocker.patch.object(agent, "compute_health_for_client", side_effect=fake_compute)

    sweep = agent.compute_health_for_all_active(db=fake_db_with_insert.db)

    assert sweep.duration_ms >= 0
    assert sweep.avg_per_client_ms >= 0
    # 2 clients fixture, so per-client should be roughly half of total
    # (exact equality not asserted — integer division can underweight).
    assert sweep.avg_per_client_ms <= sweep.duration_ms
