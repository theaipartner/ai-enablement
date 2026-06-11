# Sales — Surfaces (page map)

Every sales page, what it shows, and what was removed. All routes currently live under
`app/(authenticated)/sales-dashboard/` (server components, `force-dynamic`) — they move
under a dedicated `(sales)` route group + subdomain as part of the fulfillment/sales
split. Nav is **flat: Funnel · Leads · Talent**, with Revival nested under Funnel.

---

## Funnel — `/funnel` (was "Pulse")

The stacked cohort funnel: **Total / Direct / Setter / Reactivation** boxes (opt-ins →
connected → booked → confirmed → showed → closed; `confirmed` only on Direct/Total;
`closed` split HT/DC). Stage nodes are `<Link>`s into the filtered **Leads** roster
(type + stage), so a box's number equals the roster it opens. The page also hosts:

- the **Digital College funnel** block (closer-identity-routed — see `data-model.md`),
- the **Cash Collected / ROAS** block,
- the **integrity-guard banner** (flags `books ≥ connected ≥ confirms ≥ shows ≥ closes`
  violations),
- the **adspend** node → Ads page, and a header link → Landing Pages.

### `/funnel/revival`
The DC Revival re-engagement funnel — its **own** funnel, reading raw signals with **no
tagger**. The only surface that counts revival leads. See `data-model.md` § Revival.

### `/funnel/ads`
Meta / Cortana ad metrics (reached from the adspend node, not the sidebar).

### `/funnel/landing-pages`
Clarity landing-page + Wistia video metrics (reached from a header link).

---

## Leads — `/leads`

The lead **roster** + filter bar (type/stage) + speed-to-lead boxes + the
first-meaningful-response (FMR) chart — all window- and filter-scoped to the same cohort.
The roster shows a per-lead booking tag. (The stacked funnel **no longer lives here** — it
moved to `/funnel`.)

### `/leads/[close_id]` — per-lead page
A facts strip (qualified, opt-in dates, **Stage** chip-funnel, dials, connected
count+duration, reschedules, follow-ups) + a **two-phase Journey** (Direct → Reactivation)
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
</content>
