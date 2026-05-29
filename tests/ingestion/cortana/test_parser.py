"""Unit tests for ingestion.cortana.parser.

Sample rows mirror the real API shape captured during discovery
(2026-05-29). Pure functions, no network.
"""

from __future__ import annotations

from ingestion.cortana.parser import parse_entity, parse_meta_ad_daily

# A representative source-grain "Meta Ads" row.
META_ADS_SOURCE_ROW = {
    "dimension": "Meta Ads",
    "spent": 335.92,
    "impressions": 4907,
    "reach": 4530,
    "clicks": 178,
    "inlineLinkClicks": 102,
    "uniqueInlineLinkClicks": 99,
    "cpm": 68.457,
    "ctr": 3.6274,
    "costPerInlineLinkClick": 3.29,
    "costPerUniqueInlineLinkClick": None,
}

# A representative ad-grain row (image ad — video fields null).
AD_ROW = {
    "dimension": "Ad Tracking Image (2)",
    "dimensionKey": "Ad Tracking Image (2)|||120244792397560748",
    "platformEntityId": "120244792397560748",
    "entityId": "21675684-f4ed-4f91-a0cf-3829f8facb38",
    "platform": "facebook",
    "status": "CAMPAIGN_PAUSED",
    "effectiveStatus": "CAMPAIGN_PAUSED",
    "campaignObjective": "OUTCOME_LEADS",
    "currency": "USD",
    "spent": 233.23,
    "impressions": 7000,
    "reach": 6500,
    "leads": 19,
    "pageViews": 200,
    "uniqueVisitors": 180,
    "videoPlays": None,
    "ctr": 3.1,
    "conversions": {
        "lead": {"count": 19, "uniqueCount": 19, "revenue": 0, "costPer": 12.3},
        "purchase": {"count": 1, "uniqueCount": 1, "revenue": 5000, "costPer": 233.0},
    },
}

CAMPAIGN_ROW = {
    "dimension": "5/17 | ANDROMEDA | Closer Funnel",
    "dimensionKey": "5/17 | ANDROMEDA | Closer Funnel|||120246145380050748",
    "platformEntityId": "120246145380050748",
    "spent": 199.47,
    "impressions": 3821,
    "reach": 3549,
    "dailyBudget": 378,
    "lifetimeBudget": None,
    "budgetSource": "own",
    "conversions": {"lead": {"count": 35}},
}


def test_meta_ad_daily_maps_and_derives():
    row = parse_meta_ad_daily(META_ADS_SOURCE_ROW, "2026-05-28")
    assert row["day"] == "2026-05-28"
    assert row["amount_spent"] == 335.92
    assert row["impressions"] == 4907
    assert row["link_clicks"] == 102
    assert row["unique_link_clicks"] == 99
    assert row["ctr"] == 3.6274  # real, not derived
    # frequency derived from impressions/reach
    assert abs(row["frequency"] - (4907 / 4530)) < 1e-9
    # cost_per_unique_link_click derived from spent/unique_link_clicks
    assert abs(row["cost_per_unique_link_click"] - (335.92 / 99)) < 1e-9
    assert row["ctr_source_raw"] == "cortana_attribution"


def test_meta_ad_daily_handles_zero_reach():
    row = parse_meta_ad_daily({"dimension": "Meta Ads", "spent": 0, "impressions": 0, "reach": 0}, "2026-05-29")
    assert row["frequency"] is None
    assert row["cost_per_unique_link_click"] is None


def test_parse_ad_entity():
    row = parse_entity(AD_ROW, "2026-05-27", "ad")
    assert row["day"] == "2026-05-27"
    assert row["entity_key"] == "Ad Tracking Image (2)|||120244792397560748"
    assert row["entity_name"] == "Ad Tracking Image (2)"
    assert row["platform_entity_id"] == "120244792397560748"
    assert row["leads"] == 19
    assert row["video_plays"] is None  # image ad
    assert row["page_views"] == 200
    # leads-by-ad lives in conversions jsonb
    assert row["conversions"]["lead"]["count"] == 19
    assert row["conversions"]["purchase"]["count"] == 1
    # full row preserved
    assert row["raw"] == AD_ROW
    # ad grain carries no budget columns
    assert "daily_budget" not in row


def test_parse_campaign_entity_has_budget():
    row = parse_entity(CAMPAIGN_ROW, "2026-05-28", "campaign")
    assert row["daily_budget"] == 378.0
    assert row["lifetime_budget"] is None
    assert row["budget_source"] == "own"
    assert row["entity_key"].endswith("|||120246145380050748")


def test_parse_entity_tolerates_missing_fields():
    # A near-empty row (e.g. organic/no-spend) must not raise.
    row = parse_entity({"dimension": "x", "dimensionKey": "x|||1"}, "2026-05-29", "ad")
    assert row["entity_key"] == "x|||1"
    assert row["spent"] is None
    assert row["conversions"] == {}
