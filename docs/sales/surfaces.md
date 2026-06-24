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
  qualified, and the VSL + confirmation-video metrics. The **ads block scopes to the ad
  cascade**; the **landing-page block scopes to the LP selector + window** (separate
  dimensions) — `lib/db/funnel-summary.ts`, `components/sales/ads-lp-summary.tsx`.

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

**SQL-aggregated** (2026-06-24, migrations 0093/0094): the page is one `outbound_funnel(p_campaign_key)`
RPC (funnel + called + timeOfDay), replacing the old ~600-round-trip JS. **Connected = a ≥90s call only.**
Parameterized by the **`outbound_campaigns`** registry — a future "tag type" dropdown (other outbound
campaigns / lead tags) is a registry row + a dropdown option, no function change.

The funnel displays **leads → responded → called → connected → closed** — the **Booked and Showed
stages are hidden** (Drake 2026-06-24; the SQL still computes them, so un-hiding is a display-only change).
The Called (speed-to-dial) + time-of-day sections are unchanged.

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
details section. Bookings are matched to the lead by email + name + unique utm_term token.
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
