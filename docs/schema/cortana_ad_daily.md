# cortana_ad_daily

Per-ad daily mirror of the Cortana Attribution API (`groupBy=ad`). One
row per (ET calendar day, ad).

## Purpose

Powers per-ad attribution — **leads / qualified leads / bookings /
closes by ad** — plus Meta in-feed creative performance. The
attributed conversion counts are net-new data: which *ad* drove each
funnel outcome, a join we have nowhere else (Typeform/Calendly/Close
hold the raw records, not the ad attribution).

Source: `ingestion/cortana/` → `api/cortana_sync_cron.py` (3-hour cron,
trailing 4-day window) + `scripts/backfill_cortana.py`. Runbook:
`docs/runbooks/cortana_ingestion.md`.

## Key columns

| Column | Type | Notes |
|--------|------|-------|
| `day` | `date` | ET calendar day. PK with `entity_key`. |
| `entity_key` | `text` | Cortana `dimensionKey` (`<name>\|\|\|<metaId>`). PK. |
| `entity_name` | `text` | Ad name / creative asset id (Cortana `dimension`). |
| `platform_entity_id` | `text` | Meta ad id — future join to Close `campaign_id`/ad. Indexed. |
| `cortana_entity_id` | `text` | Cortana's internal uuid for the ad. |
| `platform` / `status` / `effective_status` / `campaign_objective` / `currency` | `text` | Metadata. |
| `spent`, `impressions`, `reach`, `frequency`, `clicks`, `inline_link_clicks`, `unique_clicks`, `unique_inline_link_clicks`, `ctr`, `unique_ctr`, `cpm`, `cost_per_inline_link_click`, `cost_per_lead`, `cost_per_thru_play` | numeric/int | Spend + delivery. `frequency` DERIVED `impressions/reach`. |
| `page_views`, `unique_visitors` | `integer` | Ad-attributed landing-page visits. |
| `leads`, `meta_platform_leads`, `total_conversions`, `total_revenue`, `total_ltv`, `average_order_value`, `cost_per_conversion`, `roas`, `roi` | numeric/int | Attributed funnel rollups. |
| `video_plays`, `thru_plays`, `video_p25/50/75/100`, `avg_watch_time`, `hook_rate`, `hold_rate`, `completion_rate`, `likes`, `comments`, `shares`, `saves` | numeric/int | Meta **in-feed ad-creative** video/engagement — NOT the LP VSL (Wistia). NULL for image ads. |
| `conversions` | `jsonb` | Per-event-type: `{event_type: {count,uniqueCount,revenue,costPer}}`. **Leads-by-ad** = `conversions->'lead'->>'count'`. |
| `raw` | `jsonb` | Full original API row — every field preserved, incl. unmodeled ones (rankings, creative-analysis tags). |
| `created_at` / `updated_at` | `timestamptz` | `updated_at` via `set_updated_at` trigger. |

## Idempotency

`UPSERT ON CONFLICT (day, entity_key)`. The cron re-pulls a trailing
4-day window; Meta's ~72h restatements overwrite (last-write-wins).

## Example queries

Top ads by attributed leads, last 7 days:
```sql
SELECT entity_name,
       SUM(spent) AS spent,
       SUM((conversions->'lead'->>'count')::int) AS leads,
       SUM((conversions->'purchase'->>'count')::int) AS closes
FROM cortana_ad_daily
WHERE day >= current_date - 7
GROUP BY entity_name
ORDER BY leads DESC NULLS LAST;
```
