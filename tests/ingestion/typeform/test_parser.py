"""Tests for ingestion/typeform/parser.

Fixtures use the discovery-verified response shape (PWSNd0h2 / SFedWelr
funnel forms) with all respondent PII masked — emails, names, phones
become `<redacted-*>` strings. The shape is preserved exactly; only
the values are placeholders.

The two parsers (`parse_form_definition`, `parse_response`) both must
be idempotent and structure-preserving — re-running on the same input
yields the same row, and the row's jsonb fields carry the exact same
keys the receiver / dashboard rely on.
"""

from __future__ import annotations

from ingestion.typeform.parser import (
    _flatten_fields,
    parse_form_definition,
    parse_response,
)


# ---------------------------------------------------------------------------
# Fixtures — discovery-verified shape with PII masked
# ---------------------------------------------------------------------------


def _form_definition_fixture() -> dict:
    """Mirrors PWSNd0h2 (Setter Funnel) — 5 fields, last 3 inside a
    contact_info group, hidden field list with utm + ad attribution."""
    return {
        "id": "PWSNd0h2",
        "title": "US TF Funnel --> ClickFunnels (go.theaipartner.io) -- Setter Funnel",
        "last_updated_at": "2026-04-29T20:38:07Z",
        "fields": [
            {
                "id": "1g0cvUrRvS",
                "ref": "670168f4-e25d-4182",
                "type": "multiple_choice",
                "title": "Are you interested in building a profitable AI business?",
                "properties": {
                    "choices": [
                        {"id": "c1", "ref": "yes-ref", "label": "Yes, I am looking to build a profitable AI business"},
                        {"id": "c2", "ref": "no-ref", "label": "No, I am not interested"},
                    ],
                },
            },
            {
                "id": "M7VwoUepJD",
                "ref": "bd4e0524-e136-4590",
                "type": "multiple_choice",
                "title": "What's your monthly income?",
                "properties": {
                    "choices": [
                        {"id": "i1", "ref": "8k-plus", "label": "$8,000+"},
                        {"id": "i2", "ref": "below-1k", "label": "Below $1,000"},
                    ],
                },
            },
            {
                "id": "group_contact",
                "ref": "contact-group-ref",
                "type": "group",
                "title": "Contact Details",
                "properties": {
                    "fields": [
                        {
                            "id": "WtuXN0Y7zN",
                            "ref": "ae611fb7-a858",
                            "type": "email",
                            "title": "Best email address",
                        },
                        {
                            "id": "eHW0fr7V6p",
                            "ref": "5c7917b0-43be",
                            "type": "short_text",
                            "title": "First name",
                        },
                        {
                            "id": "cxwj0bqfTs",
                            "ref": "c3c3fe18-e76f",
                            "type": "phone_number",
                            "title": "Phone",
                        },
                    ],
                },
            },
        ],
        "hidden": [
            "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
            "ad_id", "ad_name", "fbp", "fbc", "ip", "event_id",
            "campaign_id", "adset_id",
        ],
        # Other top-level keys the API returns; parser should ignore them.
        "welcome_screens": [],
        "thankyou_screens": [{"ref": "ty1"}],
        "logic": [{"type": "field", "ref": "..."}],
    }


