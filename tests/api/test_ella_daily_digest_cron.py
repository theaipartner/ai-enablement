"""Unit tests for api.ella_daily_digest_cron.

Mocks the supabase client + shared.slack_post.post_message + the ranker
`complete`. No real DB / Slack / LLM. Post-2026-05-28 the digest posts
to a channel (no DMs) and Haiku-ranks the top 25."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from decimal import Decimal
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
        self.item_updates: list = []
        self.audit_inserts: list = []
        self.audit_updates: list = []

    def table(self, name):
        return _Chain(name, self)


@pytest.fixture(autouse=True)
def _channel_env(monkeypatch):
    monkeypatch.setenv("ELLA_DAILY_DIGEST_CHANNEL_SLACK_ID", "C_DIGEST")


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
        lambda channel, text, **kw: sent.append((channel, text))
        or {"ok": True, "slack_error": None},
    )
    return sent


@pytest.fixture(autouse=True)
def _ranker_echo(monkeypatch):
    """Default ranker mock: echoes the input item ids in their given
    order (so the posted order == fetch order unless a test overrides)."""

    def _complete(system, messages, model, max_tokens):
        ids = []
        for line in (messages[0]["content"] or "").splitlines():
            try:
                ids.append(json.loads(line)["id"])
            except Exception:
                pass
        return SimpleNamespace(
            text=json.dumps({"ranked_ids": ids}),
            input_tokens=1,
            output_tokens=1,
            cost_usd=Decimal("0"),
            model=model,
            raw=None,
        )

    monkeypatch.setattr("api.ella_daily_digest_cron.complete", _complete)


def _item(client_id="cli-1", ts="1745500100.000100", cat="serious_uncertainty"):
    return {
        "id": f"dg-{ts}",
        "client_id": client_id,
        "slack_channel_id": "C1",
        "triggering_message_ts": ts,
        "message_text": "I'm a bit lost on the next step",
        "haiku_decision": "acknowledge_and_escalate",
        "haiku_reasoning": "client seems confused about sequencing",
        "digest_category": cat,
        "open_ended": True,
        "ella_responded": False,
        "created_at": "2026-05-18T13:00:00+00:00",
    }


# ---------------------------------------------------------------------------


def test_happy_path_posts_to_channel(fake_db, _slack_ok):
    fake_db.items = [_item("cli-1", "1.1"), _item("cli-2", "2.1")]
    fake_db.clients = [
        {"id": "cli-1", "full_name": "Zed Co"},
        {"id": "cli-2", "full_name": "Acme"},
    ]

    result = cron.run_ella_daily_digest_cron()

    assert result["status"] == "ok"
    assert result["message_count"] == 2
    assert result["posted_count"] == 2
    assert result["marked_sent"] == 2
    # One post, to the channel (not a DM).
    assert len(_slack_ok) == 1
    channel, body = _slack_ok[0]
    assert channel == "C_DIGEST"
    assert body.startswith("Hey Scott, here's today's digest:")
    # Numbered, link-only lines.
    assert "1. https://" in body
    assert "2. https://" in body
    assert "slack.com/archives/C1/p" in body
    # No grouping / category / reasoning leakage.
    assert "Acme" not in body
    assert "confused" not in body


def test_empty_day_still_fires(fake_db, _slack_ok):
    fake_db.items = []
    result = cron.run_ella_daily_digest_cron()
    assert result["status"] == "ok"
    assert result["message_count"] == 0
    assert len(_slack_ok) == 1
    assert _slack_ok[0][0] == "C_DIGEST"
    assert "no flags today" in _slack_ok[0][1].lower()
    assert result["marked_sent"] == 0


def test_channel_unset_failed_and_audit(fake_db, monkeypatch):
    monkeypatch.delenv("ELLA_DAILY_DIGEST_CHANNEL_SLACK_ID", raising=False)
    fake_db.items = [_item()]
    result = cron.run_ella_daily_digest_cron()
    assert result["status"] == "failed"
    assert "ELLA_DAILY_DIGEST_CHANNEL_SLACK_ID" in result["error"]
    assert any(
        a.get("processing_status") == "failed" and a["payload"].get("config_gap")
        for a in fake_db.audit_inserts
    )


def test_top_25_cap(fake_db, _slack_ok):
    fake_db.items = [_item("cli-1", f"{i}.0") for i in range(30)]
    fake_db.clients = [{"id": "cli-1", "full_name": "Acme"}]
    result = cron.run_ella_daily_digest_cron()
    assert result["posted_count"] == 25
    # 25 numbered lines, last is "25."
    body = _slack_ok[0][1]
    assert "25. https://" in body
    assert "26. https://" not in body
    # All 30 still marked sent (display cap, not a queue).
    assert result["marked_sent"] == 30


def test_ranker_fallback_on_haiku_failure(fake_db, _slack_ok, monkeypatch):
    def _boom(*a, **kw):
        raise RuntimeError("haiku down")

    monkeypatch.setattr("api.ella_daily_digest_cron.complete", _boom)
    fake_db.items = [
        _item("cli-1", "q.0", cat="other"),
        _item("cli-1", "m.0", cat="money_commitment"),
    ]
    fake_db.clients = [{"id": "cli-1", "full_name": "Acme"}]
    result = cron.run_ella_daily_digest_cron()
    assert result["status"] == "ok"
    assert result["posted_count"] == 2
    # Fallback priority: money_commitment (m.0) ranks above the catch-all.
    body = _slack_ok[0][1]
    assert body.index("pm0") < body.index("pq0")


def test_fallback_rank_priority_order():
    items = [
        {"id": "a", "digest_category": "other", "created_at": "1"},
        {"id": "b", "digest_category": "money_commitment", "created_at": "1"},
        {"id": "c", "digest_category": "emotional_human_needed", "created_at": "1"},
        {"id": "d", "digest_category": "complaint", "created_at": "1"},
    ]
    ordered = [i["id"] for i in cron._fallback_rank(items)]
    assert ordered == ["b", "d", "c", "a"]


def test_since_override_used(fake_db, _slack_ok):
    fake_db.items = []
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


def test_no_send_leaves_rows_unsent(fake_db, monkeypatch):
    fake_db.items = [_item()]
    fake_db.clients = [{"id": "cli-1", "full_name": "Acme"}]
    monkeypatch.setattr(
        "api.ella_daily_digest_cron.post_message",
        lambda *a, **kw: {"ok": False, "slack_error": "boom"},
    )
    result = cron.run_ella_daily_digest_cron()
    assert result["status"] == "slack_post_failed"
    assert result["marked_sent"] == 0
