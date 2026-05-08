-- 0028_journey_stage_check.sql
-- Pin the journey_stage taxonomy with a DB-level CHECK constraint.
-- Replaces the V1 free-text shape that 0017 + 0018 explicitly
-- anticipated being formalized later (the 0018 RPC docstring:
-- "No enum validation in V1 — journey_stage is free-text until the
-- taxonomy is finalized. A check constraint will be added later.").
--
-- Applied 2026-05-08 paired with the dashboard's switch from a
-- free-text edit field to an enum dropdown. Cheapest possible window
-- to add the CHECK because all 192 active clients still have
-- journey_stage IS NULL (verified pre-apply 2026-05-08) — zero rows
-- to backfill, the constraint applies clean.
--
-- ============================================================================
-- Six values + null
-- ============================================================================
--
--   business_setup                    "Business setup"
--   business_setup_activation_done    "Setup + activation done"
--   prospecting                       "Prospecting"
--   first_closing_call_taken          "First closing call"
--   first_closed_deal                 "First closed deal"
--   ten_k_month                       "$10k/month"
--
-- Display labels live in lib/client-vocab.ts JOURNEY_STAGE_OPTIONS;
-- this migration owns the values only.
--
-- ============================================================================
-- CHECK on clients ONLY — NOT on client_journey_stage_history
-- ============================================================================
--
-- Mirrors the existing pattern: migration 0019 added a CHECK on
-- clients.status but didn't extend it to client_status_history.status.
-- The history table is an append-only audit log; if vocab ever widens
-- or renames in a future migration, existing history rows with
-- retired values stay valid as historical records. CHECK on history
-- would prevent that.

alter table clients
  add constraint clients_journey_stage_check
  check (
    journey_stage is null
    or journey_stage in (
      'business_setup',
      'business_setup_activation_done',
      'prospecting',
      'first_closing_call_taken',
      'first_closed_deal',
      'ten_k_month'
    )
  );

comment on column clients.journey_stage is
  'Journey-stage funnel position. Six values pinned by the clients_journey_stage_check constraint added in migration 0028: business_setup, business_setup_activation_done, prospecting, first_closing_call_taken, first_closed_deal, ten_k_month. Null is allowed (most clients are null at migration apply time; CSMs assign a stage via the dashboard inline-edit dropdown). Display labels live in lib/client-vocab.ts JOURNEY_STAGE_OPTIONS. Replaced the V1 free-text shape; the 0018 update_client_journey_stage_with_history RPC delegates write attribution into client_journey_stage_history without value-validation — the DB CHECK is the safety net for future direct writes that bypass the dashboard.';
