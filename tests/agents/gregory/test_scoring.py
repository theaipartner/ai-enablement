"""Tests for agents.gregory.scoring.

Pure rubric tests — no DB, no Claude. Cover tier thresholds + the
insufficient-data default.
"""

from __future__ import annotations

from agents.gregory import scoring
from agents.gregory.signals import (
    NEUTRAL_CONTRIBUTION,
    WEIGHT_AI_CALL_SIGNAL,
    WEIGHT_CALL_CADENCE,
    WEIGHT_OVERDUE_ACTION_ITEMS,
    WEIGHT_LATEST_NPS,
    Signal,
)


def _signal(name: str, contribution: int, weight: float) -> Signal:
    return Signal(
        name=name,
        weight=weight,
        value=str(contribution),
        contribution=contribution,
        note="test fixture",
    )


# ---------------------------------------------------------------------------
# Tier thresholds — V2 four-signal rubric
# ---------------------------------------------------------------------------
#
# V2 weights: ai 0.50, cadence 0.20, overdue 0.10, nps 0.20 (sum 1.0).
# Expected scores (weighted average) are computed by hand below so a
# reviewer can verify the math.


def test_all_high_signals_tier_green():
    # 0.50*100 + 0.20*100 + 0.10*100 + 0.20*90 = 50+20+10+18 = 98
    sigs = [
        _signal("ai_call_signal", 100, WEIGHT_AI_CALL_SIGNAL),
        _signal("call_cadence", 100, WEIGHT_CALL_CADENCE),
        _signal("overdue_action_items", 100, WEIGHT_OVERDUE_ACTION_ITEMS),
        _signal("latest_nps", 90, WEIGHT_LATEST_NPS),
    ]

    result = scoring.score_signals(sigs)

    assert result["tier"] == "green"
    assert result["score"] == 98
    assert result["insufficient_data"] is False


def test_mid_score_lands_yellow():
    # 0.50*55 + 0.20*50 + 0.10*70 + 0.20*60 = 27.5+10+7+12 = 56.5 → 57
    sigs = [
        _signal("ai_call_signal", 55, WEIGHT_AI_CALL_SIGNAL),
        _signal("call_cadence", 50, WEIGHT_CALL_CADENCE),
        _signal("overdue_action_items", 70, WEIGHT_OVERDUE_ACTION_ITEMS),
        _signal("latest_nps", 60, WEIGHT_LATEST_NPS),
    ]

    result = scoring.score_signals(sigs)

    assert result["tier"] == "yellow"
    assert 40 <= result["score"] < 70


def test_low_score_lands_red():
    # 0.50*20 + 0.20*0 + 0.10*0 + 0.20*20 = 10+0+0+4 = 14
    sigs = [
        _signal("ai_call_signal", 20, WEIGHT_AI_CALL_SIGNAL),
        _signal("call_cadence", 0, WEIGHT_CALL_CADENCE),
        _signal("overdue_action_items", 0, WEIGHT_OVERDUE_ACTION_ITEMS),
        _signal("latest_nps", 20, WEIGHT_LATEST_NPS),
    ]

    result = scoring.score_signals(sigs)

    assert result["tier"] == "red"
    assert result["score"] < 40


def test_never_called_client_lands_yellow_not_green():
    """V2 weight rebalance fix for the M3.4 'never-called-clients-land-green'
    issue. With no calls, no reviews, no NPS, but a clean overdue docket
    (count=0 → 100), V1.1 weights produced score=70 (green). V2 weights
    produce 0.50*50 + 0.20*50 + 0.10*100 + 0.20*50 = 55 (yellow). The
    AI signal's 0.50 weight on a neutral 50 default structurally
    prevents the silent green."""
    sigs = [
        _signal("ai_call_signal", NEUTRAL_CONTRIBUTION, WEIGHT_AI_CALL_SIGNAL),
        _signal("call_cadence", NEUTRAL_CONTRIBUTION, WEIGHT_CALL_CADENCE),
        _signal("overdue_action_items", 100, WEIGHT_OVERDUE_ACTION_ITEMS),
        _signal("latest_nps", NEUTRAL_CONTRIBUTION, WEIGHT_LATEST_NPS),
    ]

    result = scoring.score_signals(sigs)

    assert result["tier"] == "yellow"
    assert result["score"] == 55
    # Not in the all-neutral case (overdue contributes 100), so this
    # is real-data yellow, not insufficient-data yellow.
    assert result["insufficient_data"] is False


