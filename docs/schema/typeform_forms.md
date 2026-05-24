# typeform_forms

Reference table mirroring Typeform form definitions. Refreshed each cron tick from `GET /forms` + `GET /forms/{form_id}`.

## Purpose

The question-ref dictionary for the lead-stream mirror. `typeform_responses.answers[]` reference questions by `field.ref` — this table is where future dashboard / aggregation queries resolve those refs to human-readable titles + question types + choice labels without re-fetching from Typeform.

~31 rows in this account today. Discovery surfaced the inventory in `docs/reports/typeform-discovery.md`.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `form_id` | `text` | PK. Typeform's stable form id (e.g. `PWSNd0h2`). |
| `title` | `text` | Display name as set in Typeform. |
| `last_updated_at` | `timestamptz` | Typeform-side last-edited timestamp. Distinct from our `updated_at`. |
| `fields` | `jsonb` | Flattened `fields[]`. Group fields are unwrapped — each inner field is a top-level entry with `_in_group` carrying the group's ref. Each entry: `{ id, ref, title, type, properties }`. |
| `hidden_fields` | `jsonb` | Flat string array of hidden-field names the form supports (utm_*, ad_*, fbp, fbc, ip, event_id, campaign_id, adset_id, funnel). Per-response values land in `typeform_responses.hidden`. |
| `definition_synced_at` | `timestamptz` | When ingestion last pulled `GET /forms/{form_id}` into this row. |
| `created_at` / `updated_at` | `timestamptz` | Standard. `updated_at` trigger via `set_updated_at()`. |

## Indexes

- PK on `form_id`.
- `typeform_forms_last_updated_idx (last_updated_at DESC) WHERE last_updated_at IS NOT NULL` — for "recently-edited forms" lookups.

## Idempotency

`UPSERT ON CONFLICT (form_id)`. Re-running the cron refreshes definitions without duplicating rows.

## What populates it

- `ingestion.typeform.pipeline.sync_form_definition()` — one form.
- `ingestion.typeform.pipeline.sync_all_form_definitions()` — all forms.
- `api/typeform_sync_cron.py` every 15 min.
- `scripts/backfill_typeform.py --apply` for the initial full-history backfill.
- `api/typeform_events.py` lazy-syncs an unseen form's definition when a response arrives for it (best-effort).

## What reads from it

Future sales dashboard / aggregation layer that translates `field.ref` → question title + choice labels for the per-form opt-in stream in `typeform_responses`.

NOT joined to `clients` — these are lead-form definitions, not client data. There is no `clients` resolution from Typeform (the spec is explicit: top-of-funnel opt-ins are leads, not clients).

## Field-ref stability (load-bearing)

Verified in discovery (§4(c)): the field `ref` is author-assigned and stable across funnel-variant forms. The active funnels `PWSNd0h2` / `poifwp1H` / `SFedWelr` all carry the SAME ref for the "Are you interested..." question (`670168f4-…`), the SAME ref for "monthly income" (`bd4e0524-…`), etc. Means a single ref-keyed answer-extractor handles all variants without per-form configuration — useful for future dashboard aggregation.

## Example queries

Question dictionary for one form:
```sql
SELECT
  form_id,
  jsonb_array_elements(fields) ->> 'ref'   AS field_ref,
  jsonb_array_elements(fields) ->> 'title' AS question_title,
  jsonb_array_elements(fields) ->> 'type'  AS question_type
FROM typeform_forms
WHERE form_id = 'PWSNd0h2';
```

Cross-form question-ref overlap (which forms share a question):
```sql
WITH per_field AS (
  SELECT
    form_id,
    jsonb_array_elements(fields) ->> 'ref' AS field_ref
  FROM typeform_forms
)
SELECT field_ref, count(distinct form_id) AS forms, array_agg(form_id) AS form_ids
FROM per_field
GROUP BY field_ref
HAVING count(distinct form_id) > 1
ORDER BY forms DESC;
```

Forms with attribution-tracking hidden fields:
```sql
SELECT form_id, title, hidden_fields
FROM typeform_forms
WHERE hidden_fields ? 'utm_source';
```
