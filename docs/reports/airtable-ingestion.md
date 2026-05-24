# Report: Airtable Live Ingestion — Setter Triage + Full Closer US/AUS

**Slug:** airtable-ingestion
**Spec:** docs/specs/airtable-ingestion.md
**Branch:** main (executed per Drake's branch correction — worktree-b directive ignored; parallel source work wound down)

Seventh sales-side data source after Close + Meta + Wistia + Calendly + Typeform + Clarity. Two mirror tables, three logical sources (US + AUS Full Closer unioned via `region` discriminator), one base-level webhook + every-15-min cron + manual backfill + manual webhook-registration helper. Migration `0050` applied + dual-verified. First-run --apply landed 3 records (2 Full Closer US + 1 Setter Triage) at cold start. 77 new tests added; full suite now 1024 passing (up from 948). Webhook activation is the remaining gated step (gate (d): `webhook:manage` scope on PAT + `AIRTABLE_WEBHOOK_*` env vars in Vercel).

## Files touched

**Created:**
- `supabase/migrations/0050_airtable_mirror.sql` — two tables, hybrid typed+jsonb schema, region discriminator on Full Closer, 4 + 7 indexes, triggers.
- `ingestion/airtable/__init__.py` — `BASE_ID` + `TARGET_TABLES` (3 sources → 2 mirror tables config) + audit-source constants.
- `ingestion/airtable/client.py` — `AirtableClient` (urllib Bearer, 429 retry, records + meta + webhook subscription + payload-pull + refresh helpers; load-bearing notes inline).
- `ingestion/airtable/parser.py` — `parse_setter_triage` + `parse_full_closer(region=...)` with defensive cast helpers; `is_setter_led` derivation flagged provisional.
- `ingestion/airtable/pipeline.py` — `SyncOutcome` + `sync_table` + `sync_all` + `upsert_changed_records`; batch-upsert-per-table with fresh-client retry on HTTP/2 ConnectionTerminated.
- `api/airtable_events.py` — webhook receiver: MAC verify (X-Airtable-Content-MAC with hmac-sha256= or bare-base64), cursor load/save via webhook_deliveries sentinel, pull-payload loop with mightHaveMore pagination, changedTablesById → TARGET_TABLES filter → per-record fetch + upsert, fail-soft 2xx.
- `api/airtable_sync_cron.py` — every-15-min cron, 6h CREATED_TIME() window, webhook refresh, audit row.
- `scripts/backfill_airtable.py` — `--dry-run`/`--smoke`/`--apply`/`--hours`/`--table`/`--full` with Setter Name fill-rate observation in smoke output.
- `scripts/register_airtable_webhook.py` — `--list`/`--dry-run`/`--apply`/`--delete`; prints AIRTABLE_WEBHOOK_ID + AIRTABLE_WEBHOOK_MAC_SECRET in a big box at creation.
- `tests/ingestion/airtable/__init__.py` — package init.
- `tests/ingestion/airtable/test_parser.py` — 25 tests covering cast helpers + both per-table parsers + region handling + is_setter_led semantics + cash-paid-today ambiguity.
- `tests/ingestion/airtable/test_pipeline.py` — 17 tests covering orchestration + idempotency + batch-upsert tripwire + since-formula + region threading + webhook path + non-target table audit + webhook↔cron parity.
- `tests/api/test_airtable_events.py` — 28 tests covering MAC verify (7 cases) + change extraction (4 cases) + cursor persistence (4 cases) + pull loop (2 cases).
- `tests/api/test_airtable_sync_cron.py` — 7 tests covering auth + since window.
- `docs/schema/airtable_setter_triage_calls.md` — full schema doc with the structural-fact note + 5-ambiguities reference.
- `docs/schema/airtable_full_closer_report.md` — full schema doc with all 5 ambiguities listed + example queries + region discriminator notes.
- `docs/runbooks/airtable_ingestion.md` — 8-step activation runbook (collapsed from 9 per Drake's branch correction), MAC scheme + pull-payload model + 7-day refresh + failure-mode table.
- `docs/reports/airtable-ingestion.md` — this file.

**Modified:**
- `vercel.json` — added `api/airtable_events.py` (`maxDuration: 60`) + `api/airtable_sync_cron.py` (`maxDuration: 300`) function entries + cron `*/15 * * * *`.
- `.env.example` — appended 3 new env vars (`AIRTABLE_SALES_PAT`, `AIRTABLE_WEBHOOK_MAC_SECRET`, `AIRTABLE_WEBHOOK_ID`) with full context on scopes, gate-d notes, and why-separate-from-AIRTABLE_ACCOUNTABILITY_PAT reasoning.
- `CLAUDE.md` — appended `ingestion/airtable/` to § Folder Structure.
- `docs/state.md` — prepended 2026-05-24 Airtable ship entry to "Gregory editorial skin shipped".

**Cleanup landed in same pass (before spec execution):**
- Merged `origin/worktree-b` into `main` (5 airtable-discovery commits: probe + complete report + resume close-out).
- Pushed merge commit to `origin/main`.
- Removed `/home/drake/projects/ai-enablement-b` worktree.
- Deleted local + remote `worktree-b` branches.

## What I did, in plain English

Started by handling the cleanup directive from Drake's args. Merged `worktree-b` into `main` (5 discovery commits, no conflicts since the airtable files didn't exist on main yet), removed the worktree directory + the local + remote branches. The cleanup brought the probe script + complete discovery report + resume close-out over to main; main's "executable specs" check then correctly showed only `airtable-ingestion` as in-flight without a report.

Read the spec carefully. Drake's branch correction args meant: execute on main directly, drop the worktree-b execution notes, collapse the 9-step runbook to 8 (no merge-to-main step since `main` IS the working branch), other gates (a/d) unchanged. The spec itself was substantial — migration + 4-file ingestion module + webhook receiver + cron + 2 scripts + tests + 4 doc files. Plenty of moving parts; planned the work, surfaced migration 0050 for gate (a) review, applied + dual-verified after approval, then worked through the build in dependency order.

The interesting design moments:

**The region discriminator on Full Closer Report.** The spec called this out — US + AUS Full Closer share ~entirely-overlapping field sets, so one mirror table with a `region` discriminator is cleaner than two tables. The parser threads region from the per-source config (TARGET_TABLES). AUS-only fields land in `fields_raw` jsonb automatically without code changes.

**The pull-payload webhook receiver.** Airtable's webhook is fundamentally different from Typeform — notification-only ping, then the receiver fetches payloads via a cursor-paginated endpoint and advances the cursor durably. The cursor lives in a sentinel row in `webhook_deliveries` (source='airtable_webhook_cursor', payload.cursor=N). One sentinel row per webhook id, last-write-wins. The pull loop handles `mightHaveMore=True` by re-calling with the response cursor until exhausted.

**The HTTP/2 ConnectionTerminated retry.** Real-API `--apply` exposed the same Supabase pooler issue we hit on Clarity (sequential supabase-py calls drop streams at low counts). Per-record was always going to be bad here; batching helped but didn't fully fix it (first batch upsert succeeded, second failed). Added a retry-with-fresh-client wrapper inside `_upsert_batch` — on the first failure, lazy-import `get_client()` and try again with a new connection. This worked: re-running `--apply` got 2 of 2 records upserted, zero failures.

**The five aggregation-layer-pending ambiguities are preserved everywhere.** Per Drake's explicit call ("mirror raw, resolve at dashboard"), the parser keeps both cash-paid-today fields in distinct typed columns, the 5 sub-fields with naming/typo ambiguity all land in `fields_raw`, and the `is_setter_led` derivation is marked PROVISIONAL in the schema column comment so the dashboard knows to flag it. Documented in both schema docs + the runbook + the discovery report's notes.

**The Setter Name fill-rate observation.** Discovery saw 0/3 (0%) — the working hypothesis ("populated = setter-led; empty = direct-booking-led") was at risk of being wrong. The smoke + 1-day backfill landed 2 Full Closer US records, of which 1 had Setter Name populated → 50% fill. Still tiny sample (N=2), but it's already shifting from the discovery observation. Hypothesis still needs N≥100 to confirm/refute. Documented prominently.

## Verification

- **Migration apply:** `supabase db push --linked --dns-resolver https --password "$DB_PW" --yes` → canonical output, exit 0.
- **Dual-verify** (psycopg2 against pooler URL):
  - `airtable_setter_triage_calls`: `to_regclass` non-null, 20 columns, 4 indexes (PK + 2 secondary + airtable_created_at), 1 trigger.
  - `airtable_full_closer_report`: `to_regclass` non-null, 38 columns, 7 indexes (PK + call_date + partial closed + GIN closer_ids + GIN fields_raw + region + airtable_created_at), 1 trigger.
  - Ledger: exactly 1 row for version `0050 airtable_mirror`; sits atop 0049 clarity / 0048 typeform / 0047 calendly / 0046 wistia (sequence intact).
- **Parser tests:** 25 — covers cast helpers (bool/numeric/str_array variants), Setter Triage happy + missing-id + empty-fields, Full Closer US/AUS region handling, sparse-record tolerance, is_setter_led derivation (None when field absent, distinct from False), cash-paid-today ambiguity preservation.
- **Pipeline tests:** 17 — covers single-table writes for each source + region threading + idempotent re-run (last-write-wins, no duplicates) + batch-upsert single-call tripwire + since→`IS_AFTER(CREATED_TIME(...))` formula construction + limit cap + unknown table errors gracefully + sync_all walks all 3 + Setter Name fill counter only counts Full Closer records + webhook path uses get_record (NOT iter_records) + non-target table changes emit audit warning + webhook ↔ cron produce identical rows for the same record.
- **Receiver tests:** 28 — MAC verify happy path (with prefix + bare), wrong sig, tampered body, wrong secret, empty inputs, invalid base64 secret; extract_changes for changed+created records, filter to TARGET_TABLES, empty payload tolerance, all 3 target tables; cursor load default/stored/bad-value; cursor save format; pull loop pagination via mightHaveMore + cursor advance.
- **Cron tests:** 7 — auth happy/missing-secret/missing-header/wrong-secret/case-insensitive/non-bearer; since window is exactly 6h.
- **Full suite:** `pytest tests/ -q` → **1024 passed in 8.88s** (up from 948 baseline).
- **Real-API smoke:** `scripts/backfill_airtable.py --smoke` → 1 record from Full Closer US parsed + upserted, 0 failures. Setter Name fill on N=1: 0%.
- **Real-API 1-day backfill:** `scripts/backfill_airtable.py --apply --hours 24` → 3 tables walked, 2 records parsed, 2 upserted, 0 failures (after the batch-upsert HTTP/2 retry fix). Distribution: 2 Full Closer US, 0 Full Closer AUS, 1 Setter Triage (the apply window pulled 2, the prior smoke landed 1 older record).
- **Direct-psycopg2 DB sanity check post-apply:** `airtable_setter_triage_calls`: 1 row; `airtable_full_closer_report`: 2 rows, both region='US'; 1 row has `is_setter_led=true`, 1 row has populated `setter_record_ids` (cardinality > 0).
- **Idempotency:** re-ran `--apply` → same outcome (2 parsed, 2 upserted, 0 failures), DB row counts unchanged (1 + 2). Last-write-wins on the natural-key PK.

## Surprises and judgment calls

- **HTTP/2 `ConnectionTerminated` (last_stream_id:3) recurred from Clarity** — same Supabase pooler issue. Clarity's batch-only mitigation wasn't sufficient here because the script does multiple sequential batches (one per table). First batch succeeds; second batch's first call hits the stream-terminated state. Solution: `_upsert_batch` retries ONCE with a fresh `get_client()` on any failure. Lazy import keeps the test fakes' surface unchanged. Worked first try on re-apply — 2/2 records upserted. This pattern is worth promoting to a shared helper if a third source hits the same wall, but inline-per-pipeline keeps things readable for now.
- **`AIRTABLE_SALES_PAT` was set in main's `.env.local` but not worktree-b's** at the start of the discovery resume spec earlier today — solved by copying the single line over. After the merge + worktree removal, this is moot (only one checkout exists now). Future ingestion specs won't see this drift.
- **`Setter Name` field on the discovery sample was empty on all 3 records (0%)**; the 1-day backfill saw 1/2 populated (50%). Still very small sample, but the discovery observation may have been bad luck. The `is_setter_led` provisional flag is the right call — dashboard surfaces as pending until N≥100 confirms.
- **No AUS Full Closer records in the 24h backfill window.** Expected if AUS funnel is lower-volume than US; not an ingestion bug. The parser + pipeline are exercised by tests with AUS region; when AUS records do land, they'll go through cleanly.
- **`webhook:manage` is genuinely gated for activation.** I shipped everything assuming the read path works (it does — backfill + cron paths use only `data.records:read`). The receiver + register helper exist + are tested + can deploy, but until Drake adds `webhook:manage` scope to the PAT and runs `register_airtable_webhook.py --apply`, the live edit-detection path is dark. This is the spec's exact intent — "build + ship everything, webhook activation is the gated step."
- **Cursor sentinel row design.** Spec said "Builder's call: dedicated table OR webhook_deliveries row." I picked `webhook_deliveries` with `source='airtable_webhook_cursor'` + the cursor int in `payload.cursor`. Single sentinel row per webhook id, last-write-wins on upsert. Avoids another migration. Documented in `api/airtable_events.py` module docstring + receiver tests cover the load/save semantics.
- **MAC header format assumption.** I implemented `X-Airtable-Content-MAC: hmac-sha256=<base64>` with bare-base64 fallback. The exact scheme should be confirmed against the FIRST real ping after Drake registers the webhook — if the format differs, adjust `_verify_mac`. Flagged in the runbook's § "Webhook signature scheme (verify against the first real ping)".
- **Notify-seam location decision.** Originally placed `_notify_upserted_record(row, target_table)` INSIDE the per-record loop. Refactored to call it AFTER all batches complete (collected rows in `rows_to_notify` list). Reason: a notify failure mid-loop shouldn't prevent subsequent upserts; the seam is a stub today but the structure preserves correct sequencing for a future Slack-on-close hook.
- **`Full Closer Report Form - AUS` has 64 fields vs US's 66.** The 2-field delta is in `fields_raw` (the parser maps US-confirmed field names; AUS-only differences land in raw). When Drake decides to dashboard the AUS funnel, a wider sample will surface which fields are US-only or AUS-only — for now, mirror-everything is sufficient.
- **`is_setter_led` semantics distinction** — `None` (Setter Name field absent) vs `False` (Setter Name explicitly empty array, no setter assigned). Per the parser, `[]` collapses to `None` via `_to_str_array` (defensive), so both cases produce `is_setter_led=None`. If Airtable's webhook ever sends an explicit empty array meaningfully distinct from absence, the parser would need adjustment. Test documents this equivalence.

## Out of scope / deferred

- **Gate (a) sequence:** Drake reviewed + approved migration 0050. APPLIED + dual-verified this session. ✓
- **Gate (d) Step 3:** `AIRTABLE_SALES_PAT` in Vercel. Required for cron + receiver. Until added: cron audits `airtable_pat_unavailable`, receiver returns 500 `misconfigured`. Drake adds.
- **Gate (d) Step 5:** `webhook:manage` scope added to `AIRTABLE_SALES_PAT` at airtable.com/create/tokens. Required for register helper + cron refresh.
- **Gate (d) Step 6:** Drake runs `register_airtable_webhook.py --apply --url https://ai-enablement-sigma.vercel.app/api/airtable_events`. Captures `AIRTABLE_WEBHOOK_ID` + `AIRTABLE_WEBHOOK_MAC_SECRET` from output.
- **Gate (d) Step 7:** Drake adds both env vars to Vercel + redeploys.
- **Gate (c) Step 8:** Drake edits a test Airtable record + confirms the row updates in `airtable_full_closer_report` / `airtable_setter_triage_calls` within seconds + cron audits clean + webhook refreshes.
- **The 5 ambiguities** — Drake/Aman picks resolution paths (LLM categorization for objections, canonical-field picks for payment-on-call + Financed/Cash + cash-paid-today, fill-rate confirmation for is_setter_led).
- **Aggregation-layer SQL views** for Engine-sheet rows 96-116 — separate spec.
- **Other 7 tables in the base** (Sales Team Member, Contract Forms, Setter/Closer EODs, High Ticket Commission Tracking, Affiliate SignUps, Setter Direct Bookings, Closer Booked Calls) — future ingestion specs when dashboard needs surface.
- **Soft-delete on Airtable `destroyedRecordIds`** — webhook payloads carry these; currently dropped. Future feature when the dashboard needs to handle deletes (vs the mirror keeping the row).
- **Notify-seam wiring** (Slack-on-close-deal, etc.) — stub present in `pipeline._notify_upserted_record`, future spec.
- **Wider sample for `is_setter_led` fill-rate confirmation** — query after the cron has run a few days, observe rate across 100+ records, decide whether to promote `is_setter_led` from PROVISIONAL to authoritative or rethink attribution.
- **`Full Closer Report Form - AUS` dedicated typed-column mapping** — currently AUS-only fields go to `fields_raw` untyped. Future spec if AUS funnel volume justifies it.

## Side effects

- **Cleanup BEFORE the spec execution** (Drake's "make sure to clean it up" args):
  - Merged `origin/worktree-b` into `main` — 5 commits, 0 conflicts, fast-forward not possible so a merge commit landed (`d56c5a7`).
  - Pushed merge to `origin/main`.
  - Removed `/home/drake/projects/ai-enablement-b` worktree directory.
  - Deleted local + remote `worktree-b` branches.
- **Migration 0050 applied to cloud Supabase.** Migration count: 49 → **50**. Two new public tables + 11 new indexes + 2 new triggers. No data loss; no schema modifications to existing tables.
- **Airtable API:** ~10 GET calls during smoke + 1-day backfill + idempotent re-apply. Way under the 5 req/sec/base ceiling. NO writes to Airtable (the only write path is webhook subscription create/refresh/delete via `register_airtable_webhook.py` which is Drake-gated).
- **Supabase writes:** 3 row upserts into `airtable_setter_triage_calls` (1 row final) + `airtable_full_closer_report` (2 rows final), plus several audit rows in `webhook_deliveries` for the failed-then-retried batch upserts. Idempotent re-apply produced no new rows.
- **No external messages** (Slack, email, etc.).
- **Local filesystem:** No new probe artifacts written (the discovery probe runs from the existing `scripts/explore_airtable_api.py` script, untouched this session). The `.probe-out/airtable/probe.json` from the prior discovery still exists on disk (gitignored).
- **`.env.local` modified during the prior discovery resume** (`AIRTABLE_SALES_PAT` line was copied from main to worktree-b). That worktree no longer exists; main's `.env.local` is unchanged.
- **Vercel:** `vercel.json` updated; on the next push, Vercel auto-deploys two new serverless functions (`api/airtable_events.py` + `api/airtable_sync_cron.py`) + a new cron schedule. Until Drake adds `AIRTABLE_SALES_PAT` + the webhook env vars, the deployed functions audit gracefully without affecting other systems.
- **Token handling:** PATs read from `.env.local` only; never logged, never written to any committed file. The Authorization header is the only place the bearer token appears at runtime.
