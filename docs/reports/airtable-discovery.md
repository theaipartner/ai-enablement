# Report: Airtable Discovery — Setter Triage Calls + Full Closer Report

**Slug:** airtable-discovery
**Spec:** docs/specs/airtable-discovery.md (original) + docs/specs/airtable-discovery-resume.md (resume)
**Branch:** worktree-b (confirmed via `git branch --show-current`)

Complete replacement of the prior PARTIAL — gate (d) is resolved, the probe re-ran end-to-end, and the findings let Director draft the `0050` ingestion spec. Scope was narrowed in the resume spec from four tables to two (`Closer Booked Calls` + `Setter Direct Bookings` dropped). Real evidence from one clean probe run: token verdict, complete Meta-API field inventories for both target tables, per-table incremental verdict, masked record samples with type-serialization notes, funnel-semantics read mapped to the Engine sheet, 1-day backfill viability, ingestion-shape A/B with a lean, and the per-base webhook shape (read-only confirmation — webhook not created).

## Files touched

**Modified:**
- `scripts/explore_airtable_api.py` — `CANDIDATE_TOKEN_VARS` prepended with `AIRTABLE_SALES_PAT`; `TARGET_TABLES` narrowed to `tblaoMsiE3FSkHjQt` + `tblYsh3fxTpXuPdIW`. Probe re-ran end-to-end with no further edits.
- `docs/reports/airtable-discovery.md` — this file. Overwrote the PARTIAL per the resume spec's explicit instruction (halt is now resolved; the clean complete report supersedes; iteration history lives in git).
- `.env.local` (worktree-b) — appended the `AIRTABLE_SALES_PAT` line from main's `.env.local` so the probe could load it. Not committed (gitignored).

**Not modified** (nothing shipped):
- No ingestion module, schema, migration, UI, cron, Vercel changes, `.env.example` edits, runbook, schema doc, or `state.md` entry. Discovery is read-only.

## What I did, in plain English

