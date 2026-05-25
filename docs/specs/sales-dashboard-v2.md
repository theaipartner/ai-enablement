# Sales Dashboard v2 — Hero + Sidebar Restructure
**Slug:** sales-dashboard-v2
**Status:** in-flight
**Target branch:** main
**Visual reference:** `docs/specs/sales-dashboard-v2.html` (the design-mock HTML; committed alongside this spec)

## Context

v1 ships today as a flat 9-column kanban of ~117 metrics. Too dense; no hierarchy; everything reads at the same weight. v2 restructures the page without changing the data layer (`lib/db/sales-dashboard.ts`) or the catalog. The metric catalog, fetchers, and state semantics in v1 are correct — keep them.

Three changes:
1. **Hero overview** as the front page — only the seven numbers Nabeel watches daily.
2. **Sales-only left sidebar** that opens each of the 9 Engine sections as its own page.
3. **Three-state visual language** sharpened — live / pending / not-connected read as distinct visual weights so the eye lands on live values first.

**Scope guard.** This spec touches the `/sales-dashboard` route only. Do not propose changes to `/clients`, `/calls`, or any other Gregory page. The left sidebar is sales-only — do not promote it to the global app shell.

## Design — match the mock, reuse Gregory tokens

Read `docs/specs/sales-dashboard-v2.html` before writing code. Every color, font, spacing decision is already token-correct against `app/globals.css` — no new tokens, no new font families. If you find yourself reaching for a new value, look in the mock first.

**Primitives reused as-is.** `HeaderBand`, `GegPill`, `EmptyStateAwareSection`. Do not modify them. If you discover the mock implies a change to one of these primitives, stop and surface it — that's a separate spec.

**One new primitive: `<MetricCard>`** at `components/sales/metric-card.tsx`. Three state variants (`live` / `pending` / `not_connected`), takes a `MetricEntry` + `FetchResult`. The existing inline-rendered card in `app/(authenticated)/sales-dashboard/page.tsx` (the kanban version) is replaced by this primitive. The mock at `.metric-card` shows exact chrome per state. Per `docs/gregory-conventions.md`, primitives live in `components/gregory/` if they're cross-page; sales-specific primitives live in `components/sales/`. `MetricCard` is sales-specific — keep it under `components/sales/`.

## Routing — sub-routes, matching Gregory's existing convention

```
/sales-dashboard                       — Overview (hero)
/sales-dashboard/[section]             — Section detail (one per Engine section)
/sales-dashboard/states                — Three-states reference page (optional v2.1)
```

Section slugs (URL-safe, lowercase, hyphenated) ↔ catalog `SectionId` mapping:

| Slug                   | SectionId             |
|------------------------|-----------------------|
| `advertising`          | `ADVERTISING`         |
| `content`              | `CONTENT`             |
| `funnels`              | `FUNNELS`             |
| `appointment-setting`  | `APPOINTMENT SETTING` |
| `closing`              | `CLOSING`             |
| `sales-data`           | `SALES DATA`          |
| `back-end-rev`         | `BACK END REV`        |
| `business-costs`       | `BUSINESS COSTS`      |
| `fulfillment`          | `FULFILLMENT`         |

Add a `SECTION_SLUGS` const in `lib/db/sales-dashboard.ts` next to `SECTION_ORDER` so both files share one source of truth. 404 on any unknown slug via Next's standard `notFound()`.

## Slot order — Overview page

