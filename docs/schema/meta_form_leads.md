# meta_form_leads

One row per **Meta lead-form (instant form) submission** — the opt-in event
of the Digital College ads funnel. Durable mirror: Meta only retains leads
~90 days via the API.

## Purpose

The DC funnel (since the July-2026 full-program suspension) is Meta ad →
instant form → rep dials. This table is the source-of-truth record of those
opt-ins, independent of the Meta→Close bridge that mirrors them into
`close_leads` (within seconds, stamping `funnel_name='Digital College'` +
the same attribution ids). If the bridge breaks, this table keeps growing —
a widening count gap vs Close-side DC leads is the bridge-health signal.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `lead_id` | `text` | PK. Meta leadgen id — stable across refetches. |
| `form_id` | `text` | Joins `meta_lead_forms.form_id`. |
| `page_id` | `text` | Facebook page the form lives on. |
| `created_time` | `timestamptz` | Form-submit time (UTC) — THE opt-in timestamp. |
| `ad_id` / `ad_name` | `text` | Meta ad. `ad_id` joins `cortana_ad_daily.platform_entity_id`, `close_leads.ad_id`. |
| `adset_id` / `adset_name` | `text` | Meta adset; joins likewise. |
| `campaign_id` / `campaign_name` | `text` | Meta campaign; joins `cortana_campaign_daily.platform_entity_id`, `close_leads.campaign_id`, `meta_leadgen_campaigns`. |
| `is_organic` | `boolean` | True = form filled without an ad click (no attribution ids). |
| `platform` | `text` | `fb` / `ig`. |
| `full_name` | `text` | Flattened from `field_data` (falls back to first+last). |
| `phone_number` | `text` | E.164 as Meta returns it. **The identity key — the current form collects no email.** |
| `email` | `text` | Null today; populated if a future form collects it. |
| `field_data` | `jsonb` | Raw answer list `[{name, values}, …]`. |
| `raw` | `jsonb` | Full original API row. |
| `created_at` / `updated_at` | `timestamptz` | Row lifecycle (trigger-maintained). |

Indexes: `created_time desc`, `form_id`, `campaign_id`, `phone_number`.

## Populated by / read by

- **Writes:** `ingestion/meta_ads/leads_pipeline.py` via
  `api/meta_leads_sync_cron.py` (15-min cron, trailing 72h) and
  `scripts/backfill_meta_leads.py`. Upsert on `lead_id`.
- **Reads:** the DC ads funnel page (`/sales-dashboard/dc-ads`) for the
  Meta-side opt-in count / bridge-drift check; ad-hoc attribution queries.
  The page's funnel stages read `dc_ads_lead_facts` (Close-side), not this
  table.

## Example queries

```sql
-- Opt-ins per day per ad
select created_time::date as day, ad_name, count(*)
from meta_form_leads group by 1, 2 order by 1 desc, 3 desc;

-- Bridge drift: Meta opt-ins vs Close mirrors
select
  (select count(*) from meta_form_leads where not is_organic) as meta_side,
  (select count(*) from close_leads
    where funnel_name = 'Digital College'
      and campaign_id in (select campaign_id from meta_leadgen_campaigns)
      and excluded_at is null) as close_side;
```

Runbook: `docs/runbooks/meta_leads_ingestion.md`.
