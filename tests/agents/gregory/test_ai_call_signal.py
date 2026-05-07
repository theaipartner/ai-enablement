"""Unit tests for agents.gregory.ai_call_signal.

Mocks the supabase client and the Claude `complete()` call. Covers:

  - Happy path: 3 reviews returned, Claude returns valid JSON, signal
    has expected contribution + concerns
  - Insufficient data: 0 reviews → neutral 50 with explicit note,
    NO Claude call fired, NO agent_runs row opened
  - Parse failure: malformed JSON → neutral 50 with parse-error note,
    agent_runs row closed with status=error
  - DB blip: documents fetch raises → neutral 50 with db-error note,
    NO Claude call, NO agent_runs row opened
  - LLM blip: Claude call raises → neutral 50 with llm-error note,
    agent_runs row closed with status=error
  - Source-call-id hallucination defense: Claude returns concerns
    referencing call_ids NOT in the input → those ids are silently
    filtered out at parse time
  - Out-of-bounds contribution clamping
  - Concerns shape matches dashboard expectations
    ({text, severity, source_call_ids})
"""

from __future__ import annotations

import json
from decimal import Decimal
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest

from agents.gregory import ai_call_signal as acs
from agents.gregory.signals import NEUTRAL_CONTRIBUTION, WEIGHT_AI_CALL_SIGNAL


# ---------------------------------------------------------------------------
# Fake supabase client
# ---------------------------------------------------------------------------


class _FakeDocumentsTable:
    """Stub the .table('documents').select(...).eq(...).filter(...).order(...).execute()
    chain with a single canned response. raise_on_execute lets a test
    simulate a DB failure mid-chain."""

    def __init__(
        self,
        rows: list[dict] | None = None,
        *,
        raise_on_execute: bool = False,
    ):
        self._rows = rows or []
        self._raise = raise_on_execute

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, *_args, **_kwargs):
        return self

    def filter(self, *_args, **_kwargs):
        return self

    def order(self, *_args, **_kwargs):
        return self

    def execute(self):
        if self._raise:
            raise RuntimeError("simulated DB blip")
        return SimpleNamespace(data=self._rows)


class _FakeDb:
    def __init__(
        self,
        rows: list[dict] | None = None,
        *,
        raise_on_execute: bool = False,
    ):
        self._documents = _FakeDocumentsTable(
            rows=rows, raise_on_execute=raise_on_execute
        )

    def table(self, name):
        if name == "documents":
            return self._documents
        raise AssertionError(f"unexpected table {name!r}")


# ---------------------------------------------------------------------------
# Test fixtures
# ---------------------------------------------------------------------------


def _review_doc(call_id: str, started_at: str, *, review: dict) -> dict:
    """Build a fake `documents` row matching call_review shape."""
    return {
        "title": f"Test call {call_id[:6]}",
        "content": json.dumps(review),
        "metadata": {"call_id": call_id, "started_at": started_at},
        "created_at": started_at,
    }


def _sample_review(
    pain: list | None = None,
    wins: list | None = None,
    dodged: list | None = None,
    arc: str = "Steady call, ended productive.",
) -> dict:
    return {
        "pain_points": pain
        or [{"description": "minor friction", "evidence": "client said 'eh'"}],
        "wins": wins
        or [{"description": "first launch", "evidence": "client closed deal"}],
        "dodged_questions": dodged or [],
        "sentiment_arc": arc,
    }


def _completion(text: str):
    return SimpleNamespace(
        text=text,
        model="claude-sonnet-4-6",
        input_tokens=500,
        output_tokens=300,
        cost_usd=Decimal("0.005"),
        raw=None,
    )


