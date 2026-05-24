"""Unit tests for api/wistia_sync_cron.

Cron-shell concerns: auth, Wistia-token-unavailable path, happy-path
orchestration. Pipeline logic exercised through tests/ingestion/wistia/.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from api.wistia_sync_cron import _verify_auth, run_wistia_sync_cron


# ---------------------------------------------------------------------------
# _verify_auth — mirrors api/meta_sheet_sync_cron auth tests
# ---------------------------------------------------------------------------


def test_verify_auth_happy_path(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "supersecret")
    headers = {"Authorization": "Bearer supersecret"}
    assert _verify_auth(headers) is True


def test_verify_auth_lowercase_header_works(monkeypatch):
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
# run_wistia_sync_cron — orchestration
# ---------------------------------------------------------------------------


def test_run_returns_error_when_wistia_token_missing():
    """No WISTIA_API_TOKEN → audit + return; never call sync_wistia_rolling."""
    mock_db = MagicMock()
    mock_db.table.return_value.insert.return_value.execute.return_value = MagicMock()
    with patch("api.wistia_sync_cron.get_client", return_value=mock_db), \
         patch(
             "api.wistia_sync_cron.WistiaClient.from_env",
             side_effect=RuntimeError("WISTIA_API_TOKEN not set"),
         ), \
         patch("api.wistia_sync_cron.sync_wistia_rolling") as mock_sync:
        result = run_wistia_sync_cron()
    assert result["error"] == "wistia_token_unavailable"
    assert "WISTIA_API_TOKEN" in result["detail"]
    mock_sync.assert_not_called()


def test_run_happy_path_calls_sync_and_returns_audit_payload():
    mock_db = MagicMock()
    mock_db.table.return_value.insert.return_value.execute.return_value = MagicMock()

    from ingestion.wistia.pipeline import SyncOutcome
    fake_outcome = SyncOutcome(
        medias_synced=80,
        medias_failed=0,
        daily_rows_upserted=1120,
        daily_rows_failed=0,
        days_in_window=14,
        window={"start_date": "2026-05-11", "end_date": "2026-05-24"},
        warnings=[],
        errors=[],
    )
    with patch("api.wistia_sync_cron.get_client", return_value=mock_db), \
         patch("api.wistia_sync_cron.WistiaClient.from_env",
               return_value=MagicMock()), \
         patch(
             "api.wistia_sync_cron.sync_wistia_rolling",
             return_value=fake_outcome,
         ) as mock_sync:
        result = run_wistia_sync_cron()
    mock_sync.assert_called_once()
    assert result["medias_synced"] == 80
    assert result["daily_rows_upserted"] == 1120
    assert result["days_in_window"] == 14
    assert result["window"]["start_date"] == "2026-05-11"
    assert result["errors"] == []
    assert result["errors_truncated"] is False


def test_run_error_truncation_in_audit_payload():
    """Audit row caps errors to keep payload size sane."""
    mock_db = MagicMock()
    mock_db.table.return_value.insert.return_value.execute.return_value = MagicMock()
    from ingestion.wistia.pipeline import SyncOutcome
    many_errors = [f"err {i}" for i in range(75)]
    fake_outcome = SyncOutcome(
        medias_synced=5,
        medias_failed=75,
        errors=many_errors,
    )
    with patch("api.wistia_sync_cron.get_client", return_value=mock_db), \
         patch("api.wistia_sync_cron.WistiaClient.from_env", return_value=MagicMock()), \
         patch("api.wistia_sync_cron.sync_wistia_rolling", return_value=fake_outcome):
        result = run_wistia_sync_cron()
    assert len(result["errors"]) == 50  # capped
    assert result["errors_truncated"] is True
