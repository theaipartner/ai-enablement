"""Meta ad ingestion orchestrator.

Pull the Insights endpoint once per level over a date window (Meta returns
one row per day per entity via `time_increment=1` — no per-day fan-out like
Cortana needed) and upsert into the four mirror tables:

  level=account  → meta_ad_daily          (PK day)
  level=campaign → cortana_campaign_daily  (PK day, entity_key)
  level=adset    → cortana_adset_daily     (PK day, entity_key)
  level=ad       → cortana_ad_daily        (PK day, entity_key)

Idempotent: upsert on (day) / (day, entity_key). The cron re-pulls a
trailing window each tick; Meta's ~72h restatements just overwrite
(last-write-wins) — same contract the Cortana pipeline had.

Each grain is fetched + written independently so one grain failing (e.g. a
transient throttle on the ad level) doesn't lose the others. Used by both
the cron (`api/meta_sync_cron.py`) and the backfill
(`scripts/backfill_meta_ads.py`); same code path.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date

from ingestion.meta_ads.client import MetaAdsAPIError, MetaAdsClient
from ingestion.meta_ads.parser import parse_entity, parse_meta_ad_daily

logger = logging.getLogger("ai_enablement.meta_ads.pipeline")

# (grain, table, the Cortana-named mirror it writes).
_ENTITY_GRAINS: tuple[tuple[str, str], ...] = (
    ("campaign", "cortana_campaign_daily"),
    ("adset", "cortana_adset_daily"),
    ("ad", "cortana_ad_daily"),
)


@dataclass
class SyncOutcome:
    """Per-run summary; serialized into the cron audit row + HTTP response."""

    meta_ad_daily_upserts: int = 0
    campaign_upserts: int = 0
    adset_upserts: int = 0
    ad_upserts: int = 0
    errors: list[str] = field(default_factory=list)


def _dedup_entity_rows(rows: list[dict]) -> list[dict]:
    """Collapse to one row per (day, entity_key); drop rows missing either.

    A batched upsert can't touch the same (day, entity_key) twice in one
    statement, so dedupe defensively (last wins).
    """
    by_key: dict[tuple[str, str], dict] = {}
    for r in rows:
        day, key, pid = r.get("day"), r.get("entity_key"), r.get("platform_entity_id")
        if day and key and pid:  # require a real Meta id
            by_key[(day, key)] = r
    return list(by_key.values())


def fetch_account_rows(client: MetaAdsClient, since: str, until: str) -> list[dict]:
    """Account-grain → meta_ad_daily rows (one per day with data)."""
    rows = client.insights("account", since, until)
    return [parse_meta_ad_daily(r) for r in rows if r.get("date_start")]


def fetch_entity_rows(
    client: MetaAdsClient, grain: str, since: str, until: str
) -> list[dict]:
    """Campaign/adset/ad grain → deduped mirror rows for the window."""
    rows = client.insights(grain, since, until)
    return _dedup_entity_rows([parse_entity(r, grain) for r in rows])  # type: ignore[arg-type]


def _chunked(rows: list[dict], size: int = 500):
    for i in range(0, len(rows), size):
        yield rows[i : i + size]


def sync_meta_range(
    db,
    client: MetaAdsClient,
    start_day: date,
    end_day: date,
) -> SyncOutcome:
    """Ingest [start_day, end_day] inclusive. Cron write path (supabase client).

    Per-grain try/except: a failure on one grain is recorded and the rest
    still write. A MetaAdsAuthError (expired token) propagates from the
    first call and aborts the run — that is a credentials problem the cron
    surfaces loudly, not a per-grain blip.
    """
    since, until = start_day.isoformat(), end_day.isoformat()
    outcome = SyncOutcome()

    # account → meta_ad_daily
    try:
        account_rows = fetch_account_rows(client, since, until)
        for chunk in _chunked(account_rows):
            db.table("meta_ad_daily").upsert(chunk, on_conflict="day").execute()
        outcome.meta_ad_daily_upserts = len(account_rows)
    except MetaAdsAPIError as exc:
        outcome.errors.append(f"account: {exc}")
        logger.warning("meta sync account grain failed: %s", exc)

    # campaign / adset / ad → cortana_* mirrors
    for grain, table in _ENTITY_GRAINS:
        try:
            rows = fetch_entity_rows(client, grain, since, until)
            for chunk in _chunked(rows):
                db.table(table).upsert(chunk, on_conflict="day,entity_key").execute()
            setattr(outcome, f"{grain}_upserts", len(rows))
        except MetaAdsAPIError as exc:
            outcome.errors.append(f"{grain}: {exc}")
            logger.warning("meta sync %s grain failed: %s", grain, exc)

    logger.info(
        "meta sync [%s..%s]: meta=%d campaign=%d adset=%d ad=%d errors=%d",
        since,
        until,
        outcome.meta_ad_daily_upserts,
        outcome.campaign_upserts,
        outcome.adset_upserts,
        outcome.ad_upserts,
        len(outcome.errors),
    )
    return outcome
