# Sales — Documentation

This folder is the **single home for everything sales**. If it isn't in here (or in
`docs/schema/` for per-table column detail), it isn't current sales documentation.

> **Status:** v1, created 2026-06-11. Synthesized from the old
> `docs/sales-dashboard-architecture.md` palimpsest and its companions. The logic
> here is faithful to those docs but should be spot-checked against live behaviour
> as we go — flag anything that disagrees with the running app and fix it *in place*.

---

## The one rule that keeps this clean

**Edit in place. Never append a dated "MOST CURRENT — read this block first" section.**

The doc this replaced grew to 1,886 lines because every working session stapled a
new "read the LAST block first" update on top instead of changing the sentence that
was now wrong. Five of those stacked up and started contradicting each other. That
is the failure mode we are escaping. When something changes:

1. Open the relevant doc below.
2. Change the sentence that is now false.
3. If a whole concept is retired, delete its paragraph — don't strike it through.

There is exactly one "what's true right now": the current text of these files.

---

## What the product is

An internal **sales analytics** dashboard. Three surfaces, flat nav:

- **Marketing** (route `/funnel`, was "Funnel") — the cohort funnel (opt-ins → connected →
  booked → confirmed → showed → closed), split Total / Direct / Setter / Reactivation, plus
  the Digital College funnel, a Cash Collected / ROAS block, a **last-5-days daily table**,
  and an **inline Ads + Landing-Page summary** (the old Ads / Landing-Pages detail pages,
  now surfaced in-page). Revival is a nested child page.
- **Leads** — the lead roster + filters + speed-to-lead + first-meaningful-response
  chart, and the per-lead page (`/leads/[close_id]`) with the two-phase Journey and
  day-grouped Lifecycle.
- **Talent** (route `/people`) — per-rep setter/closer activity, scheduled tables,
  Calendly bookings, Cash, and the Digital College drilldown.

Sales is being walled off from fulfillment entirely (own subdomain — see the
subdomain plan). Nothing in here should reference Ella, Clients, CSM, or Gregory.

## Doc map

| Doc | What's in it |
|-----|--------------|
| [`data-model.md`](./data-model.md) | The lead definition, the funnel stages, lead types, HT vs Digital College, Cash/ROAS, and the **sales table manifest** (which DB tables are ours). |
| [`logic.md`](./logic.md) | The load-bearing matching & business logic — the rules you must not break (utm_term guard, form selection, the connected signal, outcome derivation, the 1000-row cap, timezone). |
| [`ingestion.md`](./ingestion.md) | Every data source, its webhook/cron model, and the **ops traps** (the env gotcha, the migration apply path). |
| [`surfaces.md`](./surfaces.md) | The page-by-page UI map — routes, what each shows, what was removed. |
| [`landing-pages.md`](./landing-pages.md) | How landing pages work + **the checklist for adding a new one** (the 5 things to collect, what's deferred). |

Per-table column detail stays in `docs/schema/<table>.md` (kept as-is; the manifest
in `data-model.md` says which of those are sales).

## How we work on sales

We **disregard the CLAUDE.md Director/Builder machinery** for this work (specs,
reports, ADRs, the four-gate ceremony, EOD cleanup). Drake describes what he wants —
often refining mid-stream — and we work directly and iteratively:

- Build → verify with `npx tsc --noEmit`, `npx next lint --file <paths>`, `npm run build`
  → `git commit` → `git push origin main` (Vercel auto-deploys).
- Surface genuine landmines **before** building; for clear directives, execute.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Migrations are the one careful, Drake-gated path** — see `ingestion.md` § Ops traps.

## Performance — SQL aggregation is the baseline

**Going forward, dashboard aggregation runs in Postgres, not JavaScript.** The pattern:
the **tagger** materializes per-lead/per-cycle facts into the tag tables (`lead_cycles`
/ `lead_cycle_stages`) at write-time; the dashboard reads them via **SQL functions**
(read-time) or direct column reads — instead of pulling thousands of raw rows into the
page and crunching them in JS. New aggregation should follow this: don't add a JS scan
over `close_*` / `airtable_*` when a function over the materialized tables will do. See
`docs/sales-sql-aggregation-plan.md` for the migration arc.

**Done:** funnel box counts (`sales_funnel_counts`, migration 0079); speed-to-lead + FMR
(per-cycle facts materialized in `lead_cycles` via 0080, read by `getSpeedToLeadCohort` /
`getFmrSignals`; aggregated by `sales_speed_fmr`, 0081). Each preserves the prior numbers
exactly — verified per-lead + cell-by-cell against the JS before cut-over.

**Still JS (the remaining slowness — see [[logic]] § Known perf):** the roster
(`getLeadsForRange`, called by BOTH the funnel and leads pages), and the Talent per-rep
metrics.

## Legacy docs being folded in (do not treat as current)

These predate this folder and are being consolidated here. Read them only to mine
still-true detail, then delete once their content lives in the docs above:

- `docs/sales-dashboard-architecture.md` — the 1,886-line palimpsest. **Superseded by
  this folder.**
- `docs/runbooks/sales_dashboard.md` — the older v1/v2 metric-catalog surface
  (`/[section]`, `/states`, "~30 of ~140 LIVE"). A legacy layer the funnel/leads/talent
  product grew over, not the current product.
- `docs/high-ticket-funnel-explained.md`, `docs/data-hygiene.md` — folded into
  `data-model.md` / `logic.md`.
- `docs/sales-sql-aggregation-plan.md` — the live **performance** plan (push
  aggregation into Postgres). Still active; will move under this folder.
</content>
</invoke>
