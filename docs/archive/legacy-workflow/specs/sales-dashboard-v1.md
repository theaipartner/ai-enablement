# Sales Dashboard v1 — Admin-Gated Engine View (Gregory)
**Slug:** sales-dashboard-v1
**Status:** in-flight
**Target branch:** main

## Context

Execute on `main`. `git branch --show-current` to confirm. This builds a new admin-only page in the existing Gregory app that visualizes the seven ingested data sources against the Engine sheet's structure. Reads DIRECTLY from the mirror tables (no aggregation layer yet — that's a future spec). Speed + a real thing for Nabeel to look at is the priority; correctness-by-omission over correctness-by-guessing.

**All seven sources are live in Supabase:** Close, Meta, Wistia, Calendly, Typeform, Clarity, Airtable (setter triage + full closer US/AUS). The Engine sheet (`Data_Sheet_-_Overall_Engine`) defines ~140 metrics across 9 sections: Advertising, Content, Funnels, Appointment Setting, Closing, Sales Data, Back End Rev, Business Costs, Fulfillment.

## Design — match Gregory exactly, invent nothing

**Read Gregory's existing frontend BEFORE writing any UI.** Pull the colorway, font, spacing, and component primitives from the current Gregory pages — do NOT introduce new colors, fonts, or a new design language. Specifically:
- Reuse Gregory's existing CSS variables / theme tokens / Tailwind config (whatever's in use). Same fonts, same color palette, same border/radius conventions as the current admin pages.
- Reuse Gregory's existing chart library if one is already a dependency (check package.json — recharts/chart.js/etc.). If none exists, use a lightweight one consistent with the stack, but prefer what's already there.
- Match the existing admin page layout shell (header, nav, container widths) so this feels native, not bolted-on.
- If anything about the existing design system is ambiguous, mirror the closest existing admin page rather than guessing.

**Layout: kanban-style columns.** Each of the 9 Engine sections is a column. Within each column, cards stack vertically — one card per metric (or metric group). Metric cards show the number where live; graph cards show a placeholder (empty chart frame with the metric title + "graph coming soon" or similar) where the visualization isn't wired yet. Graphs can ALL be placeholders for v1 — the point is the structure + the live numbers, not finished charts.

## Access control — admin only, reuse existing auth

