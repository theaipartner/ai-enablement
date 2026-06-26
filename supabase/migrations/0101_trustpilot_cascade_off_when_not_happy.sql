-- 0101_trustpilot_cascade_off_when_not_happy.sql
-- Reverse Trustpilot cascade: only happy clients get the "ask".
--
-- Context: migration 0024 (+ 0037 first-month carve-out) added the forward
-- cascade — csm_standing transitions TO 'happy' sets trustpilot_status='ask'.
-- There was no reverse: a client sliding to content / at_risk / problem kept a
-- pending 'ask'/'asked', so we'd solicit a public review from an unhappy client.
--
-- This adds the mirror trigger. Trustpilot vocabulary (0020): yes = review
-- given · no = don't ask · ask = not given, should ask · asked = ask pending.
-- Rule (Drake, 2026-06-25): "only happy clients get the ask." Any transition to
-- a NON-happy standing flips trustpilot_status to 'no'.
--
-- Two guards:
--   * Tiers: content / at_risk / problem only. A NULL standing ("unknown") is
--     deliberately excluded — we don't auto-act on an unknown standing, same
--     conservative stance as 0037's NULL start_date handling.
--   * Never overwrite 'yes'. A given review is permanent — if a client already
--     left one and then goes negative, the 'yes' stays. The WHEN clause checks
--     NEW.trustpilot_status so a same-statement set to 'yes' is also respected.
--
-- No first-month carve-out on this direction: an unhappy client should never be
-- asked, regardless of tenure.
--
-- ============================================================================
-- Trigger ordering (mirrors the 0024/0037 analysis)
-- ============================================================================
-- BEFORE-row triggers fire alphabetically by name:
--   clients_set_updated_at
--   clients_status_cascade_before                 (status→negative: sets csm_standing='at_risk')
--   clients_trustpilot_cascade_off_unhappy_before (this one)
--   clients_trustpilot_cascade_on_happy_before
-- The status cascade fires first, so a status→ghost/paused/leave/churned UPDATE
-- finalizes NEW.csm_standing='at_risk' before this trigger's WHEN re-evaluates —
-- meaning a churned client also correctly lands on trustpilot_status='no'. The
-- happy and unhappy triggers have mutually-exclusive WHEN clauses, so they never
-- both fire on one row.

create or replace function clients_trustpilot_cascade_off_unhappy_before()
returns trigger
language plpgsql
as $$
begin
  NEW.trustpilot_status := 'no';
  return NEW;
end;
$$;

comment on function clients_trustpilot_cascade_off_unhappy_before is
  'BEFORE UPDATE trigger function for the reverse Trustpilot cascade (0101). Sets clients.trustpilot_status = ''no'' when csm_standing transitions to a non-happy tier (content/at_risk/problem) and the client has not already given a review. Gating is in the trigger WHEN clause; this function just mutates the NEW row.';

create trigger clients_trustpilot_cascade_off_unhappy_before
  before update on clients
  for each row
  when (
    OLD.csm_standing is distinct from NEW.csm_standing
    and NEW.csm_standing in ('content', 'at_risk', 'problem')
    and NEW.trustpilot_status is distinct from 'yes'
  )
  execute function clients_trustpilot_cascade_off_unhappy_before();

-- ============================================================================
-- One-time backfill — kill pending asks for clients already non-happy
-- ============================================================================
-- The cascade fires on TRANSITION, not PRESENCE, so existing non-happy clients
-- sitting on 'ask'/'asked' need a one-time sweep. Only 'ask'/'asked' are touched
-- (the two "we should/are asking" states); 'yes' (permanent) and NULL (no ask
-- pending) are left alone. Does not change csm_standing, so it does not re-fire
-- this trigger.
update clients
set trustpilot_status = 'no'
where csm_standing in ('content', 'at_risk', 'problem')
  and trustpilot_status in ('ask', 'asked');
