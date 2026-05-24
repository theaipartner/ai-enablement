# Calendly Ingestion — Data Model + Live Webhooks + 7-Day Backfill
**Slug:** calendly-ingestion
**Status:** in-flight
**Target branch:** main

## ⚠️ Landscape note

Close (live webhooks) + Meta (3h cron) + Wistia (3h cron, timeseries cutover done) all live on `main`. Separate Ella worktree on `ella-worktree`. **Stay on `main`.** `git status` + `git log --oneline -10` first; re-read current file state.

## Why this exists

Ingest Calendly into Supabase — source for SIX Engine-sheet rows. Discovery is done: **`docs/reports/calendly-discovery.md` is the authoritative input — read it fully before designing.** It has the real event/invitee shapes, the event-type catalog, the metric mappings, and the footguns. Don't re-probe what it covers.

**Drake's decisions (bake in):**
- **Automated live ingestion moving forward is the PRIORITY** — via Calendly webhooks (the plan tier supports them; 10 already fire to Make.com). Mirror the Close webhook receiver pattern we shipped. This is the main deliverable.
- **Backfill: 7 days only** (not 30). `min_start_time`/relevant window = last 7 days on first load.
- **Closer-booking type = "AI Partner Strategy Call"** (Drake confirmed the lean). Implement this as the closer-type set, but as a CLEARLY-MARKED config constant (not buried in a query) so it's trivially correctable if Aman/team later says it's more than one type. Match by event `name`, case-insensitive (see footgun below).
- **"Follow Up Meeting" (row 95) definition is UNRESOLVED** — Aman/team hasn't defined it. Do NOT block on it. Build the ingestion (which mirrors all events regardless), and leave the row-95 metric as a documented TODO in the aggregation notes / runbook. The raw data will support whatever definition lands later. Ingest everything; defer only that one metric's computation.

## Footguns from discovery (MUST handle — these are verified, not hypothetical)

1. **Cloudflare blocks default `Python-urllib` User-Agent (1010 / browser_signature_banned).** The Calendly client MUST set a normal `User-Agent` header (e.g. `ai-enablement/1.0 (+drake@theaipartner.io)`). First source in this codebase to require this. Without it every call 403s.
2. **Filter closer bookings by event `name`, NOT `event_type` URI.** 58% of sampled events reference RETIRED event-type URIs absent from the active `/event_types` catalog; a URI-based filter silently misses them. The event's own `name` field carries the booking-time label. Match case-insensitively ("Ai Partner Strategy Call" vs catalog's "AI Partner Strategy Call" — casing drifts).
3. **Date math (Next Day / Two Days Out) in business tz `America/New_York`, NOT UTC.** Store timestamps UTC; compute `start_time.date - created_at.date` in EDT (per ADR 0003). A near-midnight UTC booking flips to the wrong calendar day otherwise. This matters for rows 35/36 — but those are aggregation-layer computations; ingestion just stores the raw UTC timestamps. Note it for the aggregation layer.
4. **Reschedules fire as TWO webhook events:** `invitee.canceled` on the old invitee + `invitee.created` on the new (with `rescheduled=true`, `old_invitee` populated). Handle both; don't double-count a reschedule as a new booking (the `rescheduled` flag + `old_invitee` lineage distinguishes it).

## Env var

