-- 0098_lead_cycle_stages_disposition.sql
-- Add no-show + follow-up disposition timestamps to the per-phase stage row.
-- The roster "latest stage" becomes a latest-by-timestamp DISPOSITION: these two
-- new events join the existing connected/booked/confirmed/showed/closed (+ dq_at
-- on lead_cycles) so the read layer (getLeadCycleRows) can pick the most-recent
-- disposition rather than the furthest-stage ladder.
--
-- Both columns are nullable + additive: the tagger insert is an explicit column
-- list (delete-then-insert, so a retag rebuilds cleanly) and every reader —
-- sales_funnel_counts (0079/0084/0085/0087/0088), getLeadCycleRows, lead-detail —
-- references columns by name, so two new nullable columns are invisible to them.
--
-- Populated by the tagger (shared/lead_tagging.py); a retag backfills history:
--   - no_show_at:   a closer "Client Ghosted (no show)" / Old Showed?=No form
--                   (primary), or a booked Calendly call whose start passed >4h
--                   with no closer form (backup).
--   - follow_up_at: a closer "Short/Long-Term Follow Up" form (primary), or an
--                   "AI Partner Sync" Calendly booking with no form (backup).

alter table lead_cycle_stages
  add column if not exists no_show_at    timestamptz,
  add column if not exists follow_up_at  timestamptz;
