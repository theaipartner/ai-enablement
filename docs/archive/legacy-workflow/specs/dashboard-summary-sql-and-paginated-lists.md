# Dashboard Summary-in-SQL + Server-Paginated Lists
**Slug:** dashboard-summary-sql-and-paginated-lists
**Status:** in-flight

> **DO NOT EXECUTE YET.** Drake is scheduling focused time for this. This
> spec is written ahead of execution. When picked up, read it in full,
> run the acclimatization checklist, and treat the parity gate (§ Hard
> stops) as non-negotiable — these numbers are read by Nabeel.

## Why

The sales-dashboard pages compute their summary metrics by pulling **every**
row (all leads, all calls) into the serverless function and tallying them
in JavaScript, then often loading the full row list and slicing it for
display. With only a few days of data this is already slow; at a month —
let alone months — it gets linearly worse on two axes at once (more rows to
haul in, more rows to render). Two recent stop-gaps bought runway but did
not fix the root cause: `getCurrentUserAccessTier` is now `React.cache()`d
(commit 53c36d3) and the heavy pages got `maxDuration = 60` (commit
f7b9be4). This spec removes the root cause.

**The pattern (applies to every surface below):**

1. **Summary numbers → computed in the database**, not in our app. One
   aggregate query / RPC returns the handful of finished numbers. Cost is
   ~flat regardless of how much history exists. This is the primary win —
   it's what Drake/Nabeel look at most.
2. **Row lists → server-side pagination.** Fetch one page (cap **100**),
   show a "See more" / "See next" control that fetches the next page on
   demand. The query carries `LIMIT`/`OFFSET` (or keyset) + `ORDER BY` —
   the app never materializes more than one page. Because the summary no
   longer depends on the list, a page never pulls more than ~100 rows +
   the summary numbers, at any window size.

## Scope — four surfaces

| # | Surface | Page | Fetcher(s) | Today's problem |
|---|---------|------|-----------|-----------------|
| 1 | Appointment setting | `app/(authenticated)/sales-dashboard/funnel/appointment-setting/page.tsx` | `lib/db/funnel-appointment-setting.ts` — `getFmrTimeBlocks`, `getCallActivityMetrics`, `getSpeedToLeadCohort`, `getCallActivityForUser` | Summary tallied in JS over full-cohort scans; `for(;;)` pagination loops materialize all close_calls / close_sms. |
| 2 | Leads | `app/(authenticated)/sales-dashboard/leads/page.tsx` | `lib/db/leads.ts` — `getLeadsForRange` | Loads the full lead list + paginated calendly scans into memory. **Coupled** to `getSpeedToLeadCohort` (comment: "so the two can't drift"). |
| 3 | Calls (sales) | `app/(authenticated)/sales-dashboard/calls/page.tsx` | `lib/db/setter-calls.ts` — `listSetterCalls` | Already has `PAGE_SIZE = 50` + "See next" UI, but loads **all** rows then `allRows.slice()` in JS — front-end-only paging. |
| 4 | Calls (fulfillment) | `app/(authenticated)/(fulfillment)/calls/page.tsx` | `lib/db/calls.ts` — `getCallsList` | Loads the full calls list + a documents-metadata join; `calls` is small today (~941 rows) but "adds up quickly". |

Priority order if split across sessions: **1 → 2 → 3 → 4** (1 is the worst
offender and establishes the pattern; 2 shares logic with 1; 3 and 4 are
mostly the list-pagination half).

## Acclimatization checklist (confirm in 4–5 bullets before coding)

Read and confirm understanding of:

- `lib/db/funnel-appointment-setting.ts` — the `for(;;)` scan loops and
  **which scans are intentionally unbounded**. Specifically lines ~1243–1290
  (`getSpeedToLeadCohort`): the missing `activity_at` upper bound is
  **deliberate** ("intensity captures cumulative outreach effort"). The SQL
  rewrite must preserve that semantic exactly — cumulative intensity is NOT
  to be window-clamped.
- `lib/db/leads.ts` `getLeadsForRange` and its stated coupling to
  `getSpeedToLeadCohort` — confirm how they share logic so they don't drift
  after the refactor.
- `lib/db/setter-calls.ts` `listSetterCalls` + the sales calls page's
  existing `PAGE_SIZE`/`slice` pagination — confirm the display contract so
  the server-paginated version keeps the same UX.
