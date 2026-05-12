# Promethean V0 — full dashboard shell with mock data on a feature branch
**Slug:** promethean-v0-shell-mock-data
**Status:** in-flight
**Target branch:** `promethean-shell` (NOT main)

## Context

Drake is testing a hypothesis: that the 11-surface Promethean sales analytics dashboard can be substantially built in a single Claude Code session if integrations are deferred entirely. The exercise is to produce a polished, demo-able shell with realistic mock data across all 11 surfaces. Integrations (Close, Stripe, Meta) land later as one-by-one work items where the only refactor is swapping mock-data imports for real Supabase queries.

The hypothesis matters because Promethean's previous estimate was 3 weeks (with V1.5 deferrals on Meta/Stripe). A successful single-session shell with mock data would compress the visible work — Nabeel sees something demo-able in a day rather than a week. The remaining work is then strictly backend (data ingestion + real queries) which is parallelizable and incremental.

**Source reference for the dashboard shape:** Drake provided a transcript of a Promethean demo (the product Nabeel was shown). The eleven surfaces and their content come directly from that transcript. The full transcript is inlined at the bottom of this spec — Builder reads it for the feature list.

**This spec is deliberately exploratory.** The goal is to learn what "single-session 11-surface shell" looks like in practice. Builder should treat the polished demo as the target output, but it's understood that some surfaces may need follow-up iteration. The goal is not perfection; the goal is "Drake and Nabeel can see what Promethean looks like with our codebase."

## Drake-confirmed scope

- **All 11 surfaces in scope.** No trimming.
- **Realistic mock data**, generated in code, lives in a single `lib/mock-data.ts` file. Names match the transcript's style (Sebastian, James, Aubrey, Aiden, Jordan as closers; ~5-8 setters; 30-50 leads; believable dial gaps, sentiment distributions, ROAS numbers, country distributions).
- **Polish target: demo-able, looks professional.** Builder picks a coherent visual direction. Default to light mode unless conditional cues suggest otherwise. Use Tailwind defaults + shadcn/ui primitives consistent with the existing Gregory codebase. Don't chase pixel-perfection.
- **Target branch: `promethean-shell`.** This work does NOT land on main. Builder creates the branch from main's current HEAD, builds on the branch, commits to the branch. Vercel auto-deploys preview URLs from feature branches; Drake reviews at the preview URL.
- **No backend, no Supabase queries, no API calls, no integration logic.** Every data fetch in the new code returns from `lib/mock-data.ts`. The boundary is clear: when integrations land later, the only thing that changes is the import path.
- **Auth gate stays.** Promethean is behind the same Supabase Auth gate as Gregory. Drake logs in with the same credentials. No new auth surface.
- **Route group: `app/(authenticated)/promethean/...`** so it shares Gregory's auth wrapper but is its own surface.

## Acclimatization checklist — confirm in 4-5 bullets before starting

1. Confirm you're on a fresh branch `promethean-shell` cut from `origin/main`. `git checkout -b promethean-shell origin/main`. Push the branch immediately so Vercel sees it and starts auto-deploys.
2. Read `app/(authenticated)/layout.tsx` to understand the auth-gate pattern Gregory uses. Promethean reuses it — same layout file applies to `/promethean/*` routes.
3. Read `components/ui/` (shadcn primitives) and the table/pill/dropdown patterns in `app/(authenticated)/clients/clients-table.tsx`. Reuse these primitives. Do NOT create new alternatives.
4. Read `lib/client-vocab.ts` to see the vocab pattern. Promethean has its own vocabs (setter names, closer names, sentiment tiers, lead quality buckets, outcome states, country list). Create `lib/promethean-vocab.ts` with the same shape.
5. Confirm `vercel.json`'s preview-branch behavior — pushing to a non-main branch should produce a preview URL. If not, surface to Drake before pushing the first commit.

## Mock data structure

Single file: `lib/mock-data.ts`. Exports typed data structures matching what real Promethean queries will eventually return. Suggested shape:

