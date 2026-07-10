"""Meta leadgen (instant-form) ingestion orchestrator — the DC ads funnel.

One sync pass:
  1. Scan the ad account's adsets → upsert `meta_leadgen_campaigns` (the
     ad-spend scoping set for the DC ads funnel page).
  2. Derive the Page token from the user token (per run, never stored).
  3. Upsert the page's forms → `meta_lead_forms`.
  4. Per form, fetch submissions (incremental via `since_unix` on the cron;
     full on backfill) → upsert `meta_form_leads`.
  5. `refresh_dc_ads_facts()` so the funnel page reflects the new opt-ins.

Idempotent: every table upserts on its Meta id. ⚠ Meta retains leads ~90
days via the API — the mirror is the durable copy, so the cron must keep
running (see docs/runbooks/meta_leads_ingestion.md).

Used by both the cron (`api/meta_leads_sync_cron.py`) and the backfill
(`scripts/backfill_meta_leads.py`); same code path.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from ingestion.meta_ads.client import MetaAdsAPIError, MetaAdsClient
from ingestion.meta_ads.leads_parser import (
    parse_form,
    parse_lead,
    parse_leadgen_adset,
)

logger = logging.getLogger("ai_enablement.meta_ads.leads_pipeline")


@dataclass
class LeadsSyncOutcome:
    """Per-run summary; serialized into the cron audit row + HTTP response."""

    campaigns_upserted: int = 0
    forms_upserted: int = 0
    leads_upserted: int = 0
    facts_rows: int | None = None
    errors: list[str] = field(default_factory=list)


def _chunked(rows: list[dict], size: int = 500):
    for i in range(0, len(rows), size):
        yield rows[i : i + size]


def _dedup_by(rows: list[dict], key: str) -> list[dict]:
    """One row per key (last wins) — a batched upsert can't hit a key twice."""
    by_key = {r[key]: r for r in rows if r.get(key)}
    return list(by_key.values())


def fetch_leadgen_campaign_rows(client: MetaAdsClient, account_id: str) -> list[dict]:
    """Adset scan → deduped `meta_leadgen_campaigns` rows."""
    adsets = client.leadgen_adsets()
    rows = [parse_leadgen_adset(a, account_id) for a in adsets]
    return _dedup_by([r for r in rows if r], "campaign_id")


def sync_meta_leads(
    db,
    client: MetaAdsClient,
    page_id: str,
    account_id: str,
    *,
    since_unix: int | None = None,
) -> LeadsSyncOutcome:
    """One full leadgen sync pass (see module docstring for the steps).

    `since_unix=None` fetches every retained lead (backfill); the cron passes
    a trailing-window timestamp. A MetaAdsAuthError on the page-token step
    aborts lead ingestion (credentials problem); a single form failing is
    recorded and the rest still sync.
    """
    outcome = LeadsSyncOutcome()

    # 1. adset scan → campaign scoping set (user token; independent of leads)
    try:
        campaign_rows = fetch_leadgen_campaign_rows(client, account_id)
        for chunk in _chunked(campaign_rows):
            db.table("meta_leadgen_campaigns").upsert(
                chunk, on_conflict="campaign_id"
            ).execute()
        outcome.campaigns_upserted = len(campaign_rows)
    except MetaAdsAPIError as exc:
        outcome.errors.append(f"adset_scan: {exc}")
        logger.warning("meta leads sync: adset scan failed: %s", exc)

    # 2. page token — everything below needs it
    try:
        page_token = client.page_access_token(page_id)
    except MetaAdsAPIError as exc:
        outcome.errors.append(f"page_token: {exc}")
        logger.warning("meta leads sync: page token derivation failed: %s", exc)
        return outcome

    # 3. forms
    try:
        forms = client.leadgen_forms(page_id, page_token)
        form_rows = _dedup_by([parse_form(f, page_id) for f in forms], "form_id")
        for chunk in _chunked(form_rows):
            db.table("meta_lead_forms").upsert(chunk, on_conflict="form_id").execute()
        outcome.forms_upserted = len(form_rows)
    except MetaAdsAPIError as exc:
        outcome.errors.append(f"forms: {exc}")
        logger.warning("meta leads sync: forms fetch failed: %s", exc)
        return outcome

    # 4. leads per form
    for form_row in form_rows:
        form_id = form_row["form_id"]
        try:
            leads = client.form_leads(form_id, page_token, since_unix=since_unix)
            lead_rows = _dedup_by(
                [parse_lead(lead, page_id) for lead in leads], "lead_id"
            )
            for chunk in _chunked(lead_rows):
                db.table("meta_form_leads").upsert(
                    chunk, on_conflict="lead_id"
                ).execute()
            outcome.leads_upserted += len(lead_rows)
        except MetaAdsAPIError as exc:
            outcome.errors.append(f"leads[{form_id}]: {exc}")
            logger.warning("meta leads sync: form %s leads failed: %s", form_id, exc)

    # 5. facts refresh — the DC funnel page reads dc_ads_lead_facts
    try:
        result = db.rpc("refresh_dc_ads_facts", {}).execute()
        outcome.facts_rows = result.data
    except Exception as exc:  # noqa: BLE001 - refresh failure must not sink the sync
        outcome.errors.append(f"facts_refresh: {exc}")
        logger.warning("meta leads sync: refresh_dc_ads_facts failed: %s", exc)

    logger.info(
        "meta leads sync: campaigns=%d forms=%d leads=%d facts=%s errors=%d",
        outcome.campaigns_upserted,
        outcome.forms_upserted,
        outcome.leads_upserted,
        outcome.facts_rows,
        len(outcome.errors),
    )
    return outcome
