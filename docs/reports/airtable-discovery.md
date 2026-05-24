# Report (PARTIAL): Airtable Discovery — Four Sales-Funnel Tables

**Slug:** airtable-discovery
**Spec:** docs/specs/airtable-discovery.md
**Status:** halted — gate (d): no candidate PAT in `.env.local` has `schema.bases:read`, and base `appCWa6TV6p7EBarC` isn't in either PAT's allow-list. Drake mints a new PAT scoped per § What's needed to unblock.
**Branch:** worktree-b (confirmed via `git branch --show-current`)

Discovery halted at Step 1 of the spec's "The investigation" sequence — the auth/scope check. Both Airtable PATs available in `.env.local` (`AIRTABLE_ACCOUNTABILITY_PAT` + `AIRTABLE_API_KEY`) authenticate as the same Airtable user (`usrPfNpbojP9CkaUN`) but fail with HTTP 403 `INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND` against `GET /v0/meta/bases/appCWa6TV6p7EBarC/tables`. A differential probe against the accountability PAT's OWN known-good base proved the scope is the load-bearing miss (Meta API 403s even on its own base; records endpoint 200s). The spec's hard-stop on missing auth fires here.

## Files touched

**Created:**
- `scripts/explore_airtable_api.py` — throwaway read-only probe. Step 1 (auth/scope) executed end-to-end; Steps 2-4 short-circuited per the spec's hard-stop. The probe is fully implemented for all four steps so when a working PAT lands it can re-run with no edits.
- `docs/reports/airtable-discovery.md` — this PARTIAL report.

**Not touched** (nothing else shipped):
- No ingestion module, schema, migration, UI, cron, env vars, runbooks, or `state.md` entry — read-only discovery.
- No commits on `main` — execution and report committed to `worktree-b` per the spec.

## What I did, in plain English

