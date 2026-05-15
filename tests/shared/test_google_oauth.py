"""Unit tests for `shared.google_oauth.get_valid_access_token` +
`_refresh_access_token`. Covers the three branches the cron depends on:

  - stored token still valid → returns it without a refresh call
  - stored token expired → refresh fires + DB updates + returns new
  - refresh fails → GoogleOAuthError raised (cron catches)
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any

import pytest

from shared import google_oauth as oauth
from shared.google_oauth import GoogleOAuthError, get_valid_access_token


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

    def update(self, payload):
        self._mode = "update"
        self._payload = payload
        return self

    def eq(self, k, v):
        self._filters.append(("eq", k, v))
        return self

    def limit(self, *_a, **_kw):
        return self

    def execute(self):
        if self._mode == "select" and self.table == "oauth_tokens":
            return SimpleNamespace(data=list(self.fake.token_rows))
        if self._mode == "update" and self.table == "oauth_tokens":
            self.fake.token_updates.append((self._filters, self._payload))
            return SimpleNamespace(data=[{}])
        raise AssertionError(
            f"unexpected execute table={self.table} mode={self._mode}"
        )


class _FakeDb:
    def __init__(self):
        self.token_rows: list[dict] = []
        self.token_updates: list[tuple] = []

    def table(self, name):
        return _Chain(name, self)


@pytest.fixture
def fake_db(monkeypatch):
    db = _FakeDb()
    monkeypatch.setattr("shared.db.get_client", lambda: db)
    monkeypatch.setattr("shared.google_oauth.get_client", lambda: db)
    return db


@pytest.fixture(autouse=True)
def _stub_env(monkeypatch):
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_ID", "client-id")
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_SECRET", "client-secret")


# ---------------------------------------------------------------------------
# Stored token still valid
# ---------------------------------------------------------------------------


def test_returns_stored_token_when_not_expired(fake_db, monkeypatch):
    """Stored access_token is valid for another hour → no refresh call."""
    future_expiry = (
        datetime.now(timezone.utc) + timedelta(hours=1)
    ).isoformat()
    fake_db.token_rows = [
        {
            "access_token": "still-valid",
            "refresh_token": "rt-1",
            "access_token_expires_at": future_expiry,
        }
    ]
    called = {"n": 0}
    monkeypatch.setattr(
        "shared.google_oauth._refresh_access_token",
        lambda *a, **kw: (called.__setitem__("n", called["n"] + 1), {})[1],
    )

    token = get_valid_access_token("tm-1")

    assert token == "still-valid"
    assert called["n"] == 0
    assert fake_db.token_updates == []


# ---------------------------------------------------------------------------
# Stored token expired → refresh fires
# ---------------------------------------------------------------------------


def test_refreshes_when_token_expired(fake_db, monkeypatch):
    past_expiry = (
        datetime.now(timezone.utc) - timedelta(minutes=5)
    ).isoformat()
    fake_db.token_rows = [
        {
            "access_token": "stale",
            "refresh_token": "rt-1",
            "access_token_expires_at": past_expiry,
        }
    ]
    monkeypatch.setattr(
        "shared.google_oauth._refresh_access_token",
        lambda rt: {
            "access_token": "fresh-token",
            "expires_in": 3600,
            "scope": "https://www.googleapis.com/auth/calendar.readonly",
        },
    )

    token = get_valid_access_token("tm-1")

    assert token == "fresh-token"
    # DB update wrote the new access_token + a fresh expiry.
    assert len(fake_db.token_updates) == 1
    _, update_payload = fake_db.token_updates[0]
    assert update_payload["access_token"] == "fresh-token"
    assert "access_token_expires_at" in update_payload
    assert update_payload["scope"] == "https://www.googleapis.com/auth/calendar.readonly"


# ---------------------------------------------------------------------------
# Refresh failures
# ---------------------------------------------------------------------------


def test_no_row_raises(fake_db):
    fake_db.token_rows = []
    with pytest.raises(GoogleOAuthError, match="no oauth_tokens row"):
        get_valid_access_token("tm-missing")


def test_refresh_http_error_raises(fake_db, monkeypatch):
    past_expiry = (
        datetime.now(timezone.utc) - timedelta(minutes=5)
    ).isoformat()
    fake_db.token_rows = [
        {
            "access_token": "stale",
            "refresh_token": "rt-1",
            "access_token_expires_at": past_expiry,
        }
    ]

    def _raise(rt):
        raise GoogleOAuthError("google token refresh returned http 400")

    monkeypatch.setattr("shared.google_oauth._refresh_access_token", _raise)

    with pytest.raises(GoogleOAuthError, match="returned http 400"):
        get_valid_access_token("tm-1")


def test_refresh_within_buffer_window_still_refreshes(fake_db, monkeypatch):
    """If the token has <60s left on its life, we proactively refresh
    rather than letting it expire mid-sync."""
    just_about_expired = (
        datetime.now(timezone.utc) + timedelta(seconds=30)
    ).isoformat()
    fake_db.token_rows = [
        {
            "access_token": "stale-ish",
            "refresh_token": "rt-1",
            "access_token_expires_at": just_about_expired,
        }
    ]
    monkeypatch.setattr(
        "shared.google_oauth._refresh_access_token",
        lambda rt: {"access_token": "fresh", "expires_in": 3600},
    )

    token = get_valid_access_token("tm-1")

    assert token == "fresh"
    assert len(fake_db.token_updates) == 1
