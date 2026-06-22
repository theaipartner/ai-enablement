# Wistia Ingestion — Data Model + Backfill + Live Cron
**Slug:** wistia-ingestion
**Status:** in-flight
**Target branch:** main

## ⚠️ Landscape note

Close live webhooks + Meta sheet ingestion are live in production on `main`. Separate Ella worktree on `ella-worktree`. **Stay on `main`.** `git status` + `git log --oneline -10` first; re-read current file state, don't assume.

## Why this exists

Ingest Wistia video analytics into Supabase — the source for the Engine sheet's four Wistia rows (VSL Engagement Rate, VSL Average View Duration, TYP Engagement Rate, TYP Average View Duration). Discovery is done: `docs/reports/wistia-discovery.md` is the authoritative input — **read it fully before designing.** It already answers the hard questions with real data (per-day stats ARE available; the live VSL is two videos inside a project, NOT the media literally named "VSL"; engagement rate is DERIVED from volume metrics + duration).

**Drake's decisions (bake in):**
- **Ingest ALL 80 medias**, not just the funnel-relevant ones. Principle: mirror everything, decide what to use in the aggregation layer later (core principle #1). Base 44 / future-funnel videos come free; 80 medias is trivial volume (~2,400 daily rows). Do NOT scope to specific projects.
- **"Live" ingestion = frequent self-healing cron, NOT a webhook.** Wistia's per-day stats are a PULL API (`/by_date` with a date range) — there is no event Wistia pushes for view activity that could feed daily aggregates. So real-time webhooks are not possible for this data. The live model is a tight cron cadence (every 3h) that re-pulls a rolling recent window so new views land within hours and restated/missed days self-correct. Same shape as the Meta sheet cron. Don't build a webhook receiver — there's nothing to receive.
- **Canonical-VSL / TYP-video selection is DEFERRED to the aggregation layer.** Because we ingest all 80 raw, the "which hashed_ids count as the VSL" question (discovery flagged: two active VSLs `i1173gx76b` + `nbump1crwb`, plus Base 44 separate; TYP is `fbgjxwe62y`) does NOT need settling here. Ingest everything; the dashboard spec picks canonical ids later. This spec must NOT hardcode a VSL choice into ingestion.

## Context Builder needs

- **Auth:** `WISTIA_API_TOKEN` in `.env.local` (present, length 64). Bearer auth: `Authorization: Bearer <token>`. Confirm a cheap call (`GET /v1/medias.json?per_page=1`) returns 200 before backfilling; **hard stop** on 401/403 (token page is Account-Owner-only in Wistia — an auth failure may mean Nabeel must regenerate/scope the token; surface that).
- **`urllib` only, no SDK dep** — matches `ingestion/close/client.py`, `ingestion/meta/sheets_client.py`, `shared/google_oauth.py`.
- **Rate limit:** 600 req/min per account; Wistia returns **HTTP 503** (NOT 429), no Retry-After. Treat 503 as back-off (exponential, as the probe did). The sync touches ~80 medias/tick = ~80 calls, ~13% of one minute's budget — fine, but handle 503 defensively.
- **Pattern to mirror:** `ingestion/meta/` is the closest analog (external pull → parser → idempotent upsert + a Vercel cron reusing `CRON_SECRET`). Read `ingestion/meta/{sheets_client,parser,pipeline}.py` + `api/meta_sheet_sync_cron.py` before writing `ingestion/wistia/`. Reuse `shared/db`, the `webhook_deliveries` audit pattern (`source='wistia_sync'`), fail-soft per-record, summary audit row.
- **Endpoints (confirmed in discovery — verify shapes against live API as you build):**
  - `GET /v1/medias.json` — paginated inventory (page + per_page max 100): name, hashed_id, project, duration, type, created/updated. 80 medias today.
  - `GET /v1/projects.json` — project list (id + name) for the `project_id`→`project_name` mapping on the reference table.
  - `GET /modern/stats/medias/{hashed_id}/by_date?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD` — **the per-day source.** REQUIRES header `X-Wistia-API-Version: 2026-03`. Returns a list of `{date, load_count, play_count, hours_watched}`, one entry per calendar day in the window, zeros (not nulls) on no-activity days. No documented `start_date` ceiling → full-history backfill is feasible.
  - `GET /v1/medias/{hashed_id}/stats.json` — LIFETIME aggregates `{pageLoads, visitors, percentOfVisitorsClickingPlay, plays, averagePercentWatched}`. Use to populate the reference table's lifetime cross-check field. (`/medias/{id}/engagement` 404s on this account — don't use it.)
