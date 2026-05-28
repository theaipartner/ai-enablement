"""Unit tests for api.cs_missed_recording_cron.

Mocks the supabase client + shared.slack_post.post_message. No real
DB / Slack. The fake calendar_events select applies the
`missing_recording_posted_at IS NULL` + end_time window filters so the
ignored-by-query cases are real assertions."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any

import pytest

from api import cs_missed_recording_cron as cron

_NOW = datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


class _Chain:
    def __init__(self, table, fake):
        self.table = table
        self.fake = fake
        self._mode = None
        self._payload: Any = None
        self._is_null: set[str] = set()
        self._lte: tuple[str, Any] | None = None
        self._gte: tuple[str, Any] | None = None
        self._eq: dict[str, Any] = {}

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

    def eq(self, col, val):
        self._eq[col] = val
        return self

    def gte(self, col, val):
        self._gte = (col, val)
        return self

    def lte(self, col, val):
        self._lte = (col, val)
        return self

    def is_(self, col, _val):
        self._is_null.add(col)
        return self

    def order(self, *_a, **_kw):
        return self

    def limit(self, *_a, **_kw):
        return self

    def execute(self):
        t, m = self.table, self._mode
        if m == "select" and t == "calendar_events":
            rows = []
            for r in self.fake.events:
                if "missing_recording_posted_at" in self._is_null and r.get(
                    "missing_recording_posted_at"
                ):
                    continue
                et = r["end_time"]
                if self._lte and et > self._lte[1]:
                    continue
                if self._gte and et < self._gte[1]:
                    continue
                rows.append(r)
            rows.sort(key=lambda x: x["end_time"])
            return SimpleNamespace(data=rows)
        if m == "select" and t == "calls":
            return SimpleNamespace(data=self.fake.calls)
        if m == "update" and t == "calendar_events":
            self.fake.event_updates.append(
                {"id": self._eq.get("id"), "payload": self._payload}
            )
            return SimpleNamespace(data=[{}])
        if m == "insert" and t == "webhook_deliveries":
            self.fake.audit_inserts.append(self._payload)
            return SimpleNamespace(data=[self._payload])
        raise AssertionError(f"unexpected execute table={t} mode={m}")


class _FakeDb:
    def __init__(self):
        self.events: list[dict] = []
        self.calls: list[dict] = []
        self.event_updates: list[dict] = []
        self.audit_inserts: list[dict] = []

    def table(self, name):
        return _Chain(name, self)


@pytest.fixture(autouse=True)
def _channel_env(monkeypatch):
    monkeypatch.setenv("SLACK_CS_CALL_SUMMARIES_CHANNEL_ID", "C_CS")


@pytest.fixture
def fake_db(monkeypatch):
    db = _FakeDb()
    monkeypatch.setattr("api.cs_missed_recording_cron.get_client", lambda: db)
    return db


@pytest.fixture(autouse=True)
def slack_calls(monkeypatch):
    calls = []
    monkeypatch.setattr(
        "api.cs_missed_recording_cron.post_message",
        lambda channel, text, **kw: calls.append((channel, text))
        or {"ok": True, "slack_error": None, "ts": "1.1"},
    )
    return calls


def _event(eid="ev-1", title="Coaching Call with Scott", start_ago=timedelta(hours=2)):
    start = _NOW - start_ago
    end = start + timedelta(minutes=30)
    return {
        "id": eid,
        "google_event_id": f"g-{eid}",
        "title": title,
        "start_time": _iso(start),
        "end_time": _iso(end),
        "missing_recording_posted_at": None,
    }


def test_unmatched_event_posts_and_stamps(fake_db, slack_calls):
    ev = _event()
    fake_db.events = [ev]
    fake_db.calls = []  # no recording landed

    result = cron.run_cs_missed_recording_cron()

    assert result["status"] == "ok"
    assert result["checked"] == 1
    assert result["matched"] == 0
    assert result["posted"] == 1
    assert slack_calls == [("C_CS", "Coaching Call with Scott - recording not available")]
    # Stamped so it never re-posts.
    assert fake_db.event_updates[0]["id"] == "ev-1"
    assert fake_db.event_updates[0]["payload"]["missing_recording_posted_at"]


def test_matched_event_skipped_no_post(fake_db, slack_calls):
    ev = _event()
    fake_db.events = [ev]
    # A client call with the same title, started within ±30min of the event.
    fake_db.calls = [
        {"title": "coaching call with scott", "started_at": ev["start_time"]}
    ]
    result = cron.run_cs_missed_recording_cron()
    assert result["matched"] == 1
    assert result["posted"] == 0
    assert slack_calls == []
    # Matched events are left unstamped (age out via backstop).
    assert fake_db.event_updates == []


def test_match_outside_time_tolerance_still_posts(fake_db, slack_calls):
    ev = _event()
    fake_db.events = [ev]
    # Same title but the call started 2h off — not the same meeting.
    far = _parse_plus(ev["start_time"], timedelta(hours=2))
    fake_db.calls = [{"title": "Coaching Call with Scott", "started_at": far}]
    result = cron.run_cs_missed_recording_cron()
    assert result["posted"] == 1


def test_recent_event_within_grace_ignored(fake_db, slack_calls):
    # Ended 10 minutes ago — grace (30m) hasn't elapsed.
    ev = _event(start_ago=timedelta(minutes=40))  # ended ~10m ago
    fake_db.events = [ev]
    fake_db.calls = []
    result = cron.run_cs_missed_recording_cron()
    assert result["checked"] == 0
    assert result["posted"] == 0


def test_already_posted_ignored(fake_db, slack_calls):
    ev = _event()
    ev["missing_recording_posted_at"] = _iso(_NOW)
    fake_db.events = [ev]
    result = cron.run_cs_missed_recording_cron()
    assert result["checked"] == 0
    assert slack_calls == []


def test_event_older_than_backstop_ignored(fake_db, slack_calls):
    ev = _event(start_ago=timedelta(days=8))
    fake_db.events = [ev]
    fake_db.calls = []
    result = cron.run_cs_missed_recording_cron()
    assert result["checked"] == 0


def test_untitled_event_renders_placeholder(fake_db, slack_calls):
    ev = _event(title="")
    fake_db.events = [ev]
    fake_db.calls = []
    cron.run_cs_missed_recording_cron()
    assert slack_calls[0][1] == "(untitled meeting) - recording not available"


def test_channel_unset_failed_and_audit(fake_db, monkeypatch):
    monkeypatch.delenv("SLACK_CS_CALL_SUMMARIES_CHANNEL_ID", raising=False)
    fake_db.events = [_event()]
    result = cron.run_cs_missed_recording_cron()
    assert result["status"] == "failed"
    assert "SLACK_CS_CALL_SUMMARIES_CHANNEL_ID" in result["error"]
    assert any(
        a["processing_status"] == "failed" and a["payload"].get("config_gap")
        for a in fake_db.audit_inserts
    )


def test_slack_failure_isolated_no_stamp(fake_db, monkeypatch):
    fake_db.events = [_event()]
    fake_db.calls = []
    monkeypatch.setattr(
        "api.cs_missed_recording_cron.post_message",
        lambda *a, **kw: {"ok": False, "slack_error": "not_in_channel"},
    )
    result = cron.run_cs_missed_recording_cron()
    assert result["posted"] == 0
    assert result["post_failures"] == 1
    # Not stamped — next tick retries.
    assert fake_db.event_updates == []


def test_auth_rejects_bad_secret(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "right")
    assert cron._verify_auth(SimpleNamespace(get=lambda k, d=None: "Bearer wrong")) is False
    assert cron._verify_auth(SimpleNamespace(get=lambda k, d=None: "Bearer right")) is True


def _parse_plus(iso: str, delta: timedelta) -> str:
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return (dt + delta).isoformat()
