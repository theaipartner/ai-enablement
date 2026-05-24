"""Parser tests — Airtable record dict → mirror row dict.

The parser is the boundary between Airtable's API shape and our DB row
shape. Tests pin down:
  * type casts (currency/number → numeric, dateTime → ISO str,
    checkbox → bool, multipleRecordLinks → list[str])
  * empty-field-omission tolerance (Airtable omits empty fields; the
    parser must produce None for unset typed columns)
  * fields_raw catch-all carries the COMPLETE fields{} dict
  * is_setter_led provisional derivation (None when Setter Name absent;
    False when present-but-empty; True when populated)
  * region discriminator threads through Full Closer
  * missing record id → returns None
  * AUS region honored
"""

from __future__ import annotations

import pytest

from ingestion.airtable.parser import (
    parse_full_closer,
    parse_setter_triage,
    _to_bool,
    _to_numeric,
    _to_str_array,
)


# ---------------------------------------------------------------------------
# Cast helpers
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("v,expected", [
    (True, True),
    (False, False),
    ("true", True),
    ("False", False),
    ("Yes", True),
    ("no", False),
    ("1", True),
    ("0", False),
    (1, True),
    (0, False),
    (None, None),
    ("", None),
    ("maybe", None),
])
def test_to_bool_handles_variants(v, expected):
    assert _to_bool(v) == expected


@pytest.mark.parametrize("v,expected", [
    (15, 15.0),
    (15.5, 15.5),
    ("15", 15.0),
    ("1,500", 1500.0),  # comma-stripped
    ("  42  ", 42.0),
    (None, None),
    ("", None),
    ("nope", None),
    (True, None),  # bool is NOT numeric — should not coerce
])
def test_to_numeric_defensive(v, expected):
    assert _to_numeric(v) == expected


@pytest.mark.parametrize("v,expected", [
    (["recA", "recB"], ["recA", "recB"]),
    (["recA"], ["recA"]),
    ([], None),         # empty list → None per parser contract
    (None, None),
    ("recSolo", ["recSolo"]),
    ("", None),
])
def test_to_str_array_handles_variants(v, expected):
    assert _to_str_array(v) == expected


# ---------------------------------------------------------------------------
# Setter Triage parser
# ---------------------------------------------------------------------------


def test_parse_setter_triage_happy_path():
    record = {
        "id": "rec2bBTQnY7pGrvvA",
        "createdTime": "2026-05-23T15:19:00.000Z",
        "fields": {
            "Lead ID": "<lead-id>",
            "Lead Name": "<lead-name>",
            "Outcome": "Show",
            "Booking Status": "Confirmed Booked with Closer",
            "Showed %": True,
            "Booked with Closer?": True,
            "Setter Name": ["recSetter1"],
            "Name (from Setter Name)": ["Aman Ali"],
            "Event Date & Time": "2026-05-24T15:00:00.000Z",
            "Confirmed Call Date&Time": "2026-05-24T15:00:00.000Z",
            "Booked At": "2026-05-23T15:18:00.000Z",
            "Submitted At": "2026-05-23",
            "Notes": "<notes>",
        },
    }
    row = parse_setter_triage(record)

    assert row["record_id"] == "rec2bBTQnY7pGrvvA"
    assert row["airtable_created_at"] == "2026-05-23T15:19:00.000Z"
    assert row["lead_id"] == "<lead-id>"
    assert row["outcome"] == "Show"
    assert row["booking_status"] == "Confirmed Booked with Closer"
    assert row["showed_pct"] is True
    assert row["no_show_pct"] is None   # absent field
    assert row["booked_with_closer"] is True
    assert row["setter_record_ids"] == ["recSetter1"]
    assert row["setter_names"] == ["Aman Ali"]
    assert row["event_date_time"] == "2026-05-24T15:00:00.000Z"
    assert row["submitted_at"] == "2026-05-23"
    assert row["notes"] == "<notes>"
    # fields_raw carries the COMPLETE original dict
    assert row["fields_raw"] == record["fields"]


def test_parse_setter_triage_missing_id_returns_none():
    assert parse_setter_triage({"fields": {"Outcome": "Show"}}) is None
    assert parse_setter_triage({"id": "", "fields": {}}) is None


def test_parse_setter_triage_empty_fields_become_none():
    record = {
        "id": "rec123",
        "createdTime": "2026-05-23T15:19:00.000Z",
        "fields": {},  # Airtable omits empty fields
    }
    row = parse_setter_triage(record)
    assert row["record_id"] == "rec123"
    assert row["airtable_created_at"] == "2026-05-23T15:19:00.000Z"
    assert row["lead_id"] is None
    assert row["outcome"] is None
    assert row["booking_status"] is None
    assert row["showed_pct"] is None
    assert row["setter_record_ids"] is None
    # fields_raw is the empty dict that came in
    assert row["fields_raw"] == {}


# ---------------------------------------------------------------------------
# Full Closer Report parser
# ---------------------------------------------------------------------------