Read the resume spec + the PARTIAL report. The PARTIAL had isolated the gate-(d) miss precisely (both prior PATs lack `schema.bases:read`, confirmed via differential probe against the accountability PAT's own known-good base). The resume's two changes — prepend `AIRTABLE_SALES_PAT` to `CANDIDATE_TOKEN_VARS`, narrow target tables to two — were ~6 lines total in `scripts/explore_airtable_api.py`. The probe was already complete for all four steps; the resume was a re-run, not a rebuild.

Hit a small operational friction: `AIRTABLE_SALES_PAT` was in `main`'s `.env.local` but not the parallel worktree-b's. Both are gitignored secret stores on the same machine. Copied the single line over rather than refactoring the probe to read from either checkout — simpler, no code change, future runs work consistently from worktree-b.

Re-ran the probe. Step 1 succeeded immediately on `AIRTABLE_SALES_PAT` (whoami 200, Meta-API-on-target-base 200, 11 tables visible). Step 2 returned the complete schema. Step 3 pulled 3 records from each target table. Step 4 (webhook list) returned 403 — `AIRTABLE_SALES_PAT` lacks `webhook:manage` scope, expected, noted for the future ingestion spec.

Inspected the raw probe.json by dumping schemas + record shapes (keys + types only, never values — PII never echoed). Cross-walked the Full Closer Report fields against the Engine-sheet Closing section to identify which fields feed the named metrics. The mapping is largely clean but surfaces a few real ambiguities that Drake/Aman should resolve before the ingestion spec lands (see Surprises).

## Verification

- **Probe parse-check:** `ast.parse(...)` → ok after the two edits.
- **Probe run:** all 4 steps executed end-to-end, exit 0.
- **Step 1 (token):** `AIRTABLE_SALES_PAT` → whoami 200 (user `usrPfNpbojP9CkaUN`) + Meta-API-on-target-base 200 (11 tables). The two fallback PATs were not attempted (walk-order short-circuits on first success), but the PARTIAL report already proved both 403.
- **Step 2 (schema):** Meta API returned 11 tables. Both target tables present with full field metadata (`id`, `name`, `type`, `options` per field).
- **Step 3 (records):** 3 records returned per target table; field-presence sets captured.
- **Step 4 (webhooks):** 403 on `GET /v0/bases/appCWa6TV6p7EBarC/webhooks` — `webhook:manage` not on this PAT. Confirmed the pull-based payload model from the docs (`cursorForNextPayload` field on each webhook entry per the Web API reference at airtable.com/developers/web/api/list-webhooks).
- **API budget burned:** 5 Airtable GETs this run (1 whoami + 1 Meta schema + 2 record samples + 1 webhooks list). + 6 from the PARTIAL pass = 11 total today. Far under Airtable's 5 req/sec/base.
- **No writes** anywhere: Airtable, Supabase, Vercel, env-vars-in-Vercel.
- **No PII** in this report or in committed code. Raw probe.json (~1.2MB) stays in `.probe-out/airtable/` which is gitignored. Records were inspected programmatically (`type(v).__name__` + `len(v)`) to confirm serialization shapes without echoing values.

## Findings

### Token verdict

**`AIRTABLE_SALES_PAT`** reaches base `appCWa6TV6p7EBarC` with `schema.bases:read` + `data.records:read`. Confirmed empirically — Meta API returned 200 with 11 tables. **`webhook:manage` is NOT granted** (403 on the webhooks list endpoint) — this is fine for ingestion's reads but means Drake will need to add this scope (or mint a separate webhook-mgmt PAT) before the ingestion spec can register the live webhook subscription. Flag for the `0050` spec's gate-(d) list.

### Per-table field schemas (from Meta API — complete, including empty-in-sample fields)

#### `tblYsh3fxTpXuPdIW` — Full Closer Report Form — **66 fields**, primaryFieldId `fldwB4HeVgS88bNOc` ('ID' formula)

Grouped by what the Engine sheet's Closing section (rows 96-116) needs:

**Identity / lead linkage:**
- `ID` (formula → singleLineText)
- `Lead ID` (singleLineText) ← Close-CRM lead id, glue for cross-source joins
- `Prospect Name` (singleLineText), `Prospect Email` (singleLineText), `Prospect Phone` (singleLineText)
- `Partner Name`, `Partner Email` (email), `Partner Phone Number` (phoneNumber), `Do they have a business partner?` (singleSelect: No / Yes)

**Attribution (load-bearing for Engine-sheet direct-booking-led vs setter-led split):**
- `Closer Name` (multipleRecordLinks → `tblpSaR3Iq4vBBbpO` Sales Team Member)
- `Name (from Closer Name)` (multipleLookupValues)
- `Setter Name` (multipleRecordLinks → same Sales Team Member table) — **populated = setter-led; empty = direct-booking-led** (working hypothesis; Drake confirms)

**Call meta:**
- `Date & Time of Call` (dateTime)
- `Call Type` (singleSelect: Consultation Call / Follow Up Call) — meeting-type dimension for the Closed-Deals rollup
- `Call Recording` (singleLineText)
- `Call Notes` (multilineText), `Call Notes (Lead lost):` (multilineText)

**Dispositions (Engine rows: Showed/CCMI/No-Show/Reschedule/Cancel):**
- `Showed?` (singleSelect: Yes / No / Other (Lead got Triage Disqualified))
- `No Show Reason?` (singleSelect: Rescheduled / Ghost - NoShow / Closer Cancelled Call / Client Cancelled Call) ← supplies the Reschedule + Cancel splits
- `Closed?` (singleSelect: Yes / No)
- `Lost Deal?` (singleSelect: No / Yes)
- `Follow Up` (singleSelect: Continuation / Advanced / Yes), `Follow Up Date?` (date)

**Money (currency, $ for all — Engine rows: Total Deposits, Cash Collected):**
- `How much did they pay today?/How much are they paying upfront?` (currency) ← upfront / first-payment
- `Deposit?` (currency)
- `How much to collect on top of this deposit to get them started?` (currency)
- `Total Contract Amount` (currency)
- `Amount they paid today?` (number — yes, *also* a number-typed field on top of the currency one above; Drake/Aman to confirm which is canonical or whether they semantically differ)
- `What contract amount should be sent to the client?` (number)
- 10 currency/date pairs for the installment plan: `Date of 1st payment?` / `Amount of 1st payment?` through 5th payment + 4 additional same-date variants (`Select Date of 2nd-4th payment?`)
- `Income` (currency) ← prospect's reported income, NOT cash collected

**Plan structure:**
- `What type of payment was it?` (singleSelect: Deposit / Paid In Full)
- `Payment Status` (singleSelect: Paid in Full / Owing Money)
- `Payment Plan Type?` (singleSelect: Normal Plan / Creative Plan)
- `Select normal plan` (singleSelect: $4k x 2 times / $3k x 3 times / $2k x 4 times)
- `How many monthly payments will there be? (creative plan)` (singleSelect: 1-5)
- `Creative Plan Notes(if any)?` (multilineText), `Payment Schedule` (singleLineText)
- `Will all payment be made on same date of each month?` (singleSelect: Yes / No)
- `Financed, Cash deposit, both?` (singleSelect: Financed / Case depost / Both) — note typo "Case depost"; the field is repeated as `Financed, Cash Deal, or Both?` (Financed / Case Deal / Both) — also typo. **Two separate fields with similar choices and matching typos** — flag.
- `Describe the payment plan you gave them` (singleLineText)
- `Which program is the client going for?` (singleSelect: DFY / DIY)

**Other / context:**
- `Paid On Call?` (checkbox), `Contract Sent?` (checkbox), `Have you already sent a contract?` (singleSelect: No / Yes), `Did they pay on the call?` (singleSelect: No / Yes) — **three fields covering similar payment-on-call signals**; redundant per-row, may differ in fill-rate
- `Did they watch the VSL?` (singleSelect: Yes / No)
- `ad_name` (singleLineText), `Industry` (singleLineText), `Location` (singleLineText)
- `What's their likely start date?` (date)
- `Age` (number)
- `High Ticket Commission Tracking` (multipleRecordLinks → `tblX5GidUPleDAPaR`)

**Timestamp-shaped fields:** ZERO. No `lastModifiedTime`, no `createdTime` field, no `autoNumber`. Incremental MUST use Airtable's record-level `createdTime` metadata.

#### `tblaoMsiE3FSkHjQt` — Setter Triage Calls EOC Form — **16 fields**, primaryFieldId `fld5wfF0Cab1PE40X` ('Lead Name' formula)

Far simpler than the closer report.

- `Lead Name` (formula → singleLineText), `Record ID` (formula → singleLineText)
- `Lead ID` (singleLineText), `Prospect Name` (singleLineText)
- `Outcome` (singleSelect: Show / No Show) ← primary disposition
- `Booking Status` (singleSelect: Confirmed Booked with Closer / Disqualified Lead / Downsell) ← secondary disposition
- `Showed %` (checkbox), `No Show %` (checkbox), `Booked with Closer?` (checkbox)
- `Setter Name` (multipleRecordLinks → `tblpSaR3Iq4vBBbpO`), `Name (from Setter Name)` (multipleLookupValues)
- `Submitted At` (date — user-entered), `Booked At` (dateTime — user-entered), `Event Date & Time` (dateTime), `Confirmed Call Date&Time` (dateTime)
- `Notes` (multilineText)

**Timestamp-shaped fields:** ZERO. Same as Full Closer Report. Incremental via record-level `createdTime` metadata only.

### Per-table incremental verdict

| Table | Verdict | Why |
|---|---|---|
| `tblaoMsiE3FSkHjQt` Setter Triage Calls | **Created-only incremental via record `createdTime` metadata.** No `lastModifiedTime` field; `Submitted At` is user-entered date (coarse + unreliable as system clock). | No system-generated timestamp field. Edits to existing rows won't be caught by the cron backstop — webhook required for edit-detection. |
| `tblYsh3fxTpXuPdIW` Full Closer Report | **Created-only incremental via record `createdTime` metadata.** | Same as above. Same caveat — edits invisible to the cron backstop. |

**Implication for the `0050` ingestion spec:** the cron backstop (`*/15` or whatever cadence) catches NEW records only. The live webhook (per-base, pull-payload model) is the ONLY way to catch edits to existing records. **Webhook is therefore load-bearing, not just nice-to-have** — without it, e.g. a closer updating `Closed? = No → Yes` later in the day would never propagate. Flag prominently in the ingestion spec.

**1-day backfill filter** (per spec § 6): expressible via `filterByFormula=IS_AFTER(CREATED_TIME(), DATETIME_PARSE("2026-05-23T00:00:00.000Z"))`. Airtable's `CREATED_TIME()` formula function returns the record-level metadata regardless of whether a `createdTime` field exists on the schema. Confirmed against the Web API filter docs. Works per table.

### Masked record samples (3 per table, all PII placeholders are mine — values exist in raw probe.json which is gitignored)

#### Setter Triage Calls — sample record (one of three)

```json
{
  "id": "rec2bBTQnY7pGrvvA",
  "createdTime": "2026-05-23T15:19:00.000Z",
  "fields": {
    "Lead ID": "<close-lead-id, 48 chars>",
    "Lead Name": "<13-char lead-name string from primary-field formula>",
    "Confirmed Call Date&Time": "2026-05-XXTXX:XX:XX.000Z",
    "Submitted At": "2026-05-XX",
    "Booking Status": "Confirmed Booked with Closer",
    "Event Date & Time": "2026-05-XXTXX:XX:XX.000Z",
    "Prospect Name": "<13-char name>",
    "Record ID": "<17-char Airtable rec-id echo>",
    "Name (from Setter Name)": ["<setter display name>"],
    "Notes": "<217-char free text — PII likely>",
    "Setter Name": ["recXXXXXXXXXXXXXX"]
  }
}
```

Type-serialization confirmed: dateTime → ISO 8601 with `.000Z` (24 chars), date → `YYYY-MM-DD` (10 chars), singleSelect → choice name string, multipleRecordLinks → list of `recXXX` ids (length 1 in all 3 samples — 1:1 setter linkage), multipleLookupValues → list of strings.

**11 / 16 fields present in the sample.** Absent in sample (per Meta API, still part of schema): `Outcome`, `Showed %`, `No Show %`, `Booked At`, `Booked with Closer?`. The first record's `Booking Status` of "Confirmed Booked with Closer" implies `Outcome=Show` should be set somewhere, but it wasn't on this record — fields are conditionally-filled based on what the setter ticked in the form, and empty fields are OMITTED from the response (that's why the Meta API is the source of truth for the field set).

#### Full Closer Report — sample record (one of three)

```json
{
  "id": "rec024ln7IgWx92Ml",
  "createdTime": "2026-04-06T20:54:55.000Z",
  "fields": {
    "ID": "<53-char formula output, looks like '<lead-id> | <call-type>' or similar>",
    "Lead ID": "<48-char Close lead id>",
    "Prospect Name": "<14-char name>",
    "Date & Time of Call": "2026-04-XXTXX:XX:XX.000Z",
    "Call Type": "Consultation Call",
    "Call Recording": "<59-char URL>",
    "Call Notes": "<364 chars free text — PII likely>",
    "Closer Name": ["recXXXXXXXXXXXXXX"],
    "Name (from Closer Name)": ["<closer display name>"],
    "Showed?": "Yes",
    "Closed?": "No",
    "Lost Deal?": "Yes"
  }
}
```

**12 / 66 fields present** on this record. Sparse-fill is the norm — most fields are conditional on the deal path (closed deals fill the payment-plan + money fields; lost deals fill `Lost Deal? + Call Notes (Lead lost):`; no-shows fill `No Show Reason?` and skip the rest). Across all 3 sample records, 15 distinct fields appeared. The remaining 51 fields exist in the schema but weren't filled in any of the 3 samples — common for a sparse form-driven table.

Important: **`Setter Name` is ABSENT in all 3 sample records.** Working hypothesis from spec ("populated = setter-led; empty = direct-booking-led") makes the small sample look entirely direct-booking-led. This may be sample bias, OR it could mean Setter Name is filled less reliably than expected. **Worth a wider sample (say 100 records) at ingestion-spec time to estimate the fill rate.**

### Funnel-semantics read

#### Setter Triage Calls — what a row is, what fields matter

**One row = one setter's end-of-call form after a triage call with a lead.** Sources the setter-side Engine-sheet Appointment Setting rows.

The meaningful fields:
- **Outcome** — Show / No Show — primary disposition; counts as "triage shown" in setter metrics.
- **Booking Status** — Confirmed Booked with Closer / Disqualified Lead / Downsell — counts as "booked" for setter productivity; the Disqualified Lead bucket is the triage filter rate the Engine-sheet may surface.
- **Setter Name** — the per-setter rollup dimension.
- **Booked At / Event Date & Time / Confirmed Call Date&Time** — when the setter booked, when the call is, when it was confirmed. The Engine-sheet's setter-led-bookings rollup likely keys off `Booked At` rolled into the day.

#### Full Closer Report — what a row is, what fields matter

**One row = one closer's end-of-call form after a closing call with a prospect.** Sources the ENTIRE Engine-sheet Closing section (rows 96-116).

| Engine sheet row | Closing-section need | Field(s) that feed it | Notes |
|---|---|---|---|
| Showed | Count `Showed? = Yes` per closer per day | `Showed?` × `Closer Name` × `Date & Time of Call` | Filter `Showed? != 'Other'`; "Other (Lead got Triage Disqualified)" is a tertiary bucket worth keeping but probably excluded from the main Showed/No-Show ratio |
| CCMI (closer-cancelled mid-interaction) | Count `No Show Reason? = 'Closer Cancelled Call'` | `No Show Reason?` | Distinct from generic No-Show |
| No-Show | Count `Showed? = No` AND `No Show Reason? = 'Ghost - NoShow'` | `Showed?` + `No Show Reason?` | The Reschedule + Client Cancelled subset is a different bucket |
| Reschedule | Count `No Show Reason? = 'Rescheduled'` | `No Show Reason?` | |
| Cancel | Count `No Show Reason? = 'Client Cancelled Call'` | `No Show Reason?` | |
| Three objection types (Shopping Around / Think-About-It-Fear / Spouse) | **NOT MAPPED — no objection-categorization field in this table.** | — | **Major gap.** Either tracked in `Call Notes (Lead lost):` as free text, OR aggregated elsewhere, OR not yet tracked. Drake/Aman to clarify before the ingestion spec lands. |
| Total Deposits | Sum `Deposit?` filtered to `Closed? = Yes` per closer per day | `Deposit?` + `Closed?` + `Closer Name` + `Date & Time of Call` | |
| Closed Deals — by meeting type | Count `Closed? = Yes` split by `Call Type` | `Closed?` × `Call Type` | Consultation Call / Follow Up Call |
| Closed Deals — direct-booking-led vs setter-led | Count `Closed? = Yes` AND `Setter Name` empty (direct) vs populated (setter-led) | `Closed?` + `Setter Name` populated/empty | **Working hypothesis** — needs Drake/Aman confirmation per the "Setter Name was empty in all 3 samples" finding above |
| Cash Collected — deposits | Sum `Deposit?` (or `Amount they paid today?` — TBD which is canonical) per closer per day | `Deposit?` / `Amount they paid today?` | The two-currency-fields-for-the-same-thing ambiguity is real — flag |
| Cash Collected — new calls vs follow-up | Sum cash collected split by `Call Type` | currency-field × `Call Type` | |
| Cash Collected — direct-booking-led vs setter-led | Sum cash collected split by `Setter Name` populated/empty | currency-field × `Setter Name` | Same hypothesis as above |

The Engine sheet's Closing section maps almost entirely to this one table, with two notable gaps:
1. **Objection categorization is missing from the table schema** — possibly free-text-only in `Call Notes (Lead lost):`. Manual categorization or LLM-classification would be needed; either way, the source IS this table.
2. **Direct-booking-led vs setter-led attribution** is hypothesized to be inferable from `Setter Name` populated-or-not, but that needs to be confirmed before the dashboard relies on it.

### Webhook shape (read-only, confirmed from docs)

Per https://airtable.com/developers/web/api/list-webhooks + https://airtable.com/developers/web/api/list-webhook-payloads:

- Webhooks are **registered per-BASE** (not per-table), via `POST /v0/bases/{baseId}/webhooks` with a `specification` filter that can scope to tables/views/field-types.
- Webhooks **do NOT push the changed payload** — they POST a notification ping to your URL, then your handler must call `GET /v0/bases/{baseId}/webhooks/{webhookId}/payloads?cursor=...` to fetch what changed. The `cursor` advances per payload-fetch; the response includes a `cursor` field for the next call.
- Required scope to MANAGE (create/list/delete): `webhook:manage` — `AIRTABLE_SALES_PAT` does NOT have this. The future ingestion spec needs Drake to grant it (or mint a separate webhook-management PAT).
- Required scope to FETCH payloads on a webhook: `data.records:read` (the same scope our ingestion already needs). So once Drake creates the subscription, the receiver doesn't need `webhook:manage`.

**Implication for the `0050` spec:** one base-level webhook subscription on `appCWa6TV6p7EBarC` covers both target tables. The receiver's first job per ping is to disambiguate which table changed (`payload.changedTablesById` per the Airtable spec) and route to per-table parsers. Mirrors the pull-based design Drake already implemented for Typeform (different mechanism but same shape: notification → pull → upsert).

### Ingestion-shape recommendation (A/B with lean)

**(A) Per-table mirror tables — `airtable_setter_triage_calls` + `airtable_full_closer_report`, typed hot columns + `fields_raw jsonb` catch-all.**

Pros:
- Engine-sheet Closing-section queries become readable: `SELECT closer_name, sum(deposit) FROM airtable_full_closer_report WHERE closed = 'Yes' AND date_of_call >= ...` instead of 12-deep jsonb extractions.
- Indexes on the hot dispositions (`closed`, `showed`, `no_show_reason`) keep aggregation fast as rows accumulate.
- Type safety at ingest: currency → numeric, dateTime → timestamptz, multipleRecordLinks → text[].
- Same hybrid pattern as `close_leads.custom_fields_raw` (precedent).

Cons:
- Two tables, two parsers, one migration that's longer (~80 columns total).
- Schema drift: if Airtable adds a `Cash Refund?` field tomorrow, the typed column stays absent until promoted; but `fields_raw` catches it immediately (no data loss, just no convenience).

**(B) Single generic `airtable_records` table keyed on `(table_id, record_id)`, all fields in `fields_raw jsonb`.**

Pros:
- One migration, no schema drift ever.
- Easy to extend to more Airtable tables later (just start writing rows with a new `table_id`).

Cons:
- Every Engine-sheet aggregation becomes `fields_raw->>'Closed?' = 'Yes' AND (fields_raw->>'Deposit?')::numeric` — verbose, slow without functional indexes, and easy to fat-finger field names.
- Full Closer Report is money-critical with ~12 currency fields; the rollup queries become a query-writing tax on every dashboard change.
- No type safety at ingest — a string-typed currency value would silently flow through.

**Lean: (A).** Full Closer Report's money/disposition focus and the Engine sheet's 20+ rollup rows on this single table tip the balance toward typed columns. Mirror the Close pattern. Setter Triage Calls is small (16 fields, ~7 hot) and gets a thinner version of the same approach. The `fields_raw jsonb` catch-all on both tables preserves the "store everything raw" principle and forward-compatibility.

**Sketch (NOT a migration — just for the spec):**

```
airtable_setter_triage_calls (
  record_id text PK,
  airtable_created_at timestamptz NOT NULL,  -- from record-level metadata
  lead_id text, prospect_name text,
  outcome text, booking_status text,
  showed_pct boolean, no_show_pct boolean, booked_with_closer boolean,
  setter_record_ids text[], setter_names text[],
  event_date_time timestamptz, confirmed_call_date_time timestamptz,
  booked_at timestamptz, submitted_at date,
  notes text,
  fields_raw jsonb NOT NULL,
  synced_at / created_at / updated_at
)

airtable_full_closer_report (
  record_id text PK,
  airtable_created_at timestamptz NOT NULL,
  lead_id text, prospect_name text, prospect_email text, prospect_phone text,
  call_type text, date_time_of_call timestamptz,
  call_recording text, call_notes text, call_notes_lost text,
  closer_record_ids text[], closer_names text[],
  setter_record_ids text[], setter_names text[],
  showed text, closed text, lost_deal text, no_show_reason text,
  contract_sent boolean, paid_on_call boolean, follow_up text,
  amount_paid_today numeric, deposit_amount numeric,
  total_contract_amount numeric, income numeric,
  payment_status text, payment_plan_type text, program_type text,
  industry text, location text,
  fields_raw jsonb NOT NULL,  -- 5-payment installment fields + Partner-* + Age + etc. live here
  synced_at / created_at / updated_at
)

-- Migration 0050. Indexes:
--   * (date_time_of_call desc) — Engine rollups are date-bounded
--   * (closer_record_ids gin) — per-closer queries
--   * (closed) WHERE closed = 'Yes' — closed-deals filter
--   * GIN on fields_raw — fallback query path
```

**Direct-booking-led vs setter-led attribution** could become a derived column at the ingestion layer (`is_setter_led boolean = cardinality(setter_record_ids) > 0`) — but waits on Drake/Aman confirming the hypothesis first.

### Other tables in the base (context for Drake — not in scope for this discovery)

| id | name | fields | notes |
|---|---|---:|---|
| `tblpSaR3Iq4vBBbpO` | Sales Team Member | 26 | Reference table — both target tables' `Closer Name` and `Setter Name` link here. Future ingestion may want this for human-readable rollups. |
| `tblkWNWWge8IrgJEf` | Contract Forms | 17 | Possibly contract-line-item detail; not feeding any current Engine rollup. |
| `tblnGf0NoNCWVwOsz` | Setter EOD's | 14 | Daily setter summaries. Might pre-aggregate signals we're computing from Setter Triage Calls — worth comparing later. |
| `tbly2S13lmo82xy5e` | Closer EOD's | 15 | Same pattern, closer side. |
| `tblcC25y6lMrtgcty` | **Full Closer Report Form - AUS** | 64 | **Australian variant of Full Closer Report (US has 66, AUS has 64).** Drake may want this for the AUS funnel — if so, a future ingestion spec adds it (the `0050` schema can be reused with another table.) |
| `tblRNhANZ7OGqjlrM` | Setter Direct Bookings | 13 | **Dropped from this discovery per resume spec.** |
| `tbla3benxdsq4n0kP` | Closer Booked Calls | 17 | **Dropped from this discovery per resume spec.** |
| `tblX5GidUPleDAPaR` | High Ticket Commission Tracking | 14 | Linked from Full Closer Report (`High Ticket Commission Tracking` field). Commission/payment tracking; not currently on the Engine sheet's main rollups. |
| `tblIKbEWT7P5lv9X6` | Affiliate SignUps/Purchase | 6 | Small affiliate-tracking table. |

## Surprises and judgment calls

- **`AIRTABLE_SALES_PAT` was in main's `.env.local` but not worktree-b's.** Same machine, both gitignored. Copied the single line over (`grep ... | tee -a`) rather than refactoring the probe to look up either checkout. Future runs from worktree-b now work cleanly. Not committed (gitignored), not a secret leak.
- **NEITHER target table has a stored `lastModifiedTime` or `createdTime` field.** Incremental MUST use Airtable's record-level `createdTime` metadata, and that's created-only — edits to existing records won't be caught by the cron backstop. This makes the live webhook load-bearing for edit-detection in the `0050` spec, not optional.
- **Three near-duplicate payment-on-call fields on Full Closer Report:** `Paid On Call?` (checkbox), `Have you already sent a contract?` (singleSelect Y/N), `Did they pay on the call?` (singleSelect Y/N), plus `Contract Sent?` (checkbox). Closers probably fill some-but-not-all of these depending on the form path they take; the canonical "did they pay" signal is ambiguous. Drake/Aman to pick one.
- **Two near-duplicate "Financed / Cash / Both" fields with matching typos:** `Financed, Cash deposit, both?` (choices: Financed / Case depost / Both) AND `Financed, Cash Deal, or Both?` (choices: Financed / Case Deal / Both). Both have "Case" instead of "Cash" in the second choice — looks like a copy-paste artifact when the second field was added. Same problem at ingestion: which is canonical? Both can be stored; mirror-everything principle covers us, but the rollup queries need to pick.
- **Two currency/number fields for "what they paid today":** `How much did they pay today?/How much are they paying upfront?` (currency) AND `Amount they paid today?` (number). Could be a "we added the second one when the first stopped being filled" pattern. Engine-sheet Cash Collected needs to know which is canonical — flag.
- **Objection categorization (Shopping Around / Think-About-It-Fear / Spouse) is NOT a field in Full Closer Report.** The Engine sheet lists three objection-type rows in the Closing section; nothing in this table's schema feeds them directly. Hypotheses: (1) tracked in `Call Notes (Lead lost):` free-text and either eyeballed or LLM-classified later; (2) aggregated separately in a dashboard that this table feeds; (3) just not yet tracked. **Major flag** — without resolving this, the Closing section's objection rows won't compute from Airtable alone.
- **`Setter Name` was empty on all 3 Full Closer Report samples.** Small N, so could be sample bias — but it's worth a wider sample (say 100 records) at ingestion-spec time to estimate fill rate. If the field really is rarely-filled, the "populated = setter-led / empty = direct-booking-led" hypothesis falls apart and we need a different attribution source.
- **The `Full Closer Report Form - AUS` variant exists** (64 fields vs the US 66). Out of scope here per the resume spec (which scoped to two tables) but Drake almost certainly wants this for the AUS funnel — flag for a follow-up spec.
- **Setter Triage Calls' table name in Airtable is "Setter Triage Calls EOC Form"** (not just "Setter Triage Calls" as Drake referenced). Same ID. Probably re-named at some point. Not a blocker; worth noting the canonical name for the schema doc and any UI labels.
- **`AIRTABLE_SALES_PAT` does NOT have `webhook:manage` scope.** Drake's PAT mint had `schema.bases:read` + `data.records:read` but not webhook management. The future ingestion spec will need this scope (or a separate webhook-mgmt PAT) before it can create the live subscription. Read-path doesn't need it.
- **The Meta API path is `GET /v0/meta/bases/{baseId}/tables` — but the records endpoint is `GET /v0/{baseId}/{tableId}`** (no `/meta`). Easy to typo into 404. Inline in the probe; documenting here for the future ingestion client.

## Out of scope / deferred

- **The `0050` ingestion spec itself.** Director writes; this report is the input.
- **Resolution of the ambiguities flagged above** (payment-on-call canonical field, Financed/Cash/Both canonical field, objection categorization source, Setter Name fill rate, direct-vs-setter-led attribution hypothesis confirmation). Drake/Aman calls before the ingestion spec lands.
- **The dropped tables** — `Closer Booked Calls` (`tbla3benxdsq4n0kP`) and `Setter Direct Bookings` (`tblRNhANZ7OGqjlrM`). Resume spec explicitly dropped them; if they come back later for direct-booking-led attribution, the probe's `TARGET_TABLES` is the one-line edit.
- **The `Full Closer Report Form - AUS` variant.** Same shape mostly; future spec when Drake wants the AUS funnel.
- **Other 7 tables in the base** (Sales Team Member, Contract Forms, EODs, HT Commission Tracking, Affiliate SignUps). Reference / context tables; future-spec candidates when a need surfaces.
- **`webhook:manage` scope add to `AIRTABLE_SALES_PAT` (or a new webhook-mgmt PAT).** Gate (d) for the `0050` spec.
- **Wider record sample (100+) at ingestion time** to estimate field fill rates — especially `Setter Name` on Full Closer Report.
- **Mapping Setter EOD's / Closer EOD's** against Setter Triage / Full Closer Report — they may pre-aggregate signals we'd otherwise compute.

## Side effects

- **Airtable API: 5 GET calls this run.** All read-only:
  - 1× `/v0/meta/whoami` (AIRTABLE_SALES_PAT)
  - 1× `/v0/meta/bases/appCWa6TV6p7EBarC/tables` (schema for 11 tables)
  - 2× `/v0/appCWa6TV6p7EBarC/{tableId}?pageSize=3` (record samples)
  - 1× `/v0/bases/appCWa6TV6p7EBarC/webhooks` (403, expected)
- **PARTIAL pass burned 6 earlier.** Total Airtable budget: 11 reqs today. Daily limit not specified by Airtable (the 5 req/sec/base is the only per-base ceiling — and that's instantaneous, not daily).
- **No Supabase writes.** No migration. No Vercel changes. No env-vars-in-Vercel.
- **`.env.local` on worktree-b modified** (uncommitted, gitignored) — appended `AIRTABLE_SALES_PAT=...` from main's `.env.local`. Not a leak; same machine; both files are .gitignored.
- **No external messages.**
- **Local filesystem:** `.probe-out/airtable/probe.json` overwritten by the re-run (now contains the successful Step 2-4 data, NOT just the PARTIAL-pass error envelopes). ~1.2 MB, gitignored. Contains real PII in record samples — never committed; never echoed in this report; values were inspected by `type(v).__name__ + len(v)` only.
- **Token handling:** PATs read from `.env.local` only; never logged, never written to any committed file. The Authorization header was the only place the bearer token touched.
