# cortana_campaign_daily

Per-campaign daily mirror of the Cortana Attribution API
(`groupBy=campaign`). One row per (ET calendar day, campaign).

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
