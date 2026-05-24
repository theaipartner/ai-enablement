# Airtable Discovery — Four Sales-Funnel Tables: Schema + Field Mapping + Incremental Viability
**Slug:** airtable-discovery
**Status:** in-flight
**Target branch:** worktree-b

## ⚠️ Parallel-work landscape — READ FIRST

You are the Builder running in the **`worktree-b` worktree** (`~/projects/ai-enablement-b`, branched off `origin/main`), building in parallel with source work on `main`.

- **Execute on `worktree-b`, NOT `main`.** `git status` + `git branch --show-current` + `git log --oneline -10` before anything; confirm `worktree-b`. Re-read current file state; don't assume.
- This spec file lives on `main` (that's how you're reading it). Specs push to `main`; execution + report commits target `worktree-b`. The report lands on `worktree-b`.
- **This is discovery ONLY — read-only.** No schema, no migration, no ingestion module, no UI, no cron, no Supabase writes, no Airtable writes. Output is a throwaway probe + a findings report. Drake + Director read it and decide table shape before the ingestion spec.
- **Migration-number context (for the eventual ingestion spec, NOT this one):** the ledger is at 0046 Wistia, 0047 Calendly, 0048 Typeform (merged), 0049 Clarity (shipping now). **Airtable ingestion will be `0050`** — pinned. Don't auto-detect. (No migration in *this* discovery spec — just recording the pin so it's not lost.)

## Why this exists

Airtable is the next sales-side source. Four tables in ONE base hold funnel-stage data that lives nowhere else in our mirror (Close explicitly does NOT capture triage — the `close-ingestion-v1` spec flagged "triage lives in Airtable, a future Airtable-triage ingestion is the canonical source"; this is that, plus three more). Same Core Principle #1: mirror everything into Supabase, the sales dashboard reads from Supabase, never from Airtable.

**The base + four tables (Drake-provided, confirmed from the Airtable UI URLs):**
- Base: **`appCWa6TV6p7EBarC`** (all four tables live in this one base)
- **Setter Triage Calls** — `tblaoMsiE3FSkHjQt`
- **Full Closer Report** (a.k.a. EOC Form / Full Closer Report Form) — `tblYsh3fxTpXuPdIW`
- **Closer Booked Calls** — `tbla3benxdsq4n0kP`
- **Setter Direct Bookings** — `tblRNhANZ7OGqjlrM`

**What discovery must answer with real data:**
1. **Field schema per table** — exact field names, field IDs, and field TYPES (Airtable has many: singleLineText, email, phoneNumber, singleSelect, multipleSelects, number, date, dateTime, formula, lookup, rollup, linkedRecord, createdTime, lastModifiedTime, etc.). The mirror schema is designed against this. **Critical: read the schema via the Meta API, NOT by sampling records — Airtable omits empty-valued fields from record responses, so a record sample alone undercounts the field set.**
2. **Incremental key per table** — does each table have a usable `lastModifiedTime` and/or `createdTime` field (or can we rely on the record-level `createdTime` metadata)? This is load-bearing for the incremental cron backstop AND the one-day backfill filter. If a table lacks any modified/created timestamp, that changes its ingestion shape — flag it explicitly per table.
3. **Real record shape** — a small masked sample per table showing how typed values actually serialize (linkedRecord → array of record IDs; lookup/rollup → arrays; singleSelect → string; attachments → array of objects; etc.), so the parser is built against reality.
4. **Token viability** — does the existing `AIRTABLE_ACCOUNTABILITY_PAT` reach base `appCWa6TV6p7EBarC` with `schema.bases:read` + `data.records:read`? Or is a new/widened PAT needed (gate (d))? Test empirically; report which case we're in.

## Auth + API context (verified against current docs 2026-05-24 — confirm against the live API)

