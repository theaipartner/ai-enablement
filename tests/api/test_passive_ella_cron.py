"""Unit tests for `api.passive_ella_cron.run_passive_ella_cron`.

Covers each per-row outcome:
  - global kill switch off          -> cancelled_kill_switch
  - per-channel toggle off          -> cancelled_channel_disabled
  - CSM intervention                -> cancelled_csm_intervened
  - happy path respond_substantive  -> responded
  - happy path respond_general_inquiry -> responded
  - generation raises               -> error

The HTTP `_verify_auth` is exercised in `test_passive_ella_cron_auth`.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from api import passive_ella_cron as cron
from agents.ella.agent import PassiveResponseResult


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

    def update(self, payload):
        self._mode = "update"
        self._payload = payload
        return self

    def eq(self, k, v):
        self._filters.append(("eq", k, v))
        return self

    def lte(self, k, v):
        self._filters.append(("lte", k, v))
        return self

    def gt(self, k, v):
        self._filters.append(("gt", k, v))
        return self

    def in_(self, k, v):
        self._filters.append(("in", k, list(v)))
        return self

    def order(self, *_a, **_kw):
        return self

    def limit(self, *_a, **_kw):
        return self

    def execute(self):
        if self._mode == "select" and self.table == "pending_ella_responses":
            return SimpleNamespace(data=list(self.fake.due_rows))
        if self._mode == "update" and self.table == "pending_ella_responses":
            self.fake.pending_updates.append((self._filters, self._payload))
            return SimpleNamespace(data=[{}])
        if self._mode == "select" and self.table == "slack_channels":
            return SimpleNamespace(data=self.fake.channel_rows)
        if self._mode == "select" and self.table == "slack_messages":
            return SimpleNamespace(data=self.fake.intervention_rows)
        raise AssertionError(
            f"unexpected execute table={self.table} mode={self._mode}"
        )


class _FakeDb:
    def __init__(self):
        self.due_rows: list[dict] = []
        self.channel_rows: list[dict] = []
        self.intervention_rows: list[dict] = []
        self.pending_updates: list[tuple] = []

    def table(self, name):
        return _Chain(name, self)


@pytest.fixture
def fake_db(monkeypatch):
    db = _FakeDb()
    monkeypatch.setattr("shared.db.get_client", lambda: db)
    monkeypatch.setattr("api.passive_ella_cron.get_client", lambda: db)
    return db


@pytest.fixture(autouse=True)
def _stub_env(monkeypatch):
    monkeypatch.setenv("ELLA_PASSIVE_MONITORING_ENABLED", "true")
    # Stub user-id resolution so no auth.test call is made.
    monkeypatch.setattr(
        "api.passive_ella_cron.get_user_id_for_token",
        lambda token: "UBOT" if token == "fake-bot-token" else None,
    )
    monkeypatch.setenv("SLACK_BOT_TOKEN", "fake-bot-token")
    monkeypatch.delenv("SLACK_USER_TOKEN", raising=False)


def _pending_row(
    id_="p-1",
    decision="respond_substantive",
    channel="C123",
    ts="1745500100.000100",
):
    return {
        "id": id_,
        "slack_channel_id": channel,
        "triggering_message_ts": ts,
        "triggering_message_slack_user_id": "UCLIENT1",
        "haiku_decision": decision,
        "haiku_reasoning": "test reasoning",
        "respond_after_ts": "2026-05-10T00:00:00Z",
        "status": "queued",
    }


# ---------------------------------------------------------------------------
# Gate: global kill switch off
# ---------------------------------------------------------------------------


def test_global_kill_switch_off_cancels_all_rows(fake_db, monkeypatch):
    monkeypatch.setenv("ELLA_PASSIVE_MONITORING_ENABLED", "false")
    fake_db.due_rows = [_pending_row("p-1"), _pending_row("p-2")]

    result = cron.run_passive_ella_cron()

    assert result == {
        "processed": 2,
        "responded": 0,
        "cancelled": 2,
        "errored": 0,
    }
    statuses = [
        upd[1]["status"] for upd in fake_db.pending_updates
    ]
    assert statuses == ["cancelled_kill_switch", "cancelled_kill_switch"]


# ---------------------------------------------------------------------------
# Gate: per-channel toggle off
# ---------------------------------------------------------------------------


def test_per_channel_disabled_cancels_row(fake_db):
    fake_db.due_rows = [_pending_row()]
    fake_db.channel_rows = [
        {
            "id": "ch-uuid",
            "slack_channel_id": "C123",
            "passive_monitoring_enabled": False,
        }
    ]

    result = cron.run_passive_ella_cron()

    assert result["cancelled"] == 1
    assert fake_db.pending_updates[0][1]["status"] == "cancelled_channel_disabled"


def test_missing_channel_row_cancels(fake_db):
    fake_db.due_rows = [_pending_row()]
    fake_db.channel_rows = []  # channel deleted between insert and drain

    result = cron.run_passive_ella_cron()

    assert result["cancelled"] == 1
    assert fake_db.pending_updates[0][1]["status"] == "cancelled_channel_disabled"


# ---------------------------------------------------------------------------
# Gate: CSM intervention
# ---------------------------------------------------------------------------


def test_csm_intervention_cancels_row(fake_db):
    fake_db.due_rows = [_pending_row()]
    fake_db.channel_rows = [
        {"slack_channel_id": "C123", "passive_monitoring_enabled": True}
    ]
    fake_db.intervention_rows = [
        {
            "slack_user_id": "UTEAM1",
            "author_type": "team_member",
            "slack_ts": "1745500200.000000",
        }
    ]

    result = cron.run_passive_ella_cron()

    assert result["cancelled"] == 1
    assert fake_db.pending_updates[0][1]["status"] == "cancelled_csm_intervened"


def test_intervention_check_excludes_ella_own_post(fake_db):
    """If the only message in the window is Ella's own bot/user post,
    the intervention check must NOT count it as a CSM interruption."""
    fake_db.due_rows = [_pending_row()]
    fake_db.channel_rows = [
        {"slack_channel_id": "C123", "passive_monitoring_enabled": True}
    ]
    fake_db.intervention_rows = [
        {
            "slack_user_id": "UBOT",
            "author_type": "ella",
            "slack_ts": "1745500200.000000",
        }
    ]

    # Stub respond_to_passive_trigger so we don't actually call Sonnet.
    import agents.ella.agent as ella_agent
    ella_agent._stub_called = False

    def _stub(pending):
        ella_agent._stub_called = True
        return PassiveResponseResult(
            response_text="answer",
            agent_run_id="run-1",
            posted=True,
            slack_error=None,
        )

    import api.passive_ella_cron as cron_mod
    # The cron imports lazily inside _process_row — patch the agent
    # module's function directly.
    import agents.ella.agent as agent_mod
    original = agent_mod.respond_to_passive_trigger
    agent_mod.respond_to_passive_trigger = _stub
    try:
        result = cron_mod.run_passive_ella_cron()
    finally:
        agent_mod.respond_to_passive_trigger = original

    # Substantive dispatched, NOT intervention-cancelled.
    assert result["responded"] == 1
    assert result["cancelled"] == 0
    assert ella_agent._stub_called is True


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_respond_substantive_happy_path(fake_db, monkeypatch):
    fake_db.due_rows = [_pending_row(decision="respond_substantive")]
    fake_db.channel_rows = [
        {"slack_channel_id": "C123", "passive_monitoring_enabled": True}
    ]
    fake_db.intervention_rows = []

    import agents.ella.agent as agent_mod

    def _stub(pending):
        return PassiveResponseResult(
            response_text="answer",
            agent_run_id="run-1",
            posted=True,
            slack_error=None,
        )

    monkeypatch.setattr(agent_mod, "respond_to_passive_trigger", _stub)

    result = cron.run_passive_ella_cron()

    assert result["responded"] == 1
    assert fake_db.pending_updates[0][1]["status"] == "responded"
    assert "responded_at" in fake_db.pending_updates[0][1]


def test_respond_general_inquiry_happy_path(fake_db, monkeypatch):
    fake_db.due_rows = [_pending_row(decision="respond_general_inquiry")]
    fake_db.channel_rows = [
        {"slack_channel_id": "C123", "passive_monitoring_enabled": True}
    ]
    fake_db.intervention_rows = []

    import agents.ella.agent as agent_mod

    def _stub(pending):
        return PassiveResponseResult(
            response_text="opener",
            agent_run_id="run-2",
            posted=True,
            slack_error=None,
        )

    monkeypatch.setattr(agent_mod, "handle_passive_general_inquiry", _stub)

    result = cron.run_passive_ella_cron()

    assert result["responded"] == 1


# ---------------------------------------------------------------------------
# Errors are isolated per row
# ---------------------------------------------------------------------------


def test_per_row_exception_isolated(fake_db, monkeypatch):
    fake_db.due_rows = [
        _pending_row("p-1", decision="respond_substantive"),
        _pending_row("p-2", decision="respond_general_inquiry"),
    ]
    fake_db.channel_rows = [
        {"slack_channel_id": "C123", "passive_monitoring_enabled": True}
    ]
    fake_db.intervention_rows = []

    import agents.ella.agent as agent_mod

    def _raise(pending):
        raise RuntimeError("sonnet api 500")

    def _stub(pending):
        return PassiveResponseResult(
            response_text="opener",
            agent_run_id="run-3",
            posted=True,
            slack_error=None,
        )

    monkeypatch.setattr(agent_mod, "respond_to_passive_trigger", _raise)
    monkeypatch.setattr(agent_mod, "handle_passive_general_inquiry", _stub)

    result = cron.run_passive_ella_cron()

    # Bad row marked error; good row still drained.
    assert result["responded"] == 1
    assert result["errored"] == 1


def test_unknown_haiku_decision_marks_error(fake_db):
    fake_db.due_rows = [_pending_row(decision="hallucinated_option")]
    fake_db.channel_rows = [
        {"slack_channel_id": "C123", "passive_monitoring_enabled": True}
    ]
    fake_db.intervention_rows = []

    result = cron.run_passive_ella_cron()

    assert result["errored"] == 1
    error_update = fake_db.pending_updates[0][1]
    assert error_update["status"] == "error"
    assert "hallucinated_option" in error_update["error_message"]


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def test_verify_auth_missing_secret_returns_false(monkeypatch):
    monkeypatch.delenv("CRON_SECRET", raising=False)
    headers = {"Authorization": "Bearer anything"}
    assert cron._verify_auth(headers) is False


def test_verify_auth_bad_token_returns_false(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "right-token")
    headers = {"Authorization": "Bearer wrong-token"}
    assert cron._verify_auth(headers) is False


def test_verify_auth_missing_bearer_prefix_returns_false(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "right-token")
    headers = {"Authorization": "right-token"}
    assert cron._verify_auth(headers) is False


def test_verify_auth_happy_path(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "right-token")
    headers = {"Authorization": "Bearer right-token"}
    assert cron._verify_auth(headers) is True
