# Report: Airtable Discovery Resume — Probe Edits + Re-Run

**Slug:** airtable-discovery-resume
**Spec:** docs/specs/airtable-discovery-resume.md
**Substantive findings:** docs/reports/airtable-discovery.md (the complete non-PARTIAL report — that's where Director picks up for the `0050` ingestion spec).
**Branch:** worktree-b (confirmed via `git branch --show-current`)

This is the procedural close-out for the resume spec. The actual discovery findings — token verdict, schemas, incremental verdicts, masked samples, funnel-semantics read, ingestion A/B with lean — live in `docs/reports/airtable-discovery.md`, which this pass overwrote (the PARTIAL report is gone from the worktree but preserved in git history). Per the resume spec's explicit instruction (§ What success looks like): "overwrite the PARTIAL in place — it's the same slug, same investigation, now completed; iteration history lives in git."

## Files touched

**Modified:**
- `scripts/explore_airtable_api.py` — two edits: prepended `AIRTABLE_SALES_PAT` to `CANDIDATE_TOKEN_VARS`; narrowed `TARGET_TABLES` to `tblaoMsiE3FSkHjQt` (Setter Triage Calls) + `tblYsh3fxTpXuPdIW` (Full Closer Report) only.
- `docs/reports/airtable-discovery.md` — complete replacement of the PARTIAL. New body with all six standard sections plus the spec's required deliverables.
- `docs/reports/airtable-discovery-resume.md` — this file (created).
- `.env.local` on worktree-b — appended `AIRTABLE_SALES_PAT=...` line from main's `.env.local` so the probe could load it. Not committed (gitignored). Same machine, same secret store, no leak.

**Not modified:**
- No ingestion module, schema, migration, runbook, schema-doc, env.example, `state.md`, CLAUDE.md edits. Discovery is read-only.

## What I did, in plain English

Tiny work-item: spec said this would be ~6 lines of edits + a re-run, and it was. Read the PARTIAL report + the resume spec + the existing probe. Made the two edits. Realized `AIRTABLE_SALES_PAT` was in main's `.env.local` but not worktree-b's — appended the single line across, no code change. Re-ran the probe end-to-end. All 4 steps green (Step 4's webhooks list 403'd as the spec anticipated — `webhook:manage` not granted; expected; flagged for the `0050` ingestion spec). Inspected the schema + sample shapes programmatically (never echoing values), then wrote the complete `docs/reports/airtable-discovery.md` to replace the PARTIAL.

Discovery is now complete and the `0050` ingestion spec has its inputs. Substantive findings are all in the main discovery report — this close-out exists to satisfy the slug→report convention for THIS spec and pair the resume execution with a one-Builder-pass artifact.

## Verification

- **Probe parse-check:** `ast.parse(...)` → ok after edits.
- **Probe run:** Steps 1-4 ran end-to-end; exit 0. `AIRTABLE_SALES_PAT` 200s on Meta API. 11 tables visible in base. Both target tables' schemas pulled. 3-record samples per table.
- **Branch confirmation:** `git branch --show-current` → `worktree-b`. Working tree clean before commits; staged changes only what's listed in "Files touched".
- **Pre-commit secret scan:** `grep -E 'eyJ[A-Za-z0-9_-]{20,}|pat[A-Z][A-Za-z0-9]{15,}|Bearer [A-Za-z0-9._-]{30,}'` against staged files → no matches.
- **No PII** in either committed report. Record samples in the main report use placeholders; raw values live in `.probe-out/airtable/probe.json` (gitignored).

## Surprises and judgment calls

- **`AIRTABLE_SALES_PAT` was in main's `.env.local` but not worktree-b's** — same-machine secret-store drift. Appended the single line over rather than refactoring the probe to look up either checkout. Future worktree-b runs work consistently without further env edits. Not a secret leak (gitignored both places).
- **Step 4 returned 403 as expected** — `AIRTABLE_SALES_PAT` doesn't have `webhook:manage`. Not a re-flag-as-blocker situation; flagged in the main report's "Out of scope" and in the suggested gate-(d) ask for the `0050` ingestion spec.
- **Decision: overwrite the PARTIAL rather than write a sibling `-resume.md` for the discovery substance.** Spec explicitly instructed this and I followed. The general no-overwriting-partials rule (per the user-memory note) exists to preserve a HALT handoff for Director — that halt is now resolved, so the clean complete report supersedes. Git history preserves the iteration. Procedurally clean.

## Out of scope / deferred

- All of the substantive deferred items are in `docs/reports/airtable-discovery.md` § Out of scope / deferred. Repeating only the top-line ones for orientation:
  - The `0050` ingestion spec itself (Director writes; this discovery is the input).
  - Drake/Aman resolutions for the ambiguities in Full Closer Report (canonical payment-on-call field, Financed/Cash/Both canonical, objection-categorization source, Setter Name fill-rate, direct-vs-setter-led attribution).
  - `webhook:manage` scope add to `AIRTABLE_SALES_PAT` (gate (d) for the ingestion spec).
  - The two dropped tables + the AUS variant + other 7 reference tables in the base.

## Side effects

- **Airtable API: 5 GET calls** this run (per the main report's Side effects section).
- **No Supabase writes.** No migration. No Vercel changes.
- **`.env.local` on worktree-b** appended with `AIRTABLE_SALES_PAT` (gitignored, uncommitted, never echoed).
- **`.probe-out/airtable/probe.json` overwritten** by the successful re-run (gitignored, contains real PII in record samples — never committed, never echoed in either report).
- **No external messages.**
