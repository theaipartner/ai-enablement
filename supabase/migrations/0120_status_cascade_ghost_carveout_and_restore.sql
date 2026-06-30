-- 0120_status_cascade_ghost_carveout_and_restore.sql
--
-- Reworks the M5.6 status cascade (migration 0022) per Scott's 2026-06-30 ask.
-- Three changes, one migration:
--
--   1. Ghost carve-out — moving to `ghost` no longer turns Accountability /
--      NPS off. Only `paused` / `leave` / `churned` do. Ghost keeps both ON.
--
--   2. No more "Scott Chasing" reassignment — negative-status transitions keep
--      the client's existing primary CSM instead of reassigning to the Scott
--      Chasing sentinel. The sentinel team_member row is left in place
--      (harmless); pre-existing historical assignments to it are NOT reverted.
--
--   3. Automatic restore — Accountability / NPS now flip back ON automatically
--      when a client returns to `active` (or `ghost`). The cascade is no longer
--      one-directional: accountability_enabled / nps_enabled are now a pure
--      function of status, re-derived on EVERY status transition.
--
-- The status → on/off function (applied on every transition):
--      active, ghost            => accountability_enabled = nps_enabled = TRUE
--      paused, leave, churned   => accountability_enabled = nps_enabled = FALSE
--
-- Intent override: this means a manual dashboard flip is no longer sticky in
-- EITHER direction — the next status change re-derives the value from status.
-- Per Scott, overriding a deliberate manual "off" this way is acceptable: the
-- toggle is now a status-derived field with an ad-hoc manual override that
-- lasts until the next status move.
--
-- UNCHANGED from 0022:
--   - csm_standing => 'at_risk' on negative-going transitions (ghost included)
--     and the client_standing_history row that records it (attributed to
--     Gregory Bot, same 'cascade:status_to_<status>:by:<uuid_or_NULL>' note).
--   - trustpilot_status is still not touched here (its own csm_standing-driven
--     cascade in 0024 / 0101 is independent).
--
-- Trigger ordering note: clients_status_cascade_before still sorts ahead of
-- the trustpilot BEFORE triggers (clients_trustpilot_cascade_*_before) by
-- name, so it sets NEW.csm_standing := 'at_risk' before they re-evaluate.
-- Unchanged by this migration (same trigger name).

-- ===========================================================================
-- 1. BEFORE trigger function — derive accountability/NPS from status + at_risk
-- ===========================================================================
create or replace function clients_status_cascade_before()
returns trigger
language plpgsql
as $$
begin
  -- accountability_enabled / nps_enabled are a pure function of status,
  -- re-derived on every status transition (the trigger WHEN clause is
  -- broadened below to ANY status change, so this also runs on the
  -- positive-going restore). Ghost is in the ON set (0120 carve-out).
  if NEW.status in ('active', 'ghost') then
    NEW.accountability_enabled := true;
    NEW.nps_enabled            := true;
  elsif NEW.status in ('paused', 'leave', 'churned') then
    NEW.accountability_enabled := false;
    NEW.nps_enabled            := false;
  end if;

  -- csm_standing => 'at_risk' on negative-going transitions. UNCHANGED from
  -- 0022 — ghost still counts as negative for standing even though it now
  -- keeps accountability/NPS on. Set here (BEFORE) so the trustpilot BEFORE
  -- triggers observe the at_risk value.
  if NEW.status in ('ghost', 'paused', 'leave', 'churned') then
    NEW.csm_standing := 'at_risk';
  end if;

  return NEW;
end;
$$;

comment on function clients_status_cascade_before is
  'BEFORE UPDATE half of the status cascade (reworked in 0120). Derives accountability_enabled / nps_enabled from the new status on EVERY status transition: active/ghost => true, paused/leave/churned => false (ghost carved out of the off-set in 0120; restore on the way back is automatic). Also sets csm_standing => ''at_risk'' on negative-going transitions (ghost/paused/leave/churned), unchanged from 0022. The history row lives in clients_status_cascade_after.';

-- ===========================================================================
-- 2. AFTER trigger function — history row only (Scott Chasing removed)
-- ===========================================================================
create or replace function clients_status_cascade_after()
returns trigger
language plpgsql
as $$
declare
  v_changed_by_text text;
  v_changed_by_uuid uuid;
  v_gregory_bot     uuid := 'cfcea32a-062d-4269-ae0f-959adac8f597'::uuid;
