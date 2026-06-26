# Sales — Surfaces (page map)

Every sales page, what it shows, and what was removed. All routes currently live under
`app/(authenticated)/sales-dashboard/` (server components, `force-dynamic`) — they move
under a dedicated `(sales)` route group + subdomain as part of the fulfillment/sales
split. Nav is **flat: Advertising Hub · Outbound · Leads · Talent**, with Roster nested under Talent.
Outbound is its own top-level page (no longer nested under the Advertising Hub).

---

## Advertising Hub — `/funnel` (was "Marketing" / "Funnel" / "Pulse")

> Renamed to **Advertising Hub** 2026-06-24 (sidebar label + page header `SALES · ADVERTISING HUB` /
> "Advertising Hub."). The route stays `/sales-dashboard/funnel`. (Was "Marketing" 2026-06-18.)

The stacked cohort funnel: **Total / Direct / Setter / Reactivation** boxes (opt-ins →
connected → booked → confirmed → showed → closed; `confirmed` only on Direct/Total;
the **Total box hides the Books node** — Confirms is the meaningful one there;
`closed` split HT/DC). Stage nodes are `<Link>`s into the filtered **Leads** roster
(type + stage), so a box's number equals the roster it opens. The page also hosts:

- the **Digital College funnel** block — modeled **Connects → Closed** (connects =
  `lead_cycles.digital_college_at`; closed = `dc_closed_at`, downsells merged; see `data-model.md`),
- the **Cash Collected / ROAS** block,
- the **integrity-guard banner** (flags `books ≥ connected ≥ confirms ≥ shows ≥ closes`
  violations),
- the **Campaign → Ad Set → Ad cascade filter** (three dependent dropdowns; the deepest
  selection scopes the whole funnel — see `data-model.md` § cascade. All three
  levels are named with spend/ROAS, including Ad Set since migration 0089),
- the **last-5-days daily table** at the bottom — a cohort-by-opt-in-day strip
  (`Day · Spend · Leads · Connects · Booked · Showed · Closed · Cash · Sp2L · Dials`),
  a rolling 5 ET calendar days **independent of the date picker** but **scoped to the ad
  cascade**. Each day reuses the funnel's own `getLeadsFunnel` / `getFunnelCash` over a
  single-day window, so the rows can't drift from the boxes above
  (`lib/db/funnel-daily.ts`, `components/sales/daily-funnel-table.tsx`),
- the **inline Ads + Landing-Page summary** under that table — the numbers that used to
  live on the click-through Ads and Landing-Pages pages, now plain labelled lists (no
  sparklines): Meta ad delivery (spend / impressions / unique clicks / CTR / CPM /
  cost-per-click / frequency), LP visits + conversion, Typeform starts / completions /
  qualified, and the VSL + confirmation-video metrics (each divider labelled with the video's
  Wistia name beside it). LP visits + the Typeform counts
  (starts / completions / qualified / non-qualified) each carry a **cost-per bracket**
  (adspend ÷ count). The **ads block scopes to the ad cascade**; the **landing-page block
  scopes to the LP selector + window** (separate
  dimensions) — `lib/db/funnel-summary.ts`, `components/sales/ads-lp-summary.tsx`.
- the **inline leads roster** at the very bottom — the same list + columns (Prospect /
  Opted in / Disposition / Time to call / Connected / Intensity) you'd reach by clicking
  the Total funnel's opt-ins stage, surfaced in-page so there's no click-through. Reuses
  the Leads page's `LeadRoster` over the page's already-loaded cohort `rows`, so it
  **re-scopes with the ad cascade for free** (no extra query — the roster fetch is already
  paid). Rows still link to the per-lead page. LP scoping is pending per-lead LP attribution.

The old in-page **navigation links were removed** (2026-06-18): the adspend node no longer
links to the Ads page and the "Landing pages →" header link is gone, now that the data is
inline. The `/funnel/ads` and `/funnel/landing-pages` routes still exist (reachable by URL).

### `/funnel/ads`
Meta / Cortana ad metrics. **No longer linked** from the funnel (the adspend node's link
was removed); the same window-scoped numbers now render inline on the Advertising Hub page.
Still reachable by URL.

### `/funnel/landing-pages`
Landing-page + Wistia video + Typeform metrics. **No longer linked** (the "Landing pages →"
header link was removed); those numbers now render inline on the Advertising Hub page. Still
reachable by URL.