- **CRITICAL UNIT NOTE from discovery:** `hours_watched` is in HOURS as a float (e.g. `0.085` ≈ 5m6s), NOT seconds. Derivations convert via `× 3600`. `averagePercentWatched` from lifetime stats is an INTEGER percentage (e.g. `25`). Engagement-rate + avg-view-duration are DERIVED (see discovery § metric map), not raw columns — but this spec only INGESTS raw; derivation lives in the future aggregation/dashboard layer. Store raw `load_count`/`play_count`/`hours_watched` + the media `duration`; don't pre-compute engagement into the mirror.

## What to build

1. **Migration 0045** — two tables (validate shapes against real payloads before finalizing):
   - **`wistia_medias`** (reference, keyed `hashed_id text PRIMARY KEY`): `name text`, `duration_seconds numeric`, `project_id text`, `project_name text`, `media_type text`, `lifetime_plays int`, `lifetime_avg_percent_watched int` (refreshed each sync as a cross-check), `wistia_created_at`/`wistia_updated_at` timestamptz, + standard `created_at`/`updated_at` + `set_updated_at` trigger. ~80 rows.
   - **`wistia_media_daily`** (per-day mirror, keyed on a UNIQUE `(hashed_id, day)`): `hashed_id text` (FK-loose to wistia_medias, same loose-ref posture as the Close mirror — don't hard-FK, backfill order isn't guaranteed), `day date`, `load_count int`, `play_count int`, `hours_watched numeric`, + lifecycle. Index/PK on `(hashed_id, day)` for the per-day aggregation joins. Consider an index on `day` alone for cross-video daily rollups.
   - **HARD STOP for Drake's SQL review before apply** (gate a). After approval, apply + dual-verify per `docs/runbooks/apply_migrations.md` (psql not installed → psycopg2 against pooler URL; verify schema reality via `to_regclass` + ledger via `supabase_migrations.schema_migrations`).
