-- 0050_airtable_mirror.sql
-- Mirror tables for Airtable base `appCWa6TV6p7EBarC` — two sales-funnel
-- tables that feed Engine-sheet rows living nowhere else in our mirror.
--
-- Spec: docs/specs/airtable-ingestion.md
-- Discovery: docs/reports/airtable-discovery.md (probe + complete field
--   inventories; structural no-timestamp-field finding; five flagged
--   aggregation-layer-pending ambiguities)
-- Schema docs: docs/schema/airtable_setter_triage_calls.md +
--   docs/schema/airtable_full_closer_report.md
-- Runbook: docs/runbooks/airtable_ingestion.md
--
-- ============================================================================
-- The defining structural fact — NO STORED TIMESTAMP FIELD
-- ============================================================================
-- Neither target table has a `lastModifiedTime` or `createdTime` FIELD
-- in the Airtable schema. Incremental ingestion can only use Airtable's
-- record-level `createdTime` metadata, which is CREATED-ONLY — it
-- catches NEW records but is BLIND TO EDITS of existing records.
--
-- Consequence:
--   * The cron backstop (CREATED_TIME() filter) catches missed webhook
--     CREATIONS but cannot reconcile edits.
--   * The live webhook is the ONLY path for edit-detection. It is
--     structurally required for dashboard correctness on any
--     edit-after-creation field (Closed?, money fields entered later,
--     disposition updates).
--
-- This shapes the receiver design (pull-payload model with persisted
-- cursor) and the activation gates (webhook:manage scope on the PAT is
-- a hard prerequisite for live correctness).
--
-- ============================================================================
-- Schema design — hybrid (typed-columns + jsonb catch-all)
-- ============================================================================
-- Same pattern as close_leads.custom_fields_raw + meta_ad_daily +
-- the Clarity hybrid. Typed columns for the Engine-rollup hot fields
-- (clean queries + indexable); `fields_raw` jsonb carries the COMPLETE
-- Airtable `fields{}` dict regardless of typed-column promotion (so
-- the dashboard can read any field — including the five flagged
-- ambiguities — without a migration).
--
-- The five aggregation-layer-pending ambiguities, all mirrored:
--   1. Objection categorization — NO field; lives in call_notes_lost
--      free text; dashboard reads + categorizes (LLM or manual).
--   2. is_setter_led — derived `cardinality(setter_record_ids) > 0`,
--      flagged PROVISIONAL because Setter Name was empty on all 3
--      discovery samples; the hypothesis is unconfirmed.
--   3. "Cash paid today" — TWO Airtable fields with different types
--      (currency AND number) for similar semantic. Both stored as
--      separate typed columns (amount_paid_today_currency,
--      amount_paid_today_number); dashboard picks canonical.
--   4. Three near-duplicate payment-on-call fields — paid_on_call +
--      contract_sent typed; the other two land in fields_raw.
--   5. Two typo'd "Financed/Cash/Both" fields — both in fields_raw
--      only (not worth typed columns).
--
-- The mirror is lossless + opinion-free; every ambiguity is a
-- read-time decision the dashboard makes, flagged until Drake/Aman
-- resolves it.
--
-- ============================================================================
-- AUS variant — region discriminator, NOT a separate table
-- ============================================================================
-- Full Closer Report has a US table (66 fields, tblYsh3fxTpXuPdIW)
-- and an AUS variant (64 fields, tblcC25y6lMrtgcty). Field sets
-- overlap ~entirely; mirror both into `airtable_full_closer_report`
-- with a `region text NOT NULL` discriminator ('US' | 'AUS'). The
-- dashboard wants them unioned-or-split by region. AUS-only fields
-- land in fields_raw (typed columns map only US-confirmed names;
-- missing-in-AUS = NULL column, never blocks the upsert).
--
-- Migration number hardcoded to 0050 per spec (deliberate — ledger
-- at 0049 clarity, this is the next reserved slot).


-- ============================================================================
-- airtable_setter_triage_calls
-- ============================================================================
-- Source: Airtable base appCWa6TV6p7EBarC table tblaoMsiE3FSkHjQt
-- ("Setter Triage Calls EOC Form" in Airtable, 16 fields). Feeds the
-- setter-side Appointment Setting rows on the Engine sheet.

