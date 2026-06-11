# ⚠️ PERFORMANCE / SCALING DEBT — sales dashboard ⚠️

**Read this before the leads / appointment-setting / people pages get slow again.**

The sales-dashboard pages aggregate **site-side**: they pull thousands of raw
rows out of Postgres into the serverless function and compute counts / sums /
mins in JavaScript. That works at today's scale but degrades as the mirror
tables grow (`close_sms` is the fastest-growing — already ~48k rows). When a
page exceeds its 60s / memory budget it returns a 500 — the crashes Drake saw
on 2026-05-31.

The durable fix is **database-side aggregation**: let Postgres do the
`GROUP BY` / `COUNT` / `MIN` with the existing indexes and return a few hundred
summary rows instead of shipping tens of thousands of raw rows to Node.

---

## ✅ Already done (2026-05-31)

- **Option A** — `perf(...): dedupe cohort fetch + cache FMR`. The leads page
  fetched the speed-to-lead cohort twice; now once, threaded into
  `getLeadsForRange(range, cohort?)`. `getFmrTimeBlocks` is wrapped in
  `unstable_cache` (10-min revalidate; cohort-wide, identical per request).
- **Option B, step 1 (filter pushdown)** — `perf(...): push cohort scans
  DB-side via lead-id filter`. `getSpeedToLeadCohort`'s `close_calls` and
  `close_lead_status_changes` scans no longer pull every row and discard
  non-cohort ones in JS; they filter to the cohort/new-lead set with chunked
  `.in(lead_id)` against the existing indexes. **Provably identical output**
  (drops exactly the rows JS already skipped), so no diff was needed.

### ✅ Also done (2026-06-02) — not previously recorded here

- **lead_cycles N+1 killed** (`473af73`) — `getLeadCycleRows` used to loop over
  every in-window lead issuing 2 queries each (`lead_cycles` + `lead_cycle_stages`,
  `.eq close_id`) — ~1+N×2 sequential round-trips, and ran **twice** on `/funnel`.
  Now `getLeadCyclesByIds`: two chunked `IN` queries (200 ids/chunk, cycles+stages
  in parallel), grouped in memory, and the whole thing wrapped in **React `cache()`**
  so the funnel page's two callers share one computation per request. Measured
  against cloud (280-lead window): **560 round-trips → 4, 93.2s → 1.28s (72×)**,
  byte-identical output. This was the single biggest win to date.
- **Hot indexes** (`2c2199d`, migration `0070_sales_hot_indexes.sql`) — added
  `close_calls (direction, activity_at)` + `close_sms (direction, activity_at)`.
  The connection/FMR scans filtered `(direction, activity_at)` but every existing
  index was keyed on `date_created`, so the planner fell back to full seq scans
  (`close_calls` 1.3s reading 16.7k rows to return 119). Now index range-scans.
- **access-tier memoized** (`53c36d3`) — `getCurrentUserAccessTier` wrapped in
  React `cache()`; removes 2–3 serial `auth.getUser()` + `team_members` round-trips
  per request from nested layouts.
- **maxDuration 60s** (`f7b9be4`) — heavy SSR pages get 60s headroom so a cold
  start aggregates instead of 500-ing. A band-aid, not a fix — the work below is
  what stops needing it.

---

## 🔎 Verification snapshot (2026-06-10) — what's confirmed STILL slow

Verified against current code (not docs). The above fixes are real, but the
structural bottlenecks remain:

- **No SQL aggregation exists for the sales funnel.** `grep '.rpc('` across
  `lib/db` returns only clients/calls/merge/fulfillment RPCs — nothing for the
  funnel. `getSpeedToLeadCohort` still ships raw `close_calls` rows and buckets
  them in JS. Item 1 below is genuinely unstarted.
- **Funnel page awaits are fully sequential** (`funnel/page.tsx:40-46`):
  `getSpeedToLeadCohort → getLeadsForRange → getLeadsFunnel → getDcFunnel →
  getCashCollected`. `getDcFunnel` is independent of the cohort chain but waits
  behind it. See new item 0.
- **Unbounded resolvers are NOT deduped** — only `getLeadCycleRows` got React
  `cache()`. `buildCalendlyLeadResolver`, `buildSetterNameResolver`,
  `buildBookedByResolver` are still rebuilt per call with **no date bound**, so on
  one funnel render `airtable_full_closer_report` is scanned all-time ~3× and
  `close_leads` (via the calendly resolver) is scanned all-time again. See item 6.

**Caching posture (Drake 2026-06-10):** cross-request `unstable_cache` is
**deprioritized** — the dashboard is meant to be played with across date ranges,
and every date change misses the cache, so it can't be the speed strategy. The
goal is **fast on every fresh render without a cross-request cache.** That points
at: SQL aggregation (item 1/2), parallelization (item 0), per-request dedup via
React `cache()` (item 6 — same tool as the lead_cycles fix, and date-change-safe
because it only dedupes within one render), and date-bounding the resolver scans
(item 6). `unstable_cache` stays available as a later add-on, not the foundation.

---

## 🔧 Remaining fixes (not yet done) — priority order

Each "math-rewrite" item below changes *where/how* a number is computed, so it
**MUST** go through **build-alongside-and-diff** (see § Methodology). The
filter-pushdown style (provably identical) does not.

### 0. Parallelize the funnel page's section fetches (trivial, no math change)
`app/(authenticated)/sales-dashboard/funnel/page.tsx:40-46` awaits its five
section loaders one after another. Only `getCashCollected` has real upstream
deps (`dcFunnel` + `funnel.adspendUsd`); the cohort chain and `getDcFunnel` are
independent. Restructure so independent loaders run in `Promise.all` (the People
page already does this — copy that shape). Pure latency reduction, date-range
independent, zero aggregation-math change → does NOT need build-alongside-diff.
Compounds with every item below: parallelism shrinks wall-clock to the slowest
single query, SQL aggregation shrinks that slowest query.

