# Sales Dashboard (v1)

Admin-tier page at `/sales-dashboard`. Visualizes the Engine sheet
(`Data Sheet - Overall Engine.csv` at repo root) — 9 sections, ~140
metrics — against the seven ingested mirror tables. v1 reads
DIRECTLY from those mirrors (no aggregation layer, no views).

- Code: `app/(authenticated)/sales-dashboard/{layout,page}.tsx`,
  `lib/db/sales-dashboard.ts`.
- Auth: admin tier or higher. Reuses the existing
  `getCurrentUserAccessTier()` + `tierAtLeast(..., 'admin')` gate that
  guards `/cost-hub`. Non-admin tiers redirect to
  `/clients?error=insufficient_access`.
- Nav: a "Sales" item in `components/top-nav.tsx`, visible only to
  admin+ (Nabeel, Drake).
- Spec: `docs/specs/sales-dashboard-v1.md`.

## The three states (legend, also rendered on the page)

Each metric card renders in one of three states. The rule for choosing
the state is structural — applied at catalog-write time, not by guessing
at runtime.

- **LIVE** (green dot, real number) — the metric is a direct count /
  sum / filter / average over **one mirror table** (or one source's
  tables, e.g. Calendly events + invitees, where the schema docs treat
  the join as the canonical aggregation pattern). The catalog entry
  carries a `fetcher` key; the data layer's `FETCHERS` map runs the
  query and returns `number | null`.
- **PENDING** (gold dot) — the metric needs (a) a cross-source join
  (Meta spend × Typeform leads, Clarity visits × Typeform opt-ins,
  Airtable × Typeform freshness), (b) a derived ratio that depends on
  other PENDING/LIVE cells, or (c) it hits one of the flagged
  ambiguities surfaced by the schema docs (the five Airtable cash /
  setter-led ambiguities, the objection rows with no structured source,
  `is_setter_led` provisionality). Cards render with the metric title,
  source label, and a "PENDING" badge — no number.
- **NOT CONNECTED** (grey dot) — the upstream source is not ingested at
  all. Today: IG Analytics, YT Analytics, Gamma, GoHighLevel, Wix,
  Base44, Instantly, TrustPilot, and the manual "Business Costs"
  category. The entire CONTENT, BACK END REV, and BUSINESS COSTS
  sections render as not-connected columns so Nabeel sees the full
  Engine shape — and what's pending — at a glance.

The cardinal rule: **a metric is either a real number from one mirror
table, or it's visibly pending**. The dashboard NEVER renders a
computed-but-unverified number as fact. When unsure whether a cell is
single-source-clean, the catalog entry defaults to PENDING.

## What's LIVE today (v1)

Roughly 30 metrics out of ~140 land as LIVE. The exact list is in the
`METRICS` array in `lib/db/sales-dashboard.ts`; here it is by section:

- **ADVERTISING (Meta — `meta_ad_daily`):** all 7 rows live. Total
  Adspend, Frequency, Total Impressions, Unique Link Clicks, Cost per
  Impression, Cost per Unique Link Click, Click Through Rate. Cost-per
  metrics use volume-weighted ratios (total spend / total impressions,
  etc.) rather than averaging the per-day rates.
- **FUNNELS:**
  - `clarity_metrics_daily`: Landing Page Visits, Average Time on
    Landing Page, Average Time on Thank-You Page. Clarity rows are
    rolling-3-day snapshots; the dashboard displays the **latest
    snapshot** per path. Average-time-per-session pairs the Traffic
    block's `total_session_count` with the EngagementTime block's
    `active_time`, both from the same snapshot date.
  - `wistia_media_daily`: VSL Engagement Rate, VSL Average View
    Duration, TYP Engagement Rate, TYP Average View Duration. VSL =
    `i1173gx76b` + `nbump1crwb`; TYP = `fbgjxwe62y`.
  - `typeform_responses`: Typeform Submits ("Leads") — counts all
    submissions across all funnels, in last 7 days. NOT filtered to one
    form id (the historical Setter Funnel `PWSNd0h2` went dormant;
    `SFedWelr` is the active funnel today; hardcoding either would go
    stale).
  - `calendly_scheduled_events` + `calendly_invitees`: Total Closer
    Bookings, Closer Booking Next Day, Closer Booking Two Days Out.
    "Closer" = `name` ILIKE one of the entries in
    `ingestion/calendly/__init__.py CLOSER_EVENT_TYPE_NAMES`
    (currently `"ai partner strategy call"`). Booking-delta computed in
    America/New_York per the schema's date-math gotcha.
