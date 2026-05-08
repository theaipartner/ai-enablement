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

    def limit(self, *_args, **_kwargs):
        return self

    def execute(self):
        if self._raise:
            raise RuntimeError("simulated DB blip")
        return SimpleNamespace(data=self._rows)


class _FakeDb:
    """Multi-table fake. `documents` holds the call_review rows tests
    care about; `agent_runs` + `client_health_scores` support the
    freshness-skip path's lookups. All three default to empty lists
    so existing tests keep working without scripting the new tables."""

    def __init__(
        self,
        rows: list[dict] | None = None,
        *,
        raise_on_execute: bool = False,
        agent_runs_rows: list[dict] | None = None,
        client_health_scores_rows: list[dict] | None = None,
        agent_runs_raise: bool = False,
        client_health_scores_raise: bool = False,
    ):
        self._documents = _FakeDocumentsTable(
            rows=rows, raise_on_execute=raise_on_execute
        )
        self._agent_runs = _FakeDocumentsTable(
            rows=agent_runs_rows or [], raise_on_execute=agent_runs_raise
        )
        self._client_health_scores = _FakeDocumentsTable(
            rows=client_health_scores_rows or [],
            raise_on_execute=client_health_scores_raise,
        )

    def table(self, name):
        if name == "documents":
            return self._documents
        if name == "agent_runs":
            return self._agent_runs
        if name == "client_health_scores":
            return self._client_health_scores
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


# ---------------------------------------------------------------------------
# Freshness filter (daily-cron architecture)
# ---------------------------------------------------------------------------
#
# Four paths covered:
#   1. No prior compute → falls through to LLM compute (recompute path)
#   2. Prior compute + no new reviews → skips LLM, returns prior Signal
#      with rewritten note + creates an agent_runs row tagged "skipped"
#   3. Prior compute + new review since → falls through to LLM compute
#   4. Prior compute exists but the prior client_health_scores row
#      doesn't have an ai_call_signal entry (V1.1→V2 transition shape)
#      → falls through to LLM compute (defensive fallback)


def _agent_run_row(
    *,
    started_at: str,
    output_summary: str = "contribution=70 reviews=2 concerns=1",
):
    """Mimic an agent_runs row shape — only the columns the freshness
    queries actually select."""
    return {
        "started_at": started_at,
        "output_summary": output_summary,
    }


def _client_health_scores_row_with_ai_signal(
    *,
    contribution: int = 70,
    note: str = "Original LLM-judged reasoning.",
    concerns: list | None = None,
):
    """A V2-shaped client_health_scores row. factors.signals[] has
    ai_call_signal as the first entry."""
    return {
        "factors": {
            "signals": [
                {
                    "name": "ai_call_signal",
                    "weight": WEIGHT_AI_CALL_SIGNAL,
                    "value": "2 reviews, watch",
                    "contribution": contribution,
                    "note": note,
                },
                {
                    "name": "call_cadence",
                    "weight": 0.20,
                    "value": "5 days ago",
                    "contribution": 100,
                    "note": "Most recent call 5 days ago.",
                },
            ],
            "concerns": concerns or [],
            "overall_reasoning": "Some prior reasoning.",
        }
    }


def test_freshness_no_prior_compute_falls_through_to_llm(stub_telemetry):
    """Client with no prior ai_call_signal agent_runs row → fresh
    compute. Confirms the "first time we see this client" gate."""
    rows = [
        _review_doc(
            "call-aaa", "2026-05-08T08:00:00+00:00", review=_sample_review()
        ),
    ]
    db = _FakeDb(
        rows=rows,
        agent_runs_rows=[],  # no prior compute on record
        client_health_scores_rows=[],
    )
    response = json.dumps(
        {"contribution": 80, "reasoning": "Strong call.", "concerns": []}
    )
    with patch(
        "agents.gregory.ai_call_signal.complete",
        return_value=_completion(response),
    ) as comp:
        signal, _ = acs.compute_ai_call_signal(db, "client-x")

    # Recompute path fired — Sonnet was called, signal is the new value.
    comp.assert_called_once()
    assert signal["contribution"] == 80
    # Note from the new compute, not a "reused" note.
    assert "Strong call." in signal["note"]
    assert "reused" not in signal["note"].lower()