1. **HeaderBand** — eyebrow `SALES · ENGINE`, title `Today.`, actions slot carries the rolling-window pill + admin/user pill. No backlink (this is the root page).
2. **Hero lede row** — 3 `<MetricCard variant="hero-lede">` cards in a CSS grid (3-up). Catalog IDs in order: `cls_total_cash`, `cls_closed_total`, `fun_typeform_submits`. See *Hero metric catalog* below for the exception on `cls_total_cash`.
3. **Hero supporting row** — 4 `<MetricCard variant="hero-support">` cards in a 4-up grid. Catalog IDs in order: `fun_total_closer_bookings`, `adv_total_adspend`, `aps_total_dials`, `ful_calls_held`.
4. **Engine status strip** — counts derived from `METRICS` (not hardcoded): live count, pending count, not-connected count, sections-with-at-least-one-live count, total coverage %.
5. *(optional v2.1)* **Section pulse rail** + **Engine coverage block** — these are in the mock but require infra that doesn't exist yet (deltas; see *Out of scope* §). Ship the page without them in v2.0; revisit in v2.1.

## Slot order — Section page

1. **HeaderBand** — eyebrow `SALES · {SECTION}`, title `{Section}.` (period), backlink `← BACK TO OVERVIEW` pointing at `/sales-dashboard`, actions slot carries window pill + a `{N} LIVE · {N} PENDING · {N} N/C` summary derived from the catalog filter.
2. **Top-live row** (`EmptyStateAwareSection` with `mode='show'` when at least one live metric exists; `mode='stub'` with the empty-section-stub copy from the mock when zero) — 3-up grid of the first 3 live metrics in catalog order. See *Top-live picker* below.
3. **Full catalog grid** (`EmptyStateAwareSection` with `mode='show'`) — every metric in the section in catalog order, rendered through `<MetricCard variant="grid">`. 4-column CSS grid; gap from the mock.

No glance row, no diagnostics collapse, no configuration slot — this is a metrics view, not an entity-detail page. The slot order from `gregory-conventions.md § Detail-page slot order` applies in spirit but only slots 1 + 3 are populated.

## Hero metric catalog (the 7)

Locked, in display order:

| Slot          | Catalog ID                     | Current catalog status |
|---------------|--------------------------------|------------------------|
| Lede 1        | `cls_total_cash`               | **`pending`** ← see Decision 1 |
| Lede 2        | `cls_closed_total`             | `live`                 |
| Lede 3        | `fun_typeform_submits`         | `live`                 |
| Support 1     | `fun_total_closer_bookings`    | `live`                 |
| Support 2     | `adv_total_adspend`            | `live`                 |
| Support 3     | `aps_total_dials`              | `live`                 |
| Support 4     | `ful_calls_held`               | `live`                 |

**Decision 1 — promote `cls_total_cash` to live.** It's currently `pending` because the underlying cash field is ambiguous (deposit vs new-call vs follow-up). For v2, ship it as `live` computed as the catalog-order sum: `cls_cash_deposits + cls_cash_new + cls_cash_followup` once those three resolve, OR — for v2.0 ship today — as a single-table sum over `airtable_full_closer_report.cash_collected` (or whichever field the schema docs canonicalize). If that field is not yet trustworthy, **ship the hero card in pending state with the warn-tinted treatment** — the hero contract allows it, the mock just expects it to be the exception not the norm. Surface the decision in the report.

**Hero error fallback.** If a hero fetcher throws (`live_error`), render the red-bordered ERROR variant from `metric-card`. Never replace a hero card with another metric — the 7 slots are fixed.

## Top-live picker (section pages)

```
const topLive = METRICS
  .filter(m => m.section === sectionId && m.status === 'live')
  .slice(0, 3);
```

Catalog order, first three. No "biggest mover" logic, no manual curation list. Sections with fewer than 3 live metrics render whatever live cards they have; sections with zero render the empty-section-stub (see mock `.empty-section-stub`).

## Sidebar — sales-only, lives in the segment layout

The sidebar renders only under `/sales-dashboard/*`. Implement in `app/(authenticated)/sales-dashboard/layout.tsx` (already exists; currently a passthrough — extend it). Two-column grid: 240px sidebar + flexible main. Do NOT touch `app/(authenticated)/layout.tsx`.