- **APPOINTMENT SETTING:**
  - `airtable_setter_triage_calls`: Total Setter Triages, Setter DQs
    after Triage, Setter Triage Downsells, Closer Confirmed Meetings.
    Time-axis is `airtable_created_at` (record-create), NOT the
    user-entered `booked_at` — see § Time-axis choices below.
  - `close_calls`: Total Dials (outbound count in window).
- **CLOSING:**
  - `calendly_scheduled_events` + `calendly_invitees`: New Scheduled
    Meetings, New Rescheduled Meetings. Filtered by invitee
    `status='active'` AND `rescheduled` flag.
  - `airtable_full_closer_report`: Showed (new), No Shows / Ghosts,
    Reschedules, Cancelled Meetings, Closed Deals - New, Closed Deals -
    Follow Up, Total Closed Deals. All filter on `date_time_of_call`
    in the window; the Cancelled metric `.in_()`'s the two cancellation
    `no_show_reason` values into one count.
  - `calls`: Average Meeting Duration. Filter `call_category='client'`.
- **FULFILLMENT (`calls`):** Calls Held. Same filter as Average Meeting
  Duration — count.

## What's PENDING and why

In groups, the recurring reasons:

- **Cross-source joins:** Cost per opt-in (Meta × Typeform), Cost per
  Direct Book (Meta × Calendly), LP Conversion Rate (Clarity ×
  Typeform), Qualified Lead to Direct Book (Typeform × Calendly),
  Setter Triages from fresh/old opt-ins (Airtable × Typeform), and
  every Cost-per-X metric.
- **Derived ratios:** Hand Down Rate, DQ Rate, Downsell Rate, Show
  Rate, Close Rate, ROAS, AOV, all the SALES DATA section. They depend
  on other LIVE/PENDING numbers; a future aggregation layer composes
  them.
- **Close Smartview semantics:** First Message Responses, Total Closer
  Triages, Hand Downs, Hand Offs Completed, the setter-meetings family,
  Tier 1/2 Booked Meetings. These all reflect Close-side filtered views
  that the raw `close_leads`/`close_calls`/`close_lead_status_changes`
  mirrors don't reproduce without complex query trees.
- **Schema-flagged Airtable ambiguities** (per
  `docs/schema/airtable_full_closer_report.md`):
  - Objection categorization (Shopping / Think-About-It-Fear / Spouse) —
    no structured field; lives in `call_notes_lost` free text.
  - `is_setter_led` is provisional (N=2 sample, 50% fill) — Closed Deals
    - Direct-Booking-Led / Setter-Led PENDING until N≥100.
  - "Total Deposits" (count vs sum semantic unclear).
  - Cash Collected splits (two competing currency fields).
- **Typeform internals:** Typeform Engagement, Completion Rate,
  Qualified / Non-Qualified Opt-Ins. The mirror doesn't carry
  visit-vs-submit funnel data, and "qualified" needs a per-form scoring
  rule the dashboard doesn't yet encode.

## What's NOT CONNECTED today

Whole sections render as not-connected columns:

- **CONTENT (16 rows):** IG Analytics + YT Analytics not ingested.
- **BACK END REV (9 rows):** GoHighLevel, Wix, Base44, LLC, Instantly,
  Payplan, Upsell, Referral, Client Sales (5%) — none of these revenue
  streams are mirrored.