- The migration convention: `supabase/migrations/NNNN_*.sql`, next number is
  **0058**. Study an existing RPC as the template —
  `0015_merge_clients_function.sql`, `0025_create_or_update_client_from_onboarding.sql`,
  `0008_kb_search.sql`. Confirm how functions are granted to `service_role`
  and exposed via PostgREST (the dashboard calls them with the admin client).
- The existing indexes on `close_leads`, `close_calls`, `close_sms`,
  `calls`, `setter_call_transcripts` (check `information_schema` / the
  migration history) so we add only what's missing.

## Approach

### Summary tier (the priority)

- Move each page's summary math into Postgres. Use a **SQL function (RPC)**
  where the math is non-trivial (per-lead first/second call, connect rate,
  cumulative intensity, avg speed-to-lead) — i.e. surface 1's cohort
  metrics. Use plain aggregate queries (`count`, `sum`, conditional
  aggregates via PostgREST) where it's genuinely simple.
- RPCs take the same window/range params the TS functions take today and
  return one row of finished numbers. Call them from the data layer with the
  admin client (`createAdminClient().rpc('fn_name', {...})`).
- **Indexes are mandatory, not optional.** An aggregate that table-scans
  months of `close_calls`/`close_sms` defeats the purpose. The migration
  adds covering indexes for every filter/join/sort column the RPCs touch
  (e.g. `close_calls(lead_id, direction, activity_at)`,
  `close_leads(date_created)`). Verify existing indexes first; don't
  duplicate.

### List tier

- Replace "load all → slice in JS" with **server-side pagination**:
  `ORDER BY <stable sort> LIMIT 100 OFFSET <page*100>` (offset-based is fine
  at this scale; note keyset as the upgrade path if any list routinely goes
  hundreds of pages deep). The sort that determines "top 100" must run in
  SQL — if a list is sorted by a computed metric (e.g. intensity), that
  metric is computed in the same query/RPC, not in JS after the fact.
- Cap = **100** as a named constant (e.g. `LIST_PAGE_SIZE`) so it's a
  one-line change later. Surface 3 already has the "See next" control —
  keep its UX, just make the data fetch honor the page.
- The list query and the summary query are **independent**: showing more
  rows never recomputes the summary, and the summary never depends on how
  many rows are loaded.

### Parity (how we de-risk the metric rewrite)

For every metric moved from JS to SQL, prove equivalence **before** deleting
the JS path:

- Add a one-shot parity script under `scripts/` (e.g.
  `scripts/_parity_appt_setting.py` or a `.ts` harness) that runs the OLD JS
  aggregation and the NEW SQL/RPC for the **same** window(s) and asserts the
  numbers are identical (exact for counts/sums; within a tiny epsilon for
  floats/averages). Run it against cloud for at least: a 1-day window, a
  7-day window, and an all-time/cohort window.
- Cut a page over to the SQL path **only** after parity passes for that
  page. If a number doesn't match, stop and surface it — do not ship a
  silent metric change.

## What success looks like

- Each of the 4 pages renders its summary from a SQL aggregate/RPC; no
  page's summary requires materializing the full row set in JS.
- Each list fetches at most one page (≤100 rows) per request; "See more" /
  "See next" loads the next page server-side.
- Parity script(s) show identical numbers old-vs-new for every migrated
  metric across the three test windows. Output captured in the report.
- `EXPLAIN` (or timing) shows the summary RPCs use indexes, not seq scans,
  on a months-sized dataset (simulate if needed by widening the window).
- The dashboard pages still pass typecheck (`npx tsc --noEmit`) and the
  existing pytest suite is green.
- Appointment-setting page wall-clock at a 1-month window is dramatically
  lower than today (capture a before/after number in the report).

## Hard stops (surface to Drake; do not self-clear)

- **Before applying the migration** — Drake reviews the SQL diff (functions
  + indexes). Standard SQL-review gate. Apply only after sign-off, then
  dual-verify (schema reality + `supabase_migrations.schema_migrations`).
- **Parity gate** — if any migrated metric does not match the current JS
  output, STOP and surface the discrepancy with the failing numbers. Never
  ship a number that changed silently.
