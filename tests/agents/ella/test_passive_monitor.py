"""Unit tests for `agents.ella.passive_monitor.evaluate_passive_trigger`.

Each of the six gates and the Haiku-decision parse path is exercised.
The module's hard contract is "never raises" — fail-soft is asserted
on the exception path. Default-stance "skip on uncertainty" is the
load-bearing semantic.
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import pytest

from agents.ella import passive_monitor as pm
from agents.ella.passive_monitor import (
    PassiveTriggerPayload,
    evaluate_passive_trigger,
)


# ---------------------------------------------------------------------------
# Fake DB matching the shape of `realtime_ingest`'s fake-db harness
# ---------------------------------------------------------------------------


class _Chain:
    def __init__(self, table, fake):
        self.table = table
        self.fake = fake
        self._mode = None
        self._filters = []

    def select(self, *_a, **_kw):
        self._mode = "select"
        return self

    def eq(self, k, v):
        self._filters.append((k, v))
        return self

    def is_(self, k, v):
        self._filters.append((k, f"is:{v}"))
        return self

    def in_(self, k, v):
        self._filters.append((k, list(v)))
        return self

    def gte(self, k, v):
        self._filters.append((k, f">={v}"))
        return self

    def order(self, *_a, **_kw):
        return self

    def limit(self, *_a, **_kw):
        return self

    def execute(self):
        if self.table == "client_team_assignments":
            return SimpleNamespace(data=self.fake.assignments_response)
        if self.table == "team_members":
            return SimpleNamespace(data=self.fake.team_members_response)
        if self.table == "agent_runs":
            return SimpleNamespace(data=self.fake.agent_runs_response)
        raise AssertionError(f"unexpected execute table={self.table}")


class _FakeDb:
    def __init__(self):
        self.assignments_response = []
        self.team_members_response = []
        self.agent_runs_response = []

    def table(self, name):
        return _Chain(name, self)


@pytest.fixture
def fake_db(monkeypatch):
    db = _FakeDb()
    # `passive_monitor` does `from shared.db import get_client` at the
    # top so the name is bound locally. Patch both the source and the
    # live re-export so every lookup resolves to the fake.
    monkeypatch.setattr("shared.db.get_client", lambda: db)
    monkeypatch.setattr("agents.ella.passive_monitor.get_client", lambda: db)
    return db


@pytest.fixture(autouse=True)
def _stub_env(monkeypatch):
    monkeypatch.setenv("ELLA_PASSIVE_MONITORING_ENABLED", "true")
    monkeypatch.delenv("ELLA_PASSIVE_KB_RELEVANCE_THRESHOLD", raising=False)


def _payload(text="What's the next step?", author_type="client", channel="C1", test_mode=False):
    return PassiveTriggerPayload(
        slack_channel_id=channel,
        triggering_message_ts="1745500100.000100",
        triggering_message_slack_user_id="UCLIENT1",
        triggering_message_text=text,
        author_type=author_type,
        channel_client_id="client-uuid-1",
        test_mode=test_mode,
    )


def _stub_kb(monkeypatch, results):
    """Return the given Chunk-like results from `search_for_client`."""
    monkeypatch.setattr(
        "agents.ella.passive_monitor.search_for_client",
        lambda *a, **kw: results,
    )


def _stub_recent_context(monkeypatch, text=""):
    monkeypatch.setattr(
        "agents.ella.passive_monitor.fetch_recent_channel_context",
        lambda *a, **kw: text,
    )


def _chunk(similarity=0.6, content="some relevant content"):
    """Build a `Chunk`-shaped object — only `.similarity`, `.content`,
    `.document_type`, `.document_title` are read by the module."""
    return SimpleNamespace(
        similarity=similarity,
        content=content,
        document_type="course_lesson",
        document_title="Lesson 1",
        chunk_id="c1",
        document_id="d1",
        chunk_index=0,
        document_created_at=datetime.now(timezone.utc),
        metadata={},
    )


# ---------------------------------------------------------------------------
# Gate 1 — kill switch
# ---------------------------------------------------------------------------


def test_gate_kill_switch_off_skips(fake_db, monkeypatch):
    monkeypatch.setenv("ELLA_PASSIVE_MONITORING_ENABLED", "false")
    _stub_kb(monkeypatch, [_chunk()])
    _stub_recent_context(monkeypatch)

    ev = evaluate_passive_trigger(_payload())

    assert ev.decision.decision == "skip"
    assert ev.skip_reason == "kill_switch"
    assert "kill switch" in ev.decision.reasoning


# ---------------------------------------------------------------------------
# Gate 2 — author type
# ---------------------------------------------------------------------------


def test_gate_non_client_author_skips(fake_db, monkeypatch):
    _stub_kb(monkeypatch, [_chunk()])
    _stub_recent_context(monkeypatch)

    ev = evaluate_passive_trigger(_payload(author_type="team_member"))

    assert ev.decision.decision == "skip"
    assert ev.skip_reason == "non_client_author"


def test_gate_ella_author_skips(fake_db, monkeypatch):
    """Ella's own posts should never re-trigger the passive monitor."""
    _stub_kb(monkeypatch, [_chunk()])
    _stub_recent_context(monkeypatch)

    ev = evaluate_passive_trigger(_payload(author_type="ella"))

    assert ev.decision.decision == "skip"
    assert ev.skip_reason == "non_client_author"


