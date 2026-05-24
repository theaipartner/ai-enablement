# wistia_media_daily

Per-day stats mirror from Wistia's `/modern/stats/medias/{hashed_id}/by_date` endpoint. One row per `(hashed_id, day)`.

## Purpose

Time-series source for the Engine sheet's four Wistia-sourced metrics. Stores raw volume metrics only (`load_count`, `play_count`, `hours_watched`) — engagement-rate + average-view-duration are DERIVED at aggregation time so the canonical-VSL-selection decision can live in the dashboard layer.

Per the discovery report, Wistia retains per-day history indefinitely with no documented `start_date` ceiling. The backfill loads from 2024-01-01 (~875 days as of 2026-05-24); the cron self-heals via a rolling 14-day window.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `hashed_id` | `text` | PK component. Loose ref to `wistia_medias.hashed_id` — no hard FK; aggregation layer left-joins. |
| `day` | `date` | PK component. Calendar day the stats are attributed to. |
| `load_count` | `integer` | NOT NULL default 0. Page-loads where this media's embed was present. |
| `play_count` | `integer` | NOT NULL default 0. Plays initiated this day. |
| `hours_watched` | `numeric` | NOT NULL default 0. **HOURS as float** (Wistia API quirk — e.g. `0.085` ≈ 5m6s). NOT seconds. Aggregation converts via `× 3600`. |
| `synced_at` | `timestamptz` | When ingestion last touched this row. |
| `created_at` / `updated_at` | `timestamptz` | Standard. `updated_at` trigger via `set_updated_at()`. |

## Indexes

- PK on `(hashed_id, day)` — covers per-media-per-day lookups and per-media DESC scans.
- `wistia_media_daily_day_idx (day DESC)` — covers cross-video daily rollups (e.g. "total VSL hours_watched on day X" summing across both active VSL variants).

## Why hours_watched stays in hours

Pre-converting to seconds in ingestion would silently double-multiply downstream when the aggregation layer applies its own `× 3600` based on Wistia's documented unit. Storing raw matches Wistia's convention exactly. Loudly documented in the column comment + the parser docstring.

## Derivations the aggregation layer does

| Engine metric | Formula |
|---|---|
| Engagement rate (per day, per media) | `(hours_watched × 3600) / (play_count × wistia_medias.duration_seconds) × 100`. NULL when `play_count = 0`. |
| Average view duration (per day, per media, seconds) | `(hours_watched × 3600) / play_count`. NULL when `play_count = 0`. |

When aggregating across multiple medias (e.g. the two active VSL variants), sum `hours_watched` and `play_count` separately, then divide — DO NOT average the per-media derivations. Wistia's `averagePercentWatched` on the lifetime endpoint is a sanity-check value for the all-time aggregate; matches when summed across the media's full history.

## Idempotency

`UPSERT ON CONFLICT (hashed_id, day)`. The cron pulls a rolling 14-day window every 3h, so the most-recent days get restated on every tick — last-write-wins is desired (newer pulls reflect Wistia's late-arriving event counts).

## What populates it

- `ingestion.wistia.pipeline.sync_wistia()` — per-media loop pulling by_date over a window.
- `api/wistia_sync_cron.py` every 3 hours (rolling 14-day window).
- `scripts/backfill_wistia.py --apply` for initial wide-window backfill.

## What reads from it

Future Gregory aggregation layer.

## Example queries

Per-day engagement rate for the two active VSL variants (combined), last 14 days:
```sql
SELECT
  d.day,
  SUM(d.hours_watched * 3600) / NULLIF(SUM(d.play_count) * m.duration_seconds, 0) * 100 AS engagement_rate_pct
FROM wistia_media_daily d
JOIN wistia_medias m USING (hashed_id)
WHERE d.hashed_id IN ('i1173gx76b', 'nbump1crwb')
  AND d.day >= current_date - interval '14 days'
GROUP BY d.day, m.duration_seconds
ORDER BY d.day DESC;
```

Avg view duration (in seconds) for the TYP video, this month:
```sql
SELECT
  day,
  (hours_watched * 3600.0) / NULLIF(play_count, 0) AS avg_view_seconds
FROM wistia_media_daily
WHERE hashed_id = 'fbgjxwe62y'
  AND day >= date_trunc('month', current_date)
ORDER BY day DESC;
```
