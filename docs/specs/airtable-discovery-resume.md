# Airtable Discovery (Resume) — New PAT + Scope to Two Tables
**Slug:** airtable-discovery-resume
**Status:** in-flight
**Target branch:** worktree-b

## ⚠️ Parallel-work landscape — READ FIRST

You are Builder in the **`worktree-b` worktree** (`~/projects/ai-enablement-b`). Execute on `worktree-b`, NOT `main`. `git branch --show-current` to confirm before anything.

This RESUMES `docs/specs/airtable-discovery.md`, which halted at gate (d) — no PAT in `.env.local` had `schema.bases:read`. The PARTIAL report is at `docs/reports/airtable-discovery.md` — **read it first**; it has the full diagnosis (both prior PATs lack `schema.bases:read`; Airtable's `INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND` is the ambiguous scope-OR-access error; the differential-probe technique that isolated the scope miss). The probe script `scripts/explore_airtable_api.py` is already written for all steps — this resume is a tiny edit + a re-run, NOT a rebuild.

Still read-only: no schema, no migration, no ingestion module, no Supabase/Airtable writes. Ingestion is the NEXT spec; this just completes the probe. (Migration pin for that next spec: **`0050`** — recorded, not used here.)

## Two changes from the original discovery spec

**1. New PAT now in `.env.local`: `AIRTABLE_SALES_PAT`.** Drake minted it with `schema.bases:read` + `data.records:read` and added base `appCWa6TV6p7EBarC` to its allow-list (confirmed). Prepend it to the probe's candidate list:

```
CANDIDATE_TOKEN_VARS = ["AIRTABLE_SALES_PAT", "AIRTABLE_ACCOUNTABILITY_PAT", "AIRTABLE_API_KEY"]
```

(Keep the others as fallback — the walk picks the first that 200s on the schema call, which should now be `AIRTABLE_SALES_PAT`.)

**2. Scope narrowed from four tables to TWO.** Drake dropped Closer Booked Calls + Setter Direct Bookings. Probe + map ONLY:
- **Setter Triage Calls** — `tblaoMsiE3FSkHjQt`
- **Full Closer Report** (EOC Form / Full Closer Report Form) — `tblYsh3fxTpXuPdIW`

Update the probe's target-table list to just these two. The base `appCWa6TV6p7EBarC` Meta-API call still returns ALL tables (that's fine — surface the others as context, but only deep-probe records/semantics for these two).

**Why Full Closer Report is the high-stakes one (bake into the funnel-semantics read):** per the Engine sheet, this table is the ENTIRE Closing money section — rows 96–116: Showed/CCMI/No-Show/Reschedule/Cancel dispositions, the three objection types (Shopping Around / Think-About-It-Fear / Spouse), Total Deposits, Closed Deals (by meeting type + direct-booking-led + setter-led), and Cash Collected (deposits / new calls / follow-up / direct-booking-led / setter-led). Map its fields with extra care — get the disposition + money + deal-attribution fields identified precisely, because the dashboard's whole Closing section reads from here. Setter Triage Calls feeds the setter-side Appointment Setting rows.

## Re-run sequence

1. Read the PARTIAL report + the existing probe script.
2. Make the two edits above (`CANDIDATE_TOKEN_VARS` prepend + two-table target list).
3. Re-run: `/home/drake/projects/ai-enablement/.venv/bin/python scripts/explore_airtable_api.py` from the worktree-b cwd. (Note the venv lives in the main checkout; same interpreter, fine to use.)
4. Probe walks Steps 2–6: base schema → per-table field inventory → incremental-key verdict → masked record samples → funnel-semantics read → 1-day backfill-window check.
5. Write the COMPLETE report.

## What success looks like — the complete report

