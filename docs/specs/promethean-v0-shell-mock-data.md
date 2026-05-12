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
- **Polish target: demo-able, looks like the Promethean reference screenshots.** Builder matches the visual aesthetic specified in the Design section below. This is NOT a generic dark theme — it's a specific editorial dark aesthetic with serif headlines, warm-dark backgrounds, and yellow-green accent.
- **Target branch: `promethean-shell`.** This work does NOT land on main. Builder creates the branch from main's current HEAD, builds on the branch, commits to the branch. Vercel auto-deploys preview URLs from feature branches; Drake reviews at the preview URL.
- **No backend, no Supabase queries, no API calls, no integration logic.** Every data fetch in the new code returns from `lib/mock-data.ts`. The boundary is clear: when integrations land later, the only thing that changes is the import path.
- **Auth gate stays.** Promethean is behind the same Supabase Auth gate as Gregory. Drake logs in with the same credentials. No new auth surface.
- **Route group: `app/(authenticated)/promethean/...`** so it shares Gregory's auth wrapper but is its own surface.

## Acclimatization checklist — confirm in 4-5 bullets before starting

1. Confirm you're on a fresh branch `promethean-shell` cut from `origin/main`. `git checkout -b promethean-shell origin/main`. Push the branch immediately so Vercel sees it and starts auto-deploys.
2. Read `app/(authenticated)/layout.tsx` to understand the auth-gate pattern Gregory uses. Promethean reuses it for auth but otherwise renders its own dark-themed shell — Gregory's light shell does NOT apply to /promethean routes.
3. Read `components/ui/` (shadcn primitives) and the table/pill/dropdown patterns in `app/(authenticated)/clients/clients-table.tsx`. Reuse the structural patterns (sortable table, pill component shape) but restyle for the dark editorial aesthetic. Do NOT just drop Gregory's components in with a dark-mode prop — the typography, weight, and density are different.
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

**The mock tenant.** Drake's mock tenant is named **Helios** (matches the reference screenshots, where the demo tenant was "Helios · SCALE-2"). Sidebar shows: "Promethean · LIVE" at top, then "Helios" with subtitle "HELIOS · SCALE-2" below.

## The 11 surfaces

Each surface is its own route. All under `/app/(authenticated)/promethean/`. The naming is suggestion — Builder can adapt for sensible URL slugs.

### 1. Overview — `/promethean`

Top-level dashboard. The Promethean landing page. The reference screenshot shows what this should feel like.

Components:

- **Page header**: Tenant name + "CEO VIEW" small-caps eyebrow label above. Serif headline below ("Every dollar, tracked." in the reference). Date range underneath: "Apr 12 → May 11" + "SYNCED 9:36 AM" timestamp small-caps.
- **Period selector** (top right): "All countries" dropdown + "Last 30 days" dropdown. Both pill-shaped, dark, subtle.
- **Eyebrow + headline sections** throughout the page: small-caps eyebrow label ("THIS MONTH · LIVE", "LEVERAGE") above a serif sub-headline ("Where we stand, where we're headed.", "If you fixed one thing.").
- **Top section cards**:
  - **Monthly Pace card**: Small-caps "MONTHLY PACE" label. If no target set: "Set a target to unlock pace tracking." with subtle config hint below ("Add a `Settings` tab to this client's sheet with a row: `monthly_cash_target` · `150000`"). If target set: progress bar + numbers.
  - **Live Pipeline card** (right column): Small-caps "LIVE PIPELINE" label. Big yellow-green number ($9.5K). Explainer below ("Expected cash from 107 active follow-ups, based on a historical 0.8% recovery rate."). Bottom strip with 3 sub-stats: ACTIVE / OVERDUE / AVG WHEN WON.
