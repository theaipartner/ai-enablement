"""Tests for the passive-monitor fork inside `realtime_ingest.ingest_message_event`.

The Batch 1 path (channel allowlist + parse + upsert + audit) is
covered exhaustively by `tests/api/test_slack_events_message_ingest.py`.
This file pins the Batch 2.3 addition:

  - When `slack_channels.passive_monitoring_enabled=true` AND
    `author_type='client'`, the helper dispatches into
    `agents.ella.passive_monitor.evaluate_passive_trigger`.
  - When `passive_monitoring_enabled=false`, no dispatch fires.
  - When the dispatch raises, the ingest itself still succeeds and
    a `webhook_deliveries.source='ella_passive_monitor_error'` audit
    row is written.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from ingestion.slack import realtime_ingest as ri


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

    def upsert(self, payload, **_kw):
        self._mode = "upsert"
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
        self._filters.append((k, f"is:{v}"))
        return self

    def limit(self, *_a, **_kw):
        return self

    def execute(self):
        if self._mode == "select" and self.table == "slack_channels":
            return SimpleNamespace(data=list(self.fake.channel_rows))
        if self._mode == "select" and self.table == "clients":
            return SimpleNamespace(data=list(self.fake.clients))
        if self._mode == "select" and self.table == "team_members":
            return SimpleNamespace(data=list(self.fake.team_members))
        if self._mode == "upsert" and self.table == "slack_messages":
            self.fake.upserts.append(self._payload)
            return SimpleNamespace(data=[{"id": "m-1"}])
        if self._mode == "upsert" and self.table == "webhook_deliveries":
            # Post-2026-05-20 dedup-gate step 0. Returns the row on
            # first call per webhook_id; empty on retry to signal
            # the duplicate.
            self.fake.webhook_upserts.append(self._payload)
            wid = self._payload.get("webhook_id")
            if wid in self.fake._upsert_seen_ids:
                return SimpleNamespace(data=[])
            self.fake._upsert_seen_ids.add(wid)
            return SimpleNamespace(data=[{"id": "wd-1", "webhook_id": wid}])
        if self._mode == "update" and self.table == "webhook_deliveries":
            self.fake.webhook_updates.append(self._payload)
            return SimpleNamespace(data=[{}])
        if self._mode == "insert" and self.table == "webhook_deliveries":
            self.fake.webhook_inserts.append(self._payload)
            return SimpleNamespace(data=[{"id": "wd-1"}])
        raise AssertionError(
            f"unexpected execute table={self.table} mode={self._mode}"
        )


class _FakeDb:
    def __init__(self):
        self.channel_rows: list[dict] = []
        self.clients: list[dict] = []
        self.team_members: list[dict] = []
        self.upserts: list[Any] = []
        self.webhook_inserts: list[Any] = []
        self.webhook_upserts: list[Any] = []
        self.webhook_updates: list[Any] = []
        self._upsert_seen_ids: set[str] = set()

    def table(self, name):
        return _Chain(name, self)


@pytest.fixture
def fake_db(monkeypatch):
    db = _FakeDb()
    monkeypatch.setattr("shared.db.get_client", lambda: db)
    return db


@pytest.fixture(autouse=True)
def _stub_user_token(monkeypatch):
    monkeypatch.delenv("SLACK_USER_TOKEN", raising=False)


def _envelope(event):
    return {
        "type": "event_callback",
        "event": event,
        "team_id": "T1",
        "event_id": "Ev1",
    }


# ---------------------------------------------------------------------------
# Dispatch fires
# ---------------------------------------------------------------------------


def test_passive_fork_dispatches_when_enabled(fake_db, monkeypatch):
    fake_db.channel_rows = [
        {
            "id": "ch-1",
            "slack_channel_id": "C100",
            "client_id": "client-uuid-1",
            "is_archived": False,
            "passive_monitoring_enabled": True,
        }
    ]
    fake_db.clients = [{"slack_user_id": "UCLIENT1"}]

    captured: dict[str, Any] = {}

    def _stub_evaluate(payload):
        captured["payload"] = payload
        return SimpleNamespace(
            payload=payload,
            decision=SimpleNamespace(
                decision="skip",
                reasoning="default skip",
            ),
            skip_reason="haiku_skip",
        )

    def _stub_persist(ev):
        captured["persisted"] = True
        return {"decision": "skip"}

    monkeypatch.setattr(
        "agents.ella.passive_monitor.evaluate_passive_trigger", _stub_evaluate
    )
    monkeypatch.setattr(
        "agents.ella.passive_dispatch.persist_passive_evaluation", _stub_persist
    )

    result = ri.ingest_message_event(
        _envelope({
            "type": "message",
            "channel": "C100",
            "user": "UCLIENT1",
            "text": "Hey what's the next module about?",
            "ts": "1745500000.000100",
        })
    )

    # Ingest itself succeeded.
    assert result["ingested"] is True
    # Fork fired.
    assert "payload" in captured
    assert captured["payload"].slack_channel_id == "C100"
    assert captured["payload"].author_type == "client"
    assert captured["persisted"] is True


def test_passive_fork_skipped_when_disabled(fake_db, monkeypatch):
    fake_db.channel_rows = [
        {
            "id": "ch-1",
            "slack_channel_id": "C100",
            "client_id": "client-uuid-1",
            "is_archived": False,
            "passive_monitoring_enabled": False,
        }
    ]
    fake_db.clients = [{"slack_user_id": "UCLIENT1"}]

    called = {"count": 0}

    def _stub_evaluate(payload):
        called["count"] += 1
        return None

    monkeypatch.setattr(
        "agents.ella.passive_monitor.evaluate_passive_trigger", _stub_evaluate
    )

    result = ri.ingest_message_event(
        _envelope({
            "type": "message",
            "channel": "C100",
            "user": "UCLIENT1",
            "text": "test",
            "ts": "1745500001.000100",
        })
    )

    assert result["ingested"] is True
    assert called["count"] == 0  # fork did not fire


def test_passive_fork_exception_audited_but_ingest_succeeds(fake_db, monkeypatch):
    fake_db.channel_rows = [
        {
            "id": "ch-1",
            "slack_channel_id": "C100",
            "client_id": "client-uuid-1",
            "is_archived": False,
            "passive_monitoring_enabled": True,
        }
    ]
    fake_db.clients = [{"slack_user_id": "UCLIENT1"}]

    def _raise(payload):
        raise RuntimeError("unexpected passive bug")

    monkeypatch.setattr(
        "agents.ella.passive_monitor.evaluate_passive_trigger", _raise
    )

    result = ri.ingest_message_event(
        _envelope({
            "type": "message",
            "channel": "C100",
            "user": "UCLIENT1",
            "text": "test",
            "ts": "1745500002.000100",
        })
    )

    # Ingest succeeds despite the fork exception.
    assert result["ingested"] is True
    # Audit ledger post-2026-05-20:
    #   - slack_message_ingest source appears in the step-0 UPSERT
    #     (received) and the lifecycle UPDATE (processed).
    #   - ella_passive_monitor_error remains a plain INSERT.
    upsert_sources = [w["source"] for w in fake_db.webhook_upserts]
    assert "slack_message_ingest" in upsert_sources
    insert_sources = [w["source"] for w in fake_db.webhook_inserts]
    assert "ella_passive_monitor_error" in insert_sources
    error_row = next(
        w for w in fake_db.webhook_inserts
        if w["source"] == "ella_passive_monitor_error"
    )
    assert error_row["processing_status"] == "failed"
    assert "unexpected passive bug" in error_row["processing_error"]


# --- is_routed_to_others plumbing ---------------------------------------


def test_passive_fork_plumbs_is_routed_to_others(fake_db, monkeypatch):
    """Non-Ella @-mention in the message text → payload.is_routed_to_others
    is True when reaching the passive fork."""
    fake_db.channel_rows = [
        {
            "id": "ch-1",
            "slack_channel_id": "C100",
            "client_id": "client-uuid-1",
            "is_archived": False,
            "passive_monitoring_enabled": True,
        }
    ]
    fake_db.clients = [{"slack_user_id": "UCLIENT1"}]

    captured: dict[str, Any] = {}

    def _stub_evaluate(payload):
        captured["payload"] = payload
        return SimpleNamespace(
            payload=payload,
            decision=SimpleNamespace(decision="skip", reasoning="r"),
            skip_reason="routed_to_humans",
        )

    monkeypatch.setattr(
        "agents.ella.passive_monitor.evaluate_passive_trigger", _stub_evaluate
    )
    monkeypatch.setattr(
        "agents.ella.passive_dispatch.persist_passive_evaluation",
        lambda ev: {"decision": "skip"},
    )

    # No SLACK_*_TOKEN set in this test, so Ella IDs resolve to None;
    # any <@U...> mention becomes routed-to-others by construction.
    ri.ingest_message_event(
        _envelope({
            "type": "message",
            "channel": "C100",
            "user": "UCLIENT1",
            "text": "<@U0DRAKE> can you take a look",
            "ts": "1745500003.000100",
        })
    )

    payload = captured["payload"]
    assert payload.is_routed_to_others is True
    assert payload.is_ella_mentioned is False


def test_passive_fork_no_mention_no_routing_flag(fake_db, monkeypatch):
    """Plain message with no @-mentions → both flags are False;
    decision-Haiku path runs as before."""
    fake_db.channel_rows = [
        {
            "id": "ch-1",
            "slack_channel_id": "C100",
            "client_id": "client-uuid-1",
            "is_archived": False,
            "passive_monitoring_enabled": True,
        }
    ]
    fake_db.clients = [{"slack_user_id": "UCLIENT1"}]

    captured: dict[str, Any] = {}

    def _stub_evaluate(payload):
        captured["payload"] = payload
        return SimpleNamespace(
            payload=payload,
            decision=SimpleNamespace(decision="skip", reasoning="r"),
            skip_reason="haiku_skip",
        )

    monkeypatch.setattr(
        "agents.ella.passive_monitor.evaluate_passive_trigger", _stub_evaluate
    )
    monkeypatch.setattr(
        "agents.ella.passive_dispatch.persist_passive_evaluation",
        lambda ev: {"decision": "skip"},
    )

    ri.ingest_message_event(
        _envelope({
            "type": "message",
            "channel": "C100",
            "user": "UCLIENT1",
            "text": "just thinking out loud here",
            "ts": "1745500004.000100",
        })
    )

    payload = captured["payload"]
    assert payload.is_routed_to_others is False
    assert payload.is_ella_mentioned is False


# ---------------------------------------------------------------------------
# Split-path fork tests (2026-05-23) — @-mentions route to the new @ handler;
# non-@-mention messages stay on the passive observation path.
# ---------------------------------------------------------------------------


def test_bot_mention_routes_to_at_handler_not_passive(fake_db, monkeypatch):
    """Spec acceptance case (a): @-mention of the BOT user_id routes
    through `agents.ella.agent.handle_at_mention`, NOT through the
    passive monitor. The two paths must not co-fire."""
    fake_db.channel_rows = [
        {
            "id": "ch-1",
            "slack_channel_id": "C100",
            "client_id": "client-uuid-1",
            "is_archived": False,
            "passive_monitoring_enabled": True,
        }
    ]
    fake_db.clients = [{"slack_user_id": "UCLIENT1"}]
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-fake")
    monkeypatch.setenv("SLACK_USER_TOKEN", "")
    monkeypatch.setattr(
        "ingestion.slack.realtime_ingest.get_user_id_for_token",
        lambda token: "UBOT0001" if token == "xoxb-fake" else None,
    )

    at_calls = []
    passive_calls = []

    def _at_handler(payload):
        at_calls.append(payload)
        return SimpleNamespace(
            agent_run_id="run-at",
            trigger_type="slack_mention",
            response_text="x",
            escalated=False,
            escalation_id=None,
            posted=True,
            status="success",
        )

    monkeypatch.setattr("agents.ella.agent.handle_at_mention", _at_handler)
    monkeypatch.setattr(
        "agents.ella.passive_monitor.evaluate_passive_trigger",
        lambda payload: passive_calls.append(payload) or SimpleNamespace(),
    )
    monkeypatch.setattr(
        "agents.ella.passive_dispatch.persist_passive_evaluation",
        lambda ev: {"decision": "skip"},
    )

    ri.ingest_message_event(
        _envelope({
            "type": "message",
            "channel": "C100",
            "user": "UCLIENT1",
            "text": "<@UBOT0001> what's covered in module 3",
            "ts": "1745500010.000100",
        })
    )

    # @ handler called exactly once
    assert len(at_calls) == 1
    assert at_calls[0].is_ella_mentioned is True
    assert at_calls[0].slack_channel_id == "C100"
    # Passive monitor NOT called — split prevents double-fire
    assert passive_calls == []


def test_human_token_mention_routes_to_at_handler(fake_db, monkeypatch):
    """Spec acceptance case (b): @-mention of the HUMAN account user_id
    (SLACK_USER_TOKEN's user) also triggers the @ handler, not passive."""
    fake_db.channel_rows = [
        {
            "id": "ch-1",
            "slack_channel_id": "C100",
            "client_id": "client-uuid-1",
            "is_archived": False,
            "passive_monitoring_enabled": True,
        }
    ]
    fake_db.clients = [{"slack_user_id": "UCLIENT1"}]
    monkeypatch.setenv("SLACK_BOT_TOKEN", "")
    monkeypatch.setenv("SLACK_USER_TOKEN", "xoxp-fake")
    monkeypatch.setattr(
        "ingestion.slack.realtime_ingest.get_user_id_for_token",
        lambda token: "UHUMAN001" if token == "xoxp-fake" else None,
    )

    at_calls = []
    passive_calls = []
    monkeypatch.setattr(
        "agents.ella.agent.handle_at_mention",
        lambda payload: (
            at_calls.append(payload)
            or SimpleNamespace(
                agent_run_id="run-at",
                trigger_type="slack_mention",
                response_text="x",
                escalated=False,
                escalation_id=None,
                posted=True,
                status="success",
            )
        ),
    )
    monkeypatch.setattr(
        "agents.ella.passive_monitor.evaluate_passive_trigger",
        lambda payload: passive_calls.append(payload) or SimpleNamespace(),
    )

    ri.ingest_message_event(
        _envelope({
            "type": "message",
            "channel": "C100",
            "user": "UCLIENT1",
            "text": "<@UHUMAN001> can you help with the sales module",
            "ts": "1745500011.000100",
        })
    )

    assert len(at_calls) == 1
    assert at_calls[0].is_ella_mentioned is True
    assert passive_calls == []


def test_non_mention_routes_to_passive_not_at_handler(fake_db, monkeypatch):
    """Spec acceptance case (e): a non-@-mention message still goes
    through the passive observation path (which now writes a digest
    item but no in-channel post). The @ handler must NOT be called."""
    fake_db.channel_rows = [
        {
            "id": "ch-1",
            "slack_channel_id": "C100",
            "client_id": "client-uuid-1",
            "is_archived": False,
            "passive_monitoring_enabled": True,
        }
    ]
    fake_db.clients = [{"slack_user_id": "UCLIENT1"}]
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-fake")
    monkeypatch.setattr(
        "ingestion.slack.realtime_ingest.get_user_id_for_token",
        lambda token: "UBOT0001" if token == "xoxb-fake" else None,
    )

    at_calls = []
    passive_calls = []
    monkeypatch.setattr(
        "agents.ella.agent.handle_at_mention",
        lambda payload: at_calls.append(payload),
    )
    monkeypatch.setattr(
        "agents.ella.passive_monitor.evaluate_passive_trigger",
        lambda payload: (
            passive_calls.append(payload)
            or SimpleNamespace(
                payload=payload,
                decision=SimpleNamespace(decision="skip", reasoning="r"),
                skip_reason="haiku_skip",
            )
        ),
    )
    monkeypatch.setattr(
        "agents.ella.passive_dispatch.persist_passive_evaluation",
        lambda ev: {"decision": "skip"},
    )

    ri.ingest_message_event(
        _envelope({
            "type": "message",
            "channel": "C100",
            "user": "UCLIENT1",
            "text": "just thinking out loud, no mention",
            "ts": "1745500012.000100",
        })
    )

    assert at_calls == []
    assert len(passive_calls) == 1
    assert passive_calls[0].is_ella_mentioned is False
