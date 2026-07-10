"""Backfill Meta instant-form leads into the mirrors (migration 0122).

Usage:
  # smoke: ONE lead end-to-end against the REAL API + REAL DB (writes 1 row
  # per table, then reads it back) — run this before any bulk --apply
  .venv/bin/python scripts/backfill_meta_leads.py --smoke

  # apply: full pass — every form on the page, every lead Meta still retains
  # (~90 days), plus the adset scan and a facts refresh
  .venv/bin/python scripts/backfill_meta_leads.py --apply

Reads META_ACCESS_TOKEN + META_AD_ACCOUNT_ID + META_LEADGEN_PAGE_ID
(+ optional META_API_VERSION) from .env.local (loaded by shared.db).
Idempotent — safe to re-run; the 15-min cron overlaps harmlessly.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shared.db import get_client  # noqa: E402  (loads .env.local)
from ingestion.meta_ads.client import MetaAdsClient  # noqa: E402
from ingestion.meta_ads.leads_parser import parse_form, parse_lead  # noqa: E402
from ingestion.meta_ads.leads_pipeline import (  # noqa: E402
    fetch_leadgen_campaign_rows,
    sync_meta_leads,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")


def _env() -> tuple[MetaAdsClient, str, str]:
    token = os.environ.get("META_ACCESS_TOKEN")
    account_id = os.environ.get("META_AD_ACCOUNT_ID")
    page_id = os.environ.get("META_LEADGEN_PAGE_ID")
    version = os.environ.get("META_API_VERSION") or "v23.0"
    if not token or not account_id or not page_id:
        sys.exit(
            "Missing META_ACCESS_TOKEN / META_AD_ACCOUNT_ID / "
            "META_LEADGEN_PAGE_ID in env (.env.local)"
        )
    return MetaAdsClient(token, account_id, api_version=version), page_id, account_id


def smoke() -> None:
    """One record end-to-end: real API → parse → real DB upsert → readback."""
    client, page_id, account_id = _env()
    db = get_client()

    campaign_rows = fetch_leadgen_campaign_rows(client, account_id)
    print(f"adset scan: {len(campaign_rows)} leadgen campaign(s)")
    for row in campaign_rows:
        print(f"  {row['campaign_id']}  {row['campaign_name']}")
    if campaign_rows:
        db.table("meta_leadgen_campaigns").upsert(
            campaign_rows[:1], on_conflict="campaign_id"
        ).execute()

    page_token = client.page_access_token(page_id)
    forms = client.leadgen_forms(page_id, page_token)
    print(f"forms on page {page_id}: {len(forms)}")
    if not forms:
        sys.exit("no forms — nothing to smoke")
    form_row = parse_form(forms[0], page_id)
    db.table("meta_lead_forms").upsert([form_row], on_conflict="form_id").execute()
    print(f"form upserted: {form_row['form_id']} ({form_row['name']})")

    leads = client.form_leads(form_row["form_id"], page_token)
    print(f"leads retained by Meta for this form: {len(leads)}")
    if not leads:
        sys.exit("no leads — nothing to smoke")
    lead_row = parse_lead(leads[0], page_id)
    db.table("meta_form_leads").upsert([lead_row], on_conflict="lead_id").execute()

    back = (
        db.table("meta_form_leads")
        .select("lead_id,created_time,campaign_id,full_name,phone_number")
        .eq("lead_id", lead_row["lead_id"])
        .execute()
    )
    if not back.data:
        sys.exit("SMOKE FAILED: lead row did not read back")
    print(f"smoke OK — lead {back.data[0]['lead_id']} round-tripped: {back.data[0]}")


def apply_full() -> None:
    client, page_id, account_id = _env()
    db = get_client()
    outcome = sync_meta_leads(db, client, page_id, account_id, since_unix=None)
    print(
        f"apply done: campaigns={outcome.campaigns_upserted} "
        f"forms={outcome.forms_upserted} leads={outcome.leads_upserted} "
        f"facts_rows={outcome.facts_rows} errors={outcome.errors}"
    )
    if outcome.errors:
        sys.exit(1)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--smoke", action="store_true", help="one lead end-to-end")
    mode.add_argument("--apply", action="store_true", help="full backfill")
    args = ap.parse_args()
    if args.smoke:
        smoke()
    else:
        apply_full()


if __name__ == "__main__":
    main()