@pytest.fixture
def stub_telemetry():
    with patch("agents.gregory.ai_call_signal.start_agent_run") as start, patch(
        "agents.gregory.ai_call_signal.end_agent_run"
    ) as end:
        start.return_value = "run-1"
        yield SimpleNamespace(start=start, end=end)


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_happy_path_returns_signal_and_concerns(stub_telemetry):
    rows = [
        _review_doc(
            "call-aaa",
            "2026-05-01T12:00:00+00:00",
            review=_sample_review(),
        ),
        _review_doc(
            "call-bbb",
            "2026-05-04T12:00:00+00:00",
            review=_sample_review(arc="Started rough, ended hopeful."),
        ),
        _review_doc(
            "call-ccc",
            "2026-05-07T12:00:00+00:00",
            review=_sample_review(),
        ),
    ]
    db = _FakeDb(rows=rows)
    claude_response = json.dumps(
        {
            "contribution": 78,
            "reasoning": "Trajectory positive across 3 calls; consistent wins.",
            "concerns": [
                {
                    "text": "Watch for follow-through on the launch milestone.",
                    "severity": "low",
                    "source_call_ids": ["call-bbb"],
                }
            ],
        }
    )

    with patch(
        "agents.gregory.ai_call_signal.complete",
        return_value=_completion(claude_response),
    ) as comp:
        signal, concerns = acs.compute_ai_call_signal(db, "client-x")

    assert signal["name"] == "ai_call_signal"
    assert signal["weight"] == WEIGHT_AI_CALL_SIGNAL
    assert signal["contribution"] == 78
    assert "Trajectory positive" in signal["note"]
    assert "3 reviews" in signal["value"]
    assert concerns == [
        {
            "text": "Watch for follow-through on the launch milestone.",
            "severity": "low",
            "source_call_ids": ["call-bbb"],
        }
    ]
    # Telemetry: success path
    assert stub_telemetry.start.call_count == 1
    assert stub_telemetry.end.call_args.kwargs["status"] == "success"
    # run_id wired through to claude.complete for cost attribution
    assert comp.call_args.kwargs["run_id"] == "run-1"


# ---------------------------------------------------------------------------
# Insufficient data
# ---------------------------------------------------------------------------


def test_insufficient_data_returns_neutral_no_claude_no_agent_run(stub_telemetry):
    db = _FakeDb(rows=[])
    with patch("agents.gregory.ai_call_signal.complete") as comp:
        signal, concerns = acs.compute_ai_call_signal(db, "client-x")

    assert signal["contribution"] == NEUTRAL_CONTRIBUTION
    assert "insufficient data" in signal["note"].lower()
    assert "no call reviews" in signal["note"].lower()
    assert concerns == []
    comp.assert_not_called()
    # No agent_runs row opened — caller doesn't pay for empty input.
    stub_telemetry.start.assert_not_called()


# ---------------------------------------------------------------------------
# DB blip
# ---------------------------------------------------------------------------


def test_db_failure_returns_neutral_no_claude_no_agent_run(stub_telemetry):
    db = _FakeDb(rows=[], raise_on_execute=True)
    with patch("agents.gregory.ai_call_signal.complete") as comp:
        signal, concerns = acs.compute_ai_call_signal(db, "client-x")

    assert signal["contribution"] == NEUTRAL_CONTRIBUTION
    assert "documents fetch failed" in signal["note"].lower()
    assert concerns == []
    comp.assert_not_called()
    stub_telemetry.start.assert_not_called()


# ---------------------------------------------------------------------------
# LLM blip
# ---------------------------------------------------------------------------


def test_llm_failure_returns_neutral_with_run_closed_error(stub_telemetry):
    rows = [
        _review_doc(
            "call-aaa", "2026-05-01T12:00:00+00:00", review=_sample_review()
        ),
    ]
    db = _FakeDb(rows=rows)
    with patch(
        "agents.gregory.ai_call_signal.complete",
        side_effect=RuntimeError("anthropic 503"),
    ):
        signal, concerns = acs.compute_ai_call_signal(db, "client-x")

    assert signal["contribution"] == NEUTRAL_CONTRIBUTION
    assert "claude call failed" in signal["note"].lower()
    assert "anthropic 503" in signal["note"]
    assert concerns == []
    # agent_runs opened but closed with error status
    stub_telemetry.start.assert_called_once()
    assert stub_telemetry.end.call_args.kwargs["status"] == "error"
    assert "llm_call_failed" in stub_telemetry.end.call_args.kwargs["error_message"]


# ---------------------------------------------------------------------------
# Parse failure
# ---------------------------------------------------------------------------


def test_malformed_json_returns_neutral_with_run_closed_error(stub_telemetry):
    rows = [
        _review_doc(
            "call-aaa", "2026-05-01T12:00:00+00:00", review=_sample_review()
        ),
    ]
    db = _FakeDb(rows=rows)
    with patch(
        "agents.gregory.ai_call_signal.complete",
        return_value=_completion("not valid json at all"),
    ):
        signal, concerns = acs.compute_ai_call_signal(db, "client-x")

    assert signal["contribution"] == NEUTRAL_CONTRIBUTION
    assert "parse failed" in signal["note"].lower()
    assert concerns == []
    assert stub_telemetry.end.call_args.kwargs["status"] == "error"
    assert "parse_failed" in stub_telemetry.end.call_args.kwargs["error_message"]


