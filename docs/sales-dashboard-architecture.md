# Sales Dashboard — Architecture & Code Map

**Purpose.** A navigation map of the sales-dashboard surface for any new Claude
instance. It records how the code is structured, where the data comes from, the
non-obvious matching logic, and — most importantly — the **environment/ops traps**
that cost real time to discover. It is intentionally uneven: sections we worked
through (leads, the funnels, ingestion of the closer/confirmation forms,
Calendly↔lead matching) are deep; sections we only know *exist* (ads, revenue,
trajectory) are sparse stubs for a future instance to fill in.

Companion docs:
- `docs/runbooks/sales_dashboard.md` — the v1 metric catalog, LIVE/PENDING/NOT-CONNECTED
  state semantics, v2 hero/sidebar restructure, and the per-feature wiring notes.
- `docs/runbooks/apply_migrations.md` — cloud migration apply + dual-verify procedure.
- `docs/decisions/0003*` — timezone conventions (store UTC, render ET).

---

## ⚡ CONTINUATION — START HERE (handoff 2026-05-30, sales-dashboard sprint)

> **2026-05-31 UPDATE:** A large amount has shipped since this 05-30 handoff.
> **(1)** The reactivation funnel/status plan (§ 5) is fully BUILT — all 5 steps
> shipped. **(2)** Connected is now a form-OR-call signal and every funnel box is
> cumulative/monotonic; the per-lead page gained a two-phase Journey (Direct →
> Reactivation). **(3)** A page RESTRUCTURE landed: the stacked funnel moved to
> the **Funnel page** (renamed from Pulse), its stages link into a filtered Leads
> roster (type/stage filter — see § 1 › Funnel → Leads filter), the sidebar
> flattened to **Funnel/Leads/Talent** (no sub-bars; "Talent" is the People page renamed — route stays /people; the Calls list page was removed — per-call review pages are reached from the per-lead Lifecycle), and the
> Appointment-Setting/Closing/Revenue routes were removed. Read **§ 1** for the
> current routing/filter model and **§ REACTIVATION & LEAD FUNNEL** (bottom) for
> the reactivation logic. The 05-30 section just below is now mostly historical
> (it still describes the funnel as living on /leads — it no longer does).
>
> **For the full late-session detail (the "connected" model, the form Call-Status
> values, the shared funnel predicate, the per-lead Journey + day-grouped
> Lifecycle, the FMR rewrite, the funnel integrity guard, and the CEO missing-form
> flags) read the LAST section: § DEEP REFERENCE (2026-05-31, late session) at the
> very bottom of this doc.** It is the most current and most detailed.

A fresh instance picks up here. This captures a long working session so you can
continue cold. Read this whole section, then §0 (traps), then dive in.

