"""Unit tests for api/typeform_sync_cron.

Cron-shell concerns: auth, token-unavailable path, since-window
construction, audit-row write on happy path. Pipeline logic exercised
through tests/ingestion/typeform/.
"""

from __future__ import annotations

import re
from unittest.mock import MagicMock, patch

import pytest

from api.typeform_sync_cron import _verify_auth, run_typeform_sync_cron


# ---------------------------------------------------------------------------
# _verify_auth
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
    headers = {"Authorization": "Bearer wrong"}
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
# run_typeform_sync_cron — orchestration
# ---------------------------------------------------------------------------


def test_run_returns_error_when_token_missing():
    """No TYPEFORM_API_KEY → audit + return; never call sync_all_responses."""
    mock_db = MagicMock()
    mock_db.table.return_value.insert.return_value.execute.return_value = MagicMock()
    with patch("api.typeform_sync_cron.get_client", return_value=mock_db), \
         patch(
             "api.typeform_sync_cron.TypeformClient.from_env",
             side_effect=RuntimeError("TYPEFORM_API_KEY not set"),
         ), \
         patch("api.typeform_sync_cron.sync_all_responses") as mock_sync_r, \
         patch("api.typeform_sync_cron.sync_all_form_definitions") as mock_sync_f:
        result = run_typeform_sync_cron()
    assert result["error"] == "typeform_token_unavailable"
    mock_sync_r.assert_not_called()
    mock_sync_f.assert_not_called()


def test_run_happy_path_walks_definitions_and_responses():
    mock_db = MagicMock()
    mock_db.table.return_value.insert.return_value.execute.return_value = MagicMock()

    from ingestion.typeform.pipeline import SyncOutcome
    fake_outcome = SyncOutcome(
        forms_walked=8,
        forms_synced=31,
        forms_failed=0,
        responses_synced=12,
        responses_failed=0,
        errors=[],
    )
    with patch("api.typeform_sync_cron.get_client", return_value=mock_db), \
         patch("api.typeform_sync_cron.TypeformClient.from_env", return_value=MagicMock()), \
         patch("api.typeform_sync_cron.sync_all_form_definitions") as mock_sync_f, \
         patch("api.typeform_sync_cron.sync_all_responses") as mock_sync_r:
        # Both pipeline calls mutate the same outcome by reference;
        # the simplest fake matches that contract.
        def populate_outcome(client, db, outcome=None, **kwargs):
            if outcome is not None:
                outcome.forms_walked = fake_outcome.forms_walked
                outcome.forms_synced = fake_outcome.forms_synced
                outcome.responses_synced = fake_outcome.responses_synced
            return outcome
        mock_sync_f.side_effect = populate_outcome
        mock_sync_r.side_effect = populate_outcome

        result = run_typeform_sync_cron()

    mock_sync_f.assert_called_once()
    mock_sync_r.assert_called_once()

    # Audit payload has the cron-relevant fields.
    assert "since" in result
    assert "forms_synced" in result
    assert "responses_synced" in result

    # `since` is a recent ISO-8601 timestamp (now - safety window).
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", result["since"])

    # An audit row landed in webhook_deliveries.
    mock_db.table.assert_any_call("webhook_deliveries")


def test_run_passes_since_to_sync_all_responses():
    """The cron's safety-window hours flow through to the pipeline call
    as a since= argument — load-bearing for the backstop semantics."""
    mock_db = MagicMock()
    mock_db.table.return_value.insert.return_value.execute.return_value = MagicMock()

    captured_kwargs: dict = {}

    def capture(client, db, outcome=None, **kwargs):
        captured_kwargs.update(kwargs)
        return outcome

    with patch("api.typeform_sync_cron.get_client", return_value=mock_db), \
         patch("api.typeform_sync_cron.TypeformClient.from_env", return_value=MagicMock()), \
         patch("api.typeform_sync_cron.sync_all_form_definitions"), \
         patch("api.typeform_sync_cron.sync_all_responses", side_effect=capture):
        run_typeform_sync_cron()

    assert "since" in captured_kwargs
    assert captured_kwargs["since"] is not None
