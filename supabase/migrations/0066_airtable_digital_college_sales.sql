-- 0066_airtable_digital_college_sales.sql
--
-- Digital College (low-ticket) sale form mirror. Source = the Airtable
-- "Digital College" table (tbljmzRoMoE5B26lt) in the sales base
-- appCWa6TV6p7EBarC. The dedicated low-ticket closer (Robby Bryant)
-- fills this form end-to-end. Aman's downsell DC closes continue to live
-- on airtable_full_closer_report (call_outcome = 'Digital College Closed');
-- this table is the dedicated low-ticket path.
--
-- Source of truth is Airtable; this is a mirror populated by the SAME
-- ingestion pipeline (webhook + cron) as the other two Airtable mirrors.
-- PK is the Airtable record id. fields_raw holds the COMPLETE field set;
-- typed columns are promoted for queryability. The webhook watches the
-- whole base and filters to TARGET_TABLES in the receiver, so adding this
-- table needs NO webhook re-registration.
--
-- Like the other Airtable tables, there is no stored created/modified
-- FIELD, so incremental sync uses Airtable's record-level createdTime
-- metadata (create-detection via cron; edit-detection via webhook).

create table if not exists airtable_digital_college_sales (
  record_id text primary key,
  airtable_created_at timestamptz,
  lead_id text,
  prospect_name text,
  date_time_of_call timestamptz,
  closer_record_ids text[],
  closer_names text[],
  setter_record_ids text[],
  setter_names text[],
  closed text,            -- 'Closed?' Yes/No — the explicit DC close flag
  plans text[],           -- 'What plan did we get them on?' — Base/Wix x Monthly/Yearly
  follow_up text,         -- 'Follow Up?' Yes/No
  follow_up_date date,
  call_notes text,
  fields_raw jsonb,
  excluded_at timestamptz,
  excluded_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table airtable_digital_college_sales is
  'Mirror of the Airtable Digital College sale form (tbljmzRoMoE5B26lt) — the low-ticket offer. Populated by the airtable ingestion pipeline (webhook + cron). fields_raw is the complete field set. Robby Bryant is the dedicated low-ticket closer; Aman downsell DC closes live on airtable_full_closer_report.';

comment on column airtable_digital_college_sales.closed is
  'Closed? Yes/No — the explicit DC close flag. Yes = a Digital College close.';
comment on column airtable_digital_college_sales.plans is
  'What plan did we get them on? — multi-select of Base Monthly / Base Yearly / Wix Monthly / Wix Yearly. "Base" = Base44. A close can include Base, Wix, or both.';
comment on column airtable_digital_college_sales.excluded_at is
  'Soft-hide timestamp (creator-only). NULL = visible. Set via the dashboard x action; never written by ingestion.';

create index if not exists idx_dc_sales_lead_id
  on airtable_digital_college_sales (lead_id);
create index if not exists idx_dc_sales_created
  on airtable_digital_college_sales (airtable_created_at);
create index if not exists idx_dc_sales_call_time
  on airtable_digital_college_sales (date_time_of_call);
