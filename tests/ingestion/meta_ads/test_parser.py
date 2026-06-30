"""Parser tests — sample rows are the real shapes read off the live Meta
Insights API on 2026-06-30 (account + campaign/adset/ad levels)."""

from __future__ import annotations

from ingestion.meta_ads.parser import parse_entity, parse_meta_ad_daily

# Real account-grain row (act_2293461684485411, 2026-06-12).
_ACCOUNT_ROW = {
    "date_start": "2026-06-12",
    "date_stop": "2026-06-12",
    "spend": "779.45",
    "impressions": "6610",
    "reach": "5397",
    "frequency": "1.224754",
    "clicks": "222",
    "inline_link_clicks": "131",
    "unique_clicks": "184",
    "unique_inline_link_clicks": "120",
    "cpm": "117.919818",
    "ctr": "3.358548",
    "inline_link_click_ctr": "1.981846",
    "unique_ctr": "3.409301",
    "cost_per_inline_link_click": "5.95",
    "cost_per_unique_inline_link_click": "6.495417",
}

# Real campaign-grain row (2026-06-15) — note the "Closer Funnel" token.
_CAMPAIGN_ROW = {
    "campaign_id": "120247773807770748",
    "campaign_name": "6/8/26 | ANDROMEDA | CBO | New Statics Batch | Influencers lyd AI | Booking | Closer Funnel",
    "spend": "329.17",
    "impressions": "3262",
    "reach": "2758",
    "inline_link_clicks": "89",
    "unique_clicks": "140",
    "unique_inline_link_clicks": "85",
    "date_start": "2026-06-15",
    "date_stop": "2026-06-15",
}

_ADSET_ROW = {
    "adset_id": "120247773808790748",
    "adset_name": "Influencers lyd AI",
    "campaign_id": "120247773807770748",
    "spend": "329.17",
    "impressions": "3262",
    "date_start": "2026-06-15",
    "date_stop": "2026-06-15",
}

_AD_ROW = {
    "ad_id": "120247773834370748",
    "ad_name": "6/5/26 - Creative 1_v1",
    "adset_id": "120247773808790748",
    "campaign_id": "120247773807770748",
    "spend": "122.43",
    "impressions": "900",
    "date_start": "2026-06-15",
    "date_stop": "2026-06-15",
}


def test_meta_ad_daily_maps_every_dashboard_column():
    row = parse_meta_ad_daily(_ACCOUNT_ROW)
    assert row["day"] == "2026-06-12"
    assert row["amount_spent"] == 779.45
    assert row["impressions"] == 6610
    assert row["clicks_all"] == 222
    assert row["link_clicks"] == 131
    assert row["unique_link_clicks"] == 120
    assert row["cpm"] == 117.919818
    # native now (was derived under Cortana)
    assert row["cost_per_unique_link_click"] == 6.495417
    assert row["frequency"] == 1.224754
    # ctr = LINK ctr (inline_link_click_ctr), preserving the column's meaning
    assert row["ctr"] == 1.981846
    assert row["ctr_source_raw"] == "meta_api"


def test_meta_ad_daily_types():
    row = parse_meta_ad_daily(_ACCOUNT_ROW)
    assert isinstance(row["impressions"], int)
    assert isinstance(row["amount_spent"], float)


def test_parse_entity_campaign():
    row = parse_entity(_CAMPAIGN_ROW, "campaign")
    assert row["day"] == "2026-06-15"
    assert row["platform_entity_id"] == "120247773807770748"
    assert row["entity_name"].endswith("Closer Funnel")
    assert row["entity_key"] == f"{_CAMPAIGN_ROW['campaign_name']}|||120247773807770748"
    assert row["platform"] == "facebook"
    assert row["spent"] == 329.17
    assert row["unique_clicks"] == 140
    # attribution blob empty + raw preserved (the source-swap contract)
    assert row["conversions"] == {}
    assert row["raw"] == _CAMPAIGN_ROW


def test_parse_entity_adset_uses_adset_fields():
    row = parse_entity(_ADSET_ROW, "adset")
    assert row["platform_entity_id"] == "120247773808790748"
    assert row["entity_name"] == "Influencers lyd AI"
    assert row["spent"] == 329.17


def test_parse_entity_ad_uses_ad_fields():
    row = parse_entity(_AD_ROW, "ad")
    assert row["platform_entity_id"] == "120247773834370748"
    assert row["entity_name"] == "6/5/26 - Creative 1_v1"
    assert row["spent"] == 122.43


def test_coercion_tolerates_missing_and_junk():
    row = parse_meta_ad_daily(
        {"date_start": "2026-06-12", "spend": "", "impressions": None, "cpm": "n/a"}
    )
    assert row["amount_spent"] is None
    assert row["impressions"] is None
    assert row["cpm"] is None
