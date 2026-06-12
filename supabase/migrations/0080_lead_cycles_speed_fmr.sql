-- 0080_lead_cycles_speed_fmr.sql
-- Per-cycle speed-to-lead + FMR facts, materialized by the tagger so the leads
-- page reads them instead of scanning ~58k SMS + ~18k calls live. Anchored to
-- the cycle's opt_in_at. Verified per-lead against the live computation (Phase 1).
alter table lead_cycles
  add column if not exists first_call_at                timestamptz,
  add column if not exists intensity                    integer,
  add column if not exists any_call_connected           boolean,
  add column if not exists first_two_dials_connected     boolean,
  add column if not exists caller_user_id               text,
  add column if not exists total_connected_duration_sec  integer,
  add column if not exists connected_call_count          integer,
  add column if not exists earliest_inbound_at           timestamptz,
  add column if not exists earliest_connect_at           timestamptz;
