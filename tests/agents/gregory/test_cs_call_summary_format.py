"""Unit tests for the cs_call_summary_post sentiment-pill rendering."""

from __future__ import annotations

from agents.gregory import cs_call_summary_post as mod


def _review(arc="Client warmed up over the call."):
    return {"sentiment_arc": arc}


def test_sentiment_pill_red_renders_negative():
    body = mod._format_review_message(
        csm_name="Lou",
        client_name="Acme",
        review=_review(),
        call_id="call-1",
        sentiment_tier="red",
    )
    assert "**Sentiment**  🔴 - Negative - 🔴" in body
    # Arc text follows on the next line.
    assert "Client warmed up over the call." in body


def test_sentiment_pill_green_and_yellow_labels():
    green = mod._format_review_message(
        csm_name="Lou", client_name="Acme", review=_review(), call_id="c",
        sentiment_tier="green",
    )
    yellow = mod._format_review_message(
        csm_name="Lou", client_name="Acme", review=_review(), call_id="c",
        sentiment_tier="yellow",
    )
    assert "🟢 - Positive - 🟢" in green
    assert "🟡 - Mixed - 🟡" in yellow


def test_no_tier_renders_bare_sentiment_header():
    body = mod._format_review_message(
        csm_name="Lou", client_name="Acme", review=_review(), call_id="c",
        sentiment_tier=None,
    )
    assert "**Sentiment**\n" in body
    assert "🟢" not in body and "🟡" not in body and "🔴" not in body


def test_missing_arc_returns_none():
    assert (
        mod._format_review_message(
            csm_name="Lou", client_name="Acme", review={"sentiment_arc": ""},
            call_id="c", sentiment_tier="red",
        )
        is None
    )
