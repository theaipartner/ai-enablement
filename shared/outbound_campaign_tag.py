"""Auto-tag a Close lead into roster-based outbound campaigns (e.g. Jacob/ECJ).

On a new/updated lead, if its email or phone matches a campaign's roster
(`outbound_campaign_roster`) and it isn't already tagged, set that campaign's
Close custom field. Setting it in Close (not just the mirror) makes it durable —
the mirror's `custom_fields_raw` is overwritten on every re-sync, so a Close-side
tag is the source of truth. Close then re-mirrors it via its own lead.updated.

Idempotent (skips already-tagged leads, so no webhook loop) and fail-soft —
callers wrap it so a tagging error never breaks the webhook ack.
"""
import base64
import json
import os
import re
import urllib.request

from shared.db import get_client


def _norm_phone(p: str | None) -> str | None:
    d = re.sub(r"\D", "", p or "")
    if len(d) == 10:
        d = "1" + d
    return d[-11:] if len(d) >= 11 else None


def _set_close_cf(lead_id: str, cf_id: str) -> None:
    key = os.environ["CLOSE_API_KEY"]
    auth = base64.b64encode(f"{key}:".encode()).decode()
    body = json.dumps({f"custom.{cf_id}": "Yes"}).encode()
    req = urllib.request.Request(
        f"https://api.close.com/api/v1/lead/{lead_id}/",
        data=body, method="PUT",
        headers={"Authorization": f"Basic {auth}", "Content-Type": "application/json"},
    )
    urllib.request.urlopen(req, timeout=20)


def tag_lead_outbound_campaigns(lead_id: str) -> list[str]:
    """Tag `lead_id` into any roster-based outbound campaign it matches.

    Returns the list of campaign keys newly tagged (usually empty). The lead row
    must already be upserted into `close_leads` (the webhook does this first).
    """
    sb = get_client()
    lead = (
        sb.table("close_leads")
        .select("contacts, custom_fields_raw")
        .eq("close_id", lead_id)
        .limit(1)
        .execute()
        .data
    )
    if not lead:
        return []
    contacts = lead[0].get("contacts") or []
    cfr = lead[0].get("custom_fields_raw") or {}

    emails, phones = set(), set()
    for c in contacts:
        for em in c.get("emails") or []:
            v = (em.get("email") or "").strip().lower()
            if v:
                emails.add(v)
        for ph in c.get("phones") or []:
            n = _norm_phone(ph.get("phone"))
            if n:
                phones.add(n)
    if not emails and not phones:
        return []

    campaigns = (
        sb.table("outbound_campaigns")
        .select("key, close_cf_id")
        .eq("is_active", True)
        .execute()
        .data
    )
    tagged: list[str] = []
    for camp in campaigns:
        cf = camp["close_cf_id"]
        if cfr.get(cf):  # already tagged in this campaign
            continue
        matched = False
        if emails:
            r = (
                sb.table("outbound_campaign_roster").select("id")
                .eq("campaign_key", camp["key"]).in_("email", list(emails)).limit(1).execute()
            )
            matched = bool(r.data)
        if not matched and phones:
            r = (
                sb.table("outbound_campaign_roster").select("id")
                .eq("campaign_key", camp["key"]).in_("phone", list(phones)).limit(1).execute()
            )
            matched = bool(r.data)
        if matched:
            _set_close_cf(lead_id, cf)
            tagged.append(camp["key"])
    return tagged
