# Report: Sales Dashboard v1 — Admin-Gated Engine View (Gregory)
**Slug:** sales-dashboard-v1
**Spec:** docs/specs/sales-dashboard-v1.md

Executed on branch `main`. Confirmed `git branch --show-current`
returned `main` before any write.

## Files touched

**Created:**

- `app/(authenticated)/sales-dashboard/layout.tsx` — admin-tier gate.
  Mirror of the cost-hub layout: `getCurrentUserAccessTier()` +
  `tierAtLeast(access.tier, 'admin')`, redirects non-admins to
  `/clients?error=insufficient_access`. Preview-mode bypass passes
  through.
- `app/(authenticated)/sales-dashboard/page.tsx` — server-component
  page with `export const dynamic = 'force-dynamic'`. Renders
  HeaderBand + legend + 9-column kanban + placeholder graph cards.
  Pulls all data via `fetchSalesDashboardData()`.
- `lib/db/sales-dashboard.ts` — data layer. The full `METRICS` catalog
  (~110 entries mirroring the Engine sheet row-for-row), the
  per-LIVE-metric fetchers, the orchestrator with per-card try/catch,
  and the display-format helpers. ~640 lines.
- `docs/runbooks/sales_dashboard.md` — full runbook covering the
  three-state legend, per-section LIVE / PENDING / NOT-CONNECTED
  inventory, time-axis rationale, the promote-to-LIVE recipe,
  post-deploy verification.
- `scripts/smoke_sales_dashboard_queries.py` — read-only probe of
  every LIVE query's column + filter shape against cloud; one section
  per source, prints row counts + key derived values.
- `docs/reports/sales-dashboard-v1.md` — this file.

**Modified:**

- `components/top-nav.tsx` — added `{ href: '/sales-dashboard', label: 'Sales', requiredTier: 'admin' }` to `NAV_ITEMS` and the matching
  `isActive` branch. Sits between Cost Hub and Tasks in the nav order.
- `docs/state.md` — appended one entry at the end documenting the
  ship: what's LIVE / PENDING / NOT-CONNECTED, the three judgment
  calls (setter-triage time-axis, Calendly no-FK two-query, Typeform
  no-form-id-filter), tabs post-state.
- `CLAUDE.md` — updated § Current Focus + § Next Session Priorities to
  reflect that the first piece of the Gregory V2 sales-side arc has
  shipped, with the broader scoping conversation still pending.

## What I did, in plain English

Built the v1 admin-only sales engine dashboard at `/sales-dashboard`.
The page is one big kanban grid: 9 columns, one per Engine-sheet
section (Advertising, Content, Funnels, Appointment Setting, Closing,
Sales Data, Back End Rev, Business Costs, Fulfillment), each column
stacking ~5–47 cards covering every row of the Engine sheet.

Each card declares one of three states. **LIVE** cards run a real
query against one mirror table (or one source's tables for Calendly)
and show a number. **PENDING** cards have no number — they need a
cross-source join, a derived ratio, or hit one of the schema-doc-
flagged Airtable ambiguities. **NOT CONNECTED** cards reflect upstream
sources we don't ingest at all (IG / YT analytics, GoHighLevel, Wix,
Gamma, TrustPilot, manual cost categories).