---

## Outbound — `/outbound` (was `/funnel/revival`, "Revival")

The DC Revival re-engagement (outbound SMS) funnel — its **own** funnel, reading raw signals with **no
tagger**. The only surface that counts revival leads. Moved out from under the Advertising Hub to its
own top-level page + renamed **Outbound** 2026-06-24 (route `/sales-dashboard/outbound`; internally
still "revival" — components/data keep the `revival` name). See `data-model.md` § Revival.

**Materialized** (2026-06-24, migrations 0093/0094/0095). The page reads one `outbound_funnel(p_campaign_key)`
RPC (funnel + called + timeOfDay) **over the precomputed `outbound_lead_facts` table** — sub-second, no
matter how big the campaign gets. The heavy per-lead aggregation runs OFF the page load:
`refresh_outbound_facts()` (≈15s) is called by the **`outbound_facts_refresh_cron`** every 15 min, and
`outbound_funnel()` just reads the facts. (The original live-aggregation function scanned 66k SMS + 20k
calls every load → 23s → past the 8s API timeout → the page crashed; this is the fix, mirroring
`lead_cycles`.) **Connected = a ≥90s call only.** Parameterized by the **`outbound_campaigns`** registry,
now surfaced as a **campaign switcher** (`?campaign=` — Revival | Jacob); each pool is a registry row, so
adding a campaign is a row + tagging its leads. `refresh_outbound_facts` runs for **every active campaign**.
A **date range** (calendar, `?start=&end=`, migration 0102) scopes the funnel by each lead's
**anchor** (campaign entry = `greatest(date_created, floor)`) — a fast filter over the materialized facts,
no re-aggregation. There is **no all-time mode**: when the calendar is untouched the page defaults the
range to **[campaign start → today]** (start dates are hard-quoted per campaign in the page — Revival
Jun 3, Jacob Jun 20), so the funnel and the calendar always agree. A **"Started …"** label shows the
campaign's launch date.

**Pools are mutually exclusive** (migration 0103). The ECJ "Jacob" batch runs through the same Close SMS
reactivation workflow that stamps every lead with the **"DC Revival Lead"** CF, so all Jacob leads also
carry the Revival tag. To honor "counted in exactly one place," `refresh_outbound_facts` assigns each lead
to the **most specific** campaign it carries (highest `outbound_campaigns.sort_order`) and excludes it from
the rest — so Jacob leads/closes are dropped from Revival, never double-counted.

