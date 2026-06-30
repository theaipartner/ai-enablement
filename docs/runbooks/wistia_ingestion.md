# Runbook: Wistia Video Analytics Ingestion

Schema docs: `docs/schema/wistia_medias.md` + `docs/schema/wistia_media_daily.md`.

This runbook covers the source endpoints + auth, the cron cadence and self-healing rolling window, the backfill, idempotency, the load-bearing `hours_watched` unit convention, failure modes, and the explicit deferral of canonical-VSL/TYP selection + engagement-rate derivation to the future aggregation layer.

## What this ingestion does

Mirrors Wistia's media inventory + per-day stats into two Supabase tables (`wistia_medias` + `wistia_media_daily`). Ingests ALL ~80 medias raw (Core Principle #1 — mirror everything, decide what to use at aggregation). Idempotent on `hashed_id` and `(hashed_id, day)`.

The Engine sheet's four Wistia metrics (VSL Engagement Rate, VSL Average View Duration, TYP Engagement Rate, TYP Average View Duration) are DERIVED at aggregation time from the raw volume metrics — this ingestion does NOT pre-compute them.

## Architecture

```
   ┌─────────────────────┐
   │ Wistia (external)   │
   │ Data + Stats APIs   │
   └──────────┬──────────┘
              │ GET /v1/medias.json (inventory)
              │ GET /v1/medias/{id}/stats.json (lifetime)
              │ GET /modern/analytics/medias/{id}/timeseries (per-day, post-2026-05-24)
              │   — replaced /modern/stats/medias/{id}/by_date (legacy; synthesized
              │     hours_watched — fake daily engagement)
              ▼
   ┌─────────────────────┐
   │ api/wistia_sync_    │  every 3h via Vercel Cron
   │ cron.py             │  CRON_SECRET bearer auth
   └──────────┬──────────┘
              │ uses ingestion/wistia/pipeline.sync_wistia_rolling
              │ (rolling 14-day window)
              ▼
   ┌───────────────────────────────────────┐
   │ wistia_medias (reference, ~80 rows)   │
   │ wistia_media_daily (time-series)      │
   └───────────────────────────────────────┘
```

## Auth

- **Token:** `WISTIA_API_TOKEN`. HTTP Bearer (`Authorization: Bearer <token>`).
- **Required in BOTH locations** — `.env.local` for backfill/probes/local runs, AND Vercel env vars for the deployed cron. Setting only one breaks the other side.
- **Token page is Account-Owner-only** in Wistia (Nabeel today). If `webhook_deliveries.processing_status = 'failed'` rows accumulate with `wistia_token_unavailable` or `HTTP 401` errors, the token was likely rotated and needs re-minting with `Read detailed stats` permission.

### Rate limit

Wistia caps at **600 req/min per account**. Violations return **HTTP 503 (NOT 429)** with no `Retry-After` header. The client exponentially backs off (5s × attempt, 3 tries). The cron's per-tick budget is ~163 API calls (1 projects + 80 inventory + 80 lifetime-stats + 80 timeseries) — ~27% of one minute's quota, well within bounds.

## Endpoints

| Endpoint | Purpose | Notes |
|---|---|---|
| `GET /v1/medias.json?page=N&per_page=100` | Inventory pagination | Returns empty list when exhausted. Pagination safety cap = 50 pages (5000 medias). |
| `GET /v1/projects.json?page=N&per_page=100` | Project lookup | Fallback for `project_name` resolution when media payload omits it. |
| `GET /v1/medias/{hashed_id}/stats.json` | Lifetime aggregates | Cross-check values only; `wistia_media_daily` is the canonical time-series. |
| `GET /modern/analytics/medias/{hashed_id}/timeseries?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&granularity=daily` | **Per-day stats — the load-bearing source (post-2026-05-24)** | Requires `X-Wistia-API-Version: 2026-03` header. Returns list of `{timestamp, plays, unique_plays, unique_loads, unique_visitors, played_time (seconds), engagement_rate (0-1), play_rate, cta_*, form_conversions}`, zero-activity days have zeros (not nulls). **`end_date` is EXCLUSIVE** — the client wrapper `fetch_timeseries` adds +1 day internally so callers pass inclusive end. |
| `GET /modern/stats/medias/{hashed_id}/by_date?...` | **DEPRECATED** — replaced 2026-05-24 | Was the per-day source; verification proved it synthesized `hours_watched` (fake daily engagement). Method retained on the client (`fetch_by_date`) for ad-hoc legacy queries; pipeline + cron do NOT use it. |

