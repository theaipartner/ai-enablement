-- 0043_close_ingestion_tables.sql
-- Close CRM mirror tables — the foundation of the Gregory sales-side
-- surface (CEO/business-engine dashboard).
--
-- Spec: docs/specs/close-ingestion-v1.md.
-- Discovery inputs:
--   - docs/reports/close-smartview-discovery.md (endpoints, 11-status pipeline)
--   - docs/reports/close-full-data-inventory.md (real activity density,
--     populated cf inventory, opportunities-are-$1-placeholders)
--
-- Design principle (CLAUDE.md § Core Principles #1+#2): our DB is the
-- source of truth; agents query Supabase, not Close. These tables mirror
-- Close raw objects so the Gregory aggregation layer can compute the
-- Engine-sheet APPOINTMENT SETTING + CLOSING metrics in SQL without
-- live calls to Close.
--
-- Scope decisions (per spec + Step-0 CSV reconciliation):
--   - Primary target: APPOINTMENT SETTING (33 Close-sourced rows + 13
--     derived rates). The Engine sheet's CLOSING section is sourced
--     from Closer EOC Forms / Calendly / Fathom — only one row
--     ("Follow Up Looms Sent") comes from Close. So payment / cash /
--     deal cfs are mirrored for completeness + cross-validation but
--     are NOT the canonical money source.
--   - SMS over Email: 67% vs 6% activity share; Drake confirmed
--     First Message Response = SMS + Call, NOT email. We mirror SMS;
--     skip Email for V1.
--   - Opportunities mirrored despite $1 placeholder value because
--     `OpportunityStatusChange` events (Opt-Ins → Confirmed booking →
--     DQ) give a parallel workflow signal worth keeping. The `value`
--     column is mirrored but treated as workflow data, not money.
--   - Lead custom fields: 52 of 88 populated. Funnel-relevant subset
--     (~30) denormalized as typed columns; the full `custom.cf_*` map
--     kept in `custom_fields_raw` jsonb for forward-compat without a
--     migration per new field.
--
-- Idempotency keys are Close's stable IDs (`lead_*`, `acti_*`, `oppo_*`,
-- `cf_*`). Re-running the backfill or pipeline never duplicates rows.
-- Every table is upsert-shaped on its `close_id` primary key.
--
-- Triage-count-path canonical choice (documented in
-- docs/runbooks/close_ingestion.md): "Total Closer Triages" uses the
-- `triage_showed = 'Yes'` lead custom field, not the lead-status-change
-- event. Reasoning: Drake's spec definition of triage is "the phone
-- call where a human qualifies the lead" — a status-change to
-- 'Unconfirmed Booking - Handed over' marks the hand-over, not the
-- triage call itself. The runbook documents the gap risk (cf is
-- sparsely populated — closers must fill it in).
--
-- Tier derivation (denormalized into `close_leads.tier`): Tier 1 =
-- qualified (≥ $2k disposable income per Typeform `investment` cf);
-- Tier 2 = unqualified (< $2k). Ingestion-layer logic parses
-- `investment` text values and writes `tier`. The runbook documents
-- the value-to-tier mapping; mapping is conservative on unknowns
-- (leaves tier null rather than defaulting to a side).

-- ============================================================================
-- close_custom_field_definitions — cf_id → name/type/choices reference
-- ============================================================================
--
-- Cheap, small (~100 rows), high-value. Lets the aggregation layer
-- resolve `cf_*` IDs to human labels without hardcoding. Synced fresh
-- on every backfill run; updates are idempotent on close_id PK.

