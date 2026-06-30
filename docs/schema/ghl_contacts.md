# ghl_contacts

Mirror of GoHighLevel (GHL) contacts — the **lead** in the GHL outbound CRM. One
row per GHL contact. The GHL counterpart of `close_leads`. Added in migration
`0114`.

Populated by `ingestion/ghl/pipeline.py` (`sync_contacts`), run by
`api/ghl_sync_cron.py` + `scripts/backfill_ghl.py`. Read (later) by the re-sourced
`refresh_outbound_facts` GHL arm. Runbook: `docs/runbooks/ghl_ingestion.md`.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `id` | `text` | **PK.** GHL contact id. |
| `location_id` | `text` | Sub-account id. |
| `source` | `text` | Campaign membership today (`"DC Revival Lead"`). The campaign registry will key off this (and later `tags`). Indexed. |
| `first_name` / `last_name` / `contact_name` | `text` | Names. |
| `email` / `phone` | `text` | Contact channels (phone is the SMS/call target). |
| `tags` | `text[]` | GHL contact tags. Empty today (the long-term per-campaign tag will land here). GIN-indexed. |
| `assigned_to` | `text` | GHL user id. Rarely set on bulk-uploaded leads — **don't** use for rep attribution; use the call message's `user_id` instead. |
| `eoc_lead_id` | `text` | Airtable closer-form "Lead ID" parsed from the contact's **"EOC From"** custom field URL. In practice **equals `id`** (the form is prefilled with the contact id) → the closes join key: `airtable_full_closer_report.lead_id = ghl_contacts.id`. Indexed. |
| `date_added` | `timestamptz` | When the contact entered GHL. The campaign anchor / floor reads this. |
| `date_updated` | `timestamptz` | Last GHL update. |
| `custom_fields` | `jsonb` | Raw `[{id, value}]` array. |
| `raw` | `jsonb` | Full GHL contact object. |
| `synced_at` | `timestamptz` | Last upsert time (default `now()`). |

## Relationships

- `id` ← `ghl_conversations.contact_id`, `ghl_messages.contact_id`.
- `id` == `airtable_full_closer_report.lead_id` for GHL-sourced closes (via the
  EOC-From prefill). This is how closes/cash attribute to a GHL lead despite there
  being no `close_id`.

## Caveats

- **`source` is contaminated** for the launch batch: the SMS tool stamped older
  leads with `"DC Revival Lead"` too, so `source` alone doesn't isolate a specific
  campaign — a date floor (`date_added`) and/or a proper per-campaign tag is needed
  when the campaign is registered. See `project_outbound_ghl_migration` memory.

## Example queries

```sql
-- Leads in the launch batch (source + a date floor to dodge the contamination).
select count(*) from ghl_contacts
where source = 'DC Revival Lead' and date_added >= '2026-06-27';

-- Confirm eoc_lead_id == id (the closer-report join assumption).
select count(*) filter (where eoc_lead_id = id) as match, count(*) total
from ghl_contacts where eoc_lead_id is not null;
```
