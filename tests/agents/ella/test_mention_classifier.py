"""Unit tests for `agents.ella.mention_classifier.classify_mention_response`.

The classifier's output enum has NO `skip` — that's the structural
fix this spec introduces. Any failure (malformed JSON / out-of-enum /
attempted "skip" / API exception) → safer-fallback `warm_opener`.
"""

from __future__ import annotations

import json
from decimal import Decimal
from types import SimpleNamespace

from agents.ella import mention_classifier as mc
from agents.ella.mention_classifier import (
    _SAFER_FALLBACK_SHAPE,
    _SHAPES,
    classify_mention_response,
)


def _payload(text="<@U0B03PTJD3P> what does the discovery section cover?"):
    return SimpleNamespace(triggering_message_text=text)


def _chunk(sim=0.7, title="Discovery", content="Discovery covers framing."):
    return SimpleNamespace(
        similarity=sim,
        content=content,
        document_type="course_lesson",
        document_title=title,
        chunk_index=0,
    )


def _stub_classifier(monkeypatch, obj, tokens=(50, 25), cost="0.00002"):
    text = obj if isinstance(obj, str) else json.dumps(obj)
    monkeypatch.setattr(
        "agents.ella.mention_classifier.complete",
        lambda **kw: SimpleNamespace(
            text=text,
            input_tokens=tokens[0],
            output_tokens=tokens[1],
            cost_usd=Decimal(cost),
            model="haiku",
            raw=None,
        ),
    )


# --- structural guarantees ----------------------------------------------


def test_skip_is_not_in_the_enum():
    """The structural fix: `skip` is impossible to produce."""
    assert "skip" not in _SHAPES
    assert _SAFER_FALLBACK_SHAPE == "warm_opener"


def test_prompt_explicitly_forbids_skip():
    p = mc._SYSTEM_PROMPT
    assert "You never output `skip`" in p
    assert "WHAT YOU DO NOT DO" in p


# --- happy paths --------------------------------------------------------


def test_kb_answerable_question_picks_respond_haiku(monkeypatch):
    _stub_classifier(
        monkeypatch,
        {
            "shape": "respond_haiku",
            "ack_text": None,
            "digest_flag": False,
            "digest_category": None,
            "reasoning": "clean factual question with strong KB anchor",
        },
    )
    res = classify_mention_response(
        payload=_payload(), kb_chunks=[_chunk(sim=0.85)], recent_context=""
    )
    assert res.shape == "respond_haiku"
    assert res.ack_text is None


def test_nuanced_question_picks_respond_sonnet(monkeypatch):
    _stub_classifier(
        monkeypatch,
        {
            "shape": "respond_sonnet",
            "ack_text": None,
            "digest_flag": False,
            "digest_category": None,
            "reasoning": "needs nuance",
        },
    )
    res = classify_mention_response(
        payload=_payload(text="<@U…> how should I think about restructuring my offer?"),
        kb_chunks=[_chunk()],
        recent_context="",
    )
    assert res.shape == "respond_sonnet"


def test_emotional_content_picks_acknowledge_and_escalate(monkeypatch):
    _stub_classifier(
        monkeypatch,
        {
            "shape": "acknowledge_and_escalate",
            "ack_text": "Hey Drake, hearing you — getting Scott on this.",
            "digest_flag": True,
            "digest_category": "emotional_human_needed",
            "reasoning": "frustration",
        },
    )
    res = classify_mention_response(
        payload=_payload(text="<@U…> I'm really frustrated"),
        kb_chunks=[],
        recent_context="",
    )
    assert res.shape == "acknowledge_and_escalate"
    assert res.ack_text and "Drake" in res.ack_text
    assert res.digest_flag is True


def test_bare_mention_no_context_picks_warm_opener(monkeypatch):
    _stub_classifier(
        monkeypatch,
        {
            "shape": "warm_opener",
            "ack_text": None,
            "digest_flag": False,
            "digest_category": None,
            "reasoning": "bare mention, quiet channel",
        },
    )
    res = classify_mention_response(
        payload=_payload(text="<@U…>"), kb_chunks=[], recent_context=""
    )
    assert res.shape == "warm_opener"


