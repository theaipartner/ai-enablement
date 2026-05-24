"""Cron tests — auth + since-window + webhook-refresh fail-soft."""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest

from api.airtable_sync_cron import _verify_auth, _SINCE_WINDOW


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


class _FakeHeaders:
    def __init__(self, d):
        self._d = d

    def get(self, key, default=None):
        return self._d.get(key, default)


def test_verify_auth_rejects_when_secret_unset(monkeypatch):
    monkeypatch.delenv("CRON_SECRET", raising=False)
    assert _verify_auth(_FakeHeaders({"Authorization": "Bearer x"})) is False


def test_verify_auth_rejects_missing_header(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "abc")
    assert _verify_auth(_FakeHeaders({})) is False


def test_verify_auth_rejects_wrong_secret(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "abc")
    assert _verify_auth(_FakeHeaders({"Authorization": "Bearer wrong"})) is False


def test_verify_auth_accepts_correct_secret(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "abc")
    assert _verify_auth(_FakeHeaders({"Authorization": "Bearer abc"})) is True


def test_verify_auth_accepts_lowercase_header_key(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "abc")
    assert _verify_auth(_FakeHeaders({"authorization": "Bearer abc"})) is True


def test_verify_auth_rejects_non_bearer_scheme(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "abc")
    assert _verify_auth(_FakeHeaders({"Authorization": "Basic abc"})) is False


# ---------------------------------------------------------------------------
# Since window
# ---------------------------------------------------------------------------


def test_since_window_is_six_hours():
    """6h overlap on a 15-min cadence = ~24× — enough room to absorb
    a webhook outage. If we change this, update the runbook."""
    assert _SINCE_WINDOW.total_seconds() == 6 * 3600