`/v1/medias/{id}/engagement` is documented but 404s on this account's API version. Don't use it.

### Date semantics gotcha (CRITICAL)

The new `/timeseries` endpoint uses **`end_date` EXCLUSIVE**. The legacy `by_date` used inclusive on both. To preserve the inclusive convention every other source in the codebase uses, `WistiaClient.fetch_timeseries(start_date, end_date)` takes an INCLUSIVE end_date and adds +1 day internally before hitting the API. Get this wrong (bypass the wrapper, pass exclusive bounds directly) and you silently drop the latest day.

## Cron cadence

`30 */3 * * *` — every 3 hours at the 30-minute mark. Offset from the Meta sheet cron (`0 */3 * * *`) to avoid traffic spike overlap with that and with Wistia's own background analytics processing.

### Why rolling-window self-healing

The cron pulls a rolling **14-day window** per tick (`start_date = today - 13d, end_date = today`). Each tick refreshes the most-recent 14 days, so:

- New views land within ~3h of being recorded by Wistia.
- Wistia's late-arriving event counts (visitors finishing a video days later) self-heal on every subsequent tick.
- The cron is correct-by-construction — there's no notion of a "last-high-water-mark" to drift from.

If the cron misses a window > 14 days (Vercel outage, account-paused), days older than `today - 13d` get stale until a manual backfill re-runs. Standard recovery: `scripts/backfill_wistia.py --apply` re-pulls full history idempotently.

## Backfill

```bash
.venv/bin/python scripts/backfill_wistia.py             # dry-run
.venv/bin/python scripts/backfill_wistia.py --smoke     # 1 media end-to-end
.venv/bin/python scripts/backfill_wistia.py --apply
.venv/bin/python scripts/backfill_wistia.py --apply --limit 10
```

