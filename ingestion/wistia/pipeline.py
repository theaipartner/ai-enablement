"""Wistia ingestion orchestrator.

Pipeline:
  1. Refresh media inventory (`wistia_medias`) — paginate /v1/medias.json
     + project lookup + per-media lifetime stats. Idempotent on
     `hashed_id` PK.
  2. For each media: pull /modern/stats/medias/{id}/by_date over a
     window → idempotent upsert into `wistia_media_daily` keyed on
     `(hashed_id, day)`.

Fail-soft per media — one media's stats failing doesn't abort the
whole sync; errors collected in `SyncOutcome.errors` for the audit row.

Used by both the daily cron (`api/wistia_sync_cron.py`, rolling
14-day window) and any ad-hoc backfill (`scripts/backfill_wistia.py`,
wide window).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from ingestion.wistia.client import WistiaAPIError, WistiaClient
from ingestion.wistia.parser import parse_by_date_entry, parse_media

logger = logging.getLogger("ai_enablement.wistia.pipeline")


@dataclass
class SyncOutcome:
    """Per-tick summary; serialized into the cron's audit row."""

    medias_synced: int = 0
    medias_failed: int = 0
    daily_rows_upserted: int = 0
    daily_rows_failed: int = 0
    days_in_window: int = 0
    window: dict[str, str] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def record_error(self, where: str, err: Exception) -> None:
        self.errors.append(f"{where}: {err}")


def sync_wistia(
    client: WistiaClient,
    db,
    *,
    start_date: date,
    end_date: date,
    max_medias: int | None = None,
) -> SyncOutcome:
    """One full pull: refresh inventory, then per-day stats per media.

    `start_date` + `end_date` (inclusive, YYYY-MM-DD) bound the by_date
    window. Cron passes a rolling 14-day window; backfill passes a
    wide one.

    `max_medias` caps how many medias get the by_date treatment (for
    --smoke / --limit). None = all of them.
    """
    outcome = SyncOutcome(
        days_in_window=(end_date - start_date).days + 1,
        window={"start_date": start_date.isoformat(), "end_date": end_date.isoformat()},
    )

    # ---- 1. Project lookup (for project_name resolution on medias) ----
    project_name_by_id: dict[str, str] = {}
    try:
        for proj in client.iter_projects():
            pid = proj.get("id")
            if pid is None:
                continue
            project_name_by_id[str(pid)] = proj.get("name") or ""
    except WistiaAPIError as e:
        # Non-fatal — most media payloads carry project.name inline; the
        # lookup is a fallback. Log + continue.
        outcome.warnings.append(f"projects fetch failed: {e}")

    # ---- 2. Media inventory + lifetime stats ---------------------------
    medias_seen: list[dict[str, Any]] = []
    try:
        medias_seen = list(client.iter_medias())
    except WistiaAPIError as e:
        outcome.record_error("iter_medias", e)
        return outcome

    for media in medias_seen:
        hid = media.get("hashed_id")
        if not hid:
            outcome.medias_failed += 1
            outcome.warnings.append("media payload missing hashed_id — skipped")
            continue
        # Lifetime stats. Fail-soft per-media; if stats 404 we still
        # write the inventory row.
        try:
            stats_payload = client.fetch_lifetime_stats(hid)
        except WistiaAPIError as e:
            stats_payload = None
            outcome.warnings.append(f"lifetime_stats {hid}: {e}")
        row = parse_media(media, stats_payload, project_name_by_id)
        if not row:
            outcome.medias_failed += 1
            continue
        try:
            db.table("wistia_medias").upsert(
                row, on_conflict="hashed_id"
            ).execute()
            outcome.medias_synced += 1
        except Exception as e:
            outcome.medias_failed += 1
            outcome.record_error(f"upsert media {hid}", e)

    # ---- 3. Per-day stats per media ------------------------------------
    target_medias = [m for m in medias_seen if m.get("hashed_id")]
    if max_medias is not None:
        target_medias = target_medias[:max_medias]

    start_iso = start_date.isoformat()
    end_iso = end_date.isoformat()
    for media in target_medias:
        hid = media["hashed_id"]
        try:
            entries = client.fetch_by_date(
                hid, start_date=start_iso, end_date=end_iso
            )
        except WistiaAPIError as e:
            outcome.record_error(f"by_date {hid}", e)
            continue
        for entry in entries:
            row = parse_by_date_entry(hid, entry)
            if not row:
                continue
            try:
                db.table("wistia_media_daily").upsert(
                    row, on_conflict="hashed_id,day"
                ).execute()
                outcome.daily_rows_upserted += 1
            except Exception as e:
                outcome.daily_rows_failed += 1
                outcome.record_error(f"upsert daily {hid} {row.get('day')}", e)

    logger.info(
        "wistia sync: medias=%d/%d daily_upserted=%d daily_failed=%d window=%s..%s",
        outcome.medias_synced,
        outcome.medias_synced + outcome.medias_failed,
        outcome.daily_rows_upserted,
        outcome.daily_rows_failed,
        start_iso,
        end_iso,
    )
    return outcome


def sync_wistia_rolling(
    client: WistiaClient,
    db,
    *,
    window_days: int = 14,
    max_medias: int | None = None,
) -> SyncOutcome:
    """Convenience wrapper for the cron: rolling [today-N+1, today] window."""
    end = date.today()
    start = end - timedelta(days=window_days - 1)
    return sync_wistia(
        client, db, start_date=start, end_date=end, max_medias=max_medias,
    )