2. **`ingestion/wistia/`** — client (urllib, Bearer, the three endpoints, 503 back-off, the `X-Wistia-API-Version` header on by_date) + parser (API payloads → typed row dicts; hours_watched stays as-is, no derivation) + pipeline (`sync_wistia`: refresh inventory → for each media pull by_date over a window → idempotent `UPSERT ON CONFLICT (hashed_id, day)` for daily + `ON CONFLICT (hashed_id)` for the reference table). Fail-soft per media — one media's stats failing doesn't abort the run; collect errors in a `SyncOutcome`.
3. **`api/wistia_sync_cron.py`** — Vercel cron, **every 3 hours** (`0 */3 * * *`), mirroring `api/meta_sheet_sync_cron.py` exactly: `CRON_SECRET` bearer auth, `sync_wistia` over a **rolling 14-day window** (`start_date = today - 14d`, `end_date = today`) so new views land within 3h and restated/missed days self-heal, audit row to `webhook_deliveries` (`source='wistia_sync'`), fail-soft, summary. This IS the "live" mechanism. Reuses `CRON_SECRET` + `SUPABASE_*` — confirm no new env var needed beyond `WISTIA_API_TOKEN` (which the cron reads from Vercel env — flag that `WISTIA_API_TOKEN` must be added to Vercel for the cron to work in prod; it's in `.env.local` for local/backfill but the deployed cron needs it in Vercel — gate (d)).
4. **Backfill** — the same pipeline with a wide `start_date` (e.g. `2025-01-01` or earlier — no API ceiling found) loads full history in one run. A `scripts/backfill_wistia.py --smoke / --apply / --limit` wrapper, OR (per the Meta precedent where the cron's first tick WAS the backfill) document that a one-off wide-window invocation backfills. Builder's call which is cleaner; if a script, smoke (one media end-to-end) before bulk. **Bulk backfill is Drake-gated** — smoke first, confirm, then full history. (Volume is small — 80 medias × ~500 days ≈ 40k rows max — so this is quick, but still gate the first bulk write.)

## Gates / hard stops

- **Migration 0045 SQL review** before apply (gate a).
- **`WISTIA_API_TOKEN` must be added to Vercel env** for the deployed cron (gate d) — it's in `.env.local` for local/backfill, but the prod cron needs it in Vercel. Flag it; Drake adds it. Don't add silently.
- **`vercel.json` cron addition** — deploy-affecting; flag it (low-risk, reuses the established cron pattern).
- **Bulk backfill** — smoke first, Drake confirms, then full history.
- `WISTIA_API_TOKEN` missing/misnamed or unrecoverable 401 → stop + report.
- Repeated 503s → back off, report partial.
- Never write to Wistia. Never echo the token.

## What success looks like

- Migration 0045 applied + dual-verified; both tables exist with correct keys/indexes.
- `ingestion/wistia/` mirrors all 80 medias' inventory + per-day stats idempotently.
- Backfill loads full available history; row count + date range + media count reported (e.g. "80 medias, N daily rows, oldest X newest Y").
- Re-running is a no-op (idempotency proven on `(hashed_id, day)`).
- `api/wistia_sync_cron.py` on a 3h cron, rolling 14-day self-healing window, reusing the Meta cron's auth/audit shape.
- Sanity numbers: e.g. "the two active VSLs `i1173gx76b`+`nbump1crwb` show N plays last 7d; TYP `fbgjxwe62y` shows M" so Drake can eyeball realism against the discovery report.
- A note in the report restating that canonical-VSL/TYP selection + engagement-rate derivation are DEFERRED to the aggregation/dashboard layer (this spec ingests raw only).

## Think this through — what could go wrong

The `X-Wistia-API-Version` header being required on by_date but not the v1 endpoints (mixed API versions in one client — handle per-call). hours_watched unit confusion (HOURS not seconds — store raw, document loudly). A media with no stats history returning an empty list vs zeros (discovery saw zeros-per-day; confirm). Pagination on /medias.json if the account grows past 100 (paginate properly even though it's 80 today). 503 rate-limit mid-backfill (back off, resumable via idempotent upsert). The reference table's `lifetime_avg_percent_watched` being an int (precision loss — fine, it's a cross-check not the source of truth). Backfill window genuinely unbounded — pick a sane floor (account creation era) rather than literally infinite. Surface all honestly.

## Mandatory doc updates

- `docs/schema/wistia_medias.md` + `docs/schema/wistia_media_daily.md`.
- `docs/runbooks/wistia_ingestion.md` — source, auth (token + Vercel-env requirement), endpoints + the API-version header, cron cadence + rolling-window self-heal, backfill, idempotency, the hours-not-seconds unit note, failure modes, and the DEFERRED note (canonical VSL/TYP + engagement derivation live in the aggregation layer).
- `.env.example` — add `WISTIA_API_TOKEN` (documented, where to generate it: Wistia Account Settings → API Access, Account-Owner-only, Bearer; note it's needed in BOTH `.env.local` and Vercel).
- `docs/state.md` — add the Wistia ingestion entry once shipped (migration 0045, two tables, cron, backfill counts).
- `CLAUDE.md` § Folder Structure — add `ingestion/wistia/`.
- Report at `docs/reports/wistia-ingestion.md`.