### How we work — IGNORE CLAUDE.md's process machinery
**Disregard the entire Director/Builder workflow in CLAUDE.md** — the specs in
`docs/specs/`, reports in `docs/reports/`, ADRs, the four-gate ceremony, "Builder
pulls a spec," EOD cleanup, all of it. For this sales-dashboard work Drake and I
work **directly and iteratively**:
- Drake describes what he wants in plain language, often **refining mid-stream**
  (he'll interrupt to add/change requirements — roll with it).
- I build it, **verify** with `npx tsc --noEmit`, `npx next lint --file <paths>`,
  and `npm run build`, then `git add` + `git commit` + `git push origin main`
  **straight to main** (Vercel auto-deploys). No specs, no reports, no asking
  permission to push.
- I **surface genuine ambiguities or landmines BEFORE building** (Drake explicitly
  values honest pushback — e.g. the utm_term unique-mapping trap, the "latest form
  un-sets showed" edge case). For clear directives, just execute.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` (strip
  "(1M context)").
- Migrations are the one careful path — see §0.2.
- The stack is Next.js 14 (TS, server components) + Supabase (Postgres). Styling
  uses `geg-*` classes + `var(--color-geg-*)` tokens (see `app/globals.css`).

### What shipped this session (all live on main)
1. **Calendly→lead matching via utm_term token** (`lib/db/calendly-lead-match.ts`)
   — a per-lead `aaid_<uuid>` in `calendly_invitees.raw_payload.tracking.utm_term`
   == `close_leads.utm_term`. **Unique-mapping guard is mandatory** (generic terms
   like "Broad" map to thousands of leads). Used as the primary key (then
   email/name) in directBooked + the closer drill.
2. **New closer form ingestion** — migration **0062** added `call_outcome` +
   `form_type` (New|Old) + ~21 plan/payment columns to `airtable_full_closer_report`;
   `parse_full_closer` maps them; live via webhook + cron. The form redesigned
   around a single **`Call Outcome`** disposition.
3. **Closer drill** (`/funnel/closed`, `funnel-closing.ts` + `closer-tables.tsx`)
   reads new-form `call_outcome` for Showed/Closed/Upfront/Setter. `pickForm`
   selects the form per lead: **New over Old, then newest `airtable_created_at`**.
4. **/leads booking funnels** — three mutually-exclusive boxes by `bookingType`
   (which Calendly links the lead EVER had): **direct** (direct-only) / **setter**
   (partnership-only) / **reactivation** (both — a direct lead a setter re-booked).
   Direct has a Confirmed stage; the others don't. Showed/Closed are **per-lead**
   from the new closer form. Roster shows a per-lead booking tag.
5. **Per-lead page** (`/leads/[close_id]`, `lib/db/lead-detail.ts` +
   `[close_id]/page.tsx`): a header (qualified, opt-in dates, **Stage** chip-funnel,
   dials, connected count+duration, reschedules, follow-ups, caller) + a
   **lifecycle timeline** (newest-first, scoped from latest opt-in). Bookings
   matched to the lead by email + name + **unique utm_term token**.
6. **Lead search bar** (`?q=`, `lead-search.tsx` + `lib/db/lead-search.ts`) — search
   any lead by name → per-lead page.
7. **Lifecycle fixes** — "Opted in" anchor, **booked-by** (setter from the preceding
   connected call), and **dedup** of duplicate closer forms (same call within 90min,
   keep latest submission).

### 🎯 THE NEXT TASK — Option A: absorb dispositions into the lifecycle
The lifecycle currently shows form dispositions as **separate floating rows**, which
reads disjointed. Drake chose **Option A**: absorb each form disposition INTO the
call or booking it describes.
- **Triage outcomes** (`airtable_setter_triage_calls.call_status`: e.g.
  `Confirmed Booked with Closer`, `Setter pipeline / Follow up`, `High Ticket
  booking`, `DQ / Un-interested`) = the result of a **connected call** (the setter's
  triage call). Show inline on the connected-call row:
  `Connected call · {caller} · {duration} → {outcome}`.
- **Closer outcomes** (`airtable_full_closer_report` form_type=New `call_outcome`:
  `High Ticket Closed` / `Digital College Closed` / `Deposit` / `Short-Term Follow
  Up` / `Long-Term Follow` / `Client Ghosted (no show)` / `Call Rescheduled` / `Call
  Cancelled` / `DQ / Bad Fit`) = the result of a **booked meeting**. Show on/under
  the **Booked** row.
- For **direct** bookings: also show **Confirmed** (from the confirmation form =
  `airtable_setter_triage_calls` `form_type='Closer Triage Form'`, `call_status`
  starting "Confirmed"). Direct should read Booked → Confirmed → Showed → Closed.
- **Matching:** time-proximity within a **±48h window** — mirror the closer drill's
  `matchForm` / `pickForm` in `funnel-closing.ts` (prefer New form, newest
  submission). A form that doesn't match any call/booking **falls back to its own
  row** (don't drop it).
- Build it in `lib/db/lead-detail.ts` (the timeline assembly, step 8) + the render
  (`EventBody` in `[close_id]/page.tsx`). Connected/booking timeline events gain an
  optional `outcome`/`confirmed` field.

**OPEN — confirm with Drake at the very start of the next session:** for **direct**,
does the Booked row **accumulate inline** (one evolving row: `Booked → Confirmed →
Showed → Closed`) or stay as a Booked row with Confirmed/Showed/Closed as separate
rows beneath it? Drake hasn't decided. Ask before building.

### Other open decisions / refinements noted (not blocking)
- **Booking timestamp** is the call's `start_time` (so a Booked row sits next to its
  outcome), not `event_created_at` (when they actually booked). Revisit if Drake
  wants the booking shown at book-time.
- **Header scoping:** dials/connected are scoped from latest opt-in; bookingType,
  reschedules, follow-ups are all-time. Could journey-scope the latter.
- **Lead search** is name-only. Email/phone need a jsonb query on
  `close_leads.contacts`.
- **Funnel Showed/Closed + reactivation/setter stages read ~0** until real New
  closer forms with REAL `lead_id`s flow in. Drake's test forms used placeholder
  lead_ids ("1234"); real ones (e.g. Colton, `lead_fK6V…`) work.
- **`.env.local` active `SUPABASE_URL` = local (stale)** — Drake should refresh the
  local DB or repoint so local dev/diagnostics match prod (see §0.1). It cost real
  time this session.

### Files for the per-lead / funnel work
- `lib/db/lead-detail.ts` — `getLeadDetail` (header + timeline). **THE file for
  Option A.**
- `app/(authenticated)/sales-dashboard/leads/[close_id]/page.tsx` — per-lead render
  (`EventBody` = the timeline row renderer). **THE render file for Option A.**
- `lib/db/funnel-closing.ts` — closer drill: `deriveNewOutcome` (call_outcome →
  showed/closed), `matchForm`/`pickForm` (form↔booking matching to MIRROR),
  `buildSetterNameResolver` (Airtable rec-id → name), `buildBookedByResolver`.
- `lib/db/leads.ts` — `getLeadsForRange`: `bookingType`, `confirmed/showed/closed`,
  `outcomeShowed`/`outcomeClosed`.
- `lib/db/calendly-lead-match.ts` — utm_term resolver (+ unique guard).
- `lib/db/lead-search.ts` / `leads/lead-search.tsx` — search.
- `app/(authenticated)/sales-dashboard/leads/page.tsx` — roster + funnels + search.

Event-link cheat sheet: **direct** = `DIRECT_BOOKING_EVENT_TYPE_URI`
("Ai Partner Strategy Call", in `funnel-calendly.ts`); **setter** = event name
starts `"partnership call w/"`; **sync/follow-up** = `"AI Partner Sync"`.

---

## 0. READ THIS FIRST — the traps (environment & ops)

These are the things that are NOT obvious from the code and that will waste your
time or mislead you if you don't know them.

### 0.1 `.env.local` points at LOCAL Supabase by default
The **active** (uncommented) `SUPABASE_URL` is `http://127.0.0.1:54321` (a local
Docker Supabase stack) and `SUPABASE_SERVICE_ROLE_KEY` is the local key. The
**cloud/production** project (`sjjovsjcfffrftnraocu.supabase.co`) is on the
**commented** lines just below each.

- The local DB is a **stale snapshot** — today it was missing `form_type` /
  `call_status` columns and confirmation-form rows, had 33 triage rows vs cloud's
  179, and 538 closer rows vs cloud's 80. **It will lie to you.**
- A naive diagnostic that grabs the first `SUPABASE_URL=` match hits LOCAL.
  **To probe cloud**, grab the `https://` URL and the **commented** (`#`-prefixed)
  service-role key:
  ```python
  url = re.search(r'^#?\s*SUPABASE_URL=(https://\S+)', text, re.M).group(1)
  key = re.search(r'^#\s*SUPABASE_SERVICE_ROLE_KEY=(\S+)', text, re.M).group(1)
  ```
- The deployed app (Vercel) uses the cloud project via its own env vars, so
  **app code is always running against cloud** — only your local diagnostics are
  at risk of hitting the stale local DB.

### 0.2 Migrations: local Docker is running → `supabase db push` misroutes
A local Supabase Docker stack is up on this machine. Supabase CLI v2.90.0
**silently misroutes `db push --linked`** when both a linked cloud project AND a
reachable local Docker stack exist (the 2026-04-28 bug). Do **not** stop the
user's local stack. Apply via **psycopg2 direct against the pooler** instead:
- Connection: `supabase/.temp/pooler-url` + `SUPABASE_DB_PASSWORD` from `.env.local`
  (see `docs/runbooks/apply_migrations.md` for the exact connection boilerplate).
- After `ALTER`/`CREATE`, **manually insert the ledger row**:
  `insert into supabase_migrations.schema_migrations (version, name, statements)
  values ('00NN', '<name>', ARRAY[<sql>])`.
- **Dual-verify** (required, never single-query): schema reality
  (`information_schema.columns` / `to_regclass`) AND ledger (`schema_migrations`).
  Plus a pre/post `count(*) from information_schema.tables` drift check for
  non-CREATE-TABLE migrations.
- **Migrations are still gated** — Drake reviews the SQL diff before apply.

### 0.3 HTTP/2 `ConnectionTerminated` on the Python client
The python `supabase`/httpx client drops streams against the pooler after a few
sequential queries (`ConnectionTerminated, last_stream_id:3`). It's transient —
retry with a fresh client or split into fewer/standalone queries. The production
TypeScript client (`@supabase/supabase-js` over fetch) does **not** hit this; it's
a python-diagnostic-only annoyance. The Airtable ingestion mitigates the same
issue in `_upsert_batch` (retry once with a fresh client).

### 0.4 Use the Airtable Metadata API to read form options — don't guess
Don't ask the user to fill test forms to discover field options. Pull the live
schema (all tables, fields, single/multi-select choices):
```python
from ingestion.airtable.client import AirtableClient
AirtableClient.from_env().get_base_schema()   # needs AIRTABLE_SALES_PAT, scope schema.bases:read
```
Sales base id: `appCWa6TV6p7EBarC`. Closer form table: `tblYsh3fxTpXuPdIW`
("Full Closer Report Form"); triage/confirmation table: `tblaoMsiE3FSkHjQt`
("Triage Calls EOC Form").

### 0.5 Timezone — store UTC, render ET (ADR 0003)
All timestamps are stored UTC and rendered in `America/New_York`. Cohort windows
are ET calendar days. Use the shared helpers (`lib/time/est-periods.ts`,
`lib/db/funnel-window.ts`); don't hand-roll TZ math.

### 0.6 Soft-hide (`excluded_at`) is creator-only and survives re-sync
Several mirror tables have an `excluded_at` (+ `excluded_by`) column for a
creator-only "× hide test row" action: `close_leads`, `calendly_scheduled_events`,
`airtable_setter_triage_calls`. Queries that should drop test rows filter
`excluded_at is null`. The Airtable/Calendly parsers never write this column, so a
hidden row stays hidden across re-syncs. Not every surface filters it — check.

---

## 1. Page topology (routes)

All under `app/(authenticated)/sales-dashboard/`. Server components by default;
`force-dynamic`. The left sidebar (`sidebar.tsx`, a client component for
`usePathname()`) renders only under `/sales-dashboard/*`.

**2026-05-31 restructure.** The sidebar is now four flat items, no sub-bars:
**Funnel · Leads · Talent** ("Talent" = the People page, route still /people). The Calls list page is gone. The stacked Total/Direct/Setter/Reactivation
funnel moved off `/leads` onto the **Funnel page** (`/sales-dashboard/funnel`);
its stage nodes link into the Leads roster pre-filtered (see § Funnel → Leads
filter below), the Total adspend node → the Ads page, and a header link → the
Landing Pages page (those two links are why Ads/LP left the sidebar). The
Appointment-Setting, Closing, and Revenue **routes were removed** (appt/closing
are covered by People + the funnel→leads drill; Revenue is slated for a future
CEO tab). The `_components/` (PerRepCallActivityTable, CloserScheduledTables) +
`actions.ts` + `rep-link.tsx` under the deleted appt-setting/closed folders stay
colocated — the Talent (People) page still imports them. `lib/db/funnel-stages.ts`
was trimmed to just `resolveFunnelRange` (the dead `getFunnelActivity` + its
FunnelBox/PulseTile types/helpers were removed when the activity-box Funnel page
went away).

| Route | What it is | Depth today |
|---|---|---|
| `/sales-dashboard` | Redirects → `/sales-dashboard/funnel` | n/a |
| `/sales-dashboard/funnel` | **Funnel** — the stacked Total/Direct/Setter/Reactivation funnel; stages link to filtered Leads | **deep** |
| `/sales-dashboard/[section]` | Dynamic section router → `SectionId` or 404 (not in nav) | not touched |
| `/sales-dashboard/leads` | **Leads roster** + filter bar (type/stage) + speed-to-lead + FMR (both now window/filter-scoped to the same cohort) | **deep** |
| `/sales-dashboard/leads/[close_id]` | **Per-lead detail** — facts + two-phase Journey + form-driven lifecycle | **deep** |
| `/sales-dashboard/funnel/landing-pages` | Landing-page metrics (Clarity) — reached from the Funnel header link | not touched |
| `/sales-dashboard/funnel/ads` | Ad metrics (Meta) — reached from the Funnel adspend node | **sparse — see §7** |
| `/sales-dashboard/people` | Per-rep views (Call Activity, per-closer scheduled, bookings, cash) | **deep** |
| `/sales-dashboard/calls/[close_id]` | Per-call transcript/review detail. Reached from the per-lead Lifecycle; back link = "← Back to lead" via `?lead=`. (The Calls LIST page was removed.) | medium |
| `/sales-dashboard/states`, `/trajectory` | reference / trend surfaces (not in nav) | not touched |

### Funnel → Leads filter (2026-05-31)

The Funnel page's stage nodes are links to `/sales-dashboard/leads?type=<t>&stage=<s>`
(+ the window's `start`/`end`). The Leads page reads them and filters the roster;
the filter bar (`leads-filter-bar.tsx`) also sets them manually. Contract:

- **`type`** (multi, comma-sep): `direct` | `setter` (a.k.a. opt-in) | `reactivation`.
  **`direct` INCLUDES reactivation** — a reactivated lead is still originally a
  direct booking (reactivation ⊂ direct), so clicking *Direct · Showed* surfaces
  reactivated-showed leads too. `reactivation` is the post-handover subset;
  `setter` is everyone who never booked the strat link. Empty = all (Total).
- **`stage`** (single): `connected` | `booked` | `confirmed` | `showed` | `closed`.
  **Cumulative — "latest stage reached", not current stage.** Selecting `showed`
  includes closes (they reached it). Because it's cumulative, multi-select makes
  no sense — you pick the lowest stage you care about. `confirmed` is direct-only.
- **Single source of truth:** `reachedStage(row, type, stage)` + `matchesType` +
  `matchesLeadFilter` in `lib/db/leads-funnel.ts`. The funnel box COUNTS and the
  roster FILTER both go through it, so a bar's number equals the roster it opens.
- **"Connected" = one definition everywhere (`row.connectedEffective`, set in
  `leads.ts`):** raw connect evidence (`row.connected` = a ≥90s dial OR a setter
  triage form OR a confirmation that reached the lead — *every* Closer-Triage
  Call Status EXCEPT `Unresponsive – Setter Handover`, the only no-answer
  outcome; `Setter pipeline / Follow up` counts) **OR** a setter/reactive booking
  (`hasPartnership`) **OR** a show/close. A **pure self-booked direct booking is
  NOT a connection** — so in the **Total** funnel **Books can exceed Connected**
  (intended). Setter + Reactivation bookings DO count as connected (booking them
  took a conversation). The Direct box keeps its own connected (direct-phase
  signal only; a direct booking still isn't a connect). The roster column,
  per-lead header, speed box, and Total funnel all read `connectedEffective`.
  In the per-lead **Journey**, Connected surfaces in the LATEST lane (the
  Reactivation segment for a reactivated lead — a DQ always implies a connect —
  the Direct segment otherwise).
- **Integrity guard:** `validateFunnel` (leads-funnel.ts) runs inside
  `getLeadsFunnel` and the Funnel page shows a red banner if any invariant
  breaks — per-lead-once (no duplicate cohort rows), per-box monotonicity (Total
  exempt on Books>Connected), Direct+Setter partition the cohort, Reactivation ⊂
  Direct. Always-on; clean = no banner.
- The per-lead **Back to leads** button preserves the full window+filter via a
  `ret` querystring carried on each row link.

---

## 2. Data model — the mirror tables that feed the dashboard

Source of truth is Supabase; everything is a mirror of an external tool. Key
tables and their load-bearing columns / gotchas:

### `close_leads` (Close CRM lead mirror)
- PK `close_id` (`lead_xxx`). `display_name`, `contacts` (jsonb: emails/phones).
- Opt-in: `date_created`, `date_first_opted_in` (date), `latest_opt_in_date` (tstz),
  `number_of_opt_ins`.
- `marketing_qualified` (Yes/No) — the canonical qualified flag.
- `direct_call_booked` (Yes/No) — Close's own direct-booking flag.
- **`utm_term`** — carries the per-lead ad token (`aaid_<uuid>`). **Also** carries
  generic ad-targeting terms ("Broad" = 2,591 leads) — see §4.2. This is the join
  key to Calendly bookings.
- `confirmed_booking`, `showed`, `closed` exist but are **sparsely/unreliably
  filled** (`closed` was all "No") — prefer the Airtable forms for outcomes.
- `excluded_at` soft-hide.

### `close_calls` (Close call-activity mirror)
- `close_id` (PK), `lead_id`, `user_id`, `activity_at`, `duration` (seconds),
  `direction` (inbound/outbound), `raw_payload` (has `user_name`, phone).
- **Connected = `duration >= 90`** (the `FMR_DIAL_CONNECTED_SEC` convention).

### `close_lead_status_changes`
- Lead status transitions; used to derive a lead's *initial* status for cohort
  qualification.

### `calendly_scheduled_events` / `calendly_invitees`
- Event: `uri` (PK), `name`, `event_type_uri`, `start_time`, `host_user_name`,
  `status`, `excluded_at`.
- Invitee: `event_uri`, `name`, `email`, `no_show`, `raw_payload`
  (`tracking.utm_term` = the aaid token; `text_reminder_number` + Q&A = phone).
- **Direct booking** = `event_type_uri === DIRECT_BOOKING_EVENT_TYPE_URI` (the
  exact "Ai Partner Strategy Call" link). **Setter-led** = event name starts
  `"partnership call w/"`. (`lib/db/funnel-calendly.ts` holds the URI constant.)
- Calendly is the **spine** of the closer drill — bookings show before any form
  exists.

### `airtable_setter_triage_calls` (Airtable "Triage Calls EOC Form")
- ONE table, **two form types** via `form_type`:
  - `'Setter Triage Form'` — the setter's triage/qualification call.
  - `'Closer Triage Form'` — the **confirmation call** for **direct bookings**
    (almost always Aman; he calls his own direct bookings). This is where
    "confirmed booking" lives.
  - (Older rows have `form_type` NULL — pre-redesign.)
- `call_status` — the disposition (the field the dashboard reads). On confirmation
  forms the 4 real values are `Confirmed Booking`, `Confirmed <different time>`,
  `DQ / Bad Fit`-style, `Setter pipeline / Follow up`. (Some rows show
  `High Ticket booking` from a `form_type` backfill — ignore; match `call_status`
  starting with `"Confirmed"`.)
- `lead_id`, `setter_record_ids`, `setter_names`, `confirmed_call_date_time`,
  `excluded_at`.

### `airtable_full_closer_report` (Airtable "Full Closer Report Form", US + AUS via `region`)
- The closer EOC form. **Redesigned ~2026-05-30** around a single disposition:
  - `form_type` (`New` | `Old`) — filter to `New` for the redesigned form.
  - `call_outcome` — 9 values driving showed/closed/rescheduled (see §5.3).
  - Migration **0062** promoted ~23 disposition/plan/payment fields to typed
    columns; the long tail stays in `fields_raw`. See
    `docs/schema/airtable_full_closer_report.md`.
- **Trap:** the new form dropped the `Name (from Setter Name)` lookup, so
  `setter_names` is empty on new rows — only `setter_record_ids` survive. Resolve
  id→name from other (id,name) pairs (see §4.3).
- Two competing "cash paid today" fields: `amount_paid_today_currency` (old) vs
  `amount_paid_today_number` (new). The new form uses the latter.

### `setter_call_transcripts` / `setter_call_reviews`
- Transcription (Deepgram) + Sonnet review of setter calls, keyed by
  `close_call_id`. Reviews exist only for transcribed ≥90s setter calls since the
  2026-05-24 horizon — so many calls have no review. Review fields:
  `lead_score`, `should_be_dqd`, `booked`, `sentiment`, `setter_strengths[]`,
  `setter_weaknesses[]`, `lead_attributes[]`, etc.

### v2 metric sources (not deep today)
`meta_*` (ads), `clarity_*` (landing pages), `wistia_*`, `typeform_responses` —
feed the v1 metric catalog. See `docs/runbooks/sales_dashboard.md`.

---

## 3. Data-layer modules (`lib/db/*`)

| Module | Responsibility | Key exports |
|---|---|---|
| `funnel-appointment-setting.ts` | **The cohort spine** + per-rep call activity | `getSpeedToLeadCohort`, `getCallActivityMetrics`, `getCallActivityForUser` |
| `leads.ts` | Leads roster — wraps the cohort + qualified + directBooked + directConfirmed | `getLeadsForRange`, `LeadRow` |
| `lead-detail.ts` | Per-lead page data (facts + calls + reviews) | `getLeadDetail` |
| `funnel-closing.ts` | Closer drill (Calendly events → forms → outcomes) | `getClosingScheduledList` |
| `funnel-calendly.ts` | Direct-booking event aggregation; `DIRECT_BOOKING_EVENT_TYPE_URI` | `loadDirectEvents` |
| `calendly-lead-match.ts` | utm_term → close_id resolver (unique-mapping-only) | `buildCalendlyLeadResolver`, `inviteeUtmTerm` |
| `setter-calls.ts` | Setter-call list + detail (transcript + review) | `listSetterCalls`, `getSetterCallById` |
| `funnel-window.ts` / `funnel-stages.ts` | ET date-range resolution | `resolveFunnelRange`, `parseEtDateString` |
| `sales-dashboard.ts` / `sales-dashboard-shared.ts` | v2 metric catalog + fetchers | `getHeroMetrics`, `METRICS`, `HERO_*` |

Components of note:
- `funnel/appointment-setting/_components/sortable-tables.tsx` — the speed-to-lead
  lead list + per-rep drill (client component, column-sortable).
- `funnel/closed/_components/closer-tables.tsx` — the per-closer aggregate + drill.
- `components/sales/metric-card.tsx` — the v2 catalog card primitive.

---

## 4. Cross-cutting logic (the non-obvious bits)

### 4.1 The cohort spine — `getSpeedToLeadCohort`
The single source for "which leads are in this window." Used by **both** the
`/leads` roster (`getLeadsForRange`) and the appointment-setting lead list, so they
can't drift. Cohort = **new opt-ins** (account created in window with a qualifying
initial status) **∪ re-opt-ins**.
- **Re-opt-in** = `date_first_opted_in < window-start` AND `latest_opt_in_date`
  in window. Speed-to-lead for re-opt-ins anchors to `latest_opt_in_date`, not
  account creation. Each cohort row carries `optInType: 'new' | 'reoptin'`.
- The row also carries (added today) `totalConnectedDurationSec` +
  `connectedCallCount` (sum/count of the lead's ≥90s outbound calls).

### 4.2 Calendly → Close lead matching via `utm_term` (`calendly-lead-match.ts`)
Bookings carry a per-lead token `aaid_<uuid>` in
`calendly_invitees.raw_payload.tracking.utm_term`, mirrored onto
`close_leads.utm_term`. So the join is `utm_term ↔ utm_term → close_id`.
- **CRITICAL guard — unique mapping only.** `utm_term` is overloaded: most leads
  carry a generic ad-targeting term ("Broad" = 2,591 leads, dated campaign labels)
  shared across thousands. The resolver keeps **only** terms mapping to exactly
  ONE lead; shared terms → ambiguous → dropped. Matching on a shared term would
  mis-attribute a booking to a random one of thousands. Never remove this guard.
- Used as the **primary** key (ahead of email/phone/name fallbacks) in
  `leads.ts` `directBooked` and across `funnel-closing.ts` (event→lead collapse,
  setter attribution, event→form match).
- Coverage grows over time; ~20% of historical bookings have a token. The durable
  fix for full coverage is the booking-link config injecting the real `lead_id` —
  an ops change, not code.

### 4.3 Setter id→name resolution (`funnel-closing.ts` `buildSetterNameResolver`)
The new closer form carries Setter as record-ids only. Resolve id→name by learning
every `(record_id, name)` pair the mirror already has: closer forms'
`closer_record_ids ↔ closer_names` + `setter_record_ids ↔ setter_names`, and triage
forms' setter pairs. (E.g. `rec7Tncd → Jan`, `recJOyLZQbcjtqsM0 → Aman`.) The
person is usually a closer somewhere, so they resolve.

### 4.4 Direct vs setter call type
Always from **Calendly** (the event link), never from a form: direct =
`DIRECT_BOOKING_EVENT_TYPE_URI`; setter-led = name starts `"partnership call w/"`.
The closer form's own setter==closer can corroborate but is not the source.

---

## 5. The booking funnel (Booked → Confirmed → Showed → Closed)

Two funnels exist conceptually — **Direct bookings** and **Setter-led bookings**.
Direct is wired; setter-led is scaffolded.

### 5.1 Booked
`directBooked` (leads.ts) = the lead has an "Ai Partner Strategy Call" Calendly
booking ever (matched by utm_term → email → name).

### 5.2 Confirmed (direct)
A direct booking whose **confirmation form** confirmed it: an
`airtable_setter_triage_calls` row with `form_type = 'Closer Triage Form'` matched
by `lead_id`, whose `call_status` starts with `"Confirmed"`. The form is the sole
decider — **no ≥90s call gate** (a sub-90s confirmation call still files a form).
`directConfirmed = directBooked && <confirmed form>` (monotonic: Confirmed ≤ Booked).

### 5.3 Showed / Closed — from `call_outcome` (closer drill, `funnel-closing.ts`)
For `form_type = 'New'` closer forms, `deriveNewOutcome(call_outcome)` maps the 9
outcomes:

| Call Outcome | Showed | Closed |
|---|---|---|
| High Ticket Closed | yes | yes (ht) |
| Digital College Closed | yes | yes (dc) |
| Deposit | yes | **deposit** (own state, NOT a close) |
| Short-Term Follow Up | short_follow | no |
| Long-Term Follow | long_follow | no |
| DQ / Bad Fit | yes | no |
| Client Ghosted (no show) | no | no |
| Call Rescheduled | reschedule | no |
| Call Cancelled | no | no |

- **Upfront** = `amount_paid_today_number ?? _currency`; for a Deposit, the
  `deposit_amount`.
- Old (`form_type != 'New'`) rows keep legacy `showed`/`closed`/`payment_plan_type`.
- Aggregate "showed" = `yes` + the two follow-ups; "closed" = full closes only
  (deposit excluded); upfront sums incl. deposits.

### 5.4 Where the funnel renders
Today the Booked + Confirmed counts render on the `/leads` page booking-funnel
boxes (`leads/page.tsx` `BookingFunnels`). Showed/Closed are wired into the closer
**drill** (`funnel/closed`) per-row; the `/leads` funnel-box Showed/Closed stages
are still pending (next task).

---

## 6. Ingestion (how data lands, and "live")

- `ingestion/airtable/` — mirrors the sales base (`appCWa6TV6p7EBarC`).
  `client.py` (PAT `AIRTABLE_SALES_PAT`), `parser.py` (`parse_setter_triage`,
  `parse_full_closer`), `pipeline.py` (`_upsert_batch` upserts the **full** parsed
  dict — no column whitelist, so a new parser key + an existing column = it lands).
  Live path = a Vercel webhook receiver + a 15-min cron, both running the same
  parser. **Sequencing rule:** apply a column migration to cloud BEFORE deploying a
  parser that writes it, or ingestion errors on the missing column.
- `ingestion/calendly/`, `ingestion/close/`, `ingestion/meta/`, `ingestion/clarity/`,
  `ingestion/typeform/`, `ingestion/wistia/` — the other mirrors (see each module's
  runbook).
- Every field is always in the `fields_raw` jsonb catch-all even if not promoted
  to a typed column — "ingest it all" is satisfied by `fields_raw`; typed columns
  are just for direct queryability.

---

## 7. Surfaces NOT worked on today (sparse — future fill-in)

These are known to exist but were not touched; a future instance should expand
these with the same depth as §1–§6.

- **Ads** (`/funnel/ads`) — Meta ad-spend metrics via the `meta_*` mirror (Cortana
  → Google Sheet → Supabase, 3-hour cron). Location of the ads page in the future
  3-page layout is TBD (Drake undecided).
- **Landing pages** (`/funnel/landing-pages`) — Microsoft Clarity metrics.
- **Revenue** (`/revenue/*`) — profit / future / new-cash / expenses / refunds.
- **States / Trajectory** — reference + trend surfaces.
- **v2 metric catalog** — the LIVE/PENDING/NOT-CONNECTED card system on the
  overview + `[section]` pages. Fully documented in
  `docs/runbooks/sales_dashboard.md`; not re-covered here.

---

## 8. Future vision (Drake, 2026-05-30)

The dashboard converged on this shape (shipped 2026-05-31):
1. **Funnel** (`/sales-dashboard/funnel`, renamed from Pulse) — the at-a-glance
   stacked-funnel overview; stages drill into filtered Leads, adspend → Ads, a
   header link → Landing Pages.
2. **Leads** — everything about the leads (the roster + filters + per-lead pages).
3. **Talent** (route /people) — the same data from the **sales reps'** perspective (closers/setters).
4. ~~**Calls**~~ — the Calls list was removed; per-call review pages are now reached from the per-lead Lifecycle.

**Ads + Landing Pages** live as detail pages reached *from* the Funnel page (no
sidebar entry). **Revenue** is removed from Sales and slated for a future **CEO
tab**. See § 1 for the realized routing.

---

## Appendix — quick gotcha checklist

- [ ] Probing the DB? Use the **cloud** (commented) creds, not local.
- [ ] Applying a migration? Local Docker is up → **psycopg2 + manual ledger**, dual-verify.
- [ ] Reading Airtable form options? Use `get_base_schema()`, don't guess.
- [ ] Matching Calendly→lead on `utm_term`? **Unique-mapping-only** guard.
- [ ] New closer form? Filter `form_type='New'`; setter is id-only (resolve).
- [ ] Outcomes? New forms → `call_outcome`; old forms → `showed`/`closed`.
- [ ] Direct vs setter? From **Calendly**, never the form.
- [ ] Timestamps? Store UTC, render ET.
- [ ] Test rows? `excluded_at` soft-hide; not every surface filters it.
- [ ] Deploying a parser with new columns? Migration to cloud **first**.


---

# ⚡⚡ REACTIVATION & LEAD FUNNEL — FULL STATE + PLAN (2026-05-31) ⚡⚡

**This is the authoritative current state of the `/sales-dashboard/leads` funnel
+ the closer/People per-rep views, and the step-by-step plan for the unfinished
reactivation funnel/status work.** A fresh instance after a `/clear` should be
able to execute the plan from this section alone. Read it top to bottom.

## 0. How we work (recap — overrides CLAUDE.md process)
Drake describes in plain language, often refining mid-stream. Builder (this
agent) edits directly, verifies with `npx tsc --noEmit`, `npx next lint --file
<paths>`, `npm run build`, then `git add/commit/push` straight to `main` (Vercel
auto-deploys). Commit trailer: `Co-Authored-By: Claude Opus 4.8
<noreply@anthropic.com>`. One logical change per commit. Surface genuine
ambiguities/landmines BEFORE building; otherwise execute. Migrations are the
careful path — see §0.2 of this doc (local Docker is up → `supabase db push`
misroutes → apply via **psycopg2 against the pooler** + manual ledger insert +
dual-verify). DB ops use `.venv/bin/python` (psycopg2 is there, not in the
system python).

## 1. What shipped 2026-05-30 → 05-31 (all live on `main`)
In rough order. Each is a separate commit.
- **Form-driven per-lead lifecycle timeline** (`lib/db/lead-detail.ts`,
  `leads/[close_id]/page.tsx`): dropped close_calls from the per-lead timeline;
  it's opt-in anchor + form outcomes (triage/confirmation/closer) + follow-up,
  chronological. No reliable form↔call link exists (forms carry only `lead_id`).
- **FMR chart + speed-to-lead boxes moved onto `/leads`** (shared components
  `components/sales/fmr-time-block-chart.tsx`, `speed-to-lead-boxes.tsx`). FMR is
  cohort-wide since May 24 (NOT range-scoped); speed boxes ARE range-scoped.
- **New `/sales-dashboard/people` page** consolidating the per-rep Call Activity
  (setters/closers) + Calendly-bookings boxes + per-closer scheduled tables +
  Cash, with its own date picker. The old Appointment-Setting + Closing funnel
  pages still exist (Drake compares before deleting them — when deleting, the
  table components in their `_components/` folders must move to `components/sales/`).
- **Migration 0063** — `close_leads.reactivated_at` (the persistent reactivation
  tag). **Migration 0064** — `tag_reactivated_leads()` RPC. Backfill script
  `scripts/backfill_reactivated_at.py`. Cron call wired into
  `api/airtable_sync_cron.py` (fail-soft, set-once).
- **Stacked lead funnel** (Total / Direct / Setter-led / Reactivation) replacing
  the old 3 side-by-side booking boxes. `lib/db/leads-funnel.ts` (`getLeadsFunnel`).
- **Dials in a bracket** beside each funnel's lead amount (not a stage), funnel
  COLOUR coats: Direct green, "New opt-ins (setter-led)" yellow, Reactivation
  pale blue (`#7ea8dd`, no palette token), Total neutral.
- **Status column** on the roster (replaced "Booking" + removed "Caller"),
  re-opt-in tag → light grey (`text-dim`).
- **Strategy-call timing fix**: `hasDirect` = booked a direct strat link AFTER
  the lead's latest opt-in (not ever) — `lib/db/leads.ts` `bookedSince`.
- **Re-opt-in resets all stats**: every per-lead stat is scoped to `optInAt`
  (cohort call scan skips calls before optInAt; form signals gated to after
  optInAt; funnel dials lower-bounded at optInAt).
- **Status as a boxed tag** (4 types: Direct green / Reactivated blue / Opt-in
  yellow / DQ red), DQ keyed off forms only (NOT Close `status_label`, which is
  inaccurate — `status_label` is intentionally unused).
- **Perf option A** (`PERFORMANCE-SCALING-DEBT.md` at repo root): deduped the
  double cohort fetch on `/leads`; cached `getFmrTimeBlocks` (`unstable_cache`,
  10-min). **Perf option B step 1**: `getSpeedToLeadCohort`'s `close_calls` +
  `close_lead_status_changes` scans filter to the cohort via chunked
  `.in(lead_id)` (provably identical — was scanning all, discarding in JS).
- **People-page fixes**: canceled meetings show "—" for Showed/Closed; Airtable
  parser strips a pasted Close-lead-URL to the bare `lead_*` (SARRA);
  no-show ≠ cancel in the closer drill (only `status=canceled`); closer form
  matches by **lead_id → email → name**; **invitee email → lead** resolution
  when utm fails (EDavid); booked-by matches setter by **identity (lead_id →
  email → phone → name), NOT by date** (Rahul/Connor); the per-rep Call Activity
  Connected/Missing + the expandable drill are scoped by **form family** (a stray
  closer form no longer drags a setter's whole volume / connects into the
  Confirmation table). Dials still "mimic" (total) in both tables.
- **Sortable lead roster**: `leads/lead-roster.tsx` (client). The roster moved
  out of `page.tsx` into this client component; clickable column sort.

## 2. REACTIVATION LOGIC — complete spec (the focus)

### 2.1 What "reactivated" means
A **direct-booking lead** (one that booked an Ai Partner Strategy Call) that has
**lost its strategy-call spot**. Stored permanently as
`close_leads.reactivated_at` (timestamptz, null = never reactivated). Set ONCE,
never cleared. It is the moment they lost the spot, and the sales dashboard uses
it to (a) classify the lead into the Reactivation funnel and (b) scope that
funnel's activity to AFTER this timestamp.

### 2.2 The triggers (3 shipped, 1 PLANNED — all additive/OR)
A lead is reactivated at the **earliest** triggering event of:
1. **Setter handover** — a Closer Triage Form (the confirmation call form;
   `airtable_setter_triage_calls.form_type = 'Closer Triage Form'`) with
   `call_status` containing **`Setter pipeline`**. (The closer fills this form
   for every direct booking even on a no-answer; "hand off to setter" = this.)
2. **Lost the meeting** — the strategy-meeting **closer EOC form**
   (`airtable_full_closer_report`, `form_type='New'`) `call_outcome` is a
   **ghost/no-show or a cancel** (e.g. `Client Ghosted (no show)`,
   `Call Cancelled`). Old forms: `no_show_reason` Ghost/Cancelled.
3. **(PLANNED, NOT BUILT) Strat meeting lapsed >3h** — Aman often just lets a
   meeting pass without cancelling / handover / no-show. So: the lead has a
   direct strat booking, has **no active future strat booking**, and the latest
   strat booking's `start_time + 3h < now()` → reactivated. `reactivated_at` =
   that lapsed meeting's **`start_time + 3h`**. The 3h grace also absorbs a
   reschedule's cancel→recreate gap (a drag-dropped reschedule lands a new
   future booking inside 3h, so it does NOT trigger).
- **DQ NEVER triggers reactivation.** A DQ'd lead stays a direct-booking lead and
  is tagged DQ; it is not reactivated.
- `Rescheduled` / `Confirmed` / `Downsold` / closed / follow-up never trigger.

### 2.3 reactivated_at timestamp
= the triggering form's `airtable_created_at` (triggers 1 & 2), or `start_time +
3h` of the lapsed meeting (trigger 3). Earliest across all triggers.

### 2.4 Where it is computed (set-once, permanent)
- **Backfill**: `scripts/backfill_reactivated_at.py` (run `--apply`). Currently
  FORMS-ONLY (triggers 1 & 2). Trigger 3 must be ADDED here.
- **Ongoing**: `tag_reactivated_leads()` Postgres function (migration 0064),
  called via `db.rpc('tag_reactivated_leads')` at the end of
  `api/airtable_sync_cron.py`'s 15-min tick (fail-soft). Currently FORMS-ONLY.
  Trigger 3 must be ADDED here too (this RPC pulls Calendly + does the
  active-future-booking / 3h-lapse check). NOTE: adding trigger 3 means a NEW
  migration (e.g. 0065) that `create or replace`s the function — apply via
  psycopg2 + ledger + dual-verify per §0.2.

### 2.5 Lifecycle scoping — re-opting in resets everything
ALL per-lead stats are scoped to the lead's **latest opt-in** (`optInAt` =
`date_created` for new leads, `latest_opt_in_date` for re-opt-ins), NOT the view
window start. A re-opt-in wipes the prior journey's dials / connects /
booked / shows / closes / DQ. Implemented in `lib/db/leads.ts` (`afterOptIn`,
`bookedSince`), the cohort call scan (`getSpeedToLeadCohort`, skip calls before
`lead.optInAt`), and the funnel dial scan (`scanDialWindows`, lower bound
`optInAt`).

## 3. THE LEAD FUNNEL MODEL (`/sales-dashboard/leads`)

Four stacked boxes, computed in `lib/db/leads-funnel.ts` `getLeadsFunnel(rows,
range)` over the SAME view-filtered cohort `rows` the roster shows (boxes +
roster can't drift). The toggle (`view-toggle.tsx`, `?view=all|unique`) re-scopes
everything (re-opt-ins in/out).

### Segments
- **Direct-booking lead** = `hasDirect` (ever booked a direct strat link AFTER
  the latest opt-in) OR `reactivatedAt != null` (reactivation ⊂ direct).
- **Setter / "New opt-ins" lead** = everyone else (never booked a strat link).
- **Reactivation lead** = `reactivatedAt != null` (a subset of Direct).

### Box stages (dials live in a BRACKET beside the lead amount, not a stage)
- **Total** (neutral): adspend node → opt-ins (+dials bracket) → connected (1/lead)
  → books → shows → closes.
- **Direct** (green): qualified opt-ins → **Booked** (= the direct-lead count,
  +dials bracket) → connected → confirms → shows → closes. Each stage counted
  **ONCE per lead, cumulative**: Booked once (a reactive re-book never adds a
  second), Confirmed = confirmed‖showed‖closed, Showed = showed‖closed. A
  reactivated lead's eventual show/close (even post-reactivation) DOES count here
  (they are originally direct) — and ALSO appears in the Reactivation box as its
  reactive-phase outcome (different views; each counts the lead once within
  itself — that is NOT "double counting" per Drake).
- **Setter-led / New opt-ins** (yellow): pool (qual/unqual small) → dials (+bracket)
  → connected → books → shows → closes.
- **Reactivation** (pale blue): pool → dials → connected → books → shows → closes,
  **ALL scoped to after `reactivated_at`** (post-reactivation only; pre-reactivation
  connects/books belong to Direct).

### Cross-cutting
- **Dials** = RAW outbound dial count, **capped at the lead's close**
  (`closeTimeIso`, post-close fulfillment dials excluded) and **lower-bounded at
  `optInAt`**. Reactive dials additionally lower-bounded at `reactivated_at`.
- **Connected** = 1 per lead (`anyCallConnected`); reactive Connected = a
  connected call after `reactivated_at`.
- Computed live (not stored) — cheap over the cohort's already-loaded data, and
  lifecycle-scoping gives the re-opt-in reset for free.

## 4. THE STATUS COLUMN (roster)
One word, in the lead-type colour. `leadType` (drives colour) + `statusWord`
(furthest stage), both computed in `getLeadsForRange` (`lib/db/leads.ts`).
- **Type precedence (colour): DQ red > Reactivation blue > Direct green > Opt-in
  yellow.** DQ from FORMS only (any form `DQ`), lifecycle-scoped.
- **statusWord ladders** (furthest reached, lifecycle-scoped):
  - Direct: Booked / Confirmed / Showed / Closed.
  - Opt-in & Reactivation: Connected / Booked / Showed / Closed.
  - DQ: "DQ".
- Boxed tag; a not-yet-reached status shows a plain "—".

## 5. THE PLAN — reactivation work (ALL STEPS SHIPPED 2026-05-31)

All five build steps shipped 2026-05-31 (step 6 was verify-only, already
confirmed). The WHY is kept for each so a fresh instance understands intent; a
**SHIPPED** note records what landed and where. Commits on `main`:
3h-lapse trigger, Direct funnel cumulative, reactive funnel post-handover,
roster reactive status, per-lead two-phase journey.

### Step 1 — Add the 3h-lapse trigger (trigger 3 above) — **SHIPPED**
**Shipped:** migration `0065` (`create or replace tag_reactivated_leads()` with
trigger 3 + a showed-block so attended meetings don't lapse-reactivate) +
the matching extension in `scripts/backfill_reactivated_at.py` (re-run with
`--apply`: 27 rows set, 30 reactivated total). Calendly→lead resolution in SQL
mirrors the dashboard's unique utm/email/name chain; soft-hidden events
excluded; set-once / earliest-wins. Validated: 67 direct events all resolved,
8 kept (future booking), 8 lapsed-but-attended blocked, 28 lapse fires.

WHY: Aman frequently lets a strat meeting pass without cancelling / handover /
no-show, so triggers 1 & 2 miss those leads. The 3h-lapse path is the fool-proof
catch. ADDITIVE — does not change the existing form triggers.
WHAT: extend BOTH `scripts/backfill_reactivated_at.py` AND the
`tag_reactivated_leads()` RPC (new migration, e.g. 0065, `create or replace`) to
also tag: lead has a direct strat booking, no active (status!='canceled', future)
strat booking, latest strat booking `start_time + 3h < now()` → `reactivated_at`
= `start_time + 3h`, set-once (only where currently null, and only earlier than
any existing value). This reintroduces Calendly (`calendly_scheduled_events`
event_type = `DIRECT_BOOKING_EVENT_TYPE_URI` = `.../event_types/8f6795d3-...`,
matched to the lead via invitees by utm_term → email → name — utm often doesn't
resolve, so email/name fallback is essential, same as the closer-list fix).
Apply migration via psycopg2 + ledger + dual-verify (§0.2). Re-run the backfill.

### Step 2 — Direct funnel: count each stage ONCE, cumulative — **SHIPPED**
WHY: a lead that reaches Confirmed in direct, falls through to reactive, then
shows/closes should read Booked·Confirmed·Showed·Closed in the Direct funnel
(confirm is a prereq to show/close) — but never double-count (a reactive re-book
is not a 2nd direct Booked).
WHAT: in `getLeadsFunnel` Direct box — `confirms = count(isDirect && (confirmed ||
showed || closed))`, `shows = count(isDirect && (showed || closed))`,
`books = count(isDirect)` (unchanged — already once). showed/closed already
include post-reactivation (they're optInAt-scoped). This is the main Direct change.
**Shipped:** `lib/db/leads-funnel.ts`. Also made `connected` cumulative
(`anyCallConnected || confirmed || showed || closed`) — a strat-call show/close
is a Calendly/Zoom meeting, not a ≥90s `close_calls` dial, so leaving connected
raw inverted the rendered ladder (verified against real data). The whole Direct
ladder is now monotonic: books ≥ connected ≥ confirms ≥ shows ≥ closes.

### Step 3 — Reactive funnel: fully post-reactivation — **SHIPPED**
WHY: the reactive funnel should reflect only what happened AFTER the lead lost
its spot; pre-reactivation connects/books belong to Direct.
WHAT: in `getLeadsFunnel` Reactivation box, scope books/shows/closes/connected to
after `reactivated_at` (dials + connected already are via `scanDialWindows`).
NOTE: a reactivated lead's shows/closes are *inherently* post-reactivation (they
lost the strat meeting, so any show/close is via the setter pipeline after) — so
in practice `showed`/`closed`/`hasPartnership` ≈ post-reactivation already;
verify against real data and tighten only if needed. Reactive Connected = 0 when
they only connected pre-reactivation is CORRECT (that connect counts in Direct).
**Shipped:** `lib/db/leads.ts` gained `reactBooked` / `reactShowed` /
`reactClosed` (a partnership booking or show/close at-or-after `reactivated_at`);
the funnel box uses them. Verification found the NOTE held for shows/closes (0
of 30 pre-react) but NOT for partnership books — **2 real leads** booked a
partnership BEFORE the handover, so the tighten was needed (they no longer count
as reactive-phase books). Kept cumulative/monotonic like Direct.

### Step 4 — Roster status for reactivated leads = post-reactivation, floor "Eligible" — **SHIPPED**
WHY: the Status column should show the lead's CURRENT (reactive-phase) progress,
not the carried-over direct progress. A reactivated lead with no activity since
reactivation should read **"Eligible"** (not "Connected").
WHAT: in `getLeadsForRange` (`lib/db/leads.ts`), for `leadType==='reactivation'`,
compute `statusWord` from POST-reactivation signals: closed→"Closed",
showed→"Showed", booked(post)→"Booked", connected(post)→"Connected", else
**"Eligible"**. This needs a post-reactivation connected signal per reactivated
lead (few leads — cheap).
**Shipped via option (a):** `lib/db/leads.ts` adds a small targeted ≥90s-dial
scan over just the reactivated cohort leads → `postReactConnectedIds`, and the
reactivation `statusWord` branch uses the post-react signals (reactClosed /
reactShowed / reactBooked / postReactConnected), flooring at "Eligible". (Chose
(a) over (b) because importing `scanDialWindows` into `leads.ts` would create a
module cycle.) Today: 2 of 30 reactivated read "Connected", ~28 read "Eligible".
DQ still wins the colour.

### Step 5 — Per-lead page: two-phase journey — **SHIPPED**
WHY: see the lead's direct-funnel progress THEN their reactive-funnel progress
(and for DQ leads, surface their progress up to the DQ — DQ wins the roster tag
but the per-lead page should still show how far they got).
WHAT: `leads/[close_id]/page.tsx` + `lib/db/lead-detail.ts` — render a
two-segment progress (direct stages reached, then reactive stages reached). The
existing per-lead timeline already shows the form-driven journey; this adds an
explicit funnel-progress view. DQ leads show their progress + the DQ.
**Shipped:** new "Journey" section replaces the compact header Stage chip. A
Direct segment (Booked → Confirmed → Showed → Closed) and, for a reactivated
lead, a second Reactivation segment under a "↓ lost spot" divider (Eligible →
Connected → Booked → Showed → Closed) from the post-handover signals; setter-only
leads show a single Setter-led ladder; a terminal red DQ chip when DQ'd.
`lead-detail.ts` gained `isDq` + `reactConnected` / `reactBooked` / `reactShowed`
/ `reactClosed`. The Direct segment always renders when `reactivatedAt` is set
(reactivated ⇒ direct), even if the Calendly booking match didn't resolve here.

### Step 6 — #2 verify-only (DONE, no change)
The May 24-31 "3 reactive in list vs counter 4" is correct: the 4th is **Presley
Caillot**, reactivated AND DQ → renders the red DQ tag but is still in the
reactive pool (DQ > reactivation precedence). The `×` soft-hide (`excluded_at`)
already removes a lead from BOTH the list and the counter (the cohort filters
`excluded_at is null` before the funnel counts; 0 leads hidden currently). Both
**confirmed, leave as-is** per Drake.

## 6. KEY FILES MAP (for this area)
- `lib/db/leads.ts` — `getLeadsForRange`: the cohort enriched per lead with
  `hasDirect` / `hasPartnership` (both `bookedSince` optInAt), `reactivatedAt`,
  `closeTimeIso`, `confirmed/showed/closed`, `leadType`, `statusWord`. Booking
  signals via `collectTimedSignals` (utm→email→name, timestamped). DQ + status
  computed here. `afterOptIn` = lifecycle gate.
- `lib/db/leads-funnel.ts` — `getLeadsFunnel`: the 4 boxes; `scanDialWindows`
  (per-lead outbound-call scan → dialsBeforeClose [optInAt..close],
  postReactDials/postReactConnected [after reactivated_at]); adspend via
  `getAdsAggregateLive(clampAdsRange(...))`.
- `lib/db/funnel-appointment-setting.ts` — `getSpeedToLeadCohort` (the shared
  cohort; lifecycle-scoped call scan), `getFmrTimeBlocks` (cached), the per-rep
  `getCallActivityMetrics` / `getCallActivityForUser` (family-scoped
  Connected/Missing + drill).
- `lib/db/funnel-closing.ts` — closer scheduled list (`getClosingScheduledList`):
  event typing, lead grouping, `matchForm` (lead_id→email→name), invitee
  email→lead fallback, `buildBookedByResolver` (identity, not date), cancel =
  status=canceled only.
- `lib/db/calendly-lead-match.ts` — `buildCalendlyLeadResolver` (utm_term→leadId),
  `inviteeUtmTerm`. `DIRECT_BOOKING_EVENT_TYPE_URI` in `funnel-calendly.ts`.
- `scripts/backfill_reactivated_at.py`, migration `0063`/`0064`,
  `api/airtable_sync_cron.py` (RPC call).
- `app/(authenticated)/sales-dashboard/leads/page.tsx` (server) +
  `lead-roster.tsx` (client, sortable) + `view-toggle.tsx` +
  `leads/[close_id]/page.tsx` (per-lead).

## 7. DATA QUIRKS / GOTCHAS (real, observed)
- Close `status_label` is inaccurate — DO NOT use it. DQ + all status come from
  forms / Calendly.
- Triage `confirmed_call_date_time` is sometimes mis-entered (Rahul: a May 3
  value on a May 30 form, predating the lead's own opt-in). Never key on it for
  matching — match by identity.
- Calendly bookings frequently have a `utm_term` ad tag (`aaid_...`) that is NOT
  in `close_leads.utm_term`, so utm resolution returns null. ALWAYS have an
  email/name fallback when resolving a booking → lead.
- Calendly invitee names are often first-name-only ("EDavid" vs form "EDavid
  Waugh"); closer-form `prospect_email` is often null. The reliable booking→lead
  key is the invitee EMAIL → `close_leads.contacts`.
- Forms carry only `lead_id` (no close_call_id / calendly uri) — there is no hard
  form↔call↔booking link; everything is lead_id + identity + time-proximity.
- Two strat-call event types exist; `DIRECT_BOOKING_EVENT_TYPE_URI` =
  `.../event_types/8f6795d3-992a-4cbd-b584-9ecaabb3938c` ("Ai Partner Strategy
  Call") is the one we treat as direct.
- The People page defaults to TODAY (single day); broaden the picker to see
  prior days. Drake works around midnight ET so "today" can roll unexpectedly.

## 8. PERF
See `PERFORMANCE-SCALING-DEBT.md` (repo root). Option A + B-step-1 shipped; the
DB-side SQL-aggregation layer (the build-alongside-and-diff items) is deferred.
The new 3h-lapse RPC + the cohort scans are fine at current scale (5.4k leads,
16k calls, 158 calendly) but are on that doc's radar.

---

# ⚡⚡⚡ DEEP REFERENCE — CONNECTED MODEL · FILTERS · FMR · JOURNEY · INTEGRITY · CEO FLAGS (2026-05-31, late session) ⚡⚡⚡

This is the authoritative, detailed record of the late-2026-05-31 session. It is
intentionally exhaustive — a future instance should be able to reconstruct the
reasoning, not just the mechanics. Everything below is live on `main`.

## A. THE "CONNECTED" MODEL — the load-bearing concept (read first)

There are **two connected signals**, both per-lead, both set in `lib/db/leads.ts`
`getLeadsForRange`:

- **`connected`** (raw connect evidence) = a ≥90s outbound dial (`anyCallConnected`)
  **OR** a setter triage form (`setterTriagedIds` — any `airtable_setter_triage_calls`
  row with `form_type != 'Closer Triage Form'`) **OR** a confirmation that *reached*
  the lead (`confirmReachedIds`).
- **`connectedEffective`** (the GENERAL "did we reach them") =
  `connected || hasPartnership || showed || closed`. This is what the **Total
  funnel**, the **speed-to-lead box**, the **roster Connected column**, and the
  **per-lead header** all read.

**`confirmReached` rule (memorize this):** a Closer Triage Form (= the
**confirmation** form) counts as a connect for **every** `call_status` EXCEPT
`Unresponsive – Setter Handover` — the *only* no-answer outcome. Match by:
`cs && !cs.includes('unresponsive') && !cs.includes('handover')`. So
`Confirmed Booking`, `Confirmed Booking – New Time`, `DQ / Un-interested`,
`Setter pipeline / Follow up`, `High Ticket booking`, `Digital College booking`,
`Downsold` ALL count as connected. (Earlier versions wrongly hinged on
confirmed/DQ/follow only — fixed.)

**A pure direct booking is NEVER a connection.** A self-booked "Ai Partner
Strategy Call" (`hasDirect`, no call/form/partnership) is **Booked but not
Connected** everywhere — including the Total funnel. Consequence: in the **Total
funnel, Books can exceed Connected** (intended, Drake-confirmed). A
**setter/reactive booking (`hasPartnership`) DOES count** as connected (booking
it took a conversation), as do showed/closed.

**A DQ always implies connected** — every DQ comes from a form output that counts
(a closer-EOC `DQ / Bad Fit` is `showed`; a confirmation `DQ / Un-interested` is
`confirmReached`; a setter-triage DQ is a triage form). No special-casing needed.

**Per-type connected** (the `reachedStage` predicate, below):
- Total: `connectedEffective` (excludes pure-direct booking).
- Direct: `connected || confirmed || showed || closed` (NO partnership/booking
  back-fill — a direct booking isn't a connect; but confirm/show/close are).
- Setter: `connectedEffective` (a setter booking counts).
- Reactivation: `reactConnected` only — a **≥90s dial OR setter triage form filed
  AFTER `reactivated_at`** (`postReactConnectedIds || postReactTriagedIds`). A
  **confirmation does NOT count as a reactive connect** (it's a direct-phase event).

## B. AUTHORITATIVE FORM VALUES + NAMING (pulled live from Airtable schema)

**Naming (confusing — internalize it):** `airtable_setter_triage_calls` is ONE
table holding TWO forms via `form_type`:
- `'Closer Triage Form'` = **the CONFIRMATION form** (the closer/Aman confirms a
  direct booking). Drake calls this "the confirmation form."
- `'Setter Triage Form'` = **the TRIAGE form** (the setter's triage call). Drake
  calls this "the triage form."

**`Call Status` singleSelect options** (shared field, both forms), pulled via the
Airtable Metadata API: `High Ticket booking`, `Digital College booking`,
`Setter pipeline / Follow up`, `Confirmed Booking`, `Confirmed Booking – New Time`,
`Downsold`, `Unresponsive – Setter Handover`, `DQ / Un-interested`. **The only
no-answer (lead didn't pick up) outcome is `Unresponsive – Setter Handover`.** Do
NOT confuse it with `Setter pipeline / Follow up` (a real, answered disposition).

**Form filler names** (for "who sent the form" on the per-lead Lifecycle):
- `airtable_setter_triage_calls.setter_names[0]` — the filler for BOTH triage
  (the setter) and confirmation (the confirming closer, e.g. `"Aman Ali"`;
  sometimes `"No Setter"` → treat as null).
- `airtable_full_closer_report.closer_names[0]` — the closer who filled the EOC.
- Both are populated `text[]` here, so NO record-id→name resolution is needed on
  the per-lead page (unlike the closer drill, which still needs it).

**Pulling live form options:** `AirtableClient.from_env().get_base_schema()` —
but `.env.local` is NOT auto-loaded into the python shell, so first
`os.environ.setdefault(...)` from `.env.local`. Confirmation/triage table id =
`tblaoMsiE3FSkHjQt` ("Triage Calls EOC Form").

## C. SHARED FUNNEL PREDICATE (single source of truth) — `lib/db/leads-funnel.ts`

Every funnel box count AND the /leads roster filter go through these, so **a
funnel bar's number always equals the roster it opens when clicked**:
- `isDirect(r)` = `hasDirect || reactivatedAt != null` (**reactivation ⊂ direct**).
  `isReact` = `reactivatedAt != null`. `isSetter` = `!isDirect`.
- `matchesType(r, type | null)` — `direct` / `reactivation` / `setter` / `null`(all).
- `reachedStage(r, type | null, stage)` — **cumulative** "reached at least this
  stage", with the per-type connected defs from § A. `confirmed` is direct/total
  only (setter + reactivation return false for it).
- `matchesLeadFilter(r, types[], stage)` — the roster filter: a lead matches if
  it's in ANY selected type AND (no stage OR reached it within that type).

## D. FUNNEL → LEADS FILTER (URL contract)

- `?type=` comma-multi (`direct` / `setter` (a.k.a. opt-in) / `reactivation`);
  `?stage=` single (`connected`/`booked`/`confirmed`/`showed`/`closed`).
- `direct` INCLUDES reactivation. `stage` is cumulative ("latest stage reached" —
  picking `showed` includes closes). `confirmed` only shows in the bar when Direct
  is selected. Multi-stage makes no sense (cumulative), so it's single-select.
- Funnel-page stage nodes are `<Link>`s to `/leads?type=&stage=&start=&end=`; the
  Total adspend node → the Ads page; a header link → the Landing Pages page.
- Filter bar = `leads/leads-filter-bar.tsx` (client): View (all/unique — the old
  toggle, repurposed) · Type chips · Reached chips.

## E. PER-LEAD JOURNEY (two-phase) — `leads/[close_id]/page.tsx` `JourneyProgress`

Lanes (each stage is a chip, lit/unlit):
- **Direct** (when `isDirect` or `reactivatedAt`): Booked → Connected → Confirmed
  → Showed → Closed.
- **Opt-in** (every non-direct, non-reactivated lead — incl. ones we haven't
  connected with): Connected → Booked → Showed → Closed. ALWAYS surfaced (no
  "not booked" empty state) — the full ladder shows unlit, starting at Connected,
  for a lead that just opted in. Booked lights only once a partnership is actually
  booked (`bookingType === 'setter'`).
- **Reactivation** (when reactivated, under a "↓ lost spot · {date}" divider):
  Eligible → Connected → Booked → Showed → Closed. Eligible is ALWAYS lit (lost
  the spot = eligible). Booked/Showed/Closed use the post-handover signals
  (`reactBooked`/`reactShowed`/`reactClosed`).

**DURABLE Connected-lane logic (signal-based, NOT timing — so form fill-order
can't break it; this was the Raymond Chacon bug):**
- Direct Connected = `lead.confirmed || (lead.connected && !lead.reactConnected)`.
  A **confirmed booking** (`Confirmed Booking` / `– New Time`, i.e. `lead.confirmed`)
  ALWAYS lights Direct Connected (and Confirmed).
- Reactive Connected = `lead.reactConnected` (post-handover only). A confirmed
  booking is a **global** connect but is **NEVER** a reactive connect.
- `Confirmed` stays **literal** (`lead.confirmed`) — a `DQ / Un-interested`
  confirmation is NOT "confirmed".
- DQ leads still render their progress + a terminal red DQ chip.

## F. PER-LEAD LIFECYCLE (day-grouped) — same page, `Lifecycle`

Grouped by **ET day, newest first**, since latest opt-in. Each day shows, side by
side (NO matching — Drake: "just show both"):
- **Calls** — time · caller · duration · a link to the per-call review page
  `/sales-dashboard/calls/[closeCallId]` ("review →" when transcribed, else
  "open →"). Connected (≥90s) green; sub-90s tagged "(not connected)".
- **Forms** — disposition · source (Setter triage / Confirmation / Closer) ·
  **"by {filler}"** (`setter_names[0]` / `closer_names[0]`, see § B).
- Opt-in + follow-up markers fold into their day.
- `lead-detail.ts` form events now carry a `by` field; `LeadTimelineEvent`'s
  `form` variant gained `by: string | null`.
- The per-call links REPLACED the Calls sidebar tab (the list page + nav item
  were removed). Each Lifecycle call link carries `?lead=<close_id>` so the
  per-call page's "← Back to lead" returns to the source lead.

## G. FMR (first message response) — `lib/db/funnel-appointment-setting.ts`

**History:** FMR used to be a fixed since-May-24, **creation-based** scan that
showed 180 while the roster total showed 196. The gap = FMR (a) excluded the **22
re-opt-ins** (creation predates May 24), (b) had no qualifying-status filter, (c)
didn't drop the 1 soft-hidden row. Different cohort definition entirely.

**Now (window + cohort-aligned):**
- `getFmrSignals(range)` — **cached per range** (`unstable_cache`, keyed on
  start/end); runs the inbound-SMS + ≥90s-outbound-connect scans (`activity_at >=
  window start`), returns serializable `[leadId, iso][]` arrays.
- `buildFmrBlocks(cohortRows, signals, label)` — pure; buckets each lead by the ET
  hour of its **OPT-IN** (a re-opt-in by its re-opt-in moment, not original
  signup); a response counts only **at/after** opt-in; within-24h is relative to
  opt-in. `cohortSize` = the cohort length.
- On `/leads`: FMR is built over `allRows` (the window cohort) so its cohortSize
  **equals the Total funnel's opt-ins** (196 = 196). It honors the **type filter
  but ONLY `direct` / `setter` (opt-in)** — `reactivation` is ignored ("response
  by opt-in hour" isn't meaningful for it), and no/other selection shows the full
  window cohort. The **stage filter does NOT touch FMR**.
- Response definition is unchanged from the accurate original (inbound SMS OR ≥90s
  connect; within-24h either) — only the anchor (opt-in) + cohort changed.

## H. SPEED-TO-LEAD BOXES — filter-aware

`summarizeCohortRows(rows)` was extracted (pure stats fn: avg speed, under-3h,
intensity, connected rate, cohort size) and is reused by `getSpeedToLeadCohort`
(no behavior change) AND on `/leads` over the **filtered** roster rows, so the
boxes track the type/stage filter. The box's "Connected rate" count uses the
cumulative `reachedStage(r, null, 'connected')` so it matches the Total funnel.

## I. FUNNEL INTEGRITY GUARD — `validateFunnel` (always-on)

Runs inside `getLeadsFunnel`; the Funnel page shows a banner (GREEN "all checks
pass" when clean, RED with specifics when not — always visible). Invariants:
- **Per-lead-once** — no duplicate cohort rows. (The cohort is structurally
  one-row-per-lead: re-opt-ins dedup against new leads at
  `funnel-appointment-setting.ts` ~`if (newLeadIdSet.has(...)) continue`, and the
  funnel counts via `count(pred)` = one increment per row. So a lead that books
  direct THEN reactive is one row, counted once per stage.)
- **Monotonicity** per box (Total exempt on Books-vs-Connected, by design).
- **Partition:** Direct.books + Setter.pool == Total.optIns.
- **Reactivation ⊂ Direct:** reactivation pool ≤ direct books.
A violation = a real bug (double-count / mis-bucket). Simple framing for Drake:
"it adds up Direct + Setter and checks they equal total opt-ins."

## J. CEO CONTROL-CENTER MISSING-FORM FLAGS — `lib/db/ceo-missing-forms.ts`

On `(ceo)/control-center`. Always-visible panel (GREEN "all filled" when clean).
For **today (ET)**:
- **Setter:** a ≥90s connected outbound call with **no Setter Triage Form 15 min**
  later → flag (lead + caller, from `close_calls.raw_payload.user_name`).
- **Closer:** a booked meeting (direct or "partnership call w/") with **no Closer
  EOC form 1.5 h after its START** → flag (lead + closer `host_user_name`).
  Meeting→lead resolves by **unique email→name** (utm skipped — for a flag we only
  want high-confidence matches; unresolved meetings are **dropped, not
  false-flagged**). Closer trigger is start-based for now (Fathom isn't wired for
  closing-call END yet — that's the eventual upgrade).
- "No form" = no Airtable form for that lead filed **at/after** the interaction.
  One flag per lead per side.

## K. PAGE RESTRUCTURE + ROUTING (recap of the structural change)

- Sidebar is FLAT, no sub-bars: **Funnel · Leads · Talent** (the Calls list page was removed; per-call review pages live under the per-lead Lifecycle). "Talent" is
  the **People page renamed** (route is still `/sales-dashboard/people` — display
  name only). The stacked funnel **moved off `/leads` onto the Funnel page**
  (`/sales-dashboard/funnel`, renamed from Pulse, was the activity-box page).
- **Removed routes:** `funnel/appointment-setting`, `funnel/closed`, `revenue/*`
  (Revenue → future CEO tab). Their `_components/` (PerRepCallActivityTable,
  CloserScheduledTables) + `actions.ts` + `rep-link.tsx` stay colocated — the
  Talent page imports them.
- `funnel-stages.ts` was **trimmed to just `resolveFunnelRange`** (the dead
  `getFunnelActivity` + FunnelBox/PulseTile types/helpers were removed).
- Ads + Landing Pages are reached FROM the Funnel page (adspend node + header
  link). Their "Back to Funnel" (`StageDetailLayout` `backHref`) preserves the
  window.

## L. BACK-BUTTON / WINDOW + FILTER PRESERVATION

- `buildLeadsQuery(searchParams)` serializes the leads-page state (every param
  except `q` and `ret`) → a `ret=` param appended to **both** the roster row
  links AND the lead-**search** result links. The per-lead "Back to leads" rebuilds
  the URL from `ret`, so you land back on the exact window+filters.

## M. KEY FILES TOUCHED THIS SESSION

- `lib/db/leads.ts` — `connected` / `connectedEffective` / `reactConnected` /
  `reactBooked/Showed/Closed`, `confirmReachedIds`/`setterTriagedIds`/
  `postReactTriagedIds`, the post-react connected scan, `statusWord`.
- `lib/db/leads-funnel.ts` — `reachedStage`/`matchesType`/`matchesLeadFilter`,
  the boxes, `validateFunnel`, `LeadsFunnel.warnings`.
- `lib/db/lead-detail.ts` — broad `connected`, `reactConnected`, `isDq`,
  reactive signals, form-event `by` (filler).
- `lib/db/funnel-appointment-setting.ts` — `summarizeCohortRows`, `getFmrSignals`,
  `buildFmrBlocks` (replaced `getFmrTimeBlocks`).
- `lib/db/funnel-stages.ts` — trimmed to `resolveFunnelRange`.
- `lib/db/ceo-missing-forms.ts` — NEW (CEO flags).
- `components/sales/funnel-stack.tsx` — NEW (extracted, link-enabled funnel).
- `components/sales/speed-to-lead-boxes.tsx` — `connectedLeads` prop.
- `components/sales/stage-detail.tsx` — `backHref`.
- `components/sales/fmr-time-block-chart.tsx` — window/cohort labels.
- `app/(authenticated)/sales-dashboard/funnel/page.tsx` — rewritten (FunnelStack
  + integrity banner + LP link).
- `app/(authenticated)/sales-dashboard/leads/page.tsx` — filters, FMR wiring,
  speed-box wiring, search `ret`.
- `app/(authenticated)/sales-dashboard/leads/leads-filter-bar.tsx` — NEW.
- `app/(authenticated)/sales-dashboard/leads/lead-roster.tsx` — Connected column,
  `backQuery`.
- `app/(authenticated)/sales-dashboard/leads/[close_id]/page.tsx` — Journey +
  day-grouped Lifecycle + `ret` back link.
- `app/(authenticated)/sales-dashboard/sidebar.tsx` — flattened.
- `app/(authenticated)/(ceo)/control-center/page.tsx` — missing-forms panel.
- `supabase/migrations/0065_tag_reactivated_leads_3h_lapse.sql` — NEW (trigger 3).
- `scripts/backfill_reactivated_at.py` — trigger 3 added.

## N. VERIFICATION HANDLES (real leads, for the next instance to eyeball)

- **Presley Caillot** (`lead_GtB7zTmWgOsgLwSgqtNiEMhSKzpDfhdywUvjTWu29qY`) —
  reactivated + DQ via a `DQ / Un-interested` confirmation; reads connected (her
  confirmation reached); good for the connected/DQ edge.
- **Nand Modi** (`lead_hceyWL1wxBG9xoWBraa6x8iScDhDxXdhQUVqKkwJOUv`) — 3 connected
  calls on Wed May 27 (after opt-in, so visible); good for the day-grouped
  Lifecycle + per-call review links. (Backups: Hang Vu `lead_kIK2NvY8…`, Matthew
  Milford `lead_Z1gOJGSdoZpkxvvgXbJRGhpHc0Cd93LmXLOl8nSsMyc`.)
