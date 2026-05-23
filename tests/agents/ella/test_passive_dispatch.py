"""Unit tests for `passive_dispatch.persist_passive_evaluation` after
the 2026-05-23 path split.

Post-split passive monitoring is observation-only: every decision
collapses to "write agent_runs + (if digest_flag) pending_digest_items".
No in-channel posts, no escalation DMs, no pending_ella_responses
inserts from this layer.
"""

from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace

import pytest

from agents.ella import passive_dispatch as pd
from agents.ella.passive_monitor import (
    PassiveDecision,
    PassiveEvaluation,
    PassiveTriggerPayload,
)


# ---------------------------------------------------------------------------
# Fixtures — fake Supabase client + fake slack_post (must not be called)
# ---------------------------------------------------------------------------


class _Chain:
    def __init__(self, table, fake):
        self.table = table
        self.fake = fake
        self._mode = None
        self._payload = None

    def select(self, *_a, **_kw):
        self._mode = "select"
        return self

    def insert(self, payload):
        self._mode = "insert"
        self._payload = payload
        return self

    def update(self, payload):
        self._mode = "update"
        self._payload = payload
        return self

    def eq(self, *_a, **_kw):
        return self

    def is_(self, *_a, **_kw):
        return self

    def limit(self, *_a, **_kw):
        return self

    def execute(self):
        t, m = self.table, self._mode
        if m == "insert" and t == "agent_runs":
            self.fake.runs.append(self._payload)
            return SimpleNamespace(data=[{"id": f"run-{len(self.fake.runs)}"}])
        if m == "update" and t == "agent_runs":
            self.fake.run_updates.append(self._payload)
            return SimpleNamespace(data=[{}])
        if m == "insert" and t == "pending_digest_items":
            self.fake.digest.append(self._payload)
            return SimpleNamespace(data=[{"id": f"dg-{len(self.fake.digest)}"}])
        if m == "select" and t in ("client_team_assignments", "team_members"):
            return SimpleNamespace(data=[])
        raise AssertionError(f"unexpected {t}/{m}")


class _FakeDb:
    def __init__(self):
        self.runs = []
        self.run_updates = []
        self.digest = []

    def table(self, name):
        return _Chain(name, self)


@pytest.fixture
def fake_db(monkeypatch):
    db = _FakeDb()
    for tgt in (
        "shared.db.get_client",
        "agents.ella.passive_dispatch.get_client",
        "shared.logging.get_client",
    ):
        monkeypatch.setattr(tgt, lambda: db)
    return db


@pytest.fixture(autouse=True)
def _no_slack_posts(monkeypatch):
    """Passive observation MUST NOT post to Slack. Any call to
    post_message during these tests is a regression — fail loud."""
    monkeypatch.setattr(
        "shared.slack_post.post_message",
        lambda *a, **kw: pytest.fail("passive must not post to Slack"),
    )


def _payload(mentioned=False, routed_to_others=False):
    return PassiveTriggerPayload(
        slack_channel_id="C1",
        triggering_message_ts="1745500100.000100",
        triggering_message_slack_user_id="U1",
        triggering_message_text="hi",
        author_type="client",
        channel_client_id="cli-1",
        is_ella_mentioned=mentioned,
        is_routed_to_others=routed_to_others,
    )


def _decision(decision, **kw):
    return PassiveDecision(
        decision=decision,
        response_model=kw.get("response_model"),
        ack_text=kw.get("ack_text"),
        digest_flag=kw.get("digest_flag", False),
        digest_category=kw.get("digest_category"),
        reasoning=kw.get("reasoning", "r"),
        haiku_cost_usd=Decimal("0.0001"),
        haiku_input_tokens=100,
        haiku_output_tokens=10,
    )


def _ev(decision, skip_reason=None, **kw):
    return PassiveEvaluation(
        payload=_payload(kw.pop("mentioned", False)),
        decision=_decision(decision, **kw),
        skip_reason=skip_reason or ("haiku_skip" if decision == "skip" else None),
    )


# ---------------------------------------------------------------------------
# Observation-only contract
# ---------------------------------------------------------------------------


def test_kill_switch_no_row(fake_db):
    ev = PassiveEvaluation(
        payload=_payload(),
        decision=_decision("skip"),
        skip_reason="kill_switch",
    )
    r = pd.persist_passive_evaluation(ev)
    assert r["skip_reason"] == "kill_switch"
    assert fake_db.runs == []
    assert fake_db.digest == []


def test_skip_no_flag_writes_run_only(fake_db):
    r = pd.persist_passive_evaluation(_ev("skip"))
    assert len(fake_db.runs) == 1
    assert fake_db.runs[0]["trigger_type"] == "passive_monitor"
    # end_agent_run writes terminal status via UPDATE
    term = _terminal_update(fake_db)
    assert term["status"] == "success"
    assert "observe (haiku_skip)" in term["output_summary"]
    assert fake_db.digest == []
    assert r["agent_run_id"] == "run-1"


