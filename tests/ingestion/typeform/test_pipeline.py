"""Tests for ingestion/typeform/pipeline.

The pipeline is mostly orchestration over the client + parser + DB
upserts. These tests cover:
  - `sync_form_definition` — upsert path, idempotency-row shape.
  - `sync_responses` — calls iter_responses with the right args, upserts
    each, fail-soft per row, `since` and `limit` honored.
  - `upsert_response_from_webhook` — same upsert as backfill, lazy
    form-sync skipped when the form is already mirrored.
  - Critical: `iter_responses` MUST omit `sort` when `before` is set
    (the load-bearing API constraint discovery surfaced).
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from ingestion.typeform.client import TypeformAPIError, TypeformClient
from ingestion.typeform.pipeline import (
    SyncOutcome,
    sync_form_definition,
    sync_responses,
    upsert_response_from_webhook,
)


# ---------------------------------------------------------------------------
# Mock fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_db():
    """supabase-py chain mock: .table().upsert().execute()."""
    db = MagicMock()
    db.table.return_value.upsert.return_value.execute.return_value = MagicMock(data=[])
    db.table.return_value.select.return_value.eq.return_value.limit.return_value.execute.return_value = MagicMock(data=[])
    return db


def _form_def_raw() -> dict:
    return {
        "id": "FORM1",
        "title": "Active Funnel",
        "last_updated_at": "2026-05-01T10:00:00Z",
        "fields": [
            {"id": "f1", "ref": "ref-a", "type": "multiple_choice", "title": "Q1"},
        ],
        "hidden": ["utm_source"],
    }


def _response_raw() -> dict:
    return {
        "response_id": "tok123",
        "token": "tok123",
        "landed_at": "2026-05-21T13:00:00Z",
        "submitted_at": "2026-05-21T13:01:00Z",
        "metadata": {"platform": "mobile"},
        "hidden": {"utm_source": "ig"},
        "calculated": {"score": 0},
        "answers": [
            {"field": {"id": "f1", "ref": "ref-a", "type": "multiple_choice"},
             "type": "choice",
             "choice": {"id": "c1", "ref": "yes", "label": "Yes"}},
        ],
    }


# ---------------------------------------------------------------------------
# sync_form_definition
# ---------------------------------------------------------------------------


def test_sync_form_definition_upserts_and_records_outcome(mock_db):
    client = MagicMock(spec=TypeformClient)
    client.get_form.return_value = _form_def_raw()
    outcome = SyncOutcome()
    sync_form_definition(client, mock_db, "FORM1", outcome)
    assert outcome.forms_synced == 1
    assert outcome.forms_failed == 0
    # Upserted into typeform_forms
    mock_db.table.assert_any_call("typeform_forms")
    upsert_call = mock_db.table.return_value.upsert.call_args
    row = upsert_call.args[0]
    assert row["form_id"] == "FORM1"
    assert row["title"] == "Active Funnel"
    assert row["definition_synced_at"] is not None  # set at write time


def test_sync_form_definition_records_failure_on_api_error(mock_db):
    client = MagicMock(spec=TypeformClient)
    client.get_form.side_effect = TypeformAPIError("HTTP 500")
    outcome = SyncOutcome()
    sync_form_definition(client, mock_db, "FORM1", outcome)
    assert outcome.forms_synced == 0
    assert outcome.forms_failed == 1
    assert any("get_form:FORM1" in e for e in outcome.errors)


def test_sync_form_definition_skips_payload_without_id(mock_db):
    client = MagicMock(spec=TypeformClient)
    client.get_form.return_value = {"title": "no id"}  # missing 'id'
    outcome = SyncOutcome()
    sync_form_definition(client, mock_db, "FORM1", outcome)
    assert outcome.forms_synced == 0
    assert outcome.forms_failed == 1


# ---------------------------------------------------------------------------
# sync_responses — backfill + incremental path
# ---------------------------------------------------------------------------


def test_sync_responses_walks_and_upserts(mock_db):
    client = MagicMock(spec=TypeformClient)
    client.iter_responses.return_value = iter([_response_raw(), _response_raw()])
    outcome = SyncOutcome()
    sync_responses(client, mock_db, "FORM1", outcome=outcome)
    assert outcome.responses_synced == 2
    assert outcome.responses_failed == 0
    assert outcome.forms_walked == 1
    mock_db.table.assert_any_call("typeform_responses")


def test_sync_responses_honors_limit(mock_db):
    client = MagicMock(spec=TypeformClient)
    # Generator yields 5 but limit=2 caps processing.
    client.iter_responses.return_value = iter([_response_raw() for _ in range(5)])
    outcome = SyncOutcome()
    sync_responses(client, mock_db, "FORM1", limit=2, outcome=outcome)
    assert outcome.responses_synced == 2


def test_sync_responses_passes_since_to_client(mock_db):
    client = MagicMock(spec=TypeformClient)
    client.iter_responses.return_value = iter([])
    outcome = SyncOutcome()
    sync_responses(client, mock_db, "FORM1", since="2026-05-01T00:00:00", outcome=outcome)
    client.iter_responses.assert_called_with("FORM1", since="2026-05-01T00:00:00")


def test_sync_responses_skips_payload_without_response_id(mock_db):
    bad = _response_raw()
    bad.pop("response_id")
    bad.pop("token")
    client = MagicMock(spec=TypeformClient)
    client.iter_responses.return_value = iter([bad, _response_raw()])
    outcome = SyncOutcome()
    sync_responses(client, mock_db, "FORM1", outcome=outcome)
    assert outcome.responses_synced == 1  # only the good one
    assert outcome.responses_failed == 1


def test_sync_responses_records_iter_failure_but_does_not_raise(mock_db):
    client = MagicMock(spec=TypeformClient)

    def explode(*args, **kwargs):
        raise TypeformAPIError("HTTP 500 mid-walk")

    client.iter_responses.side_effect = explode
    outcome = SyncOutcome()
    sync_responses(client, mock_db, "FORM1", outcome=outcome)
    assert any("iter_responses:FORM1" in e for e in outcome.errors)


# ---------------------------------------------------------------------------
# upsert_response_from_webhook
# ---------------------------------------------------------------------------


def test_upsert_response_from_webhook_upserts_and_returns_id(mock_db):
    payload = {**_response_raw(), "form_id": "FORM1"}
    result = upsert_response_from_webhook(mock_db, payload)
    assert result == "tok123"
    mock_db.table.assert_any_call("typeform_responses")


def test_upsert_response_from_webhook_skips_missing_response_id(mock_db):
    payload = {**_response_raw(), "form_id": "FORM1"}
    payload.pop("response_id")
    payload.pop("token")
    result = upsert_response_from_webhook(mock_db, payload)
    assert result is None


def test_upsert_response_from_webhook_skips_missing_form_id(mock_db):
    payload = _response_raw()  # no form_id at all
    result = upsert_response_from_webhook(mock_db, payload)
    assert result is None


def test_upsert_response_from_webhook_lazy_syncs_form_when_absent(mock_db):
    """If the form definition isn't yet mirrored AND a client is passed,
    the receiver lazy-pulls + upserts it. Best-effort — failures don't
    block the response upsert."""
    payload = {**_response_raw(), "form_id": "NEWFORM"}
    client = MagicMock(spec=TypeformClient)
    client.get_form.return_value = {
        "id": "NEWFORM", "title": "X", "last_updated_at": None,
        "fields": [], "hidden": [],
    }
    # Form not present in mirror → empty result.
    mock_db.table.return_value.select.return_value.eq.return_value.limit.return_value.execute.return_value = MagicMock(data=[])
    upsert_response_from_webhook(mock_db, payload, client=client)
    client.get_form.assert_called_with("NEWFORM")


def test_upsert_response_from_webhook_skips_lazy_sync_when_form_present(mock_db):
    payload = {**_response_raw(), "form_id": "EXISTING"}
    client = MagicMock(spec=TypeformClient)
    # Form already mirrored.
    mock_db.table.return_value.select.return_value.eq.return_value.limit.return_value.execute.return_value = MagicMock(
        data=[{"form_id": "EXISTING"}]
    )
    upsert_response_from_webhook(mock_db, payload, client=client)
    client.get_form.assert_not_called()


def test_upsert_response_from_webhook_tolerates_lazy_sync_failure(mock_db):
    """Lazy form sync raising must not break the primary response upsert
    (the response IS already upserted before the lazy sync attempt)."""
    payload = {**_response_raw(), "form_id": "BROKEN"}
    client = MagicMock(spec=TypeformClient)
    client.get_form.side_effect = TypeformAPIError("HTTP 500")
    mock_db.table.return_value.select.return_value.eq.return_value.limit.return_value.execute.return_value = MagicMock(data=[])
    # Must not raise.
    result = upsert_response_from_webhook(mock_db, payload, client=client)
    assert result == "tok123"


# ---------------------------------------------------------------------------
# Client iter_responses — the load-bearing cursor pagination contract.
# ---------------------------------------------------------------------------


def test_iter_responses_omits_sort_when_cursor_present(monkeypatch):
    """API contract: `before`+`sort` returns HTTP 400. The client must
    never combine them. This test guards against a tidy-up regression."""
    client = TypeformClient(api_key="dummy")
    captured: list[tuple[str, str, dict]] = []

    def fake_list_responses(self, form_id, *, since=None, until=None, before=None, page_size=1000):
        # Capture exactly what list_responses received so the test can
        # assert the cursor-vs-no-sort invariant at the iter-level.
        params = {"since": since, "until": until, "before": before, "page_size": page_size}
        captured.append(("list_responses", form_id, params))
        # First page: 2 items, then empty on second.
        if before is None:
            return {"items": [{"token": "t1", "submitted_at": "2026-05-01T00:00:00Z"},
                              {"token": "t2", "submitted_at": "2026-04-30T00:00:00Z"}]}
        return {"items": []}

    monkeypatch.setattr(TypeformClient, "list_responses", fake_list_responses)
    list(client.iter_responses("FORM1"))
    # Two calls — first with no cursor, second with before=t2 (oldest from first page).
    assert len(captured) == 2
    assert captured[0][2]["before"] is None
    assert captured[1][2]["before"] == "t2"
    # No `sort` ever appears in params (the structural absence — list_responses
    # doesn't even accept a sort kwarg, mirroring the client's design).
    assert all("sort" not in c[2] for c in captured)