def _response_fixture() -> dict:
    """Mirrors a PWSNd0h2 submission with PII masked. Shape verified
    against the live API in discovery (see docs/reports/typeform-discovery.md
    § Real response shape)."""
    return {
        "response_id": "upjjv93lhtee22blkduwupjjv2814uzt",
        "token": "upjjv93lhtee22blkduwupjjv2814uzt",  # same as response_id
        "landed_at": "2026-05-21T13:52:27Z",
        "submitted_at": "2026-05-21T13:54:04Z",
        "response_type": "completed",
        "thankyou_screen_ref": "ty1",
        "landing_id": "abc123",
        "metadata": {
            "browser": "default",
            "network_id": "<masked>",
            "platform": "mobile",
            "referer": "<masked-url>",
            "user_agent": "Mozilla/5.0 …",
        },
        "hidden": {
            "utm_source": "ig",
            "utm_medium": "paid",
            "utm_campaign": "120246387294960748",
            "utm_term": "<aaid>",
            "utm_content": "120246387338210748",
            "ad_id": "",
            "ad_name": "",
            "fbp": "",
            "fbc": "fb.1.1779371530.…",
            "ip": "<respondent-ip>",
            "event_id": "<event-uuid>",
            "campaign_id": "",
            "adset_id": "",
        },
        "calculated": {"score": 0},
        "answers": [
            {
                "field": {"id": "1g0cvUrRvS", "ref": "670168f4-e25d-4182", "type": "multiple_choice"},
                "type": "choice",
                "choice": {"id": "c1", "ref": "yes-ref", "label": "Yes"},
            },
            {
                "field": {"id": "M7VwoUepJD", "ref": "bd4e0524-e136-4590", "type": "multiple_choice"},
                "type": "choice",
                "choice": {"id": "i2", "ref": "below-1k", "label": "Below $1,000"},
            },
            {
                "field": {"id": "WtuXN0Y7zN", "ref": "ae611fb7-a858", "type": "email"},
                "type": "email",
                "email": "<redacted-email>",
            },
            {
                "field": {"id": "eHW0fr7V6p", "ref": "5c7917b0-43be", "type": "short_text"},
                "type": "text",
                "text": "<redacted-text>",
            },
            {
                "field": {"id": "cxwj0bqfTs", "ref": "c3c3fe18-e76f", "type": "phone_number"},
                "type": "phone_number",
                "phone_number": "<redacted-phone>",
            },
        ],
    }


# ---------------------------------------------------------------------------
# _flatten_fields — group unwrapping
# ---------------------------------------------------------------------------


def test_flatten_fields_unwraps_groups():
    raw = _form_definition_fixture()["fields"]
    flat = _flatten_fields(raw)
    # 2 top-level multiple_choice + 3 inner fields from the group = 5 leaves
    assert len(flat) == 5
    types = [f["type"] for f in flat]
    assert "group" not in types
    assert types == ["multiple_choice", "multiple_choice", "email", "short_text", "phone_number"]


def test_flatten_fields_records_group_ref_on_children():
    flat = _flatten_fields(_form_definition_fixture()["fields"])
    inner = [f for f in flat if f["type"] in ("email", "short_text", "phone_number")]
    assert all(f["_in_group"] == "contact-group-ref" for f in inner)
    # Top-level (non-grouped) fields don't carry _in_group.
    top = [f for f in flat if f["type"] == "multiple_choice"]
    assert all("_in_group" not in f for f in top)


def test_flatten_fields_handles_empty_and_none():
    assert _flatten_fields(None) == []
    assert _flatten_fields([]) == []


# ---------------------------------------------------------------------------
# parse_form_definition
# ---------------------------------------------------------------------------


def test_parse_form_definition_projects_top_level_columns():
    raw = _form_definition_fixture()
    row = parse_form_definition(raw)
    assert row["form_id"] == "PWSNd0h2"
    assert row["title"].startswith("US TF Funnel")
    assert row["last_updated_at"] == "2026-04-29T20:38:07Z"
    assert isinstance(row["fields"], list)
    assert isinstance(row["hidden_fields"], list)


def test_parse_form_definition_flattens_groups_in_fields_column():
    row = parse_form_definition(_form_definition_fixture())
    types = [f["type"] for f in row["fields"]]
    assert "group" not in types
    assert len(row["fields"]) == 5


def test_parse_form_definition_preserves_hidden_field_names():
    row = parse_form_definition(_form_definition_fixture())
    assert "utm_source" in row["hidden_fields"]
    assert "fbp" in row["hidden_fields"]
    assert "ip" in row["hidden_fields"]


