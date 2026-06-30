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
| `notes` | `text` | Nullable. Free-form notes — billing cycle, seat count, plan details, anything an admin might want to remember |
| `effective_from` | `date` | Not null, default `CURRENT_DATE`. The date the subscription began contributing to monthly totals. Added in migration 0039. See § Month attribution below |
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

## Month attribution

A subscription contributes to month **M** when both hold:

- `effective_from <= last_day_of_M` — it had started by the end of M.
- `archived_at IS NULL OR archived_at >= first_day_of_M` — it had not been archived before M began.

The rule is implemented once in `lib/db/cost-hub.ts:subscriptionActiveInMonth` and consumed by the history-month rollup (`getMonthTotal`) and the current-month page filter. Before migration 0039, the rollup summed every non-archived sub into every historical month — so a sub added today inflated every prior month's total. `effective_from` fixes that: a sub only counts from the month it started.

**Backdating use case:** a subscription that's been billing since (say) March can be added now with `effective_from` set to the March date (via the cost-hub editable table's date input). The history view then retroactively attributes it to March, April, May, … — every month at-or-after `effective_from`. Conversely, a sub added today with `effective_from` left at today only counts from this month forward.

Existing rows at migration time were backfilled to `created_at::date` (the date they were added), so they retain the "added today" semantic rather than silently counting back to the beginning of time.

## Historical price drift (locked trade-off)

`monthly_cost_usd` reflects today's price. When the cost-hub computes historical month totals (e.g., "April 2026 total"), it uses today's price for every active sub, regardless of what the actual price was at the time. If a sub price changes mid-period, the row is edited in place; historical totals shift slightly.

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
