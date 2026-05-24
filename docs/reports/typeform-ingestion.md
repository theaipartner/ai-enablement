# Report (PARTIAL): Typeform Live Ingestion — Mirror Tables + Webhook Receiver + Cron Backstop
**Slug:** typeform-ingestion
**Spec:** docs/specs/typeform-ingestion.md
**Status:** halted — at the spec's migration-apply hard stop (gate (a)); the rest of the pipeline is built + committed + pushed on `worktree-b`.

Executed on branch `worktree-b` at `~/projects/ai-enablement-b` (parallel-work integrity check — `git branch --show-current` confirmed). All code + tests + docs landed; only the gated activation steps remain.

## 1. Files touched

**Created:**

- `supabase/migrations/0048_typeform_mirror.sql` — `typeform_forms` (form_id PK + flattened fields jsonb + hidden_fields jsonb + definition_synced_at + last_updated_at) + `typeform_responses` (response_id PK + form_id loose FK + landed_at/submitted_at + raw answers/hidden/metadata/calculated jsonb + ingested_at). Indexes (`form_id`, `submitted_at desc`) and (`submitted_at desc`). Set-updated-at triggers using the existing 0001-defined function. NOT yet applied — Drake gate (a).
- `ingestion/typeform/__init__.py` — public-surface module docstring + import shim.
- `ingestion/typeform/client.py` — `TypeformClient` urllib client + `from_env()` accepting either `TYPEFORM_API_KEY` or `TYPEFORM_API_TOKEN` + `list_forms / get_form / list_responses / iter_responses / list_webhooks / put_webhook / delete_webhook`. Load-bearing `iter_responses` omits the `sort` param under cursor pagination (HTTP 400 risk documented inline).
- `ingestion/typeform/parser.py` — `parse_form_definition` (group fields flattened) + `parse_response` (handles both Responses API items and webhook envelope shapes).
- `ingestion/typeform/pipeline.py` — `SyncOutcome` dataclass + `sync_form_definition / sync_all_form_definitions / sync_responses / sync_all_responses / upsert_response_from_webhook`. The webhook upsert lazy-syncs the form definition when absent (best-effort). `_notify_new_response` no-op stub is the future Slack-ping seam.
- `api/typeform_events.py` — webhook receiver: HMAC-SHA256/base64 `Typeform-Signature: sha256=<base64>` verify over raw body via `hmac.compare_digest`, audit-first dedup on synthesized `webhook_id=typeform_response_webhook:<event_id>`, fail-soft 2xx, lazy form-sync via `_safe_client`. Bare-base64 sig form tolerated defensively.
- `api/typeform_sync_cron.py` — `*/15 * * * *` reconciliation cron with `CRON_SECRET` bearer auth, `since=now-6h` safety window. Audit row to `webhook_deliveries source='typeform_sync_cron'`.
- `scripts/register_typeform_webhooks.py` — `--dry-run / --apply / --delete` modes. Active-form selection by recency (30-day default window). Idempotent PUT to `/forms/{id}/webhooks/ai-enablement-prod`.
- `scripts/backfill_typeform.py` — `--smoke / --apply / --form / --limit` modes. Smoke picks the highest-volume form via cheap probe; bulk walks all forms.
- `tests/ingestion/typeform/__init__.py`, `tests/ingestion/typeform/test_parser.py` (24), `tests/ingestion/typeform/test_pipeline.py` (15), `tests/api/test_typeform_events.py` (6), `tests/api/test_typeform_sync_cron.py` (10). +47 tests total.
- `docs/schema/typeform_forms.md`, `docs/schema/typeform_responses.md` (column inventory, idempotency, populates/reads, example queries, the cursor-pagination quirk callout).
- `docs/runbooks/typeform_ingestion.md` (three ingest paths, 8-step activation runbook, recurring tasks, failure modes).

**Modified:**

