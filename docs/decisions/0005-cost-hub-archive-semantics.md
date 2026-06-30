# ADR 0005: Cost-hub archive semantics — Cancel-vs-Remove + cancelled-but-visible

**Date:** 2026-05-23
**Status:** Accepted
**Decision makers:** Engineering

## Context

`/cost-hub` is Nabeel's monthly cost-visibility surface. It surfaces five Anthropic LLM-spend buckets + an editable Monthly Subscriptions table + a Cost Extras table (one-off line items like "$50 ad spend"), plus a current-month total that sums them. A 12-month History view shows the same total per past month using a `subscriptionActiveInMonth(sub, monthStart, monthEnd)` overlap predicate.

Mid-2026-05 a cluster of bugs around archive behavior surfaced:

- The ElevenLabs subscription was cancelled mid-month. The line item disappeared from the current-month list AND from the current-month total — but ElevenLabs had already been paid for the month. The expected behavior was "stops billing next month, still counts this month."
- The current-month total used a separate query path from the table render (the table read `archived_at IS NULL`; the total summed over rows the table fetched). The two views were edited independently for each pre-shipped feature, and any divergence in how they treated archived rows surfaced as "the total doesn't match the lines I see."
- The × button on a row was overloaded: sometimes the row was a *mistake* (typed wrong cost, wrong vendor — should be wiped from history); sometimes the row was a *real cancellation* (paid this month, stops next month — should stay in audit trail). Both cases pressed the same button.
- Extras (one-off line items) were treated the same as subscriptions in the UI but conceptually have no "next month" — cancelling an extra is incoherent.

A first-pass fix landed the current-month-total alignment (Q1: total counts rows active-in-month including mid-month-archived, matching the history path). A second pass codified the cancel-vs-remove split, the cancelled-but-visible badge, and the structural guard that prevents the table-vs-total divergence from recurring.

## Decision

### (i) Current-month total counts rows *active-in-month*, including mid-month-archived

The current-month total uses the same `subscriptionActiveInMonth(sub, monthStart, monthEnd)` overlap predicate the History path uses. A row counts if it overlaps the current month at all — `effective_from <= monthEnd AND (archived_at IS NULL OR archived_at >= monthStart)`. Mid-month archives stay in the current-month total because they were paid for the month.

### (ii) Cancel vs Remove — two distinct operations on the × button

Two server actions, two distinct semantics:

- **Cancel (soft-archive)** — sets `archived_at = now()`. The row stays in the database, stays in the current-month total (per (i)), stays visible in the current-month table with a "cancelled" badge. Future months: the row no longer counts. Use case: a real cancellation where the bill was paid this month but won't recur.
- **Remove (hard DELETE)** — deletes the row from the database. Gone from all totals (current and historical), gone from all views. Use case: a mistake (wrong vendor name, wrong price, accidental add).

The × button surfaces both options as separate buttons in the row's action area; the operator explicitly chooses on each press. No defaults, no "Cancel hides into Remove if you click twice" — both are first-class.

### (iii) Cancelled-but-still-in-paid-month subs render with a "cancelled" badge

For the current month, a row with `archived_at` set in this month renders in the Monthly Subscriptions table with a visible "Cancelled" badge. The badge tells the reader *why* this row is still showing despite being archived: "it's cancelled, but you paid for it this month, so it counts." Once the calendar month passes, the row drops out of the Monthly Subscriptions table view but stays in the underlying data (visible in any future History query that covers a month the row was active in).

### (iv) Extras are Remove-only (no Cancel)

Cost Extras represent one-off line items (one-time ad spend, a one-month subscription bought as a test). There is no "next month" to stop billing for — the line item is by definition a single-month entry. The × button on an extra shows only Remove (hard DELETE). Trying to model Cancel here would be confusing without adding value.

### Structural guard against co-edit divergence

