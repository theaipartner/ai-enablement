# close_custom_field_definitions

Reference table mirroring Close's custom-field schema per object type.

## Purpose

Lets the aggregation layer resolve `cf_*` IDs to human-readable names + types + choices without hardcoding the values. Refreshed on every backfill run; cheap (~100 rows total across lead/opportunity/contact/activity object types).

Per the inventory probe: 88 lead, 9 opportunity, 4 contact, 0 custom-activity fields in the AI Partner org as of 2026-05-23.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `close_id` | `text` | PK. Close `cf_*` id. |
| `object_type` | `text` | NOT NULL. `'lead'` / `'opportunity'` / `'contact'` / `'activity'`. |
| `name` | `text` | NOT NULL. Human-readable label as set in the Close UI. |
| `type` | `text` | NOT NULL. `'text'` / `'number'` / `'date'` / `'datetime'` / `'choices'` / `'user'` / `'contact'` / `'textarea'` / `'hidden'`. |
| `choices` | `jsonb` | Array of valid string values for `'choices'` type; null otherwise. |
| `accepts_multiple_values` | `boolean` | True for multi-value cfs. |
| `is_shared` | `boolean` | True for shared cfs (cross-object). |
| `description` | `text` | Optional admin-set description. |
| `synced_at` / `created_at` / `updated_at` | `timestamptz` | Standard. |

## Indexes

- `close_custom_field_definitions_object_type_idx (object_type)` — common filter for resolution lookups.

## Idempotency

`UPSERT ON CONFLICT (close_id)`. Definitions are stable in Close once created; rename in Close is reflected on next sync.

## What populates it

`ingestion.close.pipeline.sync_custom_field_definitions()` — calls `/custom_field_schema/{lead|opportunity|contact|activity}/` per object type. The `'activity'` schema endpoint 404s if the org has no Custom Activity Types (AI Partner today); the sync is best-effort for that one and skips silently.

## What reads from it

- `ingestion.close.parser.project_cf_columns()` — uses the lead-scoped name map to project cfs into `close_leads` typed columns.
- Future Gregory aggregation layer — joins on `cf_id` to surface human labels in dashboards.

## Example query

Lead cfs and their types:
```sql
SELECT close_id, name, type, choices
FROM close_custom_field_definitions
WHERE object_type = 'lead'
ORDER BY name;
```
