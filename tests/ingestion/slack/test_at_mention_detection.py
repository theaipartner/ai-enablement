"""Unit tests for `detect_at_mentions` in `ingestion.slack.realtime_ingest`.

Pure-string-parsing helper feeding the @-mention routing gate.
Returns mentions / is_ella_mentioned / is_routed_to_others; the gate
in `agents.ella.passive_monitor._evaluate` consumes the third bool to
decide whether to skip pre-LLM with a digest item.
"""

from __future__ import annotations

import pytest

from ingestion.slack.realtime_ingest import detect_at_mentions


_ELLA_BOT = "U0ELLABOT0"
_ELLA_HUMAN = "U0ELLAHUMAN"
_DRAKE = "U0DRAKE0000"
_NICO = "U0NICO00000"
_LOU = "U0LOU000000"


def test_empty_message():
    result = detect_at_mentions("", _ELLA_BOT, _ELLA_HUMAN)
    assert result["mentions"] == []
    assert result["is_ella_mentioned"] is False
    assert result["is_routed_to_others"] is False


def test_none_message_safe():
    # Defensive: passing None instead of a string shouldn't crash.
    result = detect_at_mentions(None, _ELLA_BOT, _ELLA_HUMAN)  # type: ignore[arg-type]
    assert result["mentions"] == []
    assert result["is_routed_to_others"] is False


def test_only_ella_bot_mention():
    result = detect_at_mentions(
        f"<@{_ELLA_BOT}> can you help?", _ELLA_BOT, _ELLA_HUMAN
    )
    assert result["mentions"] == [_ELLA_BOT]
    assert result["is_ella_mentioned"] is True
    assert result["is_routed_to_others"] is False


def test_only_ella_human_mention():
    result = detect_at_mentions(
        f"hey <@{_ELLA_HUMAN}>", _ELLA_BOT, _ELLA_HUMAN
    )
    assert result["mentions"] == [_ELLA_HUMAN]
    assert result["is_ella_mentioned"] is True
    assert result["is_routed_to_others"] is False


def test_single_non_ella_mention_routes():
    result = detect_at_mentions(
        f"<@{_DRAKE}> can you help with the offer framework?",
        _ELLA_BOT,
        _ELLA_HUMAN,
    )
    assert result["mentions"] == [_DRAKE]
    assert result["is_ella_mentioned"] is False
    assert result["is_routed_to_others"] is True


def test_multiple_non_ella_mentions_route():
    """Dhamen Hothi's 2026-05-19 misfire shape: explicit routing to
    Scott and Lou. Gate 3 should suppress Ella."""
    result = detect_at_mentions(
        f"<@{_DRAKE}> <@{_LOU}> Who controls my sub account?",
        _ELLA_BOT,
        _ELLA_HUMAN,
    )
    assert set(result["mentions"]) == {_DRAKE, _LOU}
    assert result["is_ella_mentioned"] is False
    assert result["is_routed_to_others"] is True


def test_ella_plus_others_classifier_wins():
    """When Ella appears in the mention list, the routing gate must NOT
    fire — the classifier path takes precedence (Ella was invited)."""
    result = detect_at_mentions(
        f"<@{_DRAKE}> <@{_ELLA_BOT}> can you both help?",
        _ELLA_BOT,
        _ELLA_HUMAN,
    )
    assert _ELLA_BOT in result["mentions"]
    assert _DRAKE in result["mentions"]
    assert result["is_ella_mentioned"] is True
    assert result["is_routed_to_others"] is False


def test_uslackbot_treated_as_non_ella():
    """Slack's sentinel UIDs (USLACKBOT and similar) aren't Ella and
    should route through the gate."""
    result = detect_at_mentions(
        "<@USLACKBOT> hi", _ELLA_BOT, _ELLA_HUMAN
    )
    assert result["mentions"] == ["USLACKBOT"]
    assert result["is_routed_to_others"] is True


def test_malformed_lowercase_id_not_matched():
    # `<@u12345>` lacks the leading uppercase U; the regex requires
    # `<@U[A-Z0-9]+>` and skips this.
    result = detect_at_mentions(
        "<@u12345> hi", _ELLA_BOT, _ELLA_HUMAN
    )
    assert result["mentions"] == []
    assert result["is_routed_to_others"] is False


def test_duplicate_mention_deduplicated():
    result = detect_at_mentions(
        f"<@{_NICO}> wait <@{_NICO}> are you here",
        _ELLA_BOT,
        _ELLA_HUMAN,
    )
    assert result["mentions"] == [_NICO]
    assert result["is_routed_to_others"] is True


def test_mention_order_preserved_for_distinct_ids():
    result = detect_at_mentions(
        f"<@{_DRAKE}> and <@{_LOU}> then <@{_NICO}>",
        _ELLA_BOT,
        _ELLA_HUMAN,
    )
    assert result["mentions"] == [_DRAKE, _LOU, _NICO]


def test_missing_ella_ids_routes_everyone_to_others():
    """When Ella isn't configured (both IDs falsy), every mention is
    treated as non-Ella by construction. Conservative — better to skip
    on noise than misfire a response."""
    result = detect_at_mentions(
        f"<@{_DRAKE}> hi", None, None
    )
    assert result["mentions"] == [_DRAKE]
    assert result["is_ella_mentioned"] is False
    assert result["is_routed_to_others"] is True


def test_empty_string_ella_ids_treated_as_missing():
    """The realtime_ingest caller passes whatever env-var resolution
    returns; empty strings should not match any mention."""
    result = detect_at_mentions(
        f"<@{_ELLA_BOT}> hi", "", ""
    )
    assert result["is_ella_mentioned"] is False
    # is_routed_to_others is True because the mention exists and Ella
    # didn't match — the conservative-on-misconfiguration behavior.
    assert result["is_routed_to_others"] is True


def test_only_one_ella_id_configured_matches_that_one():
    """Realistic case during a token-resolution partial failure: if
    only the bot ID resolved, a message mentioning the bot still wins
    the classifier path; a message mentioning Ella's human-user ID does
    NOT (the function is precise to the IDs it was given)."""
    bot_only = detect_at_mentions(
        f"<@{_ELLA_BOT}> ping", _ELLA_BOT, None
    )
    assert bot_only["is_ella_mentioned"] is True

    human_when_only_bot_configured = detect_at_mentions(
        f"<@{_ELLA_HUMAN}> ping", _ELLA_BOT, None
    )
    assert human_when_only_bot_configured["is_ella_mentioned"] is False
    assert human_when_only_bot_configured["is_routed_to_others"] is True


@pytest.mark.parametrize(
    "text,expected_routed",
    [
        ("plain text with no mentions", False),
        ("hey there <@>", False),  # malformed bracket pair
        ("<@U123>", True),  # short but valid Slack U-prefix ID
    ],
)
def test_edge_text_shapes(text, expected_routed):
    result = detect_at_mentions(text, _ELLA_BOT, _ELLA_HUMAN)
    assert result["is_routed_to_others"] is expected_routed