- **BUSINESS COSTS (6 rows):** Closer / Setter / Mgmt / Fulfillment /
  Software / Other Costs — there's no category-tagged cost ingestion
  (the Cost Hub's `monthly_subscriptions` table is untagged).

Individual not-connected cells inside otherwise-live sections:

- APPOINTMENT SETTING → Pre-Call Gamma Average Time Spent (Gamma not
  ingested).
- FULFILLMENT → TrustPilots Generated (no TrustPilot mirror).

## Time-axis choices

- **Rolling last 7 days, UTC-anchored.** The dashboard window is
  `now() - 7 days` to `now()`. The 5-hour EST-vs-UTC drift on the
  window's lower boundary is ~0.7% of the span — within tolerance for
  a v1 admin overview. A formal EST window helper exists at
  `lib/time/est-periods.ts`; v2 should adopt it.
- **Clarity is a special case.** Each `clarity_metrics_daily` row is a
  rolling-3-day snapshot (the API has no historical-range endpoint).
  Aggregating across snapshots would double-count. The dashboard
  displays the **latest snapshot** for each Clarity-sourced metric, and
  the per-card note reads "Latest 3-day snapshot". Mathematically the
  Landing Page Visits number is "sessions Clarity observed in the 3
  days ending at the last cron tick" — not "last 7 days."
- **Setter triage time-axis:** the data layer filters
  `airtable_setter_triage_calls` on `airtable_created_at`, not the
  user-entered `booked_at` column the schema doc recommends. Reason:
  ingestion went live 2026-05-23 and 0 of 4 rows have `booked_at`
  filled as of 2026-05-24 — operators haven't started using the field
  yet. Using `airtable_created_at` gives the dashboard real numbers
  while the team's data hygiene catches up. The per-card note "By
  Airtable record-create time" surfaces this so Nabeel reads the
  number with the right semantic. **Switch back to `booked_at` once
  the team consistently fills the column.**
- **Closer report time-axis:** `date_time_of_call` is well-populated
  on the closer report and matches the Engine intent — kept as-is.

## How to promote a PENDING metric to LIVE

1. Decide the metric is single-source-clean (or has an explicit
   resolution — e.g. Drake/Aman confirms which Airtable cash-paid field
   is canonical).
2. Add or change the fetcher in `lib/db/sales-dashboard.ts` (`FETCHERS`
   map). Use existing fetchers as templates; per-card error catching is
   handled by the orchestrator.
3. Flip the catalog entry's `status` from `'pending'` to `'live'`, set
   `fetcher` to the new function key, and set `format` to the
   appropriate display format.
4. Re-run `.venv/bin/python scripts/smoke_sales_dashboard_queries.py`
   if you added a new table read — it's the fastest validation that
   the columns / filters resolve.
5. Type-check (`npx tsc --noEmit`) and ship. The page is auto-rerendered
   on every request (`export const dynamic = 'force-dynamic'`).

## How to add a new section

(Future-proofing note — not needed for v1.) If a new source comes
online (GoHighLevel ingestion lands, IG Analytics gets wired up, etc.):

1. Flip the `status` on the appropriate not-connected metrics from
   `'not_connected'` to `'live'` (or `'pending'`).
2. Add fetchers per § above.
3. The kanban grid auto-resizes — no layout change needed.

## What's deferred to v2

- **Real graph rendering.** Each kanban column ships with one
  placeholder graph frame at the bottom. v2 picks a chart library
  (none is currently a dependency — see `package.json`), wires per-card
  sparklines, and ships time-series storytelling.
- **A time-window picker.** v1 is fixed at last 7 days. Today / 7d /
  30d / MTD toggles are a small extension once the data layer is shaped
  around windows (it already is — `getWindowStartIso()` /
  `getWindowStartDate()` are the only places to plumb a param).
- **An aggregation layer / views.** v1 reads mirrors directly. A future
  spec creates an `aggregation/sales_dashboard/` package with one
  function per Engine row, returning typed results — the catalog
  becomes a list of "agg function name + display format" rather than
  inline SQL.
- **PENDING → LIVE promotions** as the schema-doc ambiguities resolve
  (is_setter_led, cash field canon, objection categorization, Close
  Smartview reproduction).

## Smoke probe

`scripts/smoke_sales_dashboard_queries.py` exercises every LIVE
query's column + filter shape against cloud. Read-only. Useful as a
post-deploy sanity check, after a mirror-table column rename, or before
flipping a PENDING entry to LIVE.

```bash
.venv/bin/python scripts/smoke_sales_dashboard_queries.py
```

Prints one section per source with row counts and key derived values.
Non-zero exit indicates a query shape broke (e.g. a column was renamed
mirror-side and the dashboard's filter is now invalid).

## Post-deploy verification (Drake gate (c))

After `git push` triggers a Vercel deploy:

1. Visit `/sales-dashboard` as an admin user (Drake or Nabeel).
2. Verify the page renders without auth redirect and the nine section
   columns are present in order.
3. Spot-check one LIVE number per section against the smoke probe's
   output. They should match exactly (same query, same window).
4. Confirm the legend at the top reads sensible LIVE / PENDING / NOT
   CONNECTED counts.

If a LIVE card shows "ERROR", hover for the tooltip with the underlying
PostgREST error. The most common cause is a mirror-table column rename
(in which case the smoke probe will reproduce the same error locally).
