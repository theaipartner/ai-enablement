# Sales — Documentation

This folder is the **single home for everything sales**. If it isn't in here (or in
`docs/schema/` for per-table column detail), it isn't current sales documentation.

Edit these docs in place: when something changes, change the sentence that is now wrong;
if a whole concept is retired, delete its paragraph. The current text of these files is
the one "what's true right now."

## What the product is

An internal **sales analytics** dashboard. Five surfaces, flat nav:

- **Advertising Hub** (route `/funnel`, was "Marketing" / "Funnel") — the cohort funnel (opt-ins →
  connected → booked → confirmed → showed → closed), split Total / Direct / Setter / Reactivation, plus
  the Digital College funnel, a Cash Collected / ROAS block, a **last-5-days daily table**,
  and an **inline Ads + Landing-Page summary** (the old Ads / Landing-Pages detail pages,
  now surfaced in-page).
- **Outbound** (route `/outbound`, was "Revival" nested under Marketing) — the outbound-SMS campaign
  funnels, one per pool via a **campaign switcher** (Revival, Jacob); each pool's leads are mutually
  exclusive and excluded from every other surface, so it's the only place they're counted. A calendar
  scopes the funnel by lead-entry cohort, plus an activity-scoped **By rep** table (dials / connections /
  closes / cash). Its own top-level page.
- **DC Ads** (route `/dc-ads`, added 2026-07-10) — the Digital College paid-ads funnel (since the
  full-program suspension, the only acquisition motion): Meta instant-form opt-ins with **ad spend
  leading the funnel** (adspend → opt-ins → called → connected → closed, + cash/ROAS), an
  Advertising-Hub-style **ad cascade chooser** + a **Forms dropdown** (per instant form),
  **last-5-days strip**, by-rep, **speed-to-lead boxes** (the Leads page's stats, DC-scoped),
  opt-in→dial speed, and time-of-day. Shows/closes come from the **DC sale form** ∪ closer report.
  Scoped strictly to lead-form campaigns — never outbound pools, and its leads never appear on
  Outbound.
- **Leads** — the lead roster + filters + speed-to-lead + first-meaningful-response
  chart, and the per-lead page (`/leads/[close_id]`) with the two-phase Journey and
  day-grouped Lifecycle.
- **Talent** (route `/people`) — per-rep setter/closer activity, scheduled tables,
  bookings (Calendly), Cash, and the Digital College drilldown. Its **Roster** sub-page
  (`/people/by-rep`) is the by-person re-presentation — one block per rep, hide-inactive
  by default.

The sales surfaces live under `app/(authenticated)/sales-dashboard/`. Nothing in here should
reference Ella, Clients, CSM, or Gregory.

## Doc map

| Doc | What's in it |
|-----|--------------|
| [`data-model.md`](./data-model.md) | The lead definition, the funnel stages, lead types, HT vs Digital College, Cash/ROAS, and the **sales table manifest** (which DB tables are ours). |
| [`logic.md`](./logic.md) | The load-bearing matching & business logic — the rules you must not break (utm_term guard, form selection, the connected signal, outcome derivation, the 1000-row cap, timezone). |
| [`ingestion.md`](./ingestion.md) | Every data source, its webhook/cron model, and the **ops traps** (the env gotcha, the migration apply path). |
| [`surfaces.md`](./surfaces.md) | The page-by-page UI map — routes, what each shows, what was removed. |
| [`landing-pages.md`](./landing-pages.md) | How landing pages work + **the checklist for adding a new one** (the 5 things to collect, what's deferred). |

The sales Slack bot (text-to-SQL, read-only) is documented in
[`docs/agents/sales_bot.md`](../agents/sales_bot.md) (agent) and
[`docs/runbooks/sales_bot.md`](../runbooks/sales_bot.md) (ops).

Per-table column detail stays in `docs/schema/<table>.md` (the manifest in `data-model.md`
says which of those are sales).

## Performance — SQL aggregation is the baseline

Dashboard aggregation runs in Postgres, not JavaScript. The pattern: the **tagger**
materializes per-lead/per-cycle facts into the tag tables (`lead_cycles` / `lead_cycle_stages`)
at write-time; the dashboard reads them via **SQL functions** (read-time) or direct column
reads — instead of pulling thousands of raw rows into the page and crunching them in JS.

The standing rule for new dashboard code: compute counts/sums/mins **in SQL** (GROUP BY + the
indexes on the hot columns — `close_calls(lead_id, date_created)`, `close_sms(lead_id, …)`,
`close_leads(date_created)`, etc.) and return small result sets. Never paginate a whole table
into Node to loop over it.

Funnel box counts (`sales_funnel_counts`), speed-to-lead, and FMR are materialized/aggregated
this way. A few reads are still JS — the roster (`getLeadsForRange`, called by both the funnel
and leads pages) and the Talent per-rep metrics. See [`logic.md`](./logic.md) § Perf for the
current state.
