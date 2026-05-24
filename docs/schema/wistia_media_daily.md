# wistia_media_daily

Per-day stats mirror. **Post-2026-05-24 cutover (migration 0046)** the source is `/modern/analytics/medias/{hashed_id}/timeseries?granularity=daily` — the legacy `/modern/stats/medias/{id}/by_date` synthesized a fake `hours_watched` (= `play_count × per-media constant`) which produced flat daily engagement / view-duration. The new endpoint returns real per-day variance. See `docs/reports/wistia-watchtime-verify.md` for the proof.

Two distinct column groups coexist in this table by design:

- **Post-cutover columns** (from timeseries) — `played_time_seconds`, `engagement_rate`, `play_rate`, `plays_filtered`, `unique_plays`, `unique_visitors`, `unique_loads`, CTA + form fields. Real per-day variance. **Aggregation should use these.**
- **Pre-cutover legacy columns** (from by_date) — `load_count`, `play_count`, `hours_watched`. DEPRECATED. The post-cutover pipeline does NOT refresh these. Pre-cutover row values are preserved as historical audit; post-cutover rows have the column defaults (zeros). **Do NOT use for daily engagement / watch-time derivation.**

One row per `(hashed_id, day)`; idempotent upsert.

## Columns

### Post-cutover (current source — use these)

| Column | Type | Notes |
|---|---|---|
| `hashed_id` | `text` | PK component. Loose ref to `wistia_medias.hashed_id`. |
| `day` | `date` | PK component. Calendar day (Wistia bucket-start timestamp's date portion; account-local-tz). |
| `played_time_seconds` | `integer` | Real per-day watch time, SECONDS. Replaces the deprecated `hours_watched`. |
| `engagement_rate` | `numeric(6,4)` | Real per-day engagement, **0–1 float** (e.g. `0.1473` for 14.73%). Stored RAW — display layer formats. |
| `play_rate` | `numeric(6,4)` | `plays / unique_loads`, 0–1 float. Stored raw. |
| `plays_filtered` | `integer` | Bot-filtered plays from the timeseries endpoint. Distinct from legacy `play_count`; ~14% lower per the verification report. |
| `unique_plays` | `integer` | |
| `unique_visitors` | `integer` | |
| `unique_loads` | `integer` | |
| `cta_impressions` | `integer` | |
| `cta_conversions` | `integer` | |
| `cta_conversion_rate` | `numeric(6,4)` | 0–1 float. Stored raw. |
| `form_conversions` | `integer` | |
| `synced_at` | `timestamptz` | When ingestion last touched this row. |
| `created_at` / `updated_at` | `timestamptz` | Standard. `updated_at` trigger via `set_updated_at()`. |

### Legacy (deprecated, NOT refreshed)

| Column | Type | Notes |
|---|---|---|
| `load_count` | `integer` | DEPRECATED. From legacy by_date. Pre-cutover values preserved; new rows have default 0. Use `unique_loads` (timeseries-sourced, bot-filtered). |
| `play_count` | `integer` | DEPRECATED. Raw plays from legacy by_date. ~14% higher than timeseries `plays_filtered` (bot/dedup difference). New rows have default 0. Use `plays_filtered`. |
| `hours_watched` | `numeric` | DEPRECATED. Was play_count × per-media constant (synthesized from lifetime average); NOT a true daily metric. Use `played_time_seconds`. |

## Indexes

- PK on `(hashed_id, day)` — per-media-per-day lookups + per-media DESC scans.
- `wistia_media_daily_day_idx (day DESC)` — cross-video daily rollups.

## Derivations the aggregation layer does

| Engine metric | Formula (post-cutover) |
|---|---|
| Engagement rate (per day, per media) | `engagement_rate` direct field. NO derivation needed — Wistia returns this real per-day. |
| Average view duration (per day, per media, seconds) | `played_time_seconds / plays_filtered`. NULL when `plays_filtered = 0`. |
| Total watch time (cross-video, per day) | SUM `played_time_seconds` across the canonical VSL/TYP hashed_ids. |

When aggregating across multiple medias (e.g. the two active VSL variants), compute volume-weighted averages: `SUM(played_time_seconds) / SUM(plays_filtered)` for cross-media avg-view-duration; for engagement-rate, the math is `SUM(played_time_seconds) / SUM(plays_filtered × duration_seconds)` — but in practice using `AVG(engagement_rate)` weighted by `plays_filtered` is close enough and simpler.

## Idempotency

`UPSERT ON CONFLICT (hashed_id, day)`. The cron pulls a rolling 14-day window every 3h. Post-cutover upserts touch only the post-cutover columns; legacy columns on already-existing rows are preserved.

## What populates it

- `ingestion.wistia.pipeline.sync_wistia()` — per-media loop pulling timeseries over a window.
- `api/wistia_sync_cron.py` every 3 hours (`30 */3 * * *`, rolling 14-day window).
- `scripts/backfill_wistia.py --apply` for backfill (post-cutover default is 30-day window).

## Date semantics gotcha

The new `/timeseries` endpoint uses **end_date EXCLUSIVE** (vs the legacy by_date which was inclusive on both). Callers pass an inclusive end_date through `ingestion.wistia.client.fetch_timeseries`, which adds +1 day internally before hitting the endpoint. Don't bypass that wrapper or you'll silently drop the latest day.

## Example queries

Engagement rate + view duration for both active VSL variants, last 14 days:
```sql
SELECT
  day,
  hashed_id,
  engagement_rate,
  (played_time_seconds::numeric / NULLIF(plays_filtered, 0)) AS avg_view_seconds,
  plays_filtered
FROM wistia_media_daily
WHERE hashed_id IN ('i1173gx76b', 'nbump1crwb')
  AND day >= current_date - interval '14 days'
ORDER BY day DESC, hashed_id;
```

Cross-VSL aggregate (combined Direct Closer Funnel + v2), last 7 days:
```sql
SELECT
  day,
  SUM(plays_filtered)        AS total_plays,
  SUM(played_time_seconds)   AS total_played_seconds,
  SUM(played_time_seconds)::numeric / NULLIF(SUM(plays_filtered), 0) AS avg_view_seconds
FROM wistia_media_daily
WHERE hashed_id IN ('i1173gx76b', 'nbump1crwb')
  AND day >= current_date - interval '7 days'
GROUP BY day
ORDER BY day DESC;
```

TYP video, current month:
```sql
SELECT day, plays_filtered, played_time_seconds, engagement_rate
FROM wistia_media_daily
WHERE hashed_id = 'fbgjxwe62y'
  AND day >= date_trunc('month', current_date)
ORDER BY day DESC;
```