def test_freshness_no_new_reviews_returns_prior_signal_skips_llm(
    stub_telemetry,
):
    """Prior compute exists + latest call_review created_at <= prior
    compute started_at → reuse prior Signal verbatim (note rewritten),
    NO Sonnet call, agent_runs row opened with output_summary starting
    with 'skipped'."""
    prior_compute_iso = "2026-05-08T09:00:00+00:00"
    older_review_iso = "2026-05-07T15:00:00+00:00"

    db = _FakeDb(
        rows=[
            # call_review document for this client, but its created_at
            # predates the prior compute.
            {
                "title": "Old review",
                "content": json.dumps(_sample_review()),
                "metadata": {"call_id": "call-old", "started_at": older_review_iso},
                "created_at": older_review_iso,
            }
        ],
        agent_runs_rows=[
            _agent_run_row(started_at=prior_compute_iso),
        ],
        client_health_scores_rows=[
            _client_health_scores_row_with_ai_signal(
                contribution=72,
                note="Earlier-day reasoning that should be preserved.",
                concerns=[
                    {
                        "text": "Watchpoint from earlier compute.",
                        "severity": "low",
                        "source_call_ids": ["call-old"],
                    }
                ],
            )
        ],
    )
    with patch("agents.gregory.ai_call_signal.complete") as comp:
        signal, concerns = acs.compute_ai_call_signal(db, "client-x")

    # Skip path fired — NO Sonnet call.
    comp.assert_not_called()
    # Prior signal returned with rewritten note.
    assert signal["contribution"] == 72
    assert signal["weight"] == WEIGHT_AI_CALL_SIGNAL
    assert "reused" in signal["note"].lower() or "no new call_review" in signal["note"].lower()
    # Original LLM-judged reasoning preserved after the separator.
    assert "Earlier-day reasoning that should be preserved." in signal["note"]
    # Prior concerns flow through.
    assert len(concerns) == 1
    assert concerns[0]["text"] == "Watchpoint from earlier compute."

    # Telemetry: agent_runs row opened, closed with status=success +
    # output_summary starting with "skipped".
    stub_telemetry.start.assert_called_once()
    assert stub_telemetry.end.call_args.kwargs["status"] == "success"
    assert stub_telemetry.end.call_args.kwargs["output_summary"].startswith(
        "skipped"
    )


def test_freshness_new_review_since_prior_compute_triggers_recompute(
    stub_telemetry,
):
    """Prior compute exists + at least one call_review with created_at
    > prior compute started_at → recompute (LLM call fires)."""
    prior_compute_iso = "2026-05-07T09:00:00+00:00"
    new_review_iso = "2026-05-08T08:00:00+00:00"  # AFTER prior compute

    db = _FakeDb(
        rows=[
            {
                "title": "Fresh review",
                "content": json.dumps(_sample_review()),
                "metadata": {"call_id": "call-new", "started_at": new_review_iso},
                "created_at": new_review_iso,
            }
        ],
        agent_runs_rows=[
            _agent_run_row(started_at=prior_compute_iso),
        ],
        client_health_scores_rows=[
            _client_health_scores_row_with_ai_signal(),
        ],
    )
    response = json.dumps(
        {
            "contribution": 65,
            "reasoning": "New review pulls score down.",
            "concerns": [],
        }
    )
    with patch(
        "agents.gregory.ai_call_signal.complete",
        return_value=_completion(response),
    ) as comp:
        signal, _ = acs.compute_ai_call_signal(db, "client-x")

    # Recompute fired — Sonnet called, new contribution.
    comp.assert_called_once()
    assert signal["contribution"] == 65
    assert "New review pulls score down." in signal["note"]


def test_freshness_v1_1_transition_falls_through_to_recompute(stub_telemetry):
    """Prior compute agent_runs row exists, but the most recent
    client_health_scores row is V1.1-shaped (no ai_call_signal entry
    in factors.signals[]). Defensive fallback: recompute to land V2
    shape rather than returning a malformed prior Signal."""
    prior_compute_iso = "2026-05-08T09:00:00+00:00"
    older_review_iso = "2026-05-07T15:00:00+00:00"

    db = _FakeDb(
        rows=[
            {
                "title": "Old review",
                "content": json.dumps(_sample_review()),
                "metadata": {"call_id": "call-old", "started_at": older_review_iso},
                "created_at": older_review_iso,
            }
        ],
        agent_runs_rows=[
            _agent_run_row(started_at=prior_compute_iso),
        ],
        client_health_scores_rows=[
            # V1.1 shape — no ai_call_signal entry.
            {
                "factors": {
                    "signals": [
                        {
                            "name": "call_cadence",
                            "weight": 0.40,
                            "contribution": 50,
                            "note": "Most recent call 14 days ago.",
                        },
                        {
                            "name": "open_action_items",
                            "weight": 0.20,
                            "contribution": 100,
                            "note": "0 open.",
                        },
                    ],
                    "concerns": [],
                }
            }
        ],
    )
    response = json.dumps(
        {
            "contribution": 70,
            "reasoning": "Recomputed after V1.1 transition.",
            "concerns": [],
        }
    )
    with patch(
        "agents.gregory.ai_call_signal.complete",
        return_value=_completion(response),
    ) as comp:
        signal, _ = acs.compute_ai_call_signal(db, "client-x")

    # Recompute fired — defensive fallback past the missing prior signal.
    comp.assert_called_once()
    assert signal["contribution"] == 70
    assert signal["name"] == "ai_call_signal"  # V2 shape