- **Leverage section**: 3 cards in a row.
  - Each card has small-caps top-left label (CLOSE RATE, BOOKED CALLS, CASH AOV), small-caps top-right label (#1 lever, #2 lever, #3 lever).
  - Big yellow-green delta value (+$40.2K, +$27K, +$18.1K).
  - Sub-line: "projected cash · +7 wins" / similar.
  - Progress bar showing current vs target.
  - Comparison framing: "22.3% → 25.6% halfway to Sebastian Brown's 29.0%".
  - Coaching question/insight: "Have Sebastian Brown run a tactic clinic — what objections do they handle that the rest don't?"
  - Bottom-right small lift label: "+14.9% lift on this lever".
- **Money KPI strip** (4 cards below leverage): REVENUE (CONTRACT VALUE) / CASH COLLECTED / CASH RECEIVED / PROFIT. Each shows a big number with a small delta pill top-right (▼ 43% in red-orange for negative, ▲ in yellow-green for positive).

The Overview is the most important surface for Nabeel's demo. Spend extra polish budget here.

### 2. Pipeline — `/promethean/pipeline`

[Same as before — filterable lead table with status chips, slide-over detail panel, overdue filter chip.]

### 3. Financials — `/promethean/financials`

[Same as before — but rendered in the dark editorial aesthetic.]

### 4. End-of-day lead entry form — `/promethean/setter-eod`

Note: in the reference sidebar this is called "Setter EOD". Use that naming. Otherwise as before.

### 5. Triages — `/promethean/triage-inbox`

Note: reference sidebar calls this "Triage Inbox". Use that naming.

[Otherwise as before — table + inline-edit triage status + AI Mode panel shell.]

### 6. Contacts — `/promethean/contacts`

[Same as before.]

### 7. Closers — `/promethean/closers`

The reference's second screenshot shows the per-closer detail page (Sebastian Brown). Key elements:

- **Page header**: Small-caps "CLOSER BREAKDOWN" eyebrow. Serif name headline ("Sebastian Brown"). Date range + sync timestamp.
- **KPI strip** (4 cards): SHOW RATE / PITCH RATE / CLOSE RATE / APPT → SALE. Big numbers, small delta pills top-right (red-orange ▼ for negative, yellow-green ▲ for positive).
- **Leverage section** (closer-scoped): Same pattern as Overview but with the headline "If [Name] fixed one thing." 2-3 lever cards showing what this closer specifically should improve, with peer comparison framing.
- **Outcomes section**: 4-card strip showing WON / LOST / FOLLOW UP / NO SHOWS counts.
- **Consistency section**: "Steady, or spiky." headline with metrics ACTIVE DAYS / AVG CALLS / DAY / STD DEV / CV.
- **"How do we help [Name]?"** AI coaching card with mock content. Preview badge.

The list view (`/promethean/closers`) is the leaderboard — card grid with each closer's key metrics, click to drill.

### 8. Setters — `/promethean/setters`

Top-level setter leaderboard: same card-grid pattern as closers. Per-setter detail at `/promethean/setters/[id]`:

- Same page-header pattern (eyebrow + serif name).
- KPI strip with setter-specific metrics: Dials / Speed to lead / Conversations / Bookings / Show rate.
- Dial log timeline (per-day) with visible gaps as labeled segments.
- Talk time per day chart.
- Recent calls table.

### 8b. Setter QC — `/promethean/setter-qc`

In the reference sidebar this is its own nav item ("Setter QC"). Promote to a standalone surface, not just a panel inside Setters detail.

- List view of all recent setter calls with AI grades (Green/Yellow/Red pill + 1-line summary).
- "Grade conversation" button on each row (no-op for V0).
- Filter by setter, by grade, by date.
- Click a row → detail view with the AI grading writeup (mock content). Preview badge.

### 9. Number Health — `/promethean/number-health`

[Same as before.]

### 10. Marketing — `/promethean/marketing`

[Same as before — in the dark editorial aesthetic.]

### 11. Deep Dive — `/promethean/deep-dive`

[Same as before — pairing matrix gets full polish since it's a flagship feature.]

### Additional surfaces from the reference sidebar

The screenshots show three additional surfaces beyond the original 11. Include these in V0:

- **Inbox** — `/promethean/inbox`. General inbox for notifications, alerts, action items. For V0: a list of mock notifications (deal stuck, target missed, payment failed, etc.).
- **Money on Table** — `/promethean/money-on-table` (also listed under Deep Dive as a section). Reference promotes it to a standalone surface. Same content as the Deep Dive subsection but with its own page.
- **Payment Plans** — `/promethean/payment-plans`. Table of active payment plans with progress tracking (lead, plan total, paid, remaining, next charge date, status).
- **Cohort Retention** — `/promethean/cohort-retention`. Same content as the Deep Dive subsection, promoted to its own page.
- **P&L** — `/promethean/pnl`. Profit/loss summary. KPI cards + simple breakdown table. Lives under the SALES section in the sidebar.

The expanded count is 15 surfaces, but several share components heavily. Builder may consolidate routes if natural (e.g., Cohort Retention could be a tab inside Financials).

## Sidebar navigation structure

From the reference, the sidebar is organized into labeled sections:

```
● Promethean · LIVE          [tenant pill top]
Helios
HELIOS · SCALE-2

📈 Overview
📥 Inbox
▼ Triage Inbox
✨ AI Mode

— SALES —
👤 Contacts
○ Closers
📞 Setters
🎙 Setter QC
🔢 Number Health
📋 Setter EOD

— ACQUISITION —
📊 Marketing
🔍 Deep Dive
💰 Money on Table
💳 Payment Plans
🔄 Cohort Retention
💲 P&L

— CONFIGURATION —
👤 OWNER
   thomas@heliosscale.com
   APP ADMIN
```

Sections labels are tiny small-caps. Active nav item has a left-edge yellow-green accent bar + slightly brighter text.

## Design + UX guidance

This section is detailed because matching the reference aesthetic matters more than for Gregory. Read carefully.

### Visual aesthetic — "editorial dark"

The Promethean reference is a specific aesthetic, not generic dark mode:

- **Background**: warm-dark, not pure black. Around `#0a0a0a` to `#101010` for page background. Cards slightly lighter (`#16161a` or similar). Subtle warmth — slight olive/charcoal undertone, not blue-tinted.
- **Borders**: barely visible. Either no border on cards (rely on lighter card background to separate) or very subtle 1px border at ~10% opacity.
- **Generous whitespace**. Editorial breathing room. This is the opposite of dense; let things have space.

### Typography

- **Serif headlines** for page titles and section headlines. Use a free serif via Google Fonts: **Instrument Serif**, **Fraunces**, or **GT Sectra**'s closest free analog **Lora** at heavy weights. Headlines are LARGE — 48-60px for page titles like "Every dollar, tracked.", 32-40px for section sub-headlines like "Where we stand, where we're headed."
- **Sans-serif body / labels / numerics.** Use **Inter** or system stack. Body 14-16px, labels 11-13px with `text-transform: uppercase` and `letter-spacing: 0.08em` for small-caps treatment.
- **Numeric KPIs** are LARGE and sans (Inter at 600-700 weight, 40-72px depending on importance).
- **Small-caps labels** are ubiquitous: section eyebrows ("THIS MONTH · LIVE"), card labels ("MONTHLY PACE"), sub-labels ("ACTIVE", "OVERDUE", "AVG WHEN WON"). Render as uppercase + tracked-out + slightly muted color.

### Color palette

- **Background**: `#0a0a0a` page, `#16161a` cards (suggestions; refine as needed).
- **Text primary**: near-white, slightly warm. `#f5f4ef` or similar (not pure white).
- **Text secondary**: ~60% opacity of primary. For body copy.
- **Text muted**: ~40% opacity. For small-caps labels.
- **Accent (positive)**: yellow-green. Around `#c9d92b` or `#d4e157`. Use for: positive numbers, "wins" deltas, active nav indicator, leverage card metric values.
- **Accent (negative)**: red-orange. Around `#e74c3c` or `#ff6b47`. Use for: negative deltas (▼ percentages), overdue counts, alerts.
- **Pills**: use opacity-based color tints rather than solid backgrounds. E.g., red-orange pill is `rgba(231, 76, 60, 0.15)` background + red-orange text.

### Component shapes

- **Cards**: rounded corners (8px), card background subtly lighter than page bg, padding generous (24-32px).
- **KPI cards**: large numeric, small-caps label above, optional delta pill in top-right corner.
- **Tables**: zebra-striping NO. Row separators yes, very subtle (1px at low opacity). Hover state slight background lift.
- **Pills**: rounded-full, padding `px-2 py-0.5`, small text. Color via opacity-tinted bg + matching text color.
- **Buttons**: primary uses yellow-green bg with dark text. Secondary is bordered, transparent bg. Tertiary is text-only.
- **Active nav item**: left-edge accent bar (3px yellow-green) + slightly brighter text + subtle bg tint.

### Copy voice

The reference's coaching copy is doing real work for the brand feel. For V0 mock content, write in the same voice:

- **Direct, declarative.** "Where we stand, where we're headed." Not "Dashboard Overview".
- **Question-as-coaching.** "Why does Aiden Rodriguez collect more per deal — payment plans, qualifying for full-pay, or pricing tier presented?" Not "Suggested action: review pricing strategy."
- **Specific peer comparisons.** "halfway to Sebastian Brown's 29.0%" rather than "below average."
- **Confidence + framing.** "If you fixed one thing." "Each card halves the gap to the team-best on that lever and projects the cash impact."

### Loading + empty states

- Skeleton loaders, not spinners.
- Empty states have a serif-headline one-liner ("No leads in this view.") and optional small-caps CTA below.

### Live status indicator

The top-left sidebar has a "● LIVE" pill next to the Promethean wordmark. Use a small yellow-green dot animation (subtle pulse) + LIVE small-caps text. Communicates real-time-data.

### AI feature affordances

Anywhere there's a mock LLM feature (AI Mode, coaching cards, QC grading), render a small "Preview" badge in the corner: small-caps text, yellow-green border, transparent bg. Tooltip on hover: "Demo-only. Live AI features land in V1."

### Responsive

Desktop-first. Mobile not a target for V0.

### Dark mode

Required. Light mode NOT needed.

## Hard stops

- **Do NOT push to `main`.** All work lives on `promethean-shell` branch. If something forces a main push, stop and surface.
- **Do NOT call Supabase / Anthropic API / any external service.** All data comes from `lib/mock-data.ts`. If a surface needs data that doesn't have a mock shape yet, extend the mock data file.
- **Do NOT modify existing Gregory code in ways that affect Gregory's behavior.** Touching the shared layout to add the nav switcher between Gregory and Promethean is allowed; modifying clients-table.tsx, calls list, or anything else under `app/(authenticated)/clients/` or `app/(authenticated)/calls/` is not.
- **Do NOT skip the serif headlines.** Without them the aesthetic falls apart. If a font load fails, surface — don't fall back to sans.
- **Do NOT use Tailwind's default colors literally** (zinc-900, gray-800, etc.). Build a color token palette in `tailwind.config.ts` (or use CSS variables) matching the Promethean palette specified above.
- **Do NOT add new dependencies without surfacing first.** If a chart library or component lib feels necessary beyond what shadcn/ui + recharts + a Google Fonts serif provide, stop and ask.
- **Stop and surface if a single surface exceeds ~1 hour of work.** That's the signal that surface needs scoping or simplification. Don't grind for 3 hours on Pipeline because the slide-over is hard.

## What could go wrong

- **The aesthetic doesn't quite match the reference.** Likely on first pass. The fix is iteration after Drake sees it — don't grind for 4 hours trying to nail the serif weight. Get it 80% there in V0; Claude Design or a polish pass closes the gap.
- **The 11+ surfaces have inconsistent visual treatment by the end.** Mitigation: build the design primitives (cards, KPI strip, tables, page header pattern with eyebrow+serif, leverage card, KPI delta pill) FIRST as a shared library inside `components/promethean/`. Every surface composes from these primitives. The primitives lock the visual direction.
- **Mock data shape doesn't match what real queries will return.** Mitigation: name the types in `mock-data.ts` to match what the eventual Supabase schema would produce. E.g., a `Lead` type whose fields map 1:1 to columns in a future `promethean.leads` table. The swap is then literally `import { LEADS } from '@/lib/mock-data'` → `import { fetchLeads } from '@/lib/db/promethean'` with the same return shape.
- **AI feature shells are confusing without "Preview" badges.** Mitigation already specified — every mock LLM surface gets the badge + tooltip.
- **Drake wants more / different / fewer features after seeing V0.** Expected. This whole exercise is to surface that feedback fast. V0 is a learning vehicle, not a final deliverable.
- **Build time runs long.** Real possibility — 15 surfaces at any quality is real work. If Builder hits ~4 hours and is at 10-12 surfaces complete, that's a great result. If at ~6 hours and stuck on surface 3, stop and surface.
- **Vercel preview deploy fails because of a build error.** Build clean before pushing. `npm run build` locally before every commit on this branch.

## Mandatory doc updates

- **`docs/state.md`** — append a single entry under a new "Promethean V0 exploration" section noting that this shell was built on `promethean-shell` branch on 2026-05-11/12, what's included, what's mocked, and Drake's evaluation outcome (filled in when Drake reviews).
- **No CLAUDE.md change.** This is exploratory, not part of the canonical Director/Builder rhythm yet.
- **No new runbook.** The integrations-later spec will spawn its own runbook when Drake decides to proceed.
- **Optional: README.md inside `app/(authenticated)/promethean/`** explaining that this is V0 with mock data, where the data lives, and how to swap to real queries.

## Commit + report

Per CLAUDE.md § Commits, one logical change per commit. Suggested batched commits:

- `promethean: scaffold route group, dark layout, nav switcher`
- `promethean: add tailwind tokens + Google Fonts serif for editorial aesthetic`
- `promethean: add mock-data.ts with realistic seeded Helios data`
- `promethean: build shared design primitives (page header, KPI card, leverage card, delta pill, sidebar nav)`
- `promethean: implement Overview surface`
- `promethean: implement Pipeline surface`
- `promethean: implement Financials surface`
- `promethean: implement Setter EOD form`
- `promethean: implement Triage Inbox surface with AI Mode shell`
- `promethean: implement Contacts + detail surfaces`
- `promethean: implement Closers + per-closer detail surfaces`
- `promethean: implement Setters + per-setter detail surfaces`
- `promethean: implement Setter QC surface`
- `promethean: implement Number Health surface`
- `promethean: implement Marketing surface`
- `promethean: implement Deep Dive surface with pairing matrix`
- `promethean: implement Inbox + Money on Table + Payment Plans + Cohort Retention + P&L surfaces`
- `docs: note Promethean V0 shell exploration in state.md`
- `docs: add report for promethean-v0-shell-mock-data`

Bundle commits where natural; the principle is one logical change.

Report at `docs/reports/promethean-v0-shell-mock-data.md`. Include:

- The Vercel preview URL for the `promethean-shell` branch.
- Total session time (approximate).
- Which surfaces shipped at "matches the reference aesthetic" quality vs which felt rougher.
- Any surfaces that surfaced unexpected complexity worth flagging.
- The exact list of mock data shapes generated.
- Recommendations for which integrations to tackle first when Drake green-lights the next phase (e.g., "Close is the unlock; Stripe is independent; Meta is the easiest to fake longer with manual entry").
- Anything Builder learned about Gregory's existing primitives that might be worth promoting / sharing.
- Screenshots or descriptions of how closely the Overview surface matches the reference.

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
