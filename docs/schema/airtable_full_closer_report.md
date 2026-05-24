# `airtable_full_closer_report`

Airtable Full Closer Report mirror — **US + AUS variants unioned via `region` discriminator**. Feeds the ENTIRE Engine-sheet Closing section (rows 96-116). Source: Airtable base `appCWa6TV6p7EBarC`, two tables:

- `tblYsh3fxTpXuPdIW` "Full Closer Report Form" (US, 66 fields)
- `tblcC25y6lMrtgcty` "Full Closer Report Form - AUS" (AUS, 64 fields)

Field sets overlap ~entirely. AUS-only fields land in `fields_raw`.

**Spec:** `docs/specs/airtable-ingestion.md`
**Discovery:** `docs/reports/airtable-discovery.md`
**Migration:** `supabase/migrations/0050_airtable_mirror.sql`
**Runbook:** `docs/runbooks/airtable_ingestion.md`

## The structural fact: NO stored timestamp field

Same as Setter Triage — no `lastModifiedTime` or `createdTime` field in schema. Incremental via record-level `createdTime` metadata only; created-only, blind to edits. **The live webhook is the only edit-detection path.** A closer who saves `Closed? = No` then later updates it to `Yes` produces NO new-record signal — only a webhook ping. If the webhook is down, that edit goes invisible until the next full re-pull.

## Columns

### Identity + region

| column | type | nullable | notes |
|---|---|---|---|
| `record_id` | `text` | NO | PK. Airtable `recXXX` id. Globally unique across US + AUS. |
| `region` | `text` | NO | `'US'` (tblYsh3fxTpXuPdIW) or `'AUS'` (tblcC25y6lMrtgcty). Discriminator for split-or-union queries. |
| `airtable_created_at` | `timestamptz` | NO | Record-level `createdTime` metadata. Created-only. |
| `lead_id` | `text` | YES | Close CRM lead id (text); cross-source join key. |
| `prospect_name` | `text` | YES | PII. |
| `prospect_email` | `text` | YES | PII. |
| `prospect_phone` | `text` | YES | PII. |

### Call meta

| column | type | nullable | notes |
|---|---|---|---|
| `call_type` | `text` | YES | `'Consultation Call'` \| `'Follow Up Call'`. |
| `date_time_of_call` | `timestamptz` | YES | Engine rollups bucket by this column. |
| `call_recording` | `text` | YES | URL. |
| `call_notes` | `text` | YES | PII (free text). |
| `call_notes_lost` | `text` | YES | PII. **Likely source for objection categorization** (Engine rows Shopping Around / Think-About-It-Fear / Spouse — see § Aggregation-layer-pending ambiguities). |

### Attribution

| column | type | nullable | notes |
|---|---|---|---|
| `closer_record_ids` | `text[]` | YES | Linked Sales Team Member `recXXX` ids. Typically 1 entry. |
| `closer_names` | `text[]` | YES | Lookup of closer display names. |
| `setter_record_ids` | `text[]` | YES | Same. Drives the `is_setter_led` derivation; fill rate UNCONFIRMED. |
| `setter_names` | `text[]` | YES | Lookup of setter display names. |

### Dispositions

| column | type | nullable | notes |
|---|---|---|---|
| `showed` | `text` | YES | `'Yes'` \| `'No'` \| `'Other (Lead got Triage Disqualified)'`. |
| `closed` | `text` | YES | `'Yes'` \| `'No'`. Primary closing-rate signal. |
| `lost_deal` | `text` | YES | `'No'` \| `'Yes'`. |
| `no_show_reason` | `text` | YES | `'Rescheduled'` \| `'Ghost - NoShow'` \| `'Closer Cancelled Call'` \| `'Client Cancelled Call'`. Supplies Reschedule/Cancel/CCMI splits. |
| `paid_on_call` | `boolean` | YES | `'Paid On Call?'` checkbox. |
| `contract_sent` | `boolean` | YES | `'Contract Sent?'` checkbox. |
| `follow_up` | `text` | YES | `'Continuation'` \| `'Advanced'` \| `'Yes'`. |

### Money

| column | type | nullable | notes |
|---|---|---|---|
| `amount_paid_today_currency` | `numeric` | YES | Airtable `'How much did they pay today?/How much are they paying upfront?'` (currency type). **One of TWO cash-paid-today fields** — see § Ambiguity #3. |
| `amount_paid_today_number` | `numeric` | YES | Airtable `'Amount they paid today?'` (number type). Same semantic, different type. Dashboard picks canonical. |
| `deposit_amount` | `numeric` | YES | `'Deposit?'` currency. |
| `total_contract_amount` | `numeric` | YES | `'Total Contract Amount'` currency. |
| `income` | `numeric` | YES | `'Income'` currency. **Prospect's reported income**, NOT cash collected. |

### Plan structure

| column | type | nullable | notes |
|---|---|---|---|
| `payment_status` | `text` | YES | `'Paid in Full'` \| `'Owing Money'`. |
| `payment_plan_type` | `text` | YES | `'Normal Plan'` \| `'Creative Plan'`. |
| `program_type` | `text` | YES | `'DFY'` \| `'DIY'` — from `'Which program is the client going for?'`. |

### Context

| column | type | nullable | notes |
|---|---|---|---|
| `industry` | `text` | YES | |
| `location` | `text` | YES | |

### Provisional derived

