# Sales Dashboard — SQL Aggregation Implementation Plan

**Status:** plan (not yet started)
**Author:** investigation 2026-06-11
**Companion docs:** `docs/fulfillment/PERFORMANCE-SCALING-DEBT.md` (the why + the parallelization/dedup items), `docs/sales/sales-dashboard-architecture.md` (surface map + ops traps), `docs/runbooks/apply_migrations.md` (migration apply).

---

## 0. The point of this plan

Every heavy sales surface today pulls scoped-but-raw rows out of Postgres and
computes counts/sums/mins/buckets in JavaScript, across many sequential
round-trips. That is fast *enough* today and gets linearly slower as the mirror
tables grow. The durable fix is to compute those aggregates **in Postgres** and
return small summary rows.

**The non-negotiable framing Drake set:** SQL aggregation is not a one-off
cleanup — it is the **foundation layer everything else stands on**. After this
plan, the rule is: *a sales surface gets its aggregated numbers from the
aggregation layer (RPCs + the `lead_cycles` tag tables), never by paginating raw
rows into Node.* New features are aggregation-native by default. That is what
makes the work "scoped to future iterations" — each iteration below converts one
cluster onto the shared substrate, and once the substrate exists, all future
sales work builds on top of it instead of re-deriving in JS.

**Why this (and not caching):** cross-request caching (`unstable_cache`) is
deprioritized — the dashboard is meant to be played with across date ranges, and
every date change misses the cache. The aggregation layer makes *each fresh
render* fast natively (Postgres narrows to the window via indexes and returns a
summary), so date-play stays fast with no staleness.

---

## 1. What "the aggregation layer" is — two forms, one excluded

We use **two** complementary forms of SQL aggregation, and deliberately avoid a
third.

**(A) On-the-fly aggregate RPCs — the primary substrate.** Postgres functions
(`returns table`) that take a window (and/or a lead-id set) and return per-lead /
per-rep / per-bucket summary rows computed with `GROUP BY` + window functions
over the existing indexes. Window-flexible, always fresh, fast. This is where the
bulk of the work goes.

**(B) The `lead_cycles` / `lead_cycle_stages` precompute — already exists, lean
in.** The tagger (`shared/lead_tagging.py`, migrations 0067/0076) already rolls
up per-lead-cycle stage timestamps (`connected_at`, `booked_at`, `confirmed_at`,
`showed_at`, `closed_at`, `close_type`, `dc_*`). The surfaces that already read it
(`getDcFunnel`, `getCashCollected`, `getLeadsFunnel` via `getLeadCycleRows`) are
the **lightest** in the whole audit. The lesson: a precomputed per-cycle stage
table IS aggregation done right. Where a new funnel signal is stable per cycle,
the cleanest home is the tagger writing it onto `lead_cycle_stages`, not a fresh
JS scan.

**(C) Materialized views — explicitly NOT used here.** A materialized view stores
a frozen answer and refreshes on a schedule — same staleness tradeoff as caching,
which conflicts with date-flexible play. Reserve as a *possible later*
optimization for fixed cohorts only; not part of this plan.

---

## 2. Iteration 0 — Foundation (build before anything else)

Nothing user-facing changes in Iteration 0. It lays the substrate every later
iteration consumes. **Do this first and completely.**

### 2.1 Shared SQL semantic helpers (semantics live in ONE place)

The JS code encodes the same business semantics over and over — these must move
into SQL helpers so every RPC inherits identical meaning:

- `sales.et_day(ts timestamptz) returns date` — ET calendar day. Must match the
  JS `Intl.DateTimeFormat('America/New_York')` / `etDateMidnight` output **exactly,
  including DST**. (Postgres `(ts AT TIME ZONE 'America/New_York')::date`.)
- `sales.et_hour(ts timestamptz) returns int` — ET hour-of-day (0–23) for the FMR
  + revival time-of-day buckets. Must match JS `etHourOfDay`.
- A single source for the **90s connected threshold** (`FMR_DIAL_CONNECTED_SEC` /
  `CONNECTED_SEC`) — a SQL constant or inlined `coalesce(duration,0) >= 90`.
- Soft-hide predicate convention: `excluded_at is null` (and the
  `display_name <> 'test'` test-row drop) applied consistently.

**Correctness gate for 2.1:** before any RPC ships, prove ET parity — run
`sales.et_day` / `sales.et_hour` against a spread of timestamps (incl. an
EST↔EDT transition date) and diff against the JS helpers' output. A 1-hour or
1-day disagreement here silently corrupts every cohort and bucket.

### 2.2 The core per-lead call/SMS aggregate RPC (THE primitive)

