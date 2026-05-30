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
