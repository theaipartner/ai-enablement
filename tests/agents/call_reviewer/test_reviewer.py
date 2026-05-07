"""Unit tests for agents.call_reviewer.reviewer.

Mocks the Claude client (no real API calls) and the supabase client
(no real DB). Covers JSON parsing happy-path and three failure modes
(markdown fences, missing keys, malformed JSON), plus the no-transcript
ValueError gate.
"""

from __future__ import annotations

import json
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from agents.call_reviewer import reviewer as r


_VALID_REVIEW = {
    "pain_points": [
        {"description": "Slow launch ramp", "evidence": "client said 'I'm 3 weeks behind'"}
    ],
    "wins": [
        {"description": "First $5k month", "evidence": "client mentioned closing two deals"}
    ],
    "dodged_questions": [],
    "sentiment_arc": "Started anxious, ended hopeful after the next-step plan.",
}


# ---------------------------------------------------------------------------
# Fake DB
# ---------------------------------------------------------------------------


class _FakeCallTable:
    """Stub the .table('calls').select(...).eq(...).maybe_single().execute()
    chain. Captures the last `eq` filter so tests can assert it.
    """

    def __init__(self, row):
        self._row = row

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, *_args, **_kwargs):
        return self

    def maybe_single(self):
        return self

    def execute(self):
        return SimpleNamespace(data=self._row)


class _FakeDb:
    def __init__(self, call_row):
        self._call_row = call_row

    def table(self, name):
        if name == "calls":
            return _FakeCallTable(self._call_row)
        raise AssertionError(f"unexpected table {name!r}")


def _call_row(transcript="Speaker A: hi\nSpeaker B: hello"):
    return {
        "id": "call-1",
        "transcript": transcript,
        "primary_client_id": "client-1",
        "started_at": "2026-05-01T12:00:00+00:00",
        "call_category": "client",
    }


def _completion(text):
    return SimpleNamespace(
        text=text,
        model="claude-sonnet-4-6",
        input_tokens=100,
        output_tokens=50,
        cost_usd=Decimal("0.001"),
        raw=None,
    )


# ---------------------------------------------------------------------------
# Telemetry stubs (no DB, no API)
# ---------------------------------------------------------------------------


@pytest.fixture
def stub_telemetry():
    with patch("agents.call_reviewer.reviewer.start_agent_run") as start, \
         patch("agents.call_reviewer.reviewer.end_agent_run") as end:
        start.return_value = "run-1"
        yield SimpleNamespace(start=start, end=end)


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_review_call_happy_path_returns_parsed_dict(stub_telemetry):
    db = _FakeDb(_call_row())
    fake_text = json.dumps(_VALID_REVIEW)

    with patch(
        "agents.call_reviewer.reviewer.complete",
        return_value=_completion(fake_text),
    ) as comp:
        result = r.review_call(db, "call-1")

    assert result == _VALID_REVIEW
    # End run called with success.
    assert stub_telemetry.end.call_args.kwargs["status"] == "success"
    # Claude called with run_id wired through so cost auto-writes.
    assert comp.call_args.kwargs["run_id"] == "run-1"


# ---------------------------------------------------------------------------
# Parse failures
# ---------------------------------------------------------------------------


def test_review_call_strips_markdown_fences(stub_telemetry):
    db = _FakeDb(_call_row())
    body = json.dumps(_VALID_REVIEW)
    fenced = f"```json\n{body}\n```"

    with patch(
        "agents.call_reviewer.reviewer.complete",
        return_value=_completion(fenced),
    ):
        result = r.review_call(db, "call-1")

    assert result == _VALID_REVIEW


def test_review_call_strips_leading_and_trailing_prose(stub_telemetry):
    db = _FakeDb(_call_row())
    body = json.dumps(_VALID_REVIEW)
    noisy = f"Sure! Here's the review:\n\n{body}\n\nLet me know if you want changes."

    with patch(
        "agents.call_reviewer.reviewer.complete",
        return_value=_completion(noisy),
    ):
        result = r.review_call(db, "call-1")

    assert result == _VALID_REVIEW


def test_review_call_raises_on_malformed_json(stub_telemetry):
    db = _FakeDb(_call_row())
    bad = "{not really json at all"

    with patch(
        "agents.call_reviewer.reviewer.complete",
        return_value=_completion(bad),
    ):
        with pytest.raises(ValueError, match=r"not valid JSON|did not contain"):
            r.review_call(db, "call-1")

    # Telemetry must close the run on the error path BEFORE re-raise.
    assert stub_telemetry.end.call_args.kwargs["status"] == "error"


def test_review_call_raises_on_missing_required_key(stub_telemetry):
    db = _FakeDb(_call_row())
    bad_review = dict(_VALID_REVIEW)
    bad_review.pop("dodged_questions")
    fake_text = json.dumps(bad_review)

    with patch(
        "agents.call_reviewer.reviewer.complete",
        return_value=_completion(fake_text),
    ):
        with pytest.raises(ValueError, match=r"dodged_questions"):
            r.review_call(db, "call-1")

    assert stub_telemetry.end.call_args.kwargs["status"] == "error"


def test_review_call_raises_on_wrong_type_for_array_key(stub_telemetry):
    db = _FakeDb(_call_row())
    bad_review = dict(_VALID_REVIEW)
    bad_review["pain_points"] = "should be a list"
    fake_text = json.dumps(bad_review)

    with patch(
        "agents.call_reviewer.reviewer.complete",
        return_value=_completion(fake_text),
    ):
        with pytest.raises(ValueError, match=r"pain_points"):
            r.review_call(db, "call-1")


# ---------------------------------------------------------------------------
# Pre-Claude gates
# ---------------------------------------------------------------------------


def test_review_call_raises_on_missing_call(stub_telemetry):
    db = _FakeDb(call_row=None)
    with patch("agents.call_reviewer.reviewer.complete") as comp:
        with pytest.raises(ValueError, match=r"call call-1 not found"):
            r.review_call(db, "call-1")
    comp.assert_not_called()
    # No run was opened (raise happens before start_agent_run).
    stub_telemetry.start.assert_not_called()


def test_review_call_raises_on_empty_transcript(stub_telemetry):
    db = _FakeDb(_call_row(transcript=""))
    with patch("agents.call_reviewer.reviewer.complete") as comp:
        with pytest.raises(ValueError, match=r"no transcript"):
            r.review_call(db, "call-1")
    comp.assert_not_called()
    stub_telemetry.start.assert_not_called()


def test_review_call_raises_on_whitespace_only_transcript(stub_telemetry):
    db = _FakeDb(_call_row(transcript="   \n  \t\n"))
    with patch("agents.call_reviewer.reviewer.complete") as comp:
        with pytest.raises(ValueError, match=r"no transcript"):
            r.review_call(db, "call-1")
    comp.assert_not_called()
