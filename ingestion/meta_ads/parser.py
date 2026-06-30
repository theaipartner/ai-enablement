"""Map Meta Insights rows → the existing mirror-table row dicts.

Two projections, matching the tables the dashboard already reads:
  - `parse_meta_ad_daily(account_row)` → `meta_ad_daily` row.
  - `parse_entity(row, grain)` → `cortana_campaign_daily` /
    `cortana_adset_daily` / `cortana_ad_daily` row.

Column meanings are preserved from the Cortana era so NO dashboard consumer
changes. The day label is Meta's own `date_start` (the account-timezone
calendar day the metrics fall on).

Coercion: counts → int, money/rates → float, missing/junk → None (NULL);
never crash a row. Meta returns every numeric as a string ("779.45").
"""

from __future__ import annotations

from typing import Any, Literal

Grain = Literal["campaign", "adset", "ad"]


def _num(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _int(v: Any) -> int | None:
    f = _num(v)
    return int(round(f)) if f is not None else None


# ---------------------------------------------------------------------------
# meta_ad_daily — account grain → the existing dashboard table
# ---------------------------------------------------------------------------


def parse_meta_ad_daily(row: dict[str, Any]) -> dict[str, Any]:
    """Project an account-level insights row into a `meta_ad_daily` row.

    `ctr` maps to Meta's `inline_link_click_ctr` (the LINK click-through
    rate) to preserve the column's documented "real link CTR" meaning;
    `frequency` and `cost_per_unique_link_click` are now Meta-native (were
    derived under Cortana). `ctr_source_raw` records the new provenance.
    """
    return {
        "day": row.get("date_start"),
        "amount_spent": _num(row.get("spend")),
        "impressions": _int(row.get("impressions")),
        "clicks_all": _int(row.get("clicks")),
        "link_clicks": _int(row.get("inline_link_clicks")),
        "unique_link_clicks": _int(row.get("unique_inline_link_clicks")),
        "cpm": _num(row.get("cpm")),
        "cost_per_unique_link_click": _num(
            row.get("cost_per_unique_inline_link_click")
        ),
        "ctr": _num(row.get("inline_link_click_ctr")),
        "frequency": _num(row.get("frequency")),
        "ctr_source_raw": "meta_api",
    }


# ---------------------------------------------------------------------------
# cortana_{campaign,adset,ad}_daily — per-entity grain
# ---------------------------------------------------------------------------

# (Meta field, our column, coercer). Only the columns the dashboard reads
# plus the cheap delivery metrics; the attribution/creative/budget columns
# Meta doesn't supply at this shape are left NULL (they were unused).
_ENTITY_FIELDS: tuple[tuple[str, str, Any], ...] = (
    ("spend", "spent", _num),
    ("impressions", "impressions", _int),
    ("reach", "reach", _int),
    ("clicks", "clicks", _int),
    ("inline_link_clicks", "inline_link_clicks", _int),
    ("unique_clicks", "unique_clicks", _int),
    ("unique_inline_link_clicks", "unique_inline_link_clicks", _int),
    ("ctr", "ctr", _num),
    ("unique_ctr", "unique_ctr", _num),
    ("cpm", "cpm", _num),
    ("cost_per_inline_link_click", "cost_per_inline_link_click", _num),
)

# Per-grain (id field, name field) in the Meta row.
_GRAIN_IDS: dict[str, tuple[str, str]] = {
    "campaign": ("campaign_id", "campaign_name"),
    "adset": ("adset_id", "adset_name"),
    "ad": ("ad_id", "ad_name"),
}


def parse_entity(row: dict[str, Any], grain: Grain) -> dict[str, Any]:
    """Project a campaign/adset/ad insights row into its mirror-table row.

    `entity_key` keeps Cortana's `<name>|||<metaId>` shape so the
    (day, entity_key) PK stays stable across the source swap.
    `platform_entity_id` is Meta's own id (joins `close_leads.*`).
    `conversions` is {} and the attributed-rollup columns stay NULL — the
    dashboard derives funnel counts from Close, not from this blob.
    """
    id_field, name_field = _GRAIN_IDS[grain]
    meta_id = row.get(id_field)
    name = row.get(name_field)
    out: dict[str, Any] = {
        "day": row.get("date_start"),
        "entity_key": f"{name}|||{meta_id}",
        "entity_name": name,
        "platform_entity_id": str(meta_id) if meta_id is not None else None,
        "platform": "facebook",
        "frequency": _num(row.get("frequency")),
        "conversions": {},
        "raw": row,
    }
    for src, col, fn in _ENTITY_FIELDS:
        out[col] = fn(row.get(src))
    return out