Gregory already has role-based auth: a `public.users` table with `role IN ('client','csm','admin')`, `getUserRole()` helper, middleware protecting `/admin/*`, and admins land on `/admin/*`. **Reuse this entirely — build no new auth.**
- The dashboard lives at an admin route (e.g. `/admin/sales-dashboard`) protected by the existing admin middleware/route-guard.
- Only `role='admin'` users (Nabeel + Drake) can reach it. A `client` or `csm` hitting the URL gets the existing redirect behavior — confirm the existing guard covers the new route (it should if it's under `/admin/*`).
- Do NOT modify the users table, roles, or any access logic. Just place the page behind the existing admin protection.

## Entry point — a navigable card/link

- Add a "Sales" (or "Sales Engine") entry card/link on the existing admin landing page (wherever admins currently land, e.g. `/admin/content`) that navigates to the dashboard. Match the visual style of whatever cards/nav items already exist there.
- Also add it to the admin nav/sidebar if Gregory has one, consistent with existing nav items.
- Keep it simple — this is just a nav affordance; the path can be refined later (Drake's note: "eventually we'll fix the path, this is an easy start").

## The live-vs-placeholder rule (CRITICAL — don't invent numbers)

For each Engine-sheet metric, decide LIVE vs PENDING by this rule:
- **LIVE — populate it** if the metric is a direct count / sum / filter / latest-value over ONE mirror table. Examples: opt-ins per day (Typeform `typeform_responses`), triage shows (Airtable `airtable_setter_triage_calls.outcome`), closed deals (Airtable `airtable_full_closer_report.closed`), adspend (Meta), landing-page visits (Clarity), closer bookings (Calendly), VSL engagement (Wistia). Compute it with a straightforward query and show the real number.
- **PENDING — placeholder slot** if the metric needs a cross-source join, a derived ratio, or touches one of the flagged Airtable ambiguities. Render the card with its title + a clear "pending" state (NOT a zero, NOT a guess). Examples: LP conversion rate (Clarity visits ÷ Typeform opt-ins — cross-source), cost per lead (Meta spend ÷ leads — cross-source), the three objection rows (no structured source), direct-booking-led vs setter-led splits (`is_setter_led` is provisional), canonical cash-collected (ambiguous field).
- **NO SOURCE — greyed/empty section** for sections whose source isn't ingested at all: Content (IG/YouTube analytics), Back End Rev (GHL/Wix/etc.), Business Costs (manual), most of Fulfillment. Show the section/column with its metric titles as empty placeholders labeled "source not connected" so Nabeel sees the full engine and what's pending.

The governing principle: **a metric is either a real number from one table, or it's visibly pending. Never a computed-but-unverified number presented as fact.** When unsure whether a metric is single-source-clean, default to PENDING.

## What to build

1. **The page** at `/admin/sales-dashboard` (or Gregory's route convention), admin-gated, Gregory-styled, kanban columns for the 9 sections.
2. **A data layer** that queries the mirror tables for the LIVE metrics. Reads directly (no views). Keep queries simple + per-metric; this is v1, not optimized. Default time window: today + maybe a 7-day or 30-day toggle if cheap, but a single sensible default window is fine for v1.
3. **Metric cards** (live number) + **graph placeholder cards** (titled empty chart frames) + **pending cards** (titled, "pending" state) + **greyed section columns** for no-source sections.
4. **The entry card/nav link** on the admin landing.
5. A short **legend** somewhere on the page explaining live vs pending vs not-connected, so Nabeel reads it correctly without explanation.

**Map each Engine-sheet section to its source(s) and decide live/pending per metric** using the Engine sheet's source tags + the rule above. Use the Engine sheet structure (9 sections, the named rows) as the authoritative list of what cards exist. For each row: if single-source-live, wire it; else placeholder.

## Gates / hard stops

- Read-only against the mirror tables. No writes, no migration, no schema changes, no new env vars.
- No new auth — reuse existing admin gating. Do NOT touch the users table or role logic.
- Deploy is via Drake's push → Vercel (gate (c)). Builder builds + tests; Drake deploys + eyeballs.
- If a "live" query is ambiguous or would require a join to be meaningful, downgrade it to PENDING rather than shipping a number you're unsure of. When in doubt, pending.
- Don't invent design — if Gregory's existing styles don't cover a case, match the nearest existing page.

## What success looks like

- A navigable, admin-only `/admin/sales-dashboard` page in Gregory's exact colorway + font, kanban columns for all 9 Engine sections.
- Every single-source metric that can be computed simply from one mirror table shows a real, current number.
- Everything cross-source / derived / flagged renders as a clearly-labeled pending placeholder; no-source sections show as not-connected placeholders.
- Graphs are placeholder frames (titled, "coming soon") — acceptable for v1.
- A legend explains the three states.
- Entry card/link on the admin landing navigates to it.
- Reuses existing admin auth — non-admins can't reach it; nothing in the auth/users layer modified.
- Tests where Gregory has a testing pattern for pages/data-fetching (match existing density); at minimum, the data-layer queries are covered or smoke-verified against the real mirror tables. Report what was verified.

## Think this through — what could go wrong

Inventing a new design language instead of reusing Gregory's (read the existing frontend first — this is the most likely failure). Computing a cross-source ratio and presenting it as live when it should be pending (when in doubt, pending). The new route not actually being covered by the existing admin guard (verify a non-admin gets redirected). Showing zeros for no-data metrics that read as real (use explicit pending/not-connected states, not 0). Querying mirror tables with wrong column names (check the schema docs / actual columns — e.g. Airtable uses `record_id`, `closed`, `outcome`; Typeform uses `response_id`, `submitted_at`; confirm against the shipped schema docs). Heavy per-card queries making the page slow (fine for v1 admin-only, but note it). The Engine sheet's derived rows being mistaken for single-source (most ratios/rates are derived → pending). Surface honestly.

## Mandatory doc updates

- New `docs/runbooks/sales_dashboard.md` — what's live vs pending vs not-connected per section, the live-vs-pending rule, how to promote a pending metric to live later (i.e. when the aggregation layer or a new source lands), the admin-gating note.
- `docs/state.md` — append entry at END (dashboard v1 shipped, reads mirrors directly, admin-only, kanban + placeholder graphs, what's live).
- `CLAUDE.md` — note the new admin page under the relevant section if the structure list warrants it.
- Report at `docs/reports/sales-dashboard-v1.md` — what's live vs pending per section, design decisions (which Gregory tokens/components reused), what Drake should verify post-deploy. Confirm executed branch.
