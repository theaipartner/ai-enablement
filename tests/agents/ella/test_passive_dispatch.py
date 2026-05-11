"""Unit tests for `agents.ella.passive_dispatch.persist_passive_evaluation`.

Covers each of the four decision outcomes:
  - skip                       -> agent_runs row only, no queue insert, no DM
  - escalate                   -> agent_runs + DM + audit rows
  - respond_substantive        -> agent_runs + pending_ella_responses queue insert
  - respond_general_inquiry    -> same shape as respond_substantive

Also exercises the no-primary-CSM escalation path (DM fails cleanly,
audit row records the gap).
"""

from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace
from typing import Any

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
        self._filters = []

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

    def eq(self, k, v):
        self._filters.append((k, v))
        return self

    def limit(self, *_a, **_kw):
        return self

    def execute(self):
        if self._mode == "insert" and self.table == "agent_runs":
            self.fake.agent_runs_inserts.append(self._payload)
            new_id = f"run-{len(self.fake.agent_runs_inserts)}"
            return SimpleNamespace(data=[{"id": new_id}])
        if self._mode == "update" and self.table == "agent_runs":
            self.fake.agent_runs_updates.append((self._filters, self._payload))
            return SimpleNamespace(data=[{}])
        if self._mode == "insert" and self.table == "pending_ella_responses":
            self.fake.pending_inserts.append(self._payload)
            return SimpleNamespace(data=[{"id": "pending-1"}])
        if self._mode == "insert" and self.table == "webhook_deliveries":
            self.fake.webhook_inserts.append(self._payload)
            return SimpleNamespace(data=[{"id": "wd-1"}])
        if self._mode == "update" and self.table == "webhook_deliveries":
            self.fake.webhook_updates.append((self._filters, self._payload))
            return SimpleNamespace(data=[{}])
        raise AssertionError(
            f"unexpected execute table={self.table} mode={self._mode}"
        )


class _FakeDb:
    def __init__(self):
        self.agent_runs_inserts = []
        self.agent_runs_updates = []
        self.pending_inserts = []
        self.webhook_inserts = []
        self.webhook_updates = []

    def table(self, name):
        return _Chain(name, self)


@pytest.fixture
def fake_db(monkeypatch):
    db = _FakeDb()
    monkeypatch.setattr("shared.db.get_client", lambda: db)
    # passive_dispatch imports get_client at module top — patch the
    # bound name too.
    monkeypatch.setattr("agents.ella.passive_dispatch.get_client", lambda: db)
    # shared.logging's start_agent_run / end_agent_run also use get_client
    # at call time via its own top-level import.
    monkeypatch.setattr("shared.logging.get_client", lambda: db)
    return db


def _payload():
    return PassiveTriggerPayload(
        slack_channel_id="C123",
        triggering_message_ts="1745500100.000100",
        triggering_message_slack_user_id="UCLIENT1",
        triggering_message_text="Hey is the curriculum updated?",
        author_type="client",
        channel_client_id="cli-uuid",
    )


def _decision(decision="skip", reasoning="default-stance skip"):
    return PassiveDecision(
        decision=decision,
        reasoning=reasoning,
        haiku_cost_usd=Decimal("0.0001"),
        haiku_input_tokens=120,
        haiku_output_tokens=15,
    )


# ---------------------------------------------------------------------------
# skip
# ---------------------------------------------------------------------------


def test_skip_writes_agent_runs_row_only(fake_db):
    ev = PassiveEvaluation(
        payload=_payload(),
        decision=_decision(),
        skip_reason="csm_directed",
    )

    result = pd.persist_passive_evaluation(ev)

    assert result["decision"] == "skip"
    assert len(fake_db.agent_runs_inserts) == 1
    insert = fake_db.agent_runs_inserts[0]
    assert insert["agent_name"] == "ella"
    assert insert["trigger_type"] == "passive_monitor"
    assert insert["trigger_metadata"]["haiku_decision"] == "skip"
    assert insert["trigger_metadata"]["skip_reason"] == "csm_directed"
    # No queue insert.
    assert fake_db.pending_inserts == []
    # No escalation DM audit rows.
    assert fake_db.webhook_inserts == []


# ---------------------------------------------------------------------------
# respond_substantive
# ---------------------------------------------------------------------------


