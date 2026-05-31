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

---

## 🔧 Remaining fixes (not yet done) — priority order

Each "math-rewrite" item below changes *where/how* a number is computed, so it
**MUST** go through **build-alongside-and-diff** (see § Methodology). The
filter-pushdown style (provably identical) does not.

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