```ts
export type Setter = { id: string; name: string; avatar_initials: string }
export type Closer = { id: string; name: string; avatar_initials: string }
export type Lead = {
  id: string
  name: string
  email: string
  country: 'USA' | 'CAN' | 'AUS' | 'UK' | 'GBR'
  source: string
  status: 'new' | 'contacted' | 'qualified' | 'booked' | 'showed' | 'pitched' | 'won' | 'lost'
  setter_id: string | null
  closer_id: string | null
  created_at: string
  first_contact_at: string | null
  booked_at: string | null
  showed_at: string | null
  pitched_at: string | null
  outcome: 'won' | 'lost' | 'no_show' | 'dq' | null
  cash_collected: number | null
  payment_plan: boolean
  lead_quality: 'ready_to_buy' | 'good' | 'average' | 'poor' | null
  sentiment: 'green' | 'yellow' | 'red' | null
  notes: string | null
}
export type Dial = {
  id: string
  setter_id: string
  lead_id: string
  dialed_at: string
  talk_time_seconds: number
  outcome: 'no_answer' | 'voicemail' | 'live' | 'booked'
}
export type AdSpendDay = {
  date: string
  campaign: string
  country: 'USA' | 'CAN' | 'AUS' | 'UK' | 'GBR'
  spend: number
  impressions: number
  clicks: number
  leads_generated: number
}
export type Payment = {
  id: string
  lead_id: string
  amount: number
  paid_at: string
  payment_plan_position: number | null
}

// Generators: deterministic so the demo is stable across reloads.
// Use a seeded RNG (e.g., mulberry32 with a fixed seed).
export const SETTERS: Setter[] = [...]
export const CLOSERS: Closer[] = [...]
export const LEADS: Lead[] = [...]
export const DIALS: Dial[] = [...]
export const AD_SPEND: AdSpendDay[] = [...]
export const PAYMENTS: Payment[] = [...]

// Derived metric helpers — each takes the data + optional period filter.
// These are pure functions; later they're replaced with SQL or API calls.
export function getOverviewMetrics(period?: DateRange) { ... }
export function getCloserStats(period?: DateRange) { ... }
// etc.
```

Data volume targets: 5-8 setters, 4-6 closers, 40-60 leads spread across the last 60 days, ~300-500 dials, 60 days of ad spend across 3 campaigns × 4 countries, 15-25 payments. Enough volume that charts have real shape; not so much that the page lags.

## The 11 surfaces

Each surface is its own route. All under `/app/(authenticated)/promethean/`. The naming is suggestion — Builder can adapt for sensible URL slugs.

### 1. Overview — `/promethean`

Top-level dashboard. The Promethean landing page. Components:

