# Airtable Live Ingestion — Setter Triage + Full Closer (US + AUS) Mirror + Webhook + Cron Backstop
**Slug:** airtable-ingestion
**Status:** shipped
**Target branch:** main

## ⚠️ Parallel-work landscape — READ FIRST

You are Builder in the **`worktree-b` worktree** (`~/projects/ai-enablement-b`). Execute on `worktree-b`, NOT `main`. `git status` + `git branch --show-current` + `git log --oneline -10` first; confirm `worktree-b`. Re-read every file you touch from current disk state.

- This spec lives on `main` (how you're reading it). Specs push to `main`; code + report commits target `worktree-b`.
- **Migration number is PINNED to `0050`.** Do NOT auto-detect. Ledger: 0046 Wistia, 0047 Calendly, 0048 Typeform, 0049 Clarity. Airtable is `0050`. Hardcode it in the filename + ledger version.
- **One shared cloud Supabase.** The `0050` apply hits the same DB other sessions migrate against. **Migration apply is gate (a) — Builder writes + reviews the SQL, STOPS before apply, surfaces to Drake, who sequences the apply timing.** Do NOT apply autonomously even though the CLI works.
- **MERGE-CONFLICT AVOIDANCE (do this deliberately — it bit us on Typeform):** the shared files (`vercel.json`, `.env.example`, `docs/state.md`, `CLAUDE.md` § Folder Structure) merge-conflict because every source appends to them. **Append your additions at the END of each file's relevant section/array, AFTER all existing entries (Calendly/Clarity/Typeform), not interleaved among them.** In `vercel.json` add your two function entries after the last existing function entry and your cron after the last existing cron; in `.env.example` add a new Airtable block at the end; in `state.md` add your entry at the end; in `CLAUDE.md` add `ingestion/airtable/` after the last `ingestion/*` line. This makes git auto-merge instead of conflicting. Keep edits append-only; don't reformat surrounding entries.

## Why this exists

Airtable discovery (`docs/reports/airtable-discovery.md` on `worktree-b` — **read it fully first**) confirmed two funnel tables in base `appCWa6TV6p7EBarC` that feed Engine-sheet rows living nowhere else in our mirror. This makes them live. Core Principle #1: mirror everything into Supabase; the sales dashboard reads from Supabase, never from Airtable.

**What these tables ARE (from discovery + the Engine sheet):**
- **Full Closer Report** = the ENTIRE Engine-sheet Closing section (rows 96–116): Showed/CCMI/No-Show/Reschedule/Cancel dispositions, deposits, closed deals (by meeting type + attribution), all five Cash Collected buckets. Money-critical.
- **Setter Triage Calls** = the setter-side Appointment Setting rows: triage outcomes (Show/No-Show), booking status (Booked/DQ/Downsell).
- **AUS variant of Full Closer Report** (`tblcC25y6lMrtgcty`, 64 fields) — Drake wants the AUS funnel mirrored too. Same shape as US (66 fields); mirror into the same `airtable_full_closer_report` table with a `region` discriminator column (`'US'` / `'AUS'`), NOT a separate table — the field sets overlap ~entirely and the dashboard wants them unioned-or-split by region. Map AUS fields to the same typed columns; any AUS-only fields land in `fields_raw`.

**Decision: webhook for live + cron backstop + 1-day backfill** — same shape as Typeform. BUT discovery surfaced a structural fact that makes the webhook load-bearing, not optional (see below).

## ⚠️ The structural fact that shapes everything: NO stored timestamp → webhook is the ONLY edit-detection path

Discovery confirmed: **neither table has a `lastModifiedTime` or `createdTime` FIELD.** Incremental can only use Airtable's record-level `createdTime` metadata, which is **created-only** — it catches NEW records but is blind to EDITS of existing records. A closer who saves `Closed? = No` and later updates it to `Yes` produces NO new-record signal. So:
- **The cron backstop catches new records only** (via `CREATED_TIME()` filter). It is a safety net for missed webhook *creations*, not a full reconciler.
- **The live webhook is the ONLY way to catch edits.** Airtable's webhook fires on record changes (create AND update) within the base. This is why the webhook is structurally required here, unlike Typeform where the cron could fully backstop.
- Document this prominently. The dashboard's correctness on any edited-after-creation field (dispositions, money entered later) depends on the webhook being live.

## Scope — what's live, what's flagged-pending

**In scope (mirror, live):** Setter Triage Calls (`tblaoMsiE3FSkHjQt`), Full Closer Report US (`tblYsh3fxTpXuPdIW`) + AUS (`tblcC25y6lMrtgcty`). Backfill 1 day, then live. Mirror EVERY field — typed hot columns for the Engine-rollup fields + `fields_raw jsonb` catch-all for everything else (so the ambiguous fields below are all stored regardless).

**Explicitly OUT of scope:**
- The other 7 tables in the base (Sales Team Member, Contract Forms, EODs, etc.) — future specs.
- The dropped tables (Closer Booked Calls, Setter Direct Bookings) — Drake dropped them.
- **Resolving the field ambiguities below** — they're mirrored raw; resolution happens at the dashboard/aggregation layer, NOT here.

## The five discovery ambiguities — MIRROR RAW, resolve at aggregation (Drake's explicit call)

Discovery flagged five real ambiguities. **Drake's decision: mirror all of them raw; on the dashboard these specific rows render NULL/empty with a "pending — field confirmation needed" flag rather than a guessed number.** Do NOT try to resolve them in the ingestion — store everything, let the dashboard flag them. For this spec, that means: ensure every one of these fields is captured (typed column where clean, `fields_raw` always), and DOCUMENT each as a known-unresolved aggregation input in the runbook + schema doc.

1. **Objection categorization** (Engine Closing rows: Shopping Around / Think-About-It-Fear / Spouse) — NO field feeds these. Likely free-text in `Call Notes (Lead lost):`. Mirror the notes field; the three objection rows are dashboard-pending (no structured source).
2. **Direct-booking-led vs setter-led attribution** — hypothesized as `Setter Name` populated/empty, but it was empty on all 3 closer samples. Mirror `Setter Name` (as `setter_record_ids text[]`); ALSO compute a derived `is_setter_led boolean = cardinality(setter_record_ids) > 0` column BUT mark it provisional in the schema doc (the hypothesis is unconfirmed; dashboard flags attribution rows pending a fill-rate check). Capture a wider sample observation if cheap during smoke (note the fill rate you observe), but don't block on it.
3. **Canonical "cash paid today"** — two fields (`How much did they pay today?/How much are they paying upfront?` currency AND `Amount they paid today?` number). Mirror BOTH into distinct typed columns (`amount_paid_today_currency numeric`, `amount_paid_today_number numeric`); dashboard picks canonical later.
4. **Three near-duplicate payment-on-call fields** (`Paid On Call?` checkbox, `Did they pay on the call?` singleSelect, `Have you already sent a contract?` singleSelect, `Contract Sent?` checkbox) — mirror all (typed where clean); dashboard picks canonical.
5. **Two typo'd "Financed/Cash/Both" fields** — mirror both into `fields_raw` (don't bother with typed columns for these); dashboard picks canonical.