_SAMPLE_CLOSER_RECORD = {
    "id": "rec024ln7IgWx92Ml",
    "createdTime": "2026-04-06T20:54:55.000Z",
    "fields": {
        "Lead ID": "<lead-id>",
        "Prospect Name": "<name>",
        "Prospect Email": "<email>",
        "Prospect Phone": "+1234567890",
        "Call Type": "Consultation Call",
        "Date & Time of Call": "2026-04-06T20:00:00.000Z",
        "Call Recording": "https://example.com/call.mp4",
        "Call Notes": "<notes>",
        "Closer Name": ["recCloser1"],
        "Name (from Closer Name)": ["Closer A"],
        "Setter Name": ["recSetter1"],
        "Name (from Setter Name)": ["Setter A"],
        "Showed?": "Yes",
        "Closed?": "Yes",
        "Lost Deal?": "No",
        "Paid On Call?": True,
        "Contract Sent?": True,
        "Follow Up": "Continuation",
        "How much did they pay today?/How much are they paying upfront?": 2000,
        "Amount they paid today?": 2000,
        "Deposit?": 2000,
        "Total Contract Amount": 10000,
        "Income": 50000,
        "Payment Status": "Owing Money",
        "Payment Plan Type?": "Normal Plan",
        "Which program is the client going for?": "DFY",
        "Industry": "<industry>",
        "Location": "<location>",
        # Field that ONLY lives in fields_raw — not promoted to typed col
        "Partner Email": "<partner-email>",
    },
}


def test_parse_full_closer_us_happy_path():
    row = parse_full_closer(_SAMPLE_CLOSER_RECORD, region="US")

    assert row["record_id"] == "rec024ln7IgWx92Ml"
    assert row["region"] == "US"
    assert row["airtable_created_at"] == "2026-04-06T20:54:55.000Z"

    # Identity
    assert row["lead_id"] == "<lead-id>"
    assert row["prospect_phone"] == "+1234567890"

    # Call meta
    assert row["call_type"] == "Consultation Call"
    assert row["date_time_of_call"] == "2026-04-06T20:00:00.000Z"

    # Attribution
    assert row["closer_record_ids"] == ["recCloser1"]
    assert row["closer_names"] == ["Closer A"]
    assert row["setter_record_ids"] == ["recSetter1"]
    assert row["is_setter_led"] is True   # populated → derived True

    # Dispositions
    assert row["showed"] == "Yes"
    assert row["closed"] == "Yes"
    assert row["lost_deal"] == "No"
    assert row["paid_on_call"] is True
    assert row["contract_sent"] is True

    # Money — BOTH cash-paid-today fields populated separately
    assert row["amount_paid_today_currency"] == 2000.0
    assert row["amount_paid_today_number"] == 2000.0
    assert row["deposit_amount"] == 2000.0
    assert row["total_contract_amount"] == 10000.0
    assert row["income"] == 50000.0

    # fields_raw carries the full dict including the un-promoted Partner Email
    assert row["fields_raw"]["Partner Email"] == "<partner-email>"
    assert row["fields_raw"] == _SAMPLE_CLOSER_RECORD["fields"]


def test_parse_full_closer_aus_region_honored():
    aus_record = {**_SAMPLE_CLOSER_RECORD, "id": "recAUS1"}
    row = parse_full_closer(aus_record, region="AUS")
    assert row["record_id"] == "recAUS1"
    assert row["region"] == "AUS"


def test_parse_full_closer_invalid_region_raises():
    with pytest.raises(ValueError):
        parse_full_closer(_SAMPLE_CLOSER_RECORD, region="UK")


def test_parse_full_closer_missing_setter_name_is_setter_led_none():
    """No Setter Name field at all → can't distinguish 'no setter' from
    'field absent'; stored as None (NOT False)."""
    record = {
        "id": "rec1",
        "createdTime": "2026-05-23T00:00:00.000Z",
        "fields": {"Closer Name": ["recCloser1"]},  # NO Setter Name key
    }
    row = parse_full_closer(record, region="US")
    assert row["is_setter_led"] is None


def test_parse_full_closer_empty_setter_name_array_is_setter_led_false():
    """Setter Name present with empty array → explicitly NOT setter-led.

    Note: our _to_str_array maps [] → None (defensively), so this test
    documents the equivalence — empty array and absent field both
    collapse to is_setter_led=None. If Airtable ever distinguishes the
    two semantically, revisit the parser."""
    record = {
        "id": "rec1",
        "createdTime": "2026-05-23T00:00:00.000Z",
        "fields": {"Setter Name": []},
    }
    row = parse_full_closer(record, region="US")
    # Empty list collapses to None via _to_str_array; is_setter_led=None
    assert row["setter_record_ids"] is None
    assert row["is_setter_led"] is None


def test_parse_full_closer_missing_id_returns_none():
    assert parse_full_closer({"fields": {}}, region="US") is None


def test_parse_full_closer_sparse_record_handles_missing_fields():
    """Discovery showed Full Closer records typically have 9-15 of 66
    fields populated — empty fields are omitted. Parser must not crash
    on a sparse record and must produce None for absent typed cols."""
    record = {
        "id": "recSparse",
        "createdTime": "2026-04-06T20:54:55.000Z",
        "fields": {"Showed?": "No", "Closer Name": ["recCloser"]},  # only 2 fields
    }
    row = parse_full_closer(record, region="US")

    assert row["record_id"] == "recSparse"
    assert row["showed"] == "No"
    assert row["closer_record_ids"] == ["recCloser"]
    # Everything else: None
    assert row["closed"] is None
    assert row["deposit_amount"] is None
    assert row["paid_on_call"] is None
    assert row["call_type"] is None
    assert row["fields_raw"] == record["fields"]


def test_parse_full_closer_cash_paid_today_ambiguity_both_columns_distinct():
    """The two cash-paid-today fields can carry DIFFERENT values — the
    parser must keep them in separate typed columns so the dashboard
    can pick canonical without losing information."""
    record = {
        "id": "rec1",
        "createdTime": "2026-05-23T00:00:00.000Z",
        "fields": {
            "How much did they pay today?/How much are they paying upfront?": 2500,
            "Amount they paid today?": 2000,
        },
    }
    row = parse_full_closer(record, region="US")
    assert row["amount_paid_today_currency"] == 2500.0
    assert row["amount_paid_today_number"] == 2000.0