`sales_lead_call_metrics(p_lead_ids text[], p_opt_in_ats timestamptz[], p_close_ats timestamptz[] /*nullable per lead*/)`

Returns, per lead, everything the JS loops currently compute over `close_calls` /
`close_sms`:

- `first_call_at`, `first_call_user_id`, `first_call_duration` (earliest outbound
  ≥ that lead's `opt_in_at`, ordered `activity_at` then `close_id` tiebreak)
- `second_call_duration` (for the first-two-dials-connected signal)
- `any_connect` (bool — a ≥90s outbound exists)
- `connected_duration_sum`, `connected_call_count`
- `dial_count` (capped at `close_at` when supplied — the funnel's "dials before
  close"; no upper bound otherwise — cumulative intensity, intentionally)
- `earliest_inbound_sms_at`, `earliest_connect_at` (the FMR signals)

The per-lead `opt_in_at` lower bound (the re-opt-in reset) is handled in SQL by
unnesting the parallel `p_lead_ids` / `p_opt_in_ats` arrays into a cohort CTE and
joining: `... and k.activity_at >= cohort.opt_in_at`. First/second call via
`row_number() over (partition by lead order by activity_at, close_id)`. Connect
aggregates via `count(*) filter (where coalesce(duration,0) >= 90)`.

**This single RPC replaces the heaviest JS in the audit** — the `close_calls`
pass in `getSpeedToLeadCohort` (funnel-appointment-setting.ts:1330–1378), the two
paginated scans in `getFmrSignals` (182–214), and `scanDialWindows`
(leads-funnel.ts) — and it feeds `getLeadsForRange` (leads.ts) too. One grouped
query instead of N chunked-and-paginated round-trips + JS Maps.

### 2.3 The diff harness + standing rule

- **Diff harness:** a temporary Route Handler that calls V1 (JS) and V2 (RPC) for
  the same inputs and returns a field-by-field JSON diff, curl-able against the
  deploy (cloud DB). Reused by every iteration. (Per `docs/fulfillment/PERFORMANCE-SCALING-DEBT.md`
  § Methodology.)
- **Standing rule** (write into `docs/fulfillment/PERFORMANCE-SCALING-DEBT.md` § Standing rule):
  *New sales aggregations compute counts/sums/mins in SQL via the aggregation
  layer and return small result sets. Never paginate a whole table into Node to
  loop over it.* This is the line that makes the foundation stick.

**Exit criteria for Iteration 0:** ET helpers parity-proven; `sales_lead_call_metrics`
exists, dual-verified (schema + ledger), and its output diffs byte-identical
against the JS it will replace over ≥4 windows (today, 7d, since-May-24, a
per-caller filter). No callers switched yet.

---

## 3. The conversion iterations (each builds on Iteration 0)

Ordered by traffic × pain. Each iteration: build the V2 path on the substrate,
diff to zero, switch callers, delete V1. Each is independently shippable.

### Iteration 1 — Cohort + FMR (highest traffic: Funnel + Leads pages)
- **Convert:** `getSpeedToLeadCohort` (the `close_calls` pass) and
  `getFmrSignals` onto `sales_lead_call_metrics`. Keep all cohort-membership /
  qualification / speed / intensity math in TS — only swap how the per-lead maps
  (`firstCallByLead`, `leadsWithAnyConnect`, `connectedDurationByLead`,
  `dialCountByLead`, the FMR `inbound`/`connect` maps) get *populated*.
- **Watch-outs:** first/second-call tiebreak on identical `activity_at`
  (deterministic `close_id`); `coalesce(duration,0) >= 90`; lower bound is the
  per-lead `opt_in_at`, upper bound intentionally omitted (cumulative); revival-CF
  and `excluded_at` drops stay in the membership step (TS), not the RPC.
- **Why first:** these feed `/funnel` and `/leads`, the two most-hit pages, and
  `close_sms` (~48k, fastest-growing) is in `getFmrSignals`.

### Iteration 2 — Funnel boxes + dial windows
- **Convert:** `scanDialWindows` / `getLeadsFunnel`'s separate `close_calls`
  round-trip — fold the windowed dial counts (dials-before-close,
  post-reactivation dials/connected) into the **same** `sales_lead_call_metrics`
  pass (pass per-lead `close_at` + `reactivated_at` bounds). `getLeadsFunnel`
  otherwise already runs on `lead_cycles` (light) — leave that.
- **Watch-outs:** the close-time cap and the `reactivated_at` lower bound are
  per-lead; preserve the "dials reset at opt-in, capped at close" semantics.

### Iteration 3 — Per-rep tables (Talent page)
- **Convert:** `getCallActivityMetrics`, `getCallActivityForUser`,
  `getSpeedToLead`, `getSpeedToLeadLeadsForUser`, `getAppointmentSettingMetrics`,
  and `getDigitalCollegeActivity`'s per-closer dial count — onto a new
  `sales_rep_call_activity(p_since, p_until)` RPC (per `user_id`: total calls,
  calls-over-90, **distinct connected sessions**, per-lead-first-call for speed).
- **Key simplification:** the JS "session grouping" with `SESSION_GAP_MS =
  Infinity` (collapse all >90s calls to a lead by a rep into one session) is
  exactly `count(distinct lead_id) filter (where duration > 90)` per user in SQL —
  the whole `groupCallsIntoSessions` machinery disappears.
- **Watch-outs:** `getAppointmentSettingMetrics` uses **duration > 0** as
  "connected" (NOT 90s) — different threshold, keep it. Status-flip outcomes
  (7-day lookback) and form-outcome routing stay TS for now (or move with
  Iteration 4). Role attribution (per-lead owner → global fallback) stays TS.

### Iteration 4 — Closer drill + forms + cash (the gnarly one)
- **Convert:** the form-outcome derivation shared by `getClosingScheduledList`,
  `getClosingActivity`, `getCashCollected`, `getDcFunnel`, and `getLeadsForRange`'s
  outcome signals — into `sales_lead_form_outcomes(p_lead_ids text[])`: a
  lateral/window query that picks the **winning** closer form per lead (form_type
  `New` > `Old`, then newest `airtable_created_at`) and maps `call_outcome` →
  `showed` / `closed` / `closeType` / `upfront`, with the ±48h event-match window.
- **Resolvers** (`buildCalendlyLeadResolver`, `buildSetterNameResolver`,
  `buildBookedByResolver`): these are *lookups*, not aggregations — handle via
  `docs/fulfillment/PERFORMANCE-SCALING-DEBT.md` item 6 (per-request `cache()` + date-bound), and
  eventually a unique-`utm_term` index/view + an id→name lookup table. Note them
  here so the cluster lands coherent.
- **Long-term:** the cleanest home for `showed`/`closed`/`closeType` is the
  **tagger writing them onto `lead_cycle_stages`** (some already exist:
  `closed_at`, `close_type`, `dc_*`). Where that lands, the RPC reads cycles
  instead of re-deriving from forms.
- **Watch-outs:** deposit-is-not-a-close; DC excluded from HT cash;
  `amount_paid_today_number` over `_currency`; New-vs-Old field divergence;
  setter id→name resolution; `excluded_at` + `display_name='test'` drops;
  form-only instant-book rows (no Calendly event); the 14-day late-fill widen +
  client-filter on `effectiveTsIso`.

### Iteration 5 — Trend / time-of-day surfaces (per-ET-day GROUP BY)
- **Convert:** `getRevivalFunnel` / `getRevivalCalled` / `getRevivalTimeOfDay`
  (funnel-revival.ts), `getTypeformMetrics` (the dual raw-response loop), and
  `pulse-history.ts` (`getPulseHistory` + `fetchFmrDaily`). These bucket per ET
  day / 2-hour block — the natural fit for `GROUP BY sales.et_day(...)` /
  `sales.et_hour(...)` with `count(*) filter (...)`.
- **Big win in Pulse:** `getPulseHistory` currently drives ~6 fetchers × 14 days
  (~84 round-trips) and re-scans Typeform every day. A single grouped-by-day RPC
  per metric collapses that to one query. `fetchFmrDaily`'s SMS+calls paginated
  scans become one grouped query (reuses the Iteration-1 FMR aggregate, grouped by
  `et_day(date_created)`).
- **Watch-outs:** revival anchor = `max(date_created, REVIVAL_FLOOR)`;
  revival "connected" requires a *call* backing a form; no-plan "DC Closed"
  excluded; monotonic backfill; distinct-leads-per-bucket (not per-message);
  Typeform qualified/non-qualified classification (the budget-field parse) must
  move into SQL (a `CASE` over the `answers` jsonb) or a classification column.

### Iteration 6 — Peripheral cleanup
- **Convert:** `ceo-missing-forms.ts` `leadIndex()` — the twice-per-call full
  `close_leads` scan to build email/name → lead maps. Replace with an indexed
  lookup (a unique-email/name view or a small RPC). Low traffic; do last.

---

## 4. Explicitly OUT of scope (already LIGHT — do not touch)

These read **pre-rolled daily mirror tables** or already use server-side
`count: 'exact', head: true`. They aggregate a few dozen daily rows in JS — there
is nothing to win, and rewriting them adds risk for no gain:

- `funnel-ads.ts` (reads `meta_ad_daily` / `cortana_campaign_daily` — daily rollups)
- `funnel-lp.ts` (reads `clarity_metrics_daily` / `wistia_media_daily`)
- `sales-dashboard.ts` — the v2 metric catalog (already `count:'exact'` + daily mirrors)
- `ceo-control-center.ts` (count + sum over ~30 daily rows)

The standing rule still applies to *new* work in these files, but no conversion
is planned. (If `getTypeformMetrics`'s raw-response loop is invoked from the
catalog, it rides Iteration 5, not here.)

---

## 5. Cross-cutting correctness constraints (apply to EVERY iteration)

Any SQL rewrite MUST preserve these exactly — they are the landmines:

1. **ET timezone parity** — `et_day`/`et_hour` must equal the JS `Intl` output
   incl. DST. Parity-proven in Iteration 0; re-checked anywhere a bucket is built.
2. **90s connected threshold** everywhere EXCEPT `getAppointmentSettingMetrics`
   (which uses `duration > 0`). Don't unify them.
3. **Re-opt-in / `optInAt` scoping** — per-lead lower bound; a prior journey's
   calls/forms don't count. This is *the* most common silent-wrong risk.
4. **Intentionally-omitted upper bounds** — cumulative intensity has NO upper
   bound on `activity_at`; don't "helpfully" add one.
5. **Deterministic tiebreakers** — identical `activity_at` → break on `close_id`
   in both V1 and V2, or first/second-call assignment diverges.
6. **Soft-hide** — `excluded_at is null` (+ `display_name <> 'test'`) per surface;
   not every surface filters it today — match the existing behavior per function.
7. **Form selection** — New over Old, then newest `airtable_created_at`; deposit
   ≠ close; DC excluded from HT cash.
8. **lead_cycles is the type/stage source of truth** (tag-primary,
   `close_leads.reactivated_at` fallback) — don't reintroduce close_leads-derived
   classification.
9. **Unique-`utm_term` guard** — only tokens mapping to exactly one lead are
   usable; never drop this.

---

## 6. Methodology + ops (per existing rules)

- **Build-alongside-and-diff (Drake's rule):** every math-rewrite ships as a
  `...V2` next to V1, both run over several real windows, full-result diff, switch
  only at **zero diff**, then delete V1 + harness. Provably-identical changes
  (e.g. a `WHERE` that matches an existing JS skip) skip the diff but note *why*
  in the commit. (Filter-pushdown style.)
- **Migration apply:** these RPCs are migrations. Local Docker is up →
  `supabase db push` misroutes → apply via **psycopg2 against the pooler + manual
  ledger insert + dual-verify** (schema/`pg_proc` AND `schema_migrations`). See
  `docs/sales/sales-dashboard-architecture.md` §0.2 and `docs/runbooks/apply_migrations.md`.
  **SQL review is a Drake gate** — he reviews each function's SQL before apply.
- **Security:** RPCs are called via the service-role admin client (RLS bypass, as
  today). Define functions `security definer` only if needed; keep them read-only.
- **Indexes:** the hot ones exist (`close_calls/close_sms (direction,
  activity_at)`, lead-id indexes, `close_leads(date_created)`). Each RPC's
  `EXPLAIN ANALYZE` is checked on apply; add a composite only if the planner asks.

---

## 7. Sequencing summary

| Iter | Cluster | Primary substrate | Risk | Gives |
|---|---|---|---|---|
| 0 | Foundation | ET helpers + `sales_lead_call_metrics` + diff harness + rule | low (no callers switched) | the layer everything builds on |
| 1 | Cohort + FMR | `sales_lead_call_metrics` | med (math-rewrite) | fast `/funnel` + `/leads` |
| 2 | Funnel dials | same RPC (extended bounds) | low–med | one fewer round-trip |
| 3 | Per-rep (Talent) | `sales_rep_call_activity` | med | fast `/people`, session logic deleted |
| 4 | Closer/forms/cash | `sales_lead_form_outcomes` (+ tagger long-term) | **high** (gnarly) | fast closer drill + cash |
| 5 | Trend/time-of-day | per-day `GROUP BY` RPCs | med | Pulse 84→~6 queries, revival/typeform |
| 6 | Peripheral | indexed lookup | low | ceo-missing-forms scan gone |

**Do Iteration 0 fully, then 1, then reassess.** 1–3 are the bulk of the felt
speed and the bulk of the scaling win; 4 is the careful one; 5–6 are cleanup with
a nice Pulse payoff. After 0–1 land, every *new* sales feature already has the
substrate to build on — which is the whole objective.
