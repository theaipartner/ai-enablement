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

> **2026-05-31 UPDATE:** A large amount has shipped since this 05-30 handoff
> (reactivation tagging, the stacked lead funnel, the Status column, perf fixes,
> People-page fixes, sortable roster) **and there is an in-flight plan for the
> reactivation funnel/status that is NOT yet built.** Before doing anything,
> read **§ REACTIVATION & LEAD FUNNEL — FULL STATE + PLAN (2026-05-31)** at the
> BOTTOM of this doc. It is the authoritative current state and the step-by-step
> plan. This 05-30 section below is now partly historical.

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

| Route | What it is | Depth today |
|---|---|---|
| `/sales-dashboard` | Overview / hero ("Pulse" in the future vision) — v2 hero cards over a metric catalog | touched lightly |
| `/sales-dashboard/[section]` | Dynamic section router → `SectionId` or 404 | not touched |
| `/sales-dashboard/leads` | **Leads roster** + funnel header + the Direct/Setter booking funnels | **deep** |
| `/sales-dashboard/leads/[close_id]` | **Per-lead detail** — opt-in facts + full call history w/ reviews (built today) | **deep** |
| `/sales-dashboard/funnel/appointment-setting` | Speed-to-Lead lead list + per-rep call-activity drill | **deep** |
| `/sales-dashboard/funnel/closed` | **Closer drill** — per-closer scheduled calls + outcomes | **deep** |
| `/sales-dashboard/funnel/landing-pages` | Landing-page metrics (Clarity) | not touched |
| `/sales-dashboard/funnel/ads` | Ad metrics (Meta) | **sparse — see §7** |
| `/sales-dashboard/calls` + `/calls/[close_id]` | Setter-call list + per-call transcript/review detail | medium |
| `/sales-dashboard/revenue/*` | profit / future / new-cash / expenses / refunds | not touched |
| `/sales-dashboard/states`, `/trajectory` | reference / trend surfaces | not touched |

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

The dashboard is converging on **three main pages**:
1. **Pulse** — the at-a-glance health/overview surface (today's `/sales-dashboard`).
2. **Leads** — everything about the leads (today's `/leads` + per-lead pages,
   absorbing the funnel detail).
3. **People** — the same underlying data viewed from the **sales reps'**
   perspective (closers/setters).

Where the **ads** and **funnel** pages live in this layout is still undecided.
Treat this section as direction, not commitment.

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

## 5. THE PLAN — remaining reactivation work (NOT YET BUILT)

Build in this order. The WHY is given for each so a fresh instance understands
intent, not just mechanics.

### Step 1 — Add the 3h-lapse trigger (trigger 3 above)
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

### Step 2 — Direct funnel: count each stage ONCE, cumulative
WHY: a lead that reaches Confirmed in direct, falls through to reactive, then
shows/closes should read Booked·Confirmed·Showed·Closed in the Direct funnel
(confirm is a prereq to show/close) — but never double-count (a reactive re-book
is not a 2nd direct Booked).
WHAT: in `getLeadsFunnel` Direct box — `confirms = count(isDirect && (confirmed ||
showed || closed))`, `shows = count(isDirect && (showed || closed))`,
`books = count(isDirect)` (unchanged — already once). showed/closed already
include post-reactivation (they're optInAt-scoped). This is the main Direct change.

### Step 3 — Reactive funnel: fully post-reactivation
WHY: the reactive funnel should reflect only what happened AFTER the lead lost
its spot; pre-reactivation connects/books belong to Direct.
WHAT: in `getLeadsFunnel` Reactivation box, scope books/shows/closes/connected to
after `reactivated_at` (dials + connected already are via `scanDialWindows`).
NOTE: a reactivated lead's shows/closes are *inherently* post-reactivation (they
lost the strat meeting, so any show/close is via the setter pipeline after) — so
in practice `showed`/`closed`/`hasPartnership` ≈ post-reactivation already;
verify against real data and tighten only if needed. Reactive Connected = 0 when
they only connected pre-reactivation is CORRECT (that connect counts in Direct).

### Step 4 — Roster status for reactivated leads = post-reactivation, floor "Eligible"
WHY: the Status column should show the lead's CURRENT (reactive-phase) progress,
not the carried-over direct progress. A reactivated lead with no activity since
reactivation should read **"Eligible"** (not "Connected").
WHAT: in `getLeadsForRange` (`lib/db/leads.ts`), for `leadType==='reactivation'`,
compute `statusWord` from POST-reactivation signals: closed→"Closed",
showed→"Showed", booked(post)→"Booked", connected(post)→"Connected", else
**"Eligible"**. This needs a post-reactivation connected signal per reactivated
lead (few leads — cheap). `statusWord` is currently computed in `leads.ts` which
has no call data; either (a) add a small post-reactivation call scan there for
reactivated leads, or (b) compute the reactive statusWord in `leads-funnel.ts`
(which already scans calls via `scanDialWindows` → `postReactConnected`) and
thread it back onto the row. DQ still wins the colour.

### Step 5 — Per-lead page: two-phase journey
WHY: see the lead's direct-funnel progress THEN their reactive-funnel progress
(and for DQ leads, surface their progress up to the DQ — DQ wins the roster tag
but the per-lead page should still show how far they got).
WHAT: `leads/[close_id]/page.tsx` + `lib/db/lead-detail.ts` — render a
two-segment progress (direct stages reached, then reactive stages reached). The
existing per-lead timeline already shows the form-driven journey; this adds an
explicit funnel-progress view. DQ leads show their progress + the DQ.

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
