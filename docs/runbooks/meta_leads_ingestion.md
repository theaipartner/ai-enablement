# Runbook: Meta Lead-Form (Instant Form) Ingestion

Mirrors Meta lead-gen data — the **Digital College ads funnel** — into
Supabase. Since the full-program suspension (July 2026) the DC funnel is:
Meta ad → the person fills a **Meta instant form** (no landing page) → the
Meta→Close bridge creates/updates the Close lead within seconds → reps dial.

## What this ingestion does

One pass (`ingestion/meta_ads/leads_pipeline.py :: sync_meta_leads`):

1. **Adset scan** — `GET /act_<id>/adsets`, filter to the instant-form
   discriminator (`optimization_goal=LEAD_GENERATION` +
   `destination_type=ON_AD`; old website/Wix campaigns are
   `OFFSITE_CONVERSIONS`) → upsert **`meta_leadgen_campaigns`**. This table is
   THE ad-spend scoping set for the DC ads funnel page: spend rows in
   `cortana_campaign_daily` whose `platform_entity_id` is in it count as DC
   ads spend.
2. **Page token** — `GET /{page_id}?fields=access_token` with the user token.
   Lead reads are page-scoped; the page token is derived per run, never stored.
3. **Forms** — `GET /{page_id}/leadgen_forms` → upsert **`meta_lead_forms`**.
4. **Leads** — `GET /{form_id}/leads` per form (incremental via a
   `time_created GREATER_THAN` filter on the cron; full on backfill) → upsert
   **`meta_form_leads`**. Each lead carries `ad_id`/`adset_id`/`campaign_id`
   natively.
5. **Facts refresh** — `refresh_dc_ads_facts()` (migration 0123–0125) rebuilds
   `dc_ads_lead_facts` for the dashboard page.

## Schedule

- `api/meta_leads_sync_cron.py` — Vercel cron **every 15 min**
  (`vercel.json`), trailing 72h lead window. Audit rows:
  `webhook_deliveries` `source='meta_leads_sync'`.
- `api/outbound_facts_refresh_cron.py` (every 15 min) ALSO calls
  `refresh_dc_ads_facts()` so downstream stages (dials/bookings/closes from
  the Close + Airtable mirrors) stay fresh between lead syncs.

## Credentials (env vars)

`META_ACCESS_TOKEN` (user token — never-expiring since 2026-07-10; scopes
`ads_read`, `leads_retrieval`, `pages_show_list`, `pages_read_engagement`,
`pages_manage_ads`), `META_AD_ACCOUNT_ID`, `META_LEADGEN_PAGE_ID`
(The AI Partner = `627212320483048`), optional `META_API_VERSION`.
Local `.env.local` + Vercel Production. Token caveats (person-tied, rolling
data-access window): `meta_ads_ingestion.md` § warnings.

## ⚠ The 90-day retention clock

Meta only retains lead submissions ~**90 days** via the API. The mirror is
the durable copy. If the cron dies, fix it within that window or the oldest
opt-ins become unrecoverable (the backfill can only fetch what Meta still
has). The current form ("7/8 - Basic Form") collects **full_name +
phone_number only — no email**; phone is the identity key for these leads.

## Backfill

```bash
# one lead end-to-end (real API + real DB) — always run first
.venv/bin/python scripts/backfill_meta_leads.py --smoke
# everything Meta still retains, all forms, + facts refresh
.venv/bin/python scripts/backfill_meta_leads.py --apply
```

Idempotent (Meta-id upserts everywhere); safe alongside the cron.
First run 2026-07-10: 1 campaign, 1 form, 110 leads.

## Failure modes / debugging

- **`meta_leadgen_creds_missing` audit** — one of the three META_* env vars
  unset in Vercel.
- **Meta code 190 (`MetaAdsAuthError`)** — token revoked/expired → lead data
  freezes stale. See `meta_ads_ingestion.md` § token warnings.
- **Page-token step fails, adset scan succeeds** — pages permission problem
  (page removed from the Business, or token missing `pages_*` scopes);
  campaigns keep updating, leads stop.
- **Leads in Meta but missing in Close** — the Meta→Close bridge (not ours)
  broke; `meta_form_leads` keeps ingesting regardless. Compare
  `meta_form_leads` count vs `close_leads where funnel_name='Digital College'`
  — the DC ads page's opt-in count reads the Close-side facts, so a growing
  gap means the bridge needs fixing.
- **A new lead-form campaign shows no spend on the DC page** — check it
  appears in `meta_leadgen_campaigns` (adset scan runs every tick; the
  campaign must have at least one instant-form adset).

## Table docs

`docs/schema/meta_lead_forms.md` · `docs/schema/meta_form_leads.md` ·
`docs/schema/meta_leadgen_campaigns.md` · `docs/schema/dc_ads_lead_facts.md`
