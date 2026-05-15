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

    def is_(self, k, v):
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
        if self._mode == "insert" and self.table == "escalations":
            self.fake.escalation_inserts.append(self._payload)
            new_id = f"esc-{len(self.fake.escalation_inserts)}"
            return SimpleNamespace(data=[{"id": new_id}])
        if self._mode == "select" and self.table == "client_team_assignments":
            return SimpleNamespace(data=[])
        if self._mode == "select" and self.table == "team_members":
            return SimpleNamespace(data=[])
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
        self.escalation_inserts = []

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
    # The shared escalation-routing fan-out and the Ella escalation
    # wrapper both reach for the DB; route them through the same fake
    # so audit-row writes + the `escalations` row write are observable.
    monkeypatch.setattr(
        "agents.ella.escalation_routing.get_client", lambda: db
    )
    # `agents.ella.escalation._resolve_primary_csm_id` and `shared.hitl.escalate`
    # each bind `get_client` at import time — patch both.
    monkeypatch.setattr("agents.ella.escalation.get_client", lambda: db)
    monkeypatch.setattr("shared.hitl.get_client", lambda: db)
    return db


def _payload(test_mode=False, author_type="client", text="Hey is the curriculum updated?"):
    return PassiveTriggerPayload(
        slack_channel_id="C123",
        triggering_message_ts="1745500100.000100",
        triggering_message_slack_user_id="UCLIENT1",
        triggering_message_text=text,
        author_type=author_type,
        channel_client_id="cli-uuid",
        test_mode=test_mode,
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


def test_escalate_writes_escalations_row_and_fans_out_dms(fake_db, monkeypatch):
    """Post-2026-05-14 unification: every escalation writes an
    `escalations` row (was: passive path skipped this) AND fans DMs to
    Scott + primary CSM via the shared `fire_escalation_dms` helper."""
    monkeypatch.setenv("ESCALATION_RECIPIENT_SLACK_USER_ID", "U_SCOTT")
    sent: list[dict[str, Any]] = []

    def _capture(channel_id, text, **_kw):
        sent.append({"channel_id": channel_id, "text": text})
        return {"ok": True, "slack_error": None}

    monkeypatch.setattr(
        "agents.ella.escalation_routing.post_message", _capture
    )

    ev = PassiveEvaluation(
        payload=_payload(),
        decision=_decision(
            decision="escalate",
            reasoning="billing dispute — auto-escalate per fence",
        ),
        primary_csm={
            "id": "tm-uuid",
            "full_name": "Lou Perez",
            "slack_user_id": "U_LOU",
        },
    )

    result = pd.persist_passive_evaluation(ev)

    assert result["decision"] == "escalate"
    assert result["escalation_id"] == "esc-1"
    # New: an `escalations` row was written with the passive context
    # shape (mirrors the reactive escalate() context closely).
    assert len(fake_db.escalation_inserts) == 1
    esc = fake_db.escalation_inserts[0]
    assert esc["agent_name"] == "ella"
    assert esc["reason"] == "ella_passive_escalated"
    assert esc["context"]["client_id"] == "cli-uuid"
    assert esc["context"]["ella_response"] == ""
    assert esc["context"]["handoff_reasoning"].startswith(
        "billing dispute"
    )

    # Two DMs fanned out: Scott first, primary CSM second.
    assert [s["channel_id"] for s in sent] == ["U_SCOTT", "U_LOU"]
    # Both DMs carry the same body shape.
    assert sent[0]["text"] == sent[1]["text"]
    assert ":eyes: Worth a look —" in sent[0]["text"]
    assert "Reasoning: billing dispute" in sent[0]["text"]
    # The triggering message text NEVER leaks into the DM body.
    assert "Hey is the curriculum updated?" not in sent[0]["text"]
    # Two audit rows (one per recipient) under the renamed source.
    assert len(fake_db.webhook_inserts) == 2
    for audit in fake_db.webhook_inserts:
        assert audit["source"] == "ella_escalation_dm"
        assert audit["payload"]["path"] == "passive"
        assert audit["payload"]["channel_client_id"] == "cli-uuid"
    # The escalate-decision agent_runs row's terminal status is now
    # 'escalated' so the dashboard treats it identically to reactive
    # escalations in the response-scope filter.
    cost_or_status_updates = fake_db.agent_runs_updates
    end_update = next(
        (p for _, p in cost_or_status_updates if "status" in p), None
    )
    assert end_update is not None
    assert end_update["status"] == "escalated"


def test_escalate_no_primary_csm_still_dms_scott(fake_db, monkeypatch):
    """With Scott configured, an escalate decision with no primary_csm
    still fires a DM to Scott and writes the escalations row. The
    legacy 'failed audit with no_primary_csm_slack_user_id' path is
    retired — primary_csm absence is no longer load-bearing."""
    monkeypatch.setenv("ESCALATION_RECIPIENT_SLACK_USER_ID", "U_SCOTT")
    sent: list[dict[str, Any]] = []

    def _capture(channel_id, text, **_kw):
        sent.append({"channel_id": channel_id})
        return {"ok": True, "slack_error": None}

    monkeypatch.setattr(
        "agents.ella.escalation_routing.post_message", _capture
    )

    ev = PassiveEvaluation(
        payload=_payload(),
        decision=_decision(decision="escalate", reasoning="billing"),
        primary_csm=None,
    )

    result = pd.persist_passive_evaluation(ev)

    assert result["decision"] == "escalate"
    assert result["escalation_id"] == "esc-1"
    assert [s["channel_id"] for s in sent] == ["U_SCOTT"]
    assert len(fake_db.webhook_inserts) == 1
    assert fake_db.webhook_inserts[0]["source"] == "ella_escalation_dm"


def test_escalate_safer_floor_env_unset_and_no_primary_csm(fake_db, monkeypatch):
    """Both env var unset AND primary_csm missing → no DMs fanned out,
    but the escalations row still lands. The output_summary records the
    no_recipients state so the audit dashboard can spot the gap."""
    monkeypatch.delenv("ESCALATION_RECIPIENT_SLACK_USER_ID", raising=False)

    sent: list = []
    monkeypatch.setattr(
        "agents.ella.escalation_routing.post_message",
        lambda *a, **kw: (sent.append(a) or {"ok": True}),
    )

    ev = PassiveEvaluation(
        payload=_payload(),
        decision=_decision(decision="escalate", reasoning="billing"),
        primary_csm=None,
    )

    result = pd.persist_passive_evaluation(ev)

    assert result["decision"] == "escalate"
    assert result["escalation_id"] == "esc-1"
    assert sent == []
    assert fake_db.webhook_inserts == []
    # Terminal status records the no-recipients summary so the gap is
    # visible in /ella/runs.
    end_update = next(
        (p for _, p in fake_db.agent_runs_updates if "status" in p), None
    )
    assert end_update is not None
    assert "no_recipients" in end_update["output_summary"]


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


# ---------------------------------------------------------------------------
# test_mode tagging (Batch 2.3 follow-up)
# ---------------------------------------------------------------------------


def test_test_mode_run_tagged_in_trigger_metadata(fake_db):
    """When the payload carries test_mode=True, persist_passive_evaluation
    stamps `test_mode_run: True` into trigger_metadata so audit queries
    can filter test traffic out of production metrics."""
    ev = PassiveEvaluation(
        payload=_payload(test_mode=True, author_type="team_member"),
        decision=_decision(decision="skip"),
        skip_reason="haiku_skip",
    )

    pd.persist_passive_evaluation(ev)

    insert = fake_db.agent_runs_inserts[0]
    assert insert["trigger_metadata"]["test_mode_run"] is True


def test_production_run_does_not_carry_test_mode_run_flag(fake_db):
    """Default test_mode=False on the payload → no test_mode_run key in
    trigger_metadata. Production audit queries with
    `trigger_metadata->>'test_mode_run' IS NULL` rely on this."""
    ev = PassiveEvaluation(
        payload=_payload(),  # default test_mode=False
        decision=_decision(),
        skip_reason="csm_directed",
    )

    pd.persist_passive_evaluation(ev)

    insert = fake_db.agent_runs_inserts[0]
    assert "test_mode_run" not in insert["trigger_metadata"]


# ---------------------------------------------------------------------------
# Escalation-keyword bypass plumbing (2026-05-14)
# ---------------------------------------------------------------------------


def test_bypass_keyword_lands_in_trigger_metadata(fake_db):
    """When evaluate_passive_trigger sets `bypass_keyword`, the
    persistence layer plumbs it onto agent_runs.trigger_metadata as
    `kb_relevance_bypass_keyword` so /ella/runs can surface which
    trigger fired."""
    ev = PassiveEvaluation(
        payload=_payload(text="I want my money back"),
        decision=_decision(decision="escalate", reasoning="cancellation intent"),
        bypass_keyword="money back",
        primary_csm={
            "id": "tm-uuid",
            "full_name": "Lou Perez",
            "slack_user_id": "U_LOU",
        },
    )

    pd.persist_passive_evaluation(ev)

    insert = fake_db.agent_runs_inserts[0]
    assert insert["trigger_metadata"]["kb_relevance_bypass_keyword"] == "money back"


def test_no_bypass_keyword_omits_field_from_trigger_metadata(fake_db):
    """When bypass_keyword is None (the common case — message reached
    Haiku via the normal KB-anchor path), the field is omitted entirely
    rather than written as null. Audit queries can use
    `trigger_metadata ? 'kb_relevance_bypass_keyword'` to count
    bypass-fired runs without false positives."""
    ev = PassiveEvaluation(
        payload=_payload(),
        decision=_decision(),
        skip_reason="csm_directed",
        bypass_keyword=None,
    )

    pd.persist_passive_evaluation(ev)

    insert = fake_db.agent_runs_inserts[0]
    assert "kb_relevance_bypass_keyword" not in insert["trigger_metadata"]
