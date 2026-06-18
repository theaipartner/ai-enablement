# Sales — Surfaces (page map)

Every sales page, what it shows, and what was removed. All routes currently live under
`app/(authenticated)/sales-dashboard/` (server components, `force-dynamic`) — they move
under a dedicated `(sales)` route group + subdomain as part of the fulfillment/sales
split. Nav is **flat: Marketing · Leads · Talent**, with Revival nested under Marketing.

---

## Marketing — `/funnel` (was "Funnel" / "Pulse")

> Renamed to **Marketing** 2026-06-18 (sidebar label + page header `SALES · MARKETING` /
> "Marketing."). The route stays `/sales-dashboard/funnel`.

The stacked cohort funnel: **Total / Direct / Setter / Reactivation** boxes (opt-ins →
connected → booked → confirmed → showed → closed; `confirmed` only on Direct/Total;
the **Total box hides the Books node** — Confirms is the meaningful one there;
`closed` split HT/DC). Stage nodes are `<Link>`s into the filtered **Leads** roster
(type + stage), so a box's number equals the roster it opens. The page also hosts:

- the **Digital College funnel** block (closer-identity-routed — see `data-model.md`),
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

### `/funnel/revival`
The DC Revival re-engagement funnel — its **own** funnel, reading raw signals with **no
tagger**. The only surface that counts revival leads. See `data-model.md` § Revival.

### `/funnel/ads`
Meta / Cortana ad metrics. **No longer linked** from the funnel (the adspend node's link
was removed); the same window-scoped numbers now render inline on the Marketing page.
Still reachable by URL.

### `/funnel/landing-pages`
Landing-page + Wistia video + Typeform metrics. **No longer linked** (the "Landing pages →"
header link was removed); those numbers now render inline on the Marketing page. Still
reachable by URL.

---

## Leads — `/leads`

The lead **roster** + filter bar (type/stage) + speed-to-lead boxes + the
first-meaningful-response (FMR) chart — all window- and filter-scoped to the same cohort.
The roster shows a per-lead booking tag. (The stacked funnel **no longer lives here** — it
moved to `/funnel`.)

The **Connected rate** box is `connected ÷ leads worked`, where *worked* = leads
**dialed OR connected** (not the whole cohort) — a true connection rate that
never-touched leads don't dilute (Drake 2026-06-18). "Connected" is the broad
form-OR-≥90s-call signal (`reachedStage`), so a form/text reach counts even with no
dial; those form-no-dial leads sit in both the numerator and the denominator (so the
rate can't exceed 100%). A bare SMS reply with **no form** is *not* connected.

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

Per-rep **Call Activity** (setters and closers), per-closer scheduled tables, Calendly-
bookings boxes, **Cash**, and the **Digital College** drilldown (Robby). This is the
rep-performance surface.

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