def test_missing_required_key_returns_neutral_with_run_closed_error(stub_telemetry):
    rows = [
        _review_doc(
            "call-aaa", "2026-05-01T12:00:00+00:00", review=_sample_review()
        ),
    ]
    db = _FakeDb(rows=rows)
    bad = json.dumps({"contribution": 70, "concerns": []})  # missing reasoning
    with patch(
        "agents.gregory.ai_call_signal.complete",
        return_value=_completion(bad),
    ):
        signal, _ = acs.compute_ai_call_signal(db, "client-x")

    assert signal["contribution"] == NEUTRAL_CONTRIBUTION
    assert stub_telemetry.end.call_args.kwargs["status"] == "error"


# ---------------------------------------------------------------------------
# Defensive parsing
# ---------------------------------------------------------------------------


def test_hallucinated_source_call_ids_are_filtered(stub_telemetry):
    """The model must reference call_ids it actually saw. If it
    invents a UUID, the filter drops it before it lands in
    factors.concerns[]."""
    rows = [
        _review_doc(
            "call-real", "2026-05-01T12:00:00+00:00", review=_sample_review()
        ),
    ]
    db = _FakeDb(rows=rows)
    response = json.dumps(
        {
            "contribution": 60,
            "reasoning": "Mixed signal.",
            "concerns": [
                {
                    "text": "Real concern.",
                    "severity": "medium",
                    # 'call-real' is in input; 'call-hallucinated' is not.
                    "source_call_ids": ["call-real", "call-hallucinated"],
                }
            ],
        }
    )
    with patch(
        "agents.gregory.ai_call_signal.complete",
        return_value=_completion(response),
    ):
        _, concerns = acs.compute_ai_call_signal(db, "client-x")

    assert len(concerns) == 1
    assert concerns[0]["source_call_ids"] == ["call-real"]


def test_contribution_clamped_to_0_100(stub_telemetry):
    rows = [
        _review_doc(
            "call-aaa", "2026-05-01T12:00:00+00:00", review=_sample_review()
        ),
    ]
    db = _FakeDb(rows=rows)
    response = json.dumps(
        {"contribution": 150, "reasoning": "model overshot.", "concerns": []}
    )
    with patch(
        "agents.gregory.ai_call_signal.complete",
        return_value=_completion(response),
    ):
        signal, _ = acs.compute_ai_call_signal(db, "client-x")

    assert signal["contribution"] == 100
    # Run still closes with success — out-of-bounds is logged not raised.
    assert stub_telemetry.end.call_args.kwargs["status"] == "success"


def test_negative_contribution_clamped_to_0(stub_telemetry):
    rows = [
        _review_doc(
            "call-aaa", "2026-05-01T12:00:00+00:00", review=_sample_review()
        ),
    ]
    db = _FakeDb(rows=rows)
    response = json.dumps(
        {"contribution": -10, "reasoning": "model undershot.", "concerns": []}
    )
    with patch(
        "agents.gregory.ai_call_signal.complete",
        return_value=_completion(response),
    ):
        signal, _ = acs.compute_ai_call_signal(db, "client-x")

    assert signal["contribution"] == 0


def test_strips_markdown_fences(stub_telemetry):
    rows = [
        _review_doc(
            "call-aaa", "2026-05-01T12:00:00+00:00", review=_sample_review()
        ),
    ]
    db = _FakeDb(rows=rows)
    body = json.dumps(
        {"contribution": 70, "reasoning": "Healthy.", "concerns": []}
    )
    fenced = f"```json\n{body}\n```"
    with patch(
        "agents.gregory.ai_call_signal.complete",
        return_value=_completion(fenced),
    ):
        signal, _ = acs.compute_ai_call_signal(db, "client-x")

    assert signal["contribution"] == 70


def test_concerns_with_invalid_severity_drops_severity_keeps_concern(stub_telemetry):
    rows = [
        _review_doc(
            "call-aaa", "2026-05-01T12:00:00+00:00", review=_sample_review()
        ),
    ]
    db = _FakeDb(rows=rows)
    response = json.dumps(
        {
            "contribution": 60,
            "reasoning": "Mixed.",
            "concerns": [
                {
                    "text": "Some concern.",
                    "severity": "very-bad",  # not in allowed set
                    "source_call_ids": [],
                }
            ],
        }
    )
    with patch(
        "agents.gregory.ai_call_signal.complete",
        return_value=_completion(response),
    ):
        _, concerns = acs.compute_ai_call_signal(db, "client-x")

    assert len(concerns) == 1
    assert concerns[0]["text"] == "Some concern."
    assert "severity" not in concerns[0]  # dropped, not crashed