# ---------------------------------------------------------------------------
# Gate 2 — test_mode bypass (Batch 2.3 follow-up)
# ---------------------------------------------------------------------------


def test_test_mode_accepts_team_member(fake_db, monkeypatch):
    """When the channel is test_mode-enabled, team_member messages
    pass Gate 2 and proceed through the rest of the pipeline. Validates
    Drake's smoke-test workflow."""
    fake_db.assignments_response = []
    fake_db.agent_runs_response = []
    _stub_kb(monkeypatch, [_chunk(similarity=0.8)])
    _stub_recent_context(monkeypatch)
    monkeypatch.setattr(
        "agents.ella.passive_monitor.complete",
        lambda **kw: SimpleNamespace(
            text='{"decision":"respond_substantive","reasoning":"test"}',
            input_tokens=10, output_tokens=5,
            cost_usd=Decimal("0.00001"), model="haiku", raw=None,
        ),
    )

    ev = evaluate_passive_trigger(_payload(author_type="team_member", test_mode=True))

    # Past Gate 2 — no non_client_author skip.
    assert ev.skip_reason != "non_client_author"
    assert ev.decision.decision == "respond_substantive"


def test_test_mode_still_rejects_ella_author(fake_db, monkeypatch):
    """test_mode is NOT a blanket bypass. Ella, bot, workflow, and
    unknown still skip regardless of channel test_mode — Ella responding
    to her own posts is undesirable in every mode."""
    _stub_kb(monkeypatch, [_chunk()])
    _stub_recent_context(monkeypatch)

    for author_type in ("ella", "bot", "workflow", "unknown"):
        ev = evaluate_passive_trigger(
            _payload(author_type=author_type, test_mode=True)
        )
        assert ev.decision.decision == "skip", f"{author_type} should skip"
        assert ev.skip_reason == "non_client_author", f"{author_type} skip_reason"


def test_test_mode_default_false_keeps_production_behavior(fake_db, monkeypatch):
    """Default test_mode=False on every other channel preserves the
    clients-only Gate 2 behavior. team_member skips by default."""
    _stub_kb(monkeypatch, [_chunk()])
    _stub_recent_context(monkeypatch)

    ev = evaluate_passive_trigger(_payload(author_type="team_member"))  # default test_mode=False

    assert ev.decision.decision == "skip"
    assert ev.skip_reason == "non_client_author"


# ---------------------------------------------------------------------------
# Gate 3 — CSM-directed (Slack-mention path)
# ---------------------------------------------------------------------------