create table close_custom_field_definitions (
  close_id text primary key,
  object_type text not null,
  name text not null,
  type text not null,
  choices jsonb,
  accepts_multiple_values boolean,
  is_shared boolean,
  description text,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table close_custom_field_definitions is
  'Mirror of Close CRM custom-field definitions. Reference table; ~100 rows. Populated by ingestion/close/ from /custom_field_schema/{object_type}/. Read by the Gregory aggregation layer to resolve cf_* IDs to human labels.';

create index close_custom_field_definitions_object_type_idx
  on close_custom_field_definitions (object_type);

create trigger close_custom_field_definitions_set_updated_at
  before update on close_custom_field_definitions
  for each row execute function set_updated_at();

-- ============================================================================
-- close_leads — denormalized lead mirror
-- ============================================================================
--
-- The funnel-relevant lead custom-field subset is denormalized as typed
-- columns for fast aggregation queries. The complete `custom.cf_*` map
-- is kept in `custom_fields_raw` jsonb so any future field can be
-- consumed without a migration.
--
-- Text-typed money / Yes-No fields are mirrored as text — the source
-- values in Close are text-typed (`'1133'`, `'Yes'`, `'TRUE'`) and may
-- carry dirt (`'$1,133'`, `'1,133.00'`). The aggregation layer casts
-- in SQL with defensive cleaning; ingestion stores the raw value to
-- preserve auditability.
--
-- `tier` is the only denormalized column NOT directly from a Close cf —
-- it's derived in ingestion from `investment` per Drake's confirmed
-- business logic (≥ $2k disposable income → tier_1). Refresh on every
-- lead upsert; stored so dashboard queries don't re-derive at read time.

create table close_leads (
  -- Identity + core lead fields
  close_id text primary key,
  display_name text,
  description text,
  url text,
  status_id text,
  status_label text,

  -- Contacts / addresses kept as raw jsonb (rarely queried; never the
  -- primary aggregation surface — Close contact emails come through
  -- per-call participants in the existing Fathom flow, not this one).
  contacts jsonb,
  addresses jsonb,

  -- Ownership / authorship
  created_by text,
  updated_by text,

  -- Lifecycle timestamps from Close
  date_created timestamptz,
  date_updated timestamptz,

  -- Marketing attribution (~100% populated per inventory report — the
  -- spine of the FUNNELS section + cost-per-X derived rates)
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_term text,
  source text,
  funnel_name text,
  funnel_type text,
  ad_name text,
  ad_id text,
  adset_id text,
  campaign_id text,

  -- Opt-in lifecycle
  date_first_opted_in date,
  latest_opt_in_date timestamptz,
  number_of_opt_ins integer,

  -- Qualification signals (form-level — the Typeform output)
  investment text,
  monthly_income text,
  marketing_qualified text,
  overnight_lead text,

  -- Derived tier (tier_1 = qualified for closer; tier_2 = unqualified,
  -- routes to setter / digital college). NULL when investment can't be
  -- classified. Refreshed in ingestion on every upsert.
  tier text,

  -- Booking lifecycle (~70% populated)
  date_of_first_booked_call date,
  latest_date_of_booked_call date,
  date_call_scheduled_for timestamptz,
  direct_call_booked text,
  confirmed_booking text,
  call_connected text,
  date_first_connected date,
  showed text,
  triage_showed text,

  -- Ownership cfs (user_id strings)
  closer_owner_id text,
  setter_owner_id text,

  -- Cancellation / reschedule lifecycle
  no_show_or_cancellation text,
  no_show_or_cancellation_date timestamptz,
  number_of_reschedules integer,

  -- Closing / payment cfs (sparse — populated on closed leads only;
  -- mirrored for cross-validation against EOC Forms, NOT canonical)
  type_of_payment_on_call text,
  date_contract_sent date,
  contract_sent text,
  closed text,
  lost_deal text,
  date_closed date,
  payment_plan_type text,
  total_monthly_creative_payments text,
  amount_of_1st_payment text,
  amount_of_2nd_payment text,
  amount_of_3rd_payment text,
  amount_of_4th_payment text,
  amount_of_5th_payment text,
  date_of_1st_payment date,
  date_of_2nd_payment date,
  date_of_3rd_payment date,
  date_of_4th_payment date,
  date_of_5th_payment date,

  -- Cross-system join keys
  airtable_student_record_id text,

  -- Catch-all for the remaining 50+ custom fields (current + future).
  -- Map of "cf_xxxx" → raw value. Aggregation layer can query this with
  -- jsonb operators when a denormalized column isn't available.
  custom_fields_raw jsonb not null default '{}'::jsonb,

  -- Full raw payload for audit / re-parse if the parser evolves.
  raw_payload jsonb,

  -- Our lifecycle
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table close_leads is
  'Mirror of Close CRM lead objects. Funnel-relevant custom fields denormalized as typed columns; full cf map kept in custom_fields_raw jsonb. Idempotent on close_id PK. Populated by ingestion/close/pipeline.py via scripts/backfill_close.py + the polling cron. Read by the Gregory sales-side aggregation layer; never queried by agents directly.';

-- Aggregation queries pivot on these:
--   - status_id (per-status counts, funnel-stage snapshots)
--   - date_created / date_updated (cohort windows)
--   - date_first_opted_in (opt-in cohort attribution)
--   - tier (Tier 1 / Tier 2 booked-meeting splits)
--   - closer_owner_id / setter_owner_id (per-rep performance)
create index close_leads_status_id_idx on close_leads (status_id);
create index close_leads_date_created_idx on close_leads (date_created desc);
create index close_leads_date_updated_idx on close_leads (date_updated desc);
create index close_leads_date_first_opted_in_idx on close_leads (date_first_opted_in desc);
create index close_leads_tier_idx on close_leads (tier) where tier is not null;
create index close_leads_closer_owner_idx on close_leads (closer_owner_id) where closer_owner_id is not null;
create index close_leads_setter_owner_idx on close_leads (setter_owner_id) where setter_owner_id is not null;
create index close_leads_funnel_name_idx on close_leads (funnel_name) where funnel_name is not null;
create index close_leads_campaign_id_idx on close_leads (campaign_id) where campaign_id is not null;

create trigger close_leads_set_updated_at
  before update on close_leads
  for each row execute function set_updated_at();

-- ============================================================================
-- close_lead_status_changes — funnel-spine event stream
-- ============================================================================
--
-- Timestamped record of every lead-status transition. This is the spine
-- for hand-down / hand-off / booking / no-show / DQ / downsell / deposit
-- / client daily counts. Per the inventory report, 51 events across 25
-- sampled leads — densely populated.
--
-- Cross-table FK to close_leads is deliberately omitted — backfill order
-- doesn't always guarantee the lead row lands first (large activity
-- pulls per-lead happen as we walk leads, but we want the table to be
-- usable even if a status-change row arrives before its lead is fully
-- mirrored). Aggregation layer left-joins; loose FK keeps backfill
-- resilient. Same pattern used downstream for close_calls / close_sms.

create table close_lead_status_changes (
  close_id text primary key,
  lead_id text not null,
  old_status_id text,
  old_status_label text,
  new_status_id text,
  new_status_label text,
  user_id text,
  date_created timestamptz,
  raw_payload jsonb,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table close_lead_status_changes is
  'Mirror of Close LeadStatusChange activities — the funnel-spine event stream. Aggregation source for Hand Downs / DQs / Downsells / Booked Meetings / No Shows / Deposits / Client (status-flip counts per period). Idempotent on close_id PK.';

-- Aggregation queries pivot on (new_status_id, date_created) for
-- per-day "leads that became X" counts.
create index close_lead_status_changes_new_status_date_idx
  on close_lead_status_changes (new_status_id, date_created desc);
create index close_lead_status_changes_lead_id_idx
  on close_lead_status_changes (lead_id, date_created desc);
create index close_lead_status_changes_date_idx
  on close_lead_status_changes (date_created desc);

create trigger close_lead_status_changes_set_updated_at
  before update on close_lead_status_changes
  for each row execute function set_updated_at();

-- ============================================================================
-- close_calls — Call activity mirror
-- ============================================================================
--
-- The Engine sheet's "Setter Dials", "Closer Dials", "Average Time to
-- Closer Dial", "Calls Connected", "Average Closer Triage Call
-- Duration" all derive from here. Per the inventory report: 87 calls
-- across 25 leads, 84% of leads have ≥1 call, 5 distinct setter/closer
-- user_ids in the sample.
--
-- `duration` is in seconds (Close convention — confirmed in inventory).
-- "Connected" = duration > 0 (Close's own /report/activity/ metric
-- `leads.contacted.all.count` uses this).

create table close_calls (
  close_id text primary key,
  lead_id text not null,
  contact_id text,
  user_id text,
  direction text,                 -- 'inbound' | 'outbound' | null
  status text,                    -- 'completed' | 'no-answer' | etc.
  duration integer,               -- seconds
  disposition text,
  voicemail_url text,
  recording_url text,
  phone text,
  local_phone text,
  remote_phone text,
  note text,
  dialer_id text,                 -- 'power_dialer' | 'predictive_dialer' | null
  source text,
  date_created timestamptz,
  activity_at timestamptz,
  raw_payload jsonb,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table close_calls is
  'Mirror of Close Call activities. Aggregation source for Setter/Closer Dials, Calls Connected, time-to-first-dial, triage-call duration. Idempotent on close_id PK.';

-- Aggregation queries pivot on (user_id, date_created) for per-rep dial
-- counts and on (direction, date_created) for inbound/outbound splits.
create index close_calls_user_date_idx on close_calls (user_id, date_created desc) where user_id is not null;
create index close_calls_lead_id_idx on close_calls (lead_id, date_created desc);
create index close_calls_direction_date_idx on close_calls (direction, date_created desc);
create index close_calls_date_idx on close_calls (date_created desc);

create trigger close_calls_set_updated_at
  before update on close_calls
  for each row execute function set_updated_at();

-- ============================================================================
-- close_sms — SMS activity mirror (the dominant channel)
-- ============================================================================
--
-- 67% of all activity in the inventory sample. The auto-SMS-on-opt-in
-- flow that defines the funnel entry point lives here. "First Message
-- Response" per Drake's confirmed semantic = first incoming SMS in
-- response to the auto-outbound SMS (channel-agnostic with Call, NOT
-- email).

create table close_sms (
  close_id text primary key,
  lead_id text not null,
  contact_id text,
  user_id text,
  direction text,                 -- 'inbound' | 'outbound'
  status text,                    -- 'sent' | 'delivered' | 'inbound' | ...
  text text,                      -- the message body
  local_phone text,
  remote_phone text,
  date_created timestamptz,
  date_sent timestamptz,
  activity_at timestamptz,
  raw_payload jsonb,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table close_sms is
  'Mirror of Close SMS activities — dominant channel (67% of activity in inventory sample). Aggregation source for First Message Response (inbound after auto-outbound).';

create index close_sms_lead_id_idx on close_sms (lead_id, date_created desc);
create index close_sms_direction_date_idx on close_sms (direction, date_created desc);
create index close_sms_date_idx on close_sms (date_created desc);

create trigger close_sms_set_updated_at
  before update on close_sms
  for each row execute function set_updated_at();

-- ============================================================================
-- close_opportunities — workflow-marker mirror (NOT money)
-- ============================================================================
--
-- All opportunities in the inventory sample have value=$1 placeholder.
-- Mirror provides the parallel state machine (Opt-Ins → Confirmed
-- booking → DQ) which gives a coarser funnel signal than the lead-
-- status pipeline. Useful when the team wants "how many opportunities
-- entered Confirmed booking today" vs the lead-status equivalent.
--
-- `value` is mirrored for completeness — DO NOT use as money. The
-- canonical money source for closing-funnel metrics is the Closer EOC
-- Forms (Engine sheet § CLOSING). Close cfs `amount_of_Nth_payment?`
-- on close_leads are a secondary cross-validation source, NOT this
-- column.

create table close_opportunities (
  close_id text primary key,
  lead_id text not null,
  status_id text,
  status_label text,
  status_type text,               -- 'active' | 'won' | 'lost'
  value integer,                  -- cents (Close convention); $1 placeholders in this org
  value_currency text,
  value_period text,              -- 'one_time' | 'monthly' | 'annual'
  value_formatted text,
  annualized_value integer,
  expected_value integer,
  note text,
  user_id text,
  contact_id text,
  created_by text,
  updated_by text,
  date_created timestamptz,
  date_updated timestamptz,
  date_won date,
  date_lost date,
  confidence integer,
  raw_payload jsonb,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table close_opportunities is
  'Mirror of Close Opportunity objects. Workflow markers (Opt-Ins / Confirmed booking / DQ), NOT money — values are $1 placeholders in this org. Canonical closing-funnel money lives in Closer EOC Forms; close_leads payment cfs are secondary cross-validation.';

create index close_opportunities_lead_id_idx on close_opportunities (lead_id);
create index close_opportunities_status_id_idx on close_opportunities (status_id, date_created desc);
create index close_opportunities_date_won_idx on close_opportunities (date_won desc) where date_won is not null;
create index close_opportunities_date_lost_idx on close_opportunities (date_lost desc) where date_lost is not null;

create trigger close_opportunities_set_updated_at
  before update on close_opportunities
  for each row execute function set_updated_at();
