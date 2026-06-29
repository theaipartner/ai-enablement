# airtable_rep_eods

Mirror of the Airtable **Setter EOD's** + **Closer EOD's** tables (base
`appCWa6TV6p7EBarC`: `tblnGf0NoNCWVwOsz` / `tbly2S13lmo82xy5e`). Feeds the
per-rep **EOD section** on the roster detail page
(`/sales-dashboard/people/by-rep?rep=`). One row per EOD.

Added in migration `0111_airtable_rep_eods.sql`.

## Why one table + `fields_raw`

Setter and closer EOD forms have very different field sets, the data is sparse
(only a few reps fill them today), and the forms are expected to grow. So both
kinds mirror into one table with a `kind` discriminator and the **full Airtable
record in `fields_raw`** — the dashboard renders the labeled fields straight from
it, so new EOD-form fields appear with no schema change. Only the join key + date
are promoted to columns.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `record_id` | `text` | **PK.** Airtable EOD record id (matches the shared upsert path's `on_conflict="record_id"`). |
| `kind` | `text` | Not null. CHECK `setter` / `closer` (the source table). |
| `rep_record_id` | `text` | Sales Team Member rec id = `team_members.airtable_user_id` (form's "Sales Person"/"Closer" link). Null = orphan (no rep) → not shown. |
| `eod_date` | `date` | Setter "Date" / Closer "Submitted At". |
| `airtable_created_at` | `timestamptz` | Record createdTime. |
| `fields_raw` | `jsonb` | The complete Airtable `fields` dict. |
| `synced_at` | `timestamptz` | Not null, default `now()`. |

Index: `(rep_record_id, eod_date)` for the per-rep windowed read.

## Populated by

- The Airtable ingestion pipeline — both EOD table ids are in `TARGET_TABLES`
  (`ingestion/airtable/__init__.py`), parsed by `parse_rep_eod` and routed in
  `pipeline.py`. The 15-min `airtable_sync_cron` (`sync_all`) keeps it current;
  the live webhook covers it too if its subscription includes these tables. A
  one-time full backfill loaded the existing rows.

## Read by

- `lib/db/funnel-eods.ts` `getRepEods(range, closeUserId)` — resolves
  `close_user_id → airtable_user_id`, returns that rep's EODs in the window.
  Rendered as a collapsed section at the bottom of the roster detail view.

## Related

- `team_members` (§ Sales identity) — `airtable_user_id` is the join key.
