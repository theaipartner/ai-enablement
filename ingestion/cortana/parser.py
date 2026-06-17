"""Map Cortana attribution rows → typed mirror-table row dicts.

Three projections, one per grain:
  - `parse_meta_ad_daily(meta_ads_row, day)` → `meta_ad_daily` row
    (unchanged schema; feeds the live dashboard). CTR + frequency are
    now REAL Meta numbers, not the Sheet's broken/derived ones.
  - `parse_entity(row, day, grain)` → `cortana_ad_daily` /
    `cortana_campaign_daily` row.

Field names confirmed against the live API on 2026-05-29 (the OpenAPI
spec types rows as opaque objects, so these were read off real
responses — see docs/runbooks/cortana_ingestion.md § Field map).

Coercion rules:
  - counts → int, money/rates → float, else passthrough
  - missing / non-numeric → None (NULL); never crash a row
  - `frequency` derived = impressions / reach (Cortana returns it null
    at row grain); `cost_per_unique_link_click` derived = spent /
    uniqueInlineLinkClicks (Cortana's costPerUniqueInlineLinkClick is
    null) — preserves the `meta_ad_daily` column's original meaning.
"""

from __future__ import annotations

from typing import Any, Literal

Grain = Literal["ad", "campaign", "adset"]


def _num(v: Any) -> float | None:
    """Coerce to float or None. Tolerates strings, ints, None, junk."""
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _int(v: Any) -> int | None:
    """Coerce to int or None (rounds through float so '12.0' works)."""
    f = _num(v)
    return int(round(f)) if f is not None else None


def _derive_frequency(impressions: Any, reach: Any) -> float | None:
    imp, rch = _num(impressions), _num(reach)
    if imp is None or rch is None or rch == 0:
        return None
    return imp / rch


def _derive_cost_per_unique_link_click(spent: Any, ulc: Any) -> float | None:
    s, u = _num(spent), _num(ulc)
    if s is None or u is None or u == 0:
        return None
    return s / u


# ---------------------------------------------------------------------------
# meta_ad_daily — source-grain "Meta Ads" row → the existing dashboard table
# ---------------------------------------------------------------------------

def parse_meta_ad_daily(row: dict[str, Any], day: str) -> dict[str, Any]:
    """Project the source-grain Meta Ads row into a `meta_ad_daily` row.

    Column meanings preserved from the Sheet era so the dashboard's
    fetchers need no change. The only semantic upgrade: `ctr` is now
    Meta's real CTR (Cortana `ctr`), and `ctr_source_raw` records the
    provenance change rather than the old serial-0 bug.
    """
    return {
        "day": day,
        "amount_spent": _num(row.get("spent")),
        "impressions": _int(row.get("impressions")),
        "clicks_all": _int(row.get("clicks")),
        "link_clicks": _int(row.get("inlineLinkClicks")),
        "unique_link_clicks": _int(row.get("uniqueInlineLinkClicks")),
        "cpm": _num(row.get("cpm")),
        "cost_per_unique_link_click": _derive_cost_per_unique_link_click(
            row.get("spent"), row.get("uniqueInlineLinkClicks")
        ),
        "ctr": _num(row.get("ctr")),
        "frequency": _derive_frequency(row.get("impressions"), row.get("reach")),
        # Provenance marker — no longer the Sheet's broken serial-0 value.
        "ctr_source_raw": "cortana_attribution",
    }


# ---------------------------------------------------------------------------
# cortana_ad_daily / cortana_campaign_daily — full per-entity metric set
# ---------------------------------------------------------------------------

# Shared (Cortana field, column, coercer). Order = doc-readable grouping.
_SHARED_FIELDS: tuple[tuple[str, str, Any], ...] = (
    # identity / metadata
    ("platformEntityId", "platform_entity_id", str),
    ("entityId", "cortana_entity_id", str),
    ("platform", "platform", str),
    ("status", "status", str),
    ("effectiveStatus", "effective_status", str),
    ("campaignObjective", "campaign_objective", str),
    ("currency", "currency", str),
    # spend / delivery
    ("spent", "spent", _num),
    ("impressions", "impressions", _int),
    ("reach", "reach", _int),
    ("clicks", "clicks", _int),
    ("inlineLinkClicks", "inline_link_clicks", _int),
    ("uniqueClicks", "unique_clicks", _int),
    ("uniqueInlineLinkClicks", "unique_inline_link_clicks", _int),
    ("ctr", "ctr", _num),
    ("uniqueCtr", "unique_ctr", _num),
    ("cpm", "cpm", _num),
    ("costPerInlineLinkClick", "cost_per_inline_link_click", _num),
    ("costPerLead", "cost_per_lead", _num),
    ("costPerThruPlay", "cost_per_thru_play", _num),
    # traffic (ad-attributed LP visits)
    ("pageViews", "page_views", _int),
    ("uniqueVisitors", "unique_visitors", _int),
    # attributed funnel rollups
    ("leads", "leads", _int),
    ("metaPlatformLeads", "meta_platform_leads", _int),
    ("totalConversions", "total_conversions", _int),
    ("totalRevenue", "total_revenue", _num),
    ("totalLTV", "total_ltv", _num),
    ("averageOrderValue", "average_order_value", _num),
    ("costPerConversion", "cost_per_conversion", _num),
    ("roas", "roas", _num),
    ("roi", "roi", _num),
    # creative performance (Meta in-feed ad video, NOT the LP VSL/Wistia)
    ("videoPlays", "video_plays", _int),
    ("thruPlays", "thru_plays", _int),
    ("videoP25", "video_p25", _int),
    ("videoP50", "video_p50", _int),
    ("videoP75", "video_p75", _int),
    ("videoP100", "video_p100", _int),
    ("avgWatchTime", "avg_watch_time", _num),
    ("hookRate", "hook_rate", _num),
    ("holdRate", "hold_rate", _num),
    ("completionRate", "completion_rate", _num),
    ("likes", "likes", _int),
    ("comments", "comments", _int),
    ("shares", "shares", _int),
    ("saves", "saves", _int),
)

# Campaign-only (budget lives at campaign grain; ad rows carry null).
_CAMPAIGN_FIELDS: tuple[tuple[str, str, Any], ...] = (
    ("dailyBudget", "daily_budget", _num),
    ("lifetimeBudget", "lifetime_budget", _num),
    ("budgetSource", "budget_source", str),
)


def _coerce(fn: Any, v: Any) -> Any:
    if v is None:
        return None
    if fn is str:
        return str(v)
    return fn(v)


def parse_entity(row: dict[str, Any], day: str, grain: Grain) -> dict[str, Any]:
    """Project a campaign/ad attribution row into its mirror-table row.

    Stores the full original row under `raw` (jsonb) so every field —
    including ones we don't model as typed columns (rankings, creative-
    analysis tags, etc.) — is preserved per "ingest everything we can."
    """
    out: dict[str, Any] = {
        "day": day,
        "entity_key": row.get("dimensionKey") or row.get("dimension"),
        "entity_name": row.get("dimension"),
        "frequency": _derive_frequency(row.get("impressions"), row.get("reach")),
        "conversions": row.get("conversions") or {},
        "raw": row,
    }
    for src, col, fn in _SHARED_FIELDS:
        out[col] = _coerce(fn, row.get(src))
    if grain == "campaign":
        for src, col, fn in _CAMPAIGN_FIELDS:
            out[col] = _coerce(fn, row.get(src))
    return out
