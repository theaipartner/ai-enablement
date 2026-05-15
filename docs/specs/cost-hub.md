# Cost hub — admin-tier visibility into Anthropic spend + manually-tracked subs/extras
**Slug:** cost-hub
**Status:** in-flight

New admin-tier-only page at `/cost-hub` surfacing all cost data we have visibility into. Closes out Gregory V1 — Nabeel's cost-reduction-opportunity surface.

## Context Builder needs

Read these first, confirm understanding in 4-5 bullets:

- `app/(authenticated)/ella/layout.tsx` — admin-tier sub-layout precedent for `/cost-hub`'s gating.
- `app/(authenticated)/tasks/page.tsx` + `app/(authenticated)/tasks/actions.ts` + `app/(authenticated)/tasks/task-list.tsx` — closest existing precedent for editable per-user data with server actions + optimistic UI. Cost hub's subs/extras tables follow this pattern.
- `shared/claude_client.py` and `shared/logging.py:start_agent_run` / `end_agent_run` — these are the writers for `agent_runs.llm_cost_usd`. Builder should confirm which agents pass `run_id` through to `complete()` so we know exactly what's tracked.
- `lib/auth/access-tier.ts` — `getCurrentUserAccessTier()` + `tierAtLeast('admin')` are the gating primitives.
- `components/gregory/header-band.tsx` and the `geg-gold-box` CSS class — page composition primitives used across the editorial Gregory surface. Cost hub matches the visual language.

## What Drake wants

Admin-tier-only view showing cost data so Nabeel + Drake can spot reduction opportunities. Four sections:

1. **Anthropic spend** — five buckets, each showing today / this week / this month × total runs / total cost / avg cost per run.
2. **Monthly subscriptions** — manually-maintained editable table (provider / monthly cost / notes).
3. **One-off extras** — manually-maintained editable table (date / description / cost).
4. **Total cost this month** — big-number box summing the three above for the current month. History button opens recent months (lean A — monthly totals only, expandable per row).

Five Anthropic buckets:

| Bucket | Filter on agent_runs |
|---|---|
| Ella Sonnet | `agent_name='ella'` AND model starts with `claude-sonnet` |
| Ella Haiku | `agent_name='ella'` AND model starts with `claude-haiku` |
| Call review Sonnet | `agent_name='call_reviewer'` AND model starts with `claude-sonnet` |
| Call review Haiku | `agent_name='call_reviewer'` AND model starts with `claude-haiku` |
| Gregory brain Sonnet | `agent_name='gregory_brain'` (Builder verifies exact agent_name string — could be 'gregory' or 'gregory_brain' or similar) |

**Builder pre-flight task:** before writing the rollup queries, run a one-shot SQL query against cloud `agent_runs` (via psycopg2 like all our other ops scripts) to:
- Confirm the exact `agent_name` strings used by each of the five buckets above. The bucket filter strings in the spec are educated guesses — verify against production.
- Spot-check `llm_cost_usd` completeness for the trailing 30 days per agent_name. Note any gaps (e.g., null `llm_cost_usd` rows, missing-cost-tracking eras).
- Find the earliest date with reliable cost data per agent. The "incomplete history before YYYY-MM-DD" caveat the UI shows is based on this.

Surface findings in the report. The spec assumes:
- Gregory brain cost-tracking started ~2026-05-07 (per state.md).
- Call_reviewer cost-tracking started ~2026-05-07.
- Ella cost-tracking has been wired since V1 (well before).

If reality differs from these assumptions, the UI's caveat strings need to match reality, not the spec's guesses.

## Schema — migration 0038

New migration `0038_cost_hub_tables.sql` adds two tables.

### `monthly_subscriptions`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK, default gen_random_uuid() |
| `provider` | `text` | NOT NULL. Free-form ("Anthropic Claude Max", "Fathom", etc.) |
| `monthly_cost_usd` | `numeric(10,2)` | NOT NULL. Decimals for sub-dollar precision. |
| `notes` | `text` | Nullable. Free-form notes. |
| `created_at` | `timestamptz` | NOT NULL, default now() |
| `updated_at` | `timestamptz` | NOT NULL, default now(), updated via trigger |
| `archived_at` | `timestamptz` | Nullable. Soft delete — hidden from page but preserved in history. |

Index: `(archived_at)` partial index on `WHERE archived_at IS NULL` for the page query.

