"""Unit tests for ingestion.ghl.pipeline parsing (pure, no network/DB).

Covers the three contracts that the funnel depends on: (1) raw GHL fields land in
the right columns, (2) the call meta (duration/status) is lifted out of
meta.call, (3) the Airtable "Lead ID" is extracted from the "EOC From" custom
field and timestamps normalize (ISO passthrough + epoch-ms conversion).
"""

from __future__ import annotations

from ingestion.ghl.pipeline import (
    _ts,
    extract_eoc_lead_id,
    parse_contact,
    parse_conversation,
    parse_message,
)


# ---------------------------------------------------------------------------
# _ts
# ---------------------------------------------------------------------------


def test_ts_passthrough_iso_string():
    assert _ts("2026-06-29T19:55:11.582Z") == "2026-06-29T19:55:11.582Z"


def test_ts_epoch_millis_to_utc_iso():
    # 1782784762627 ms -> a UTC ISO string (conversation lastMessageDate shape).
    out = _ts(1782784762627)
    assert out is not None and "T" in out and "+00:00" in out


def test_ts_empty_is_none():
    assert _ts(None) is None
    assert _ts("") is None


# ---------------------------------------------------------------------------
# extract_eoc_lead_id
# ---------------------------------------------------------------------------


def test_extract_eoc_lead_id_encoded_space():
    cfs = [
        {
            "id": "KRkVfMSscPUKhDQJ5pjg",
            "value": "https://airtable.com/app/form?prefill_Lead%20ID=MFMWbEpWVQ5yfj90U8Iu&prefill_Prospect%20Name=Jeffrey",
        }
    ]
    assert extract_eoc_lead_id(cfs) == "MFMWbEpWVQ5yfj90U8Iu"


def test_extract_eoc_lead_id_missing_returns_none():
    assert extract_eoc_lead_id([{"id": "x", "value": "no lead id here"}]) is None
    assert extract_eoc_lead_id([]) is None
    assert extract_eoc_lead_id(None) is None


# ---------------------------------------------------------------------------
# parse_contact
# ---------------------------------------------------------------------------


def test_parse_contact_projects_and_extracts():
    raw = {
        "id": "MFMWbEpWVQ5yfj90U8Iu",
        "locationId": "LOC1",
        "source": "DC Revival Lead",
        "firstName": "Jeffrey",
        "lastName": "Laubach",
        "email": "j@example.com",
        "phone": "+12708495568",
        "tags": [],
        "assignedTo": None,
        "dateAdded": "2026-06-29T19:55:11.582Z",
        "customFields": [
            {"id": "KRkVfMSscPUKhDQJ5pjg", "value": "x?prefill_Lead%20ID=MFMWbEpWVQ5yfj90U8Iu"}
        ],
    }
    row = parse_contact(raw)
    assert row["id"] == "MFMWbEpWVQ5yfj90U8Iu"
    assert row["source"] == "DC Revival Lead"
    assert row["eoc_lead_id"] == "MFMWbEpWVQ5yfj90U8Iu"  # == contact id (closer-report join)
    assert row["tags"] == []
    assert row["raw"] is raw


def test_parse_contact_null_tags_defaults_empty_list():
    row = parse_contact({"id": "c1", "locationId": "L", "tags": None, "customFields": None})
    assert row["tags"] == []
    assert row["eoc_lead_id"] is None


# ---------------------------------------------------------------------------
# parse_message — the call signal
# ---------------------------------------------------------------------------


def test_parse_message_call_lifts_duration_and_status():
    raw = {
        "id": "m1",
        "conversationId": "conv1",
        "contactId": "c1",
        "messageType": "TYPE_CALL",
        "direction": "outbound",
        "status": "completed",
        "userId": "RlYhwCv3MTnjRA5lKEqE",
        "meta": {"call": {"duration": 157, "status": "completed"}},
        "dateAdded": "2026-06-30T00:07:38.439Z",
    }
    row = parse_message(raw)
    assert row["message_type"] == "TYPE_CALL"
    assert row["call_duration"] == 157
    assert row["call_status"] == "completed"
    assert row["user_id"] == "RlYhwCv3MTnjRA5lKEqE"


def test_parse_message_sms_has_no_call_fields():
    raw = {
        "id": "m2",
        "messageType": "TYPE_SMS",
        "direction": "inbound",
        "status": "delivered",
        "body": "hi",
        "dateAdded": "2026-06-30T01:59:22.744Z",
    }
    row = parse_message(raw)
    assert row["call_duration"] is None
    assert row["call_status"] is None
    assert row["body"] == "hi"


def test_parse_conversation_normalizes_epoch_last_message_date():
    raw = {
        "id": "conv1",
        "contactId": "c1",
        "type": "TYPE_PHONE",
        "lastMessageDate": 1782784762627,
        "lastMessageType": "TYPE_SMS",
    }
    row = parse_conversation(raw)
    assert row["id"] == "conv1"
    assert row["last_message_type"] == "TYPE_SMS"
    assert row["last_message_date"] is not None and "+00:00" in row["last_message_date"]