def test_respond_substantive_inserts_pending_row(fake_db):
    ev = PassiveEvaluation(
        payload=_payload(),
        decision=_decision(
            decision="respond_substantive",
            reasoning="question matches lesson 1 directly",
        ),
    )

    result = pd.persist_passive_evaluation(ev)

    assert result["decision"] == "respond_substantive"
    assert len(fake_db.pending_inserts) == 1
    pending = fake_db.pending_inserts[0]
    assert pending["slack_channel_id"] == "C123"
    assert pending["triggering_message_ts"] == "1745500100.000100"
    assert pending["haiku_decision"] == "respond_substantive"
    assert pending["haiku_reasoning"].startswith("question matches lesson")
    assert "respond_after_ts" in pending


def test_respond_general_inquiry_inserts_pending_row(fake_db):
    ev = PassiveEvaluation(
        payload=_payload(),
        decision=_decision(
            decision="respond_general_inquiry",
            reasoning="general help ask, no KB match",
        ),
    )

    result = pd.persist_passive_evaluation(ev)

    assert result["decision"] == "respond_general_inquiry"
    pending = fake_db.pending_inserts[0]
    assert pending["haiku_decision"] == "respond_general_inquiry"


# ---------------------------------------------------------------------------
# escalate
# ---------------------------------------------------------------------------


def test_escalate_fires_dm_to_primary_csm(fake_db, monkeypatch):
    """Captures the DM target via the shared.slack_post.post_message
    monkeypatch (conftest's autouse fixture returns ok=True by default)."""
    captured: dict[str, Any] = {}

    def _capture(channel_id, text, **_kw):
        captured["channel_id"] = channel_id
        captured["text"] = text
        return {"ok": True, "slack_error": None}

    monkeypatch.setattr(
        "agents.ella.passive_dispatch.post_message", _capture
    )

    ev = PassiveEvaluation(
        payload=_payload(),
        decision=_decision(
            decision="escalate",
            reasoning="billing dispute — auto-escalate per fence",
        ),
        primary_csm={
            "id": "tm-uuid",
            "full_name": "Scott Lyons",
            "slack_user_id": "UCSMSCOTT",
        },
    )

    result = pd.persist_passive_evaluation(ev)

    assert result["decision"] == "escalate"
    assert result["dm_result"]["dm_ok"] is True
    # DM went to the CSM's slack_user_id (not the channel).
    assert captured["channel_id"] == "UCSMSCOTT"
    # Body contains link + reasoning but NO quoted client message.
    assert ":eyes: Worth a look —" in captured["text"]
    assert "Reasoning: billing dispute" in captured["text"]
    # The triggering message's text must NOT leak into the DM body.
    assert "Hey is the curriculum updated?" not in captured["text"]
    # Audit row pair: insert + update.
    assert len(fake_db.webhook_inserts) == 1
    audit = fake_db.webhook_inserts[0]
    assert audit["source"] == "ella_passive_escalation_dm"


def test_escalate_no_primary_csm_records_gap(fake_db, monkeypatch):
    """An escalate decision with no primary_csm should record the gap
    in the audit ledger and return cleanly — never raise."""
    monkeypatch.setattr(
        "agents.ella.passive_dispatch.post_message",
        lambda *a, **kw: {"ok": True, "slack_error": None},
    )

    ev = PassiveEvaluation(
        payload=_payload(),
        decision=_decision(decision="escalate", reasoning="billing"),
        primary_csm=None,
    )

    result = pd.persist_passive_evaluation(ev)

    assert result["dm_result"]["dm_ok"] is False
    assert len(fake_db.webhook_inserts) == 1
    audit = fake_db.webhook_inserts[0]
    assert audit["source"] == "ella_passive_escalation_dm"
    # The audit row was updated to a failed terminal status.
    assert len(fake_db.webhook_updates) == 1
    _, update_payload = fake_db.webhook_updates[0]
    assert update_payload["processing_status"] == "failed"
    assert "no_primary_csm_slack_user_id" in update_payload["processing_error"]


# ---------------------------------------------------------------------------
# Cost accounting
# ---------------------------------------------------------------------------


def test_cost_accounting_writes_haiku_model_and_tokens(fake_db):
    ev = PassiveEvaluation(
        payload=_payload(),
        decision=_decision(decision="skip"),
        skip_reason="haiku_skip",
    )

    pd.persist_passive_evaluation(ev)

    # Cost-write update on the agent_runs row.
    update_filters_and_payloads = fake_db.agent_runs_updates
    cost_update = next(
        (p for _, p in update_filters_and_payloads if "llm_cost_usd" in p),
        None,
    )
    assert cost_update is not None
    assert cost_update["llm_model"] == "claude-haiku-4-5-20251001"
    assert cost_update["llm_input_tokens"] == 120
    assert cost_update["llm_output_tokens"] == 15
