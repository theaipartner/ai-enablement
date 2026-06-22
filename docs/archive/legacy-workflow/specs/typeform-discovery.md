# Typeform Discovery — Form Inventory + Response-Shape Viability
**Slug:** typeform-discovery
**Status:** in-flight
**Target branch:** worktree-b

## ⚠️ Parallel-work landscape — READ FIRST

This source is being built in an **isolated git worktree** (`worktree-b`, folder `~/projects/ai-enablement-b`, branched off `origin/main`), in parallel with other source work happening on `main` (Calendly is building there now; Close/Meta/Wistia already shipped).

- **You are the Builder running in the `worktree-b` worktree.** Execute here, NOT on `main`. This discovery is read-only (no writes), so the branch only matters for where the throwaway probe + report land — but build the habit now because the ingestion spec that follows WILL write code and a migration to `worktree-b`.
- This spec file itself lives on `main` (that's how you're reading it) — that's expected. Specs are pushed to `main`; execution targets `worktree-b`. Your report commits go to `worktree-b`.
- `git status` + `git branch --show-current` + `git log --oneline -5` before starting. Confirm you're on `worktree-b`. Re-read current file state; don't assume.
- Shared files that may merge-conflict later (`docs/state.md`, `.env.example`, `CLAUDE.md` folder list) are NOT touched by this discovery — nothing ships. Good.

## Why this exists

Typeform is this worktree's data source — the next sales-side mirror after Close + Meta + Wistia, same established pattern (`ingestion/<source>/`, mirror-everything-into-Supabase per Core Principle #1, agents read from Supabase not Typeform). Before any schema or ingestion module, we probe the live API with the real token, exactly as Wistia/Close/Meta each did.

**This is discovery ONLY — no schema, no migration, no ingestion module, no UI, no cron, no Supabase writes.** The output is a throwaway probe script + a findings report. Drake + Director read it and decide viability + table shape before the ingestion spec is written.

Three questions discovery must answer with real data:
1. **Form inventory** — which forms exist in the account, their `form_id`s, titles, response counts, and which one(s) are the funnel-relevant ones (the application / opt-in / survey forms that feed the Engine sheet).
2. **Response shape** — what does a real response actually look like? Field types, the `answers[]` array structure, how questions map to answers (by `field.id` / `field.ref`), hidden fields, metadata (submitted_at, landed_at, calculated score if any), and how stable the field refs are.
3. **Daily-grain + historical viability** — can we pull responses filtered by submission date (`since`/`until`) and page through full history? This decides whether the mirror is a per-response table keyed on `response_id` with a backfill + going-forward cron (the likely shape, mirroring Close), and whether the Engine-sheet rows are reconstructable historically.

## ⚠️ Open input needed from Drake (call this out in the report)

Close/Meta/Wistia each map to **named Engine-sheet rows** (e.g. Wistia → VSL/TYP Engagement Rate + Avg View Duration). **The Engine sheet's specific Typeform rows are not documented anywhere in the repo** — I (Director) could not find them in `docs/state.md`, schema docs, or runbooks. So the probe cannot pre-confirm the exact target rows the way the Wistia probe could name VSL/TYP.

Handle this by **inverting the approach**: the probe surfaces the *full real inventory* — every form, every question, every field — and the report presents that inventory so **Drake names which form(s) + which questions feed which Engine-sheet rows**. Discovery's job here is to make the actual data visible for Drake's mapping call, not to guess the mapping. If Drake has already told Director the target rows by the time this runs, fold them into § "Map to Engine-sheet rows"; otherwise present the inventory and explicitly ask.

## Context from Drake (bake into the investigation)

- **Token:** `TYPEFORM_API_TOKEN` in `.env.local` (a Personal Access Token). Confirm it exists + is non-empty before anything; **hard stop** if missing/misnamed.
- Drake will confirm form identity against the inventory the probe surfaces — same "list and let Drake confirm" posture as the Wistia VSL/TYP naming. Don't trust assumed form names blindly; show what's really there.

## Auth + API context (verified against current docs 2026-05-24 + confirm against the live API)

