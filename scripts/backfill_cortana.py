"""Backfill Cortana attribution data into the mirror tables.

Usage:
  # smoke: one complete day end-to-end against the REAL API, NO writes
  .venv/bin/python scripts/backfill_cortana.py --smoke

  # dry run: pull N days, report counts, NO writes (default 3 days)
  .venv/bin/python scripts/backfill_cortana.py --days 3

  # apply: upsert into meta_ad_daily + cortana_{campaign,ad}_daily
  .venv/bin/python scripts/backfill_cortana.py --days 3 --apply

Reads CORTANA_API_KEY + CORTANA_BUSINESS_ID from .env.local (loaded by
shared.db). Per the repo's backfill discipline: run --smoke first to
prove the real-API path before any bulk --apply.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from pathlib import Path

from urllib.parse import quote

import psycopg2
from psycopg2.extras import Json, execute_values

from shared.db import get_client  # loads .env.local
from ingestion.cortana.client import CortanaClient
from ingestion.cortana.parser import parse_entity, parse_meta_ad_daily
from ingestion.cortana.pipeline import (
    et_day_window,
    fetch_day_rows,
    sync_cortana_range,
)

# jsonb columns need psycopg2 Json wrapping on direct-SQL writes.
_JSONB_COLS = {"conversions", "raw"}

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
_ET = ZoneInfo("America/New_York")


def _cloud_db():
    """Build a Supabase client pointed at CLOUD (production).

    `.env.local` SUPABASE_URL is pinned to local for offline dev; the
    live cloud creds live (uncommented) in `.env.local.cloud-backup`
    (project sjjovsjcfffrftnraocu). The cron writes cloud automatically
    in Vercel; this is only for the manual backfill from a local shell.
    """
    backup = Path(".env.local.cloud-backup")
    if not backup.exists():
        sys.exit(".env.local.cloud-backup not found — can't target cloud")
    creds: dict[str, str] = {}
    for ln in backup.read_text().splitlines():
        s = ln.strip()
        if s.startswith("#") or "=" not in s:
            continue
        k, _, v = s.partition("=")
        creds[k.strip()] = v.strip().strip('"').strip("'")
    url = creds.get("SUPABASE_URL")
    key = creds.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key or "127.0.0.1" in url:
        sys.exit("cloud SUPABASE_URL / SERVICE_ROLE_KEY not active in .env.local.cloud-backup")
    os.environ["SUPABASE_URL"] = url
    os.environ["SUPABASE_SERVICE_ROLE_KEY"] = key
    get_client.cache_clear()
    return get_client()


def _client() -> CortanaClient:
    api_key = os.environ.get("CORTANA_API_KEY")
    business_id = os.environ.get("CORTANA_BUSINESS_ID")
    if not api_key or not business_id:
        sys.exit("Missing CORTANA_API_KEY / CORTANA_BUSINESS_ID in env (.env.local)")
    return CortanaClient(api_key, business_id)


def _today_et() -> "datetime.date":
    return datetime.now(_ET).date()


# --- psycopg2 cloud writer (bypasses PostgREST HTTP/2, which drops on
#     repeated local→cloud writes — see MARCH_ANALYSIS_HANDOFF) ---------

def _pg_conn():
    """Direct Postgres connection to the linked CLOUD project."""
    pooler = Path("supabase/.temp/pooler-url").read_text().strip()
    pw = os.environ.get("SUPABASE_DB_PASSWORD")
    if not pw:
        # SUPABASE_DB_PASSWORD lives in .env.local (cloud db password).
        for ln in Path(".env.local").read_text().splitlines():
            if ln.startswith("SUPABASE_DB_PASSWORD="):
                pw = ln.partition("=")[2].strip().strip('"').strip("'")
    if not pw:
        sys.exit("SUPABASE_DB_PASSWORD not found for cloud psycopg2 write")
    at = pooler.index("@")
    dsn = f"{pooler[:at]}:{quote(pw, safe='')}{pooler[at:]}"
    return psycopg2.connect(dsn, connect_timeout=20)


def _pg_upsert(cur, table: str, rows: list[dict], conflict_cols: list[str]) -> int:
    """Batch upsert rows via execute_values. Rows share one column set."""
    if not rows:
        return 0
    cols = list(rows[0].keys())
    update_cols = [c for c in cols if c not in conflict_cols]
    set_clause = ", ".join(f"{c}=EXCLUDED.{c}" for c in update_cols)
    sql = (
        f"INSERT INTO {table} ({', '.join(cols)}) VALUES %s "
        f"ON CONFLICT ({', '.join(conflict_cols)}) DO UPDATE SET {set_clause}"
    )
    values = [
        [Json(r.get(c)) if c in _JSONB_COLS else r.get(c) for c in cols]
        for r in rows
    ]
    execute_values(cur, sql, values)
    return len(rows)


def run_cloud_pg(days: int) -> int:
    """Cloud backfill via direct Postgres. Fetch/parse via the shared
    pipeline helper, write via psycopg2."""
    client = _client()
    end_day = _today_et()
    start_day = end_day - timedelta(days=days - 1)
    print(f"Cortana backfill (CLOUD/psycopg2): {start_day} .. {end_day} ({days} ET days)")
    conn = _pg_conn()
    conn.autocommit = False
    totals = {"meta": 0, "campaign": 0, "ad": 0}
    try:
        with conn.cursor() as cur:
            d = start_day
            while d <= end_day:
                rows = fetch_day_rows(client, d)
                if rows.meta_ad_daily is not None:
                    totals["meta"] += _pg_upsert(cur, "meta_ad_daily", [rows.meta_ad_daily], ["day"])
                totals["campaign"] += _pg_upsert(cur, "cortana_campaign_daily", rows.campaign, ["day", "entity_key"])
                totals["ad"] += _pg_upsert(cur, "cortana_ad_daily", rows.ad, ["day", "entity_key"])
                print(f"  {d}: meta={1 if rows.meta_ad_daily else 0} campaign={len(rows.campaign)} ad={len(rows.ad)}")
                d += timedelta(days=1)
        conn.commit()
    finally:
        conn.close()
    print(f"\nAPPLIED (cloud): {totals}")
    return 0


def smoke() -> int:
    """Pull yesterday (a complete ET day) across all 3 grains; print; no write."""
    client = _client()
    day = _today_et() - timedelta(days=1)
    start, end = et_day_window(day)
    print(f"SMOKE — ET day {day} window {start}..{end}")

    source = client.attribution_data(start, end, group_by="source")
    meta_row = next(
        (r for r in source.get("data", []) if (r.get("dimension") or "").lower() == "meta ads"),
        None,
    )
    print("\nmeta_ad_daily row:")
    print(json.dumps(parse_meta_ad_daily(meta_row, day.isoformat()), indent=1) if meta_row else "  (no Meta Ads source row)")

    campaign = client.attribution_data(start, end, group_by="campaign")
    crows = campaign.get("data", [])
    ad = client.attribution_data(start, end, group_by="ad")
    arows = ad.get("data", [])
    print(f"\ncampaign rows: {len(crows)}  ad rows: {len(arows)}")
    if crows:
        sample = parse_entity(crows[0], day.isoformat(), "campaign")
        print(f"  sample campaign: {sample['entity_name']!r} spent={sample['spent']} leads={sample['leads']} conv_keys={list(sample['conversions'])}")
    if arows:
        sample = parse_entity(arows[0], day.isoformat(), "ad")
        print(f"  sample ad: {sample['entity_name']!r} spent={sample['spent']} leads={sample['leads']} conv_keys={list(sample['conversions'])}")
    print("\nSMOKE OK — no rows written.")
    return 0


def run(days: int, apply: bool, cloud: bool) -> int:
    client = _client()
    end_day = _today_et()
    start_day = end_day - timedelta(days=days - 1)
    print(f"Cortana backfill: {start_day} .. {end_day} ({days} ET days) apply={apply} cloud={cloud}")

    if not apply:
        # Dry run: pull + count, no DB.
        d = start_day
        totals = {"meta": 0, "campaign": 0, "ad": 0}
        while d <= end_day:
            start, end = et_day_window(d)
            src = client.attribution_data(start, end, group_by="source")
            has_meta = any((r.get("dimension") or "").lower() == "meta ads" for r in src.get("data", []))
            crows = client.attribution_data(start, end, group_by="campaign").get("data", [])
            arows = client.attribution_data(start, end, group_by="ad").get("data", [])
            totals["meta"] += 1 if has_meta else 0
            totals["campaign"] += len(crows)
            totals["ad"] += len(arows)
            print(f"  {d}: meta_ad_daily={'yes' if has_meta else 'no'} campaign={len(crows)} ad={len(arows)}")
            d += timedelta(days=1)
        print(f"\nDRY RUN totals: {totals}.  Re-run with --apply to write.")
        return 0

    db = _cloud_db() if cloud else get_client()
    outcome = sync_cortana_range(db, client, start_day, end_day)
    print(
        f"\nAPPLIED: days={len(outcome.days_covered)} "
        f"meta_ad_daily={outcome.meta_ad_daily_upserts} "
        f"campaign={outcome.campaign_upserts} ad={outcome.ad_upserts} "
        f"errors={len(outcome.errors)}"
    )
    for e in outcome.errors:
        print(f"  ERROR {e}")
    return 1 if outcome.errors else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true", help="one complete day, no writes")
    ap.add_argument("--days", type=int, default=3, help="trailing ET days incl today (default 3)")
    ap.add_argument("--apply", action="store_true", help="write to DB (else dry run)")
    ap.add_argument("--cloud", action="store_true", help="target cloud (production) instead of local")
    args = ap.parse_args()
    if args.smoke:
        return smoke()
    if args.apply and args.cloud:
        return run_cloud_pg(args.days)
    return run(args.days, args.apply, args.cloud)


if __name__ == "__main__":
    sys.exit(main())
