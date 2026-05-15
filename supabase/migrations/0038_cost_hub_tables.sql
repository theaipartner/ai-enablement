-- 0038_cost_hub_tables.sql
-- Admin cost-hub: two new manually-maintained cost tables.
--
-- Backs the new admin-tier-only page at `/cost-hub` (spec:
-- docs/specs/cost-hub.md). Anthropic spend rolls up from the existing
-- `agent_runs.llm_cost_usd` column; no new infrastructure for that.
-- These two tables capture cost data that doesn't have an automated
-- source — monthly subscription line items (Fathom, Claude Max, etc.)
-- and one-off extras (domain registrations, occasional API top-ups,
-- etc.). Both are read by the cost-hub page and edited via dashboard
-- server actions (admin-tier-gated; defense-in-depth tier check on
-- every action).
--
-- ============================================================================
-- monthly_subscriptions — line items for recurring monthly spend
-- ============================================================================
--
-- One row per subscription. `monthly_cost_usd` reflects today's price;
-- historical month totals use today's price even if the actual cost
-- was different at the time (locked trade-off per spec § Historical
-- sub price drift). If the drift becomes a problem, future iteration
-- is an `effective_from` column for per-row price history — out of
-- scope for V1.
--
-- Soft archive on delete (`archived_at` not null) so historical month
-- totals stay accurate for months when the sub was active. Hard delete
-- is available via SQL if needed.

create table monthly_subscriptions (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  monthly_cost_usd numeric(10, 2) not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

comment on table monthly_subscriptions is
  'Manually-maintained line items for recurring monthly cost. Read by /cost-hub. Soft-archive on delete (archived_at).';

create index monthly_subscriptions_active_idx
  on monthly_subscriptions (created_at desc)
  where archived_at is null;

create trigger monthly_subscriptions_set_updated_at
  before update on monthly_subscriptions
  for each row execute function set_updated_at();

-- ============================================================================
-- cost_extras — one-off non-recurring expenses
-- ============================================================================
--
-- One row per expense. `incurred_on` is a date (not timestamptz) — these
-- are accounted for by calendar day, not by clock instant. The cost-hub
-- page surfaces the current-month set (incurred_on falls in
-- [first-of-month, today]) and history queries scope to past months by
-- the same column.
--
-- Soft archive on delete, same shape as monthly_subscriptions.

create table cost_extras (
  id uuid primary key default gen_random_uuid(),
  incurred_on date not null,
  description text not null,
  cost_usd numeric(10, 2) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

comment on table cost_extras is
  'Manually-maintained one-off expenses (domain registrations, occasional API top-ups, etc.). Read by /cost-hub. Soft-archive on delete (archived_at).';

create index cost_extras_incurred_on_idx
  on cost_extras (incurred_on desc)
  where archived_at is null;

create trigger cost_extras_set_updated_at
  before update on cost_extras
  for each row execute function set_updated_at();