def test_bare_mention_with_resolved_prior_thread_picks_warm_opener(monkeypatch):
    """The structural regression case: a bare @-mention with a stale /
    resolved prior thread. Classifier (no `skip` in its enum) is
    correct here — `warm_opener` is the right small shape."""
    _stub_classifier(
        monkeypatch,
        {
            "shape": "warm_opener",
            "ack_text": None,
            "digest_flag": False,
            "digest_category": None,
            "reasoning": "bare mention, 22h-old resolved escalation in context",
        },
    )
    recent = (
        "[yesterday 15:30 ET — 22h ago] client (Catrina): I want a refund\n"
        "[yesterday 15:32 ET — 22h ago] ella: I'll have Scott jump in shortly."
    )
    res = classify_mention_response(
        payload=_payload(text="<@U0B03PTJD3P>"),
        kb_chunks=[],
        recent_context=recent,
    )
    assert res.shape == "warm_opener"
    assert res.shape != "skip"  # belt-and-suspenders — enum forbids it


# --- safer-fallback behavior --------------------------------------------


def test_malformed_json_falls_back_to_warm_opener(monkeypatch):
    _stub_classifier(monkeypatch, "totally not json")
    res = classify_mention_response(payload=_payload(), kb_chunks=[], recent_context="")
    assert res.shape == "warm_opener"
    assert "unparseable" in res.reasoning


def test_attempted_skip_output_falls_back_to_warm_opener(monkeypatch):
    """Even if the model tries to output `skip`, the parser collapses
    it to `warm_opener` — structural defense in depth."""
    _stub_classifier(
        monkeypatch,
        {
            "shape": "skip",
            "ack_text": None,
            "digest_flag": False,
            "digest_category": None,
            "reasoning": "model tried skip",
        },
    )
    res = classify_mention_response(payload=_payload(), kb_chunks=[], recent_context="")
    assert res.shape == "warm_opener"
    assert "unknown_shape='skip'" in res.reasoning


def test_classifier_call_exception_falls_back_to_warm_opener(monkeypatch):
    def _boom(**kw):
        raise RuntimeError("anthropic down")

    monkeypatch.setattr("agents.ella.mention_classifier.complete", _boom)
    res = classify_mention_response(payload=_payload(), kb_chunks=[], recent_context="")
    assert res.shape == "warm_opener"
    assert "classifier_call_failed" in res.reasoning


def test_digest_flag_independent_of_shape(monkeypatch):
    """A `respond_haiku` decision can still flag (Scott still wants to
    see "Ella handled a refund question today")."""
    _stub_classifier(
        monkeypatch,
        {
            "shape": "respond_haiku",
            "ack_text": None,
            "digest_flag": True,
            "digest_category": "money_commitment",
            "reasoning": "answered but flag for visibility",
        },
    )
    res = classify_mention_response(
        payload=_payload(), kb_chunks=[_chunk()], recent_context=""
    )
    assert res.shape == "respond_haiku"
    assert res.digest_flag is True
    assert res.digest_category == "money_commitment"


def test_ack_escalate_always_flags_even_if_model_says_false(monkeypatch):
    _stub_classifier(
        monkeypatch,
        {
            "shape": "acknowledge_and_escalate",
            "ack_text": "ok",
            "digest_flag": False,
            "digest_category": None,
            "reasoning": "x",
        },
    )
    res = classify_mention_response(payload=_payload(), kb_chunks=[], recent_context="")
    assert res.digest_flag is True  # forced by the parser


def test_cost_accounting(monkeypatch):
    _stub_classifier(
        monkeypatch,
        {
            "shape": "warm_opener",
            "ack_text": None,
            "digest_flag": False,
            "digest_category": None,
            "reasoning": "x",
        },
        tokens=(123, 45),
        cost="0.00007",
    )
    res = classify_mention_response(payload=_payload(), kb_chunks=[], recent_context="")
    assert res.haiku_input_tokens == 123
    assert res.haiku_output_tokens == 45
    assert res.haiku_cost_usd == Decimal("0.00007")