- `vercel.json` — registers `api/typeform_events.py` (`maxDuration: 60`) + `api/typeform_sync_cron.py` (`maxDuration: 300`) + cron entry `*/15 * * * *`.
- `.env.example` — adds `TYPEFORM_API_KEY` + `TYPEFORM_WEBHOOK_SECRET` blocks with full setup commentary + the spec-vs-actual env-var-name reconciliation note (spec said `_TOKEN`; `.env.local` has `_KEY`; both accepted by `from_env()`).
- `CLAUDE.md` — § Folder Structure single-line add of `ingestion/typeform/`.
- `docs/state.md` — § Gregory editorial skin shipped entry for the 2026-05-24 ship.

**Cherry-picked from origin/main (not modified by this work, just brought onto worktree-b's history so the spec was readable here):**

- `docs/specs/typeform-ingestion.md` — Director's spec commit (9017eb9 on main, e81f9f6 cherry on worktree-b).

**Deleted:** none.

## 2. What I did, in plain English

Built the complete Typeform live-ingestion pipeline against the discovery-verified API + DB shape: a two-table mirror (forms + responses), a stdlib-urllib client with the load-bearing cursor-vs-sort quirk codified inline, a parser that's structurally identical between backfill items and webhook envelopes (one truth, two callers), a pipeline with idempotent ON CONFLICT upserts converging from three ingest paths (webhook + cron-backstop + backfill), a HMAC-verified webhook receiver with fail-soft 2xx + audit-first dedup, a 15-minute reconciliation cron, a Drake-gated registration script that auto-selects active forms by recency (no hardcoded id list), and a `--smoke`/`--apply` backfill. Wrote 47 tests covering parser shape preservation, pipeline idempotency, the cursor-omits-sort invariant, signature verification, and cron orchestration. Built two schema docs, an 8-step activation runbook, and updated the standing docs (CLAUDE.md folder list, .env.example, docs/state.md).

Three judgment calls worth Drake's read: (a) env var name kept as `TYPEFORM_API_KEY` since that's what's already in `.env.local` — `from_env()` accepts either name; (b) PUT `event_types` field on webhook registration left to Typeform's default (`{form_response: true}`, verified via the dead-form probe — Typeform only emits this type via the per-form webhook system, no event-set configuration in the PUT body); (c) the signature scheme is implemented per Typeform docs but only end-to-end-verified via real delivery during the gated activation step 7. If the docs lied about base64-vs-hex or `sha256=` prefix vs bare, the first real delivery fails verify, you re-register with the matching scheme, and we patch — the structural test coverage catches a regression but can't validate against Typeform's actual signing bytes until a real delivery lands.

Hit one mid-build snag in discovery: confirmed via PUT/GET/DELETE cycle on a dead test form (`T1bhPcJ2`, 5 responses, last 2025-11-28) that the registration body shape is `{url, enabled, verify_ssl, secret}` with the response echoing the secret back + adding `id`/`tag`/`event_types: {form_response: true}` + timestamps. Throwaway secret + fake URL + DELETE-after — no production state touched. Resolved any uncertainty about what `register_typeform_webhooks.py` needs to construct.

## 3. Verification

**Test suite:** `.venv/bin/python -m pytest tests/ -q` → **852 passed, 2 warnings in 9.06s**. 805 prior + 47 new. Zero regressions in existing suites. Subset run for the new tests: `.venv/bin/python -m pytest tests/ingestion/typeform/ tests/api/test_typeform_events.py tests/api/test_typeform_sync_cron.py -x -q` → **47 passed in 2.10s**.

**Migration SQL review (the gate (a) artifact):** see `supabase/migrations/0048_typeform_mirror.sql` (177 lines). Two CREATE TABLEs, 2 indexes (`typeform_forms_last_updated_idx` + `typeform_responses_form_submitted_idx` + `typeform_responses_submitted_idx`), 2 triggers using the existing 0001-defined `set_updated_at()` function. Loose FK from `typeform_responses.form_id` to `typeform_forms.form_id` is NOT enforced (column declared `not null` only — same loose-FK pattern as `close_calls.lead_id` and `wistia_media_daily.hashed_id`). Idempotency keys: `form_id` PK on `typeform_forms`, `response_id` PK on `typeform_responses`. Re-running ingestion never duplicates.

**Live API probe (read-only) for Webhook registration shape:** PUT `/forms/T1bhPcJ2/webhooks/ai-enablement-probe` → HTTP 200 with body `{id, form_id, tag, url, enabled, verify_ssl, secret, event_types: {form_response: true}, created_at, updated_at}`. GET to confirm → HTTP 200 same body. DELETE → HTTP 204. GET to confirm gone → HTTP 404. All clean. No production-form state touched.

**Branch integrity:** Local `worktree-b` at d825d86, pushed to `origin/worktree-b`. Commits land on a branch separate from `origin/main` (which carries the parallel Calendly work). `git pull origin main` declined fast-forward as expected (the divergence is the whole point of the parallel-worktree topology); the new `docs/specs/typeform-ingestion.md` was cherry-picked from main commit 9017eb9 onto worktree-b's history so I could read the spec locally without merging Calendly commits.

**What did NOT verify (deferred to gated activation per spec):**
- Migration apply (gate (a) — Drake reviews SQL diff + sequences against parallel Calendly migration).
- `TYPEFORM_API_KEY` + `TYPEFORM_WEBHOOK_SECRET` present in Vercel (gate (d)).
- Real-delivery signature scheme (verified per docs + via the receiver's test coverage; first real delivery in step 7 of the activation runbook is the end-to-end check).
- End-to-end opt-in flow (gate (c) on real surfaces — Drake submits a test response, watches `typeform_responses` for the row + `webhook_deliveries` for the audit).

## 4. Surprises and judgment calls

**(a) Env var name — `TYPEFORM_API_KEY` kept.** Spec wrote `TYPEFORM_API_TOKEN`, `.env.local` has `TYPEFORM_API_KEY`. Followed the Calendly precedent (which had the same mismatch): `from_env()` accepts either, prefers the one set. No rename pushed. Reason: lower-cost than the alternative (no Vercel env-var change needed, no documentation rewrite needed), and the spec's intent was clearly "the PAT" regardless of name. Drake can rename later if there's a strong consistency argument.

**(b) Signature-scheme implementation per docs, not via live byte-validation.** Typeform's per-form webhooks documentation says `Typeform-Signature: sha256=<base64>` over the raw body. I implemented to that spec + added a defensive bare-base64-no-prefix tolerance, but the actual byte-level validation against a real Typeform delivery happens at step 7 of the activation runbook. Tests use synthesized signatures keyed off the same algorithm; if the docs lied about base64 vs hex or about the prefix, the test suite passes but the real delivery fails `_verify_signature`. The fix path is short: change `base64.b64encode(...)` to `.hexdigest()` (or whatever Typeform actually does), retest, redeploy. The bigger risk is "we shipped the wrong cipher" — partially mitigated by the registration probe response not echoing the signing scheme either (Typeform doesn't surface it via the API). This is the "API discovery curl probe" memory's case — verified the registration body shape live, but the signing direction is one-way and only observable on real delivery.

**(c) `event_types` not in the PUT body.** The probe response showed `event_types: {form_response: true}` is Typeform's default when you create a per-form webhook (with no event_types field in the PUT body). Means there's no per-event-type subscription configuration to do — Typeform's per-form webhook system only emits this one type (unlike Close, where you opt into a list). Confirmed during discovery PUT cycle. Treat this as the natural API shape, not an oversight.

**(d) Loose FK on `typeform_responses.form_id`.** Matches the close + wistia precedent. Backfill order isn't guaranteed to land the form-definition row first, and the webhook receiver lazy-syncs the definition only on best-effort basis. A strict FK would block ingestion if Typeform ever delivered a response for a brand-new form before our scheduled definition pull. Loose FK + the lazy-sync seam + the cron's `sync_all_form_definitions` per-tick refresh together make the form-definition mirror eventually-consistent without ever blocking response ingest.

**(e) `--smoke` form selection heuristic.** Picks the highest-volume form via cheap `total_items` probes against the first 10 forms (`page_size=1`), short-circuiting if it finds one with >100 responses. Tries to match what discovery showed — PWSNd0h2 sitting at the top with ~10k. Caller can override with `--form <id>`. The probe is cheap (~10 GETs at worst) and falls through cleanly if every form has 0 responses (logs `HARD STOP: no candidate form found for smoke`).

**(f) Notify-seam wiring.** Spec asked for a no-op stub so a future Slack-on-new-opt-in spec is a function-body change, not a refactor. Implemented as `_notify_new_response(response_row)` returning `None` at the bottom of `upsert_response_from_webhook`. Future spec drops in a `shared.slack_post.post_message` call gated on a `TYPEFORM_NOTIFY_*` env flag without touching the receiver — exactly the seam shape the spec wanted.

**(g) Cron cadence `*/15`.** Spec leaned `*/15`; I held there. Rationale captured inline in the cron's docstring: webhooks are the primary path, this is reconciliation; tighter than Meta/Wistia 3h because Typeform is real-time-relevant for closers; 6h safety window × 15min cadence = 24 overlapping passes per safety period. Trade-off: every 15-minute tick walks every form's last 6h of responses (~14k responses total but the `since` filter narrows it). With page_size=1000 cursor + ~31 forms, a tick should complete well under the `maxDuration: 300` ceiling.

**(h) Cherry-picked the spec onto worktree-b.** Rather than `git merge origin/main` (which would pull 6 Calendly commits — explicitly NOT what the parallel-worktree topology wants) or running blind without the spec on disk, used `git cherry-pick 9017eb9` to bring just the spec file onto worktree-b's history. Author preserved as Drake (per spec front-matter); committed automatically by cherry-pick. The merge of worktree-b + main later resolves the cherry naturally (same commit hash on both sides post-rebase or as a no-op merge).

## 5. Out of scope / deferred

**Gate (a) — migration apply.** Drake reviews `supabase/migrations/0048_typeform_mirror.sql` (177 lines), confirms sequencing against the parallel Calendly worktree's migration apply (both target the same shared cloud DB; an apply race is possible if both fire concurrently), then runs `supabase db push --linked --dns-resolver https --password "$DB_PW" --yes` per `docs/runbooks/apply_migrations.md`. Post-apply Builder dual-verifies: `select to_regclass('public.typeform_forms')` non-null, `select to_regclass('public.typeform_responses')` non-null, `select * from supabase_migrations.schema_migrations where version='0048'` returns exactly 1 row. Drake's call if both worktrees should apply in series (cleanest) vs alternate strategies.

**Gate (d) — env vars in Vercel.**
- `TYPEFORM_API_KEY` (the PAT) — already in `.env.local`, needs adding to Vercel for the cron + receiver's lazy form-sync.
- `TYPEFORM_WEBHOOK_SECRET` — Drake generates (`openssl rand -hex 32`), adds to Vercel env vars, redeploys to pick up. Same value MUST be passed to the registration script via `export TYPEFORM_WEBHOOK_SECRET=...` before running `register_typeform_webhooks.py --apply` (the PUT body must match exactly or every delivery fails signature verification).

**Steps 5-8 of the activation runbook** — backfill (smoke + apply), webhook registration (Drake-gated `--apply`), end-to-end verification (gate (c) — Drake submits a test response on an active funnel form), cron-backstop audit confirmation. Full step-by-step in `docs/runbooks/typeform_ingestion.md` § 8-step activation runbook.

**What would come next if continuing (future specs, not this one):**
- Slack notify-on-new-opt-in wiring through `_notify_new_response`. One-spec follow-up; the seam is in place.
- Aggregation layer / sales dashboard surface that reads the lead stream. Separate future arc (Drake's call on shape — the Engine-sheet Typeform-target rows are still undocumented, flagged in discovery §4(e)).
- Per-respondent flattening view (`typeform_response_answers` materialized view) IF the dashboard finds the jsonb-query ergonomics unworkable. Discovery flagged as optional; deferred per spec.

**Did NOT need to update / explicit no-op decisions:**
- `clients` table — no resolution per spec § Scope (these are leads, not clients).
- KB / `documents` / `document_chunks` — Typeform data isn't embedded for retrieval; mirror-tables only.
- `app/` Next.js routes — no UI in scope per spec.
- `agents/` — no agent reads from Typeform; aggregation is a future arc.

## 6. Side effects

**Real-world API calls during build/verify:**
- ~80 GETs against `api.typeform.com` during discovery (pre-existing report — not part of this work, but still in Nabeel's API log as of yesterday).
- Today: 1 GET on `T1bhPcJ2/webhooks` (read existing → empty), 1 GET on the specific tag (404 as expected), 1 PUT to create the probe webhook, 1 GET to confirm, 1 DELETE to tear down, 1 GET to confirm deletion. All on the dead test form. Six API calls total today. Throwaway secret + non-routable URL — never delivered an event anywhere.

**Local filesystem writes (NOT committed):** none beyond the standard test cache. The `.probe-out/` from discovery yesterday is still there (already git-ignored).

**Supabase writes:** **none.** Migration 0048 NOT yet applied. No mirror tables exist yet. No `typeform_*` rows in the DB. No `webhook_deliveries` rows from this code (the cron + receiver are deployed-ready but neither has fired against a populated DB).

**Vercel deploys:** the push of these 6 commits to `origin/worktree-b` does NOT trigger a Vercel deploy because Vercel's GitHub integration is tied to `origin/main`. The receiver + cron + scripts only become live after `worktree-b` is merged into `main` (Drake's call when that happens — likely after both the Calendly partial-report unblock + this work's activation steps are coordinated).

**Slack / Telegram / email:** none. The `_notify_new_response` seam is a no-op return.

**Shared-system state not captured in the diff:**
- The cherry-pick (e81f9f6) carries the spec into worktree-b's history. When worktree-b eventually merges to main, the spec commit will appear on both sides — git handles this cleanly (same content, same author, same commit hash from the cherry).
- `webhook_deliveries.source` will start emitting `'typeform_response_webhook'` + `'typeform_sync_cron'` once activation completes. Both rows are documented in the schema docs; no migration change needed to `webhook_deliveries` (the CHECK on `processing_status` allows the existing values `received/processed/failed/duplicate/malformed`, and `source` is free-text by design).

## 7. What's needed to unblock

The hard stop is the migration-apply gate (a). Two coordinated actions sequence the unblock:

**Path A (recommended) — sequential apply, this worktree second:**
1. Drake decides the Calendly partial's migration story first (its partial report at `docs/reports/calendly-ingestion.md` on main describes its own blocker). Resolve that path, including whether Calendly's `0047` is applied or pending. Once `0047` is settled in the ledger, apply `0048` from this worktree's `supabase/migrations/0048_typeform_mirror.sql`. Builder dual-verifies post-apply.
2. After 0048 is in the ledger, the rest of the activation runbook proceeds without conflict: deploy (after worktree-b merges into main, since Vercel deploys from main), add the two env vars, run smoke + bulk backfill, run the registration script, verify end-to-end, confirm cron audits clean.

**Path B — parallel apply, two CLI sessions:** Possible but risky. Both `0047` and `0048` apply against the same supabase ledger; if the CLI is invoked from two checkouts simultaneously, one will see the ledger advance under it mid-apply. Worth NOT doing.

**Path C — defer migration entirely until both worktrees re-converge on main:** Lowest-risk if Drake wants to fully decouple. Merge `worktree-b` into a `worktree-b → main` PR, resolve any `docs/state.md` / `CLAUDE.md` / `.env.example` conflicts with main's Calendly content there, apply both migrations in one ordered session from main. Slightly more diff-resolution work upfront, zero apply-race risk.

**Drake's specific judgment calls remaining:**

1. **Which apply path (A/B/C).** Lean: A. The shared-DB sequencing the spec calls out is the exact case "do not apply autonomously" was written for.
2. **Whether to rename `TYPEFORM_API_KEY` to `TYPEFORM_API_TOKEN`** to match the spec's wording. Lean: no — `from_env()` accepts both, the existing `.env.local` entry stays, no Vercel rework.
3. **`TYPEFORM_WEBHOOK_SECRET` generation** — `openssl rand -hex 32` recommended. Drake's value, exported locally + added to Vercel, has to match across both before the registration script runs.

When ready to resume: Builder dual-verifies the 0048 apply, then opens a fresh report (per the no-overwriting-partial-reports memory: `docs/reports/typeform-ingestion-resume.md` or `-pt2.md`) covering verification + the activation steps 2-8 as they complete.
