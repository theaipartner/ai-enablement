"""Unit tests for `agents.ella.passive_dispatch.persist_passive_evaluation`.

Covers the unified-decision side-effect routing:
  - kill_switch          -> NO agent_runs row at all
  - skip                 -> agent_runs row; pending_digest_items only
                            when digest_flag
  - respond_haiku_self   -> response Haiku, Slack post; fallback token
                            routes to the Sonnet pending path
  - respond_via_sonnet   -> pending_ella_responses insert
  - digest_only          -> no post / no escalations row / no DM;
                            pending_digest_items always inserted
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
# Fake DB
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
            self.fake.agent_runs_inserts.append(self._payload)
            return SimpleNamespace(
                data=[{"id": f"run-{len(self.fake.agent_runs_inserts)}"}]
            )
        if m == "update" and t == "agent_runs":
            self.fake.agent_runs_updates.append(self._payload)
            return SimpleNamespace(data=[{}])
        if m == "insert" and t == "pending_ella_responses":
            self.fake.pending_inserts.append(self._payload)
            return SimpleNamespace(data=[{"id": "pending-1"}])
        if m == "insert" and t == "pending_digest_items":
            if self.fake.digest_dedup_raises:
                raise RuntimeError("duplicate key value violates unique constraint")
            self.fake.digest_inserts.append(self._payload)
            return SimpleNamespace(data=[{"id": f"dg-{len(self.fake.digest_inserts)}"}])
        if m == "insert" and t == "webhook_deliveries":
            self.fake.webhook_inserts.append(self._payload)
            return SimpleNamespace(data=[{"id": "wd-1"}])
        if m == "update" and t == "webhook_deliveries":
            return SimpleNamespace(data=[{}])
        if m == "insert" and t == "escalations":
            self.fake.escalation_inserts.append(self._payload)
            return SimpleNamespace(data=[{"id": "esc-1"}])
        if m == "select" and t in ("client_team_assignments", "team_members"):
            return SimpleNamespace(data=[])
        raise AssertionError(f"unexpected execute table={t} mode={m}")


class _FakeDb:
    def __init__(self):
        self.agent_runs_inserts = []
        self.agent_runs_updates = []
        self.pending_inserts = []
        self.digest_inserts = []
        self.webhook_inserts = []
        self.escalation_inserts = []
        self.digest_dedup_raises = False

    def table(self, name):
        return _Chain(name, self)


@pytest.fixture
def fake_db(monkeypatch):
    db = _FakeDb()
    monkeypatch.setattr("shared.db.get_client", lambda: db)
    monkeypatch.setattr("agents.ella.passive_dispatch.get_client", lambda: db)
    monkeypatch.setattr("shared.logging.get_client", lambda: db)
    return db


@pytest.fixture(autouse=True)
def _no_real_slack(monkeypatch):
    monkeypatch.setattr(
        "shared.slack_post.post_message",
        lambda *a, **kw: {"ok": True, "slack_error": None},
    )


def _payload(text="Is the curriculum updated?"):
    return PassiveTriggerPayload(
        slack_channel_id="C123",
        triggering_message_ts="1745500100.000100",
        triggering_message_slack_user_id="UCLIENT1",
        triggering_message_text=text,
        author_type="client",
        channel_client_id="cli-uuid",
    )


def _decision(decision="skip", digest_flag=False, digest_category=None):
    return PassiveDecision(
        decision=decision,
        digest_flag=digest_flag,
        digest_category=digest_category,
        reasoning=f"{decision} reasoning",
        haiku_cost_usd=Decimal("0.0001"),
        haiku_input_tokens=120,
        haiku_output_tokens=15,
    )


def _ev(decision, **dkw):
    return PassiveEvaluation(
        payload=_payload(),
        decision=_decision(decision, **dkw),
        skip_reason="haiku_skip" if decision == "skip" else None,
    )


def _stub_response_haiku(monkeypatch, *, fallback=False, text="Here you go!"):
    monkeypatch.setattr(
        "agents.ella.digest_response.generate_response",
        lambda **kw: SimpleNamespace(
            response_text="" if fallback else text,
            fallback_to_sonnet=fallback,
            cost_usd=Decimal("0.00002"),
            input_tokens=40,
            output_tokens=80,
        ),
    )


# ---------------------------------------------------------------------------
# kill switch — no agent_runs row
# ---------------------------------------------------------------------------


def test_kill_switch_writes_no_agent_runs_row(fake_db):
    ev = PassiveEvaluation(
        payload=_payload(),
        decision=_decision("skip"),
        skip_reason="kill_switch",
    )
    result = pd.persist_passive_evaluation(ev)
    assert result["skip_reason"] == "kill_switch"
    assert result["agent_run_id"] is None
    assert fake_db.agent_runs_inserts == []
    assert fake_db.digest_inserts == []


# ---------------------------------------------------------------------------
# skip
# ---------------------------------------------------------------------------


def test_skip_no_flag_writes_run_only(fake_db):
    pd.persist_passive_evaluation(_ev("skip", digest_flag=False))
    assert len(fake_db.agent_runs_inserts) == 1
    assert fake_db.digest_inserts == []
    assert fake_db.pending_inserts == []


def test_skip_with_flag_writes_digest_item(fake_db):
    pd.persist_passive_evaluation(
        _ev("skip", digest_flag=True, digest_category="money_commitment")
    )
    assert len(fake_db.agent_runs_inserts) == 1
    assert len(fake_db.digest_inserts) == 1
    row = fake_db.digest_inserts[0]
    assert row["haiku_decision"] == "skip"
    assert row["digest_category"] == "money_commitment"
    assert row["ella_responded"] is False


# ---------------------------------------------------------------------------
# respond_haiku_self
# ---------------------------------------------------------------------------


def test_respond_haiku_self_posts_and_writes_run(fake_db, monkeypatch):
    posted = {}
    monkeypatch.setattr(
        "shared.slack_post.post_message",
        lambda ch, txt, **kw: posted.update(channel=ch, text=txt)
        or {"ok": True, "slack_error": None},
    )
    _stub_response_haiku(monkeypatch, fallback=False, text="The KB says X.")
    result = pd.persist_passive_evaluation(_ev("respond_haiku_self"))
    assert result["decision"] == "respond_haiku_self"
    assert result["posted"] is True
    assert posted["text"] == "The KB says X."
    assert len(fake_db.agent_runs_inserts) == 1
    assert fake_db.pending_inserts == []


def test_respond_haiku_self_fallback_routes_to_sonnet(fake_db, monkeypatch):
    _stub_response_haiku(monkeypatch, fallback=True)
    result = pd.persist_passive_evaluation(_ev("respond_haiku_self"))
    assert result["fallback_to_sonnet"] is True
    # The Sonnet pending row is written with the cron-known decision.
    assert len(fake_db.pending_inserts) == 1
    assert fake_db.pending_inserts[0]["haiku_decision"] == "respond_substantive"


def test_respond_haiku_self_flag_inserts_digest_responded_true(fake_db, monkeypatch):
    _stub_response_haiku(monkeypatch, fallback=False)
    pd.persist_passive_evaluation(
        _ev("respond_haiku_self", digest_flag=True, digest_category="question_program")
    )
    assert len(fake_db.digest_inserts) == 1
    assert fake_db.digest_inserts[0]["ella_responded"] is True


def test_respond_haiku_self_combines_cost(fake_db, monkeypatch):
    _stub_response_haiku(monkeypatch, fallback=False)
    pd.persist_passive_evaluation(_ev("respond_haiku_self"))
    # decision (120/15) + response (40/80) tokens summed in the cost write
    upd = [u for u in fake_db.agent_runs_updates if "llm_input_tokens" in u]
    assert upd and upd[0]["llm_input_tokens"] == 160
    assert upd[0]["llm_output_tokens"] == 95


# ---------------------------------------------------------------------------
# respond_via_sonnet
# ---------------------------------------------------------------------------


def test_respond_via_sonnet_inserts_pending(fake_db):
    result = pd.persist_passive_evaluation(_ev("respond_via_sonnet"))
    assert result["decision"] == "respond_via_sonnet"
    assert len(fake_db.pending_inserts) == 1
    assert fake_db.pending_inserts[0]["haiku_decision"] == "respond_substantive"


def test_respond_via_sonnet_flag_inserts_digest(fake_db):
    pd.persist_passive_evaluation(
        _ev("respond_via_sonnet", digest_flag=True, digest_category="confusion")
    )
    assert len(fake_db.digest_inserts) == 1
    assert fake_db.digest_inserts[0]["ella_responded"] is True


# ---------------------------------------------------------------------------
# digest_only
# ---------------------------------------------------------------------------


def test_digest_only_no_post_no_escalation_no_dm(fake_db):
    ev = PassiveEvaluation(
        payload=_payload(),
        decision=_decision(
            "digest_only", digest_flag=True, digest_category="complaint"
        ),
    )
    result = pd.persist_passive_evaluation(ev)
    assert result["decision"] == "digest_only"
    assert len(fake_db.digest_inserts) == 1
    # No escalations row, no DM audit rows on the passive path anymore.
    assert fake_db.escalation_inserts == []
    assert fake_db.webhook_inserts == []
    assert fake_db.pending_inserts == []


def test_digest_only_inserts_exactly_one_digest_item(fake_db):
    ev = PassiveEvaluation(
        payload=_payload(),
        decision=_decision("digest_only", digest_flag=True),
    )
    pd.persist_passive_evaluation(ev)
    assert len(fake_db.digest_inserts) == 1


# ---------------------------------------------------------------------------
# dedup idempotency
# ---------------------------------------------------------------------------


def test_digest_insert_dedup_is_swallowed(fake_db):
    """A re-fire hitting the unique index is logged + tolerated; the
    decision still completes (returns digest_item_id=None)."""
    fake_db.digest_dedup_raises = True
    ev = PassiveEvaluation(
        payload=_payload(),
        decision=_decision("digest_only", digest_flag=True),
    )
    result = pd.persist_passive_evaluation(ev)
    assert result["decision"] == "digest_only"
    assert result["digest_item_id"] is None
    assert fake_db.digest_inserts == []
    # The agent_runs row still closed cleanly.
    assert len(fake_db.agent_runs_inserts) == 1


# ---------------------------------------------------------------------------
# trigger_metadata shape
# ---------------------------------------------------------------------------


def test_trigger_metadata_carries_new_fields(fake_db):
    pd.persist_passive_evaluation(
        _ev("skip", digest_flag=True, digest_category="other")
    )
    meta = fake_db.agent_runs_inserts[0]["trigger_metadata"]
    assert meta["haiku_decision"] == "skip"
    assert meta["digest_flag"] is True
    assert meta["digest_category"] == "other"
    assert "kb_relevance_bypass_keyword" not in meta