- **The cumulative-intensity semantic** — if the SQL rewrite of
  `getSpeedToLeadCohort` would change intensity from "cumulative to date" to
  "windowed," STOP. That's a metric definition change and is Drake's call.
- **Leads ↔ cohort coupling** — if refactoring `getSpeedToLeadCohort` forces
  a behavior change in `getLeadsForRange` (or vice versa), surface it before
  shipping; they must stay consistent.

## Hard-numerical thresholds

- List page size cap: **100** rows/page (named constant).
- Parity float tolerance: averages/rates may differ by ≤ 0.5% (rounding);
  counts and sums must be **exact**. Anything outside that → hard stop.

## What could go wrong (think this through yourself)

Interrogate at least: SQL translation drifting from the JS logic on edge
cases (null durations, dedup of duplicate calls, the 90s connect threshold,
DST in ET-day bucketing); offset pagination skipping/repeating rows if the
sort isn't stable (tie-break on a unique key); RPC `search_path` / security
(`SECURITY INVOKER` vs `DEFINER`) and grants to `service_role`; PostgREST
statement-timeout on a heavy un-indexed aggregate; the leads/cohort coupling
silently diverging; a list whose sort metric can't be expressed in SQL
without the full per-row computation.

## SOP — make this the norm going forward

This is a deliverable, not just guidance: Builder lands it as a runbook
(`docs/runbooks/dashboard_data_patterns.md`) AND adds a one-line convention
pointer to CLAUDE.md § Conventions so future sessions inherit it. Content:

**Rule: dashboard pages summarize in SQL and paginate lists server-side.**

Any new (or edited) dashboard surface that shows summary metrics or lists
rows MUST follow these five rules:

1. **Summaries are computed in Postgres.** Use a SQL aggregate query or an
   RPC. Never pull a whole table into the serverless function to `sum`/
   `count`/`avg` in JavaScript. If the metric is complex (per-entity
   rollups, conditional rates), write an RPC; keep the math in one place.
2. **Lists paginate in the query.** `ORDER BY <stable sort, tie-broken on a
   unique key> LIMIT <page size> OFFSET <n>` (or keyset for deep lists).
   Never "load all then `.slice()`". The sort that defines the visible page
   runs in SQL, not in JS.
3. **Page size is a named constant**, default 100, with a "See more" /
   "See next" control. The summary tier and list tier are independent —
   loading more rows never recomputes the summary.
4. **Indexes ship with the query.** Every column an aggregate or list
   filters/joins/sorts on has a supporting index in the same migration.
   Verify before adding (no duplicates). A summary RPC that seq-scans is a
   bug.
5. **Moving JS aggregation to SQL requires a parity check.** Prove old == new
   for representative windows before deleting the JS path. Counts/sums
   exact; rates within tolerance. Capture the result in the report.

Plus the two carry-over rules from the stop-gap fixes:
6. **`force-dynamic` pages set `export const maxDuration`** (60s default for
   data-heavy pages).
7. **Per-request lookups used in multiple layouts are `React.cache()`d**
   (see `lib/auth/access-tier.ts`).

A reviewer's one-question test for any new dashboard PR: *"If this table had
a million rows, what would this page fetch?"* The answer must be "one page +
a few summary numbers," not "everything."

## Mandatory doc updates

- `supabase/migrations/0058_*.sql` (or sequential numbers per page) — the
  RPCs + indexes, with header comment explaining each function.
- `docs/runbooks/dashboard_data_patterns.md` — **new**, the SOP above.
- `CLAUDE.md` § Conventions — one-line pointer to the runbook (the norm).
- `docs/schema/*` — if any new index/function is documented at the table
  level, note it; otherwise state "no schema-doc change" explicitly.
- For each migrated page's fetcher file — update the module docstring to say
  summaries come from SQL and lists are server-paginated.
- `docs/reports/dashboard-summary-sql-and-paginated-lists.md` — the standard
  six-section report, including before/after timings and the parity output.

## Notes for the executor

- This can be done page-by-page across multiple sessions (use `-pt1`/`-pt2`
  report suffixes if so). Surface 1 first — it proves the pattern and the
  parity harness the others reuse.
- The recently-shipped `maxDuration`/`React.cache` fixes stay; this spec
  makes them belt-and-suspenders rather than load-bearing.
