# Sales Dashboard

> **Architecture & code map:** see `docs/sales-dashboard-architecture.md` for the
> route topology, data-layer modules, mirror-table model, the Calendly↔lead /
> booking-funnel / closer-outcome logic, and the environment traps (local-vs-cloud
> creds, migration apply, Airtable schema API). Read that first for "how the code
> is structured"; this runbook is the metric catalog + per-feature wiring notes.

Admin-tier page at `/sales-dashboard`. Visualizes the Engine sheet
(`Data Sheet - Overall Engine.csv` at repo root) — 9 sections, ~117
metrics — against the seven ingested mirror tables. v1 reads
DIRECTLY from those mirrors (no aggregation layer, no views).

**v1 shipped 2026-05-24** as a flat 9-column kanban.
**v2 shipped 2026-05-24** retired the kanban in favour of a
hero-overview + sales-only sidebar + per-section detail pages. The
data layer is unchanged — catalog, fetchers, state contract are all v1.

- Code split: `lib/db/sales-dashboard-shared.ts` (pure: catalog,
  types, hero IDs, formatters — client-safe) +
  `lib/db/sales-dashboard.ts` (server-only: fetchers + orchestrator
  + admin client; re-exports everything from shared).
- Routes under `app/(authenticated)/sales-dashboard/`:
  - `layout.tsx` — admin-tier gate + two-column shell (240px sidebar + main).
  - `page.tsx` — Overview (hero + status strip).
  - `[section]/page.tsx` — Section detail (top-live + full catalog).
  - `states/page.tsx` — Three-states reference.
  - `sidebar.tsx` — sales-only client component (`usePathname()` for active).
  - `header-pills.tsx` — WindowPill + PersonPill + SectionStatusPill.
- Primitive: `components/sales/metric-card.tsx` — single chrome reused
  across hero-lede / hero-support / top-live / grid sizes × live /
  pending / not_connected / live_error states.
- Auth: admin tier or higher. Reuses the existing
  `getCurrentUserAccessTier()` + `tierAtLeast(..., 'admin')` gate that
  guards `/cost-hub`. Non-admin tiers redirect to
  `/clients?error=insufficient_access`.
- Nav: a "Sales" item in `components/top-nav.tsx`, visible only to
  admin+ (Nabeel, Drake). The TopNav stays as the cross-page surface;
  the sales sidebar only renders under `/sales-dashboard/*`.
- Specs: `docs/specs/sales-dashboard-v1.md`, `docs/specs/sales-dashboard-v2.md`
  + design mock `docs/specs/sales-dashboard-v2.html`.

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

## v2 — hero + sidebar restructure (2026-05-24)

v2 retired the flat 9-column kanban in favour of three new surfaces.
The catalog, fetchers, and state semantics in v1 are unchanged.

### Three pages

- **Overview** (`/sales-dashboard`) — hero with 3 lede + 4 support
  cards over the 7 catalog-locked hero IDs, then a derived status
  strip (LIVE / PENDING / NOT CONNECTED counts + sections-with-live +
  coverage %). Hero IDs are the single source of truth in
  `lib/db/sales-dashboard-shared.ts` `HERO_LEDE_IDS` + `HERO_SUPPORT_IDS`
  — reach `getHeroMetrics()` to resolve them. Throws on catalog drift
  (a hero ID that no longer exists in METRICS).
- **Section detail** (`/sales-dashboard/[section]`) — slug from
  `SECTION_SLUGS`; resolves to a `SectionId` or 404s via `notFound()`.
  Two slots: a Top-Live row showing the first 3 LIVE metrics in
  catalog order (3-up grid; replaced by an empty-section-stub
  message when the section has zero live), and a Full Catalog grid
  (4-up) showing every metric in catalog order through the same
  `<MetricCard>` primitive.
- **Three-states reference** (`/sales-dashboard/states`) — static
  page; explains the LIVE / PENDING / NOT CONNECTED contract with
  example cards + mapping-rules block. Linked from the sidebar's
  Reference group; toggled via `INCLUDE_STATES_LINK` in the segment
  layout.

### Sidebar contract

- Lives in `app/(authenticated)/sales-dashboard/sidebar.tsx`. Client
  Component (`'use client'`) because of `usePathname()`. The rest of
  the v2 page tree stays server-rendered.
- Renders ONLY under `/sales-dashboard/*` — the global TopNav in
  `app/(authenticated)/layout.tsx` is untouched, and other pages
  (/clients, /calls, /cost-hub, etc.) see no sidebar.