- **Auth:** Bearer PAT — `Authorization: Bearer <token>`. Use `urllib`, no SDK, matching codebase posture (`ingestion/close/client.py`, `ingestion/calendly/client.py`).
- **Base URL:** `https://api.airtable.com`.
- **Rate limit:** **5 requests/second per base** — 429 on violation with a 30s lockout. Discovery is low-volume; stay well under, but handle 429 with back-off (the close/calendly client retry posture).
- **Token candidates (in `.env.local`):** try `AIRTABLE_ACCOUNTABILITY_PAT` first (already wired for the accountability roster — may already reach this base). There are also `AIRTABLE_NPS_*` / `AIRTABLE_ONBOARDING_*` secrets — note them but the accountability PAT is the likeliest fit. If none reach `appCWa6TV6p7EBarC`, that's a gate-(d) finding: Drake mints a PAT scoped to this base with `schema.bases:read` + `data.records:read`.
- **Key endpoints (confirm shapes against the live API + https://airtable.com/developers/web/api):**
  - `GET /v0/meta/bases/{baseId}/tables` — the schema: every table's `id`, `name`, `primaryFieldId`, and `fields[]` (each with `id`, `name`, `type`, and type-specific `options` — e.g. singleSelect choices). **This is the load-bearing call** — it gives the full field set including empty ones. Scope `schema.bases:read`.
  - `GET /v0/{baseId}/{tableId}?pageSize=3` — a small record sample. Records shape: `{ id, createdTime, fields: {...} }`. Remember: empty fields are OMITTED from `fields`, so cross-reference against the Meta-API schema for the complete picture. Scope `data.records:read`. Supports `filterByFormula`, `sort`, and field-based filtering for the eventual incremental pull.
  - `GET /v0/meta/whoami` (or pyairtable's user-id+scopes call) — confirm the token's scopes + that it sees the base. Cheapest viability check.

## The investigation

Probe script (`scripts/explore_airtable_api.py`, throwaway, dumps to git-ignored `.probe-out/airtable/`), in order:

1. **Auth + scope check** — confirm a token works and reports `schema.bases:read` + `data.records:read`. Try `AIRTABLE_ACCOUNTABILITY_PAT` first; if it fails or lacks scope/base access, try the other Airtable PATs in `.env.local`; if none work, HARD STOP + report (Drake mints a scoped PAT — gate (d)).
2. **Base schema** — `GET /v0/meta/bases/appCWa6TV6p7EBarC/tables`. For each of the four target tables, produce a clean field inventory: field name, id, type, and options (select choices, linked-table refs). Flag any `lastModifiedTime` / `createdTime` / `lastModifiedBy` / `autoNumber` fields per table — these are the incremental-key candidates. Also surface any OTHER tables in the base (context — Drake may want them later, but don't probe their records).
3. **Incremental-key determination** — for EACH of the four tables, state definitively: is there a `lastModifiedTime` field? A `createdTime` field? If neither as a field, the record-level `createdTime` metadata still supports created-only incremental (but not edit-detection). Conclude per table: "incremental on `{field}`" or "created-only via record metadata" or "no timestamp — full-table re-pull needed." This decides the cron backstop + one-day-backfill filter design.
4. **Real record sample (masked)** — pull `pageSize=3` per table. Paste the real `fields{}` shape with PII masked (names/emails/phones → placeholders). Show how each non-trivial type serializes: linkedRecord (array of `recXXX` ids), lookup/rollup (arrays), singleSelect (string), multipleSelects (array), attachments (array of objects), formula (computed scalar). Note which fields were absent from the sample (empty) vs present.
5. **Map the funnel semantics** — for each table, a one-line read of what each row REPRESENTS in the funnel (a triage call outcome, a booked call, a closer's end-of-call report, a direct booking) and which fields look like the meaningful ones (outcome/disposition, rep name, lead identity, money/deal fields, timestamps). This is Director's input for the ingestion-spec table design — surface it, don't over-engineer it.
6. **Backfill-window reality** — Drake wants ~1 day of backfill (Setter Direct Bookings may have ~nothing a day back — fine). Confirm per table that a created/modified-time filter can express "since 24h ago" (`filterByFormula` with `IS_AFTER({field}, ...)` or the record `createdTime`). Note any table where a 1-day filter isn't expressible.

## What success looks like

Findings report at `docs/reports/airtable-discovery.md` (six-section structure) that lets Director + Drake design the ingestion schema, with real evidence:
- **Token verdict:** which PAT reaches the base, with what scopes — or "need a new scoped PAT" (gate (d)) stated plainly.
- **Per-table field schema:** the four tables' full field inventories (name/id/type/options) from the Meta API.
- **Per-table incremental verdict:** the timestamp field (or its absence) that the cron backstop + 1-day backfill will key on.
- **Real record shapes pasted, PII masked**, with the type-serialization notes.
- **Funnel-semantics read** per table (what a row means, which fields matter).
- **A clear ingestion-shape recommendation** for the follow-up spec: likely one mirror table per Airtable table (`airtable_setter_triage_calls`, `airtable_full_closer_report`, `airtable_closer_booked_calls`, `airtable_setter_direct_bookings`) keyed on the Airtable `record_id` (PK), with hot fields as typed columns + a `fields jsonb` raw catch-all (mirrors the Close `custom_fields_raw` hybrid), OR a single generic `airtable_records` table keyed on `(table_id, record_id)` with all fields in jsonb — **lay out both with tradeoffs as an A/B for Drake**, since four heterogeneous tables could go either way. Pin migration **`0050`** in the recommendation. Frame as input to Drake's call, not settled.
- **Real-time note:** Drake wants live ingestion (webhooks + cron backstop, mirroring Typeform). Airtable webhooks are per-BASE (not per-table) and notification-only (they signal "base changed," then you call `GET /v0/bases/{baseId}/webhooks/{webhookId}/payloads` to fetch what changed — they do NOT push the row). Note this shape for the ingestion spec: one base-level webhook covers all four tables, receiver pulls the changed records back. Confirm the webhook API shape against current docs in the discovery (read-only — do NOT create a webhook subscription; that's the ingestion spec's gated step).

Concrete acceptance: a token authenticated + scopes reported; all four tables' schemas pulled from the Meta API; per-table incremental-key verdict stated; real record samples pasted with PII masked; the webhook-shape confirmed from docs (not created).

## Hard stops

- No working token with the needed scopes/base-access → stop + report (Drake mints a PAT — gate (d); note the base ID + required scopes so Drake can scope it precisely).
- Repeated 429s → back off, report partial.
- Anything that WRITES to Airtable (creating/editing records, creating webhook subscriptions, modifying schema) → never. Read-only reconnaissance. Confirming the webhook API shape = reading docs + maybe a read-only `GET .../webhooks` list, NOT a `POST` to create one.
- No Supabase writes, no migrations, no env/Vercel changes. Token read-only, never echoed into logs/report/commits. **No PII in committed report/probe output** — mask names/emails/phones; `.probe-out/` stays git-ignored.

## Think this through — what could go wrong

The accountability PAT being scoped to a DIFFERENT base than `appCWa6TV6p7EBarC` (likely, if accountability is its own base — then we need a new PAT; surface the exact base ID + scopes for Drake). Empty fields missing from record samples masking the true field set (that's WHY we lead with the Meta API — don't infer schema from records alone). Formula/lookup/rollup fields that are computed, not stored — these can't be written back and may change when upstream changes; note them as read-only-derived so the ingestion doesn't treat them as authoritative source. LinkedRecord fields that point at OTHER tables in the base (a triage row linking to a lead row) — note the link targets; the dashboard may need them but the mirror stores the `recXXX` ids as-is. Tables with NO modified-time field (forces full re-pull or created-only incremental — flag per table). Setter Direct Bookings being near-empty for a 1-day backfill (Drake said expected — confirm it's just low volume, not a token/permission artifact). Airtable's per-base (not per-table) webhook granularity meaning the receiver must disambiguate which of the four tables changed (note for the ingestion spec). Surface all honestly.

## Mandatory doc updates

- The report at `docs/reports/airtable-discovery.md` (on `worktree-b`).
- No CLAUDE.md / state.md / schema-doc / `.env.example` edits (nothing ships). Anything that should become a future entry → note in the report's "Out of scope / deferred."
- Confirm in the report which branch you executed on (`git branch --show-current`) — parallel-work integrity check.