- **Period selector** (top right, applies globally; controls every metric on the page). Options: Today, Yesterday, This Week, Last Week, This Month, Last Month, Custom Range.
- **Top KPI strip** (4-6 cards): Revenue, Cash Collected, Profit, Pipeline Value, Total Calls, Close Rate.
- **Leverage simulator widget**: form with 3 input sliders (Close Rate %, AOV $, Booked Calls #) and a live-computed delta panel showing "If your close rate went from X% to Y%, you'd earn +$Z this month." Pure math, no AI. Defaults pre-populated from the mock data's actuals.
- **Daily ROAS chart**: line chart, the period's days on x-axis, ROAS variant on y-axis. Dropdown to toggle Revenue ROAS / Cash ROAS / True ROAS.
- **Pipeline summary**: small card list — "12 active deals / 3 overdue / $X total pipeline value."
- **Recent activity feed** (optional, time-permitting): last 10 lead-status changes.

### 2. Pipeline — `/promethean/pipeline`

Active leads view. Components:

- Filterable table of leads with status filter chips at the top.
- Columns: Name / Country / Status / Setter / Closer / Days in Stage / Cash potential / Last Activity.
- Click a row → opens a slide-over panel with lead detail (skip drilling into a new page — keeps the surface contained).
- "Overdue" filter chip that highlights leads stuck in a stage past a threshold (>14 days in qualified, >7 days in booked-not-showed, etc.).

### 3. Financials — `/promethean/financials`

Money-focused surface. Components:

- KPI cards: Revenue / Cash Collected / Profit / Refunds / Outstanding payment plans.
- Multiple ROAS variants displayed side-by-side: Revenue ROAS, Cash ROAS, True ROAS, with a small explainer tooltip for what each means.
- True CAC, Cost per call, Cost per showed call, Cost per qualified call.
- Stripe-style payments table (mock): Date / Lead / Amount / Status / Payment plan position.
- Country breakdown: same metrics segmented by USA / CAN / AUS / UK.

### 4. End-of-day lead entry form — `/promethean/entry` or accessible as a modal from anywhere

A form the sales rep fills out at end of day to log call outcomes. Components:

- Lead picker (search / autocomplete from `LEADS`).
- Country selector.
- Setter selector (pre-fills based on lead if known).
- Closer selector (if pitched).
- Call outcome radio: Won / Lost / No-show / DQ.
- "Pitched?" toggle.
- "Won cash?" amount input (only if Won).
- Lead quality radio: Ready to buy / Good / Average / Poor.
- Payment plan toggle.
- Free-text notes field.
- Submit button → mock writes to localStorage so the entry persists in the demo session (or just shows a "saved" toast and dismisses; either is fine).

### 5. Triages — `/promethean/triages`

Direct-booking workflow surface. Components:

- Table of recently-booked leads needing setter triage.
- Columns: Lead / Setter / Booked at / Triage status (confirmed / untriaged / DQ'd).
- Triage status pill is inline-editable (use the existing `EditableField` pattern from Gregory).
- "Add notes" affordance per row.
- "AI Mode" panel on the right side: a chat-shaped Q&A interface. **For V0, this is a static UI shell** — input box + a few pre-canned example questions + a placeholder response area. Mark with a "Preview" badge so Nabeel knows it's not live.

### 6. Contacts — `/promethean/contacts`

All contacts in the system. Components:

- Filterable, sortable table of all leads (regardless of status).
- Click a contact → detail page at `/promethean/contacts/[id]` showing:
  - Contact info (name, email, country, source).
  - Activity timeline: dials, appointments, status changes.
  - "View recording" links (mock — go to # or a dummy recording page).
  - Notes field.

### 7. Closers — `/promethean/closers`

Per-closer performance. Components:

- Top-level closer leaderboard: card grid (one per closer) with their key metrics — Cash collected / Pitches / Close rate / AOV / Average call length.
- Click a closer → detail page at `/promethean/closers/[id]`:
  - All their metrics blown out.
  - Recent calls table.
  - **AI coaching card**: "How do we help [Name]?" — mock LLM-generated suggestions (2-3 bullet points). For V0, hardcoded suggestions per closer. Mark with "Preview" badge.
  - Biggest deals list.

### 8. Setters — `/promethean/setters`

Per-setter performance. Components:

- Top-level setter leaderboard: card grid with — Dials made / Speed to lead / Conversations / Bookings / Show rate.
- "Speed to lead" detail filter: All leads / Not yet contacted / Contacted <5min / Contacted 5-30min / Contacted >30min.
- Click a setter → detail page at `/promethean/setters/[id]`:
  - Their metrics.
  - **Dial log timeline**: vertical timeline of dials with gaps highlighted (e.g., "14 min gap" labels between dials). This is the "visible gap" feature from the transcript.
  - Talk time totals per day.
  - **Setter QC panel**: list of recent calls with an AI grade (mock — Green/Yellow/Red pill + 1-line summary). "Grade conversation" button on each row is a no-op for V0. Mark with "Preview" badge.

### 9. Number Health — `/promethean/number-health`

Dial-quality metrics. Components:

- Aggregate stats: Total dials today / this week / this month.
- Connect rate (live calls / total dials).
- Average talk time.
- Distribution chart: dial outcomes (no-answer / voicemail / live / booked) as a stacked bar.
- Time-of-day heatmap: when dials happen most, when they connect best.

### 10. Marketing — `/promethean/marketing`

Ad spend + lead source. Components:

- Spend by campaign chart.
- Country segmentation: same metrics by country.
- Cost-per-acquisition variants per campaign per country.
- Lead source funnel: how many leads each campaign generates, conversion rates per stage.
- Mock-Meta-style breakdowns (creative-level NOT required for V0; campaign-level is enough).

### 11. Deep Dive — `/promethean/deep-dive`

Cross-cutting analytics. Components:

- **No-show rate analysis**: when in the day/week do bookings most likely ghost? Chart it.
- **Pairing matrix**: setter × closer cross-tab with configurable metric (Cash / AOV / No-shows / Close rate). Minimum sample size threshold (default 3). Heat-mapped cells. **This is a feature flag** — make sure the matrix component is clean and reusable; it's one of Promethean's flagship features.
- **Lead quality booking analysis**: who books high-quality vs flake-prone leads.
- **"Does the score predict the sale?"**: scatter plot of lead_quality bucket vs actual outcome.
- **Money on the table**: deals stuck in intermediate states, with their potential cash value totaled.
- **Cohort retention** (basic for V0): payment-plan retention by signup month.

## Design + UX guidance

- **Visual direction:** clean, professional, modern. Think Stripe Dashboard / Linear / Vercel / Notion — not flashy, not cluttered. Generous whitespace. Strong typography hierarchy.
- **Color usage:** primary brand color for actions only. Status pills use red/yellow/green sparingly and only for tiered statuses (sentiment, outcome, urgency). Otherwise neutral palette.
- **Tables:** reuse Gregory's `clients-table.tsx` pattern. Same `SortableHeader`, same hover treatment, same row spacing. Tables should feel familiar across both products.
- **Navigation:** add a top-level nav switcher between Gregory and Promethean in the existing layout. Two products, same shell.
- **Loading states:** skeleton loaders, NOT spinners.
- **Empty states:** every list/table has a real empty state with a one-line message and (where appropriate) a CTA. Don't render blank tables.
- **AI feature affordances:** anywhere there's a mock LLM feature (AI Mode, coaching suggestions, QC grading), render a small "Preview" badge in the corner so Drake and Nabeel know it's not live. Tooltip on the badge: "Demo-only. Live AI features land in V1."
- **Responsive:** desktop-first. Mobile is not a target for V0.
- **Dark mode:** not required.

## Hard stops

- **Do NOT push to `main`.** All work lives on `promethean-shell` branch. If something forces a main push, stop and surface.
- **Do NOT call Supabase / Anthropic API / any external service.** All data comes from `lib/mock-data.ts`. If a surface needs data that doesn't have a mock shape yet, extend the mock data file.
- **Do NOT modify existing Gregory code in ways that affect Gregory's behavior.** Touching the shared layout to add the nav switcher is allowed; modifying clients-table.tsx, calls list, or anything else under `app/(authenticated)/clients/` or `app/(authenticated)/calls/` is not.
- **Do NOT add new dependencies without surfacing first.** If a chart library or component lib feels necessary beyond what shadcn/ui + recharts provide, stop and ask.
- **Do NOT spend time on perfect pixel polish.** "Looks nice and consistent" is the target. Mismatched font sizes within a single surface or jagged spacing is worth fixing; sub-pixel kerning is not.
- **Stop and surface if a single surface exceeds ~1 hour of work.** That's the signal that surface needs scoping or simplification. Don't grind for 3 hours on Pipeline because the slide-over is hard.

## What could go wrong

- **The 11 surfaces have inconsistent visual treatment by the end.** Likely if Builder builds them sequentially over many hours — the later surfaces drift from the earlier ones. Mitigation: build the design primitives (cards, KPI strip, tables, charts) first as a shared library inside `components/promethean/`, then compose every surface from those primitives. The primitives lock the visual direction.
- **Mock data shape doesn't match what real queries will return.** Mitigation: name the types in `mock-data.ts` to match what the eventual Supabase schema would produce. E.g., a `Lead` type whose fields map 1:1 to columns in a future `promethean.leads` table. The swap is then literally `import { LEADS } from '@/lib/mock-data'` → `import { fetchLeads } from '@/lib/db/promethean'` with the same return shape.
- **AI feature shells are confusing without "Preview" badges.** Mitigation already specified — every mock LLM surface gets the badge + tooltip.
- **Drake wants more / different / fewer features after seeing V0.** Expected. This whole exercise is to surface that feedback fast. V0 is a learning vehicle, not a final deliverable.
- **Build time runs long.** Real possibility — 11 surfaces at any quality is real work. If Builder hits ~4 hours and is at 7-8 surfaces complete, that's a great result. If at ~6 hours and stuck on surface 3, stop and surface.
- **Vercel preview deploy fails because of a build error.** Build clean before pushing. `npm run build` locally before every commit on this branch.

## Mandatory doc updates

- **`docs/state.md`** — append a single entry under a new "Promethean V0 exploration" section noting that this shell was built on `promethean-shell` branch on 2026-05-11/12, what's included, what's mocked, and Drake's evaluation outcome (filled in when Drake reviews).
- **No CLAUDE.md change.** This is exploratory, not part of the canonical Director/Builder rhythm yet.
- **No new runbook.** The integrations-later spec will spawn its own runbook when Drake decides to proceed.
- **Optional: README.md inside `app/(authenticated)/promethean/`** explaining that this is V0 with mock data, where the data lives, and how to swap to real queries.

## Commit + report

Per CLAUDE.md § Commits, one logical change per commit. Suggested batched commits:

- `promethean: scaffold route group, layout, navigation switcher`
- `promethean: add mock-data.ts with realistic seeded data`
- `promethean: build shared design primitives (cards, KPI strip, charts wrapper)`
- `promethean: implement Overview surface`
- `promethean: implement Pipeline surface`
- `promethean: implement Financials surface`
- `promethean: implement end-of-day lead entry form`
- `promethean: implement Triages surface with AI Mode shell`
- `promethean: implement Contacts surface + detail page`
- `promethean: implement Closers surface + detail page with coaching shell`
- `promethean: implement Setters surface + detail page with QC shell`
- `promethean: implement Number Health surface`
- `promethean: implement Marketing surface`
- `promethean: implement Deep Dive surface with pairing matrix`
- `docs: note Promethean V0 shell exploration in state.md`
- `docs: add report for promethean-v0-shell-mock-data`

Bundle commits where natural; the principle is one logical change.

Report at `docs/reports/promethean-v0-shell-mock-data.md`. Include:

- The Vercel preview URL for the `promethean-shell` branch.
- Total session time (approximate).
- Which surfaces shipped at "looks polished" quality vs which felt rougher.
- Any surfaces that surfaced unexpected complexity worth flagging.
- The exact list of mock data shapes generated.
- Recommendations for which integrations to tackle first when Drake green-lights the next phase (e.g., "Close is the unlock; Stripe is independent; Meta is the easiest to fake longer with manual entry").
- Anything Builder learned about Gregory's existing primitives that might be worth promoting / sharing.

---

## Reference: full transcript of the Promethean demo

Preserved here verbatim for Builder's reference. This is the source of truth for the eleven surfaces. The spec above interprets the transcript for our codebase; if any surface intent is unclear from the spec, read the transcript directly.

> Alrighty. So Promethean, basically we've got an overview section here. You can see everything from the pipeline, what's active, what's overdue. So this is with this feature called Leverage where it'll show you like if you're able to increase the close rate from 22 to even just 25%, it's going to bring an extra 40k or increase the book calls or the average order value on cash. It'll just like use AI to figure out what is going to be the best decision within your business. It'll show you revenue, cash collected, actual cash received from Stripe. So you can connect your Stripe account and it'll show you the profit. Revenue ROAs, cash ROAs acquisition cost, cost per call, true ROAs, true CAC. Everything, literally everything, every piece of data that you need automatically connects with Meta and the sales team. You can do your cost per call, cost per showed call. You can click it, it'll show you the leads. Everything down to even your cost per showed, qualified call, all applications, bit of a picture over for the month or for whatever period you've got selected daily roas, the pipeline.
>
> Now for sales reps, right, what they're going to do is end the day. So it automatically connects with the CRM you come in, it'll show you the lead delete details, you make sure it's the right country. You click the, the setter, the call outcome if you pitch them, if you won cash, lead, quality payment plans, everything, literally every little bit of data that you need.
>
> Now then triages. So if you do like a direct booking funnel, it'll basically automatically pick up on all the triages so the setters can come in and say, okay, well here's the status on, on the lead and write some notes out with something called AI mode. So you can ask it anything about the sales data, like what's, what's going to move the needle, what's working, why are we losing deals, blah, blah, blah, blah.
>
> It also show you all the contacts within the software and you can like see individual data on them. So like if you click into one of the contacts it will show you more stuff about, you know, you can even go to the recording what's happening the appointments now closes.
>
> This will show all your closer data within here you'll just see like a bit of an overview. You can go in and click a specific closer, See more stuff like if, how do we help Sebastian, like what we should do with him, what's happening, the calls, biggest deals, all this stuff right now.
>
> Setters. We got this is all automatic. So all set of data is automatic. We can see speed to lead, how long it takes for them to get to the leads. You can even click it and see the individual leads like okay well these leads haven't even been contacted. You know this lead here got called by which center, within what time frame, you can even view like which ones have never been contacted, contacted under 5 minutes, blah blah blah blah blah, direct booking triages. So if they've been confirmed, if they've actually been, been untriaged, DQ'd, whatever.
>
> Now you can also click on an individual setter. And it's going to give you a lot, a lot more detail. Pretty much anything that you need to see. You can even see down to the bookings they've done. You can see down to the dials that they've been doing from the period. So let's say like we go Saturday actually Friday. It's going to show you their dials and like the time frame that they dialed within and like what's the gap? So you know they took a 14 minute gap here, 2 minute gap here, blah blah blah blah, talk time give you a full sort of situation.
>
> Now you can also get set a qc. So this is going to use AI to quality control all the calls so you can go and press grade the conversations and it's going to give you a full AI analysis based on alpha sales frameworks on where they're at. Now you don't use it as the last bit of data, you use that to be able to see. Okay, maybe I need to go ahead and review this call personally. So it's sort of just like a, an inbound way of getting information on the setting team.
>
> Now we've got number health. This is going to show you more about like the dials, what's happening with them, like what's the health numbers they can go into marketing. It's going to show you all the individual marketing data, everything even by country deep dive. So this is a bit more of like a custom way of seeing like okay well you know we've got no show rates when the bookings most likely ghost. When are we having more most of the calls.
>
> Now we can even see like a do something called pairing matrix. Like basically the difference between centers and, and closes. so for example like let's say we want, we care about, let's say cash. Right. Got all the reps and a minimum sample, whatever you can just make this three, we need three samples to make this make sense. Right? So, like, three closed deals. All right, so we can see Sebastian, the closer, has. James, has the highest cash collector with Sebastian compared to these guys. So James, overall has the highest cash collected as a setter. But then you can see, like, Aubrey, for example, does best with Jordan. And then Aiden does best with Aubrey. Right. Aubrey does best with Aiden. Here you can just sort of see full. Full breakdown. Like, even show percentages, no shows pitch, AOV cash per show, cash per call. Average, lead quality as well. Who's booking in the specific lead quality? Who books leads that flake? No shows by country. Now, like, does the score predict the sale? So, like, how many leads that are ready to buy? Good leads, average leads, pretty much everything that you need. Money on the table. So, like, where's money sitting right now? And then, like, payment plans and cohort retention, like, a bunch more stuff. That's the main features, that we've got within Promethean so far.
