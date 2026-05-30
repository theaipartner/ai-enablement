-- 0059_triage_call_soft_hide.sql
--
-- Creator-only "hide test call" on the per-rep Call Activity drill
-- (sales-dashboard → Funnel → Appointment Setting). A test EOC form
-- submission shows up as a triage "call"; the creator can × it out.
--
-- Why soft-hide (not delete): airtable_setter_triage_calls is a mirror.
-- The Airtable sync (cron + webhook) is upsert-only with NO delete pass,
-- so a hard DELETE would be re-created on the next sync, and deleting in
-- Airtable does not propagate to us either. excluded_at survives re-sync
-- because the ingestion parser only writes Airtable-sourced columns and
-- never touches these two — the soft-hide is permanent.
--
-- The dashboard's per-rep fetchers (getCallActivityMetrics,
-- getCallActivityForUser) filter `excluded_at is null`, so a hidden row
-- drops out of both the per-rep counts and the drill list.
--
-- No index: `excluded_at is null` is true for ~all rows (a residual
-- filter, not a selective one) and the existing airtable_created_at
-- index already covers the in-window scan. An index here would not be
-- used.

alter table airtable_setter_triage_calls
  add column if not exists excluded_at timestamptz,
  add column if not exists excluded_by text;

comment on column airtable_setter_triage_calls.excluded_at is
  'Soft-hide timestamp. Non-null = the row was marked a test/bad entry and is excluded from the dashboard (per-rep Call Activity counts + drill). Set by the creator-only "×" action; survives Airtable re-sync because ingestion never writes this column. Null = visible (normal).';

comment on column airtable_setter_triage_calls.excluded_by is
  'team_members.email of the creator who hid this row (audit trail for the soft-hide). Null when not excluded.';