### `cost_extras`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK, default gen_random_uuid() |
| `incurred_on` | `date` | NOT NULL. The date the expense happened, used for month-attribution. |
| `description` | `text` | NOT NULL. Free-form ("Domain registration for foo.com", etc.) |
| `cost_usd` | `numeric(10,2)` | NOT NULL. |
| `created_at` | `timestamptz` | NOT NULL, default now() |
| `updated_at` | `timestamptz` | NOT NULL, default now(), updated via trigger |
| `archived_at` | `timestamptz` | Nullable. Soft delete — hidden from page but preserved in history. |

Index: `(incurred_on DESC)` for the month-range query, plus the same partial index pattern.

### Update trigger

Both tables get the same `set_updated_at()` BEFORE UPDATE trigger that other tables use (Builder checks the convention — likely already exists as a reusable function from prior migrations).

### Hard stop — gate (a)

Migration 0038 is gate (a) SQL review. Builder writes the migration but does NOT apply. Surface the SQL diff for Drake review. After approval, apply + dual-verify (both tables present, indexes registered, ledger entry).

## Code

### Page composition — `app/(authenticated)/cost-hub/page.tsx`

Server Component. Async fetches in parallel:

1. The five Anthropic bucket aggregates (today / this week / this month × total runs / cost / avg). Single helper `getAnthropicBucketSummaries()` in `lib/db/cost-hub.ts` that returns a `Record<BucketKey, BucketSummary>` where each `BucketSummary` has `today / thisWeek / thisMonth` and each period has `{ runs: number, totalCost: number, avgCost: number, dataIncomplete: boolean, incompleteSinceDate: string | null }`.
2. The active (non-archived) monthly subscriptions list, ordered by created_at desc.
3. The current-month one-off extras list — `incurred_on` falls in `[first-of-month, now()]`, non-archived, ordered by `incurred_on desc`.
4. The current month's total computed read-time as: sum of all `monthly_subscriptions.monthly_cost_usd` (non-archived) + sum of current-month `cost_extras.cost_usd` (non-archived) + sum of all five Anthropic bucket "thisMonth" totals.
5. Recent-month history — a small helper `getRecentMonthTotals(months: number = 12)` that returns the last 12 months' totals (each month sums the same three categories, with the caveat that for historical months you use `monthly_subscriptions.monthly_cost_usd` as-of-today per the locked-in trade-off — see § "Historical sub price drift" below).

Page layout (top to bottom):

1. **HeaderBand** — eyebrow `COST · HUB`, serif H1 "Cost hub.", small mono caption "Admin · monthly running total"
2. **Total this month** — big `geg-gold-box`, 56px serif number for the dollar amount, mono caption with month name (e.g., "May 2026 · running"). Button: "History" — opens an inline expandable section or modal showing the last 12 months' totals tabular (month label / total). Each row expandable to show the same five-bucket + subs + extras breakdown.
3. **Anthropic spend** — five `geg-gold-box` sections, one per bucket. Each box contains a small table:
   ```
   Period            Runs    Total cost    Avg / run
   Today             47      $0.83         $0.018
   This week         312     $5.41         $0.017
   This month        1,247   $22.18        $0.018
   ```
   If the bucket has incomplete history, the "This month" row gets a small mono caption "(incomplete before YYYY-MM-DD)" below it.
4. **Monthly subscriptions** — `geg-gold-box` with editable table. Add row form (provider + cost + notes inputs). Each row has edit + delete buttons. Footer shows the sum.
5. **One-off extras** — `geg-gold-box` with editable table. Add row form (date + description + cost). Each row has edit + delete buttons. Footer shows the sum for the current month.

Visual: matches the existing editorial-dark Gregory aesthetic. Use the `geg-gold-box` + `geg-serif` + mono eyebrow patterns established in the call/clients detail pages.

### Data layer — `lib/db/cost-hub.ts`

New module. Exports:

- `getAnthropicBucketSummaries(): Promise<BucketSummaries>` — Five-bucket parallel query. Each bucket query uses Supabase JS client against `agent_runs`, filtered by `agent_name` + `model LIKE` pattern + period range, aggregating `count(*)` and `sum(llm_cost_usd)`. Avg is derived JS-side from the two.
- `getMonthlySubscriptions(): Promise<MonthlySubscription[]>` — non-archived rows.
- `getCurrentMonthExtras(): Promise<CostExtra[]>` — non-archived rows where `incurred_on` is in the current month.
- `getRecentMonthTotals(months: number): Promise<{ month: string; total: number; breakdown: MonthBreakdown }[]>` — last N months. Builder picks the cleanest implementation — probably one query per month sequentially with `Promise.all` since each month is independent.

