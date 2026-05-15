"""Unit tests for `api.teams_calendar_sync_cron.run_teams_calendar_sync_cron`.

Covers:
  - CRON_SECRET auth (handler-level)
  - Drake-not-found short circuit
  - OAuth refresh failure short circuit + audit
  - Happy path: 2 CSMs, both 200 — events upserted, summary audit row
  - One CSM denied (4xx), other succeeds — partial-failure pattern
  - Cancelled / no-dateTime events skipped during upsert
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from api import teams_calendar_sync_cron as cron
from shared.google_oauth import GoogleOAuthError


# ---------------------------------------------------------------------------
# Fake DB
# ---------------------------------------------------------------------------


class _Chain:
    def __init__(self, table, fake):
        self.table = table
        self.fake = fake
        self._mode = None
        self._payload = None
        self._filters: list[tuple] = []

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
        self._filters.append(("eq", k, v))
        return self

    def is_(self, k, v):
        self._filters.append(("is", k, v))
        return self

    def limit(self, *_a, **_kw):
        return self

    def execute(self):
        if self._mode == "select" and self.table == "team_members":
            # Drake lookup (filter on email) vs CSM list (filter on is_csm).
            eq_keys = {k: v for kind, k, v in self._filters if kind == "eq"}
            if "email" in eq_keys:
                return SimpleNamespace(data=self.fake.drake_rows)
            return SimpleNamespace(data=self.fake.csm_rows)
        if self._mode == "upsert" and self.table == "calendar_events":
            self.fake.calendar_upserts.append(self._payload)
            return SimpleNamespace(data=[{}])
        if self._mode == "insert" and self.table == "webhook_deliveries":
            self.fake.audit_inserts.append(self._payload)
            return SimpleNamespace(data=[{}])
        raise AssertionError(
            f"unexpected execute table={self.table} mode={self._mode}"
        )


class _FakeDb:
    def __init__(self):
        self.drake_rows: list[dict] = []
        self.csm_rows: list[dict] = []
        self.calendar_upserts: list[dict] = []
        self.audit_inserts: list[dict] = []

    def table(self, name):
        return _Chain(name, self)


@pytest.fixture
def fake_db(monkeypatch):
    db = _FakeDb()
    monkeypatch.setattr("shared.db.get_client", lambda: db)
    monkeypatch.setattr("api.teams_calendar_sync_cron.get_client", lambda: db)
    return db


@pytest.fixture(autouse=True)
def _stub_env(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "test-secret")
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_ID", "client-id")
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_SECRET", "client-secret")


def _stub_access_token(monkeypatch, token="live-token"):
    monkeypatch.setattr(
        "api.teams_calendar_sync_cron.get_valid_access_token",
        lambda tm_id: token,
    )


def _stub_calendar_response(monkeypatch, events_by_cal_id: dict[str, list[dict]]):
    def fake(*, access_token, calendar_id, time_min, time_max):
        return events_by_cal_id.get(calendar_id, [])

    monkeypatch.setattr(
        "api.teams_calendar_sync_cron._fetch_calendar_events", fake
    )


def _drake_row():
    return {"id": "tm-drake-uuid", "email": "drake@theaipartner.io"}


def _csm(id_: str, email: str, full_name: str, metadata: dict | None = None):
    return {
        "id": id_,
        "email": email,
        "full_name": full_name,
        "metadata": metadata or {},
    }


def _event(google_event_id: str, summary: str, start_iso: str, end_iso: str):
    return {
        "id": google_event_id,
        "summary": summary,
        "start": {"dateTime": start_iso},
        "end": {"dateTime": end_iso},
        "attendees": [{"email": "client@example.com", "displayName": "Client"}],
    }


# ---------------------------------------------------------------------------
# Short-circuit cases
# ---------------------------------------------------------------------------


def test_drake_not_found_short_circuits_with_audit(fake_db):
    """No drake row → return error result + audit row with the error."""
    fake_db.drake_rows = []

    result = cron.run_teams_calendar_sync_cron()

    assert result == {"error": "drake_team_member_not_found"}
    assert len(fake_db.audit_inserts) == 1
    audit = fake_db.audit_inserts[0]
    assert audit["source"] == "teams_calendar_sync"
    assert audit["processing_status"] == "failed"
    assert audit["payload"]["error"] == "drake_team_member_not_found"


def test_oauth_refresh_failure_audits_and_short_circuits(fake_db, monkeypatch):
    """OAuth-token refresh raises → audit row + return; no calendar API calls."""
    fake_db.drake_rows = [_drake_row()]
    fake_db.csm_rows = [
        _csm("tm-1", "lou@theaipartner.io", "Lou Perez"),
    ]

    def _raise(tm_id):
        raise GoogleOAuthError("invalid_grant")

    monkeypatch.setattr(
        "api.teams_calendar_sync_cron.get_valid_access_token", _raise
    )
    # Should NOT be called because we short-circuit before the per-CSM loop.
    called = {"n": 0}

    def fake_fetch(**kw):
        called["n"] += 1
        return []

    monkeypatch.setattr(
        "api.teams_calendar_sync_cron._fetch_calendar_events", fake_fetch
    )

    result = cron.run_teams_calendar_sync_cron()

    assert result["error"] == "oauth_token_unavailable"
    assert "invalid_grant" in result["detail"]
    assert called["n"] == 0
    audit = fake_db.audit_inserts[0]
    assert audit["processing_status"] == "failed"
    assert audit["processing_error"].startswith("oauth_token_unavailable")


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_happy_path_two_csms_both_succeed(fake_db, monkeypatch):
    fake_db.drake_rows = [_drake_row()]
    fake_db.csm_rows = [
        _csm("tm-1", "lou@theaipartner.io", "Lou Perez"),
        _csm("tm-2", "nico@theaipartner.io", "Nico Sandoval"),
    ]
    _stub_access_token(monkeypatch)
    _stub_calendar_response(
        monkeypatch,
        {
            "lou@theaipartner.io": [
                _event("ev-1", "Sales call", "2026-05-12T14:00:00Z", "2026-05-12T15:00:00Z"),
            ],
            "nico@theaipartner.io": [
                _event("ev-2", "1:1 with Drake", "2026-05-12T17:00:00Z", "2026-05-12T17:30:00Z"),
                _event("ev-3", "Client onboarding", "2026-05-13T15:00:00Z", "2026-05-13T16:00:00Z"),
            ],
        },
    )

    result = cron.run_teams_calendar_sync_cron()

    assert result["csms_attempted"] == 2
    assert result["csms_succeeded"] == 2
    assert result["events_upserted"] == 3
    assert result["errors"] == []
    # 3 calendar_events upserts.
    assert len(fake_db.calendar_upserts) == 3
    # All three upserts carry the correct team_member_id + google_event_id.
    ids = {(u["team_member_id"], u["google_event_id"]) for u in fake_db.calendar_upserts}
    assert ids == {("tm-1", "ev-1"), ("tm-2", "ev-2"), ("tm-2", "ev-3")}
    # Audit row summarizes the tick.
    audit = fake_db.audit_inserts[0]
    assert audit["processing_status"] == "processed"
    assert audit["payload"]["counts"]["events_upserted"] == 3


# ---------------------------------------------------------------------------
# Partial failure
# ---------------------------------------------------------------------------


def test_one_csm_calendar_api_denied_other_succeeds(fake_db, monkeypatch):
    fake_db.drake_rows = [_drake_row()]
    fake_db.csm_rows = [
        _csm("tm-1", "lou@theaipartner.io", "Lou Perez"),
        _csm("tm-2", "zain@theaipartner.io", "Zain"),
    ]
    _stub_access_token(monkeypatch)

    def fake_fetch(*, access_token, calendar_id, time_min, time_max):
        if calendar_id == "zain@theaipartner.io":
            raise cron._CalendarApiError("calendar_api_denied", http_status=403)
        return [
            _event("ev-1", "Sales", "2026-05-12T14:00:00Z", "2026-05-12T15:00:00Z"),
        ]

    monkeypatch.setattr(
        "api.teams_calendar_sync_cron._fetch_calendar_events", fake_fetch
    )

    result = cron.run_teams_calendar_sync_cron()

    assert result["csms_attempted"] == 2
    assert result["csms_succeeded"] == 1
    assert result["events_upserted"] == 1
    assert len(result["errors"]) == 1
    err = result["errors"][0]
    assert err["team_member_id"] == "tm-2"
    assert err["error_code"] == "calendar_api_denied"
    assert err["error_status"] == 403
    # Audit row carries the error.
    audit = fake_db.audit_inserts[0]
    assert len(audit["payload"]["errors"]) == 1


# ---------------------------------------------------------------------------
# Event filtering during upsert
# ---------------------------------------------------------------------------


def test_cancelled_and_dateless_events_skipped(fake_db, monkeypatch):
    """Cancelled events + all-day events without start.dateTime are
    skipped during upsert. The matching logic only works for point-in-time
    events; persisting all-day blocks would clutter the table."""
    fake_db.drake_rows = [_drake_row()]
    fake_db.csm_rows = [_csm("tm-1", "lou@theaipartner.io", "Lou Perez")]
    _stub_access_token(monkeypatch)
    _stub_calendar_response(
        monkeypatch,
        {
            "lou@theaipartner.io": [
                _event("ev-keep", "Sales call", "2026-05-12T14:00:00Z", "2026-05-12T15:00:00Z"),
                {
                    "id": "ev-cancelled",
                    "summary": "Cancelled meeting",
                    "status": "cancelled",
                    "start": {"dateTime": "2026-05-12T16:00:00Z"},
                    "end": {"dateTime": "2026-05-12T17:00:00Z"},
                },
                {
                    "id": "ev-all-day",
                    "summary": "Holiday",
                    "start": {"date": "2026-05-12"},
                    "end": {"date": "2026-05-13"},
                },
            ],
        },
    )

    result = cron.run_teams_calendar_sync_cron()

    assert result["events_upserted"] == 1
    assert fake_db.calendar_upserts[0]["google_event_id"] == "ev-keep"


def test_sentinel_team_members_excluded_from_csm_list(fake_db, monkeypatch):
    """metadata.sentinel=true rows (Gregory Bot, Scott Chasing) are
    excluded from the per-CSM loop even though they carry is_csm=true."""
    fake_db.drake_rows = [_drake_row()]
    fake_db.csm_rows = [
        _csm("tm-1", "lou@theaipartner.io", "Lou Perez"),
        _csm(
            "tm-sentinel",
            "scott-chasing@theaipartner.io",
            "Scott Chasing",
            metadata={"sentinel": True},
        ),
    ]
    _stub_access_token(monkeypatch)
    called: list[str] = []

    def fake_fetch(*, access_token, calendar_id, time_min, time_max):
        called.append(calendar_id)
        return []

    monkeypatch.setattr(
        "api.teams_calendar_sync_cron._fetch_calendar_events", fake_fetch
    )

    cron.run_teams_calendar_sync_cron()

    # Only Lou's calendar was queried; the sentinel was filtered out.
    assert called == ["lou@theaipartner.io"]
