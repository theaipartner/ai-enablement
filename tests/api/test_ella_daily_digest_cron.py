"""Unit tests for api.ella_daily_digest_cron.

Mocks the supabase client + shared.slack_post.post_message. No real
DB / Slack."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any

import pytest

from api import ella_daily_digest_cron as cron


class _Chain:
    def __init__(self, table, fake):
        self.table = table
        self.fake = fake
        self._mode = None
        self._payload: Any = None

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

    def gte(self, *_a, **_kw):
        return self

    def is_(self, *_a, **_kw):
        return self

    def in_(self, *_a, **_kw):
        return self

    def order(self, *_a, **_kw):
        return self

    def limit(self, *_a, **_kw):
        return self

    def execute(self):
        t, m = self.table, self._mode
        if m == "select" and t == "pending_digest_items":
            return SimpleNamespace(data=self.fake.items)
        if m == "select" and t == "clients":
            return SimpleNamespace(data=self.fake.clients)
        if m == "select" and t == "team_members":
            return SimpleNamespace(data=self.fake.team_members)
        if m == "update" and t == "pending_digest_items":
            self.fake.item_updates.append(self._payload)
            return SimpleNamespace(data=[{}])
        if m == "insert" and t == "webhook_deliveries":
            self.fake.audit_inserts.append(self._payload)
            return SimpleNamespace(data=[self._payload])
        if m == "update" and t == "webhook_deliveries":
            self.fake.audit_updates.append(self._payload)
            return SimpleNamespace(data=[{}])
        raise AssertionError(f"unexpected execute table={t} mode={m}")


class _FakeDb:
    def __init__(self):
        self.items: list[dict] = []
        self.clients: list[dict] = []
        self.team_members: list[dict] = []
        self.item_updates: list = []
        self.audit_inserts: list = []
        self.audit_updates: list = []

    def table(self, name):
        return _Chain(name, self)


@pytest.fixture
def fake_db(monkeypatch):
    db = _FakeDb()
    monkeypatch.setattr("api.ella_daily_digest_cron.get_client", lambda: db)
    return db


@pytest.fixture(autouse=True)
def _slack_ok(monkeypatch):
    sent = []
    monkeypatch.setattr(
        "api.ella_daily_digest_cron.post_message",
        lambda uid, text, **kw: sent.append((uid, text))
        or {"ok": True, "slack_error": None},
    )
    return sent


def _item(client_id="cli-1", ts="1745500100.000100", responded=False, cat="confusion"):
    return {
        "id": f"dg-{ts}",
        "client_id": client_id,
        "slack_channel_id": "C1",
        "triggering_message_ts": ts,
        "message_text": "I'm a bit lost on the next step",
        "haiku_decision": "digest_only",
        "haiku_reasoning": "client seems confused about sequencing",
        "digest_category": cat,
        "ella_responded": responded,
        "created_at": "2026-05-18T13:00:00+00:00",
    }


def _scott():
    return {
        "id": "tm-scott",
        "full_name": "Scott Wilson",
        "slack_user_id": "U_SCOTT",
        "access_tier": "head_csm",
        "archived_at": None,
    }


# ---------------------------------------------------------------------------


def test_happy_path_groups_and_sends(fake_db, _slack_ok):
    fake_db.items = [
        _item("cli-1", "1.1"),
        _item("cli-1", "1.2"),
        _item("cli-2", "2.1"),
        _item("cli-3", "3.1", responded=True),
        _item("cli-3", "3.2"),
    ]
    fake_db.clients = [
        {"id": "cli-1", "full_name": "Zed Co"},
        {"id": "cli-2", "full_name": "Acme"},
        {"id": "cli-3", "full_name": "Beta"},
    ]
    fake_db.team_members = [_scott()]

    result = cron.run_ella_daily_digest_cron()

    assert result["status"] == "ok"
    assert result["message_count"] == 5
    assert result["client_groups"] == 3
    assert result["marked_sent"] == 5
    # One DM to Scott.
    assert len(_slack_ok) == 1
    body = _slack_ok[0][1]
    # Alphabetical group order: Acme, Beta, Zed Co
    assert body.index("Acme") < body.index("Beta") < body.index("Zed Co")
    assert "Ella's daily flags" in body
    assert "→ Ella responded" in body  # the responded item


def test_empty_day_still_fires(fake_db, _slack_ok):
    fake_db.items = []
    fake_db.team_members = [_scott()]
    result = cron.run_ella_daily_digest_cron()
    assert result["status"] == "ok"
    assert result["message_count"] == 0
    assert len(_slack_ok) == 1
    assert "No flags today." in _slack_ok[0][1]
    # Nothing to mark sent.
    assert result["marked_sent"] == 0


def test_scott_not_found_cc_only(fake_db, _slack_ok, monkeypatch):
    fake_db.items = [_item()]
    fake_db.clients = [{"id": "cli-1", "full_name": "Acme"}]
    fake_db.team_members = []  # no head_csm
    monkeypatch.setenv("ELLA_DAILY_DIGEST_CC_SLACK_USER_ID", "U0DRAKE99")

    result = cron.run_ella_daily_digest_cron()

    assert "zero_head_csm_resolved" in result["recipient_warnings"]
    # CC still receives it.
    assert _slack_ok and _slack_ok[0][0] == "U0DRAKE99"
    # Recipient warning audit row written.
    assert any(r.get("processing_status") == "failed" for r in fake_db.audit_inserts)


def test_multiple_head_csm_sends_to_all(fake_db, _slack_ok):
    fake_db.items = [_item()]
    fake_db.clients = [{"id": "cli-1", "full_name": "Acme"}]
    fake_db.team_members = [
        _scott(),
        {
            "id": "tm-2",
            "full_name": "Second Head",
            "slack_user_id": "U_2",
            "access_tier": "head_csm",
            "archived_at": None,
        },
    ]
    result = cron.run_ella_daily_digest_cron()
    assert any(
        w.startswith("multiple_head_csm_resolved") for w in result["recipient_warnings"]
    )
    assert len(_slack_ok) == 2


def test_cc_unset_primary_only(fake_db, _slack_ok, monkeypatch):
    monkeypatch.delenv("ELLA_DAILY_DIGEST_CC_SLACK_USER_ID", raising=False)
    fake_db.items = [_item()]
    fake_db.clients = [{"id": "cli-1", "full_name": "Acme"}]
    fake_db.team_members = [_scott()]
    cron.run_ella_daily_digest_cron()
    assert len(_slack_ok) == 1
    assert _slack_ok[0][0] == "U_SCOTT"


def test_since_override_used(fake_db, _slack_ok):
    fake_db.items = []
    fake_db.team_members = [_scott()]
    since = datetime(2026, 5, 1, tzinfo=timezone.utc)
    result = cron.run_ella_daily_digest_cron(since=since)
    assert result["window_start"] == since.isoformat()


def test_parse_since_from_path():
    dt = cron._parse_since("/api/ella_daily_digest_cron?since=2026-05-17T00:00:00Z")
    assert dt == datetime(2026, 5, 17, tzinfo=timezone.utc)
    assert cron._parse_since("/api/ella_daily_digest_cron") is None
    assert cron._parse_since("/x?since=garbage") is None


def test_auth_rejects_bad_secret(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "right")
    h = SimpleNamespace(get=lambda k, d=None: "Bearer wrong")
    assert cron._verify_auth(h) is False
    h2 = SimpleNamespace(get=lambda k, d=None: "Bearer right")
    assert cron._verify_auth(h2) is True


def test_one_recipient_fails_other_still_sends(fake_db, monkeypatch):
    fake_db.items = [_item()]
    fake_db.clients = [{"id": "cli-1", "full_name": "Acme"}]
    fake_db.team_members = [_scott()]
    monkeypatch.setenv("ELLA_DAILY_DIGEST_CC_SLACK_USER_ID", "U0DRAKE99")

    def _post(uid, text, **kw):
        if uid == "U_SCOTT":
            return {"ok": False, "slack_error": "not_in_channel"}
        return {"ok": True, "slack_error": None}

    monkeypatch.setattr("api.ella_daily_digest_cron.post_message", _post)
    result = cron.run_ella_daily_digest_cron()

    by_src = {r["source"]: r for r in result["recipients"]}
    assert by_src["head_csm"]["slack_ok"] is False
    assert by_src["cc"]["slack_ok"] is True
    # At least one send succeeded → rows still marked sent.
    assert result["marked_sent"] == 1


def test_no_send_leaves_rows_unsent(fake_db, monkeypatch):
    fake_db.items = [_item()]
    fake_db.clients = [{"id": "cli-1", "full_name": "Acme"}]
    fake_db.team_members = [_scott()]
    monkeypatch.setattr(
        "api.ella_daily_digest_cron.post_message",
        lambda *a, **kw: {"ok": False, "slack_error": "boom"},
    )
    result = cron.run_ella_daily_digest_cron()
    assert result["status"] == "slack_post_failed"
    assert result["marked_sent"] == 0