def test_parse_form_definition_idempotent_re_running():
    raw = _form_definition_fixture()
    row1 = parse_form_definition(raw)
    row2 = parse_form_definition(raw)
    assert row1 == row2


def test_parse_form_definition_handles_missing_optional_fields():
    minimal = {"id": "abc123", "title": "X"}
    row = parse_form_definition(minimal)
    assert row["form_id"] == "abc123"
    assert row["fields"] == []
    assert row["hidden_fields"] == []
    assert row["last_updated_at"] is None


# ---------------------------------------------------------------------------
# parse_response
# ---------------------------------------------------------------------------


def test_parse_response_projects_top_level_columns():
    raw = _response_fixture()
    row = parse_response(raw, form_id="PWSNd0h2")
    assert row["response_id"] == "upjjv93lhtee22blkduwupjjv2814uzt"
    assert row["form_id"] == "PWSNd0h2"
    assert row["landed_at"] == "2026-05-21T13:52:27Z"
    assert row["submitted_at"] == "2026-05-21T13:54:04Z"


def test_parse_response_preserves_answers_shape():
    """Each answer keeps field.{ref,id,type} + type tag + value key.
    The dashboard / aggregation layer keys on field.ref."""
    row = parse_response(_response_fixture(), form_id="PWSNd0h2")
    answers = row["answers"]
    assert len(answers) == 5
    # Pick the email answer — verify shape.
    email_ans = next(a for a in answers if a.get("type") == "email")
    assert email_ans["field"]["ref"] == "ae611fb7-a858"
    assert email_ans["field"]["type"] == "email"
    assert email_ans["email"] == "<redacted-email>"
    # Pick the choice answer — verify nested choice payload preserved.
    choice_ans = next(a for a in answers if a.get("type") == "choice" and a["field"]["ref"] == "bd4e0524-e136-4590")
    assert choice_ans["choice"]["label"] == "Below $1,000"


def test_parse_response_preserves_hidden_attribution_payload():
    row = parse_response(_response_fixture(), form_id="PWSNd0h2")
    assert row["hidden"]["utm_source"] == "ig"
    assert row["hidden"]["utm_medium"] == "paid"
    assert "ip" in row["hidden"]


def test_parse_response_preserves_metadata_and_calculated():
    row = parse_response(_response_fixture(), form_id="PWSNd0h2")
    assert row["metadata"]["platform"] == "mobile"
    assert row["calculated"] == {"score": 0}


def test_parse_response_idempotent():
    raw = _response_fixture()
    row1 = parse_response(raw, form_id="PWSNd0h2")
    row2 = parse_response(raw, form_id="PWSNd0h2")
    assert row1 == row2


def test_parse_response_falls_back_to_token_when_response_id_missing():
    """Older API surfaces include only `token`, not `response_id`. The
    parser treats them as interchangeable."""
    raw = _response_fixture()
    raw.pop("response_id")
    row = parse_response(raw, form_id="PWSNd0h2")
    assert row["response_id"] == raw["token"]


def test_parse_response_extracts_form_id_from_webhook_envelope():
    """Webhook payload's `form_response` object carries `form_id`
    directly; the parser should pick that up without an explicit arg."""
    raw = {
        **_response_fixture(),
        "form_id": "PWSNd0h2",
    }
    row = parse_response(raw)  # no explicit form_id arg
    assert row["form_id"] == "PWSNd0h2"


def test_parse_response_extracts_form_id_from_definition_nested():
    """Some webhook payloads nest the form id under `definition.id`."""
    raw = _response_fixture()
    raw["definition"] = {"id": "PWSNd0h2"}
    row = parse_response(raw)
    assert row["form_id"] == "PWSNd0h2"


def test_parse_response_missing_response_id_returns_empty_string():
    """Defensive — the pipeline catches this and records an error."""
    raw = _response_fixture()
    raw.pop("response_id")
    raw.pop("token")
    row = parse_response(raw, form_id="PWSNd0h2")
    assert row["response_id"] == ""
