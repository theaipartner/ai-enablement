# cortana_adset_daily

Per-ad-set daily mirror of the Cortana Attribution API, sourced from
`groupBy=medium`. One row per (ET calendar day, ad set). Migration
`0089_cortana_adset_daily.sql`.

## Purpose

Gives the funnel cascade's **Ad Set** level a name and spend — closing the
documented "ad-set gap" (`docs/sales/data-model.md` § cascade). The Ad Set
dropdown shows "Broad" / "Influencers lyd AI" instead of a bare numeric id, and
the funnel's spend/ROAS line works when an ad set is the active filter.

**Why `groupBy=medium`:** the Cortana API has no native ad-set grouping (its
enum is `source|campaign|medium|ad`) and the per-ad rows carry no parent ad-set
reference. But Meta's URL template populates `utm_medium` with the ad-set name,
and Cortana keys each `medium` row to the real Meta ad-set id via
`platformEntityId`. Verified 2026-06-17: that id matches `close_leads.adset_id`
on 21/22 cohort ad sets (the miss is a junk `{{adset.id}}` unfilled-macro row),
and per-ad-set `spent` partitions total spend to the cent against the campaign +
ad feeds. Ingestion keeps only rows with a numeric `platformEntityId`, dropping
the organic / placement noise the medium grouping also emits ("Bot Traffic",
"calendly.com", "instagram_reels", "no referrer").

Source: `ingestion/cortana/` (`groupBy=medium`) → `api/cortana_sync_cron.py`
(3-hour cron) + `scripts/backfill_cortana.py`. Runbook:
`docs/runbooks/cortana_ingestion.md`.

## Key columns

Same shape as `cortana_ad_daily` (no campaign-budget fields).

| Column | Type | Notes |
|--------|------|-------|
| `day` | `date` | ET calendar day. PK with `entity_key`. |
| `entity_key` | `text` | Cortana `dimensionKey` (`<name>\|\|\|<metaId>`). PK. |
| `entity_name` | `text` | Ad-set name (`utm_medium`, Cortana `dimension`) — e.g. `Broad`. |
| `platform_entity_id` | `text` | Meta ad-set id. **Joins `close_leads.adset_id`** / `lead_cycles`. Indexed. |
| `cortana_entity_id` | `text` | Cortana's internal uuid for the ad set. |
| `spent`, `impressions`, `reach`, `frequency`, `clicks`, … `cpm`, `cost_per_*` | numeric/int | Spend + delivery. `frequency` DERIVED `impressions/reach`. |
| `page_views`, `unique_visitors` | `integer` | Ad-set-attributed landing-page visits. |
| `leads`, `total_conversions`, `total_revenue`, `roas`, `roi`, … | numeric/int | Attributed funnel rollups. |
| `conversions` | `jsonb` | Per-event-type: `{event_type: {count,uniqueCount,revenue,costPer}}`. |
| `raw` | `jsonb` | Full original API row — every field preserved. |
| `created_at` / `updated_at` | `timestamptz` | `updated_at` via `set_updated_at` trigger. |

## Read by

- `lib/db/cortana-adset-names.ts` (`getAdsetNameMap`) → the cascade Ad Set
  dropdown (`components/sales/ad-cascade-filter.tsx`).
- `lib/db/leads-funnel.ts` → per-ad-set spend / ROAS when an ad set is the
  active funnel filter.

## Idempotency

`UPSERT ON CONFLICT (day, entity_key)`. The cron re-pulls a trailing window;
Meta's ~72h restatements overwrite (last-write-wins).

## Example query

Ad-set spend + attributed leads, last 7 days:
```sql
SELECT entity_name, platform_entity_id,
       SUM(spent) AS spent,
       SUM((conversions->'lead'->>'count')::int) AS leads
FROM cortana_adset_daily
WHERE day >= current_date - 7
GROUP BY entity_name, platform_entity_id
ORDER BY spent DESC NULLS LAST;
```