Period boundaries (all America/New_York / EST/EDT):
- **Today:** start-of-day in EST through `now()`.
- **This week:** most recent Monday 00:00 EST through `now()`. Use `date_trunc('week', ...)` Postgres pattern OR JS-side computation, Builder's call.
- **This month:** 1st of current month 00:00 EST through `now()`.

Implementation note: Postgres `date_trunc` uses cluster timezone (UTC for Supabase). Builder either passes timezone explicitly (`date_trunc('week', now() AT TIME ZONE 'America/New_York')`) or computes the boundary in JS and passes as a timestamp. JS-side is simpler — pick that unless there's a reason not to.

### Server actions — `app/(authenticated)/cost-hub/actions.ts`

Six server actions, all admin-tier-gated as defense-in-depth (sub-layout already gates, but matching the precedent from `tasks/actions.ts`):

- `addMonthlySubscriptionAction(provider, monthlyCost, notes)`
- `updateMonthlySubscriptionAction(id, provider, monthlyCost, notes)`
- `deleteMonthlySubscriptionAction(id)` — hard delete OR soft archive? My lean is **soft archive** (set `archived_at = now()`) so historical month totals stay accurate for months when the sub was active. Spec the soft-archive shape. Hard-delete is available via SQL if Drake wants to truly remove a row.
- `addCostExtraAction(incurredOn, description, costUsd)`
- `updateCostExtraAction(id, incurredOn, description, costUsd)`
- `deleteCostExtraAction(id)` — same soft-archive shape.

Each action calls `revalidatePath('/cost-hub')` on success.

### Client Component — `app/(authenticated)/cost-hub/cost-hub-tables.tsx`

Editable tables for subs + extras. Mirror `task-list.tsx`'s shape:
- Add-row inline form with text/number/date inputs.
- Per-row edit toggle that swaps display → input mode, save/cancel buttons.
- Per-row delete button with confirmation (browser `confirm()` is fine for V1).
- Optimistic UI via `useTransition` + `router.refresh()`.

### Sub-layout — `app/(authenticated)/cost-hub/layout.tsx`

Admin-tier gate via `getCurrentUserAccessTier` + `tierAtLeast('admin')`. Non-admin → redirect `/clients?error=insufficient_access`. Preview-bypass branch stubs `'creator'` per the existing pattern in `app/(authenticated)/ella/layout.tsx`.

### TopNav — `components/top-nav.tsx`

Add `{ href: '/cost-hub', label: 'Cost hub', requiredTier: 'admin' }` to NAV_ITEMS. Filtered by tier automatically per the existing precedent.

### Types — `lib/supabase/types.ts`

Add Row/Insert/Update interfaces for `monthly_subscriptions` and `cost_extras`.

## Historical sub price drift

**Locked trade-off (Drake confirmed):** monthly subs are stored as "current state" — one row per provider with `monthly_cost_usd` reflecting today's price. Historical month totals use today's price even if the actual cost was different at the time. If a sub price changes mid-period, Drake edits the row in place; old month totals shift slightly.

Note this in the runbook so it's not surprising later. If the drift becomes a problem, future iteration is an `effective_from` column on subs (per-row history) — out of scope for V1.

## "Incomplete history" caveat

Surface "(incomplete before YYYY-MM-DD)" on the "This month" row for any bucket where the earliest reliable cost-tracking date is later than the start of the current month. The date comes from the Builder pre-flight query against `agent_runs`.

For Today and This week rows — these are always recent enough that all five buckets have reliable data. No caveat shown.

## Tests

Python tests for the rollup logic where it lives Python-side (none today — the page is TS server-side, rollups happen in `lib/db/cost-hub.ts`). For TS-side rollups, no test infrastructure exists for the dashboard. Builder pattern: instead of skipping tests entirely, add a Playwright verifier script at `scripts/verify-cost-hub-preview.ts` that:

1. Authenticates to the Preview deployment (using `NEXT_PUBLIC_DISABLE_AUTH=true`).
2. Visits `/cost-hub`.
3. Asserts the page renders without errors.
4. Asserts the five bucket boxes are present.
5. Adds a test monthly subscription, asserts it appears in the table, then deletes it.
6. Adds a test one-off extra, asserts it appears, then deletes it.
7. Asserts the "Total this month" box renders a dollar amount.
8. Screenshots to `scripts/.preview/cost-hub.png`.

Mirrors `scripts/verify-clients-preview.ts` etc. — established pattern.

## Doc updates

