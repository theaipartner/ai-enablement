"""Unit tests for the webhook entry points in ingestion/close/pipeline.

The backfill flow has been validated end-to-end in production (5,172
leads). The new helpers are the per-row upserts the webhook receiver
calls — these tests cover the parse → upsert dispatch + the idempotency
guard against missing close_id / lead_id.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from ingestion.close.pipeline import (
    load_lead_cf_id_to_name,
    upsert_call_from_payload,
    upsert_lead_from_payload,
    upsert_lead_status_change_from_payload,
    upsert_opportunity_from_payload,
    upsert_sms_from_payload,
)


@pytest.fixture
def mock_db():
    """supabase-py-style chain mock: table().upsert().execute()."""
    db = MagicMock()
    # The chain always returns itself so .execute() lands on the same mock
    db.table.return_value.upsert.return_value.execute.return_value = MagicMock(data=[])
    db.table.return_value.select.return_value.eq.return_value.execute.return_value = MagicMock(data=[])
    return db


# ---------------------------------------------------------------------------
# load_lead_cf_id_to_name
# ---------------------------------------------------------------------------


def test_load_lead_cf_id_to_name_builds_map():
    db = MagicMock()
    db.table.return_value.select.return_value.eq.return_value.execute.return_value = MagicMock(
        data=[
            {"close_id": "cf_A", "name": "Investment"},
            {"close_id": "cf_B", "name": "Funnel Name"},
        ]
    )
    result = load_lead_cf_id_to_name(db)
    assert result == {"cf_A": "Investment", "cf_B": "Funnel Name"}
    db.table.assert_called_with("close_custom_field_definitions")


def test_load_lead_cf_id_to_name_empty_table_returns_empty_map():
    db = MagicMock()
    db.table.return_value.select.return_value.eq.return_value.execute.return_value = MagicMock(
        data=[]
    )
    assert load_lead_cf_id_to_name(db) == {}


# ---------------------------------------------------------------------------
# upsert_lead_from_payload
# ---------------------------------------------------------------------------


def test_upsert_lead_returns_close_id_on_success(mock_db):
    payload = {
        "id": "lead_ABC",
        "display_name": "Test Lead",
        "status_id": "stat_X",
        "custom.cf_inv": "Under $2,000",
    }
    cf_map = {"cf_inv": "Investment"}  # so tier derivation has a name
    upserted_id = upsert_lead_from_payload(mock_db, payload, cf_map)
    assert upserted_id == "lead_ABC"
    mock_db.table.assert_called_with("close_leads")
    # The row passed to upsert should include the tier derived from
    # 'Under $2,000' → tier_2.
    upsert_call = mock_db.table.return_value.upsert.call_args
    row = upsert_call.args[0]
    assert row["close_id"] == "lead_ABC"
    assert row["tier"] == "tier_2"


def test_upsert_lead_missing_close_id_returns_none(mock_db):
    payload = {"display_name": "no id"}
    result = upsert_lead_from_payload(mock_db, payload, {})
    assert result is None
    # No DB call should have been made.
    mock_db.table.return_value.upsert.assert_not_called()


def test_upsert_lead_with_unknown_cf_still_succeeds_and_lands_in_raw(mock_db):
    """Webhook payload may carry cfs we haven't synced yet — graceful degrade."""
    payload = {
        "id": "lead_XYZ",
        "custom.cf_unknown_to_us": "some value",
    }
    upserted_id = upsert_lead_from_payload(mock_db, payload, cf_id_to_name={})
    assert upserted_id == "lead_XYZ"
    row = mock_db.table.return_value.upsert.call_args.args[0]
    # Value still lands in custom_fields_raw jsonb, just not in a typed column.
    assert row["custom_fields_raw"] == {"cf_unknown_to_us": "some value"}


# ---------------------------------------------------------------------------
# upsert_call_from_payload
# ---------------------------------------------------------------------------


def test_upsert_call_happy_path(mock_db):
    payload = {
        "id": "acti_call_1",
        "lead_id": "lead_X",
        "direction": "outbound",
        "duration": 120,
        "user_id": "user_Y",
    }
    upserted_id = upsert_call_from_payload(mock_db, payload)
    assert upserted_id == "acti_call_1"
    mock_db.table.assert_called_with("close_calls")


def test_upsert_call_missing_lead_id_returns_none(mock_db):
    """Activity rows without a lead_id are unusable (loose FK)."""
    payload = {"id": "acti_orphan", "direction": "outbound"}
    assert upsert_call_from_payload(mock_db, payload) is None
    mock_db.table.return_value.upsert.assert_not_called()


def test_upsert_call_missing_close_id_returns_none(mock_db):
    payload = {"lead_id": "lead_X"}
    assert upsert_call_from_payload(mock_db, payload) is None


# ---------------------------------------------------------------------------
# upsert_sms_from_payload
# ---------------------------------------------------------------------------


def test_upsert_sms_happy_path(mock_db):
    payload = {
        "id": "acti_sms_1",
        "lead_id": "lead_X",
        "direction": "inbound",
        "text": "Hello",
    }
    upserted_id = upsert_sms_from_payload(mock_db, payload)
    assert upserted_id == "acti_sms_1"
    mock_db.table.assert_called_with("close_sms")


def test_upsert_sms_missing_lead_id_returns_none(mock_db):
    assert upsert_sms_from_payload(mock_db, {"id": "acti_orphan"}) is None


# ---------------------------------------------------------------------------
# upsert_opportunity_from_payload — Drake 2026-05-23 override
# ---------------------------------------------------------------------------


def test_upsert_opportunity_happy_path(mock_db):
    """Drake override 2026-05-23: opportunities are IN scope for live."""
    payload = {
        "id": "oppo_ABC",
        "lead_id": "lead_X",
        "status_label": "Confirmed booking",
        "value": 1,  # placeholder; not treated as money
    }
    upserted_id = upsert_opportunity_from_payload(mock_db, payload)
    assert upserted_id == "oppo_ABC"
    mock_db.table.assert_called_with("close_opportunities")


def test_upsert_opportunity_missing_lead_id_returns_none(mock_db):
    assert upsert_opportunity_from_payload(mock_db, {"id": "oppo_orphan"}) is None


# ---------------------------------------------------------------------------
# upsert_lead_status_change_from_payload
# ---------------------------------------------------------------------------


def test_upsert_status_change_happy_path(mock_db):
    payload = {
        "id": "acti_lsc_1",
        "lead_id": "lead_X",
        "old_status_id": "stat_A",
        "new_status_id": "stat_B",
        "user_id": "user_Y",
    }
    upserted_id = upsert_lead_status_change_from_payload(mock_db, payload)
    assert upserted_id == "acti_lsc_1"
    mock_db.table.assert_called_with("close_lead_status_changes")


def test_upsert_status_change_missing_lead_id_returns_none(mock_db):
    assert upsert_lead_status_change_from_payload(mock_db, {"id": "acti_lsc_orphan"}) is None