# ---------------------------------------------------------------------------
# Insufficient-data default
# ---------------------------------------------------------------------------


def test_all_neutral_lands_yellow_50_with_insufficient_flag():
    """The "no data anywhere" case: every signal returned the neutral
    contribution. Brain MUST NOT ship green — yellow with the
    insufficient_data flag set."""
    sigs = [
        _signal("ai_call_signal", NEUTRAL_CONTRIBUTION, WEIGHT_AI_CALL_SIGNAL),
        _signal("call_cadence", NEUTRAL_CONTRIBUTION, WEIGHT_CALL_CADENCE),
        _signal("overdue_action_items", NEUTRAL_CONTRIBUTION, WEIGHT_OVERDUE_ACTION_ITEMS),
        _signal("latest_nps", NEUTRAL_CONTRIBUTION, WEIGHT_LATEST_NPS),
    ]

    result = scoring.score_signals(sigs)

    assert result["tier"] == "yellow"
    assert result["score"] == 50
    assert result["insufficient_data"] is True


def test_one_real_signal_overrides_insufficient_flag():
    """Even one signal with real data takes the brain out of the
    'insufficient data' default — score then follows the rubric."""
    sigs = [
        _signal("ai_call_signal", NEUTRAL_CONTRIBUTION, WEIGHT_AI_CALL_SIGNAL),
        _signal("call_cadence", 100, WEIGHT_CALL_CADENCE),
        _signal("overdue_action_items", NEUTRAL_CONTRIBUTION, WEIGHT_OVERDUE_ACTION_ITEMS),
        _signal("latest_nps", NEUTRAL_CONTRIBUTION, WEIGHT_LATEST_NPS),
    ]

    result = scoring.score_signals(sigs)

    assert result["insufficient_data"] is False


def test_empty_signals_list_lands_yellow_with_flag():
    result = scoring.score_signals([])
    assert result["tier"] == "yellow"
    assert result["insufficient_data"] is True


# ---------------------------------------------------------------------------
# Score boundaries
# ---------------------------------------------------------------------------


def test_score_is_clamped_to_0_to_100():
    sigs = [_signal("call_cadence", 200, WEIGHT_CALL_CADENCE)]
    result = scoring.score_signals(sigs)
    assert 0 <= result["score"] <= 100


# ---------------------------------------------------------------------------
# overall_reasoning
# ---------------------------------------------------------------------------


def test_overall_reasoning_insufficient_data_says_so():
    sigs = [
        _signal("call_cadence", NEUTRAL_CONTRIBUTION, WEIGHT_CALL_CADENCE),
    ]
    result = scoring.score_signals(sigs)
    text = scoring.build_overall_reasoning(sigs, result, concerns_count=0)
    assert "insufficient" in text.lower()


def test_overall_reasoning_includes_signal_breakdown():
    sigs = [
        _signal("ai_call_signal", 80, WEIGHT_AI_CALL_SIGNAL),
        _signal("call_cadence", 100, WEIGHT_CALL_CADENCE),
        _signal("overdue_action_items", 100, WEIGHT_OVERDUE_ACTION_ITEMS),
        _signal("latest_nps", 70, WEIGHT_LATEST_NPS),
    ]
    result = scoring.score_signals(sigs)
    text = scoring.build_overall_reasoning(sigs, result, concerns_count=2)
    # Includes signal names + contributions
    assert "ai_call_signal=80" in text
    assert "call_cadence=100" in text
    assert "2 qualitative concerns" in text


def test_overall_reasoning_singular_concern():
    sigs = [_signal("call_cadence", 100, WEIGHT_CALL_CADENCE)]
    result = scoring.score_signals(sigs)
    text = scoring.build_overall_reasoning(sigs, result, concerns_count=1)
    assert "1 qualitative concern" in text
    assert "concerns surfaced" not in text  # we want singular form
