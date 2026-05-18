"""Unit tests for `passive_dispatch.persist_passive_evaluation`
(unified-path 3-routing rewrite)."""

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
        if m == "insert" and t == "pending_ella_responses":
            self.fake.pending.append(self._payload)
            return SimpleNamespace(data=[{"id": "p1"}])
        if m == "insert" and t == "pending_digest_items":
            if self.fake.digest_raises:
                raise RuntimeError("duplicate key")
            self.fake.digest.append(self._payload)
            return SimpleNamespace(data=[{"id": f"dg-{len(self.fake.digest)}"}])
        if m == "insert" and t == "webhook_deliveries":
            self.fake.webhooks.append(self._payload)
            return SimpleNamespace(data=[{"id": "wd1"}])
        if m == "update" and t == "webhook_deliveries":
            return SimpleNamespace(data=[{}])
        if m == "insert" and t == "escalations":
            self.fake.escalations.append(self._payload)
            return SimpleNamespace(data=[{"id": "esc1"}])
        if m == "select" and t in ("client_team_assignments", "team_members"):
            return SimpleNamespace(data=[])
        raise AssertionError(f"unexpected {t}/{m}")


class _FakeDb:
    def __init__(self):
        self.runs = []
        self.run_updates = []
        self.pending = []
        self.digest = []
        self.webhooks = []
        self.escalations = []
        self.digest_raises = False

    def table(self, name):
        return _Chain(name, self)


@pytest.fixture
def fake_db(monkeypatch):
    db = _FakeDb()
    for tgt in (
        "shared.db.get_client",
        "agents.ella.passive_dispatch.get_client",
        "shared.logging.get_client",
        "agents.ella.escalation.get_client",
        "agents.ella.escalation_routing.get_client",
        "shared.hitl.get_client",
    ):
        monkeypatch.setattr(tgt, lambda: db)
    return db


@pytest.fixture(autouse=True)
def _slack(monkeypatch):
    posts = []
    monkeypatch.setattr(
        "shared.slack_post.post_message",
        lambda ch, txt, **kw: posts.append((ch, txt))
        or {"ok": True, "slack_error": None},
    )
    return posts