- **Auth:** Bearer — `Authorization: Bearer <token>`. A Personal Access Token works directly (no OAuth dance). Use `urllib`, no SDK dep, matching codebase posture (`ingestion/close/client.py`, `ingestion/wistia/client.py`, `ingestion/meta/sheets_client.py`).
- **Base URL:** `https://api.typeform.com` (note: no `/v1` segment — paths are top-level, e.g. `/me`, `/forms`).
- **Rate limit:** Typeform's documented limit is ~2 req/sec on the Responses API (varies by plan); expect **HTTP 429** on violation. Discovery is low-volume so this shouldn't bite, but handle 429 with a short back-off + small retry count, mirroring the close/wistia client retry posture.
- **Key endpoints (confirm current shapes against the live API + https://www.typeform.com/developers):**
  - `GET /me` — cheapest auth check; returns account alias/email. Use this for the auth probe.
  - `GET /forms` — lists all forms the token can see: `id`, `title`, `last_updated_at`, plus `_links`. Paginates via `page` + `page_size`. This is the form-identity inventory.
  - `GET /forms/{form_id}` — the **form definition**: the `fields[]` array (each with `id`, `ref`, `title`, `type`, and for choice questions the `choices[]`). This is the question→field map the response `answers[]` reference by `field.id`/`field.ref`. Load-bearing for understanding response shape.
  - `GET /forms/{form_id}/responses` — the responses. Paginate via `page_size` (max 1000) + `before`/`after` (cursor on response `token`) or `since`/`until` (ISO-8601 submission-date filter). Returns `total_items`, `page_count`, and `items[]` — each item has `landed_at`, `submitted_at`, `metadata`, `hidden`, `answers[]`, and possibly `calculated` (score). **The `answers[]` shape is the key thing to capture** — each answer references its question by `field.id`/`field.ref` and carries a type-tagged value (`text`, `email`, `choice`, `choices`, `number`, `boolean`, `date`, `phone_number`, etc.).

## The investigation

The probe script (`scripts/explore_typeform_api.py`, throwaway, dumps to git-ignored `.probe-out/typeform/`) should, in order:

1. **Auth check** — confirm `TYPEFORM_API_TOKEN` works via `GET /me`. Hard stop on 401/403.
2. **Full form inventory** — list all forms (paginate). Produce a compact table: title, form_id, last_updated_at, and `total_items` (response count — fetch via a `page_size=1` responses call per form, or read from the responses endpoint's total). This is what Drake confirms the funnel-relevant form(s) against. Flag the ones with meaningful response volume.
3. **Form definitions for the candidate forms** — for the form(s) that look funnel-relevant (highest response counts / titles suggesting application/opt-in/survey), pull `GET /forms/{form_id}` and produce the full question list: `ref`, `id`, `title`, `type`, and choices for choice-type questions. This is the dictionary Drake maps Engine-sheet rows against.
4. **Real response shape** — pull a small real sample (e.g. `page_size=3`) for each candidate form and paste the ACTUAL `answers[]` structure: how each answer tags its type, how it references its field, what `hidden` fields + `metadata` + any `calculated` score look like. Redact/avoid echoing real PII into the committed report — show the *shape* with field names and types, mask actual respondent values (emails, names, phone numbers) to e.g. `<redacted-email>`.
5. **Date-filter + history viability (key question)** — test `since`/`until` and cursor pagination (`before`/`page_size`) on the highest-volume form. Confirm: can we filter by submission date, page through full history deterministically, and what's the total historical volume? State definitively whether a **backfill (full history) + going-forward incremental cron** is viable, mirroring the Close shape.
6. **Map to Engine-sheet rows** — for each Engine-sheet Typeform row (if Drake has named them; otherwise present the inventory and ask): name the exact form + question `ref` + answer type that produces it, the grain (per-response → aggregable to per-day), and whether it's historically reconstructable. If the target rows are still unknown, this section presents the candidate fields and explicitly requests Drake's mapping.

## What success looks like

Findings report at `docs/reports/typeform-discovery.md` (six-section structure) that lets Director + Drake decide viability + table shape, with real evidence:
- **Form inventory:** full list with form_ids + response counts; funnel-relevant candidates flagged.
- **Response shape pasted:** the real `answers[]` structure (PII masked), the field-ref→question map, hidden fields, metadata, any calculated score.
- **History verdict:** can we backfill full history + run an incremental cron (the expected Close-like shape), with the real total response volume and the date-filter/pagination params that deliver it.
- **Engine-sheet mapping** (or an explicit request for it): which form + fields feed which rows, at what grain.
- **A clear recommendation:** proposed ingestion shape for the follow-up spec — likely a `typeform_responses` table keyed on `response_id` (+ maybe a `typeform_forms` form-definition mirror so we don't re-derive the question map at read time), backfill script with `--smoke`/`--apply`, going-forward incremental cron. **Pin migration `0048`** in that recommendation — the ingestion spec must use `0048` (pre-assigned for this worktree; main owns through 0047/Calendly). Frame the shape as input to Drake's call, not settled.

Concrete acceptance: auth worked (`/me` returned); full form list retrieved with response counts; candidate form definitions pulled; real response shape pasted with PII masked; the history/date-filter question answered definitively with a real sample.

## Hard stops

- `TYPEFORM_API_TOKEN` missing/misnamed or unrecoverable 401/403 → stop + report (note whether the PAT may need regeneration/scoping by the account owner — surface that).
- Repeated 429s (rate limit) → back off, report partial.
- Anything that writes to Typeform (creating/editing forms, responses, webhooks) → never. Read-only reconnaissance.
- No Supabase writes, no migrations, no env/Vercel changes. Local token read-only, never echoed into logs/report/commits. **No PII in the committed report or probe output that gets committed** — mask respondent values; the `.probe-out/` dump is git-ignored, keep it that way.

## Think this through — what could go wrong

Field `ref`s vs `id`s — refs are author-assigned and more stable across form edits, ids are system-generated; note which one a future ingestion should key answer-mapping on (lean: `ref`, but confirm they're populated + unique). Forms being edited over time so historical responses reference fields no longer in the current definition (the answer carries its own `field` so it's self-describing, but the question `title` may have drifted — note this for the mirror design). Multiple forms feeding the same funnel stage (surface all, let Drake say which is canonical). The token's visibility scope — a PAT may only see forms in certain workspaces; if the inventory looks thinner than expected, flag that the token may be workspace-scoped. PII handling — these are real applicant/lead responses; do NOT commit raw emails/names/phones. The Engine-sheet target rows being undocumented (the known gap above) — a discovery that surfaces the full inventory and cleanly hands Drake the mapping decision is a successful discovery, not a blocked one.

## Mandatory doc updates

- The report at `docs/reports/typeform-discovery.md` (on `worktree-b`).
- No CLAUDE.md / state.md / schema-doc / `.env.example` edits (nothing ships). Anything that should become a future entry → note in the report's "Out of scope / deferred."
- Confirm in the report which branch you executed on (`git branch --show-current` output) — this is the parallel-work integrity check.