The data layer's `METRICS` array is the catalog. Each entry carries
`section / title / status / source / fetcher? / format? / note?`. The
orchestrator runs every LIVE fetcher in parallel via `Promise.all`,
wraps each in try/catch (one failing card doesn't take the page down),
and returns a map keyed by metric id. The page renders the cards from
the catalog + the result map.

Visual language reuses Gregory's existing primitives — `HeaderBand`,
`geg-gold-box`, `geg-numeric-serif`, `geg-mono`, the gold accent / pos
/ warn / neg color tokens, the existing 32px-padding / 1600-max-width
admin layout pattern. Per the spec's "invent nothing" rule, every
class and color is something already in use elsewhere; the only new
visual is the 9-column horizontally-scrolling kanban grid, which is a
straight `grid-template-columns: repeat(9, minmax(280px, 1fr))`.

Auth uses the existing access-tier infrastructure verbatim. A new
route-group layout (`/sales-dashboard/layout.tsx`) calls
`getCurrentUserAccessTier()` and gates on `admin`, mirroring the
cost-hub pattern. The new nav item is added to TopNav with the same
`tierAtLeast(actual, 'admin')` filter, so CSMs and head-CSMs don't see
it at all. Preview-mode bypass (`NEXT_PUBLIC_DISABLE_AUTH=true`) works
identically to other admin gates.

## Verification

**Type-check (`npx tsc --noEmit`):** EXIT=0. Clean across all touched
TS files.

**ESLint (`npx next lint --file ...`):** EXIT=0, no warnings or errors
on `lib/db/sales-dashboard.ts`,
`app/(authenticated)/sales-dashboard/page.tsx`, `layout.tsx`, and
`components/top-nav.tsx`.

**Python test suite (`.venv/bin/python -m pytest tests/ -q`):** 1028
passed, 2 warnings (DeprecationWarning from a Supabase client
dependency, unrelated to this work). No Python production code
touched, so no regression possible from this spec — the run is a
defensive check per the "never commit with failing tests" rule.

**Cloud smoke (`.venv/bin/python scripts/smoke_sales_dashboard_queries.py`):** all probes returned without
errors. Real numbers (7-day window, today 2026-05-24):

- **Meta:** 7 rows, spend $5,988.88, impressions 91,321 → derived CPM
  $0.0656.
- **Clarity:** Traffic@/lp latest 2026-05-24 sessions=15;
  EngagementTime@/lp latest active_time=79s (12 url rows);
  EngagementTime@/confirmation latest active_time=63s (2 url rows).
- **Wistia:** VSL (2 medias) plays_filtered=1392 played_time=55,822s
  avg_engagement_rate=12.92%; TYP plays_filtered=44 played_time=3,683s
  avg_engagement_rate=27.04%.
- **Typeform:** 11 opt-ins across all forms.
- **Calendly:** 43 active events, 43 new (active+!rescheduled), 0
  rescheduled, 30 closer bookings.
- **Airtable setter triage** (by `airtable_created_at`): 4 total, 0
  DQs, 0 Downsells, 2 Confirmed Booked with Closer.
- **Close calls:** 604 outbound dials in 7d.
- **Airtable full closer:** 1 Showed (Consultation Call), 0 Cancelled,
  0 Closed-anything-yet.
- **Calls (Fathom):** 45 client calls, avg duration 1,636s.

The numbers also surfaced one operational reality (Airtable ingestion
just went live, sparse data) and validated the data layer's
fail-soft posture against an empty mirror window.

**NOT verified:** the rendered page in a browser. No deploy preview
exists for me to load (Drake gate (c) territory); type-check + lint +
smoke probe are the surrogate. The cost-hub precedent (per
`docs/reports/cost-hub-current-month-total-fix.md`) explicitly
acknowledges there's no JS/TS test runner in the repo and treats
post-deploy Playwright + manual eyeball as the verification path. The
same applies here.

## Surprises and judgment calls

**Three real findings during build, all flagged in the runbook:**

1. **Calendly has no FK on `event_uri`** between
   `calendly_scheduled_events` and `calendly_invitees` — by design
   (loose-ref per webhook-ordering + retired event-type tolerance,
   documented in the schema). My first cut used PostgREST's `!inner`
   embedded-relation syntax (per the schema docs' example queries),
   which immediately errored with PGRST200 "no relationship found."
   Smoke caught it on first run. Rewrote both the TS data layer and
   the smoke to do two separate queries + JS-side merge via
   `partitionBookings()`. Counts metrics still single-source (Calendly
   only); the change is mechanical.

2. **Setter triage `booked_at` is sparsely populated.** Schema doc
   recommends it as the time-axis (it's the user-entered "when the
   setter booked the call" timestamp), but 0 of 4 rows have it filled
   today (ingestion went live 2026-05-23). Switched to
   `airtable_created_at` (Airtable's record-creation timestamp,
   always populated) so the dashboard shows real counts (4 total / 2
   Confirmed) instead of a row of zeros. Each setter-triage card
   carries a "By Airtable record-create time" note so the semantic
   is unambiguous. Runbook documents how to flip back once operators
   start filling `booked_at`.

3. **Typeform Setter Funnel form id is stale.** The
   `docs/schema/typeform_responses.md` schema doc names `PWSNd0h2` as
   the active Setter Funnel; live data shows it's had 0 submissions
   in the last 30 days, while `SFedWelr` (labeled "Closer Funnel" in
   the docs) is now the active form. Hardcoding either id would go
   stale as funnels rotate. Dropped the `form_id` filter entirely;
   "Typeform Submits ('Leads')" now counts all opt-ins across all
   funnels in the window. Per-card note reads "All active funnels."

**Two design calls worth surfacing for Drake's read:**

4. **No `/admin/*` URL prefix.** The spec example called the route
   `/admin/sales-dashboard`. Gregory has no `/admin/*` convention;
   `/cost-hub` lives at the root authenticated path and gates via its
   layout, so `/sales-dashboard` matches precedent. The spec text
   said "e.g. `/admin/sales-dashboard`" with the "e.g." doing work, so
   this read as latitude rather than a hard call. Same call on "no
   admin landing page" — Gregory has no admin landing surface to add
   a card to; the nav item is the equivalent affordance and what the
   spec asked for as fallback.

5. **All cards are server-rendered.** The page has no client
   interaction beyond hovering for error tooltips. Keeping it all
   server components keeps the bundle minimal and avoids the
   client-component cascade. v2's time-window picker / chart toggle
   would introduce a client component for the toolbar; v1 doesn't
   need one.

**One thing that did NOT happen but might've been expected:**

6. **No Playwright verifier script.** Cost-hub has
   `scripts/verify-cost-hub-preview.ts` as a deploy-preview harness.
   I wrote a Python data-layer smoke instead — it gives more direct
   signal (validates the actual queries against cloud, surfaces real
   numbers per source) than a Playwright "page renders + has section
   headers" assertion would. A Playwright verifier could be added in a
   follow-up if Drake wants the visual smoke too.

## Out of scope / deferred

Per the spec:

- **Real graph rendering.** v1 ships placeholder graph frames only
  (one per column, "Trend chart — coming soon"). No chart library
  added to `package.json`. Acceptable per spec § What to build.
- **A time-window picker.** v1 is fixed at last 7 days rolling. The
  data layer's `getWindowStartIso()` / `getWindowStartDate()` are the
  single hook points if v2 wants Today / 7d / 30d / MTD toggles.
- **An aggregation layer.** v1 reads mirrors directly. Future spec
  spins up `aggregation/sales_dashboard/` with one function per Engine
  row.
- **PENDING → LIVE promotions** as the schema-doc ambiguities resolve
  (is_setter_led, cash field canon, objection categorization, Close
  Smartview reproduction). Each is a small follow-up: add a fetcher,
  flip the catalog entry's `status`.

**Not added to known-issues** because none of the above are bugs —
they're explicit v2 backlog. The runbook's "What's deferred to v2"
section enumerates them.

## Side effects

Real-world actions during this run, beyond the committed diff:

- **Cloud reads (read-only).** Multiple smoke-probe runs (~5) hit the
  production Supabase mirrors. Tables touched: `meta_ad_daily`,
  `clarity_metrics_daily`, `wistia_media_daily`, `typeform_responses`,
  `calendly_scheduled_events`, `calendly_invitees`,
  `airtable_setter_triage_calls`, `close_calls`,
  `airtable_full_closer_report`, `calls`. No writes; no row state
  changed.
- **No Slack posts, no emails, no webhook fires.** The page is
  read-only with no Server Actions in v1.
- **No new env vars.** Auth, Supabase, and access-tier infrastructure
  are reused verbatim.
- **No migrations.** Zero schema changes.
- **No third-party uploads.** No diagram renderers, gists, or
  pastebins involved.
