"""Map Meta leadgen (instant-form) API rows → mirror-table row dicts.

Three projections, one per table (see migration 0122):
  - `parse_form(row, page_id)`        → `meta_lead_forms` row
  - `parse_lead(row, page_id)`        → `meta_form_leads` row
  - `parse_leadgen_adset(row, account_id)` → `meta_leadgen_campaigns` row,
    or None when the adset is NOT an instant-form adset.

The instant-form discriminator (verified live 2026-07-10): leadgen adsets have
optimization_goal=LEAD_GENERATION + destination_type=ON_AD; the old
website/Wix-funnel campaigns are OFFSITE_CONVERSIONS + WEBSITE/UNDEFINED.

Lead `field_data` arrives as [{"name": "full_name", "values": ["…"]}, …]; the
known identity keys are flattened to columns, the raw list is preserved.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def _first_value(field_data: list[dict[str, Any]], name: str) -> str | None:
    for item in field_data:
        if item.get("name") == name:
            values = item.get("values") or []
            if values and str(values[0]).strip():
                return str(values[0]).strip()
    return None


def parse_form(row: dict[str, Any], page_id: str) -> dict[str, Any]:
    """Project a /leadgen_forms row into a `meta_lead_forms` row."""
    return {
        "form_id": str(row.get("id")),
        "page_id": page_id,
        "name": row.get("name"),
        "status": row.get("status"),
        "form_created_time": row.get("created_time"),
        "questions": row.get("questions") or [],
        "raw": row,
    }


def parse_lead(row: dict[str, Any], page_id: str) -> dict[str, Any]:
    """Project a /{form_id}/leads row into a `meta_form_leads` row.

    `full_name` falls back to "first_name last_name" for forms that split the
    name; the current 7/8 Basic Form uses full_name + phone_number only.
    """
    field_data = row.get("field_data") or []
    full_name = _first_value(field_data, "full_name")
    if not full_name:
        parts = [
            _first_value(field_data, "first_name"),
            _first_value(field_data, "last_name"),
        ]
        joined = " ".join(p for p in parts if p)
        full_name = joined or None
    return {
        "lead_id": str(row.get("id")),
        "form_id": str(row.get("form_id")) if row.get("form_id") else None,
        "page_id": page_id,
        "created_time": row.get("created_time"),
        "ad_id": row.get("ad_id"),
        "ad_name": row.get("ad_name"),
        "adset_id": row.get("adset_id"),
        "adset_name": row.get("adset_name"),
        "campaign_id": row.get("campaign_id"),
        "campaign_name": row.get("campaign_name"),
        "is_organic": bool(row.get("is_organic", False)),
        "platform": row.get("platform"),
        "full_name": full_name,
        "phone_number": _first_value(field_data, "phone_number"),
        "email": _first_value(field_data, "email"),
        "field_data": field_data,
        "raw": row,
    }


def parse_leadgen_adset(row: dict[str, Any], account_id: str) -> dict[str, Any] | None:
    """Project an /adsets row into a `meta_leadgen_campaigns` row.

    Returns None unless the adset matches the instant-form discriminator.
    The pipeline dedupes by campaign_id (many adsets → one campaign).
    """
    if row.get("optimization_goal") != "LEAD_GENERATION":
        return None
    if row.get("destination_type") != "ON_AD":
        return None
    campaign_id = row.get("campaign_id")
    if not campaign_id:
        return None
    campaign = row.get("campaign") or {}
    promoted = row.get("promoted_object") or {}
    return {
        "campaign_id": str(campaign_id),
        "campaign_name": campaign.get("name"),
        "account_id": account_id,
        "page_id": str(promoted["page_id"]) if promoted.get("page_id") else None,
        "last_seen_at": datetime.now(timezone.utc).isoformat(),
    }