| column | type | nullable | notes |
|---|---|---|---|
| `is_setter_led` | `boolean` | YES | **PROVISIONAL.** Derived `cardinality(setter_record_ids) > 0`. Discovery sample had Setter Name empty on all 3 records; post-ingestion N=2 shifted to ~50%. **Dashboard MUST surface as provisional** until a wider sample (~100 records) confirms or refutes the "populated = setter-led" hypothesis. `NULL` when Setter Name field is absent entirely (can't distinguish "no setter" from "field genuinely missing"). |

### Catch-all

| column | type | nullable | notes |
|---|---|---|---|
| `fields_raw` | `jsonb` | NO | **Source of truth.** Complete Airtable `fields{}` dict including: the 5 ambiguities below, the 10 payment-installment fields (`Date of 1st-5th payment` + `Amount of 1st-5th payment` + `Select Date of 2nd-4th payment`), Partner-* fields, AUS-only fields, and anything Airtable adds later without a migration. Empty Airtable fields are OMITTED. |
| `created_at` | `timestamptz` | NO | DB row-insert time. |
| `updated_at` | `timestamptz` | NO | Maintained by trigger. |

**Primary key:** `record_id`.

**Indexes:**

| index | columns | purpose |
|---|---|---|
| `airtable_full_closer_report_pkey` | (record_id) | implicit PK btree |
| `airtable_full_closer_report_call_date_idx` | (date_time_of_call desc) | date-bounded rollups |
| `airtable_full_closer_report_closed_idx` | partial (closed) WHERE closed='Yes' | Closed-deals filter (every Closing metric) |
| `airtable_full_closer_report_closer_ids_gin` | GIN(closer_record_ids) | per-closer rollups |
| `airtable_full_closer_report_fields_raw_gin` | GIN(fields_raw) | fallback for any non-promoted field |
| `airtable_full_closer_report_region_idx` | (region) | split-or-union by region |
| `airtable_full_closer_report_created_idx` | (airtable_created_at desc) | cron `CREATED_TIME()` walks |

## Five aggregation-layer-pending ambiguities

Drake's explicit call: **mirror raw, resolve at dashboard.** The dashboard renders these Engine rows as `NULL` / `'pending field confirmation'` rather than guessing.

1. **Objection categorization** (Engine rows Shopping Around / Think-About-It-Fear / Spouse) — NO structured field categorizes objections in this table. Likely source is the `call_notes_lost` free text. Dashboard reads + categorizes (LLM or manual) when Drake/Aman decides. Until then: pending.
2. **`is_setter_led` provisional** — see column note above.
3. **Canonical "cash paid today"** — `amount_paid_today_currency` AND `amount_paid_today_number` BOTH stored. Dashboard picks canonical when Drake/Aman confirms.
4. **Three near-duplicate payment-on-call fields** — `paid_on_call` + `contract_sent` typed; the other two (`Did they pay on the call?` singleSelect, `Have you already sent a contract?` singleSelect) land in `fields_raw` only. Dashboard picks canonical.
5. **Two typo'd "Financed/Cash/Both" fields** — `Financed, Cash deposit, both?` AND `Financed, Cash Deal, or Both?` (matching `Case`-instead-of-`Cash` typos) — both in `fields_raw` only. Dashboard picks canonical.

The mirror is lossless + opinion-free. Every ambiguity is a read-time decision.

## What populates this table

- **`api/airtable_events.py`** — webhook receiver (load-bearing for edit-detection).
- **`api/airtable_sync_cron.py`** — 15-min cron, creation-detection backstop.
- **`scripts/backfill_airtable.py --apply`** — manual cold start.

All three converge on `pipeline._upsert_batch(target_table='airtable_full_closer_report')` with `ON CONFLICT (record_id) DO UPDATE`. Region is supplied by the caller per source table.

## What reads this table

The Engine-sheet Closing section rows 96-116 — Showed/CCMI/No-Show/Reschedule/Cancel dispositions, Total Deposits, Closed Deals (by meeting type + direct-booking-led/setter-led attribution), all five Cash Collected buckets.

Example aggregations:

```sql
-- Closed deals per closer per day (US only)
SELECT date_trunc('day', date_time_of_call) AS day,
       unnest(closer_names) AS closer,
       count(*) AS closed_deals
FROM airtable_full_closer_report
WHERE region = 'US'
  AND closed = 'Yes'
  AND date_time_of_call >= now() - interval '7 days'
GROUP BY day, closer
ORDER BY day DESC, closed_deals DESC;
```

```sql
-- Cash collected, split by attribution (PROVISIONAL — depends on is_setter_led)
SELECT date_trunc('day', date_time_of_call) AS day,
       is_setter_led,
       sum(deposit_amount) AS total_deposits
FROM airtable_full_closer_report
WHERE region = 'US'
  AND closed = 'Yes'
  AND date_time_of_call >= now() - interval '7 days'
GROUP BY day, is_setter_led
ORDER BY day DESC;
```

```sql
-- Objection rows: PENDING (no structured source). Once Drake/Aman picks
-- a categorization mechanism, query call_notes_lost + categorize.
```

## Operational notes

- Same HTTP/2 ConnectionTerminated mitigation as Setter Triage — `_upsert_batch` retries once with a fresh supabase client.
- Sparse-fill is normal — discovery saw 9-15 of 66 fields populated per record; absent fields are NULL in typed cols, omitted from `fields_raw`.
- Region split today: in the first 24h backfill, 2 US records / 0 AUS records were observed. AUS funnel may simply be lower volume; not an ingestion bug.
- **Setter Name fill-rate observation (live):** discovery N=3 was 0%; post-ingestion N=2 shifted to ~50%. **Hypothesis still requires N≥100 to confirm/refute.** The dashboard must flag `is_setter_led` as provisional until then.

## Out of scope (future work)

- Promoting `Partner Name/Email/Phone` to typed columns (currently `fields_raw` only).
- AUS-specific field mapping (currently AUS-only fields go to `fields_raw` untyped).
- Soft-delete on Airtable record deletes.
- Engine sheet's "Follow Up Meetings" Engine row 95 — different source (Calendly territory, not this table).
