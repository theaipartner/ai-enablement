# cost_extras

Manually-maintained one-off non-recurring expenses (domain registrations, occasional API top-ups, etc.). Backs the admin-tier `/cost-hub` page alongside `monthly_subscriptions`.

## Purpose

`monthly_subscriptions` covers recurring spend; this table covers one-shot costs that don't repeat. Each row carries a `incurred_on` date so month-attribution stays clean (a domain renewal in May 2026 belongs to May 2026's total even if it was added to the dashboard in June).

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | PK, default `gen_random_uuid()` |
| `incurred_on` | `date` | Not null. Calendar date the expense happened (not a timestamp — these are billed by day, not instant). Used for month-attribution on the cost-hub page |
| `description` | `text` | Not null. Free-form ("Domain registration for foo.com", "OpenAI API one-time top-up", etc.) |
| `cost_usd` | `numeric(10, 2)` | Not null. Two-decimal precision |
| `created_at` | `timestamptz` | Default `now()` |
| `updated_at` | `timestamptz` | Default `now()`. Bumped via shared `set_updated_at()` BEFORE UPDATE trigger |
| `archived_at` | `timestamptz` | Nullable. Soft delete — hidden from the page but preserved so historical month totals stay accurate |

## Indexes

- `cost_extras_incurred_on_idx` — `(incurred_on DESC) WHERE archived_at IS NULL`. Partial index powering both the current-month query (date range filter on `incurred_on`) and the per-month history queries.

## Triggers

- `cost_extras_set_updated_at` — shared `set_updated_at()` function (defined in 0001).

## Populated By

- `app/(authenticated)/cost-hub/actions.ts:addCostExtraAction` — admin-tier-gated server action invoked from the cost-hub page's add-row form.

## Read By

- `app/(authenticated)/cost-hub/page.tsx` (via `lib/db/cost-hub.ts:getCurrentMonthExtras` + `getRecentMonthTotals`) — current-month rows for the live page; historical month-bucketed sums for the History view.

## Mutation paths

- `addCostExtraAction(incurredOn, description, costUsd)` — inserts a new row.
- `updateCostExtraAction(id, incurredOn, description, costUsd)` — in-place edit.
- `deleteCostExtraAction(id)` — soft archive (`UPDATE cost_extras SET archived_at = now() WHERE id = $1`). Hard delete via SQL is available.

## `incurred_on` vs `created_at`

Two timestamps in opposite roles:
- `incurred_on` is **when the expense happened** in calendar time. Used for month-attribution + historical totals. Entries can be backdated (e.g., adding a March expense in May).
- `created_at` is **when the row landed in the table**. Audit-only; never used for month-attribution.

If `incurred_on` is left at today's date the two coincide. Backdating is supported because some one-off expenses (vendor invoices that arrive late, etc.) need to land in the right month.

## Recovering an accidentally-archived row

```sql
UPDATE cost_extras SET archived_at = NULL WHERE id = '<the-uuid>';
```

To find recently-archived rows:

```sql
SELECT id, incurred_on, description, cost_usd, archived_at
FROM cost_extras
WHERE archived_at IS NOT NULL
ORDER BY archived_at DESC
LIMIT 20;
```

## Access tier

Surfaces only on `/cost-hub`, which is gated to **admin-tier** via `app/(authenticated)/cost-hub/layout.tsx`. Every mutating server action self-checks `tierAtLeast('admin')` as defense-in-depth.

## Origin

Migration `0038_cost_hub_tables.sql`. Operational guide at `docs/runbooks/cost_hub.md`.