def test_freshness_skip_path_records_telemetry_with_skipped_prefix(
    stub_telemetry,
):
    """Explicit assertion: the skip path's agent_runs row has
    output_summary starting with 'skipped' so cost rollups can split
    skip from compute via WHERE output_summary LIKE 'skipped%'."""
    prior_compute_iso = "2026-05-08T09:00:00+00:00"
    older_review_iso = "2026-05-07T15:00:00+00:00"

    db = _FakeDb(
        rows=[
            {
                "title": "Old review",
                "content": json.dumps(_sample_review()),
                "metadata": {"call_id": "call-old", "started_at": older_review_iso},
                "created_at": older_review_iso,
            }
        ],
        agent_runs_rows=[
            _agent_run_row(started_at=prior_compute_iso),
        ],
        client_health_scores_rows=[
            _client_health_scores_row_with_ai_signal(),
        ],
    )
    with patch("agents.gregory.ai_call_signal.complete"):
        acs.compute_ai_call_signal(db, "client-x")

    # start_agent_run called once with the skip-path trigger_metadata
    # (carries skipped=True + last_compute_at + latest_review_at).
    stub_telemetry.start.assert_called_once()
    start_kwargs = stub_telemetry.start.call_args.kwargs
    assert start_kwargs["agent_name"] == "ai_call_signal"
    assert start_kwargs["trigger_metadata"]["skipped"] is True
    assert start_kwargs["trigger_metadata"]["last_compute_at"] == prior_compute_iso

    # end_agent_run called with status=success + 'skipped' prefix.
    end_kwargs = stub_telemetry.end.call_args.kwargs
    assert end_kwargs["status"] == "success"
    assert end_kwargs["output_summary"].startswith("skipped")


def test_freshness_excludes_prior_skip_rows_from_last_compute_lookup(
    stub_telemetry,
):
    """The last-compute query MUST exclude prior skip rows. Otherwise
    a long string of skips could hide a stale "real compute" timestamp
    and let new reviews go un-recomputed indefinitely. The query
    iterates the most recent N agent_runs rows and skips entries whose
    output_summary starts with 'skipped'."""
    real_compute_iso = "2026-05-01T09:00:00+00:00"  # OLD real compute
    skip1_iso = "2026-05-06T09:00:00+00:00"
    skip2_iso = "2026-05-07T09:00:00+00:00"
    new_review_iso = "2026-05-05T15:00:00+00:00"  # AFTER real compute, BEFORE skips

    db = _FakeDb(
        rows=[
            {
                "title": "Review that landed AFTER real compute",
                "content": json.dumps(_sample_review()),
                "metadata": {"call_id": "call-new", "started_at": new_review_iso},
                "created_at": new_review_iso,
            }
        ],
        # agent_runs ordered desc — skips most recent, real compute oldest.
        agent_runs_rows=[
            _agent_run_row(
                started_at=skip2_iso,
                output_summary="skipped — fresh (last_compute=2026-05-01...; ...)",
            ),
            _agent_run_row(
                started_at=skip1_iso,
                output_summary="skipped — fresh (last_compute=2026-05-01...; ...)",
            ),
            _agent_run_row(
                started_at=real_compute_iso,
                output_summary="contribution=70 reviews=1 concerns=0",
            ),
        ],
        client_health_scores_rows=[
            _client_health_scores_row_with_ai_signal(),
        ],
    )
    response = json.dumps(
        {
            "contribution": 60,
            "reasoning": "Recomputed because review > real compute.",
            "concerns": [],
        }
    )
    with patch(
        "agents.gregory.ai_call_signal.complete",
        return_value=_completion(response),
    ) as comp:
        signal, _ = acs.compute_ai_call_signal(db, "client-x")

    # Recompute fired — the skip-row exclusion correctly identified
    # real_compute_iso as the last actual compute, saw new_review_iso
    # is after it, and triggered recompute.
    comp.assert_called_once()
    assert signal["contribution"] == 60
