# `airtable_setter_triage_calls`

Airtable Setter Triage Calls EOC Form mirror — feeds the setter-side
Engine-sheet Appointment Setting rows. Source: Airtable base
`appCWa6TV6p7EBarC` table `tblaoMsiE3FSkHjQt`.

**Spec:** `docs/specs/airtable-ingestion.md`
**Discovery:** `docs/reports/airtable-discovery.md`
**Migration:** `supabase/migrations/0050_airtable_mirror.sql`
**Runbook:** `docs/runbooks/airtable_ingestion.md`

## The structural fact: NO stored timestamp field

Airtable's Setter Triage Calls table has **no `lastModifiedTime` or `createdTime` field** in its schema. Incremental ingestion uses Airtable's record-level `createdTime` metadata only — which is **created-only**, blind to edits. The cron backstop catches missed CREATIONS but cannot reconcile EDITS. The live webhook is the only edit-detection path; if the webhook is down, edits to existing rows go invisible until the next full backfill.

## Columns

| column | type | nullable | notes |
|---|---|---|---|
| `record_id` | `text` | NO | PK. Airtable `recXXX` id. |
| `airtable_created_at` | `timestamptz` | NO | Record-level `createdTime` metadata. **Created-only.** Updates to existing records don't change this. |
| `lead_id` | `text` | YES | Close CRM lead id (text); enables cross-source joins. |
| `prospect_name` | `text` | YES | PII. |
| `outcome` | `text` | YES | `'Show'` \| `'No Show'`. Primary triage disposition. |
| `booking_status` | `text` | YES | `'Confirmed Booked with Closer'` \| `'Disqualified Lead'` \| `'Downsell'`. |
| `showed_pct` | `boolean` | YES | Airtable `'Showed %'` checkbox. Name preserved verbatim. |
| `no_show_pct` | `boolean` | YES | `'No Show %'` checkbox. |
| `booked_with_closer` | `boolean` | YES | `'Booked with Closer?'` checkbox. |
| `setter_record_ids` | `text[]` | YES | Linked Sales Team Member `recXXX` ids. Typically 1 entry. |
| `setter_names` | `text[]` | YES | Lookup of setter display names (convenience). |
| `event_date_time` | `timestamptz` | YES | The meeting time itself. |
| `confirmed_call_date_time` | `timestamptz` | YES | When the call was confirmed. |
| `booked_at` | `timestamptz` | YES | When the setter booked the call. User-entered, NOT system clock. |
| `submitted_at` | `date` | YES | Form-submission date (coarse). |
| `notes` | `text` | YES | PII (free text). |
| `fields_raw` | `jsonb` | NO | **Source of truth.** Complete Airtable `fields{}` dict at last upsert; carries any non-promoted field including the 5 aggregation-layer-pending ambiguities. Empty Airtable fields are OMITTED. |
| `created_at` | `timestamptz` | NO | DB row-insert time. |
| `updated_at` | `timestamptz` | NO | Maintained by `airtable_setter_triage_calls_set_updated_at` trigger. |

**Primary key:** `record_id`.

**Indexes:**

| index | columns | purpose |
|---|---|---|
| `airtable_setter_triage_calls_pkey` | (record_id) | implicit PK btree |
| `airtable_setter_triage_calls_booked_at_idx` | (booked_at desc) | per-day setter-booking rollups |
| `airtable_setter_triage_calls_setter_ids_gin` | GIN(setter_record_ids) | per-setter rollups |
| `airtable_setter_triage_calls_created_idx` | (airtable_created_at desc) | cron/backfill `CREATED_TIME()` walks |

## What populates this table

- **`api/airtable_events.py`** — webhook receiver. The load-bearing edit-detection path. One base-level webhook covers all 3 sources; receiver disambiguates via `changedTablesById`.
- **`api/airtable_sync_cron.py`** — every-15-min cron, 6h `CREATED_TIME()` window. Creation-detection backstop only (blind to edits per the structural fact).
- **`scripts/backfill_airtable.py --apply`** — manual 1-day cold start (or recovery from outage).

All three converge on `pipeline.sync_table` (cron + backfill) or `pipeline.upsert_changed_records` (webhook). Same parser, same `ON CONFLICT (record_id) DO UPDATE` upsert.

## What reads this table

Engine-sheet Appointment Setting rollups (setter-side metrics). Aggregation queries:

- Per-day setter-booking count: filter on `booked_at` per day, group by `unnest(setter_record_ids)`.
- Triage outcome split: `outcome = 'Show'` vs `'No Show'`.
- Booking-status mix (booked vs DQ vs downsell): `booking_status`.

## Operational notes

- **Cron uses 1 Airtable req per table** (small per-tick budget; well under the 5 req/sec/base ceiling).
- **HTTP/2 ConnectionTerminated mitigation:** `pipeline._upsert_batch` retries once with a fresh supabase client on the first failure. Same Clarity precedent. Don't refactor to per-row.
- **Idempotency:** `ON CONFLICT (record_id) DO UPDATE`. Re-running the backfill or replaying the webhook is safe.
- **Sparse-fill is normal** — most records have only 9-11 of 16 schema fields populated; absent fields land as NULL in the typed columns and are omitted from `fields_raw`.

## Out of scope (future work)

- Soft-delete on Airtable deletes (Airtable's `destroyedRecordIds` are currently ignored — the mirror keeps the row).
- Promoting any currently-jsonb-only field to a typed column when a dashboard needs faster access.