**Window (post-2026-05-24 cutover):** `today - 30d` → today (~31 days). The cutover narrowed from the 90-day window (which itself was narrowed from the original 2024-01-01 because Wistia's per-media timeseries computation is server-side-event-walk-slow at wider windows). 30 days covers the Engine sheet's per-day rendering; older history (already in pre-cutover legacy columns) is preserved as historical audit but doesn't get the new columns retroactively.

**Volume:** 80 medias × ~31 days = ~2,480 row-upserts. API: 1 projects + 80 inventory + 80 lifetime-stats + 80 timeseries = ~163 calls. Total wall time ~3-5 minutes (most cost is timeseries server-side latency).

**To extend the window** (e.g. backfill the new columns further back), bump `BACKFILL_START` in `scripts/backfill_wistia.py` and re-run `--apply`. Idempotent on `(hashed_id, day)`; legacy columns untouched.

**Smoke gate (mandatory before `--apply`):** smoke mode upserts the full inventory but only ONE media's per-day data. Per CLAUDE.md § Operational patterns. Re-runnable; safe to re-trigger.

**Run `--smoke` before the first bulk `--apply`** (first large-scale production write). Re-runs after parser fixes are safe — idempotency contract holds.

## Idempotency

Three layers, same shape as the Meta sheet ingestion:

1. **PK on `wistia_media_daily (hashed_id, day)`** — duplicate inserts collapse via `ON CONFLICT DO UPDATE`.
2. **PK on `wistia_medias.hashed_id`** — inventory refreshes don't duplicate.
3. **Rolling-window restate** — the cron deliberately re-pulls the most-recent 14 days every tick; late-arriving Wistia counts overwrite cleanly.

## Failure modes + debugging

| Symptom | Likely cause | Action |
|---|---|---|
| Cron audit row `wistia_token_unavailable` | `WISTIA_API_TOKEN` missing in Vercel env | Add the token to Vercel env vars + redeploy |
| HTTP 401/403 from any endpoint | Token rotated or revoked | Nabeel (Account Owner) regenerates token with `Read detailed stats` permission; update `.env.local` + Vercel |
| Repeated HTTP 503 in audit error log | Wistia rate-limit (600/min) hit | Client backs off automatically; if persistent, reduce concurrency or extend cron interval |
| `daily_rows_failed` > 0 in audit | Per-media transient errors (network blip, partial 503) | Self-heals on next tick (rolling window re-pulls). Investigate only if persistent across multiple ticks for the same media |
| `medias_failed` > 0 | Inventory upsert raised (DB-side) | Check `processing_error` in audit row for traceback |
| `engagement` numbers look wrong in dashboard | Units mismatch | **Always check `hours_watched` is in HOURS** — `× 3600` for seconds. Pre-converting in ingestion is a bug |
| New media in Wistia not appearing | Cron not yet ticked | Wait up to 3h, or trigger manually via Vercel dashboard's "Run now" |

## Verification

### After deploy, manual cron trigger

Via Vercel dashboard's manual cron trigger (injects `CRON_SECRET` from env automatically):

```bash
# Or if CRON_SECRET is locally available:
curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \
  https://ai-enablement-sigma.vercel.app/api/wistia_sync_cron
```

Expected: JSON response with `medias_synced` (~80), `daily_rows_upserted` (~14 × 80 = ~1,120 for a single tick), `window.start_date` / `end_date`.

### DB sanity checks

```sql
-- Total medias mirrored
SELECT count(*) FROM wistia_medias;  -- expect ~80

-- Date range covered
SELECT min(day), max(day), count(*) FROM wistia_media_daily;

-- The two active VSL variants per discovery report — last 7 days
-- (uses post-cutover columns; legacy play_count + hours_watched
--  remain on pre-cutover rows but should NOT be used for daily metrics)
SELECT hashed_id, sum(plays_filtered) AS plays_7d, sum(played_time_seconds) AS seconds_7d
FROM wistia_media_daily
WHERE hashed_id IN ('i1173gx76b', 'nbump1crwb')
  AND day >= current_date - interval '7 days'
GROUP BY hashed_id;

-- The TYP video per discovery report
SELECT day, plays_filtered, played_time_seconds, engagement_rate
FROM wistia_media_daily
WHERE hashed_id = 'fbgjxwe62y'
  AND day >= current_date - interval '14 days'
ORDER BY day DESC;

-- Spot-check the cutover boundary — engagement_rate VARIES day-to-day
-- (vs the flat constant the old by_date-derived approach produced)
SELECT day, plays_filtered, engagement_rate,
       round(engagement_rate * 100, 2) AS engagement_pct
FROM wistia_media_daily
WHERE hashed_id = 'i1173gx76b'
  AND day >= current_date - interval '14 days'
  AND plays_filtered > 0
ORDER BY day DESC;
```

## Explicit DEFERRALS (NOT in this ingestion)

These belong to the future aggregation/dashboard layer:

- **Canonical-VSL selection.** The discovery report identified two currently-active VSLs (`i1173gx76b` Direct Closer Funnel + `nbump1crwb` v2). The Engine sheet's "VSL" metric may be one of them, both combined, or include Base 44 (`6qq1eq4wmq`). Aggregation queries pick.
- **Canonical-TYP selection.** Discovery identified `fbgjxwe62y` as the clear winner among the 7 Confirmation Page videos. Aggregation can default to that and let an override be added later.
- **Engagement-rate is no longer derived** post-2026-05-24 — the timeseries endpoint returns it directly per day. Avg-view-duration = `played_time_seconds / plays_filtered` per the schema doc.
- **Engagement-rate semantic confirmation.** Wistia's "engagement" = "average % of video watched." Aggregation-layer engineer should verify that matches the Engine-sheet author's intent before exposing the metric.
- **Canonical play-count choice.** `play_count` (legacy, raw) vs `plays_filtered` (post-cutover, bot-filtered, ~14% lower) — aggregation layer picks which to surface as "VSL Plays" on the dashboard. Recommended: `plays_filtered` (newer-API canonical, filtered = closer to "real human plays").

## Out of scope (future specs)

- **Visitor / unique-viewer metrics** — the per-day endpoint doesn't expose `visitors` (lifetime stats do). If the Engine sheet ever needs per-day unique viewers, we'd need a different surface (raw event API or a different stats endpoint).
- **Per-page-section breakdowns** — the Confirmation Page Vids project has 7 videos on the same page; if a future metric needs "engagement on confirmation page as a whole" we'd aggregate across all 7 hashed_ids.
- **Stale-data alerting** — no Slack alert today if the cron hasn't ticked successfully in N hours. Add if it becomes a real ops problem.
- **Scheduled inventory refresh decoupled from daily stats** — could optimize by only refreshing `wistia_medias` once daily instead of every 3h, but the cost is negligible (~80 lifetime-stats calls per tick) and the simplicity is worth it.
