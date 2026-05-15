-- 0037_trustpilot_cascade_first_month_carve_out.sql
-- Trustpilot cascade: first-month carve-out.
--
-- Scott's ask (2026-05-15): the M5.7 cascade (migration 0024) currently
-- flips clients.trustpilot_status = 'ask' on every transition to
-- csm_standing='happy'. New clients should be excluded — they're too
-- early in the relationship to ask for a public review. "First month" =
-- 30 days from clients.start_date.
--
-- ============================================================================
-- What changes vs 0024
-- ============================================================================
--
-- The trigger function `clients_trustpilot_cascade_on_happy_before` is
-- unchanged — it still mutates NEW.trustpilot_status := 'ask'.
--
-- The trigger WHEN clause gains two semantic gates:
--
--   3. NEW.start_date IS NOT NULL
--   4. NEW.start_date <= (current_date - interval '30 days')
--
-- Postgres requires drop + recreate to change a trigger's WHEN clause —
-- CREATE OR REPLACE TRIGGER cannot mutate WHEN. So the migration drops
-- the existing trigger and re-creates it with the extended condition.
--
-- ============================================================================
-- NULL handling decision
-- ============================================================================
--
-- NEW.start_date IS NOT NULL is added as an explicit gate. A NULL
-- start_date means "we don't know when this client started." Scott's
-- intent is "don't ask new clients"; the precautionary read of an
-- unknown start is "treat as new, don't cascade." A CSM can still
-- manually flip trustpilot_status to 'ask' via the dashboard if they
-- decide an undated client is mature enough to ask.
--
-- ============================================================================
-- 30-day choice (not '1 month'::interval)
-- ============================================================================
--
-- interval '30 days' is calendar-flat — every day counts the same.
-- interval '1 month' is month-relative and shifts the cutoff day-by-day
-- (Feb 28 + 1 month is Mar 28, not Mar 30; Mar 31 + 1 month is Apr 30,
-- one day later by calendar). 30-day flat is easier to reason about for
-- both Scott and for future debugging. Trade-off accepted: clients
-- starting in late-January-shorter-month edge cases get cascade fire one
-- day earlier than a strict '1 month' would imply. Not a meaningful
-- difference for the use case.
--
-- ============================================================================
-- Trigger is BEFORE UPDATE — date check is against the in-flight row
-- ============================================================================
--
-- BEFORE-row triggers see NEW.* mutations from earlier triggers in
-- alphabetical order (see 0024's comment block on the M5.6/M5.7 fire
-- order). NEW.start_date is rarely mutated by the M5.6 status cascade,
-- so the carve-out gate evaluates the actual stored start_date in
-- almost every case. The current_date function evaluates in the trigger
-- session's cluster timezone (UTC for Supabase). A CSM in Australia
-- transitioning a client at their local midnight whose start_date is
-- 30 days ago in their tz but 29 days in UTC will see "new client" —
-- the carve-out is approximate by 24 hours by design.
--
-- ============================================================================
-- Forward-only — no backfill
-- ============================================================================
--
-- Existing clients already in csm_standing='happy' with non-'ask'
-- trustpilot_status stay where they are — same forward-only design as
-- the original 0024. The cascade fires on TRANSITION, not on PRESENCE.

drop trigger if exists clients_trustpilot_cascade_on_happy_before on clients;

create trigger clients_trustpilot_cascade_on_happy_before
  before update on clients
  for each row
  when (
    OLD.csm_standing is distinct from NEW.csm_standing
    and NEW.csm_standing = 'happy'
    and NEW.start_date is not null
    and NEW.start_date <= (current_date - interval '30 days')
  )
  execute function clients_trustpilot_cascade_on_happy_before();

comment on function clients_trustpilot_cascade_on_happy_before is
  'BEFORE UPDATE trigger function for the M5.7 trustpilot cascade. Sets clients.trustpilot_status = ''ask'' when csm_standing transitions to ''happy''. Gating happens in the trigger WHEN clause (see 0024 + 0037); this function just mutates the NEW row. 0037 (2026-05-15) extended the WHEN clause with a first-month carve-out (start_date not null AND start_date <= current_date - 30 days).';
