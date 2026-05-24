# Microsoft Clarity Ingestion — Daily Self-Healing Cron (No Backfill)
**Slug:** clarity-ingestion
**Status:** in-flight
**Target branch:** main

## ⚠️ Landscape note + MIGRATION NUMBER

Five sources live/building: Close, Meta, Wistia, Calendly (all `main`), Typeform building in parallel on **`worktree-b`**. **Stay on `main`. Do NOT touch `worktree-b`/Typeform.**

**CRITICAL — migration number: this spec uses `0049`, NOT the next-sequential number.** Calendly took 0047 (on `main`). Typeform took **0048** (on `worktree-b`, not yet merged — so `0048` will NOT appear in `main`'s migration dir yet, but it IS claimed). Do NOT auto-detect the next number (you'd pick 0048 and collide with the unmerged Typeform migration). **Hardcode `0049`.** `git status` + `git log --oneline -10` first; re-read current file state.

## Why this exists

Ingest Microsoft Clarity page metrics into Supabase — source for THREE Engine-sheet FUNNELS rows:
- **Landing Page Visits** (row 25) — `Traffic.totalSessionCount` for the landing page
- **Average Time on Landing Page** (row 26) — `EngagementTime` for the landing page
- **Average Time on Thank-You Page** (row 37) — `EngagementTime` for the thank-you page (this row was MIS-TAGGED "Wistia" on the sheet; discovery confirmed it's a Clarity metric — noted for sheet correction)

Discovery is done: **`docs/reports/clarity-discovery.md` is the authoritative input — read it fully.** It has the real response shape, the 8-path URL list, the GET-not-POST correction, the no-normalization finding, and the metric mappings.

**Drake's decisions (bake in):**
- **Landing page = `/lp`. Thank-you page = `/confirmation`.** These are the canonical paths the named Engine-sheet metrics compute from — store as a clearly-marked config constant (like Calendly's `CLOSER_EVENT_TYPE_NAMES`), correctable later.
- **Ingest ALL paths, not just the canonical two.** Explicitly including `/base44` and `/application-completed`, plus everything else Clarity returns (`/course-success`, `/book-a-call`, `/conf`, `/go-*`, etc.). Mirror-everything per Core Principle #1. The canonical config just labels which paths feed the named metrics; all paths are stored.
- **Store BOTH `totalTime` and `activeTime`** (don't pick one at ingest). Default the canonical "time on page" metric to `activeTime` in the config/aggregation notes (better engagement signal), but store both columns so the choice is switchable in the aggregation layer without re-ingesting.
- **Mirror all 9 metric blocks**, not just Traffic + EngagementTime. The 6 quality-signal blocks (DeadClickCount, RageClickCount, QuickbackClick, ExcessiveScroll, ScriptErrorCount, ErrorClickCount) + ScrollDepth come free in the same single API call — store them. Future UX-quality alarms.

## The defining constraint — NO BACKFILL, daily self-healing cron

Clarity's API returns ONLY the last 1–3 days, ever (confirmed in discovery). **There is no historical backfill — history accumulates going-forward from cron start.** The ingestion model is forced:
- **Daily cron pulls `numOfDays=3`** (always 3, for self-healing). A 1- or 2-day cron outage self-heals on the next run; a >3-day outage = permanent gap (acceptable, document it).
- **10 requests/project/day hard cap** — the cron uses ONE request/day (one URL-segmented call returns all 9 blocks). Massive headroom; never loop.
- Idempotent upsert: re-pulling the same 3 days overwrites cleanly (Clarity may refine recent aggregates).

## Key facts from discovery (verified — honor these)

- **Endpoint is GET, not POST:** `GET https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=3&dimension1=URL`. Bearer auth via `CLARITY_API_KEY`.
- **Dimension param is `dimension1=URL`** (all-caps in request); response field is **`Url`** (capital U only). Casing differs request-vs-response — don't trip on it.
- **URLs are NOT normalized** — query strings preserved; 45 raw strings → 8 paths in 3 days. **Store the raw `Url` AND a derived `url_path`** (`urlparse(url).path`) column, both populated at ingest. Aggregation groups by `url_path`.
- **Response is a JSON array of metric blocks:** `[{metricName, information:[rows]}, ...]`. Each row is metric-specific with `Url` merged in. `Traffic` rows have `totalSessionCount`, `distinctUserCount`, `totalBotSessionCount`, `pagesPerSessionPercentage`. `EngagementTime` rows have `totalTime`, `activeTime` (both strings-of-seconds → cast int).
- **`Url: null` aggregate row** exists in Traffic (the all-URLs total). Store it as a `url_path='__total__'` sentinel OR drop it — Builder's call, documented. Lean: store with a clear sentinel so the daily total is queryable.
- **Clarity only sees `go.theaipartner.io`** — `/confirmation` is on that subdomain (confirmed present in data), so the thank-you-page metric works. Note: if a funnel page ever moves off `go.`, it vanishes from Clarity.
- **Possible Cloudflare UA gate** — if a 1010/403 hits, set a normal User-Agent header (the `ingestion/calendly/client.py` is the reference; it already solved this).

## Schema (sketch from discovery — validate, adjust with reasoning)

Migration **0049**. The metric blocks have heterogeneous shapes, so the cleanest mirror is likely a **long/EAV-ish daily table** keyed on (snapshot_date, metric, url) rather than one wide column-per-metric table. Builder decides the exact shape but lean toward:
- **`clarity_metrics_daily`** keyed on a UNIQUE `(snapshot_date, metric_name, url)` (or `(snapshot_date, metric_name, url, dimension_hash)` if multi-dimension ever added): `snapshot_date date`, `metric_name text`, `url text` (raw, nullable for the total row), `url_path text` (derived), and a `values jsonb` holding the metric-specific fields (since Traffic vs EngagementTime vs DeadClickCount have different field sets) — OR explicit nullable typed columns for the hot ones (`total_session_count`, `distinct_user_count`, `total_bot_session_count`, `total_time`, `active_time`, `scroll_depth`) plus a `raw jsonb` catch-all. Builder picks jsonb-heavy vs typed-columns based on what the aggregation queries need; lean typed columns for the Traffic + EngagementTime hot fields (they feed the named metrics) + jsonb for the 6 quality blocks.
- Index on `(url_path, snapshot_date)` + `(metric_name, snapshot_date)` for the aggregation queries.
- Standard `created_at`/`updated_at` + trigger.
- **HARD STOP for Drake's SQL review before apply** (gate a). After approval, apply + dual-verify (psycopg2 against pooler; psql not installed).

## What to build

1. **Migration 0049** — `clarity_metrics_daily` per above. Gate (a) review.
2. **`ingestion/clarity/`** — client (urllib + Bearer + User-Agent header, GET with query params, the single URL-segmented call), parser (the metric-block array → per-(date,metric,url) row dicts; derive `url_path`; cast string-numbers to int; handle the null-URL total row), pipeline (idempotent upsert on the unique key). Mirror `ingestion/meta/` shape (pull-based, no webhook). Reuse `shared/db`, audit via `webhook_deliveries` (`source='clarity_sync'`).
   - **Canonical config constant** (clearly marked, like Calendly's): `LANDING_PAGE_PATH = '/lp'`, `THANK_YOU_PAGE_PATH = '/confirmation'`, `DEFAULT_TIME_METRIC = 'active_time'`. Used by aggregation, not ingest (ingest stores everything). Document where to change.
3. **`api/clarity_sync_cron.py`** — daily Vercel cron (`numOfDays=3`). Mirror `api/meta_sheet_sync_cron.py` (CRON_SECRET bearer auth, audit row, fail-soft, summary). **Schedule: once daily** is sufficient (Clarity data is daily-grained; the 3-day window self-heals). Propose the schedule in `vercel.json` (e.g. `0 9 * * *` — mid-morning, after Clarity's overnight aggregation settles; Builder picks a sane hour). Reuses `CRON_SECRET` + `SUPABASE_*`; `CLARITY_API_KEY` must be added to Vercel (gate d — flag it).
4. **First-run population** — there's no "backfill" (API only gives 3 days), but the first cron run (or a manual `--apply` invocation of the pipeline) loads the last 3 days. Document that this is the cold start; history builds from here. A tiny `scripts/sync_clarity.py --smoke/--apply` wrapper for manual runs + smoke. Smoke (one real call, parse, upsert one snapshot) before any scheduled reliance.
5. **Tests** — parser (the metric-block array shape, url_path derivation, null-URL total row, string→int casts, both time fields), pipeline (idempotency on re-pull of same 3 days), the canonical-config constants present. Full suite green.

## Gates / hard stops

- **Migration 0049 SQL review** before apply (gate a).
- **`CLARITY_API_KEY` into Vercel env** (gate d) — it's in `.env.local`; the deployed cron needs it in Vercel. Flag it; Drake adds. Don't add silently.
- **`vercel.json` cron addition** — deploy-affecting; flag (low-risk, established pattern).
- **10-req/day cap** — the cron uses 1/day. During dev/smoke, be frugal: each test call burns the shared daily budget. Don't loop or retry-storm; a couple of smoke calls max. If you approach the cap, stop + report.
- Cloudflare 1010 → add User-Agent header (Calendly client reference), retry once.
- `CLARITY_API_KEY` missing/401 → stop + report (admin-only token; may need regeneration).
- Never write to Clarity. Never echo the token. Read-only export.

## What success looks like

- Migration 0049 applied + dual-verified.
- `ingestion/clarity/` pulls the single URL-segmented call, parses all 9 metric blocks, stores raw URL + derived path, both time fields, idempotent on (snapshot_date, metric_name, url).
- `api/clarity_sync_cron.py` on a daily cron (numOfDays=3 self-healing).
- First-run populates the last 3 days; row count + path list reported (expect ~8 paths, the `/lp` + `/confirmation` canonical ones present).
- Re-run idempotent (same 3 days overwrite, no dupes).
- Canonical config constants in place (`/lp`, `/confirmation`, active_time default) + documented as confirmable.
- Sanity: landing-page (`/lp`) session count + avg time, and thank-you (`/confirmation`) avg time, shown for the last 3 days so Drake eyeballs realism.
- Report states clearly: no-backfill constraint, history-from-here, the row-37-is-Clarity correction, all paths mirrored incl. base44 + application-completed.

## Think this through

The EAV-vs-wide schema choice (heterogeneous metric blocks — jsonb catch-all keeps it flexible; typed columns for the hot Traffic/EngagementTime fields keep the named-metric queries clean — lean hybrid). The null-URL total row (store as sentinel or drop — decide). `/conf` vs `/confirmation` (two paths that might be the same funnel — store both raw, the canonical config points at `/confirmation`; Drake/Aman can reconcile later). `/base44`'s weird 1-session-18-users (likely bots — `totalBotSessionCount` is stored so it's analyzable; not our problem to clean at ingest). EngagementTime total-vs-active (store both, default active). The 10-req cap during dev (frugal smoke). Clarity refining recent-day aggregates (idempotent overwrite handles it — the latest pull of a day wins). Surface honestly.

## Mandatory doc updates

- `docs/schema/clarity_metrics_daily.md` — the table, the raw-URL-plus-derived-path design, the both-time-fields note, the canonical-config pointer, the no-backfill constraint.
- `docs/runbooks/clarity_ingestion.md` — source, auth (key + Vercel requirement + User-Agent), GET-not-POST, the 10-req cap + 1-call-daily usage, the no-backfill / self-healing-3-day-window / >3-day-outage-is-permanent-gap behavior, canonical config location, first-run cold start.
- `.env.example` — `CLARITY_API_KEY` (documented, admin-only token, needed in both .env.local + Vercel, gate d).
- `docs/state.md` — Clarity ingestion entry once shipped (migration 0049, table, daily cron, no-backfill note).
- `CLAUDE.md` § Folder Structure — add `ingestion/clarity/`.
- Note for Drake (in report, don't edit the sheet): Engine row 37 should be re-tagged Wistia→Clarity.
- Report at `docs/reports/clarity-ingestion.md`.