- 240px wide, sticky at `top: 64px` (the parent TopNav's height) with
  `height: calc(100vh - 64px)` so it doesn't overlap the nav.
- Per-section counts derive from `METRICS.filter(...).length` — never
  hardcoded. The mock's 7/16/21/47/30/8/9/6/4 was illustrative; the
  actual numbers track catalog changes automatically.
- Active state: the link whose href matches `usePathname()` gets the
  gold border-left + accent-fill background per the mock. Verifier
  asserts via `data-active="true"` attribute.

### `<MetricCard>` primitive

`components/sales/metric-card.tsx`. Single chrome reused across four
size variants × four state variants. Driven directly from
`{ metric: MetricEntry, result: FetchResult, size: MetricCardSize }` —
the state derives from the result (live/pending/not_connected/live_error)
without per-component prop noise.

| Size | Min height | Value font | Used by |
|------|------------|-----------|---------|
| `hero-lede` | 200px | 72px serif | Overview top row (3-up) |
| `hero-support` | 168px | 56px serif | Overview second row (4-up) |
| `top-live` | 160px | 44px serif | Section page Top-Live row (3-up) |
| `grid` | 124px | 28px serif | Full Catalog grid (4-up) |

State chrome reproduces the mock at `docs/specs/sales-dashboard-v2.html`
`.metric-card.live/pending/not-connected`. Notable details:

- **Live**: solid `--color-geg-bg-elev` background, full serif numeric.
- **Pending**: `--color-geg-warn-fill` tinted background + warn-bordered
  PENDING pill. No number — the slot is reserved.
- **Not connected**: transparent background, dashed border, NOT CONNECTED
  pill. Muted/faint chrome so the eye glides past.
- **Live_error**: same elev background as live, but `border-left: 3px
  solid var(--color-geg-neg)`, ERROR badge with the underlying message
  in `title` for hover-tooltip.

Hero variants suppress the per-card state-glyph dot (the chrome alone
encodes state) and add a `--color-geg-accent`-colored section-tag in the
top-left ("CLOSING", "FUNNELS", etc.). Grid variants render the dot.

### Hero `cls_total_cash` decision (Decision 1)

Spec allowed a v2.0 promotion of `cls_total_cash` to LIVE via either
the sum of the three cash-collected cells OR a single-table sum over
`airtable_full_closer_report.cash_collected`. **Shipped as PENDING.**
Reason: the three cash-collected cells (`cls_cash_deposits` /
`cls_cash_new` / `cls_cash_followup`) are all themselves PENDING
because of the schema's flagged Airtable ambiguity (two competing
currency fields — `amount_paid_today_currency` vs
`amount_paid_today_number`). Summing them today would put an invented
number on the hero. Promoting requires Drake/Aman to first resolve the
cash-field canon — at which point the three component cells and
`cls_total_cash` all promote together. The mock anticipates this
exception via the warn-tinted hero treatment.

To promote later: pick the canonical cash field (`fields_raw` JSON
key or one of the two currency columns), wire each cash fetcher in
`lib/db/sales-dashboard.ts` (mirror the `airtableCancelled` pattern),
flip the four catalog entries to `status: 'live'`. Hero
auto-promotes on the next request.

### Deferred from v2.0 to v2.1

- **Deltas + sparklines** on hero/grid cards. The mock fakes them; we
  shipped values-only because there's no prior-window data layer. v2.1
  extends each fetcher to return `{ value, priorValue }`.
- **Section pulse rail** + **Engine coverage stacked-bar block** on
  Overview — both depend on deltas (pulse) or are duplicative of the
  status strip (coverage block). The status strip carries the LIVE /
  PENDING / NC counts + sections-with-live + coverage % already.
- **Window switcher**. The window pill is decorative chrome today —
  no click handler.

### Lead list + per-lead page (2026-05-30)

The per-lead surfaces all sit on the SAME cohort (`getSpeedToLeadCohort`
in `lib/db/funnel-appointment-setting.ts`) so the appointment-setting
"Speed-to-Lead" lead list and the `/sales-dashboard/leads` roster can't
drift.

**Lead-list columns added (both surfaces):**

