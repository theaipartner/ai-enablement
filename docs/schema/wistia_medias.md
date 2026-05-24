# wistia_medias

Reference table mirroring Wistia's media inventory + lifetime aggregate stats. Refreshed every cron tick from `/v1/medias.json` + `/v1/medias/{id}/stats.json`.

## Purpose

Source-of-truth for media metadata that the aggregation layer needs to derive Engine-sheet metrics. Specifically: `duration_seconds` is required for the engagement-rate derivation (`engagement = hours_watched × 3600 / (play_count × duration_seconds) × 100`), `name` and `project_name` are used by the aggregation layer to pick canonical VSL / TYP videos.

~80 rows in this org today. Discovery covered the inventory shape in `docs/reports/wistia-discovery.md`.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `hashed_id` | `text` | PK. Wistia's stable media id (e.g. `v736s9n4th`). |
| `name` | `text` | Display name as set in Wistia. |
| `duration_seconds` | `numeric` | Seconds as float. Required by engagement-rate derivation. |
| `project_id` | `text` | Stringified Wistia project id (Wistia returns int; we store text). |
| `project_name` | `text` | Resolved via the media's `project.name` first, then via `projects.json` lookup. |
| `media_type` | `text` | Wistia's `type` field — always `'Video'` in this org today. |
| `lifetime_page_loads` | `integer` | Lifetime cross-check value. |
| `lifetime_visitors` | `integer` | |
| `lifetime_plays` | `integer` | |
| `lifetime_percent_of_visitors_clicking_play` | `integer` | Lifetime % as int (e.g. 19 for 19%). |
| `lifetime_avg_percent_watched` | `integer` | Wistia's averagePercentWatched — INTEGER % (e.g. 25). Cross-check; aggregation derives per-day for precision. |
| `wistia_created_at` | `timestamptz` | When the media was created in Wistia. |
| `wistia_updated_at` | `timestamptz` | When Wistia last updated the media. |
| `synced_at` | `timestamptz` | When ingestion last touched this row. |
| `created_at` / `updated_at` | `timestamptz` | Standard. `updated_at` trigger via `set_updated_at()`. |

## Indexes

- PK on `hashed_id`.
- `wistia_medias_project_id_idx (project_id) WHERE project_id IS NOT NULL` — for project-scoped lookups.

## Idempotency

`UPSERT ON CONFLICT (hashed_id)`. Re-running the cron refreshes lifetime aggregates without duplicating rows.

## What populates it

- `ingestion.wistia.pipeline.sync_wistia()` — pulls inventory + per-media lifetime stats, upserts each.
- `api/wistia_sync_cron.py` every 3 hours via the rolling-window cron.
- `scripts/backfill_wistia.py --apply` for the initial full-history backfill.

## What reads from it

Future Gregory aggregation layer for the Engine sheet's FUNNELS section. Join on `hashed_id` against `wistia_media_daily` for engagement-rate + avg-view-duration derivations.

## Example queries

The two active VSL variants discovered in `docs/reports/wistia-discovery.md`:
```sql
SELECT hashed_id, name, duration_seconds, lifetime_plays
FROM wistia_medias
WHERE hashed_id IN ('i1173gx76b', 'nbump1crwb')
ORDER BY name;
```

All videos in the Confirmation Page Vids project:
```sql
SELECT hashed_id, name, duration_seconds, lifetime_plays
FROM wistia_medias
WHERE project_id = '10515824'
ORDER BY name;
```