`CALENDLY_API_KEY` in `.env.local` (NOT `_TOKEN` — spec drift noted in discovery; it's a 896-char JWT). Standardize the ingestion module on `CALENDLY_API_KEY`. Bearer auth. Confirm it works (`GET /users/me` 200, WITH the User-Agent header) before backfilling; hard stop on 401.

## API context (verified in discovery — confirm shapes as you build)

- Base `https://api.calendly.com`. `urllib` + the mandatory User-Agent header. Org URI from `GET /users/me`.
- `GET /scheduled_events?organization=<org>&min_start_time=&max_start_time=&count=` — paginated event list (backfill source).
- `GET /scheduled_events/{uuid}/invitees` — invitee detail (rescheduled/old_invitee/new_invitee/no_show/status/cancellation).
- Resource IDs are full URIs, not bare UUIDs.
- Rate limit ~60-120/min, 429 + Retry-After.
- **Webhooks:** `POST /webhook_subscriptions` to register (scope=organization), events `invitee.created` + `invitee.canceled` (+ optionally `invitee_no_show.created`/`.deleted` — see the no_show note). Calendly signs webhooks with **HMAC SHA256** via a `Calendly-Webhook-Signature` header containing a timestamp + signature; the signing key is returned when the subscription is created. **Confirm the exact signature scheme against current Calendly docs** — this is the security boundary.

## Schema (sketch from discovery — validate against real payloads, adjust with reasoning)

Migration **0047**. Three tables, mirror-everything posture (raw payload jsonb + denormalized hot fields), loose FKs (same posture as the Close mirror — webhook/backfill order isn't guaranteed):
- **`calendly_event_types`** (reference; `uri text PK`): name, duration, kind, active flag, scheduling_url. ~14 rows. Refreshed on backfill + opportunistically.
- **`calendly_scheduled_events`** (`uri text PK`): `name`, `status`, `start_time`, `end_time`, `created_at`, `updated_at` (all timestamptz), `event_type_uri`, host fields (user_name/user_email from first event_membership), `cancellation jsonb` (nullable), `invitees_counter jsonb`, `raw_payload jsonb`, + lifecycle.
- **`calendly_invitees`** (`uri text PK`): `event_uri` (loose FK), `email`, `name`, `status`, `created_at`, `rescheduled bool`, `old_invitee text` (nullable), `new_invitee text` (nullable), `no_show bool`, `timezone`, `cancel_url`, `reschedule_url`, `raw_payload jsonb`, + lifecycle.
- **HARD STOP for Drake's SQL review before apply** (gate a). After approval, apply + dual-verify per `docs/runbooks/apply_migrations.md` (psycopg2 against pooler; psql not installed).

## What to build

1. **Migration 0047** — the three tables. Indexes for the metric queries: `(status, created_at)` + `(name, created_at)` on events (closer-booking-by-name-by-day), `(event_uri)` + `(created_at)` + `(rescheduled)` on invitees. Gate (a) review.
2. **`ingestion/calendly/`** — client (urllib + User-Agent header, the endpoints, 429 back-off), parser (event/invitee JSON → typed rows; store raw_payload; denormalize hot fields), pipeline (idempotent upserts on the `uri` PKs; reschedule handling per footgun 4). Mirror `ingestion/close/` structure. Reuse `shared/db`, audit via `webhook_deliveries` (`source='calendly_webhook'` for live, `'calendly_backfill'` for backfill).
3. **`api/calendly_events.py`** — the webhook receiver. Verify HMAC SHA256 signature (against a `CALENDLY_WEBHOOK_SECRET` — gate (d) env var) → parse `invitee.created` / `invitee.canceled` (+ no_show events if subscribed) → fetch/parse the associated event + invitee → idempotent upsert → audit → fast 2xx. Fail-soft (bad single event logs + still 2xx so Calendly doesn't disable the subscription — confirm Calendly's retry/disable behavior). Mirror `api/close_events.py` structure exactly.
4. **`scripts/register_calendly_webhook.py`** — registers the org-scoped subscription pointing at the deployed receiver URL, prints the signing key for Drake to put in env. Running it is Drake's gate (creates real Calendly-side state + needs the deployed URL). Mirror `scripts/register_close_webhook.py`.
5. **7-day backfill** — `scripts/backfill_calendly.py --smoke / --apply / --limit`. Pulls last 7 days of scheduled_events + their invitees, idempotent upsert. Smoke (one event+invitees end-to-end) before bulk; **bulk Drake-gated**. Small volume (~100 events/30d → ~25 events/7d).
6. **Closer-type config** — a clearly-marked module constant `CLOSER_EVENT_TYPE_NAMES = {"ai partner strategy call"}` (lowercased for case-insensitive match), with a comment that this is Drake/Aman-confirmable and may expand. Used by the aggregation layer, not ingestion (ingestion stores everything). Document where to change it.
7. **Tests** — parser (event/invitee shapes incl. canceled + rescheduled lineage), pipeline (idempotency, reschedule-not-double-counted), webhook receiver (signature verify pass/fail, the two event types, fail-soft), the User-Agent header presence. Full suite green.

## Activation runbook (interdependent — spell out for Drake)

Live ingestion needs Drake-gated steps in order: (1) merge + deploy receiver to Vercel, (2) confirm reachable (GET health check), (3) add `CALENDLY_WEBHOOK_SECRET` to Vercel (gate d) — likely AFTER registering since the key comes from registration; sequence it like Close did, (4) run `register_calendly_webhook.py` against the deployed URL, (5) put the returned signing key in Vercel + redeploy, (6) verify a real booking flows end-to-end. Document precisely in the runbook; Drake executes.

## Gates / hard stops

- **Migration 0047 SQL review** before apply (gate a).
- **`CALENDLY_WEBHOOK_SECRET` in Vercel** (gate d) — scope + document, Drake adds. Don't add silently.
- **Deploying receiver + registering the Calendly subscription** — Drake's actions (needs deployed URL, creates real Calendly-side state). Builder writes the helper + runbook; Drake runs.
- **Bulk backfill** — smoke first, Drake confirms, then 7-day bulk.
- `CALENDLY_API_KEY` missing/401 → stop. Repeated 429 → back off, partial.
- Never write to Calendly beyond the one subscription-creation call (Drake-gated). Never echo secrets/token.
- Note the deploy-trigger flakiness (CLAUDE.md): confirm the Vercel deploy actually landed before registering.

## What success looks like

- Migration 0047 applied + dual-verified; three tables with correct indexes.
- `ingestion/calendly/` mirrors events + invitees + event-types idempotently, handling reschedules correctly.
- `api/calendly_events.py` deployed-ready: HMAC verify, routes invitee.created/canceled, upserts, audits, fast 2xx, fail-soft.
- `scripts/register_calendly_webhook.py` ready for Drake.
- 7-day backfill loads recent events; row counts reported.
- Idempotency proven (re-run no-ops; reschedule doesn't double-count).
- Closer-type config constant in place + documented as confirmable.
- Activation runbook precise enough for Drake to go live without guessing.
- Tests green.
- Report states clearly: what's live (events/invitees via webhook + 7d backfill) vs deferred (Follow Up metric definition, no_show consolidation).

## Think this through

HMAC scheme assumed wrong (verify against real Calendly docs — security boundary). Reschedule double-counting (footgun 4 — test it). Cloudflare UA (footgun 1 — without it everything 403s; test the client sets it). Event referencing a retired event_type URI not in the catalog (use event.name; don't hard-FK to event_types). Webhook delivering invitee.created before the backfill has the event (loose FK tolerates; the receiver fetches the event fresh anyway). Calendly disabling the subscription on repeated non-2xx (fail-soft, always 2xx on handled error). The 7-day backfill missing events that START in the future but were CREATED in-window (the sheet metrics key on created_at/booking-date — make sure the backfill window captures by the right time field; discovery used min/max_start_time but the metrics count by created_at — consider pulling a wider start window and filtering by created_at, or confirm the right query param). Surface honestly.

## Mandatory doc updates

- `docs/schema/calendly_event_types.md`, `docs/schema/calendly_scheduled_events.md`, `docs/schema/calendly_invitees.md`.
- `docs/runbooks/calendly_ingestion.md` — source, auth (key + User-Agent requirement), endpoints, the 4 footguns, webhook activation runbook (the interdependent steps), backfill, idempotency, closer-type config location, the deferred Follow-Up-metric TODO, the EDT date-math note for the aggregation layer.
- `.env.example` — `CALENDLY_API_KEY` + `CALENDLY_WEBHOOK_SECRET` (documented, gate d, needed in both .env.local and Vercel).
- `docs/state.md` — Calendly ingestion entry once shipped (migration 0047, three tables, webhook receiver, 7d backfill); distinguish "receiver shipped" from "live in production" (Drake-gated activation).
- `CLAUDE.md` § Folder Structure — add `ingestion/calendly/`.
- Report at `docs/reports/calendly-ingestion.md`.