create table airtable_setter_triage_calls (
  record_id text primary key,                  -- Airtable recXXX id
  airtable_created_at timestamptz not null,    -- record-level createdTime metadata

  -- Identity + linkage
  lead_id text,                                -- Close CRM lead id (text)
  prospect_name text,                          -- PII

  -- Primary + secondary disposition
  outcome text,                                -- 'Show' | 'No Show'
  booking_status text,                         -- 'Confirmed Booked with Closer' | 'Disqualified Lead' | 'Downsell'

  -- Boolean flags (from Airtable checkbox fields)
  showed_pct boolean,                          -- 'Showed %' checkbox — name preserved from Airtable
  no_show_pct boolean,                         -- 'No Show %' checkbox
  booked_with_closer boolean,                  -- 'Booked with Closer?' checkbox

  -- Attribution
  setter_record_ids text[],                    -- linked Sales Team Member rec ids
  setter_names text[],                         -- lookup names (display convenience)

  -- Timestamps from form fields (user-entered, NOT system clocks)
  event_date_time timestamptz,                 -- the meeting time itself
  confirmed_call_date_time timestamptz,
  booked_at timestamptz,                       -- when the setter booked the call
  submitted_at date,                           -- form-submission date (coarse)

  -- Free text (PII likely)
  notes text,

  -- Catch-all: the complete Airtable fields{} dict. SOURCE OF TRUTH —
  -- any field not promoted to a typed column is still readable from
  -- here without a migration.
  fields_raw jsonb not null,

  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table airtable_setter_triage_calls is
  'Airtable Setter Triage Calls EOC Form mirror. PK = Airtable record_id. Idempotent UPSERT ON CONFLICT (record_id). NO stored timestamp field — record-level airtable_created_at is created-only; edits invisible to cron, webhook required for edit-detection. See docs/schema/airtable_setter_triage_calls.md.';

comment on column airtable_setter_triage_calls.airtable_created_at is
  'Record-level createdTime metadata from Airtable. CREATED-ONLY — the cron backstop uses this with CREATED_TIME() filterByFormula. Updates to existing records do NOT change this value.';

comment on column airtable_setter_triage_calls.fields_raw is
  'Complete Airtable fields{} dict at last upsert. Source of truth for any non-promoted field. Empty-valued Airtable fields are OMITTED from this object (Airtable API behavior — cross-reference Meta API for the complete schema).';

create index airtable_setter_triage_calls_booked_at_idx
  on airtable_setter_triage_calls (booked_at desc);
create index airtable_setter_triage_calls_setter_ids_gin
  on airtable_setter_triage_calls using gin (setter_record_ids);
create index airtable_setter_triage_calls_created_idx
  on airtable_setter_triage_calls (airtable_created_at desc);

create trigger airtable_setter_triage_calls_set_updated_at
  before update on airtable_setter_triage_calls
  for each row execute function set_updated_at();


-- ============================================================================
-- airtable_full_closer_report
-- ============================================================================
-- Source: Airtable base appCWa6TV6p7EBarC, TWO tables unioned via
-- region discriminator:
--   * 'US'  → tblYsh3fxTpXuPdIW "Full Closer Report Form" (66 fields)
--   * 'AUS' → tblcC25y6lMrtgcty "Full Closer Report Form - AUS" (64 fields)
-- Feeds the ENTIRE Engine-sheet Closing section (rows 96-116).

create table airtable_full_closer_report (
  record_id text primary key,                  -- Airtable recXXX id
  region text not null,                        -- 'US' | 'AUS' discriminator
  airtable_created_at timestamptz not null,    -- record-level createdTime metadata

  -- Identity + lead linkage
  lead_id text,                                -- Close CRM lead id
  prospect_name text,                          -- PII
  prospect_email text,                         -- PII
  prospect_phone text,                         -- PII

  -- Call meta
  call_type text,                              -- 'Consultation Call' | 'Follow Up Call'
  date_time_of_call timestamptz,
  call_recording text,                         -- URL
  call_notes text,                             -- PII (multilineText)
  call_notes_lost text,                        -- PII — 'Call Notes (Lead lost):'; likely source for objection categorization (Engine rows pending)

  -- Attribution (load-bearing for Engine direct-booking-led vs setter-led split)
  closer_record_ids text[],                    -- linked Sales Team Member rec ids
  closer_names text[],
  setter_record_ids text[],
  setter_names text[],

  -- Dispositions (Engine Showed/CCMI/No-Show/Reschedule/Cancel)
  showed text,                                 -- 'Yes' | 'No' | 'Other (Lead got Triage Disqualified)'
  closed text,                                 -- 'Yes' | 'No'
  lost_deal text,                              -- 'No' | 'Yes'
  no_show_reason text,                         -- 'Rescheduled' | 'Ghost - NoShow' | 'Closer Cancelled Call' | 'Client Cancelled Call'

  -- Boolean disposition flags
  paid_on_call boolean,                        -- 'Paid On Call?' checkbox
  contract_sent boolean,                       -- 'Contract Sent?' checkbox

  -- Follow-up
  follow_up text,                              -- 'Continuation' | 'Advanced' | 'Yes'

  -- Money (Engine Total Deposits + Cash Collected splits)
  -- AMBIGUITY: Airtable has TWO fields for "cash paid today" with different types.
  --   amount_paid_today_currency — Airtable currency field, 'How much did they pay today?/How much are they paying upfront?'
  --   amount_paid_today_number   — Airtable number field, 'Amount they paid today?'
  -- Both mirrored separately; dashboard picks canonical.
  amount_paid_today_currency numeric,
  amount_paid_today_number numeric,
  deposit_amount numeric,                      -- 'Deposit?' currency
  total_contract_amount numeric,               -- 'Total Contract Amount' currency
  income numeric,                              -- 'Income' currency — prospect's reported income, NOT cash collected

  -- Plan structure
  payment_status text,                         -- 'Paid in Full' | 'Owing Money'
  payment_plan_type text,                      -- 'Normal Plan' | 'Creative Plan'
  program_type text,                           -- 'DFY' | 'DIY' — from 'Which program is the client going for?'

  -- Context
  industry text,
  location text,

  -- Provisional derived attribution
  -- HYPOTHESIS: populated setter_record_ids = setter-led; empty = direct-booking-led.
  -- Discovery sample had Setter Name EMPTY on all 3 records — fill rate unconfirmed.
  -- Dashboard MUST flag this column as provisional until a wider fill-rate
  -- check (~100 records) confirms or refutes the hypothesis.
  is_setter_led boolean,

  -- Catch-all — SOURCE OF TRUTH for every Airtable field including:
  --   * The five flagged aggregation-layer-pending ambiguities (objection
  --     categorization free-text, two typo'd Financed/Cash/Both fields,
  --     the other two payment-on-call duplicate fields)
  --   * All payment-installment fields (Date of 1st-5th payment / Amount of
  --     1st-5th payment / Select Date of 2nd-4th payment)
  --   * Partner-* fields (Partner Name / Email / Phone)
  --   * Age, ad_name, Did they watch the VSL?, What's their likely start date?,
  --     Describe the payment plan you gave them, Payment Schedule, etc.
  --   * AUS-only fields (when region='AUS')
  fields_raw jsonb not null,

  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table airtable_full_closer_report is
  'Airtable Full Closer Report mirror — US + AUS variants unioned via region discriminator. PK = Airtable record_id (globally unique across regions). Feeds Engine-sheet Closing section rows 96-116. NO stored timestamp field — record-level airtable_created_at is created-only; edits invisible to cron, webhook required for edit-detection.';

comment on column airtable_full_closer_report.region is
  '''US'' for tblYsh3fxTpXuPdIW (Full Closer Report Form, 66 fields), ''AUS'' for tblcC25y6lMrtgcty (Full Closer Report Form - AUS, 64 fields). Field sets overlap ~entirely; AUS-only fields land in fields_raw.';

comment on column airtable_full_closer_report.is_setter_led is
  'PROVISIONAL derived attribution: cardinality(setter_record_ids) > 0. Hypothesis (unconfirmed at ingestion ship): populated setter_record_ids = setter-led; empty = direct-booking-led. Discovery sample had Setter Name empty on all 3 records — fill rate needs wider sample (~100 records) to confirm. Dashboard MUST surface as provisional until confirmed.';

comment on column airtable_full_closer_report.call_notes_lost is
  'Free-text "Call Notes (Lead lost):" field. LIKELY source for objection categorization (Shopping Around / Think-About-It-Fear / Spouse — Engine rows pending) since no structured field categorizes objections in this table. Dashboard read + categorize (LLM or manual).';

comment on column airtable_full_closer_report.amount_paid_today_currency is
  'Airtable "How much did they pay today?/How much are they paying upfront?" currency field. AMBIGUITY: a parallel number-typed field (amount_paid_today_number) exists for similar semantic. Both mirrored; dashboard picks canonical.';

comment on column airtable_full_closer_report.amount_paid_today_number is
  'Airtable "Amount they paid today?" number field. AMBIGUITY: a parallel currency-typed field (amount_paid_today_currency) exists for similar semantic. Both mirrored; dashboard picks canonical.';

comment on column airtable_full_closer_report.fields_raw is
  'Complete Airtable fields{} dict at last upsert. Source of truth for every Airtable field, including the 5 aggregation-layer-pending ambiguities (objection categorization free-text, typo''d Financed/Cash/Both, the other 2 payment-on-call duplicate fields), all 10 payment-installment fields, Partner-*, and AUS-only fields. Empty-valued Airtable fields are OMITTED (API behavior).';

-- Indexes — aggregation queries pivot on:
--   * (date_time_of_call desc) — Engine rollups are date-bounded
--   * (closed) WHERE closed='Yes' — closed-deals filter for nearly every Closing metric
--   * GIN on closer_record_ids — per-closer queries
--   * GIN on fields_raw — fallback query path for any non-promoted field
--   * (region) — split-by-region dashboard cuts
create index airtable_full_closer_report_call_date_idx
  on airtable_full_closer_report (date_time_of_call desc);
create index airtable_full_closer_report_closed_idx
  on airtable_full_closer_report (closed) where closed = 'Yes';
create index airtable_full_closer_report_closer_ids_gin
  on airtable_full_closer_report using gin (closer_record_ids);
create index airtable_full_closer_report_fields_raw_gin
  on airtable_full_closer_report using gin (fields_raw);
create index airtable_full_closer_report_region_idx
  on airtable_full_closer_report (region);
create index airtable_full_closer_report_created_idx
  on airtable_full_closer_report (airtable_created_at desc);

create trigger airtable_full_closer_report_set_updated_at
  before update on airtable_full_closer_report
  for each row execute function set_updated_at();