Acclimated on the spec, verified the relevant Airtable Meta API endpoints against current docs (https://airtable.com/developers/web/api — confirmed `GET /v0/meta/bases/{baseId}/tables` requires `schema.bases:read`; `GET /v0/meta/whoami` requires no scope but only returns the user `id` for PATs, NOT scopes — that's an OAuth-token-only field; `GET /v0/bases/{baseId}/webhooks` requires `webhook:manage`), then wrote the probe and ran it.

The probe walks `CANDIDATE_TOKEN_VARS = ["AIRTABLE_ACCOUNTABILITY_PAT", "AIRTABLE_API_KEY"]` in order, doing `/v0/meta/whoami` + `/v0/meta/bases/appCWa6TV6p7EBarC/tables` per token; the first one with a 200 on the schema call wins. Both PATs got HTTP 200 on whoami (proving they're valid PATs and the network/auth wiring works) and both got HTTP 403 on the schema endpoint (proving they fail the load-bearing scope check).

Because Airtable returns the same opaque error code (`INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND`) for both "wrong scope" and "no base access" — deliberately, for security — I added one differential probe against the accountability PAT's OWN known-good base (`appR566PxMuP71mD6`, hardcoded in `AIRTABLE_ACCOUNTABILITY_BASE_ID`). That probe distinguishes the failure mode definitively:

- `GET /v0/meta/bases/appR566PxMuP71mD6/tables` → **HTTP 403** (same error)
- `GET /v0/appR566PxMuP71mD6/tblmHH0TVpMa0xYTU?pageSize=1` → **HTTP 200**, 1 record returned

Same PAT, same base it's supposed to work against. The records endpoint works (so the PAT has `data.records:read` + access to that base). The Meta API fails. **Therefore the PAT lacks `schema.bases:read` entirely** — not a base-allow-list issue. Granting the PAT base-access to `appCWa6TV6p7EBarC` would still leave the Meta API failing.

The spec's hard-stop language ("No working token with the needed scopes/base-access → stop + report") fires. Reporting the diagnosis with the precise gate-(d) ask Drake can act on directly.

## Verification

- **Probe parse-check:** `python -c "import ast; ast.parse(...)"` → ok.
- **Probe run:** completed Step 1 end-to-end, hard-stopped after Step 1 per design.
- **Differential probe:** confirmed scope-miss (not base-access-miss) is the load-bearing failure.
- **API budget burned:** 6 total Airtable calls (2 whoami + 2 schema-on-target + 1 schema-on-own-base + 1 records-on-own-base). Nowhere near Airtable's 5 req/sec/base ceiling.
- **No writes** to Airtable, Supabase, Vercel, or any env. PATs read from `.env.local` only, never echoed.
- **Raw probe output** at `/home/drake/projects/ai-enablement-b/.probe-out/airtable/probe.json` (gitignored). Contains the user_id `usrPfNpbojP9CkaUN` (Drake's Airtable user — not a secret) and the full error envelopes from both PATs. **No PII** because we never got to the record-sample step.

## Surprises and judgment calls

- **Both `AIRTABLE_ACCOUNTABILITY_PAT` and `AIRTABLE_API_KEY` belong to the same user (`usrPfNpbojP9CkaUN`).** They may be two PATs minted by the same Airtable user (likely Drake), differently scoped. Worth Drake confirming whether `AIRTABLE_API_KEY` is still in use anywhere — if it's an older / orphaned credential, this is a chance to clean it up alongside minting the new one.
- **The error code `INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND` is deliberately ambiguous.** Airtable conflates "no scope" with "no base access" with "the base doesn't exist for this user" so PATs can't be used to enumerate which bases an org has. The differential probe is the only way to distinguish. Worth noting for the future ingestion spec's debugging runbook.
- **PATs do NOT report their granted scopes via `/v0/meta/whoami`.** Only OAuth tokens do. So we can't introspect a PAT's scope set; the only way to verify a scope is to attempt the operation that requires it. This means the future ingestion's startup-check has to be "try a known-required call, observe 403 or 200" — there's no proactive `if has_scope(...)` path.
- **The accountability roster + notification cron rely only on `data.records:read`** (per `api/accountability_notification_cron.py:base_url = ...api.airtable.com/v0/{base_id}/{table_id}`). The new ingestion needs BOTH `data.records:read` AND `schema.bases:read` because of Airtable's empty-field-omission behavior — we can't infer the field set from records alone. Worth pinning in the future ingestion runbook.
- **The probe code is complete for all four steps** even though only Step 1 ran. When Drake provides a new PAT, the same script just runs end-to-end with no edits — set the new env var name in `CANDIDATE_TOKEN_VARS` and go.

## Out of scope / deferred

The remainder of the spec's "The investigation" sequence — all gate-(d)-blocked:

- **Step 2 — Base schema** via `GET /v0/meta/bases/appCWa6TV6p7EBarC/tables`. The probe is ready to print every target table's `id, name, primaryFieldId, fields[]` and flag timestamp-shaped fields for incremental-key candidacy.
- **Step 3 — Real record samples** (3 per table, `pageSize=3`). Probe captures these raw to `.probe-out/airtable/probe.json`; the report-side PII masking happens in the next revision of this document.
- **Step 4 — Webhooks list** (optional). Probe handles 403 gracefully (just notes the scope-miss).
- **Step 5 — Funnel-semantics read** per table — Director's task once the field schemas are visible.
- **Step 6 — Backfill-window reality** — confirm 1-day `filterByFormula` works per table.
- **Final report deliverables** — token verdict (will become "PAT `X` reaches the base with scopes `Y, Z`"), per-table field schemas, per-table incremental verdicts, masked record samples, ingestion-shape A/B recommendation, webhook-shape note.

When Drake completes gate (d), this report will be REPLACED with a complete (non-PARTIAL) report at the same path. Per the working-norm memory, this PARTIAL report file is NOT overwritten in place — the next pass writes a sibling file (e.g. `docs/reports/airtable-discovery-resume.md`) and Drake/Director batch-cleans at EOD.

## Side effects

- **Airtable API: 6 GET calls** total, all read-only:
  - 2× `GET /v0/meta/whoami` (one per candidate PAT)
  - 2× `GET /v0/meta/bases/appCWa6TV6p7EBarC/tables` (both 403)
  - 1× `GET /v0/meta/bases/appR566PxMuP71mD6/tables` (differential probe; 403)
  - 1× `GET /v0/appR566PxMuP71mD6/tblmHH0TVpMa0xYTU?pageSize=1` (differential probe; 200, 1 record received and discarded — that data IS the existing accountability roster row, already in our pipeline's normal access path; no new exposure)
- **No Supabase writes.** No migration. No Vercel changes. No env-var changes.
- **No external messages.** No Slack post, no email.
- **Local filesystem:** `.probe-out/airtable/probe.json` written (~5KB, gitignored, contains the two error envelopes + user id + the spec's target-base config — NO PII because no record samples landed).
- **Token handling:** PATs read from `.env.local` only; never logged, never written to any file in the diff. `probe.json` contains response bodies but the PATs themselves were only in the Authorization header.

## What's needed to unblock

**Gate (d) ask — Drake mints a new Airtable PAT.** Concrete config:

| Setting | Value |
|---|---|
| Token name | suggested `ai-enablement sales-funnel discovery` (or similar) |
| Scopes | `schema.bases:read` + `data.records:read` (required); optionally `webhook:manage` for the future ingestion spec — adding it now saves a re-mint later |
| Access | Base **`appCWa6TV6p7EBarC`** added to the PAT's allowed-bases list |
| Env var | suggested `AIRTABLE_SALES_FUNNEL_PAT` (matches the `AIRTABLE_ACCOUNTABILITY_PAT` convention) |
| Where | `.env.local` only for this discovery pass — Vercel-side adds come later with the ingestion spec |

Why a NEW PAT (not re-scoping `AIRTABLE_ACCOUNTABILITY_PAT`):
- The accountability PAT is in active production use by `api/accountability_roster.py` + `api/accountability_notification_cron.py`. Regenerating it forces a Vercel env-var update + redeploy, with a window where the cron + roster fail.
- Sales-funnel ingestion has a different scope ceiling (needs `schema.bases:read` + likely `webhook:manage`); the accountability use case doesn't. Keeping them as separate credentials follows least-privilege.
- A second PAT also leaves us cleanly able to rotate either credential independently.

Once the new PAT lands:

1. Drake adds `AIRTABLE_SALES_FUNNEL_PAT=...` to `/home/drake/projects/ai-enablement-b/.env.local` (worktree-b only — main can mirror later if needed).
2. Either Drake or Director updates `scripts/explore_airtable_api.py:CANDIDATE_TOKEN_VARS` to prepend the new var name (tiny edit — could ride in a sibling resume spec).
3. Re-run `/home/drake/projects/ai-enablement/.venv/bin/python scripts/explore_airtable_api.py` (worktree-b cwd). The probe walks Steps 2-4 with no other code changes; output drops into `.probe-out/airtable/probe.json`.
4. Builder writes a new non-PARTIAL report (sibling file, NOT overwriting this one — `docs/reports/airtable-discovery-resume.md` or similar per the no-overwriting-partials rule).

**Alternative if Drake prefers extending the accountability PAT:** add `schema.bases:read` (+ `webhook:manage`) to that PAT and add base `appCWa6TV6p7EBarC` to its allow-list — but this widens its scope set, and the Vercel update would need scheduling.

**No code change needed in the probe** to handle the new PAT — `CANDIDATE_TOKEN_VARS` is the only edit, and a single-line change. Walking-PAT-order is intentionally left simple.
