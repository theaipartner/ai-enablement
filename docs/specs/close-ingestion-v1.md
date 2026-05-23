# Close CRM Ingestion — Data Model + Backfill + Pipeline
**Slug:** close-ingestion-v1
**Status:** in-flight

## Why this exists

First real ingestion of Close CRM data into Supabase — the foundation of the Gregory sales-side surface (the eventual CEO/business-engine dashboard). Two prior discovery passes are done and their reports are the inputs here:
- `docs/reports/close-smartview-discovery.md` — endpoints, auth, the 11-status pipeline, Smartviews are operational filters not data sources.
- `docs/reports/close-full-data-inventory.md` — REAL data findings: activity density (SMS 67% / Call 12% / status-change 7% / email 6%), 52 populated lead custom fields across attribution/workflow/payment layers, opportunities are $1 placeholders (money lives in lead custom fields), ~10wk+ retained history, and a metric-by-metric map of the Engine sheet.

**Read both reports fully before designing anything.** They already answer most schema questions with real evidence. Don't re-probe what they cover; do verify any specific field/shape you're about to depend on against the live API or the `.probe-out/close-data/` dumps if they still exist.

Drake has confirmed the funnel semantics (see § Confirmed business logic). The decision is made: **mirror Close's raw objects into Supabase, then compute Engine-sheet metrics on top.** Not Smartview snapshots. This spec builds the mirror tables (migration), the backfill, and the ongoing pipeline.

## Confirmed business logic (from Drake, 2026-05-23 — bake these in)

- **Tier split = Typeform disposable income.** ≥ $2k disposable → qualified → Tier 1 → routes to Closer. < $2k → unqualified → Tier 2 → routes to Setter. The form-level signal lives in the `Investment` / `Marketing Qualified` lead custom fields (per the inventory report). Real qualification happens on the triage call — so form-qualification and call-qualification are two distinct signals; mirror both, don't collapse them.
- **Digital College = open pipe, build nothing now.** Unqualified-for-high-ticket leads will route to a Skool-type course (affiliate links: base44, airwallex). NOT yet built. The schema should not dead-end these leads — leave a clean place for a future "routed_to_digital_college" state — but implement ZERO Digital College logic in this spec.
- **Triage = the phone call where a human qualifies the lead.** Two count-paths exist (a `LeadStatusChange` event vs the `Triage Showed = Yes` custom field) that may not give identical daily counts. **Builder picks whichever is more active/reliable in the real data, documents the choice, and that becomes canonical.** The sales team sticks to it going forward.
- **First Message Response = first interaction on first outreach, channel-agnostic (SMS + call, NOT email).** An auto-SMS fires within minutes of opt-in. A first response = the lead replies to that SMS OR picks up when a setter first calls. Email is explicitly NOT part of this metric. So it's a derived signal off the SMS-inbound + call-connected activity streams.
- **Build funnel-order, top-down.** Ad → Opt-in → Tier split → Triage → Booked meeting → Show → Close → Cash. Schema covers the whole funnel; ingestion + verification prioritize the top (opt-ins + attribution are 100%-populated and cleanest) and work down.

## Step 0 — reconcile against the real Engine sheet FIRST

