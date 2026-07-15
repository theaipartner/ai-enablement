# meta_lead_forms

Registry of **Meta lead-gen (instant) forms** on our Facebook page(s). One
row per form.

## Purpose

Documents which forms exist, their status, and — via `questions` — exactly
what fields their leads carry (the "7/8 - Basic Form" collects `full_name` +
`phone_number` only, **no email**). The lead sync iterates this set: every
form on the page is mirrored, so a new form created by the ads team starts
ingesting automatically on the next 15-min tick.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `form_id` | `text` | PK. Meta leadgen form id. Joins `meta_form_leads.form_id`. |
| `page_id` | `text` | Owning Facebook page (The AI Partner = `627212320483048`). |
| `name` | `text` | e.g. `7/8 - Basic Form`. |
| `status` | `text` | `ACTIVE` / `ARCHIVED` / … |
| `form_created_time` | `timestamptz` | When the form was created on Meta. |
| `questions` | `jsonb` | Meta's question list `[{key,label,type,id}, …]`. |
| `raw` | `jsonb` | Full original API row. |
| `created_at` / `updated_at` | `timestamptz` | Row lifecycle (trigger-maintained). |

## Populated by / read by

- **Writes:** `ingestion/meta_ads/leads_pipeline.py` via
  `api/meta_leads_sync_cron.py` / `scripts/backfill_meta_leads.py`
  (upsert on `form_id`, from `GET /{page_id}/leadgen_forms`).
- **Reads:** the lead sync (form iteration); the DC Ads page's Forms
  dropdown (`getDcAdsHierarchy` pulls option labels from `name`); ad-hoc
  "what does this form collect" checks.

Runbook: `docs/runbooks/meta_leads_ingestion.md`.