**Sidebar contents** (top to bottom; see mock for exact treatment):
1. Brand block — `SALES · ENGINE` eyebrow + `The Engine.` serif title
2. Overview link
3. `9 ENGINE SECTIONS` group label
4. One link per section in `SECTION_ORDER`, with a per-section metric count derived from `METRICS.filter(m => m.section === id).length` (do NOT hardcode counts; the mock's 7/16/21/47/30/8/9/6/4 will drift the moment a row is added to the sheet)
5. `REFERENCE` group label
6. `Three states` link → `/sales-dashboard/states` (if shipping that page in v2.0; otherwise omit)

Active state via Next's `usePathname()` — the link whose href matches the current route gets the gold `border-left-color` + `accent-fill` background per the mock.

Use `<Link>` from `next/link` for every entry. Sidebar is a Client Component (`'use client'`) only because of `usePathname`; the rest of the page tree stays server-rendered.

## Three-state visual contract

Locked in the mock at `.metric-card.live` / `.metric-card.pending` / `.metric-card.not-connected`. Reproduce exactly. Summary:

| State            | Surface                              | Number?       | Source label   | Border-left rule |
|------------------|--------------------------------------|---------------|----------------|------------------|
| `live`           | `--color-geg-bg-elev` solid          | Yes, big serif | mono, text-3   | none             |
| `pending`        | `--color-geg-warn-fill` tinted       | No — `PENDING` pill | mono, warn-colored | none             |
| `not_connected`  | transparent, **dashed border**       | No — `NOT CONNECTED` pill | mono, text-faint | none             |
| `live_error`     | bg-elev, **red border-left 3px**     | `ERROR` mono, message in `title` tooltip | mono, text-3 | red |

Each state has a small dot glyph in the card head (`.state-glyph`) — green/warn/faint per state — for redundant color encoding (a11y per `gregory-conventions.md § Baseline NFRs`).

The metric card is its own primitive. **Do not invoke `EmptyStateAwareSection` per card.** `EmptyStateAwareSection` wraps the *groups* on the section page ("Top live" and "Full catalog"); the per-metric state lives inside `<MetricCard>`.

## Engine status strip — derive, don't hardcode

```
const liveCount    = METRICS.filter(m => m.status === 'live').length;
const pendingCount = METRICS.filter(m => m.status === 'pending').length;
const ncCount      = METRICS.filter(m => m.status === 'not_connected').length;
const sectionsWithLive = new Set(METRICS.filter(m => m.status === 'live').map(m => m.section)).size;
const coverage = (liveCount / METRICS.length);
```

These numbers update automatically when catalog rows are added or promoted. The mock's "31 LIVE · 53 PENDING · 33 NOT CONNECTED" / "27%" / "7 of 9" are illustrative — render the live computation.

## Out of scope for v2.0 (defer to v2.1)

The mock includes these; do NOT build them in v2.0:

- **Deltas / sparklines / "▲ +5%" copy.** No prior-window data layer exists. The mock fakes them. Either (v2.1) extend each fetcher to return `{ value, priorValue }` and add a 7-day-prior window, or accept that v2.0 ships values only and the delta slot is hidden. Recommend v2.0 = values only.
- **Section pulse rail** on Overview — requires deltas.
- **Engine coverage block** with the stacked bar — fine to ship in v2.0 since it's pure catalog math, but optional; the status strip already covers it.
- **Window switcher** beyond the existing `Last 7 days · rolling`. The pill in the actions slot is decorative for v2.0.

## File-by-file change list

| File                                                       | Change                                                                                                       |
|------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------|
| `app/(authenticated)/sales-dashboard/layout.tsx`           | Add the sidebar shell. Two-column CSS grid. Sidebar is its own client component.                              |
| `app/(authenticated)/sales-dashboard/page.tsx`             | Rewrite as Overview. Hero lede + support rows + status strip. Drop the 9-column kanban.                       |
| `app/(authenticated)/sales-dashboard/[section]/page.tsx`   | **New.** Section detail. Resolves slug → SectionId, renders Top-live + Full catalog.                          |
| `app/(authenticated)/sales-dashboard/states/page.tsx`      | **New, optional.** Three-states reference page. Ship in v2.0 if cheap; defer to v2.1 if not.                  |
| `app/(authenticated)/sales-dashboard/sidebar.tsx`          | **New.** Client component. Uses `usePathname()` for active state.                                             |
| `components/sales/metric-card.tsx`                         | **New.** Three state variants + `hero-lede` / `hero-support` / `grid` size variants.                          |
| `lib/db/sales-dashboard.ts`                                | Add `SECTION_SLUGS` map. Add a `getHeroMetrics()` helper returning the 7 IDs in order (centralizes the list). |
| `app/globals.css`                                          | **No changes.** Every color in the mock comes from existing `--color-geg-*` tokens.                           |

## Gates / hard stops

- Existing admin gating from v1 covers `/sales-dashboard/*` — verify the middleware matches the wildcard (it should; the route group is the same).
- Catalog stays the source of truth. Do not duplicate the metric list in component code.
- Do not change `gregory-conventions.md`. If you discover the mock requires a convention change, surface it as a separate spec.
- Reads remain direct against mirror tables. No new views, no new aggregation layer (still a future spec).
- No new fonts, no new colors, no new third-party deps. Charts (sparklines) deferred — see *Out of scope*.

## What success looks like

- `/sales-dashboard` renders the hero (3 lede + 4 support + status strip) and nothing else. Page reads in under one screen on a 1440×900 viewport.
- Clicking any sidebar section navigates to `/sales-dashboard/{slug}` and shows the section page.
- Sidebar active state visibly tracks the current route.
- Every live hero card shows a real number. Pending hero cards (currently expected: `cls_total_cash` if Decision 1 lands in pending) show the warn-tinted state.
- Section pages render Top-live + Full catalog; the three states are visually distinct at a glance.
- Sidebar counts derive from `METRICS.length` per section — adding a catalog row updates them with no UI change.
- The other Gregory pages (`/clients`, `/calls`, etc.) are pixel-identical to before. No global-layout regression.
- Non-admin users still bounce off `/sales-dashboard/*`.

## Think this through — what could go wrong

- Modifying `app/(authenticated)/layout.tsx` instead of the segment layout — leaks the sales sidebar into every page.
- Reinventing `HeaderBand` instead of reusing it — every section's title row must go through `HeaderBand`.
- Hardcoding the per-section counts in the sidebar instead of deriving from `METRICS` — guaranteed to drift.
- Shipping deltas/sparklines with fake numbers — the mock's deltas are illustrative; pulling them through to prod presents invented data as real. Decision 1's exception (a pending hero card) is the only place "no number" is allowed on the hero.
- Treating the metric card as an `EmptyStateAwareSection` — wrong primitive. `EmptyStateAwareSection` wraps groups (Top live, Full catalog), not individual cards.
- The `cls_total_cash` decision — easiest failure is to leave it pending without surfacing why the hero shows a warn-tinted card to Nabeel. Document the call in the report.
- Section page with zero live metrics (Content, Back-End Rev, Business Costs) — must render the empty-section-stub from the mock, not a blank slot.
- Slug ↔ SectionId mismatch — keep one source of truth (`SECTION_SLUGS` in `lib/db/sales-dashboard.ts`).

## Mandatory doc updates

- `docs/runbooks/sales_dashboard.md` — append v2 section. Hero contract, sidebar contract, three-state visual rules, how to promote a pending metric (it lights up its catalog card AND, if it's a hero metric, its hero card).
- `docs/state.md` — append entry at END (v2 ships the hero + sidebar + section pages, the kanban is retired).
- Report at `docs/reports/sales-dashboard-v2.md` — Decision 1 outcome (`cls_total_cash` live or pending and why), any deltas/sparklines decision, what Drake should verify post-deploy.
