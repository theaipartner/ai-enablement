"""Tests for the sales-bot audience gate (the "clients can never get SQL"
guarantee).

`_authorize` is defense-in-depth on top of the channel gate: the bot only
answers internal team members with sales access, and FAILS CLOSED. These tests
assert the deny paths behave safely — unknown users (e.g. clients) get total
silence; internal non-sales users get a polite refusal; neither reaches the SQL
loop.

`shared.slack_post.post_message` is auto-noop'd by the conftest autouse fixture
(incl. the sales-bot re-export), so no real Slack traffic. The DB is faked.
"""

from __future__ import annotations

import pytest

import agents.sales_bot.agent as agent_mod
from agents.sales_bot.agent import SalesBotPayload, _authorize, handle_question


class _FakeResult:
    def __init__(self, data):
        self.data = data


class _FakeQuery:
    """Ignores filters; returns canned data keyed by table name."""

    def __init__(self, table: str, store: dict):
        self._table = table
        self._store = store

    def select(self, *a, **k):
        return self

    def eq(self, *a, **k):
        return self

    def is_(self, *a, **k):
        return self

    def limit(self, *a, **k):
        return self

    def insert(self, *a, **k):
        return self

    def update(self, *a, **k):
        return self

    def execute(self):
        if self._table == "team_members":
            return _FakeResult(self._store.get("team_members", []))
        if self._table == "agent_runs":
            # start_agent_run reads data[0]["id"]; end_agent_run ignores it.
            return _FakeResult([{"id": "run-test"}])
        return _FakeResult([])


class _FakeClient:
    def __init__(self, store: dict):
        self._store = store

    def table(self, name: str):
        return _FakeQuery(name, self._store)


@pytest.fixture
def fake_db(monkeypatch):
    """Patch every get_client binding the agent + run-logging touch."""

    def _install(team_members_rows):
        client = _FakeClient({"team_members": team_members_rows})
        monkeypatch.setattr(agent_mod, "get_client", lambda: client)
        monkeypatch.setattr("shared.logging.get_client", lambda: client)
        return client

    return _install


def _payload(user="U123"):
    return SalesBotPayload(
        channel="C_SALES",
        text="<@UBOT> how many opt-ins this week",
        thread_ts="1.1",
        slack_user_id=user,
        message_ts="1.1",
    )


# --------------------------------------------------------------------------- #
# _authorize unit behavior
# --------------------------------------------------------------------------- #


def test_authorize_no_user_id_denied():
    assert _authorize(None) == (False, False)


def test_authorize_unknown_user_denied(fake_db):
    fake_db([])  # no team_members row → a client / outsider
    assert _authorize("U_client") == (False, False)


def test_authorize_non_sales_member_denied(fake_db):
    fake_db([{"areas": ["fulfillment"]}])
    assert _authorize("U_csm") == (False, True)


def test_authorize_sales_member_allowed(fake_db):
    fake_db([{"areas": ["sales"]}])
    assert _authorize("U_rep") == (True, True)


def test_authorize_fails_closed_on_db_error(monkeypatch):
    def _boom():
        raise RuntimeError("db down")

    monkeypatch.setattr(agent_mod, "get_client", _boom)
    # Must DENY (not crash, not allow) when the lookup can't be performed.
    assert _authorize("U_rep") == (False, False)


# --------------------------------------------------------------------------- #
# handle_question deny paths never reach the SQL loop
# --------------------------------------------------------------------------- #


def test_handle_question_unknown_user_is_silent(fake_db, monkeypatch):
    fake_db([])  # client / outsider

    # If the loop were ever reached it would call Anthropic — make that explode
    # so the test fails loudly if the gate leaks.
    monkeypatch.setattr(
        agent_mod, "_run_tool_loop", lambda *_a, **_k: pytest.fail("loop reached")
    )
    result = handle_question(_payload(user="U_client"))
    assert result.status == "skipped"
    assert result.posted is False  # total silence — no reply to a client
    assert result.answer == ""
    assert result.tool_calls == 0


def test_handle_question_non_sales_member_gets_refusal(fake_db, monkeypatch):
    fake_db([{"areas": ["fulfillment"]}])
    monkeypatch.setattr(
        agent_mod, "_run_tool_loop", lambda *_a, **_k: pytest.fail("loop reached")
    )
    result = handle_question(_payload(user="U_csm"))
    assert result.status == "skipped"
    assert "sales team" in result.answer.lower()
    assert result.tool_calls == 0
