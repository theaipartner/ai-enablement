"""Unit tests for api/meta_sheet_sync_cron.

Focused on the cron-shell concerns: auth, drake-lookup failure, OAuth
error path. The actual sync work is exercised through
tests/ingestion/meta/.
"""

from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

import pytest

from api.meta_sheet_sync_cron import (
    _verify_auth,
    run_meta_sheet_sync_cron,
)
from shared.google_oauth import GoogleOAuthError


# ---------------------------------------------------------------------------
# _verify_auth
# ---------------------------------------------------------------------------


def test_verify_auth_happy_path(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "supersecret")
    headers = {"Authorization": "Bearer supersecret"}
    assert _verify_auth(headers) is True


def test_verify_auth_lowercase_header_also_works(monkeypatch):
    """Some HTTP layers normalize header case; cron handles both."""
    monkeypatch.setenv("CRON_SECRET", "supersecret")
    headers = {"authorization": "Bearer supersecret"}
    assert _verify_auth(headers) is True


def test_verify_auth_wrong_token_rejected(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "supersecret")
    headers = {"Authorization": "Bearer wrongsecret"}
    assert _verify_auth(headers) is False


def test_verify_auth_missing_bearer_prefix_rejected(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "supersecret")
    headers = {"Authorization": "supersecret"}
    assert _verify_auth(headers) is False


def test_verify_auth_no_secret_configured_rejected(monkeypatch):
    monkeypatch.delenv("CRON_SECRET", raising=False)
    headers = {"Authorization": "Bearer anything"}
    assert _verify_auth(headers) is False


def test_verify_auth_no_header_rejected(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "supersecret")
    assert _verify_auth({}) is False


# ---------------------------------------------------------------------------
# run_meta_sheet_sync_cron — orchestration
# ---------------------------------------------------------------------------


def test_run_returns_error_when_drake_missing():
    """If we can't find Drake's team_member row, audit + return without
    attempting OAuth."""
    mock_db = MagicMock()
    mock_db.table.return_value.select.return_value.eq.return_value.is_.return_value.limit.return_value.execute.return_value = MagicMock(data=[])
    # _insert_audit also calls db.table — same mock fine.
    mock_db.table.return_value.insert.return_value.execute.return_value = MagicMock()

    with patch("api.meta_sheet_sync_cron.get_client", return_value=mock_db):
        result = run_meta_sheet_sync_cron()
    assert result == {"error": "drake_team_member_not_found"}


def test_run_returns_error_when_oauth_fails():
    """OAuth refresh failure → audit + return; no sheet fetch attempted."""
    mock_db = MagicMock()
    mock_db.table.return_value.select.return_value.eq.return_value.is_.return_value.limit.return_value.execute.return_value = MagicMock(
        data=[{"id": "tm_drake", "email": "drake@theaipartner.io"}]
    )
    mock_db.table.return_value.insert.return_value.execute.return_value = MagicMock()

    with patch("api.meta_sheet_sync_cron.get_client", return_value=mock_db), \
         patch(
             "api.meta_sheet_sync_cron.get_valid_access_token",
             side_effect=GoogleOAuthError("refresh failed: scope revoked"),
         ), \
         patch("api.meta_sheet_sync_cron.sync_meta_ad_daily") as mock_sync:
        result = run_meta_sheet_sync_cron()
    assert result["error"] == "oauth_token_unavailable"
    assert "scope revoked" in result["detail"]
    mock_sync.assert_not_called()


def test_run_happy_path_calls_sync_and_returns_audit_payload():
    mock_db = MagicMock()
    mock_db.table.return_value.select.return_value.eq.return_value.is_.return_value.limit.return_value.execute.return_value = MagicMock(
        data=[{"id": "tm_drake", "email": "drake@theaipartner.io"}]
    )
    mock_db.table.return_value.insert.return_value.execute.return_value = MagicMock()

    from ingestion.meta.pipeline import SyncOutcome
    fake_outcome = SyncOutcome(
        rows_parsed=23,
        rows_upserted=23,
        rows_failed=0,
        days_covered=["2026-05-02", "2026-05-23"],
        warnings=[],
        errors=[],
    )
    with patch("api.meta_sheet_sync_cron.get_client", return_value=mock_db), \
         patch(
             "api.meta_sheet_sync_cron.get_valid_access_token",
             return_value="fake-access-token",
         ), \
         patch(
             "api.meta_sheet_sync_cron.sync_meta_ad_daily",
             return_value=fake_outcome,
         ) as mock_sync:
        result = run_meta_sheet_sync_cron()
    mock_sync.assert_called_once_with(mock_db, "fake-access-token")
    assert result["rows_parsed"] == 23
    assert result["rows_upserted"] == 23
    assert result["days_range"] == ["2026-05-02", "2026-05-23"]
    assert result["errors"] == []
