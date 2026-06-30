"""Tests for the setter_call_reviewer call-type rubric split (migration 0121).

The reviewer grades two rubrics keyed by call_type:
  - outbound → booked / no_book_reason
  - revival  → closed / no_close_reason

These cover the structural validation that enforces the right outcome
pair per call_type, and the prompt selection.
"""

from __future__ import annotations

import json

import pytest

from agents.setter_call_reviewer.prompt import (
    BOOK_SYSTEM_PROMPT,
    CLOSE_SYSTEM_PROMPT,
)
from agents.setter_call_reviewer.reviewer import (
    ReviewError,
    _OUTCOME_FIELDS,
    _SYSTEM_PROMPTS,
    _parse_and_validate,
)

_BASE = {
    "sentiment": "Cool open, warmed mid-call, non-committal close.",
    "lead_score": 7,
    "lead_score_reason": "Qualified with one soft spot.",
    "should_be_dqd": False,
    "dq_reason": None,
    "setter_strengths": [],
    "setter_weaknesses": [],
    "lead_attributes": [],
}


def _payload(**outcome) -> str:
    return json.dumps({**_BASE, **outcome})


# --- outbound rubric -------------------------------------------------------


def test_outbound_accepts_booked_pair():
    parsed = _parse_and_validate(
        _payload(booked=False, no_book_reason="Wanted to talk to spouse."),
        "c1",
        "outbound",
    )
    assert parsed["booked"] is False
    assert parsed["no_book_reason"] == "Wanted to talk to spouse."


def test_outbound_rejects_booked_false_without_reason():
    with pytest.raises(ReviewError, match="no_book_reason"):
        _parse_and_validate(_payload(booked=False, no_book_reason=None), "c2", "outbound")


def test_outbound_rejects_revival_outcome_keys():
    # A revival-shaped payload is missing booked/no_book_reason → rejected.
    with pytest.raises(ReviewError, match="missing keys"):
        _parse_and_validate(_payload(closed=True, no_close_reason=None), "c3", "outbound")


# --- revival rubric --------------------------------------------------------


def test_revival_accepts_closed_pair():
    parsed = _parse_and_validate(
        _payload(closed=True, no_close_reason=None),
        "c4",
        "revival",
    )
    assert parsed["closed"] is True
    assert parsed["no_close_reason"] is None


def test_revival_rejects_closed_false_without_reason():
    with pytest.raises(ReviewError, match="no_close_reason"):
        _parse_and_validate(_payload(closed=False, no_close_reason=None), "c5", "revival")


def test_revival_rejects_booked_outcome_keys():
    # An outbound-shaped payload is missing closed/no_close_reason → rejected.
    with pytest.raises(ReviewError, match="missing keys"):
        _parse_and_validate(_payload(booked=True, no_book_reason=None), "c6", "revival")


# --- wiring ----------------------------------------------------------------


def test_outcome_fields_and_prompts_paired():
    assert _OUTCOME_FIELDS["outbound"] == ("booked", "no_book_reason")
    assert _OUTCOME_FIELDS["revival"] == ("closed", "no_close_reason")
    assert _SYSTEM_PROMPTS["outbound"] is BOOK_SYSTEM_PROMPT
    assert _SYSTEM_PROMPTS["revival"] is CLOSE_SYSTEM_PROMPT


def test_close_prompt_targets_phone_close_not_booking():
    assert '"closed"' in CLOSE_SYSTEM_PROMPT
    assert "no_close_reason" in CLOSE_SYSTEM_PROMPT
    assert "Digital College" in CLOSE_SYSTEM_PROMPT
    # The book rubric must NOT leak the close vocabulary, and vice-versa.
    assert '"closed"' not in BOOK_SYSTEM_PROMPT
    assert '"booked"' in BOOK_SYSTEM_PROMPT
