-- 0111_airtable_rep_eods.sql
-- Mirror of the Airtable Setter EOD's + Closer EOD's tables (base
-- appCWa6TV6p7EBarC: tblnGf0NoNCWVwOsz / tbly2S13lmo82xy5e) for the per-rep EOD
-- section on the roster detail page (/sales-dashboard/people/by-rep?rep=).
--
-- One table for both kinds: the setter/closer field sets differ a lot and the
-- forms are sparse + expected to grow, so the full Airtable record lives in
-- `fields_raw` (the dashboard renders the labeled fields) with just the join +
-- date promoted. PK is `record_id` to match the shared Airtable upsert path
-- (_upsert_batch uses on_conflict="record_id").
--
-- The rep is resolved via `rep_record_id` = the Sales Team Member rec id (the
-- form's "Sales Person"/"Closer" link) = team_members.airtable_user_id.

create table if not exists airtable_rep_eods (
  record_id           text primary key,          -- Airtable EOD record id
  kind                text not null check (kind in ('setter', 'closer')),
  rep_record_id       text,                       -- Sales Team Member rec id == team_members.airtable_user_id
  eod_date            date,                       -- Setter "Date" / Closer "Submitted At"
  airtable_created_at  timestamptz,
  fields_raw          jsonb not null default '{}'::jsonb,
  synced_at           timestamptz not null default now()
);

-- Per-rep read: rep_record_id + eod_date window.
create index if not exists ix_airtable_rep_eods_rep_date
  on airtable_rep_eods (rep_record_id, eod_date);

comment on table airtable_rep_eods is
  'Mirror of the Airtable Setter EOD''s + Closer EOD''s tables. One row per EOD; kind discriminates setter vs closer. Full record in fields_raw (the roster detail page renders the labeled fields); rep_record_id (= team_members.airtable_user_id) + eod_date promoted. Upserted by the Airtable ingestion pipeline; read by lib/db/funnel-roster EOD reader.';

alter table airtable_rep_eods enable row level security;