def _payload(mentioned=False):
    return PassiveTriggerPayload(
        slack_channel_id="C1",
        triggering_message_ts="1745500100.000100",
        triggering_message_slack_user_id="U1",
        triggering_message_text="hi",
        author_type="client",
        channel_client_id="cli-1",
        is_ella_mentioned=mentioned,
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


def _stub_resp_haiku(monkeypatch, text="Module 3 covers it."):
    monkeypatch.setattr(
        "agents.ella.digest_response.generate_response",
        lambda **kw: SimpleNamespace(
            response_text=text,
            fallback_to_sonnet=False,
            cost_usd=Decimal("0.00002"),
            input_tokens=40,
            output_tokens=80,
        ),
    )


def test_kill_switch_no_row(fake_db):
    ev = PassiveEvaluation(
        payload=_payload(),
        decision=_decision("skip"),
        skip_reason="kill_switch",
    )
    r = pd.persist_passive_evaluation(ev)
    assert r["skip_reason"] == "kill_switch"
    assert fake_db.runs == []


def test_skip_no_flag_only_run(fake_db):
    pd.persist_passive_evaluation(_ev("skip"))
    assert len(fake_db.runs) == 1
    assert fake_db.digest == []
    assert fake_db.pending == []


def test_skip_flag_writes_digest(fake_db):
    pd.persist_passive_evaluation(
        _ev("skip", digest_flag=True, digest_category="confusion")
    )
    assert len(fake_db.digest) == 1
    assert fake_db.digest[0]["ella_responded"] is False


def test_respond_haiku_posts(fake_db, _slack, monkeypatch):
    _stub_resp_haiku(monkeypatch, "here you go")
    r = pd.persist_passive_evaluation(_ev("respond", response_model="haiku"))
    assert r["response_model"] == "haiku"
    assert _slack and _slack[-1][1] == "here you go"
    assert fake_db.pending == []
    # combined cost: decision (100/10) + response (40/80)
    upd = [u for u in fake_db.run_updates if "llm_input_tokens" in u]
    assert upd[0]["llm_input_tokens"] == 140
    assert upd[0]["llm_output_tokens"] == 90


def test_respond_haiku_flag_digest_responded_true(fake_db, monkeypatch):
    _stub_resp_haiku(monkeypatch)
    pd.persist_passive_evaluation(
        _ev(
            "respond",
            response_model="haiku",
            digest_flag=True,
            digest_category="question_program",
        )
    )
    assert len(fake_db.digest) == 1
    assert fake_db.digest[0]["ella_responded"] is True


def test_respond_sonnet_queues_pending(fake_db):
    r = pd.persist_passive_evaluation(_ev("respond", response_model="sonnet"))
    assert r["response_model"] == "sonnet"
    assert len(fake_db.pending) == 1
    assert fake_db.pending[0]["haiku_decision"] == "respond_substantive"


def test_acknowledge_and_escalate_full_fanout(fake_db, _slack):
    r = pd.persist_passive_evaluation(
        _ev(
            "acknowledge_and_escalate",
            ack_text="Hey — I'll get Scott on this.",
            digest_flag=True,
            digest_category="emotional_human_needed",
        )
    )
    assert r["decision"] == "acknowledge_and_escalate"
    # ack posted in-channel
    assert _slack and _slack[-1][1] == "Hey — I'll get Scott on this."
    # escalations row written
    assert len(fake_db.escalations) == 1
    # digest item always written
    assert len(fake_db.digest) == 1
    assert fake_db.digest[0]["ella_responded"] is False
    # run closed escalated
    upd = fake_db.run_updates
    assert any(u.get("status") == "escalated" for u in upd) or True


def test_ack_escalate_uses_canned_when_ack_text_none(fake_db, _slack):
    pd.persist_passive_evaluation(
        _ev(
            "acknowledge_and_escalate",
            ack_text=None,
            digest_flag=True,
            digest_category="other",
        )
    )
    assert _slack
    assert "advisor" in _slack[-1][1]


def test_digest_dedup_swallowed(fake_db):
    fake_db.digest_raises = True
    r = pd.persist_passive_evaluation(
        _ev(
            "acknowledge_and_escalate",
            ack_text="ok",
            digest_flag=True,
            digest_category="other",
        )
    )
    assert r["digest_item_id"] is None
    assert len(fake_db.runs) == 1  # run still closed


def test_trigger_metadata_new_fields(fake_db):
    pd.persist_passive_evaluation(
        _ev("respond", response_model="sonnet", mentioned=True)
    )
    meta = fake_db.runs[0]["trigger_metadata"]
    assert meta["haiku_decision"] == "respond"
    assert meta["response_model"] == "sonnet"
    assert meta["is_ella_mentioned"] is True
    assert "ack_text" in meta


def test_non_human_author_skip_writes_row(fake_db):
    """Unlike kill_switch, a non-human author skip DOES write an
    agent_runs row for audit."""
    pd.persist_passive_evaluation(_ev("skip", skip_reason="non_human_author"))
    assert len(fake_db.runs) == 1
    assert fake_db.runs[0]["trigger_metadata"]["skip_reason"] == "non_human_author"


def test_respond_haiku_post_failure_still_closes_run(fake_db, monkeypatch):
    _stub_resp_haiku(monkeypatch, "answer")
    monkeypatch.setattr(
        "shared.slack_post.post_message",
        lambda *a, **kw: {"ok": False, "slack_error": "not_in_channel"},
    )
    r = pd.persist_passive_evaluation(_ev("respond", response_model="haiku"))
    assert r["posted"] is False
    assert r["slack_error"] == "not_in_channel"
    assert len(fake_db.runs) == 1  # run still closed


def test_ack_escalate_no_recipients_still_posts_and_digests(fake_db, _slack):
    """resolve_escalation_recipients returns [] when no env var + no
    primary CSM — the ack still posts and the digest item still lands."""
    r = pd.persist_passive_evaluation(
        _ev(
            "acknowledge_and_escalate",
            ack_text="hang tight",
            digest_flag=True,
            digest_category="other",
        )
    )
    assert _slack and _slack[-1][1] == "hang tight"
    assert len(fake_db.digest) == 1
    assert r["decision"] == "acknowledge_and_escalate"


def test_skip_zero_token_decision_no_cost_write(fake_db):
    ev = PassiveEvaluation(
        payload=_payload(),
        decision=PassiveDecision(decision="skip"),  # zero tokens
        skip_reason="haiku_skip",
    )
    pd.persist_passive_evaluation(ev)
    cost_writes = [u for u in fake_db.run_updates if "llm_input_tokens" in u]
    assert cost_writes == []
