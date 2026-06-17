"""Cortana attribution ingestion orchestrator.

Pull the Attribution API one ET calendar day at a time (the endpoint
has no working per-day `dailySummary`, so a single-day window is how we
get daily grain) across three groupings, and upsert into the three
mirror tables:

  groupBy=source   → meta_ad_daily        (the "Meta Ads" row only)
  groupBy=campaign → cortana_campaign_daily
  groupBy=medium   → cortana_adset_daily   (ad-set grain — see below)
  groupBy=ad       → cortana_ad_daily

The ad-set grain rides groupBy=medium: the Cortana API has no native
ad-set grouping, but Meta's URL template puts the ad-set name in
utm_medium and Cortana keys each medium row to the real Meta ad-set id
(`platformEntityId`). We keep only rows whose platformEntityId is a
numeric Meta id — that drops the organic / placement noise the medium
grouping also emits ("Bot Traffic", "calendly.com", "instagram_reels").

Idempotent: upsert on (day) for meta_ad_daily and (day, entity_key) for
the three cortana tables. Re-pulling a trailing window (the cron) just
overwrites — absorbing Meta's ~72h spend/conversion restatements.

Used by both the cron (`api/cortana_sync_cron.py`) and the backfill
script (`scripts/backfill_cortana.py`); same code path.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from ingestion.cortana.client import CORTANA_DT_FORMAT, CortanaAPIError, CortanaClient
from ingestion.cortana.parser import parse_entity, parse_meta_ad_daily

logger = logging.getLogger("ai_enablement.cortana.pipeline")

_ET = ZoneInfo("America/New_York")
_UTC = ZoneInfo("UTC")

# The source-grain row whose spend feeds meta_ad_daily. Case-insensitive.
_META_ADS_SOURCE = "meta ads"


@dataclass
class SyncOutcome:
    """Per-run summary; serialized into the cron audit row + HTTP response."""

    days_covered: list[str] = field(default_factory=list)
    meta_ad_daily_upserts: int = 0
    campaign_upserts: int = 0
    adset_upserts: int = 0
    ad_upserts: int = 0
    errors: list[str] = field(default_factory=list)


def et_day_window(day: date) -> tuple[str, str]:
    """UTC ISO (...Z) window that makes Cortana report `day`'s metrics.

    Cortana/Meta's daily attribution runs one ET calendar day *ahead* of
    the 24h window we send: a `[D 00:00, D+1 00:00)` ET window comes back
    carrying day **D+1**'s spend, not D's. Verified 2026-05-29 against
    known ground truth — the window `[05-27 00:00, 05-28 00:00) ET`
    returned 05-28's $745, and `[05-28 00:00, 05-29 00:00) ET` returned
    05-29's (today's) spend, not 05-27/05-28's.

    So to retrieve `day`, we send the window that *ends* at `day` 00:00
    ET (and starts the prior ET midnight). DST-aware via zoneinfo. The
    pipeline then labels the returned row `day`, and the stored date
    matches the real calendar day.
    """
    end_et = datetime(day.year, day.month, day.day, tzinfo=_ET)
    start_et = end_et - timedelta(days=1)
    return (
        start_et.astimezone(_UTC).strftime(CORTANA_DT_FORMAT),
        end_et.astimezone(_UTC).strftime(CORTANA_DT_FORMAT),
    )


def _et_days(start_day: date, end_day: date) -> list[date]:
    out: list[date] = []
    d = start_day
    while d <= end_day:
        out.append(d)
        d += timedelta(days=1)
    return out


def sync_cortana_range(
    db,
    client: CortanaClient,
    start_day: date,
    end_day: date,
) -> SyncOutcome:
    """Ingest [start_day, end_day] inclusive (ET calendar days)."""
    outcome = SyncOutcome()
    for day in _et_days(start_day, end_day):
        try:
            _sync_one_day(db, client, day, outcome)
            outcome.days_covered.append(day.isoformat())
        except CortanaAPIError as exc:
            outcome.errors.append(f"{day.isoformat()}: {exc}")
            logger.warning("cortana sync %s failed: %s", day, exc)
    if outcome.days_covered:
        logger.info(
            "cortana sync: days=%d meta=%d campaign=%d adset=%d ad=%d errors=%d",
            len(outcome.days_covered),
            outcome.meta_ad_daily_upserts,
            outcome.campaign_upserts,
            outcome.adset_upserts,
            outcome.ad_upserts,
            len(outcome.errors),
        )
    return outcome


def _is_real_entity_id(value) -> bool:
    """True when a Cortana platformEntityId is a numeric Meta id.

    The medium grouping mixes real ad sets (numeric Meta ad-set id) with
    organic / placement noise rows whose platformEntityId is null or a
    non-id label. Keep only the numeric ones — those are the ad sets.
    """
    return isinstance(value, str) and value.isdigit()


def _dedup_by_key(rows: list[dict]) -> list[dict]:
    """Drop rows with no entity_key and collapse duplicate keys (last wins).

    A batched upsert can't touch the same (day, entity_key) twice in one
    statement — Postgres errors on that — so dedupe defensively even
    though Cortana returning a duplicate dimensionKey in one window is
    unlikely.
    """
    by_key: dict[str, dict] = {}
    for r in rows:
        key = r.get("entity_key")
        if key:
            by_key[key] = r
    return list(by_key.values())


@dataclass
class DayRows:
    """Parsed rows for one ET day, pre-write (writer-agnostic)."""

    meta_ad_daily: dict | None
    campaign: list[dict]
    adset: list[dict]
    ad: list[dict]


def fetch_day_rows(client: CortanaClient, day: date) -> DayRows:
    """Pull + parse all four grains for one ET day. No DB I/O.

    Shared by both writers (supabase-client cron, psycopg2 backfill) so
    the fetch/parse logic lives in exactly one place.
    """
    iso = day.isoformat()
    start, end = et_day_window(day)

    source = client.attribution_data(start, end, group_by="source")
    meta_src = next(
        (
            r
            for r in source.get("data", [])
            if (r.get("dimension") or "").strip().lower() == _META_ADS_SOURCE
        ),
        None,
    )
    meta_row = parse_meta_ad_daily(meta_src, iso) if meta_src is not None else None

    campaign = client.attribution_data(start, end, group_by="campaign")
    camp_rows = _dedup_by_key(
        [parse_entity(r, iso, "campaign") for r in campaign.get("data", [])]
    )

    # Ad-set grain via medium — keep only rows with a numeric Meta ad-set id
    # (drops organic / placement noise the medium grouping also emits).
    medium = client.attribution_data(start, end, group_by="medium")
    adset_rows = _dedup_by_key(
        [
            parse_entity(r, iso, "adset")
            for r in medium.get("data", [])
            if _is_real_entity_id(r.get("platformEntityId"))
        ]
    )

    ad = client.attribution_data(start, end, group_by="ad")
    ad_rows = _dedup_by_key(
        [parse_entity(r, iso, "ad") for r in ad.get("data", [])]
    )
    return DayRows(
        meta_ad_daily=meta_row, campaign=camp_rows, adset=adset_rows, ad=ad_rows
    )


def _sync_one_day(db, client: CortanaClient, day: date, outcome: SyncOutcome) -> None:
    """Cron write path: supabase REST client, batched upserts per table."""
    rows = fetch_day_rows(client, day)
    if rows.meta_ad_daily is not None:
        db.table("meta_ad_daily").upsert(rows.meta_ad_daily, on_conflict="day").execute()
        outcome.meta_ad_daily_upserts += 1
    if rows.campaign:
        db.table("cortana_campaign_daily").upsert(
            rows.campaign, on_conflict="day,entity_key"
        ).execute()
        outcome.campaign_upserts += len(rows.campaign)
    if rows.adset:
        db.table("cortana_adset_daily").upsert(
            rows.adset, on_conflict="day,entity_key"
        ).execute()
        outcome.adset_upserts += len(rows.adset)
    if rows.ad:
        db.table("cortana_ad_daily").upsert(
            rows.ad, on_conflict="day,entity_key"
        ).execute()
        outcome.ad_upserts += len(rows.ad)
