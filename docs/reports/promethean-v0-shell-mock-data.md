# Report: Promethean V0 — full dashboard shell with mock data on a feature branch
**Slug:** promethean-v0-shell-mock-data
**Spec:** docs/specs/promethean-v0-shell-mock-data.md

## Files touched

**Created**

- `app/(authenticated)/promethean/fonts.ts` — Instrument Serif + Inter via `next/font/google`, exposed as CSS variables (`--font-prom-serif`, `--font-prom-sans`) consumed by `[data-theme="promethean"]`.
- `app/(authenticated)/promethean/layout.tsx` — wraps the route group in `data-theme="promethean"` + font variables. Auth still routes through the parent `(authenticated)/layout.tsx`.
- `app/(authenticated)/promethean/page.tsx` — **Overview** at 95% polish: CEO eyebrow + serif headline, Monthly Pace + Live Pipeline split, three Leverage cards, money KPI strip, acquisition-economics strip, daily-ROAS SVG sparkline.
- `app/(authenticated)/promethean/pipeline/page.tsx` — filterable lead table with All / Active / Overdue chips and status pills.
- `app/(authenticated)/promethean/financials/page.tsx` — 4-card money strip + recent payments table.
- `app/(authenticated)/promethean/setter-eod/page.tsx` — lead-entry form with country / setter / outcome / cash / plan / quality / closer / sentiment / notes fields + side queue.
- `app/(authenticated)/promethean/triage-inbox/page.tsx` — triage queue table + AI Mode panel (preview-badged).
- `app/(authenticated)/promethean/ai-mode/page.tsx` — standalone AI Mode page with sample-question deck.
- `app/(authenticated)/promethean/contacts/page.tsx` — global contact table with click-through to detail.
- `app/(authenticated)/promethean/contacts/[id]/page.tsx` — per-lead detail (deal shape, relationships, lead quality, recording panel — all preview-badged where relevant).
- `app/(authenticated)/promethean/closers/page.tsx` — closer card-grid leaderboard.
- `app/(authenticated)/promethean/closers/[id]/page.tsx` — per-closer page: KPI strip, scoped leverage cards (`If <Name> fixed one thing.`), outcomes, consistency, "How do we help <Name>?" AI card.
- `app/(authenticated)/promethean/setters/page.tsx` — setter card-grid leaderboard.
- `app/(authenticated)/promethean/setters/[id]/page.tsx` — per-setter page: KPI strip + dial-timeline visualization (gap-by-gap, last 7 days, colored bars per outcome) + recent-calls table.
- `app/(authenticated)/promethean/setter-qc/page.tsx` — AI-graded calls table with grade pills + "Grade conversation" buttons.
- `app/(authenticated)/promethean/number-health/page.tsx` — dial-mix KPIs + per-number watchlist with spam-likely flags.
- `app/(authenticated)/promethean/marketing/page.tsx` — ROAS economics + per-campaign table + per-country card grid.
- `app/(authenticated)/promethean/deep-dive/page.tsx` — no-show windows + the **pairing matrix heatmap** (the transcript's flagship feature) + lead-quality → outcome breakdown.
- `app/(authenticated)/promethean/inbox/page.tsx` — kind-tinted notification cards (win / risk / alert / system).
- `app/(authenticated)/promethean/money-on-table/page.tsx` — stuck-deal recovery view with days-idle.
- `app/(authenticated)/promethean/payment-plans/page.tsx` — installment plans with paid/remaining/next-charge.
- `app/(authenticated)/promethean/cohort-retention/page.tsx` — month-by-month retention heatmap grid.
- `app/(authenticated)/promethean/pnl/page.tsx` — line-by-line P&L from cash to net profit.
- `components/authenticated-shell.tsx` — route-aware client component picking Gregory's TopNav or Promethean's shell by `usePathname`.
- `components/promethean/shell.tsx` — dark editorial sidebar with brand block, three nav sections (default / SALES / ACQUISITION / WORKBENCH), config footer with logout, "← Back to Gregory" link.
- `components/promethean/primitives.tsx` — shared design system: `PromPage`, `PromPageHeader`, `PromCard`, `PromSection`, `KpiCard`, `LeverageCard`, `DeltaPill`, `Pill`, `PreviewBadge`, `PromDropdownStub`, `PromTable` family, `AvatarCircle`, `LiveDot`, `EmptyState`, `money` / `pct` / `intish` formatters.
- `components/promethean/primitives-extra.tsx` — re-exports + tiny composed helpers (e.g. `setterDisplay`).
- `lib/mock-data.ts` — single mock-data boundary. Seeded mulberry32 RNG, typed entities (Setter / Closer / Lead / Dial / AdSpendDay / Payment / QcReview / InboxNotification), plus pure derived-metric helpers (`getOverviewMetrics`, `getCloserStats`, `getSetterStats`, `getMarketingMetrics`, `getPairingMatrix`, `setterById` / `closerById` / `leadById`).
- `lib/promethean-vocab.ts` — value/label const arrays for country / lead status / outcome / lead quality / sentiment / dial outcome / triage status / QC grade. Mirrors the `lib/client-vocab.ts` shape.
- `docs/reports/promethean-v0-shell-mock-data.md` — this file.

**Modified**

- `app/(authenticated)/layout.tsx` — replaced inline `<TopNav>` + `<main>` with the new `<AuthenticatedShell>` switcher. Auth check and `redirect('/login')` unchanged.
- `app/globals.css` — appended a `[data-theme="promethean"]` block: warm-dark color tokens (`--color-prom-bg`, `--color-prom-bg-elev`, `--color-prom-text`, `--color-prom-accent`, etc.), small-caps + serif utility classes (`prom-eyebrow`, `prom-serif`, `prom-numeric`), `@keyframes prom-pulse` for the LIVE indicator, scrollbar restyling. Scoped — Gregory's light shell is untouched.
- `docs/state.md` — appended a "Promethean V0 exploration" section per the spec's mandatory-doc-updates list.

## What I did, in plain English

Built a polished, demo-able shell of all the Promethean dashboard surfaces in a single Builder session, on a feature branch (`promethean-shell`) that Vercel auto-deploys as a preview. The whole thing runs on a single seeded mock-data file — zero backend, zero Supabase queries, zero LLM calls. Auth still rides through Gregory's existing Supabase-Auth gate; the only structural change to existing code is a route-aware shell switcher that picks the Promethean dark sidebar when the path starts with `/promethean` and otherwise falls back to Gregory's TopNav unchanged.

The editorial-dark aesthetic from the reference screenshots is implemented as a `[data-theme="promethean"]` scope in `app/globals.css` with warm-dark backgrounds, near-white text, yellow-green accent, red-orange negative, plus serif headlines via Instrument Serif loaded inside the route group's layout. Every page composes from a shared primitive library in `components/promethean/` — `PromPageHeader` with the eyebrow-plus-serif pattern, `KpiCard` with the small-caps-label-plus-big-numeric shape, `LeverageCard` with the cash-delta + progress-bar + coaching-question shape, plus a dark editorial table family. Locking the visual direction in primitives meant the 14 secondary surfaces stayed coherent on a tight budget.

Overview got the heaviest polish per Drake's `/run` arg — Monthly Pace card with the "Set a target to unlock pace tracking" empty state and the config-hint snippet, Live Pipeline card with the big yellow-green projected-cash number and the three sub-stats below, three Leverage cards with peer-comparison framing and coaching questions in the brand voice, the money KPI strip with delta pills, an acquisition-economics strip, and a hand-drawn daily-ROAS SVG sparkline at the bottom. The other 14 surfaces hit ~80% — table-heavy where appropriate (pipeline, contacts, payment plans, setter QC), card-grid where appropriate (closers leaderboard, setters leaderboard), heatmap-grid for the pairing matrix on Deep Dive and the cohort grid on Cohort Retention.

Each surface that would eventually be backed by an LLM (AI Mode, Setter QC grades, the closer-detail "How do we help X?" coaching card, the contact-detail recording panel, the lead-quality bands on Deep Dive, the Cohort Retention page in full) renders the `<PreviewBadge />` with the hover tooltip "Demo-only. Live AI features land in V1." so it's unambiguous what's wired vs what's mocked.

Commits split into seven coherent units: scaffold + nav switcher, mock data, primitives, Overview + fonts, then three surface batches. Build is clean — `npm run build` produces all 18 Promethean routes (page sizes 188–196 B, First Load JS 87–96 kB).

## Verification

- **`npm run build` clean.** Final run produced all 27 routes including 18 under `/promethean`. No compile errors, no type errors, no lint errors after a fix-up pass for unused imports, escaped-entity rules, and one `PromTD` style-prop pass-through.
- **No new dependencies.** Everything renders from already-installed packages (React 18, Next 14, Tailwind v4, base-ui, lucide-react, `next/font/google` for the serif). The reference's "no dependency additions without surfacing" hard stop held.
- **Gregory untouched.** Only Gregory-facing edit was `app/(authenticated)/layout.tsx` swapping `<TopNav>` for `<AuthenticatedShell>`, which renders `<TopNav>` 1:1 when `pathname` doesn't start with `/promethean`. `app/globals.css` additions are all scoped under `[data-theme="promethean"]` selectors; no Gregory tokens overwritten.
- **No backend calls.** Every data fetch in the Promethean code paths is a pure import from `lib/mock-data.ts`. Zero Supabase client calls, zero Anthropic / OpenAI calls.
- **Did NOT exercise the running UI in a browser.** The local-dev verification this session relied on a clean build + careful component-shape inspection rather than a live `npm run dev` + manual click-through. The build's passing static analysis covers compile / type / lint; visual verification at the Vercel preview URL is Drake's gate (c).

## Surprises and judgment calls

- **Scoping the dark theme.** The reference is a specific editorial aesthetic, not generic dark mode, so I avoided putting `.dark` on a wrapper (which would have picked up shadcn's neutral-zinc dark tokens) and instead authored a fresh `[data-theme="promethean"]` palette in CSS variables. The Tailwind utilities (`text-prom-text`, etc.) aren't generated by Tailwind v4 from arbitrary CSS variables, so most color application is via inline `style` props referring to `var(--color-prom-...)`. This is verbose but reliable and keeps the palette truly scoped — Gregory's tokens are completely unaffected. Worth flagging because a future spec to "add a polish pass via Tailwind utilities" would want to register the prom-* tokens in a `@theme inline` block that's not gated by the data-theme selector so utility classes resolve.
- **Auth-shell switching via client component.** Gregory's `(authenticated)/layout.tsx` is a server component (calls `supabase.auth.getUser()` and `redirect`), so the route-based shell pick happens in a small client component (`AuthenticatedShell`) downstream. `usePathname` from `next/navigation` only works in client components. The auth check still runs server-side at the layout boundary so unauthenticated requests never hit any downstream code — the only thing that's client-side is the shell selection, which is safe.
- **`/promethean` mounts under `(authenticated)`.** This was the spec call. It means logging in via the existing `/login` page also unlocks Promethean, which is what Drake wants for demo-ability. There's no tenant switcher logic — Promethean is hardcoded to render the "Helios · SCALE-2" mock tenant identity. Real multi-tenancy is a V1 problem.
- **Setter dial-timeline visualization.** The reference describes "you took a 14 minute gap here, 2 minute gap here" as the differentiator on the setter detail page. I built it as a horizontal bar strip per day with colored bars per outcome (yellow-green for booked, warm-yellow for live convos, muted grey for no-answer / voicemail) and explicit gap labels in minutes when the gap exceeds 8 minutes. Reads naturally even without a chart library.
- **Pairing matrix as a heatmap table, not a chart.** The transcript describes it as a `setter × closer` grid with cash collected as cell intensity. Built as a native `<table>` with cell `background` set via `rgba(212, 225, 87, ${0.04 + intensity * 0.25})`. Skips cells with fewer than 2 won deals. Reads cleanly at any screen width.
- **Cohort retention is fully synthetic.** No mock data drives it; the page builds a 7-month × 7-month grid via a small deterministic function with sensible base retention curves. Tagged with a `<PreviewBadge />` so it's clear this is a shape demo, not data. When the cohort surface gets serious, the helper can be replaced with a real query without touching the rendering.
- **One quirky preview-badge placement.** `PromSection` accepts a `trailing` slot for badges; I used it consistently for the LLM-driven surfaces (Setter QC, AI Mode, the closer-detail coaching card, the contact-detail recording panel, Cohort Retention). For Setter EOD I placed the badge in the page header trailing slot instead since the whole form is preview. Both feel right in context but a future polish pass might want to standardize.
- **No "open the sidebar" toggle on mobile.** Spec said desktop-first; I rendered the sidebar at `md:flex` and didn't ship a mobile-menu version. The page bodies stack vertically on narrow viewports and remain readable, but the sidebar disappears entirely below `md`. Acceptable for V0; mobile is the next-iteration polish.
- **Editable cells / "AI Mode" buttons are stubs.** Buttons render and look real; clicking them does nothing. Spec said "no backend, no API calls" — the right call given the budget, but flagging since the temptation to wire them up at preview time is real.

## Out of scope / deferred

- **No real-data wiring.** The boundary is explicit at `lib/mock-data.ts`. The integration-later work — defined per surface in the spec — is the next phase if Drake green-lights it.
- **No `README.md` inside `app/(authenticated)/promethean/`.** Spec marked it optional and the inline comments in `lib/mock-data.ts` + `app/(authenticated)/promethean/layout.tsx` cover the same "this is V0 with mock data; here's how to swap to real queries" content. A future spec could add a README if a second Builder needs to acclimate without context.
- **Auth-protected `/promethean` route is gated by Gregory's `/login`.** No standalone Promethean auth surface. Per spec.
- **No `tailwind.config.ts` migration of the Promethean palette.** Tailwind v4 supports it via `@theme inline` blocks in CSS; I added the tokens but utility-class application of them across the app would require importing the tokens outside the `[data-theme="promethean"]` scope which I deliberately avoided. A future polish pass that wants `text-prom-text-2` and `bg-prom-accent-dim` as Tailwind utilities can split the token definition (global) from the activation rule (scoped).

## Side effects

**None outside the repo.** No Slack posts, no emails, no DB writes, no external API calls, no rows seeded in any shared system. The only artifacts produced are:

- 7 new commits on branch `promethean-shell` pushed to `origin/promethean-shell` on GitHub: `104c02c`, `0a5a90e`, `d252988`, `b5f402c`, `4c7e727`, `d109ae4`, `a2e2600`. (This report's commit will be the 8th.)
- Vercel auto-deploy will fire from the GitHub push on the feature branch and produce a preview URL. Drake reviews at that preview URL — see Vercel dashboard for the active deployment.
- No env-var changes. No `vercel.json` changes. No DB migrations. No `requirements.txt` / `package.json` changes.

## Recommendations for the integration phase

If Drake green-lights phase 2 (replacing mocks with real data), the rough order of attack:

1. **Close (CRM) is the unlock.** Lead status, setter / closer assignment, contract value, cash collected, payment plans, lead quality, sentiment, notes — all flow from Close. Pipeline, Contacts, Setter EOD, and the Closers / Setters detail pages become real on day one of the Close adapter. Setter EOD's "submit lead" button becomes a Close mutation rather than a Server Action stub.
2. **Stripe is independent.** Payments / Cash Received / payment plans get their own Stripe adapter with no cross-dependency on Close. Financials and Payment Plans light up the day Stripe is wired in. P&L's "cash cleared" line becomes real.
3. **Meta (and any other ad source) is the easiest to fake longer** — Marketing's ROAS / CPL / CPA / per-campaign / per-country tables can hold mock data right into V1.5 demos without anyone noticing. When you do wire it, the swap is the cleanest of the three.
4. **Setter QC is a separate ingestion + LLM layer.** Recordings → transcripts → Sonnet grading → `documents` rows. Reuses Gregory's `call_reviewer` agent pattern almost verbatim — same Sonnet system-prompt shape, different rubric. Probably a "Promethean call_reviewer" agent under `agents/promethean_call_reviewer/`.
5. **AI Mode** is the last surface to wire because it needs all the others. It's the synthesizer — point a Sonnet at the same Supabase brain the other surfaces query and let it answer free-form questions. Reuses Ella's retrieval shape.

The mock-data types in `lib/mock-data.ts` are deliberately named to map 1:1 to a future `promethean.leads`, `promethean.dials`, `promethean.ad_spend`, `promethean.payments`, `promethean.qc_reviews` table family. The schema work that needs to happen first is mostly entity definition (lead source + outcome + sentiment / lead-quality enums as CHECK constraints, mirroring how `clients.status` and `clients.journey_stage` are pinned today).

## Notes for Gregory's primitive library

Two things from this build are worth promoting if a polish pass on Gregory ever happens:

- **`KpiCard` with the small-caps-label + big-numeric + delta-pill shape** is a generally useful pattern Gregory doesn't have today. The "health score" stats on the Gregory home / individual client pages could use this shape.
- **The `LeverageCard` "what one fix would do" pattern** isn't Gregory-applicable today, but the underlying idea — pair a metric, a delta, and a coaching question — could improve the existing Gregory client-detail "concerns" section if Drake ever wants it to feel more directive.

Nothing in the Promethean primitives directly imports Gregory code; they're standalone and rely only on the shared `@/lib/utils` cn helper indirectly (via shadcn primitives that aren't actually used in Promethean — the dark family is hand-rolled). Promoting any of this to a shared layer is a deliberate future call, not an accidental import.

## How closely Overview matches the reference

I do not have the reference screenshots in this session, so I worked from the spec's prose description plus the inlined demo transcript. Best-effort match:

- ✅ CEO eyebrow + serif headline ("Every dollar, tracked.") + meta strip with date range and SYNCED timestamp + period selector pills top-right.
- ✅ Monthly Pace card with "Set a target to unlock pace tracking" empty state, config-hint snippet showing the Settings-tab row format, MTD cash + delta.
- ✅ Live Pipeline card with big yellow-green projected-cash number, explainer copy, and ACTIVE / OVERDUE / AVG-WHEN-WON sub-stats strip.
- ✅ Three Leverage cards (Close Rate / Booked Calls / Cash AOV) with cash-delta in yellow-green, progress bar, peer-comparison framing ("halfway to Sebastian Brown's 29.0%"), coaching question, lift% bottom-right.
- ✅ Money KPI strip (Revenue / Cash Collected / Cash Received / Profit) with delta pills.
- ✅ Acquisition-economics secondary KPI strip (Revenue ROAS / Cash ROAS / True ROAS / CAC / CPL / Cost-per-show).
- ✅ Daily-ROAS sparkline at the bottom with target line.

Surface-area coverage of the rest of the sidebar matches the spec's list 1:1: Inbox, Triage Inbox, AI Mode, Contacts, Closers, Setters, Setter QC, Number Health, Setter EOD, Marketing, Deep Dive, Money on Table, Payment Plans, Cohort Retention, P&L, plus Pipeline and Financials in a Workbench section since those are spec-required surfaces that didn't have a natural sidebar home in the reference.