def _terminal_update(fake_db):
    """Return the last agent_runs update payload that carries a
    terminal status (the end_agent_run write). Cost updates are
    skipped."""
    for upd in reversed(fake_db.run_updates):
        if "status" in upd:
            return upd
    raise AssertionError("no terminal update found")


def test_skip_with_flag_writes_digest(fake_db):
    pd.persist_passive_evaluation(
        _ev("skip", digest_flag=True, digest_category="confusion")
    )
    assert len(fake_db.digest) == 1
    assert fake_db.digest[0]["digest_category"] == "confusion"
    assert fake_db.digest[0]["ella_responded"] is False


def test_respond_decision_writes_run_no_post(fake_db):
    """Spec-critical: a `respond` decision from the passive Haiku no
    longer triggers an in-channel post. The decision is recorded in
    trigger_metadata but the dispatch layer just observes."""
    pd.persist_passive_evaluation(
        _ev("respond", response_model="sonnet", digest_flag=True, digest_category="question_program")
    )
    assert len(fake_db.runs) == 1
    # autouse _no_slack_posts fixture would have failed if post_message was called.
    assert len(fake_db.digest) == 1
    assert fake_db.digest[0]["ella_responded"] is False


def test_acknowledge_and_escalate_writes_run_no_post_no_dm(fake_db):
    """Spec-critical: passive `acknowledge_and_escalate` no longer
    posts in-channel and no longer fires escalation DMs. The Haiku's
    ack_text is recorded in trigger_metadata for audit only."""
    pd.persist_passive_evaluation(
        _ev(
            "acknowledge_and_escalate",
            ack_text="Hey — Scott will follow up.",
            digest_flag=True,
            digest_category="emotional_human_needed",
        )
    )
    assert len(fake_db.runs) == 1
    # ack_text preserved in trigger_metadata
    assert (
        fake_db.runs[0]["trigger_metadata"]["ack_text"]
        == "Hey — Scott will follow up."
    )
    # Digest item written for the daily digest
    assert len(fake_db.digest) == 1


def test_routed_to_humans_writes_digest_no_post(fake_db):
    """Gate 3 skip (pre-LLM, no Haiku cost) still produces a digest
    item — passive's observation role is preserved."""
    pd.persist_passive_evaluation(
        _ev(
            "skip",
            skip_reason="routed_to_humans",
            digest_flag=True,
            digest_category="other",
        )
    )
    assert len(fake_db.runs) == 1
    assert len(fake_db.digest) == 1


def test_cost_recorded_when_haiku_was_called(fake_db):
    pd.persist_passive_evaluation(_ev("skip"))
    cost_updates = [u for u in fake_db.run_updates if "llm_input_tokens" in u]
    assert len(cost_updates) == 1
    assert cost_updates[0]["llm_input_tokens"] == 100
    assert cost_updates[0]["llm_output_tokens"] == 10


# ---------------------------------------------------------------------------
# Status-honesty fix — failed LLM calls = status='error'
# ---------------------------------------------------------------------------


def test_haiku_call_failure_lands_as_status_error(fake_db):
    """When the decision Haiku raises, passive_monitor returns a
    PassiveDecision with `reasoning='haiku_call_failed: ...'`. The
    dispatch layer must surface that as `status='error'` so the
    failure is visible on `/ella/runs WHERE status='error'`, not
    buried in a 'success' row's output_summary."""
    ev = PassiveEvaluation(
        payload=_payload(),
        decision=_decision(
            "skip",
            reasoning="haiku_call_failed: BadRequestError",
        ),
        skip_reason="haiku_skip",
    )
    r = pd.persist_passive_evaluation(ev)
    assert len(fake_db.runs) == 1
    term = _terminal_update(fake_db)
    assert term["status"] == "error"
    assert "haiku_call_failed" in term["error_message"]
    assert r["status"] == "error"


def test_exception_path_lands_as_status_error(fake_db):
    """The other status-honesty path: when `evaluate_passive_trigger`'s
    outer try/except catches an unhandled exception, it returns a
    PassiveEvaluation with `skip_reason='exception'`. Surface as error."""
    ev = PassiveEvaluation(
        payload=_payload(),
        decision=_decision("skip", reasoning="evaluate_passive_trigger_error: KeyError"),
        skip_reason="exception",
    )
    pd.persist_passive_evaluation(ev)
    term = _terminal_update(fake_db)
    assert term["status"] == "error"


# ---------------------------------------------------------------------------
# insert_digest_item — also used by the @ handler's escalate fan-out
# ---------------------------------------------------------------------------


def test_insert_digest_item_round_trip(fake_db):
    digest_id = pd.insert_digest_item(
        run_id="run-x",
        slack_channel_id="C1",
        triggering_message_ts="1745500100.000100",
        triggering_message_slack_user_id="U1",
        client_id="cli-1",
        message_text="hello",
        haiku_decision="at_mention/escalate",
        haiku_reasoning="emotional",
        digest_category="emotional_human_needed",
        ella_responded=False,
    )
    assert digest_id == "dg-1"
    assert fake_db.digest[0]["haiku_decision"] == "at_mention/escalate"