begin
  -- Read the human attribution from the session GUC (set by
  -- update_client_status_with_history). `true` => NULL on missing key.
  v_changed_by_text := current_setting('app.current_user_id', true);
  if v_changed_by_text is null or v_changed_by_text = '' then
    v_changed_by_uuid := null;
  else
    v_changed_by_uuid := v_changed_by_text::uuid;
  end if;

  -- Standing-history row for the at_risk flip. Unchanged from 0022 (same
  -- attribution + structured note). The AFTER trigger's WHEN clause keeps
  -- firing only on negative-going transitions, so this row is only written
  -- when csm_standing actually became at_risk — never on the positive
  -- restore (accountability/NPS are operational toggles and get no history
  -- row, consistent with the dashboard toggle actions).
  insert into client_standing_history (
    client_id, csm_standing, changed_at, changed_by, note
  ) values (
    NEW.id,
    'at_risk',
    now(),
    v_gregory_bot,
    'cascade:status_to_' || NEW.status || ':by:' || coalesce(v_changed_by_uuid::text, 'NULL')
  );

  -- 0120: the primary_csm reassignment to the "Scott Chasing" sentinel that
  -- 0022 did here is REMOVED. Negative-status clients keep their existing
  -- primary CSM (Scott's 2026-06-30 ask). The sentinel team_member row is
  -- intentionally left in place; existing historical assignments to it are
  -- not reverted by this migration.

  return NEW;
end;
$$;

comment on function clients_status_cascade_after is
  'AFTER UPDATE half of the status cascade (reworked in 0120). Writes one client_standing_history row for the at_risk flip (attributed to Gregory Bot, structured note carrying the new status + the human-attributed UUID from app.current_user_id). The 0022 primary_csm reassignment to the Scott Chasing sentinel was removed in 0120 — clients keep their existing primary CSM through negative-status transitions.';

-- ===========================================================================
-- 3. Recreate the BEFORE trigger with a broadened WHEN clause
-- ===========================================================================
-- 0022's BEFORE/AFTER triggers fired only on negative-going transitions. The
-- restore (active/ghost => on) needs the BEFORE function to run on positive
-- transitions too, so the BEFORE trigger now fires on ANY status change.
-- The AFTER trigger keeps its negative-only WHEN (history row only on
-- at_risk), so it is left as-is — only its function body changed above.
drop trigger if exists clients_status_cascade_before on clients;
create trigger clients_status_cascade_before
  before update on clients
  for each row
  when ( OLD.status is distinct from NEW.status )
  execute function clients_status_cascade_before();

-- ===========================================================================
-- 4. Refresh the column comments to the 0120 semantics
-- ===========================================================================
comment on column clients.accountability_enabled is
  'Whether accountability (DMs, nudges, automated check-ins) is active for this client. As of 0120 this is a status-derived field: clients_status_cascade_before re-derives it on every status transition — active/ghost => true, paused/leave/churned => false. Ghost was carved out of the off-set in 0120 (Scott''s 2026-06-30 ask) and the restore direction is automatic (returning to active/ghost flips it on). A manual dashboard flip is NOT sticky — the next status change re-derives it (overriding manual intent is intended). Distinct from clients.status: status is the operational state, this is the automation-layer gate derived from it.';

comment on column clients.nps_enabled is
  'Whether NPS surveys go to this client. Same status-derived semantics as accountability_enabled (0120): re-derived on every status transition (active/ghost => true; paused/leave/churned => false), ghost carved out of the off-set, automatic restore on the way back, manual flips not sticky. The Airtable NPS side is currently independent — flipping this in Gregory does not (V1) prevent Airtable from sending; Path 2 outbound writeback (deferred) closes that loop.';

-- ===========================================================================
-- No data backfill.
-- ===========================================================================
-- Forward-only by decision (Scott / Drake, 2026-06-30): existing rows are not
-- re-derived. Each client picks up the new on/off rule on its next status
-- transition. Clients currently in `ghost` therefore keep whatever
-- accountability_enabled / nps_enabled value 0022 last set (false) until they
-- next change status; that is intended.