Non-PARTIAL report (six-section structure) at `docs/reports/airtable-discovery.md` — **overwrite the PARTIAL in place** (it's the same slug, same investigation, now completed; iteration history lives in git — the no-overwrite-partials rule is about preserving a HALT handoff for Director to act on, and that halt is now resolved, so the clean completed report supersedes it). With real evidence:

- **Token verdict:** confirm `AIRTABLE_SALES_PAT` reaches the base with `schema.bases:read` + `data.records:read` (the Meta API call 200s). State it plainly.
- **Per-table field schema** (from the Meta API) for both tables: every field's name, id, type, and type-options (select choices, linked-table refs). The full set incl. empty fields — that's why we use the Meta API not record samples.
- **Per-table incremental verdict:** is there a `lastModifiedTime` field? A `createdTime` field? Or only record-level `createdTime` metadata (created-only incremental, no edit-detection)? Or no timestamp at all (full re-pull)? State per table — this keys the live webhook + cron backstop + 1-day backfill for the ingestion spec.
- **Masked record samples** (3 per table): real `fields{}` shape, PII masked (names/emails/phones → placeholders), with type-serialization notes (linkedRecord → `recXXX` id arrays, lookup/rollup → arrays, singleSelect → string, formula → computed scalar, etc.). Note which fields were absent (empty) in the sample vs present in the schema.
- **Funnel-semantics read** per table: what a row represents, and which fields are the meaningful ones — for Full Closer Report, map specifically to the Engine-sheet Closing rows (dispositions, objections, deposits, closed-deal attribution, cash-collected buckets); for Setter Triage, the setter disposition/outcome fields.
- **1-day backfill check:** confirm a `filterByFormula` (`IS_AFTER({timestamp_field}, ...)`) or record-`createdTime` filter can express "since 24h ago" per table.
- **Ingestion-shape A/B recommendation** for the `0050` spec: (A) one mirror table per Airtable table (`airtable_setter_triage_calls`, `airtable_full_closer_report`) keyed on Airtable `record_id` PK, hot fields as typed columns + `fields jsonb` raw catch-all (Close-style hybrid); vs (B) one generic `airtable_records` table keyed on `(table_id, record_id)`, all fields jsonb. Lay out tradeoffs; give a lean. With only two heterogeneous tables — one of which (Full Closer) is money-critical and benefits from typed columns for the Closing-section queries — note whether that tips it toward (A). Frame as input to Drake's call.
- **Webhook-shape note** (read-only, from docs — do NOT create a webhook): Airtable webhooks are per-BASE, notification-only (signal "base changed" → receiver calls `GET /v0/bases/{baseId}/webhooks/{webhookId}/payloads` to fetch changes). One base-level webhook covers both tables; receiver disambiguates which table changed. Note for the ingestion spec. (Confirming this needs `webhook:manage` to LIST existing webhooks — if the new PAT has it, a read-only `GET .../webhooks` list is fine; if not, skip the live check and note the shape from docs only.)

Concrete acceptance: `AIRTABLE_SALES_PAT` 200s on the Meta API; both tables' full schemas pulled; per-table incremental verdict stated; masked samples pasted; Full Closer Report's Closing-section field mapping done with care; 1-day filter confirmed.

## Hard stops

- If `AIRTABLE_SALES_PAT` STILL 403s on the Meta API → the scope or base-access didn't actually save in the Airtable token UI. Re-run the differential probe (Meta-on-own-base vs records-on-own-base) to confirm it's still a scope miss, report, stop — Drake re-checks the token config. (Drake confirmed it's set, so this shouldn't fire — but if it does, don't thrash; report cleanly.)
- Repeated 429s (5 req/sec/base limit) → back off, report partial.
- Never write to Airtable (no record edits, no webhook creation, no schema changes). Read-only.
- No Supabase/migration/env/Vercel changes. PATs read-only, never echoed. No PII in the committed report/probe output — mask; `.probe-out/` stays gitignored.

## Think this through — what could go wrong

The new PAT having `data.records:read` but somehow still missing `schema.bases:read` (re-run differential probe to confirm before thrashing). Full Closer Report fields being formula/lookup/rollup (computed, not stored — flag as read-only-derived so the mirror doesn't treat them as authoritative; the money fields especially — confirm Cash Collected / Deposits are entered values, not rollups of linked records, because that changes whether we mirror them directly or mirror the linked source). LinkedRecord fields pointing at other tables in the base (Full Closer linking to a lead/booking row — note the targets; the dashboard may need them, the mirror stores the `recXXX` ids as-is). A table lacking a `lastModifiedTime` (forces created-only or full re-pull — flag). The two dropped tables' records still being probed by leftover code (make sure the target-list edit actually removed them — don't burn calls on Closer Booked Calls / Setter Direct Bookings). Surface honestly.

## Mandatory doc updates

- The complete report at `docs/reports/airtable-discovery.md` (overwrite the PARTIAL).
- No CLAUDE.md / state.md / schema-doc / `.env.example` edits (nothing ships). Future-entry candidates → report's "Out of scope / deferred."
- Confirm executed branch (`git branch --show-current`) in the report.