- `docs/schema/monthly_subscriptions.md` — new schema doc.
- `docs/schema/cost_extras.md` — new schema doc.
- `docs/runbooks/cost_hub.md` — new runbook covering: what data the page shows, the manual subs + extras workflow, the historical sub price drift trade-off, how to recover from a bad delete (soft-archive means SELECT WHERE archived_at IS NOT NULL surfaces them; UPDATE archived_at = NULL to restore), the bucket-filter exact strings (so future agents adding more LLM-using subsystems know to add a sixth bucket), the data-incompleteness caveats per bucket.
- `docs/state.md` — single bullet under the post-2026-05-15 section noting cost-hub shipped + 0038 migration applied.
- `CLAUDE.md` — § Next Session Priorities: remove "Admin cost hub" item, leaving just "Gregory V2 — sales side." § Folder structure: bump Python serverless functions count if applicable (no new functions actually — cost-hub is all dashboard-side; count stays at 11).

## Hard stops

1. **Migration 0038 apply is gate (a).** Builder writes + STOPS for Drake's SQL review. After approval: apply + dual-verify.
2. **Manual data entry post-deploy is gate (c).** Drake fills in monthly subscriptions + one-off extras post-deploy.

No other hard stops. Server-action behavior is reversible (soft-archive on delete), page is read-mostly with mutations contained to two new tables.

## Hard-numerical thresholds

- If the Builder pre-flight query against `agent_runs` finds <50% cost-tracking completeness on any bucket in the trailing 7 days, surface and stop — that bucket's "This week" rollup will be misleading and we should investigate the gap before shipping.

## What could go wrong

- **Bucket filter strings wrong.** If `agent_name='gregory_brain'` is actually `agent_name='gregory'` or similar, the Gregory brain bucket shows zero. Builder's pre-flight query catches this.
- **Cost-tracking gaps creating misleading totals.** The "incomplete before" caveat is the mitigation — make it visible enough that nobody misreads a low number as "spend is low" when it should be "data is missing."
- **Numeric precision.** `llm_cost_usd` is stored as a numeric type; sums of 1000s of rows accumulate without floating-point drift. Avg computed JS-side via `Number(totalCost) / Number(runs)` — fine for display, two-decimal-place rounding at the UI boundary.
- **Soft-archive semantics on monthly subs.** If Drake deletes a sub then re-adds it later, that's a new row, not a restore. The runbook covers restore via SQL for the rare case where Drake wants the original row back.
- **History view performance.** 12 months × 5 bucket queries + 12 months × 1 subs query + 12 months × 1 extras query = ~84 queries on history button click. Probably fine at current data volumes but watch the page-load time. If it gets slow, batch into a single Postgres function returning all 12 months at once. Out of scope for V1.
- **Vercel cold start on `/cost-hub`.** Five parallel bucket queries on initial render. If page-load is sluggish, surface in report; we can iterate.

## Mandatory doc-update list

- `docs/schema/monthly_subscriptions.md` (new)
- `docs/schema/cost_extras.md` (new)
- `docs/runbooks/cost_hub.md` (new)
- `docs/state.md` — bullet update.
- `CLAUDE.md` § Next Session Priorities — remove the cost hub item.

## Acceptance criteria

- Migration 0038 written, reviewed (gate (a)), applied + dual-verified.
- `/cost-hub` page renders for admin-tier users only; non-admin redirects to `/clients?error=insufficient_access`.
- Five Anthropic bucket boxes render with today/this week/this month rollups + avg-per-run + incomplete-history caveats where applicable.
- Editable monthly subs table — add / edit / delete (soft-archive) all working.
- Editable one-off extras table — same shape, with date input for `incurred_on`.
- Total-this-month box renders the sum of all three categories.
- History button reveals last 12 months' totals; per-row expand shows the bucket breakdown.
- Playwright verifier `scripts/verify-cost-hub-preview.ts` passes on preview deploy.
- `pytest tests/ -q` still green (no Python touched aside from the migration).
- `tsc --noEmit` + `npm run lint` clean.
- All listed docs updated.

## Sequence

1. Builder pre-flight cost-tracking inventory query (output in report).
2. Migration 0038 written.
3. **HARD STOP — Drake SQL review of 0038.**
4. Migration applied + dual-verified.
5. Schema docs (`monthly_subscriptions.md`, `cost_extras.md`).
6. Data layer (`lib/db/cost-hub.ts`) + types (`lib/supabase/types.ts`).
7. Sub-layout + page + tables Client Component + server actions.
8. TopNav entry.
9. Playwright verifier + run on preview.
10. Runbook + state.md + CLAUDE.md updates.

If any step fails its checks, hard stop and surface per the standard rules.