The principle: **the mirror is lossless and opinion-free; every ambiguity is a read-time decision the dashboard makes, flagged until Drake/Aman resolve it.**

## Context Builder needs

**Re-read the discovery report + the probe `scripts/explore_airtable_api.py` on `worktree-b`** for the verified field inventories, the per-table incremental verdict, the masked record shapes, and the type-serialization notes. Don't re-derive.

**Mirror the existing ingestion + webhook-receiver patterns — read BEFORE writing:**
- `ingestion/close/` (`client.py`/`parser.py`/`pipeline.py`) — urllib thin client, JSON-projection parser with typed-columns + `custom_fields_raw` jsonb hybrid (the exact pattern for our `fields_raw`), idempotent `ON CONFLICT` upsert.
- `ingestion/typeform/` (just shipped on worktree-b, merged to main) — the closest precedent: webhook + cron backstop + backfill, one parser serving webhook + pull paths, the `_notify_*` seam. Mirror its structure.
- `api/typeform_events.py` — webhook receiver shape (verify-first, fail-soft 2xx, audit-dedup). Airtable's differs (see below) but the skeleton matches.
- `api/wistia_sync_cron.py` / `api/meta_sheet_sync_cron.py` — cron shape (CRON_SECRET bearer, audit row, fail-soft).
- Confirm the `webhook_deliveries` audit contract on disk (status CHECK allows `received/processed/failed/duplicate/malformed`; skip rows use `processed` + `processing_error='skipped_*'`).

