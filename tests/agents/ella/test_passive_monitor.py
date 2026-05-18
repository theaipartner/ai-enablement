"""Unit tests for `agents.ella.passive_monitor` (unified-decision rewrite).

Two pre-LLM gates (kill switch + author type) then the decision Haiku.
The module's hard contract is "never raises" — fail-soft is asserted
on the exception path. The four decisions, the independent digest_flag,
and the digest_category all parse out of the structured Haiku output.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest

from agents.ella import passive_monitor as pm
from agents.ella.passive_monitor import (
    PassiveTriggerPayload,
    evaluate_passive_trigger,
)


# ---------------------------------------------------------------------------
# Fake DB
# ---------------------------------------------------------------------------


class _Chain:
    def __init__(self, table, fake):
        self.table = table
        self.fake = fake

    def select(self, *_a, **_kw):
        return self

    def eq(self, *_a, **_kw):
        return self

    def is_(self, *_a, **_kw):
        return self

    def execute(self):
        if self.table == "client_team_assignments":
            return SimpleNamespace(data=self.fake.assignments_response)
        if self.table == "team_members":
            return SimpleNamespace(data=self.fake.team_members_response)
        raise AssertionError(f"unexpected execute table={self.table}")


class _FakeDb:
    def __init__(self):
        self.assignments_response = []
        self.team_members_response = []

    def table(self, name):
        return _Chain(name, self)


@pytest.fixture
def fake_db(monkeypatch):
    db = _FakeDb()
    monkeypatch.setattr("shared.db.get_client", lambda: db)
    monkeypatch.setattr("agents.ella.passive_monitor.get_client", lambda: db)
    return db


@pytest.fixture(autouse=True)
def _stub_env(monkeypatch):
    monkeypatch.setenv("ELLA_PASSIVE_MONITORING_ENABLED", "true")


def _payload(text="What's the next step?", author_type="client", test_mode=False):
    return PassiveTriggerPayload(
        slack_channel_id="C1",
        triggering_message_ts="1745500100.000100",
        triggering_message_slack_user_id="UCLIENT1",
        triggering_message_text=text,
        author_type=author_type,
        channel_client_id="client-uuid-1",
        test_mode=test_mode,
    )


def _chunk(similarity=0.6, content="some relevant content"):
    return SimpleNamespace(
        similarity=similarity,
        content=content,
        document_type="course_lesson",
        document_title="Lesson 1",
        chunk_index=0,
    )


def _stub_kb(monkeypatch, results):
    monkeypatch.setattr(
        "agents.ella.passive_monitor.search_for_client",
        lambda *a, **kw: results,
    )


def _stub_recent(monkeypatch, text=""):
    monkeypatch.setattr(
        "agents.ella.passive_monitor.fetch_recent_channel_context",
        lambda *a, **kw: text,
    )


def _stub_haiku(monkeypatch, payload_obj, tokens=(10, 5), cost="0.00001"):
    text = payload_obj if isinstance(payload_obj, str) else json.dumps(payload_obj)
    monkeypatch.setattr(
        "agents.ella.passive_monitor.complete",
        lambda **kw: SimpleNamespace(
            text=text,
            input_tokens=tokens[0],
            output_tokens=tokens[1],
            cost_usd=Decimal(cost),
            model="haiku",
            raw=None,
        ),
    )


# ---------------------------------------------------------------------------
# Gate 1 — kill switch
# ---------------------------------------------------------------------------


def test_kill_switch_off_returns_synthetic_skip(fake_db, monkeypatch):
    monkeypatch.setenv("ELLA_PASSIVE_MONITORING_ENABLED", "false")
    ev = evaluate_passive_trigger(_payload())
    assert ev.decision.decision == "skip"
    assert ev.skip_reason == "kill_switch"
    assert "kill switch" in ev.decision.reasoning


# ---------------------------------------------------------------------------
# Gate 2 — author type
# ---------------------------------------------------------------------------


def test_non_client_author_skips(fake_db, monkeypatch):
    ev = evaluate_passive_trigger(_payload(author_type="team_member"))
    assert ev.decision.decision == "skip"
    assert ev.skip_reason == "non_client_author"


@pytest.mark.parametrize("atype", ["ella", "bot", "workflow", "unknown"])
def test_test_mode_still_rejects_non_client_non_team(fake_db, monkeypatch, atype):
    ev = evaluate_passive_trigger(_payload(author_type=atype, test_mode=True))
    assert ev.skip_reason == "non_client_author"


def test_test_mode_admits_team_member(fake_db, monkeypatch):
    _stub_kb(monkeypatch, [_chunk()])
    _stub_recent(monkeypatch)
    _stub_haiku(
        monkeypatch,
        {
            "decision": "skip",
            "digest_flag": False,
            "digest_category": None,
            "reasoning": "ok",
        },
    )
    ev = evaluate_passive_trigger(_payload(author_type="team_member", test_mode=True))
    assert ev.skip_reason != "non_client_author"


# ---------------------------------------------------------------------------
# Decision routing
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "decision",
    ["skip", "respond_haiku_self", "respond_via_sonnet", "digest_only"],
)
def test_each_decision_parses(fake_db, monkeypatch, decision):
    _stub_kb(monkeypatch, [_chunk()])
    _stub_recent(monkeypatch)
    _stub_haiku(
        monkeypatch,
        {
            "decision": decision,
            "digest_flag": False,
            "digest_category": None,
            "reasoning": "because",
        },
    )
    ev = evaluate_passive_trigger(_payload())
    assert ev.decision.decision == decision
    if decision == "skip":
        assert ev.skip_reason == "haiku_skip"
    else:
        assert ev.skip_reason is None


def test_malformed_json_defaults_to_skip(fake_db, monkeypatch):
    _stub_kb(monkeypatch, [])
    _stub_recent(monkeypatch)
    _stub_haiku(monkeypatch, "totally not json")
    ev = evaluate_passive_trigger(_payload())
    assert ev.decision.decision == "skip"
    assert "unparseable" in ev.decision.reasoning


def test_out_of_enum_decision_defaults_to_skip(fake_db, monkeypatch):
    _stub_kb(monkeypatch, [])
    _stub_recent(monkeypatch)
    _stub_haiku(
        monkeypatch,
        {
            "decision": "nuke_it",
            "digest_flag": True,
            "digest_category": "other",
            "reasoning": "x",
        },
    )
    ev = evaluate_passive_trigger(_payload())
    assert ev.decision.decision == "skip"
    assert "unknown_decision" in ev.decision.reasoning
    # Out-of-enum collapses everything to a clean skip; flag dropped.
    assert ev.decision.digest_flag is False


def test_json_in_code_fence_parses(fake_db, monkeypatch):
    _stub_kb(monkeypatch, [_chunk()])
    _stub_recent(monkeypatch)
    fenced = '```json\n{"decision":"respond_via_sonnet","digest_flag":false,"digest_category":null,"reasoning":"ok"}\n```'
    _stub_haiku(monkeypatch, fenced)
    ev = evaluate_passive_trigger(_payload())
    assert ev.decision.decision == "respond_via_sonnet"


def test_json_with_prose_prefix_parses(fake_db, monkeypatch):
    _stub_kb(monkeypatch, [_chunk()])
    _stub_recent(monkeypatch)
    prosey = 'Here is my decision: {"decision":"skip","digest_flag":false,"digest_category":null,"reasoning":"chitchat"}'
    _stub_haiku(monkeypatch, prosey)
    ev = evaluate_passive_trigger(_payload())
    assert ev.decision.decision == "skip"


# ---------------------------------------------------------------------------
# digest_flag / digest_category plumbing
# ---------------------------------------------------------------------------


def test_digest_flag_and_category_plumb_through(fake_db, monkeypatch):
    _stub_kb(monkeypatch, [_chunk()])
    _stub_recent(monkeypatch)
    _stub_haiku(
        monkeypatch,
        {
            "decision": "respond_haiku_self",
            "digest_flag": True,
            "digest_category": "confusion",
            "reasoning": "client is confused",
        },
    )
    ev = evaluate_passive_trigger(_payload())
    assert ev.decision.digest_flag is True
    assert ev.decision.digest_category == "confusion"


def test_digest_only_forces_flag_true_even_if_absent(fake_db, monkeypatch):
    _stub_kb(monkeypatch, [])
    _stub_recent(monkeypatch)
    _stub_haiku(
        monkeypatch,
        {"decision": "digest_only", "reasoning": "refund ask"},
    )
    ev = evaluate_passive_trigger(_payload())
    assert ev.decision.decision == "digest_only"
    assert ev.decision.digest_flag is True
    assert ev.decision.digest_category == "other"


def test_flag_true_invalid_category_defaults_other(fake_db, monkeypatch):
    _stub_kb(monkeypatch, [_chunk()])
    _stub_recent(monkeypatch)
    _stub_haiku(
        monkeypatch,
        {
            "decision": "skip",
            "digest_flag": True,
            "digest_category": "made_up",
            "reasoning": "x",
        },
    )
    ev = evaluate_passive_trigger(_payload())
    assert ev.decision.digest_flag is True
    assert ev.decision.digest_category == "other"


def test_flag_false_nulls_category(fake_db, monkeypatch):
    _stub_kb(monkeypatch, [_chunk()])
    _stub_recent(monkeypatch)
    _stub_haiku(
        monkeypatch,
        {
            "decision": "respond_via_sonnet",
            "digest_flag": False,
            "digest_category": "confusion",
            "reasoning": "x",
        },
    )
    ev = evaluate_passive_trigger(_payload())
    assert ev.decision.digest_flag is False
    assert ev.decision.digest_category is None


# ---------------------------------------------------------------------------
# Cost capture
# ---------------------------------------------------------------------------


def test_haiku_cost_captured(fake_db, monkeypatch):
    _stub_kb(monkeypatch, [_chunk()])
    _stub_recent(monkeypatch)
    _stub_haiku(
        monkeypatch,
        {
            "decision": "skip",
            "digest_flag": False,
            "digest_category": None,
            "reasoning": "x",
        },
        tokens=(120, 30),
        cost="0.00042",
    )
    ev = evaluate_passive_trigger(_payload())
    assert ev.decision.haiku_input_tokens == 120
    assert ev.decision.haiku_output_tokens == 30
    assert ev.decision.haiku_cost_usd == Decimal("0.00042")


# ---------------------------------------------------------------------------
# Fail-soft
# ---------------------------------------------------------------------------


def test_exception_fails_soft_to_skip(fake_db, monkeypatch):
    def _boom(*a, **kw):
        raise RuntimeError("kb exploded")

    monkeypatch.setattr("agents.ella.passive_monitor.search_for_client", _boom)
    _stub_recent(monkeypatch)
    ev = evaluate_passive_trigger(_payload())
    assert ev.decision.decision == "skip"
    assert ev.skip_reason == "exception"


def test_haiku_call_failure_defaults_to_skip(fake_db, monkeypatch):
    _stub_kb(monkeypatch, [_chunk()])
    _stub_recent(monkeypatch)

    def _raise(**kw):
        raise RuntimeError("anthropic down")

    monkeypatch.setattr("agents.ella.passive_monitor.complete", _raise)
    ev = evaluate_passive_trigger(_payload())
    assert ev.decision.decision == "skip"
    assert "haiku_call_failed" in ev.decision.reasoning


def test_empty_kb_is_allowed(fake_db, monkeypatch):
    """KB search is context, not a gate — empty result still reaches Haiku."""
    _stub_kb(monkeypatch, [])
    _stub_recent(monkeypatch)
    _stub_haiku(
        monkeypatch,
        {
            "decision": "digest_only",
            "digest_flag": True,
            "digest_category": "other",
            "reasoning": "no KB, human needed",
        },
    )
    ev = evaluate_passive_trigger(_payload())
    assert ev.decision.decision == "digest_only"
    assert ev.kb_chunks == []
