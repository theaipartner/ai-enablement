# meta_leadgen_campaigns

Which Meta campaigns are **lead-form (instant form) campaigns** — the
ad-spend scoping set for the DC ads funnel page.

## Purpose

The spend mirrors (`cortana_campaign_daily` etc.) cover the whole ad account,
past and present. The DC ads funnel page must count only lead-form-campaign
spend. Detection (verified live 2026-07-10): a campaign is leadgen iff it has
an adset with `optimization_goal=LEAD_GENERATION` **and**
`destination_type=ON_AD` — the old website/Wix booking campaigns are
`OFFSITE_CONVERSIONS` + `WEBSITE`/`UNDEFINED`. The adset scan runs every sync
tick, so a newly launched lead-form campaign scopes itself in automatically.

Rows are never deleted (a paused/archived campaign's historical spend must
stay scoped); `last_seen_at` shows whether the latest scan still saw it.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `campaign_id` | `text` | PK. Meta campaign id. Joins `cortana_campaign_daily.platform_entity_id`, `close_leads.campaign_id`, `meta_form_leads.campaign_id`. |
| `campaign_name` | `text` | e.g. `07/08 \| Test Batch 1 + Old Ads \| LeadForm \| Wix Funnel`. |
| `account_id` | `text` | Ad account (`act_…`). |
| `page_id` | `text` | Page from the adset's `promoted_object`. |
| `first_seen_at` | `timestamptz` | First scan that detected it. |
| `last_seen_at` | `timestamptz` | Most recent scan that still saw it. |
| `created_at` / `updated_at` | `timestamptz` | Row lifecycle (trigger-maintained). |

## Populated by / read by

- **Writes:** adset scan in `ingestion/meta_ads/leads_pipeline.py`
  (upsert on `campaign_id`).
- **Reads:** `refresh_dc_ads_facts()` (lead membership scoping), the DC ads
  page's spend query (`cortana_campaign_daily` filtered to these ids).

## Example queries

```sql
-- DC ads spend per day
select day, sum(spent) as spend
from cortana_campaign_daily
where platform_entity_id in (select campaign_id from meta_leadgen_campaigns)
group by day order by day desc;
```

Runbook: `docs/runbooks/meta_leads_ingestion.md`.
