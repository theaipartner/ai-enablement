# cortana_campaign_daily

Per-campaign daily mirror. One row per (ET calendar day, campaign).

> **Source changed 2026-06-30 — now the Meta Marketing API** (`level=campaign`
> of `/act_<id>/insights`) via `ingestion/meta_ads/`. Table name + columns
> unchanged. `platform_entity_id` = Meta `campaign_id`; `entity_name` = Meta
> `campaign_name` (the HT `Closer Funnel` token still matches). Budget fields
> (`daily_budget`/`lifetime_budget`) + the `conversions` blob are **not
> populated for new rows** (unused by the dashboard); historical Cortana rows
> keep theirs. Runbook: `docs/runbooks/meta_ads_ingestion.md`. *(Fed by Cortana
> `groupBy=campaign` 2026-05-29 → 2026-06-30.)*

## Purpose

Campaign-grain rollup of Meta spend, delivery, attributed funnel
conversions, and creative performance — plus campaign budget/status.
Same column set as `cortana_ad_daily` (see that doc for the full
column table) with **three campaign-only additions**:

| Column | Type | Notes |
|--------|------|-------|
| `daily_budget` | `numeric` | Campaign daily budget (Cortana `dailyBudget`). |
| `lifetime_budget` | `numeric` | Campaign lifetime budget. |
| `budget_source` | `text` | e.g. `own`. |

Identity columns: `entity_key` = Cortana `dimensionKey`
(`<campaign name>|||<metaId>`), `entity_name` = campaign name,
`platform_entity_id` = Meta campaign id (indexed, future join key).

Source: `ingestion/cortana/` → `api/cortana_sync_cron.py` +
`scripts/backfill_cortana.py`. Runbook:
`docs/runbooks/cortana_ingestion.md`. Migration:
`supabase/migrations/0057_cortana_ad_campaign_daily.sql`.

## Idempotency

`UPSERT ON CONFLICT (day, entity_key)`; trailing-window cron, Meta
restatements overwrite (last-write-wins).

## Example query

Spend + ROAS by campaign, this month:
```sql
SELECT entity_name, SUM(spent) AS spent,
       SUM((conversions->'all_payments'->>'revenue')::numeric) AS revenue
FROM cortana_campaign_daily
WHERE day >= date_trunc('month', current_date)
GROUP BY entity_name
ORDER BY spent DESC;
```
