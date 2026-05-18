"""Unit tests for `agents.ella.digest_response.generate_response`."""

from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace

import pytest

from agents.ella import digest_response as dr
from agents.ella.digest_response import generate_response


def _payload(text="How do I find the sales-call lesson?"):
    return SimpleNamespace(triggering_message_text=text)


def _chunk():
    return SimpleNamespace(
        similarity=0.7,
        content="The sales-call lesson is module 3.",
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


def test_clean_response_no_fallback(monkeypatch):
    _stub_complete(monkeypatch, "It's in *Module 3* — check the curriculum tab.")
    res = generate_response(
        payload=_payload(),
        kb_chunks=[_chunk()],
        recent_context="",
        primary_csm={"full_name": "Scott Wilson"},
        channel_client={"full_name": "Javi Pena"},
    )
    assert res.fallback_to_sonnet is False
    assert "Module 3" in res.response_text


def test_fallback_token_anywhere_triggers_fallback(monkeypatch):
    _stub_complete(
        monkeypatch,
        "I'm not totally sure here. [FALLBACK_TO_SONNET] trailing text",
    )
    res = generate_response(
        payload=_payload(),
        kb_chunks=[],
        recent_context="",
    )
    assert res.fallback_to_sonnet is True


def test_complete_error_falls_back_to_sonnet(monkeypatch):
    def _boom(**kw):
        raise RuntimeError("anthropic down")

    monkeypatch.setattr("agents.ella.digest_response.complete", _boom)
    res = generate_response(
        payload=_payload(),
        kb_chunks=[_chunk()],
        recent_context="",
    )
    assert res.fallback_to_sonnet is True
    assert res.response_text == ""
    assert res.cost_usd == Decimal("0")


def test_cost_accounting_captured(monkeypatch):
    _stub_complete(monkeypatch, "Short answer.", tokens=(111, 22), cost="0.00009")
    res = generate_response(
        payload=_payload(),
        kb_chunks=[_chunk()],
        recent_context="prev turn",
    )
    assert res.input_tokens == 111
    assert res.output_tokens == 22
    assert res.cost_usd == Decimal("0.00009")