The literal CSV was NOT in Builder's hands during discovery, so the inventory report's metric map is an *inferred* baseline. **Drake has placed the CSV in the working tree at repo root as `Data_Sheet_-_Overall_Engine.csv` — it is NOT committed to git, so read it from local disk, do not look for it in the repo tree.** Before designing schema:
1. Read the CSV. It's structured as: col A = section (ADVERTISING / CONTENT / FUNNELS / APPOINTMENT SETTING / CLOSING / SALES DATA / BACK END REV / BUSINESS COSTS / FULFILLMENT), col B = metric name, col C = source system, then one column per day.
2. Cross-reference the APPOINTMENT SETTING + CLOSING rows (the Close-sourced ones) against the inventory report's metric map. Flag any sheet row that the report didn't map, and any mapped metric that isn't actually on the sheet.
3. Note (don't build) which rows are sourced from Typeform / Calendly / Meta / EOC Forms — those are other ingestion sources, out of scope here. The goal is to know exactly which sheet rows THIS spec's tables must be able to produce.

This reconciliation goes in the report. If it surfaces a metric that needs a field/object we didn't mirror, that's a design input — fold it in or flag it explicitly as deferred.

## Context Builder needs

- **Auth:** `CLOSE_API_KEY` in `.env.local` (Drake confirms it's there + has access). HTTP Basic, key-as-username + empty-password (trailing colon). Confirm `GET /me/` 200 before backfilling.
- **Pattern to mirror:** `ingestion/fathom/` is the established ingestion shape — thin adapter (external payload → internal record), one `pipeline.py` orchestrating idempotent upserts keyed on stable external IDs, fail-soft, audit via `webhook_deliveries`. Read it before writing `ingestion/close/`. Reuse `shared/` helpers (db, logging, claude_client not needed here). Backfill scripts follow the `scripts/backfill_*.py --smoke / --apply / --limit` convention with a real-API smoke test before any bulk `--apply` (CLAUDE.md § Operational patterns — this is a hard requirement).
- **Migration mechanics:** next number is **0043**. Follow the existing migration file conventions (look at recent ones e.g. 0038/0040 for table-creation style: `set_updated_at()` trigger, partial indexes on archival, etc.). Dual-verify post-apply (schema reality via `to_regclass`/`information_schema` AND ledger via `supabase_migrations.schema_migrations`) per `docs/runbooks/apply_migrations.md`. psql isn't installed — use psycopg2 against the pooler URL for verification.
- **Schema docs:** every new table gets a `docs/schema/<table>.md` per CLAUDE.md § Documentation. New ingestion pipeline gets a `docs/runbooks/` entry.

## Proposed table set (validate against real data before finalizing — this is a starting sketch, not gospel)

From the inventory report's recommendation. Builder confirms shapes against actual API responses and adjusts with documented reasoning:
- `close_leads` — lead mirror: `close_id` (stable PK from Close), `status_id`, `status_label`, `display_name`, contact info, `date_created`/`date_updated`, owner fields, and the populated custom fields denormalized (or a normalized `close_lead_custom_fields` child table — Builder's call based on how many fields matter; 52 populated of 88 defined, so denormalizing all 88 is wasteful — lean toward mirroring the funnel-relevant subset as typed columns + a jsonb catch-all for the rest).
- `close_lead_status_changes` — the funnel spine: `close_activity_id` PK, `lead_id` FK, `old_status_id`, `new_status_id`, `user_id`, `date_created`. This is what triage/booking/no-show/DQ/downsell/deposit/client daily counts compute from.
- `close_calls` — call activities: `direction`, `user_id`, `duration`, `date_created`, `lead_id`. Dial counts + connected calls + first-response-via-call.
- `close_sms` — SMS activities (the dominant channel): `direction`, `user_id`, `date_created`, `lead_id`, `status`. First-message-response-via-SMS.
- `close_opportunities` — mirror for the workflow state machine (Opt-Ins → Confirmed booking → DQ); note value is a $1 placeholder so do NOT treat as money. Include if it adds funnel signal; drop if redundant with lead-status-changes (Builder's call, documented).
- `close_custom_field_definitions` — reference table of the field id→name→type→choices map so the dashboard/agg layer can resolve `cf_*` ids to labels without hardcoding. Cheap, high-value.
- Email: the inventory shows email at 6% and Drake dropped it from First-Message-Response. Mirror `close_emails` ONLY if a reconciled Engine-sheet metric needs it; otherwise defer (note in report).

**Money note:** payment data (`Amount of Nth payment?`, `Date of Nth payment?`, `Type of Payment On Call`, `Closed?`, etc.) lives as lead custom fields and is text-typed (e.g. `'1133'`). Mirror these as part of `close_leads` (or its custom-field child), cast/validate to numeric in the ingestion layer, and handle dirty values defensively (could be `$1,133` or `1,133`). Don't pull money from `close_opportunities`.

## What to build

1. **Migration 0043** — the mirror tables above (final set per Builder's validated design). Each with the standard `created_at`/`updated_at` + trigger, indexes for the per-day aggregation queries (e.g. `(new_status_id, date_created)` on status-changes, `(user_id, date_created)` on calls). **HARD STOP for Drake's SQL review before apply** — gate (a). After approval, Builder applies + dual-verifies.
2. **`ingestion/close/`** — adapter + pipeline mirroring the Fathom pattern. Idempotent upserts keyed on Close's stable IDs (re-running never duplicates). Fail-soft per record. Audit via `webhook_deliveries.source='close_*_ingest'`.
3. **Backfill script** `scripts/backfill_close.py` with `--smoke` (one lead + its activities, end-to-end against real DB) / `--apply` / `--limit`. Smoke MUST pass before any bulk apply. Backfill pulls full retained history (the streams aren't trimmed per the inventory report). **HARD STOP before the bulk `--apply`** — it writes production rows at scale; Drake confirms the smoke result first (gate — first large production write of this arc).
4. **Ongoing ingestion — pipeline for new data.** Drake wants new data flowing, not just a one-time backfill. Investigate Close's webhook subscription support (the inventory report's deferred list flags it) vs a polling cron. **Recommend the approach in the report with reasoning; if webhooks, the subscription setup is Drake's gate (d) + the receiver endpoint is `api/` work — scope it but flag the webhook-registration as a follow-up if it needs Close-side config Drake must do.** A polling cron (mirror the Fathom backfill cron pattern) is the safe default if webhooks need org-side setup that can't happen in this session. Builder's call which to ship now vs defer — document it. Do NOT add a Vercel cron / env var without flagging the gate.

## What success looks like

- Migration 0043 applied + dual-verified; new tables exist with correct indexes.
- `ingestion/close/` mirrors leads + status-changes + calls + SMS (+ opportunities/custom-field-defs per validated design) idempotently.
- Backfill smoke passes against real Close + real Supabase on one lead; then bulk backfill loads history (Drake-gated).
- Re-running the backfill produces zero duplicates (idempotency proven).
- The reconciliation table (Step 0) is in the report: which Engine-sheet rows these tables can now produce, which need other sources.
- Ongoing-ingestion approach decided + either shipped or scoped-with-gate-flagged.
- A row count + sanity check: e.g. "backfilled N leads, M status-changes, oldest X, newest Y; opt-in count for last 7 days = Z" so Drake can eyeball that the numbers look real.

## Hard stops

- **Migration SQL review before apply** (gate a). Don't apply 0043 until Drake reviews the diff.
- **Bulk backfill `--apply`** — smoke first, Drake confirms, then bulk. Don't bulk-write production rows unprompted.
- **Any Vercel env var / cron addition** — flag for gate (d), don't set silently.
- **Webhook registration on Close's side** — if needed, that's Drake's config; scope it, don't assume it's done.
- `CLOSE_API_KEY` missing/misnamed or unrecoverable 401 → stop + report.
- Never write to Close. Never echo the key.

## Think this through — what could go wrong

Text-typed money fields with dirty values breaking numeric casts. Custom-field denormalization choices that lock us into a shape that's painful when the next batch of fields matters. Idempotency key collisions if Close reuses IDs across object types (namespace the PKs). Backfill hitting Close's deep-pagination ceiling on large pulls (the inventory report flagged the Export API as the alternative for cold-start — consider it if plain pagination caps out). The triage-count-path choice giving numbers that don't reconcile with what the sales team expects — document the choice loudly so Drake can sanity-check against the sheet. Surface all of this honestly.

## Mandatory doc updates

- `docs/schema/<table>.md` for every new table.
- `docs/runbooks/close_ingestion.md` — backfill + ongoing-ingestion runbook (schedule/trigger, failure modes, idempotency, re-run safety, the triage-count-path decision, the tier-derivation logic).
- `.env.example` — `CLOSE_API_KEY` is documented from the discovery spec; add any new vars (webhook secret / cron secret) only if the ongoing-ingestion approach needs them, flagged as gate (d).
- `docs/state.md` — add the Close ingestion entry in the same commit-sequence (migration count → 43, new tables, new ingestion module, backfill counts). This is a shipped subsystem.
- CLAUDE.md § Folder Structure — add `ingestion/close/` to the tree (small edit, rides in this spec's Builder work).
- The report at `docs/reports/close-ingestion-v1.md`.