The bug-cluster's root cause was that the table render and the total computation had to be kept in sync manually, and they drifted under iteration. The fix: both surfaces read from a single source list of subscriptions for the month, computed once on the page. The total is `sum(list.map(monthly_cost_usd))`; the table iterates the same list. They cannot diverge because they're literally summing the same array. `lib/db/cost-hub.ts:fetchAllSubscriptionsWithArchive` is the canonical fetcher; `getSubscriptionsActiveInCurrentMonth` filters that fetch via `subscriptionActiveInMonth`; the page component renders that filtered list once and sums it once.

## Consequences

### Positive

- **Page line-items reconcile to the total** — the visible list is exactly what's summed. No more "I see N subs in the table, total shows a different number." Verified end-to-end via Playwright on the deploy preview (Part 3 of the spec) with sum-to-total invariants checked after each add / cancel / remove.
- **Cancel-vs-Remove distinction means audit history is preserved for real cancellations** without forcing the operator to live with stale-looking lists. Mistakes go cleanly; intentional stops stay traceable.
- **The cancelled badge is the user-facing version of the "yes this counts" mental model** — the operator sees the cancelled row at the top of the month, knows why it's there, knows it'll fall off after the month rolls over.
- **The single-source-list pattern is the structural fix** — if any future surface adds a third view of the same subscription data, it builds on the same fetcher and inherits the invariant for free.

### Negative / accepted

- **Two server actions per row instead of one** (`cancelMonthlySubscriptionAction` + `removeMonthlySubscriptionAction`). Slightly more code than the overloaded × of v1, but the explicit semantics are the whole point.
- **A row visible in the current-month table can no longer be re-edited** once cancelled — the badge is a one-way state. Acceptable: a cancelled row is supposed to be a record, not an editable line. To "un-cancel," the row gets re-added as a new subscription with the same effective_from.
- **The cancelled-but-visible state only applies to the current month.** Past months in the History view show rows according to whether they were active-in-that-month, with no badge — the badge is a "this is happening now" affordance, not a permanent label. This matches the intended mental model.
- **No bulk-cancel UI.** Each row gets its own Cancel / Remove press. With ~10 subscriptions in steady-state, fine; if the table ever grows to 50+, revisit.

## Known deviations + status

None at decision time. The Playwright verifier (`scripts/verify-cost-hub-preview.ts`) checks sum-to-total invariants after each add / cancel / remove and tears down its test rows via hard-DELETE in try/finally — that's the regression guard if future edits to the page logic drift the invariants.

## Implementation pointers

- **Data layer:** `lib/db/cost-hub.ts` — `SubscriptionWithArchive` type, `fetchAllSubscriptionsWithArchive` (canonical fetcher), `subscriptionActiveInMonth` (overlap predicate), `getSubscriptionsActiveInCurrentMonth`, `getCurrentMonthExtrasForTotal`.
- **Page composition:** `app/(authenticated)/cost-hub/page.tsx` — four parallel fetches, single source list per surface feeding both table render and total computation.
- **Server actions:** `app/(authenticated)/cost-hub/actions.ts` — `cancelMonthlySubscriptionAction` (soft-archive), `removeMonthlySubscriptionAction` (hard DELETE), `removeCostExtraAction` (hard DELETE, extras-only).
- **Table UI + badge:** `app/(authenticated)/cost-hub/cost-hub-tables.tsx` — Cancel + Remove buttons per row; "Cancelled" badge when the row is `archived_at`-set this month.
- **Playwright verifier:** `scripts/verify-cost-hub-preview.ts` — sum-to-total invariants + try/finally hard-DELETE cleanup of `__verify_*`-prefixed test rows.

## Review

Revisit if: a real-world cancellation flow needs a refund/credit modeled (current schema has no refund concept — it's cost-paid, not net-of-refund); a new view on the same subscription data ships and doesn't follow the single-source-list pattern (re-introduces the divergence class); OR the bulk-cancel UI need surfaces (would justify a multi-select-with-action pattern that doesn't exist anywhere else in the dashboard today).
