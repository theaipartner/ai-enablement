"""Backfill Meta ad data into the mirror tables (meta_ad_daily + cortana_*).

Usage:
  # smoke: one complete day end-to-end against the REAL API, NO writes
  .venv/bin/python scripts/backfill_meta_ads.py --smoke

  # dry run: pull N days, report counts, NO writes (default 4 days)
  .venv/bin/python scripts/backfill_meta_ads.py --days 4

  # apply to CLOUD (production) — psycopg2 path
  .venv/bin/python scripts/backfill_meta_ads.py --days 4 --apply --cloud

Reads META_ACCESS_TOKEN + META_AD_ACCOUNT_ID (+ optional META_API_VERSION)
from .env.local (loaded by shared.db). Run --smoke first to prove the
real-API path before any bulk --apply (repo backfill discipline).

Note the source overlap: meta_sync_cron and the Cortana cron both write the
same four tables — do NOT run a Meta backfill while the Cortana cron is
still scheduled, or they'll fight over the same rows. See the runbook.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import quote
from zoneinfo import ZoneInfo

import psycopg2
from psycopg2.extras import Json, execute_values

from shared.db import get_client  # loads .env.local
from ingestion.meta_ads.client import MetaAdsClient
from ingestion.meta_ads.pipeline import (
    fetch_account_rows,
    fetch_entity_rows,
    sync_meta_range,
)

# jsonb columns need psycopg2 Json wrapping on direct-SQL writes.
_JSONB_COLS = {"conversions", "raw"}
_ENTITY_TABLES = (
    ("campaign", "cortana_campaign_daily"),
    ("adset", "cortana_adset_daily"),
    ("ad", "cortana_ad_daily"),
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
_ET = ZoneInfo("America/New_York")


def _client() -> MetaAdsClient:
    token = os.environ.get("META_ACCESS_TOKEN")
    account_id = os.environ.get("META_AD_ACCOUNT_ID")
    version = os.environ.get("META_API_VERSION") or "v23.0"
    if not token or not account_id:
        sys.exit("Missing META_ACCESS_TOKEN / META_AD_ACCOUNT_ID in env (.env.local)")
    return MetaAdsClient(token, account_id, api_version=version)


def _today_et():
    return datetime.now(_ET).date()


def _cloud_db():
    """Supabase client pointed at CLOUD (production) — same trick as
    backfill_cortana: .env.local SUPABASE_URL is pinned local."""
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
        sys.exit(
            "cloud SUPABASE_URL / SERVICE_ROLE_KEY not active in .env.local.cloud-backup"
        )
    os.environ["SUPABASE_URL"] = url
    os.environ["SUPABASE_SERVICE_ROLE_KEY"] = key
    get_client.cache_clear()
    return get_client()


# --- psycopg2 cloud writer (bypasses PostgREST HTTP/2 drops on repeated
#     local→cloud writes — same as backfill_cortana) -------------------


def _pg_conn():
    pooler = Path("supabase/.temp/pooler-url").read_text().strip()
    pw = os.environ.get("SUPABASE_DB_PASSWORD")
    if not pw:
        for ln in Path(".env.local").read_text().splitlines():
            if ln.startswith("SUPABASE_DB_PASSWORD="):
                pw = ln.partition("=")[2].strip().strip('"').strip("'")
    if not pw:
        sys.exit("SUPABASE_DB_PASSWORD not found for cloud psycopg2 write")
    at = pooler.index("@")
    dsn = f"{pooler[:at]}:{quote(pw, safe='')}{pooler[at:]}"
    return psycopg2.connect(dsn, connect_timeout=20)


def _pg_upsert(cur, table: str, rows: list[dict], conflict_cols: list[str]) -> int:
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
        [Json(r.get(c)) if c in _JSONB_COLS else r.get(c) for c in cols] for r in rows
    ]
    execute_values(cur, sql, values)
    return len(rows)


def run_cloud_pg(days: int) -> int:
    client = _client()
    end_day = _today_et()
    start_day = end_day - timedelta(days=days - 1)
    since, until = start_day.isoformat(), end_day.isoformat()
    print(f"Meta backfill (CLOUD/psycopg2): {start_day} .. {end_day} ({days} ET days)")
    conn = _pg_conn()
    conn.autocommit = False
    totals = {"meta": 0, "campaign": 0, "adset": 0, "ad": 0}
    try:
        with conn.cursor() as cur:
            account_rows = fetch_account_rows(client, since, until)
            totals["meta"] = _pg_upsert(cur, "meta_ad_daily", account_rows, ["day"])
            for grain, table in _ENTITY_TABLES:
                rows = fetch_entity_rows(client, grain, since, until)
                totals[grain] = _pg_upsert(cur, table, rows, ["day", "entity_key"])
        conn.commit()
    finally:
        conn.close()
    print(f"\nAPPLIED (cloud): {totals}")
    return 0


def smoke() -> int:
    """Pull yesterday (a complete ET day) across all grains; print; no write."""
    client = _client()
    day = (_today_et() - timedelta(days=1)).isoformat()
    print(f"SMOKE — Meta insights for {day}")

    account_rows = fetch_account_rows(client, day, day)
    print("\nmeta_ad_daily row:")
    print(
        json.dumps(account_rows[0], indent=1) if account_rows else "  (no account row)"
    )

    for grain, _table in _ENTITY_TABLES:
        rows = fetch_entity_rows(client, grain, day, day)
        print(f"\n{grain} rows: {len(rows)}")
        if rows:
            s = rows[0]
            print(
                f"  sample: {s['entity_name']!r} id={s['platform_entity_id']} spent={s['spent']} impr={s['impressions']}"
            )
    print("\nSMOKE OK — no rows written.")
    return 0


def run(days: int, apply: bool, cloud: bool) -> int:
    client = _client()
    end_day = _today_et()
    start_day = end_day - timedelta(days=days - 1)
    since, until = start_day.isoformat(), end_day.isoformat()
    print(
        f"Meta backfill: {start_day} .. {end_day} ({days} ET days) apply={apply} cloud={cloud}"
    )

    if not apply:
        account_rows = fetch_account_rows(client, since, until)
        totals = {"meta": len(account_rows)}
        for grain, _table in _ENTITY_TABLES:
            totals[grain] = len(fetch_entity_rows(client, grain, since, until))
        print(f"\nDRY RUN totals: {totals}.  Re-run with --apply to write.")
        return 0

    db = _cloud_db() if cloud else get_client()
    outcome = sync_meta_range(db, client, start_day, end_day)
    print(
        f"\nAPPLIED: meta_ad_daily={outcome.meta_ad_daily_upserts} "
        f"campaign={outcome.campaign_upserts} adset={outcome.adset_upserts} "
        f"ad={outcome.ad_upserts} errors={len(outcome.errors)}"
    )
    for e in outcome.errors:
        print(f"  ERROR {e}")
    return 1 if outcome.errors else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true", help="one complete day, no writes")
    ap.add_argument(
        "--days", type=int, default=4, help="trailing ET days incl today (default 4)"
    )
    ap.add_argument("--apply", action="store_true", help="write to DB (else dry run)")
    ap.add_argument(
        "--cloud",
        action="store_true",
        help="target cloud (production) instead of local",
    )
    args = ap.parse_args()
    if args.smoke:
        return smoke()
    if args.apply and args.cloud:
        return run_cloud_pg(args.days)
    return run(args.days, args.apply, args.cloud)


if __name__ == "__main__":
    sys.exit(main())
