# monthly_subscriptions

Manually-maintained line items for recurring monthly spend (Fathom subscription, Claude Max plan, etc.). Backs the admin-tier `/cost-hub` page.

## Purpose

The cost-hub displays three categories of spend: Anthropic API (rolled up from `agent_runs.llm_cost_usd`), monthly subscriptions (this table), and one-off extras (`cost_extras`). Subscriptions need a manual surface because they don't have an automated source — vendors bill outside our infrastructure. Admin-tier users edit the table in place via dashboard forms; the page sums the active rows into the "Total this month" running figure.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | PK, default `gen_random_uuid()` |
| `provider` | `text` | Not null. Free-form name ("Anthropic Claude Max", "Fathom Premium", etc.) |
| `monthly_cost_usd` | `numeric(10, 2)` | Not null. Two-decimal precision; reflects today's price (see § Historical price drift below) |
| `notes` | `text` | Nullable. Free-form notes — billing cycle, seat count, plan details, anything Drake or Nabeel might want to remember |
| `created_at` | `timestamptz` | Default `now()` |
| `updated_at` | `timestamptz` | Default `now()`. Bumped via shared `set_updated_at()` BEFORE UPDATE trigger |
| `archived_at` | `timestamptz` | Nullable. Soft delete — hidden from the page but preserved so historical month totals stay accurate for months when the sub was active |

## Indexes

- `monthly_subscriptions_active_idx` — `(created_at DESC) WHERE archived_at IS NULL`. Partial index powering the page's "active subscriptions" query (newest first).

## Triggers

- `monthly_subscriptions_set_updated_at` — shared `set_updated_at()` function (defined in 0001).

## Populated By

- `app/(authenticated)/cost-hub/actions.ts:addMonthlySubscriptionAction` — admin-tier-gated server action invoked from the cost-hub page's add-row form.

## Read By

- `app/(authenticated)/cost-hub/page.tsx` (via `lib/db/cost-hub.ts:getMonthlySubscriptions`) — non-archived rows for the live page.

## Mutation paths

- `addMonthlySubscriptionAction(provider, monthlyCost, notes)` — inserts a new row.
- `updateMonthlySubscriptionAction(id, provider, monthlyCost, notes)` — in-place edit.
- `deleteMonthlySubscriptionAction(id)` — soft archive (`UPDATE monthly_subscriptions SET archived_at = now() WHERE id = $1`). Hard delete via SQL is available for the rare "I genuinely never want to see this row again" case.

## Historical price drift (locked trade-off)

`monthly_cost_usd` reflects today's price. When the cost-hub computes historical month totals (e.g., "April 2026 total"), it uses today's price for every active sub, regardless of what the actual price was at the time. If a sub price changes mid-period, Drake edits the row in place; historical totals shift slightly.

If the drift becomes load-bearing (e.g., for accounting reconciliation), future iteration is an `effective_from` column for per-row price history. Out of scope for V1.

## Recovering an accidentally-archived row

Soft-archive means archived rows are still in the table — just filtered out by the partial index + dashboard query. To restore:

```sql
UPDATE monthly_subscriptions SET archived_at = NULL WHERE id = '<the-uuid>';
```

To find recently-archived rows:

```sql
SELECT id, provider, monthly_cost_usd, archived_at
FROM monthly_subscriptions
WHERE archived_at IS NOT NULL
ORDER BY archived_at DESC
LIMIT 20;
```

## Access tier

Surfaces only on `/cost-hub`, which is gated to **admin-tier** via `app/(authenticated)/cost-hub/layout.tsx`. Every mutating server action self-checks `tierAtLeast('admin')` as defense-in-depth.

## Origin

Migration `0038_cost_hub_tables.sql`. Operational guide at `docs/runbooks/cost_hub.md`.