**How Airtable webhooks work (verified in discovery — confirm against live docs; this is DIFFERENT from Typeform):**
- Webhooks are per-BASE, created via `POST /v0/bases/{baseId}/webhooks` with a `specification` filter (scope to the two tables + change types). Requires `webhook:manage` scope.
- **Notification-only, pull-payload model:** Airtable POSTs a bare ping to your URL (no record data). Your receiver must then call `GET /v0/bases/{baseId}/webhooks/{webhookId}/payloads?cursor=<n>` to fetch what changed. The response carries `changedTablesById` + a `cursor` for the next call. Advance + persist the cursor so you don't re-fetch or miss payloads.
- The receiver disambiguates which of the two/three tables changed (`changedTablesById`) and routes to per-table parsers, then fetches the changed records' full current state via the records API and upserts.
- Webhook expires after 7 days of inactivity unless refreshed — note the refresh requirement (a periodic `PATCH .../webhooks/{id}/refresh` or the cron re-asserting it). Confirm current expiry behavior against docs.
- Ping auth: Airtable webhook notifications include a MAC the receiver should verify against the webhook's `macSecretBase64` (returned once at creation). Confirm the signature scheme against current docs; verify it like Typeform's.

## What to build

**Migration `0050`** (`supabase/migrations/0050_airtable_mirror.sql`):
- `airtable_setter_triage_calls` — `record_id text PK`, `airtable_created_at timestamptz NOT NULL` (record-metadata createdTime), typed hot columns (`lead_id`, `prospect_name`, `outcome`, `booking_status`, `showed_pct boolean`, `no_show_pct boolean`, `booked_with_closer boolean`, `setter_record_ids text[]`, `setter_names text[]`, `event_date_time timestamptz`, `confirmed_call_date_time timestamptz`, `booked_at timestamptz`, `submitted_at date`, `notes text`), `fields_raw jsonb NOT NULL`, `synced_at`/`created_at`/`updated_at` + trigger.
- `airtable_full_closer_report` — `record_id text PK`, `region text NOT NULL` (`'US'`/`'AUS'` discriminator), `airtable_created_at timestamptz NOT NULL`, typed hot columns per the discovery sketch (`lead_id`, `prospect_name`, `prospect_email`, `prospect_phone`, `call_type`, `date_time_of_call timestamptz`, `call_recording`, `call_notes`, `call_notes_lost`, `closer_record_ids text[]`, `closer_names text[]`, `setter_record_ids text[]`, `setter_names text[]`, `showed`, `closed`, `lost_deal`, `no_show_reason`, `paid_on_call boolean`, `contract_sent boolean`, `follow_up`, `amount_paid_today_currency numeric`, `amount_paid_today_number numeric`, `deposit_amount numeric`, `total_contract_amount numeric`, `income numeric`, `payment_status`, `payment_plan_type`, `program_type`, `industry`, `location`, `is_setter_led boolean` [provisional, derived]), `fields_raw jsonb NOT NULL`, `synced_at`/`created_at`/`updated_at` + trigger.
- Indexes: `airtable_full_closer_report` on `(date_time_of_call desc)`, `(closed) WHERE closed = 'Yes'`, GIN on `closer_record_ids`, GIN on `fields_raw`, `(region)`. `airtable_setter_triage_calls` on `(booked_at desc)`, `(setter_record_ids)` GIN.
- Loose FK convention only (no enforced FK) — matches close/wistia/typeform precedent.
- **HARD STOP for Drake's SQL review before apply (gate a), sequenced against other sessions.** Post-apply dual-verify: `to_regclass` non-null for both tables AND ledger `version='0050'` = exactly 1 row.

