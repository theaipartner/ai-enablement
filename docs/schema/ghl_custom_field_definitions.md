# ghl_custom_field_definitions

GHL custom-field definitions — the **name → id** map for the location's contact
custom fields. Lets `refresh_outbound_facts` resolve an outbound campaign's
`match_field_name` (a human name) to the id stored inside
`ghl_contacts.custom_fields` (`[{id, value}]`). The GHL counterpart of
`close_custom_field_definitions`. Added in migration `0115`.

Populated by `ingestion/ghl/pipeline.sync_custom_field_definitions` (the GHL sync,
`/locations/{id}/customFields`). Cheap — a handful of fields.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `id` | `text` | **PK.** GHL custom-field id (matches the `id` in `ghl_contacts.custom_fields`). |
| `location_id` | `text` | Sub-account id. |
| `name` | `text` | Human name (e.g. `"EOC From"`). Indexed — the campaign match resolves on this. |
| `field_key` | `text` | e.g. `contact.eoc_from`. |
| `data_type` | `text` | GHL field type (TEXT, NUMERICAL, …). |
| `raw` | `jsonb` | Full GHL field-definition object. |
| `synced_at` | `timestamptz` | Last upsert time. |

## What reads it

- `refresh_outbound_facts` (new-model GHL arm) — `select id where name = match_field_name`
  → then matches `ghl_contacts.custom_fields` for `{id, value=match_value}`.
- `lib/db/outbound-campaigns.getMatchFieldSuggestions` — unions these names with the
  Close field names for the adder's field-name datalist.

## Example query

```sql
-- The field id a campaign's match_field_name resolves to on the GHL side.
select id, name, field_key from ghl_custom_field_definitions order by name;
```