def test_gate_csm_directed_via_slack_mention(fake_db, monkeypatch):
    fake_db.team_members_response = [{"slack_user_id": "UCSMSCOTT"}]
    fake_db.assignments_response = []
    _stub_kb(monkeypatch, [_chunk()])
    _stub_recent_context(monkeypatch)

    ev = evaluate_passive_trigger(
        _payload(text="hey <@UCSMSCOTT> can we hop on?")
    )

    assert ev.decision.decision == "skip"
    assert ev.skip_reason == "csm_directed"


# ---------------------------------------------------------------------------
# Gate 3 — CSM-directed (first-name match path)
# ---------------------------------------------------------------------------


def test_gate_csm_directed_via_first_name(fake_db, monkeypatch):
    fake_db.assignments_response = [{"team_member_id": "tm-uuid"}]
    fake_db.team_members_response = [
        {"id": "tm-uuid", "full_name": "Scott Lyons", "slack_user_id": "UCSMSCOTT"}
    ]
    _stub_kb(monkeypatch, [_chunk()])
    _stub_recent_context(monkeypatch)

    ev = evaluate_passive_trigger(
        _payload(text="Scott did we agree on the new offer?")
    )

    assert ev.decision.decision == "skip"
    assert ev.skip_reason == "csm_directed"


def test_first_name_match_only_when_token_present(fake_db, monkeypatch):
    """A first-name SUBSTRING (e.g. 'cottony' contains 'cott') should
    NOT trigger the gate — we tokenize, not substring-match."""
    fake_db.assignments_response = [{"team_member_id": "tm-uuid"}]
    fake_db.team_members_response = [
        {"id": "tm-uuid", "full_name": "Scott Lyons", "slack_user_id": "UCSMSCOTT"}
    ]
    _stub_kb(monkeypatch, [_chunk(similarity=0.05)])
    _stub_recent_context(monkeypatch)
    monkeypatch.setattr(
        "agents.ella.passive_monitor.complete",
        lambda **kw: SimpleNamespace(
            text='{"decision":"skip","reasoning":"not relevant"}',
            input_tokens=10, output_tokens=5,
            cost_usd=Decimal("0.00001"), model="haiku", raw=None,
        ),
    )

    ev = evaluate_passive_trigger(_payload(text="cottony cloth pattern"))

    # No CSM-directed false positive — falls through to no_kb_match.
    assert ev.skip_reason != "csm_directed"


# ---------------------------------------------------------------------------
# Gate 4 — KB relevance
# ---------------------------------------------------------------------------


def test_gate_no_kb_match_skips(fake_db, monkeypatch):
    fake_db.assignments_response = []
    _stub_kb(monkeypatch, [])
    _stub_recent_context(monkeypatch)

    ev = evaluate_passive_trigger(_payload())

    assert ev.decision.decision == "skip"
    assert ev.skip_reason == "no_kb_match"


def test_gate_kb_below_threshold_skips(fake_db, monkeypatch):
    fake_db.assignments_response = []
    _stub_kb(monkeypatch, [_chunk(similarity=0.1)])
    _stub_recent_context(monkeypatch)

    ev = evaluate_passive_trigger(_payload())

    assert ev.decision.decision == "skip"
    assert ev.skip_reason == "no_kb_match"


def test_gate_kb_threshold_override_via_env(fake_db, monkeypatch):
    """Override the default 0.3 threshold via env so a low-similarity
    chunk passes the gate."""
    monkeypatch.setenv("ELLA_PASSIVE_KB_RELEVANCE_THRESHOLD", "0.05")
    fake_db.assignments_response = []
    fake_db.agent_runs_response = []
    _stub_kb(monkeypatch, [_chunk(similarity=0.1)])
    _stub_recent_context(monkeypatch)
    monkeypatch.setattr(
        "agents.ella.passive_monitor.complete",
        lambda **kw: SimpleNamespace(
            text='{"decision":"skip","reasoning":"not relevant"}',
            input_tokens=10, output_tokens=5,
            cost_usd=Decimal("0.00001"), model="haiku", raw=None,
        ),
    )

    ev = evaluate_passive_trigger(_payload())

    # Should NOT skip on no_kb_match (overridden); Haiku's own skip is fine.
    assert ev.skip_reason != "no_kb_match"


