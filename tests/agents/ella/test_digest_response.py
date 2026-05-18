"""Unit tests for `agents.ella.digest_response.generate_response`
(post-unified-path: no fallback token; KB-navigation rule in prompt)."""

from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace

from agents.ella import digest_response as dr
from agents.ella.digest_response import generate_response


def _payload(text="How do I find the sales-call lesson?"):
    return SimpleNamespace(triggering_message_text=text)


def _chunk():
    return SimpleNamespace(
        similarity=0.7,
        content="The sales-call lesson is in module 3.",
        document_type="course_lesson",
        document_title="Module 3",
        chunk_index=0,
    )


def _stub_complete(monkeypatch, text, tokens=(50, 30), cost="0.00003"):
    monkeypatch.setattr(
        "agents.ella.digest_response.complete",
        lambda **kw: SimpleNamespace(
            text=text,
            input_tokens=tokens[0],
            output_tokens=tokens[1],
            cost_usd=Decimal(cost),
            model="haiku",
            raw=None,
        ),
    )


def test_clean_response(monkeypatch):
    _stub_complete(monkeypatch, "It's covered in *Module 3*.")
    res = generate_response(
        payload=_payload(),
        kb_chunks=[_chunk()],
        recent_context="",
        primary_csm={"full_name": "Scott Wilson"},
        channel_client={"full_name": "Javi Pena"},
    )
    assert res.fallback_to_sonnet is False  # vestigial, always False
    assert "Module 3" in res.response_text


def test_no_fallback_token_detection(monkeypatch):
    """The [FALLBACK_TO_SONNET] token is no longer special-cased — if a
    model emitted it, it passes through as plain text and
    fallback_to_sonnet stays False."""
    _stub_complete(monkeypatch, "Not sure. [FALLBACK_TO_SONNET]")
    res = generate_response(
        payload=_payload(),
        kb_chunks=[],
        recent_context="",
    )
    assert res.fallback_to_sonnet is False


def test_complete_error_returns_graceful_handoff(monkeypatch):
    def _boom(**kw):
        raise RuntimeError("anthropic down")

    monkeypatch.setattr("agents.ella.digest_response.complete", _boom)
    res = generate_response(
        payload=_payload(),
        kb_chunks=[_chunk()],
        recent_context="",
    )
    assert res.fallback_to_sonnet is False
    assert res.response_text  # non-empty graceful message, never blank
    assert "advisor" in res.response_text
    assert res.cost_usd == Decimal("0")


def test_nav_rule_in_system_prompt():
    assert "navigation metadata" in dr._RESPONSE_SYSTEM_PROMPT
    assert "[FALLBACK_TO_SONNET]" not in dr._RESPONSE_SYSTEM_PROMPT


def test_cost_accounting(monkeypatch):
    _stub_complete(monkeypatch, "Short.", tokens=(111, 22), cost="0.00009")
    res = generate_response(
        payload=_payload(),
        kb_chunks=[_chunk()],
        recent_context="prev",
    )
    assert res.input_tokens == 111
    assert res.output_tokens == 22
    assert res.cost_usd == Decimal("0.00009")
