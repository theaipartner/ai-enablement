-- 0070_sales_hot_indexes.sql
--
-- Performance-only migration. Adds two composite indexes that match the
-- query shapes the sales dashboard runs on every load. NO schema change,
-- NO data change, NO logic change — these indexes only give Postgres a
-- faster path to the SAME rows it already returns.
--
-- WHY
--   The dashboard's connection/FMR queries filter close_calls and
--   close_sms by (direction = X AND activity_at >= window-start) and sort
--   by activity_at. The existing indexes on these tables are all keyed on
--   `date_created`, NOT `activity_at` — so the planner can't use them for
--   the activity_at predicate and falls back to a full table scan.
--
--   Measured 2026-06-02 against cloud (EXPLAIN ANALYZE, ~7-day window):
--     close_calls : Seq Scan, 1,319 ms, read 16,687 rows to return 119.
--     close_sms   : Index Scan on direction only, then filtered 15,562
--                   rows by activity_at, 747 ms, to return 586.
--   Both stack multiple times per page load and grow linearly with the
--   tables (close_calls is fed every 15 min by the setter-calls sweep),
--   which is the "slow + getting worse" symptom.
--
-- WHAT THESE FIX
--   A (direction, activity_at) composite lets Postgres range-scan straight
--   to "outbound/inbound rows at/after the window start, in time order"
--   instead of scanning the whole table and sorting. Duration (an
--   inequality) stays a cheap heap filter on the already-narrowed result.
--
-- WHAT THIS DOES NOT TOUCH
--   The lead-tagging cron (shared/lead_tagging.py) is unaffected: it pulls
--   per-lead history via `lead_id = any(...)` (already served by the
--   existing close_calls_lead_id_idx / close_sms_lead_id_idx) and does NOT
--   filter by activity_at, so cycle/stage computation reads full history
--   exactly as before.
--
-- REVERSIBILITY
--   Fully reversible — `drop index` (see rollback at bottom). Additive
--   indexes carry only a small per-insert maintenance cost, negligible at
--   these row counts and write rates.

create index if not exists close_calls_direction_activity_idx
  on close_calls (direction, activity_at);

create index if not exists close_sms_direction_activity_idx
  on close_sms (direction, activity_at);

-- Rollback (run manually if ever needed):
--   drop index if exists close_calls_direction_activity_idx;
--   drop index if exists close_sms_direction_activity_idx;
