"""leads_parser: real API shapes (captured live 2026-07-10) → mirror rows."""

from ingestion.meta_ads.leads_parser import (
    parse_form,
    parse_lead,
    parse_leadgen_adset,
)

PAGE_ID = "627212320483048"
ACCOUNT_ID = "act_2293461684485411"

# Captured verbatim from GET /{page_id}/leadgen_forms on 2026-07-10.
FORM_ROW = {
    "id": "1053168367400164",
    "name": "7/8 - Basic Form",
    "status": "ACTIVE",
    "created_time": "2026-07-08T16:29:08+0000",
    "questions": [
        {
            "key": "full_name",
            "label": "Full name",
            "type": "FULL_NAME",
            "id": "1028104442919792",
        },
        {
            "key": "phone_number",
            "label": "Phone number",
            "type": "PHONE",
            "id": "1759976548346776",
        },
    ],
}

# Captured verbatim from GET /{form_id}/leads on 2026-07-10.
LEAD_ROW = {
    "id": "1224990839685018",
    "created_time": "2026-07-10T03:40:05+0000",
    "ad_id": "120249698637820748",
    "ad_name": "07/08 | Img1",
    "adset_id": "120249698637810748",
    "adset_name": "07/08 | Img1 | ABO - Copy 2",
    "campaign_id": "120249697320740748",
    "campaign_name": "07/08 | Test Batch 1 + Old Ads | LeadForm | Wix Funnel",
    "form_id": "1053168367400164",
    "is_organic": False,
    "platform": "fb",
    "field_data": [
        {"name": "phone_number", "values": ["+17086688748"]},
        {"name": "full_name", "values": ["Sharon McKinney"]},
    ],
}

# Captured verbatim from GET /act_<id>/adsets on 2026-07-10: one instant-form
# adset (the discriminator) and one old website-funnel adset.
LEADGEN_ADSET_ROW = {
    "id": "120249698637810748",
    "name": "07/08 | Img1 | ABO - Copy 2",
    "campaign_id": "120249697320740748",
    "campaign": {
        "id": "120249697320740748",
        "name": "07/08 | Test Batch 1 + Old Ads | LeadForm | Wix Funnel",
    },
    "destination_type": "ON_AD",
    "optimization_goal": "LEAD_GENERATION",
    "promoted_object": {"page_id": "627212320483048", "smart_pse_enabled": False},
}
WEBSITE_ADSET_ROW = {
    "id": "120248128714170748",
    "name": "Broad",
    "campaign_id": "120248128714030748",
    "campaign": {"id": "120248128714030748", "name": "6/13/26 | … | Closer Funnel"},
    "destination_type": "WEBSITE",
    "optimization_goal": "OFFSITE_CONVERSIONS",
}


def test_parse_form_maps_registry_row():
    row = parse_form(FORM_ROW, PAGE_ID)
    assert row["form_id"] == "1053168367400164"
    assert row["page_id"] == PAGE_ID
    assert row["name"] == "7/8 - Basic Form"
    assert row["status"] == "ACTIVE"
    assert row["form_created_time"] == "2026-07-08T16:29:08+0000"
    assert [q["key"] for q in row["questions"]] == ["full_name", "phone_number"]
    assert row["raw"] == FORM_ROW


def test_parse_lead_flattens_identity_and_keeps_attribution():
    row = parse_lead(LEAD_ROW, PAGE_ID)
    assert row["lead_id"] == "1224990839685018"
    assert row["form_id"] == "1053168367400164"
    assert row["created_time"] == "2026-07-10T03:40:05+0000"
    # Attribution ids join cortana_*_daily.platform_entity_id + close_leads.
    assert row["ad_id"] == "120249698637820748"
    assert row["adset_id"] == "120249698637810748"
    assert row["campaign_id"] == "120249697320740748"
    assert row["is_organic"] is False
    assert row["platform"] == "fb"
    # field_data flattened regardless of answer order.
    assert row["full_name"] == "Sharon McKinney"
    assert row["phone_number"] == "+17086688748"
    assert row["email"] is None  # the 7/8 Basic Form collects no email
    assert row["field_data"] == LEAD_ROW["field_data"]


def test_parse_lead_joins_split_name_fields():
    split = dict(
        LEAD_ROW,
        field_data=[
            {"name": "first_name", "values": ["Sharon"]},
            {"name": "last_name", "values": ["McKinney"]},
            {"name": "email", "values": ["s@example.com"]},
        ],
    )
    row = parse_lead(split, PAGE_ID)
    assert row["full_name"] == "Sharon McKinney"
    assert row["email"] == "s@example.com"


def test_parse_lead_tolerates_organic_lead_without_attribution():
    organic = dict(LEAD_ROW, is_organic=True)
    for key in (
        "ad_id",
        "ad_name",
        "adset_id",
        "adset_name",
        "campaign_id",
        "campaign_name",
    ):
        organic.pop(key)
    row = parse_lead(organic, PAGE_ID)
    assert row["is_organic"] is True
    assert row["campaign_id"] is None
    assert row["phone_number"] == "+17086688748"


def test_leadgen_adset_discriminator_accepts_instant_form():
    row = parse_leadgen_adset(LEADGEN_ADSET_ROW, ACCOUNT_ID)
    assert row is not None
    assert row["campaign_id"] == "120249697320740748"
    assert row["campaign_name"].endswith("LeadForm | Wix Funnel")
    assert row["account_id"] == ACCOUNT_ID
    assert row["page_id"] == PAGE_ID
    assert row["last_seen_at"]


def test_leadgen_adset_discriminator_rejects_website_funnel():
    assert parse_leadgen_adset(WEBSITE_ADSET_ROW, ACCOUNT_ID) is None


def test_leadgen_adset_discriminator_requires_both_signals():
    half = dict(LEADGEN_ADSET_ROW, destination_type="WEBSITE")
    assert parse_leadgen_adset(half, ACCOUNT_ID) is None
    other_half = dict(LEADGEN_ADSET_ROW, optimization_goal="OFFSITE_CONVERSIONS")
    assert parse_leadgen_adset(other_half, ACCOUNT_ID) is None
