-- 0060_close_leads_soft_hide.sql
--
-- Creator-only "hide fake lead" × on the Leads page (sales-dashboard →
-- Leads) and the Appointment Setting "Lead List". The creator can × out
-- a lead they entered or that came in by mistake, scoped to creator tier.
--
-- Why soft-hide (not delete): close_leads is a Close CRM mirror. The
-- Close sync (polling + webhook) is upsert-only with no delete pass, so
-- a hard DELETE would be re-created on the next sync. excluded_at
-- survives re-sync because the Close ingestion parser only writes
-- Close-sourced columns and never touches these two (verified) — the
-- soft-hide is permanent and reversible (clear excluded_at to un-hide).
--
-- Scope of the hide: the LEAD-LIST surfaces filter `excluded_at is null`
-- (getSpeedToLeadCohort → the Leads page + the Appointment Setting lead
-- list). The per-rep Call Activity tables (getCallActivityMetrics) do
-- NOT filter — a hidden lead's dials still count toward the rep, per
-- Drake 2026-05-29.
--
-- No index: `excluded_at is null` is true for ~all rows (residual
-- filter, not selective); the existing date_created index covers the
-- cohort scan.

alter table close_leads
  add column if not exists excluded_at timestamptz,
  add column if not exists excluded_by text;

comment on column close_leads.excluded_at is
  'Soft-hide timestamp. Non-null = the lead was marked fake/mistaken and is excluded from the lead-list surfaces (Leads page + Appointment Setting lead list). Set by the creator-only "×" action; survives Close re-sync because ingestion never writes this column. Per-rep Call Activity is NOT affected. Null = visible.';

comment on column close_leads.excluded_by is
  'team_members.email of the creator who hid this lead (audit trail). Null when not excluded.';