> **2026-06-26 incident:** `refresh_outbound_facts` ran ~3s/campaign on micro but minutes on nano under
> load, and the `*/15` cron **stacked** overlapping runs → DB saturation. Fixed: nano→micro **and** the
> cron is guarded — per-refresh `statement_timeout` (kills runaways) + `pg_try_advisory_lock` (a tick
> skips if one's still running, never stacks) + per-campaign isolation.

**Jacob (ECJ Reactivation)** — the 2nd pool (migration 0099). Membership = the **"Jacob Lead"** Close
custom field (`cf_m0ooi…`), set on `close_leads` matching the ECJ CSV roster (`outbound_campaign_roster`,
by email **or** phone). Future leads auto-tag via the close webhook (`shared/outbound_campaign_tag.py`,
hooked in `api/close_events.py`): any new lead matching the roster gets the field set in Close. Floor =
2026-06-20 (the batch load start).

The funnel displays **leads → responded → called → connected → closed** — the **Booked and Showed
stages are hidden** (Drake 2026-06-24; the SQL still computes them, so un-hiding is a display-only change).
The Called (speed-to-dial) + time-of-day sections are unchanged.

**By-rep block** (migrations 0104 + 0105, `outbound_funnel_by_rep` RPC → `OutboundByRepSection`). Under the
funnel, a per-rep table: **Dials · Connections · Closes · Cash**. Its header summarizes the window's
**total closes + unit mix sold** (Base/Wix × Monthly/Yearly chips, same classification as the funnel's
`closedPlans`) — the daily-activity counterpart to the cohort funnel's plan chips. The RPC returns
`{ reps, totals }`. Unlike the funnel it is **activity-scoped** — it
counts what each rep *did* in the calendar window (calls by `activity_at`, closes by form date), not the
entry cohort. One combined row per rep bridges Close calls (`close_calls.user_id` → `team_members.close_user_id`)
and Airtable closer reports (`closer_record_ids` → `team_members.airtable_user_id`); reps absent from
`team_members` fall back to their raw name. **Only reps who actually closed are shown.** Dials = outbound
calls; Connections = ≥90s calls; Closes = DC-closed-with-plan distinct deals; Cash = $300/plan unit.
Caveat: `airtable_user_id` has no auto-sync yet (Sierra Anderson's was backfilled in 0104) — new closers
need their `airtable_user_id` set to merge their closes with their dials.

---

## Leads — `/leads`

The lead **roster** + filter bar (type/stage) + speed-to-lead boxes + the
first-meaningful-response (FMR) chart — all window- and filter-scoped to the same cohort.
The roster shows a per-lead booking tag. (The stacked funnel **no longer lives here** — it
moved to `/funnel`.)

The **Connected rate** box is `connected ÷ leads worked`, where *worked* = leads
**dialed OR connected** (not the whole cohort) — a true connection rate that
never-touched leads don't dilute (Drake 2026-06-18). "Connected" is a **≥90s call
only** (`reachedStage`, back-filled from confirmed/showed/closed) — a triage/confirmation
form no longer counts (Drake 2026-06-24). A form/text reach with no qualifying call is
**not** connected.

### `/leads/[close_id]` — per-lead page
A facts strip (qualified, opt-in dates, **Stage** chip-funnel, dials, connected
count+duration, reschedules, follow-ups) + a **Notes** section (one free-text
scratchpad per lead — type + save, overwrites; `lead_notes`, migration 0090;
any team member can edit) + a **two-phase Journey** (Direct → Reactivation)
+ a **day-grouped Lifecycle** (full history, newest-first, opt-in dividers) + a Close-
details section. Each Lifecycle **form row carries the rep's free-text notes off that
form** (triage `notes`, closer `call_notes` + `call_notes_lost` merged, DC `call_notes`),
rendered under the disposition — distinct from the per-lead `lead_notes` scratchpad above. Bookings are matched to the lead by email + name + unique utm_term token.
The journey **resets on re-opt-in**. There is a lead search bar (`?q=`) that resolves a
name → this page.

---

## Talent — `/people` (display name "Talent")

Per-rep **Call Activity** (setters and closers), per-closer scheduled tables, the
**BOOKINGS** boxes (Calendly),
**Cash**, and the **Digital College** drilldown (Robby). This is the
rep-performance surface, organized **by call type** (a Triage table + a Confirmation
table, etc.). Being superseded by Roster (below) — kept as the comparison baseline until
Roster is trusted.

### Talent · Roster — `/people/by-rep` (sidebar label "Roster")

The **by-person** re-presentation of Talent — one block per rep instead of stacked
by-call-type tables. A candidate replacement for `/people`. The **click-through detail**
reuses the existing loaders (`getCallActivityMetrics`, `getClosingScheduledList`,
`getDigitalCollegeActivity`) unchanged; the **card's crucial metrics** are computed
**forms-only** (below) via `getCloserFormMetricsByRep` — the one piece of Roster-specific
logic.

- **One card per rep**, keyed by Close `user_id`, merging that person's setter + closer
  rows from Call Activity (dials / connections / bookings) with their **forms-only closer
  metrics** (meetings / closes / cash). A rep who both sets and closes (e.g. Aman)
  collapses into a single block instead of two scattered rows.
- **One canonical role chip** from `team_members.sales_role` (Setter / Closer / DC
  Closer) — the role the rep *is*, not a chip per call-family they happen to have
  activity in. Cross-family activity (a closer's stray triage calls) still surfaces on
  the detail view.
- **Crucial metrics — the SAME eight on every card** (Drake 2026-06-20; every rep both sets
  and closes a little, so the old role-keyed sets were merged — the role chip still shows the
  dedicated role, only the metric set is unified). Setter-side → closer-side, **strictly from
  the forms** (no booking-platform data), in a 4×2 grid:
  - **Dials · Connections** — the rep's calls (`close_calls`; ≥90s = connected).
  - **Bookings** — the rep's setter "Booked" (HT + DC from the triage table). **Book rate**
    = Bookings ÷ Connections.
  - **Meetings · Closes · Cash · Cash/mtg** — from the rep's closer EOC forms
    (`airtable_full_closer_report`), attributed by `closer_record_ids` → `user_id` across
    **ALL** reps, not just `sales_role='closer'` (`getCloserFormMetricsByRep`; a closer-only
    resolver previously zeroed DC closers + setters who file EOC forms — Drake 2026-06-20).
    - **Meetings** = forms with a *showed* outcome, **incl. any Digital College disposition**
      (a DC form means a DC meeting was held).
    - **Closes** = a High-Ticket close (`call_outcome = 'High Ticket Closed'`) **OR** a DC
      close = **`dc_plans` filled** (the canonical signal — *not* the `'Digital College
      Closed'` text, which appears with no plan = a fake close, and misses bare `'Digital
      College'` + plan = a real one).
    - **Cash** = `amount_paid` (HT + deposits) **+ $300 per DC plan unit** (`DC_PLAN_PRICE_USD`,
      the same flat-rate logic as `funnel-cash`/`funnel-dc`). **Cash/mtg** = Cash ÷ Meetings.

  Everything else lives on the click-through. (The per-closer scheduled tables on the
  detail also fold DC `$300`/plan into their **Cash** column — Drake 2026-06-20 — though
  their `closedDc` *count* still keys on the outcome text; only the card is fully
  `dc_plans`-consistent on both closes and cash.)
- **Click a card → per-person detail** (`?rep=`): the full existing drilldown tables
  (call activity + per-call drill, scheduled calls, DC) scoped to that one rep, with a
  "← All reps" back link. Collapsing the drill returns to the grid (`?rep` is the page's
  single person selector). Plus a **"Closer forms" table** (`getCloserFormsForRep`) listing
  **every** closer EOC form the rep filed in range — date / prospect / outcome / plan /
  cash / close-badge — attributed across **all** roles, so DC closers + setters who file
  forms (Connor, Bradley, Joshua) finally see their forms here (the scheduled tables only
  show `sales_role='closer'`, so they were invisible before — Drake 2026-06-20).
- **Active/inactive.** Inactive reps are **hidden by default**; a "Show inactive" toggle
  reveals them (dimmed, with an "Inactive" chip). Active = `team_members.is_active` among
  non-archived sales rows (`is_csm=false`, so it's independent of the CSM surfaces;
  flip one boolean to change the roster — no deploy). Today's active set: Aman, Cobe
  Heydinger, Connor Malewicz, Yasmine Manno, Bradley, Joshua.
- **Cards are equal-height** (grid-auto-rows), active reps sorted first.
- **Click feedback.** Opening a rep is a `?rep=` searchParam nav (same route → no
  `loading.tsx`), so the card navigates through a `useTransition` and the grid swaps for a
  shimmer skeleton ("Loading <name>…") until the detail renders (`roster-grid.tsx`).

The closer card's funnel reads the read-time loaders (`getClosingScheduledList` etc.),
which reconstruct booking→closer-form from **Calendly** at read time (the per-closer
attribution that once motivated the `booking_cycles` spine, now **shelved** — see
[`booking-to-close.md`](./booking-to-close.md)). Books/Shows/Closes stay
read-time-reconstructed (no persisted spine); Roster can replace `/people` once it's
trusted on the real numbers.

---

## Per-call review — `/calls/[close_id]`

The per-call transcript / review page. Reached **only** from a per-lead Lifecycle row
(back link carries `?lead=`). There is **no Calls list page** — it was removed.

---

## Legacy surfaces (not the current product)

- `/[section]`, `/states`, `/trajectory` — the older v1/v2 **metric-catalog** layer
  (the 9-section / hero+sidebar kanban described in `docs/runbooks/sales_dashboard.md`,
  "~30 of ~140 LIVE"). Not in nav, not part of the funnel/leads/talent product. Treat as
  legacy until explicitly revived or removed.

## Removed — do not reference as live

- The **Calls list** page + its nav tab.
- `funnel/appointment-setting`, `funnel/closed`, `revenue/*` routes.
- The three side-by-side `bookingType` booking boxes (replaced by the stacked
  Total/Direct/Setter/Reactivation model).
- The all/unique view toggle and the Opt-in badge column on Leads.
- The **Status column** on the Leads roster (removed 2026-06-16; the lead-type
  status is still shown on the per-lead page, just not in the list).
</content>