### 1. `getSpeedToLeadCohort` — aggregate calls in SQL (biggest win)
`lib/db/funnel-appointment-setting.ts`. Today it transfers the cohort's raw
outbound `close_calls` rows and buckets them in JS (first/second call,
any-connect, connected duration + count, dial count, caller names). Replace
with a Postgres RPC that returns **per-lead aggregates** + a caller-names lookup
(earliest `raw_payload->>'user_name'` per `user_id`). Keep all cohort-membership
/ qualification / speed / intensity math in TS — only swap how the per-lead maps
(`firstCallByLead`, `secondCallByLead`, `leadsWithAnyConnect`,
`connectedDurationByLead`, `connectedCallCountByLead`, `dialCountByLead`,
`nameByUser`) get populated. That keeps the diff surface tiny.
- **Watch-outs:** first/second-call tie-breaks on identical `activity_at`
  (add a deterministic `close_id` tiebreaker in both versions); `duration` null
  handling (`coalesce(duration,0) >= 90`); the lower bound `activity_at >=
  range.startUtcIso` and the intentionally-omitted upper bound (cumulative).
- **Trigger:** cohorts reaching tens of thousands of leads, or a broad date
  range still timing out after the filter pushdown.

### 2. `getFmrTimeBlocks` — bucket in SQL
Same file. Cached now, but on a cache miss it still scans ~48k `close_sms` +
~16k `close_calls` (date-keyed, all leads). Move the 6 time-of-day buckets +
ever-replied / within-24h rates into a single SQL query (group leads by
ET-hour-of-creation; compute earliest inbound SMS and earliest connected
outbound dial per lead DB-side). Diffable. `close_sms` is the
fastest-growing table, so this is the next to bite.

### 3. `getCallActivityMetrics` (appointment-setting per-rep) — filter + aggregate
Same file. Per-rep volume/outcomes/speed; scans `close_calls`. Apply the same
provably-identical lead/range filter pushdown first, then SQL aggregation if
needed.

### 4. `getLeadsFunnel` dial-window scan — fold into the cohort RPC
`lib/db/leads-funnel.ts`. Already lead-filtered (`.in(lead_id)`), so cheap. When
item 1 lands, compute the windowed dial counts (dials-before-close,
post-reactivation dials/connected) in the **same** SQL pass to drop a separate
`close_calls` round-trip.

### 5. Calendly booking signals — `fetchEventUris` / `collectBookingSignals`
`lib/db/leads.ts`. Pulls ALL `calendly_scheduled_events` + ALL
`calendly_invitees` to classify each lead's booking path. Cheap today (~158
rows) but unbounded as bookings accumulate. Eventually index/filter or
precompute a lead → bookingType mapping.

### 6. Dedupe + date-bound the unbounded resolvers (no math change; date-safe)
`buildCalendlyLeadResolver` (`calendly-lead-match.ts`), `buildSetterNameResolver`
+ `buildBookedByResolver` (`funnel-closing.ts`) each scan a whole table
**all-time, with no date filter**, and are rebuilt independently per caller — so
one funnel/people render re-scans `airtable_full_closer_report` ~3× and
`close_leads` again via the calendly resolver. Two provably-identical fixes, both
**date-change-safe** (they don't cache across requests):
- **Per-request dedup:** wrap each resolver in React `cache()` — the exact tool
  already used for `getLeadCycleRows`. Collapses the 3× rescans to 1× within a
  render; a new date range re-renders and dedupes again (no stale data).
- **Date-bound the scans:** the resolvers only need rows touching the window
  (plus the form-match grace), not all history. Add the window predicate so they
  scale with the chosen range, not total table size. (Provably identical only if
  the predicate provably can't drop a row the lookup would have used — verify the
  id→name / utm→lead maps still cover every referenced key; otherwise diff it.)
This is distinct from item 5 (which is about the volume of calendly rows pulled);
item 6 is about the *number of times* the same table is rescanned per render.

---

## 📐 Methodology — build-alongside-and-diff (Drake's rule)

For any item that re-expresses aggregation in SQL (math could differ), do NOT
edit the live function in place. Instead:

1. Build the SQL/RPC version as a **new** function (`...V2`) next to the
   current one.
2. Run **both** over several real date ranges (today, last 7d, since-May-24,
   a per-caller filter) and **diff the full result** — every row field + every
   aggregate. A temporary Route Handler that calls both and returns a JSON diff,
   curled against the deploy (cloud DB), is the simplest harness.
3. Switch callers to V2 **only when the diff is exactly zero.** Then delete V1
   and the harness.

Provably-identical changes (e.g. a `WHERE lead_id IN (...)` that matches an
existing JS skip) don't need this — note *why* it's provable in the commit.

## 🧱 Standing rule for new dashboard code

New aggregations compute counts/sums/mins **in SQL** (GROUP BY + the indexes)
and return small result sets. Never paginate a whole table into Node to loop
over it. Indexes already exist on the hot columns (`close_calls(lead_id,
date_created)`, `close_sms(lead_id, …)`, `close_leads(date_created)`, etc.) —
use them.

## ⚙️ Migration apply reminder

These fixes add Postgres functions (RPCs) → migrations. Local Docker is up, so
`supabase db push` misroutes — apply via psycopg2 against the pooler + manual
ledger insert + dual-verify (schema/pg_proc AND `schema_migrations`). See
`docs/sales-dashboard-architecture.md` §0.2 and `docs/runbooks/apply_migrations.md`.
