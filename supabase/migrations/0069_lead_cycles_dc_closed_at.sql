-- 0069_lead_cycles_dc_closed_at.sql
--
-- Persist the per-cycle Digital College close (the tagger already computes it as
-- a reactivation-blocking terminal; this stores it so the funnel can show a
-- small "DC: N closed" line per box without re-deriving from raw forms). HT-only
-- stays HT-only: DC closes live HERE, never in lead_cycle_stages.closed_at, so
-- the HT funnel is unaffected.
--
-- dc_closed_at = earliest DC close in the cycle (a closer-EOC 'Digital College
-- Closed' outcome, on Robby's call OR an Aman downsell). null = no DC close.
-- Set by shared/lead_tagging.py; read by the leads funnel.

alter table lead_cycles
  add column if not exists dc_closed_at timestamptz;

comment on column lead_cycles.dc_closed_at is
  'Earliest Digital College close in the cycle (closer-EOC ''Digital College Closed''). DC is excluded from the HT journey stages, so this is the ONLY place a DC close is recorded on the cycle. null = no DC close. Drives the per-box "DC: N closed" line on the leads funnel.';