**Ingestion module `ingestion/airtable/`** mirroring `ingestion/typeform/`:
- `client.py` — urllib Bearer (`AIRTABLE_SALES_PAT`), base `https://api.airtable.com`. Methods: `list_records(table_id, *, filter_by_formula=None, page_size=100, offset=None)` (paginate via `offset`), `get_base_schema()`, plus webhook helpers `list_webhooks()`, `create_webhook(spec)`, `get_webhook_payloads(webhook_id, cursor)`, `refresh_webhook(webhook_id)`. Retry on 429 (5 req/sec/base limit), hard-error on 401/403. **Records path is `/v0/{baseId}/{tableId}` (no `/meta`); Meta path is `/v0/meta/bases/{baseId}/tables` — don't confuse them.**
- `parser.py` — `parse_setter_triage(record)` + `parse_full_closer(record, region)` → row dicts. Each takes an Airtable record (`{id, createdTime, fields}`), maps known fields to typed columns, casts (currency/number → numeric, dateTime → ISO, multipleRecordLinks → text[], singleSelect → str), and dumps the COMPLETE `fields` dict into `fields_raw`. Handle empty-field-omission gracefully (missing key → NULL column, present in raw only if Airtable sent it). Compute `is_setter_led` from `setter_record_ids` cardinality (mark provisional).
- `pipeline.py` — `sync_table(table_id, *, since=None, region=None)` (paginate records, optional `CREATE_TIME()` filter, upsert on `record_id`), `sync_all(*, since=None)` (the two/three table+region pairs), `upsert_from_webhook_payload(changed_records)` (the webhook path — fetch changed records' current state, parse, upsert). All idempotent `ON CONFLICT (record_id) DO UPDATE`.

**Webhook receiver `api/airtable_events.py`** — mirror `api/typeform_events.py` skeleton, Airtable mechanics:
1. Verify the notification MAC against the stored webhook secret (`AIRTABLE_WEBHOOK_MAC_SECRET`). Reject bad/unsigned.
2. On valid ping: read the webhook_id, call `get_webhook_payloads(webhook_id, cursor=<persisted>)`, advance + persist the cursor (store in a small state row — reuse `webhook_deliveries` or a dedicated `airtable_webhook_cursor` row; Builder's call, document it).
3. For each changed record in the payload: determine table (US closer / AUS closer / setter triage), fetch current record state, parse, upsert via pipeline.
4. Audit to `webhook_deliveries` (`source='airtable_webhook'`, dedup on payload cursor/notification id). Fast 2xx, fail-soft.
5. Notify seam: leave a `_notify_*` no-op stub like Typeform's (future Slack-ping-the-team-on-a-new-close, etc.) — build the seam, don't wire it.

**Registration helper `scripts/register_airtable_webhook.py`** — Drake-gated (`webhook:manage` required, which `AIRTABLE_SALES_PAT` does NOT yet have — see gates). `--dry-run`/`--apply`/`--list`/`--delete`. Creates ONE base-level webhook on `appCWa6TV6p7EBarC` scoped (via `specification`) to the two/three tables + record create/update change types, pointed at the deployed receiver URL. Prints the `macSecretBase64` once (Drake stores it as `AIRTABLE_WEBHOOK_MAC_SECRET` in Vercel). Idempotent-ish (list-before-create; don't double-register).

**Backfill script `scripts/backfill_airtable.py`** — `--smoke` (one table, one page, real-API → parse → upsert one row, idempotent) / `--apply` (the 1-day window: `CREATED_TIME()` filter for last 24h across all three table+region pairs) / `--table`/`--full` (full-table if ever needed). 1-day default per Drake. During smoke, note the observed `Setter Name` fill rate on Full Closer (cheap, informs the attribution-hypothesis check). Per the "real-API smoke before --apply" rule.

**Cron backstop `api/airtable_sync_cron.py`** — reconciliation for missed webhook CREATIONS (NOT a full reconciler — it can't see edits, per the structural fact). `CRON_SECRET` bearer auth, pulls last ~6h via `CREATED_TIME()` filter across the three table+region pairs, upserts idempotent. ALSO refreshes the webhook subscription if within the expiry window (keeps the 7-day webhook alive). Cadence: **every 15 min** (`*/15`), mirroring Typeform; justify in the report. Audit `source='airtable_sync_cron'`. `maxDuration: 300`.

## Future seam (build, don't wire)
`_notify_*` no-op stub in the webhook upsert path, like Typeform's — so a future "Slack-ping the team on a new closed deal" is a function body, not a refactor. No Slack post, no env flag now.

## Gates / hard stops

- **Migration `0050` apply** — gate (a). Write + review SQL, STOP before apply, surface to Drake; he sequences vs other sessions. Dual-verify post-apply.
- **`webhook:manage` scope** — `AIRTABLE_SALES_PAT` does NOT have it (discovery confirmed). The webhook CANNOT be registered until Drake adds `webhook:manage` to the PAT (or mints a webhook-mgmt PAT). Gate (d). **The read path (backfill + cron) works on the existing `schema.bases:read`+`data.records:read` — so build + ship everything, and the webhook activation is the gated step.** Don't block the whole spec on this; the cron+backfill go live independently, the webhook lights up when the scope lands.
- **`AIRTABLE_SALES_PAT` in Vercel** — gate (d). It's in `.env.local`; the cron + webhook receiver (payload fetch) need it in Vercel. Drake adds.
- **`AIRTABLE_WEBHOOK_MAC_SECRET` in Vercel** — gate (d). Produced by `register_airtable_webhook.py` at creation time; Drake stores it in Vercel, redeploys. Receiver verifies notifications against it.
- **Registering the webhook** (`register_airtable_webhook.py --apply`) — Drake's action; needs the deployed URL + `webhook:manage`. HARD STOP: Builder writes the helper, Drake runs it.
- **Deploy** via merge-to-main (Vercel deploys from main, not worktree-b) — note Drake's gate (c) post-deploy verification.
- **Order of operations** (spell out precisely in the runbook): (1) Drake reviews + applies 0050 (sequenced), Builder dual-verifies; (2) merge worktree-b→main + deploy; (3) Drake adds `AIRTABLE_SALES_PAT` to Vercel; (4) `backfill_airtable.py --smoke` then `--apply` (1-day seed); (5) Drake adds `webhook:manage` to the PAT; (6) Drake runs `register_airtable_webhook.py --apply` → gets `macSecretBase64`; (7) Drake adds `AIRTABLE_WEBHOOK_MAC_SECRET` to Vercel, redeploys; (8) verify end-to-end (edit a test record in Airtable → confirm the row updates in `airtable_full_closer_report` + audit row); (9) confirm cron audits clean + refreshes the webhook.
- Never write to Airtable EXCEPT the gated webhook create/refresh. Never echo secrets/PII.

## What success looks like

- Migration `0050` written, SQL-reviewed, applied (Drake-sequenced), dual-verified; three logical mirrors (setter triage + closer US + closer AUS into 2 tables, region-discriminated).
- `ingestion/airtable/` mirrors the typeform/close shape; one parser per table serves backfill + cron + webhook; everything mirrored raw + typed hot columns; the five ambiguities all captured + documented as aggregation-layer-pending.
- `api/airtable_events.py` deployed-ready: MAC-verified, pull-payload model with cursor persistence, table disambiguation, fail-soft 2xx, audit, notify-seam unwired.
- `scripts/backfill_airtable.py` (smoke passed, 1-day apply ready), `scripts/register_airtable_webhook.py` (Drake-gated), `api/airtable_sync_cron.py` (every 15 min, refreshes webhook).
- Idempotency confirmed (webhook dup + cron-then-webhook + backfill-then-webhook all no-op on `record_id`).
- Activation runbook `docs/runbooks/airtable_ingestion.md` — the 9-step order, the NO-stored-timestamp/webhook-load-bearing structural note, the `webhook:manage` gate, the five flagged ambiguities, webhook refresh/expiry, how to verify live.
- Tests matching close/typeform density: parser (the real discovery field shapes incl. typed casts, empty-omission, the AUS variant, `is_setter_led` derivation), pipeline (idempotent upsert, `CREATE_TIME()` filter, region discriminator), receiver (MAC verify/reject, cursor advance, table routing, dedup, fail-soft), cron (auth + since-window + webhook-refresh). Run `.venv/bin/python -m pytest tests/`; report count.

## Think this through — what could go wrong

The webhook pull-payload cursor getting lost/desynced (persist it durably; on a gap, the cron's created-only backstop limits damage for new records but NOT edits — note the exposure). The 7-day webhook expiry silently killing live ingestion (the cron's refresh is the mitigation — make sure it actually fires; an un-refreshed webhook is a silent death). MAC signature scheme assumed wrong (verify against a real Airtable ping at step 8; it's the security boundary). The `is_setter_led` hypothesis being wrong (it's marked provisional + dashboard-flagged — don't let it silently drive a "real" number). AUS field mapping differing from US in a field we typed-column'd (the AUS table has 64 vs US 66 fields — map by field NAME, tolerate missing names → NULL, dump all to fields_raw; a name present in AUS but not US lands in raw). The `CREATE_TIME()` filter formula syntax (verify against live API; discovery confirmed the function exists but test the exact formula). Currency vs number type drift on the two cash fields (cast defensively; a string slipping through → NULL not crash). The append-at-end merge discipline being forgotten (interleaving = the Typeform conflict pain again — append after existing entries). Surface all honestly.

## PII
Mirror raw (names/emails/phones/call-notes) — these are sales records the team needs whole; Supabase is service-role-only; no new exposure beyond Airtable. Do NOT hash/split. Test fixtures + report use MASKED values, never real respondent/prospect data committed to git.

## Mandatory doc updates (APPEND-AT-END to dodge merge conflicts)
- New `docs/schema/airtable_setter_triage_calls.md` + `docs/schema/airtable_full_closer_report.md` (columns, region discriminator, the five flagged ambiguities documented as aggregation-pending, the no-stored-timestamp/webhook-load-bearing note, `is_setter_led` provisional flag).
- New `docs/runbooks/airtable_ingestion.md` (9-step activation, structural webhook note, `webhook:manage` gate, ambiguities, webhook refresh/expiry, verify-live).
- `.env.example` — append a new Airtable block at END: `AIRTABLE_SALES_PAT` (needs `schema.bases:read`+`data.records:read`+`webhook:manage`), `AIRTABLE_WEBHOOK_MAC_SECRET` (from registration, gate d).
- `docs/state.md` — append entry at END (distinguish "receiver+cron+backfill shipped" from "live" since webhook activation is gated on `webhook:manage` + registration).
- `CLAUDE.md` § Folder Structure — append `ingestion/airtable/` after the last `ingestion/*` line.
- Report at `docs/reports/airtable-ingestion.md` (worktree-b). Confirm executed branch.
