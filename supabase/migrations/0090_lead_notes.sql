-- 0090_lead_notes.sql
--
-- Free-text scratchpad note per lead, shown + edited on the per-lead page
-- (/sales-dashboard/leads/[close_id]). One editable note per Close lead —
-- typed in, saved, overwrites the prior text (not a timestamped thread).
--
-- Sales-owned, standalone (keyed by close_id, no FK to the close_leads
-- mirror) so a Close re-sync can never touch it. `updated_by` stamps the
-- editor's name for the "last edited by" line; `updated_at` via trigger.
--
-- Schema doc: docs/schema/lead_notes.md.

create table lead_notes (
  close_id text primary key,            -- Close lead id this note belongs to
  note text not null default '',
  updated_by text,                      -- team member full_name who last saved
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table lead_notes is
  'Free-text scratchpad note per Close lead, edited on the per-lead page. One editable note per lead (overwrite, not a thread). Standalone (no FK) so Close re-sync never touches it. See docs/schema/lead_notes.md.';
comment on column lead_notes.close_id is
  'Close lead id (matches close_leads.close_id). PK — one note per lead.';
comment on column lead_notes.updated_by is
  'full_name of the team member who last saved the note (from team_members).';

create trigger lead_notes_set_updated_at
  before update on lead_notes
  for each row execute function set_updated_at();