- **Connected total talk time + ×N tag.** The cohort row now carries
  `totalConnectedDurationSec` (sum of the lead's ≥90s outbound calls) and
  `connectedCallCount` (how many connected). The Connected cell renders
  `Yes (12m 30s) ×2` — the bracket is combined talk time, the `×N` pill
  (shown at ≥2) is how many calls connected. Both derive from the exact
  same call set as `anyCallConnected`, so the numbers reconcile.
- **Re-opt-in date in "Created".** On the appointment-setting list only,
  the Created column shows `optInAt` (the re-opt-in moment =
  `latest_opt_in_date`) for `optInType === 'reoptin'`, else
  `leadCreatedAt`. The `/leads` roster already showed opt-in date.

**Per-lead page — `/sales-dashboard/leads/[close_id]`.** New route backed
by `getLeadDetail(closeId)` in `lib/db/lead-detail.ts`. Reached by
clicking any row on the appointment-setting lead list, the per-rep call
drill, or the `/leads` roster (the per-rep drill rows were repointed from
`/calls/[id]` to here, keyed by `lead_id`). Shows:

- A facts strip (qualified, first/latest opt-in, opt-in count, total
  calls, connected count + talk time, primary caller).
- The lead's full call history, newest-first, each **collapsed by
  default** and expanding to its setter-call review (sentiment, score +
  reason, strengths/weaknesses, lead attributes, no-book reason). Reviews
  + transcripts only exist for transcribed setter calls (≥90s, since the
  2026-05-24 horizon) — older / sub-90s / closer calls render as a
  non-expandable row with no review. A call with a transcript links out
  to the per-call detail page (`/calls/[id]`).
- A stubbed **Closing call** section (placeholder) — closing-call detail
  is a later build-out.

The standalone `/sales-dashboard/calls` feed + its `/calls/[id]` detail
page are intentionally left untouched (eventual retirement, not now).

## Leads page booking funnels (2026-05-30)

Under the Leads / Qualified header, two funnel boxes — **Direct bookings** and
**Setter-led bookings** — each a 4-stage funnel: Booked → Confirmed → Showed →
Closed. Built incrementally:

- **Direct · Booked** = `directBooked` (the utm_term/email/name Calendly match).
- **Direct · Confirmed** = a direct booking whose **confirmation call form** says
  confirmed. The confirmation form is the `airtable_setter_triage_calls` row with
  `form_type = 'Closer Triage Form'` (a confirmation call, almost always Aman),
  matched to the lead by `lead_id`. "Confirmed" = `call_status` starting with
  `"Confirmed"` (covers `Confirmed Booking` + the confirmed-different-time
  option; excludes DQ / Setter pipeline, and the stray `High Ticket booking`
  values left on a few rows by a `form_type` backfill). The form is the sole
  decider — no ≥90s call gate (a sub-90s confirmation call still files a form).
  Computed in `lib/db/leads.ts` as `directConfirmed = directBooked && <confirmed
  form>`, so Confirmed ≤ Booked (monotonic funnel).
- **Direct · Showed** = a direct booking with a closer EOC form (`form_type=New`)
  whose `call_outcome` shows attendance (anything except no-show / reschedule /
  cancel). **Direct · Closed** = `call_outcome` is High Ticket / Digital College
  Closed (Deposit does NOT count as a close). Matched by `lead_id`, sole decider,
  subsets of directBooked → monotonic Booked ≥ Showed ≥ Closed. Helpers
  `outcomeShowed` / `outcomeClosed` in `lib/db/leads.ts` mirror the closer drill's
  `deriveNewOutcome`.
- **The whole Setter-led box** is still pending placeholders (`—`).

Cross-form caveat: Confirmed comes from the confirmation form, Showed/Closed from
the closer form — so Confirmed is not guaranteed ≥ Showed (a lead can have a closer
form without a confirmation form). Each stage is independently a subset of Booked.

`call_status` is already a typed column on `airtable_setter_triage_calls` (the
parser maps it since the 2026-05-26 form redesign) — no migration needed.

## Closer drill — new-form outcome wiring (2026-05-30)

The Closing per-closer drill (`getClosingScheduledList` in `lib/db/funnel-closing.ts`,
rendered by `closer-tables.tsx`) derives Showed / Closed / Upfront / Booked-by from
the matched closer form. For `form_type = 'New'` rows it reads `call_outcome`
(`deriveNewOutcome`); old rows keep the legacy `showed`/`closed`/`payment_plan_type`.
Scheduled time, Call type (direct/setter), and the per-closer grouping stay
Calendly-sourced — never from the form.

- **Showed** states: `yes` (any close / Deposit / DQ-Bad-Fit), `reschedule`,
  `short_follow`, `long_follow`, `no` (Ghosted / Cancelled). Aggregate "showed"
  counts `yes` + the two follow-ups; `no` counts no-shows.
- **Closed** states: `yes` (High Ticket / Digital College Closed), `deposit`
  (its own state — NOT counted as a close), `no`. `closeType` ht/dc from the
  closed outcome.
- **Upfront** = cash collected (`amount_paid_today_number` ?? `_currency`); for a
  Deposit outcome, the `deposit_amount`.
- **Booked-by (setter)** = the matched form's own `setter_record_ids` resolved
  id→name (`buildSetterNameResolver`, learned from closer/triage name pairs since
  the new form dropped the Setter Name lookup), falling back to the triage
  resolver. Setter-led calls only; direct → "—".
- **Form selection** (`pickForm`): when a lead has multiple closer forms in the
  ±48h match window (old + new, or duplicate new), the winner is **New over Old,
  then the most recently submitted** (`airtable_created_at`). Previously it was raw
  time-proximity, which let a stale/old form beat the new disposition (the Walters
  old-form-wins / Colton duplicate-form cases, 2026-05-30).

## Calendly → Close lead matching via utm_term (2026-05-30)

Calendly bookings now carry a per-lead token in `raw_payload.tracking.utm_term`
(format `aaid_<uuid>`), the same value mirrored onto `close_leads.utm_term`.
`lib/db/calendly-lead-match.ts` (`buildCalendlyLeadResolver`) builds a
`utm_term → close_id` map and is used as the **primary** match key ahead of
email/phone/name in the direct-booking + closer-drill matchers.

**Critical safety rule — unique mapping only.** `utm_term` is overloaded:
most leads carry a generic ad-targeting term (`Broad` = 2,591 leads, dated
campaign labels, …) shared across thousands of leads. The resolver keeps
ONLY terms that map to exactly one Close lead; shared terms resolve to
`null` and the matcher falls back to email/phone/name. This is why the
guard is non-negotiable — matching on a shared term would mis-attribute a
booking to a random one of thousands of leads.

- **Coverage:** ~20% of mirrored bookings resolve via the token today
  (299/1458 carry a `utm_term`; 276 resolve uniquely). Grows as new
  bookings carry it. Older / direct self-books with no token fall back to
  identity matching exactly as before — the change is purely additive.
- **Correctness:** spot-checked 276 resolved bookings — 99% share a name
  token with the resolved lead (the rest are junk/test bookings).
- **Wired into** (`lead_id` first, then email/phone/name):
  - `lib/db/leads.ts` — `directBooked` (the `/leads` "Direct bookings" count).
  - `lib/db/funnel-closing.ts` — `leadKeyOf` (event→lead collapse),
    `buildBookedByResolver` (setter attribution via triage `lead_id`), and
    `matchForm` (event→closer-form via the form's `lead_id`).
- **Not yet wired:** the Python scripts (`match_closer_funnel_bookings.py`,
  `build_fresh_bookings_tabs.py`) still use identity-only matching.

**To get full coverage** (every lead with a unique token): the booking-link /
funnel setup must inject a per-lead value on every link — ideally the Close
`lead_id` (`lead_xxx`, guaranteed unique) in a dedicated param rather than
overloading `utm_term`. That's a Close/Calendly config change (Zain), not a
code change. The `aaid_` tokens are already unique per lead (1,056/1,058);
the 2 collisions are same-day duplicate leads.

## Playwright verifier — sales v2

`scripts/verify-sales-dashboard-v2-preview.ts`. Hits 6 routes
(overview, advertising, content/all-NC, funnels, closing, states),
full-page-screenshots each into `scripts/.preview/sales-v2/`, and
runs structural assertions: sidebar contents + width, hero card
titles by catalog ID, status-strip tokens, section page top-live
suppression when 0 live, empty-section-stub when 0 live, ≥10 NOT
CONNECTED tokens in the all-NC Content section.

```bash
# Local dev
NEXT_PUBLIC_DISABLE_AUTH=true npx next dev -p 3033
PREVIEW_URL=http://localhost:3033 npx --yes tsx scripts/verify-sales-dashboard-v2-preview.ts

# Vercel preview deploy (set NEXT_PUBLIC_DISABLE_AUTH=true on the
# Preview env only, never Production)
PREVIEW_URL=https://ai-enablement-xxxx-drakeynes-projects.vercel.app \
  npx --yes tsx scripts/verify-sales-dashboard-v2-preview.ts
```

Run after any visual change to the dashboard, after any v1 catalog
edit (the assertions exercise catalog-derived state), or as part of
post-deploy Drake-gate (c) verification.

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
