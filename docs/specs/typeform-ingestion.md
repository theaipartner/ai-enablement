# Typeform Live Ingestion — Mirror Tables + Webhook Receiver + Cron Backstop
**Slug:** typeform-ingestion
**Status:** in-flight
**Target branch:** worktree-b

## ⚠️ Parallel-work landscape — READ FIRST

You are the Builder running in the **`worktree-b` worktree** (`~/projects/ai-enablement-b`, branched off `origin/main`), building in parallel with other source work on `main` (Calendly is building there now; Close/Meta/Wistia already shipped).

- **Execute on `worktree-b`, NOT `main`.** `git status` + `git branch --show-current` + `git log --oneline -10` before anything; confirm you're on `worktree-b`. Re-read every file you touch from its CURRENT state on disk — don't assume.
- **This spec file lives on `main`** (that's how you're reading it). Specs push to `main`; execution + all your code/report commits target `worktree-b`. That's the topology, not a mistake.
- **Migration number is PINNED to `0048`.** Do NOT auto-detect "the next migration number" — another session is building migrations against the same ledger simultaneously and auto-detection WILL collide. Main owns through `0047` (Calendly). This worktree's migration is `0048`. Hardcode it in the filename and the ledger version.
- **One shared production Supabase.** Worktrees isolate code, not the database. When you reach the migration-apply gate, that apply hits the same cloud DB the other session uses — so **migration applies must be sequenced by Drake (gate (a))**. Build + write the migration freely; STOP at apply and surface to Drake. He coordinates the apply ordering against the other session.
- **Shared files that will merge-conflict at integration** (both sessions append to them): `docs/state.md`, `.env.example`, `CLAUDE.md` § Folder Structure list. You DO append to these (they're mandatory doc updates below) — just know the conflict is expected and gets resolved at merge. Append cleanly; don't reformat surrounding entries.

## Why this exists

Typeform discovery (`typeform-discovery`, report on `worktree-b`) confirmed: 31 forms, real response shape captured, full history available, backfill + incremental both viable. This spec makes Typeform a **live data source** — the next sales-side mirror after Close + Meta + Wistia, same Core Principle #1 (mirror everything into Supabase; the sales dashboard reads from Supabase, never from Typeform).

**What these responses ARE (Drake clarified):** top-of-funnel **opt-ins / program inquiries** — people who fill the funnel forms and become **leads**. This is NOT client data. There is **NO `clients` resolution, NO identity-matching, NO auto-creating client rows**. We mirror the raw opt-in stream; the sales dashboard does all slicing/aggregation downstream. Do not build any bridge to the `clients` table.

**Decision: webhooks for live + cron backstop + backfill.** Drake wants new opt-ins visible **the second they come in** — closers may be watching the dashboard to call fresh leads ASAP. So real-time is the primary path (webhooks), with a reconciliation cron as the safety net for any webhook the receiver missed (mirrors Close's "webhooks live, polling backstop retained" pattern). Dashboard-only for now — **no Slack ping yet**, but structure the receiver so a notify hook is a clean future addition (see § Future seam).

## Scope — mirror everything, register webhooks on active forms only

**Mirror (data side): ALL 31 forms, every field, every detail.** Per Drake — "take every form and every detail we can." No per-form allowlist on the mirror. The backfill + the backstop cron both walk all forms. Dead/archived forms simply stop producing new rows; their history still mirrors.

**Webhooks (real-time side): ACTIVE forms only.** Registering a `form_response` webhook is per-form in Typeform (unlike Close's one account-level subscription), and you have 31 forms with more created as funnels iterate. Registering dead forms is wasted plumbing — they never fire. So the registration script targets only **currently-active forms, selected by recency** (forms with a submission within a recent window — lean: last 30 days — NOT a hardcoded id list, so it doesn't go stale as funnels rotate). At discovery time that's PWSNd0h2 (Setter, last 2026-05-21), SFedWelr (Closer, last 2026-05-24), N57lwMmA (Organic, 2026-04-28) and any others inside the window; the big historical forms (w0atrvMi, QmTC4Tx2, poifwp1H) are excluded — they last fired months ago. The cron backstop still mirrors those, so nothing is lost on the data side; they just don't get real-time pings (which they wouldn't anyway, having no traffic).

**Explicitly OUT of scope:**
- **`clients` resolution / identity-matching / client auto-creation** — these are leads, not clients. Do not touch the `clients` table or its `metadata.alternate_*` patterns.
- **Slack notify** — deferred. Build the future seam (§ Future seam), don't wire a live Slack post.
- **Any aggregation / dashboard UI** — this spec is ingestion only. The sales dashboard that reads these tables is a separate future arc.
- **PII hashing/splitting** — Drake's call is mirror raw (see § PII).

## Context Builder needs

**Confirm everything from the discovery report against current disk state on `worktree-b`** — re-read `docs/reports/typeform-discovery.md` and the throwaway probe `scripts/explore_typeform_api.py` (both on `worktree-b`) for the verified API shapes, the `sort`+cursor gotcha, and the response structure. Don't re-derive what the probe already established.

**Mirror the existing ingestion-module + webhook-receiver patterns. Read these BEFORE writing Typeform's — they're the canonical shape for this codebase:**
- `ingestion/close/` (`client.py` / `parser.py` / `pipeline.py`) — the closest analog: urllib-only thin client, JSON-projection parser, idempotent `ON CONFLICT` upserts, backfill + incremental in one pipeline. Match this structure.
- `api/close_events.py` — the canonical webhook receiver: signature-verify first → parse → route by event → call existing pipeline upsert → audit to `webhook_deliveries` → fast 2xx, fail-soft (always 2xx on handled error so the provider doesn't auto-disable the subscription). Synthesized dedup key on `webhook_deliveries.webhook_id` for true duplicates.
- `scripts/register_close_webhook.py` — the canonical subscription-registration helper (Drake-gated to run; prints the signing secret once).
- `api/wistia_sync_cron.py` / `api/meta_sheet_sync_cron.py` — the canonical cron shape: `CRON_SECRET` bearer auth, sync, audit row in `webhook_deliveries`, `maxDuration` headroom. The cron + bulk share one code path.
- Confirm the `webhook_deliveries` audit contract on disk (CHECK on `processing_status` allows `received/processed/failed/duplicate/malformed`; skip rows use `'processed'` + `processing_error='skipped_*'` + `payload.skip_reason=*` per the Slack-ingest precedent).

**How Typeform webhooks work (verified against docs 2026-05-24 — confirm against the live API; don't trust blind):**
- Per-form subscription: `PUT /forms/{form_id}/webhooks/{tag}` creates/updates a webhook (tag is a caller-chosen label, e.g. `ai-enablement-prod`). Body: `{ url, enabled: true, secret, verify_ssl: true }`. The `secret` is caller-SUPPLIED (unlike Close, which generates it) — we provide one shared secret across all registered forms.
- Signature: Typeform signs each delivery with `Typeform-Signature: sha256=<base64(HMAC-SHA256(payload, secret))>`. The receiver MUST recompute over the RAW request body and constant-time compare. Confirm the exact header + encoding (base64, not hex) against current docs — this is the security boundary, get it right.
- Payload: `{ event_id, event_type: "form_response", form_response: { form_id, token, landed_at, submitted_at, definition, answers, hidden, ... } }`. The `form_response` object is the SAME shape the Responses API returns (`answers[]`, `hidden`, `metadata`) — so the parser built for the backfill should handle it with minimal/no adaptation. Verify the envelope; adapt in the receiver, NOT the parser.
- `event_id` is Typeform's idempotency key — use it (or `form_response.token` = `response_id`) for dedup.

## What to build

**Migration `0048`** (`supabase/migrations/0048_typeform_mirror.sql`) — two tables, per the discovery recommendation:
- `typeform_forms` — one row per form: `form_id text PRIMARY KEY`, `title`, `last_updated_at`, `fields jsonb` (flattened `fields[]`), `hidden_fields jsonb`, `definition_synced_at timestamptz`, `created_at`/`updated_at`. The question-ref→title dictionary so the dashboard reads field meaning without re-fetching from Typeform.
- `typeform_responses` — one row per submission: `response_id text PRIMARY KEY` (= `token`), `form_id text REFERENCES typeform_forms(form_id)`, `landed_at timestamptz`, `submitted_at timestamptz`, `metadata jsonb`, `hidden jsonb`, `calculated jsonb`, `answers jsonb` (raw `answers[]`), `ingested_at timestamptz default now()`. Index `(form_id, submitted_at desc)` for time-window dashboard queries; index `submitted_at desc` for cross-form recency. Loose FK (don't hard-fail a response whose form row isn't synced yet — upsert a stub form row or tolerate, your call; note it).
- NO flattened `typeform_response_answers` table this pass — keep answers as jsonb; flattening can be a query-time view in the dashboard spec if needed. (Discovery floated it as optional; defer.)

**Ingestion module `ingestion/typeform/`** mirroring `ingestion/close/`:
- `client.py` — urllib-only thin client, `Authorization: Bearer <TYPEFORM_API_KEY>`, base `https://api.typeform.com`. Methods: `get_me()`, `list_forms()` (paginate), `get_form(form_id)` (definition), `list_responses(form_id, *, since=None, before=None, page_size=1000)`. **CRITICAL: `list_responses` MUST omit the `sort` param when `before`/`after` is set** — Typeform returns HTTP 400 on `sort`+cursor (verified in discovery). Default sort is `submitted_at desc`, which is what cursor backfill wants. Retry on 429 with short back-off, hard-error on 401/403.
- `parser.py` — JSON-projection: `parse_form_definition(raw)` → `typeform_forms` row dict; `parse_response(raw, form_id)` → `typeform_responses` row dict. The webhook `form_response` object and the Responses-API item share a shape — one parser serves both. Key answer mapping on `field.ref` (verified stable + unique within form, AND stable across funnel variants — discovery §4(c)).
- `pipeline.py` — `sync_form_definition(form_id)`, `sync_all_form_definitions()`, `sync_responses(form_id, *, since=None)` (cursor-paginate, upsert on `response_id`), `sync_all_responses(*, since=None)` (walk all forms), `upsert_response_from_webhook(form_response)` (the receiver's entry point — same parser, same upsert). All upserts idempotent `ON CONFLICT (response_id) DO UPDATE` / `ON CONFLICT (form_id) DO UPDATE`.

**Webhook receiver `api/typeform_events.py`** — mirror `api/close_events.py`:
1. Verify `Typeform-Signature` (HMAC-SHA256 base64 over raw body, constant-time compare) against `TYPEFORM_WEBHOOK_SECRET`. Reject unsigned/bad-signed.
2. Parse `event_type` (only `form_response` in scope), extract `form_response`.
3. Call `pipeline.upsert_response_from_webhook()`. If the form definition isn't yet mirrored, sync it lazily (or stub) so the FK holds.
4. Audit to `webhook_deliveries` (`source='typeform_response_webhook'`, dedup key from `event_id`). True duplicates → `duplicate` audit, no-op.
5. Fast 2xx, fail-soft — always 2xx on handled error so Typeform doesn't disable the webhook after repeated failures (confirm Typeform's disable-on-failure behavior + handle).

**Registration helper `scripts/register_typeform_webhooks.py`** — Drake-gated to run:
- Selects active forms by recency (submission within last 30 days — query the Responses API `total_items`/last-submission per form, or read from a freshly-synced `typeform_forms`/`typeform_responses`; pick the cheap path). NOT a hardcoded id list.
- For each active form: `PUT /forms/{form_id}/webhooks/ai-enablement-prod` with the deployed receiver URL + the shared `TYPEFORM_WEBHOOK_SECRET` + `enabled:true`.
- `--dry-run` (list which forms WOULD be registered + why) and `--apply` (actually register) modes, per the operational pattern.
- Prints a clear summary: which forms registered, which skipped (and why). Re-runnable safely (PUT is idempotent on the tag).

**Backfill script `scripts/backfill_typeform.py`** — `--smoke` (one page, one form, real-API end-to-end, idempotent) / `--apply` (full bulk, all forms, all history) / `--form <id>` / `--limit N` modes, per the CLAUDE.md "real-API smoke test before --apply" rule. The bulk walks all 31 forms, cursor-paginates each from newest via `before=<oldest seen token>` until exhausted, upserts. Low volume (largest form ~10k, ~11 requests at page_size 1000) — should run in minutes.

**Cron backstop `api/typeform_sync_cron.py`** — reconciliation sweep, NOT the primary path:
- `CRON_SECRET` bearer auth (consolidated single-var pattern).
- Per tick: `sync_all_form_definitions()` (cheap, keeps the question map fresh as forms are edited) + `sync_all_responses(since=<now - safety_window>)` where the safety window comfortably overlaps the cron cadence (e.g. last 6h on a tighter cadence) so any webhook-missed response is caught. Upsert idempotent — webhook-then-cron double-write is a no-op.
- Cadence: tighter than the 3h Meta/Wistia default since it's a safety net for a real-time path — lean **every 15 min** (`*/15 * * * *`). Justify final choice in the report. `maxDuration: 300` headroom.
- Audit row `webhook_deliveries.source='typeform_sync_cron'`.

## Future seam (build, don't wire)

Structure the receiver so a future Slack-ping-the-closers-on-new-opt-in is a one-function addition, not a refactor — mirror how `agents/gregory/cs_call_summary_post.py` hooks into `ingestion/fathom/pipeline.py:ingest_call`. Concretely: after the successful upsert in `upsert_response_from_webhook`, leave a clean call site (a no-op `_notify_new_response(response_row)` stub, or a documented comment marking where it goes) so a later spec drops in a `shared/slack_post.post_message` call gated on a `TYPEFORM_NOTIFY_*` env flag. Do NOT add the Slack post or the env flag now — just the seam.

## Gates / hard stops

- **Migration `0048` apply** — gate (a). Builder writes + reviews the SQL, STOPS before apply, surfaces the diff to Drake. **Extra coordination here:** the apply hits the shared cloud DB the other session is also migrating against — Drake sequences this apply against the other session's. Do NOT apply autonomously even though the CLI works. Drake reviews SQL AND coordinates timing. Dual-verify (schema reality via `to_regclass` for both tables AND ledger `supabase_migrations.schema_migrations` version `0048`) post-apply.
- **`TYPEFORM_WEBHOOK_SECRET` in Vercel** — gate (d). It's a caller-supplied shared secret (we choose the value; a long random hex string). Document it + how it's generated; Drake adds it to Vercel + redeploys. The same secret value goes into the registration script's PUT calls, so it must match exactly.
- **`TYPEFORM_API_KEY` already exists** in `.env.local` (NOT `_TOKEN` — discovery §4(a); keep the existing name). Confirm it's in Vercel for the cron/backfill; if not, that's gate (d) too.
- **Deploying the receiver to Vercel** — must be live at its public URL before registration can point at it. Deploy via push (Builder-driven, reliable post-2026-05-08) but note Drake's gate (c) post-deploy verification.
- **Registering the Typeform webhooks** (running `register_typeform_webhooks.py --apply`) — Drake's action; creates real Typeform-side subscriptions + needs the deployed URL to exist. HARD STOP: Builder writes the helper, Drake runs it.
- **Order of operations** (spell this out precisely for Drake in the runbook — interdependent): (1) Drake reviews + applies migration 0048 (sequenced vs the other session), Builder dual-verifies; (2) merge + deploy receiver to Vercel; (3) confirm the function URL is reachable; (4) Drake generates + adds `TYPEFORM_WEBHOOK_SECRET` to Vercel, redeploys; (5) run backfill `--smoke` then `--apply` to seed history; (6) Drake runs `register_typeform_webhooks.py --apply` pointing at the deployed URL with the same secret; (7) verify a real opt-in flows end-to-end (submit a test response on an active form → confirm a `typeform_responses` row lands within seconds); (8) confirm the cron backstop fires + audits clean.
- Never write to Typeform beyond the gated webhook-registration PUTs. Never echo secrets. No PII in committed code/logs/report.

## What success looks like

- Migration `0048` written, SQL-reviewed, applied (Drake-sequenced), dual-verified; both tables present.
- `ingestion/typeform/` mirrors the Close shape; one parser serves backfill + webhook.
- `api/typeform_events.py` deployed-ready: verifies signatures, upserts via the pipeline, audits, fast 2xx, fail-soft. Notify seam present but unwired.
- `scripts/backfill_typeform.py` (smoke passed, bulk ready) seeds all-form history.
- `scripts/register_typeform_webhooks.py` ready for Drake, recency-selected active forms, dry-run + apply.
- `api/typeform_sync_cron.py` backstop live, idempotent against the webhook path.
- Idempotency confirmed end-to-end (webhook dup + webhook-then-cron + backfill-then-webhook all no-op on `response_id`).
- A precise activation runbook (`docs/runbooks/typeform_ingestion.md`) covering the 8-step order-of-operations + failure/retry behavior + the active-form recency rule + how to verify live + how to re-register when a new funnel form is created.
- Tests: parser (real discovery-confirmed shapes incl. choice/contact_info-flattening/hidden/calculated), pipeline (idempotent upsert, cursor pagination omitting `sort`), receiver (signature verify/reject + routing + dedup + fail-soft 2xx), cron (auth + since-window + audit). Match the per-source test density of close/meta/wistia ships. Run via `.venv/bin/python -m pytest tests/`; report the count.

## Think this through — what could go wrong

Webhook payload envelope differing from the Responses-API item shape the parser was built against (verify the real `form_response` object; adapt in the receiver, not the parser). Signature scheme assumed wrong — base64 vs hex, raw-body vs parsed, header name — this is the security boundary; verify against live Typeform docs + a real delivery. The `sort`+cursor HTTP 400 regressing into the backfill if someone "tidies up" the client (it's load-bearing that `list_responses` omits `sort` under cursor — comment it loudly). Typeform disabling a webhook after repeated non-2xx — hence always-2xx-on-handled-error. The 30-day active-form window being wrong for a form that fires monthly (note it; the cron backstop covers any gap so it's non-fatal, but flag the tradeoff). Migration 0048 colliding IF auto-detection is used instead of the pinned number (DON'T — it's pinned for exactly this reason). The shared-DB apply racing the other session (Drake sequences; don't apply autonomously). Loose FK on a response arriving before its form definition is synced (lazy-sync or stub the form row). PII leaking into the committed report/tests (use masked fixtures, mirror the discovery probe's redaction). Surface all honestly.

## PII

Drake's call: **mirror raw**, including emails/phones/names in `answers` and IP in `hidden`. Rationale — the data already lives in Typeform's DB (we create no new exposure), Supabase is service-role-only, and these are lead records the sales team needs whole. Do NOT hash or split. BUT: test fixtures + the report use masked values (`<redacted-email>` etc.), never real respondent data committed to git.

## Mandatory doc updates

- New `docs/schema/typeform_forms.md` + `docs/schema/typeform_responses.md` (one per table per CLAUDE.md § Documentation: purpose, columns, relationships, what populates it, what reads from it, example queries).
- New `docs/runbooks/typeform_ingestion.md` — backfill modes + the 8-step activation runbook + active-form recency rule + webhook re-registration + cron cadence rationale + failure/retry behavior + how to verify live.
- `.env.example` — add `TYPEFORM_API_KEY` (confirm existing name) + `TYPEFORM_WEBHOOK_SECRET` (caller-supplied, gate (d), how to generate). Append cleanly; this file merge-conflicts with the other session — expected.
- `docs/state.md` — add the live-ingestion entry (distinguish "receiver + cron shipped" from "live in production" since activation is Drake-gated: apply + deploy + register). Append cleanly; merge-conflict expected.
- `CLAUDE.md` § Folder Structure — add `ingestion/typeform/`. Minimal edit; merge-conflict expected.
- Report at `docs/reports/typeform-ingestion.md` (on `worktree-b`). Confirm in the report which branch you executed on (`git branch --show-current`) — parallel-work integrity check.