# ---------------------------------------------------------------------------
# Gate 5 — firm after first
# ---------------------------------------------------------------------------


def test_gate_firm_after_first_skips(fake_db, monkeypatch):
    fake_db.assignments_response = []
    fake_db.agent_runs_response = [
        {
            "id": "run-prior",
            "started_at": "2026-05-08T12:00:00Z",
            "trigger_metadata": {
                "triggering_slack_channel_id": "C1",
                "haiku_decision": "escalate",
                "haiku_reasoning": "Client asking about refund options and billing dispute",
            },
        }
    ]
    _stub_kb(monkeypatch, [_chunk(similarity=0.8)])
    _stub_recent_context(monkeypatch)

    ev = evaluate_passive_trigger(
        _payload(text="What were the refund options for the billing dispute?")
    )

    assert ev.decision.decision == "skip"
    assert ev.skip_reason == "firm_after_first"


def test_firm_after_first_no_match_when_topic_differs(fake_db, monkeypatch):
    """Prior escalation about billing; new message about scheduling.
    Should NOT trigger firm-after-first."""
    fake_db.assignments_response = []
    fake_db.agent_runs_response = [
        {
            "id": "run-prior",
            "started_at": "2026-05-08T12:00:00Z",
            "trigger_metadata": {
                "triggering_slack_channel_id": "C1",
                "haiku_decision": "escalate",
                "haiku_reasoning": "Client asking about refund options and billing dispute",
            },
        }
    ]
    _stub_kb(monkeypatch, [_chunk(similarity=0.8)])
    _stub_recent_context(monkeypatch)
    monkeypatch.setattr(
        "agents.ella.passive_monitor.complete",
        lambda **kw: SimpleNamespace(
            text='{"decision":"respond_substantive","reasoning":"genuine question"}',
            input_tokens=100, output_tokens=20,
            cost_usd=Decimal("0.0002"), model="haiku", raw=None,
        ),
    )

    ev = evaluate_passive_trigger(
        _payload(text="when does Sunday meeting start scheduling exact time?")
    )

    assert ev.skip_reason != "firm_after_first"


# ---------------------------------------------------------------------------
# Gate 6 — Haiku decision path
# ---------------------------------------------------------------------------


def test_haiku_happy_path_respond_substantive(fake_db, monkeypatch):
    fake_db.assignments_response = []
    fake_db.agent_runs_response = []
    _stub_kb(monkeypatch, [_chunk(similarity=0.8)])
    _stub_recent_context(monkeypatch, "[12:00] client UCLIENT1: earlier msg")

    monkeypatch.setattr(
        "agents.ella.passive_monitor.complete",
        lambda **kw: SimpleNamespace(
            text='{"decision":"respond_substantive","reasoning":"question matches lesson 1 directly"}',
            input_tokens=200, output_tokens=30,
            cost_usd=Decimal("0.000350"), model="haiku", raw=None,
        ),
    )

    ev = evaluate_passive_trigger(_payload())

    assert ev.decision.decision == "respond_substantive"
    assert ev.decision.reasoning.startswith("question matches lesson")
    assert ev.decision.haiku_input_tokens == 200
    assert ev.decision.haiku_output_tokens == 30
    assert ev.skip_reason is None


def test_haiku_escalate_decision(fake_db, monkeypatch):
    fake_db.assignments_response = []
    fake_db.agent_runs_response = []
    _stub_kb(monkeypatch, [_chunk(similarity=0.8)])
    _stub_recent_context(monkeypatch)
    monkeypatch.setattr(
        "agents.ella.passive_monitor.complete",
        lambda **kw: SimpleNamespace(
            text='{"decision":"escalate","reasoning":"billing question — auto-escalate per fence"}',
            input_tokens=180, output_tokens=20,
            cost_usd=Decimal("0.0001"), model="haiku", raw=None,
        ),
    )

    ev = evaluate_passive_trigger(_payload(text="can I get a refund for last month?"))

    # Note: 'refund' triggers the firm-after-first detector only when
    # there's a prior matching escalation; here agent_runs is empty
    # so we fall through to Haiku which routes to escalate.
    assert ev.decision.decision == "escalate"


