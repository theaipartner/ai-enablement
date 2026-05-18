"""Unit tests for `agents.ella.escalation_routing`.

Covers the shared escalation fan-out helper used by both Ella reactive
(`agents/ella/agent.py:_run`) and passive (`agents/ella/passive_dispatch.py`)
paths after the 2026-05-14 unification.

Two surfaces exercised:

  - `resolve_escalation_recipients(primary_csm)` — env-var-driven head
    CSM (`ESCALATION_RECIPIENT_SLACK_USER_ID`) + the channel's primary
    CSM, deduplicated, ordered Scott-first.
  - `fire_escalation_dms(...)` — one DM per recipient with one audit
    row per recipient under `webhook_deliveries.source='ella_escalation_dm'`.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agents.ella import escalation_routing as er


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
        if self._mode == "select" and self.table == "team_members":
            row = self.fake.team_member_by_slack_id.get(
                next((v for (k, v) in self._filters if k == "slack_user_id"), None)
            )
            return SimpleNamespace(data=[row] if row else [])
        if self._mode == "insert" and self.table == "webhook_deliveries":
            self.fake.webhook_inserts.append(self._payload)
            return SimpleNamespace(
                data=[{"id": f"wd-{len(self.fake.webhook_inserts)}"}]
            )
        if self._mode == "update" and self.table == "webhook_deliveries":
            self.fake.webhook_updates.append((self._filters, self._payload))
            return SimpleNamespace(data=[{}])
        raise AssertionError(f"unexpected execute table={self.table} mode={self._mode}")


class _FakeDb:
    def __init__(self):
        self.team_member_by_slack_id: dict[str, dict[str, Any]] = {}
        self.webhook_inserts: list[dict[str, Any]] = []
        self.webhook_updates: list[tuple[list, dict]] = []

    def table(self, name):
        return _Chain(name, self)


@pytest.fixture
def fake_db(monkeypatch):
    db = _FakeDb()
    monkeypatch.setattr("agents.ella.escalation_routing.get_client", lambda: db)
    monkeypatch.setattr("shared.db.get_client", lambda: db)
    return db


_PRIMARY_CSM = {
    "id": "tm-lou",
    "slack_user_id": "U_LOU",
    "full_name": "Lou Perez",
}

_SCOTT_ID = "U_SCOTT"


# ---------------------------------------------------------------------------
# resolve_escalation_recipients
# ---------------------------------------------------------------------------


def test_resolve_recipients_env_set_and_primary_csm_present(fake_db, monkeypatch):
    """Env var set + primary CSM present → both recipients, Scott first."""
    monkeypatch.setenv("ESCALATION_RECIPIENT_SLACK_USER_ID", _SCOTT_ID)
    fake_db.team_member_by_slack_id[_SCOTT_ID] = {"full_name": "Scott Lyons"}

    recipients = er.resolve_escalation_recipients(_PRIMARY_CSM)

    assert [r["slack_user_id"] for r in recipients] == [_SCOTT_ID, "U_LOU"]
    assert recipients[0]["source"] == "scott"
    assert recipients[0]["label"] == "Scott Lyons"
    assert recipients[1]["source"] == "primary_csm"
    assert recipients[1]["label"] == "Lou Perez"


def test_resolve_recipients_env_set_no_primary_csm(fake_db, monkeypatch):
    """Env set + primary_csm None → Scott only."""
    monkeypatch.setenv("ESCALATION_RECIPIENT_SLACK_USER_ID", _SCOTT_ID)
    fake_db.team_member_by_slack_id[_SCOTT_ID] = {"full_name": "Scott Lyons"}

    recipients = er.resolve_escalation_recipients(None)

    assert len(recipients) == 1
    assert recipients[0]["slack_user_id"] == _SCOTT_ID
    assert recipients[0]["source"] == "scott"


def test_resolve_recipients_env_unset_primary_csm_present(fake_db, monkeypatch):
    """Env unset + primary CSM present → primary_csm only, no Scott."""
    monkeypatch.delenv("ESCALATION_RECIPIENT_SLACK_USER_ID", raising=False)

    recipients = er.resolve_escalation_recipients(_PRIMARY_CSM)

    assert len(recipients) == 1
    assert recipients[0]["slack_user_id"] == "U_LOU"
    assert recipients[0]["source"] == "primary_csm"


def test_resolve_recipients_env_unset_no_primary_csm(fake_db, monkeypatch, caplog):
    """Env unset + primary_csm None → empty list, warning logged. The
    caller (passive_dispatch escalate branch) still writes the
    escalations row even when no one is DMed."""
    monkeypatch.delenv("ESCALATION_RECIPIENT_SLACK_USER_ID", raising=False)

    import logging

    with caplog.at_level(logging.WARNING):
        recipients = er.resolve_escalation_recipients(None)

    assert recipients == []
    assert any("no recipients resolved" in rec.message for rec in caplog.records)


def test_resolve_recipients_dedupes_when_scott_is_primary_csm(fake_db, monkeypatch):
    """When Scott IS the channel's primary CSM, the recipient list
    dedupes to one entry tagged source='scott' (the head-CSM concern
    takes precedence in the audit trail)."""
    monkeypatch.setenv("ESCALATION_RECIPIENT_SLACK_USER_ID", _SCOTT_ID)
    fake_db.team_member_by_slack_id[_SCOTT_ID] = {"full_name": "Scott Lyons"}

    recipients = er.resolve_escalation_recipients(
        {"slack_user_id": _SCOTT_ID, "full_name": "Scott Lyons"}
    )

    assert len(recipients) == 1
    assert recipients[0]["slack_user_id"] == _SCOTT_ID
    assert recipients[0]["source"] == "scott"


def test_resolve_recipients_team_member_lookup_failure_falls_back_to_default_label(
    fake_db, monkeypatch
):
    """Best-effort team_members lookup never breaks the fan-out."""
    monkeypatch.setenv("ESCALATION_RECIPIENT_SLACK_USER_ID", _SCOTT_ID)
    # No row seeded → lookup returns empty data → label falls back.

    recipients = er.resolve_escalation_recipients(None)

    assert recipients[0]["label"] == "Scott"


# ---------------------------------------------------------------------------
# fire_escalation_dms
# ---------------------------------------------------------------------------


def test_fire_escalation_dms_two_recipients_both_succeed(fake_db, monkeypatch):
    """Two recipients, both Slack-side ok → 2 success results, 2 audit
    rows inserted + 2 audit updates marking processed."""
    sent: list[dict[str, Any]] = []

    def _capture(channel_id, text, **_kw):
        sent.append({"channel_id": channel_id, "text": text})
        return {"ok": True, "slack_error": None}

    monkeypatch.setattr("agents.ella.escalation_routing.post_message", _capture)

    recipients = [
        {
            "slack_user_id": _SCOTT_ID,
            "label": "Scott Lyons",
            "source": "scott",
        },
        {
            "slack_user_id": "U_LOU",
            "label": "Lou Perez",
            "source": "primary_csm",
        },
    ]
    results = er.fire_escalation_dms(
        recipients=recipients,
        slack_channel_id="C123",
        triggering_message_ts="1745500100.000100",
        reasoning="billing question — auto-escalate",
        path="passive",
        channel_client_id="cli-uuid",
    )

    assert len(results) == 2
    assert all(r["dm_ok"] for r in results)
    assert [r["channel_id"] for r in sent] == [_SCOTT_ID, "U_LOU"]
    # Same body for both recipients.
    assert sent[0]["text"] == sent[1]["text"]
    assert ":eyes: Worth a look —" in sent[0]["text"]
    assert "Reasoning: billing question" in sent[0]["text"]
    # Audit rows: one insert + one update per recipient.
    assert len(fake_db.webhook_inserts) == 2
    assert len(fake_db.webhook_updates) == 2
    for audit in fake_db.webhook_inserts:
        assert audit["source"] == "ella_escalation_dm"
        assert audit["payload"]["path"] == "passive"
        assert audit["payload"]["channel_client_id"] == "cli-uuid"
        # Body persisted on every audit row so the dashboard can render
        # the DM body in the Output column.
        assert "body" in audit["payload"]
    for _, update in fake_db.webhook_updates:
        assert update["processing_status"] == "processed"


def test_fire_escalation_dms_one_recipient_fails_other_succeeds(fake_db, monkeypatch):
    """A Slack-side ok=False on one recipient never short-circuits the
    other. Both audit rows still land; failed one marked accordingly."""
    call_count = {"n": 0}

    def _capture(channel_id, text, **_kw):
        call_count["n"] += 1
        if call_count["n"] == 1:
            return {"ok": False, "slack_error": "cannot_dm_bot"}
        return {"ok": True, "slack_error": None}

    monkeypatch.setattr("agents.ella.escalation_routing.post_message", _capture)

    recipients = [
        {"slack_user_id": _SCOTT_ID, "label": "Scott", "source": "scott"},
        {"slack_user_id": "U_LOU", "label": "Lou", "source": "primary_csm"},
    ]
    results = er.fire_escalation_dms(
        recipients=recipients,
        slack_channel_id="C123",
        triggering_message_ts="1745500100.000100",
        reasoning="some reason",
        path="reactive",
    )

    assert results[0]["dm_ok"] is False
    assert results[0]["slack_error"] == "cannot_dm_bot"
    assert results[1]["dm_ok"] is True
    # Both audit rows still inserted.
    assert len(fake_db.webhook_inserts) == 2
    # The first audit row's terminal update reports the slack_error.
    first_filters, first_update = fake_db.webhook_updates[0]
    assert first_update["processing_status"] == "failed"
    assert "cannot_dm_bot" in first_update["processing_error"]
    # The second audit row's terminal update is processed.
    _, second_update = fake_db.webhook_updates[1]
    assert second_update["processing_status"] == "processed"


def test_fire_escalation_dms_empty_recipients_is_noop(fake_db, monkeypatch):
    """Empty recipients → [] return, no audit rows, no exceptions. This
    is the safer-floor path when both env var is unset and primary_csm
    has no slack_user_id."""
    sent: list = []
    monkeypatch.setattr(
        "agents.ella.escalation_routing.post_message",
        lambda *a, **kw: (sent.append(a) or {"ok": True}),
    )

    results = er.fire_escalation_dms(
        recipients=[],
        slack_channel_id="C123",
        triggering_message_ts="1745500100.000100",
        reasoning="no one to ping",
        path="passive",
    )

    assert results == []
    assert sent == []
    assert fake_db.webhook_inserts == []


def test_fire_escalation_dms_reasoning_truncates_at_200_chars(fake_db, monkeypatch):
    """The body's reasoning section caps at 200 chars to keep DM bodies
    tight; matches the pre-existing passive-DM behavior."""
    sent: list[dict[str, Any]] = []

    def _capture(channel_id, text, **_kw):
        sent.append({"channel_id": channel_id, "text": text})
        return {"ok": True, "slack_error": None}

    monkeypatch.setattr("agents.ella.escalation_routing.post_message", _capture)

    long_reasoning = "x" * 300
    er.fire_escalation_dms(
        recipients=[{"slack_user_id": _SCOTT_ID, "label": "Scott", "source": "scott"}],
        slack_channel_id="C123",
        triggering_message_ts="1745500100.000100",
        reasoning=long_reasoning,
        path="passive",
    )

    # Only the first 200 chars of the reasoning appear in the body.
    assert ("x" * 200) in sent[0]["text"]
    assert ("x" * 201) not in sent[0]["text"]


def test_fire_escalation_dms_permalink_includes_workspace_when_env_set(
    fake_db, monkeypatch
):
    """SLACK_WORKSPACE shaped into the permalink subdomain when set."""
    sent: list[dict[str, Any]] = []
    monkeypatch.setattr(
        "agents.ella.escalation_routing.post_message",
        lambda channel_id, text, **_kw: (
            sent.append({"text": text}) or {"ok": True, "slack_error": None}
        ),
    )
    monkeypatch.setenv("SLACK_WORKSPACE", "theaipartner")

    er.fire_escalation_dms(
        recipients=[{"slack_user_id": _SCOTT_ID, "label": "Scott", "source": "scott"}],
        slack_channel_id="C123",
        triggering_message_ts="1745500100.000100",
        reasoning="r",
        path="passive",
    )

    assert "theaipartner.slack.com/archives/C123/p1745500100000100" in sent[0]["text"]