def test_haiku_unparseable_falls_back_to_skip(fake_db, monkeypatch):
    fake_db.assignments_response = []
    fake_db.agent_runs_response = []
    _stub_kb(monkeypatch, [_chunk(similarity=0.8)])
    _stub_recent_context(monkeypatch)
    monkeypatch.setattr(
        "agents.ella.passive_monitor.complete",
        lambda **kw: SimpleNamespace(
            text="completely unparseable garble",
            input_tokens=10, output_tokens=5,
            cost_usd=Decimal("0.00001"), model="haiku", raw=None,
        ),
    )

    ev = evaluate_passive_trigger(_payload())

    assert ev.decision.decision == "skip"
    assert "unparseable" in ev.decision.reasoning


def test_haiku_code_fence_tolerance(fake_db, monkeypatch):
    """Haiku sometimes wraps JSON in code fences; the parser strips them."""
    fake_db.assignments_response = []
    fake_db.agent_runs_response = []
    _stub_kb(monkeypatch, [_chunk(similarity=0.8)])
    _stub_recent_context(monkeypatch)
    fenced = '```json\n{"decision":"respond_general_inquiry","reasoning":"general help ask"}\n```'
    monkeypatch.setattr(
        "agents.ella.passive_monitor.complete",
        lambda **kw: SimpleNamespace(
            text=fenced,
            input_tokens=50, output_tokens=10,
            cost_usd=Decimal("0.0001"), model="haiku", raw=None,
        ),
    )

    ev = evaluate_passive_trigger(_payload())

    assert ev.decision.decision == "respond_general_inquiry"


def test_haiku_unknown_decision_falls_back_to_skip(fake_db, monkeypatch):
    fake_db.assignments_response = []
    fake_db.agent_runs_response = []
    _stub_kb(monkeypatch, [_chunk(similarity=0.8)])
    _stub_recent_context(monkeypatch)
    monkeypatch.setattr(
        "agents.ella.passive_monitor.complete",
        lambda **kw: SimpleNamespace(
            text='{"decision":"hallucinated_new_option","reasoning":"something"}',
            input_tokens=10, output_tokens=5,
            cost_usd=Decimal("0.00001"), model="haiku", raw=None,
        ),
    )

    ev = evaluate_passive_trigger(_payload())

    assert ev.decision.decision == "skip"
    assert "haiku_returned_unknown_decision" in ev.decision.reasoning


def test_haiku_call_exception_falls_back_to_skip(fake_db, monkeypatch):
    fake_db.assignments_response = []
    fake_db.agent_runs_response = []
    _stub_kb(monkeypatch, [_chunk(similarity=0.8)])
    _stub_recent_context(monkeypatch)
    def _raise(**_kw):
        raise RuntimeError("anthropic api timeout")
    monkeypatch.setattr("agents.ella.passive_monitor.complete", _raise)

    ev = evaluate_passive_trigger(_payload())

    assert ev.decision.decision == "skip"
    assert "haiku_call_failed" in ev.decision.reasoning


# ---------------------------------------------------------------------------
# Top-level fail-soft
# ---------------------------------------------------------------------------


def test_unrecoverable_exception_returns_safer_fallback_skip(monkeypatch):
    """Force `_evaluate` to raise; the entry point must still return."""
    def _raise(*_a, **_kw):
        raise RuntimeError("db connection refused")

    monkeypatch.setattr("agents.ella.passive_monitor._evaluate", _raise)

    ev = evaluate_passive_trigger(_payload())

    assert ev.decision.decision == "skip"
    assert ev.skip_reason == "exception"
    assert "evaluate_passive_trigger_error" in ev.decision.reasoning
