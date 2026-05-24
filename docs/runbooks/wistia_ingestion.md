# Runbook: Wistia Video Analytics Ingestion

Spec: `docs/specs/wistia-ingestion.md`. Discovery: `docs/reports/wistia-discovery.md`. Schema docs: `docs/schema/wistia_medias.md` + `docs/schema/wistia_media_daily.md`.

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
              │ GET /modern/stats/medias/{id}/by_date (per-day)
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

Wistia caps at **600 req/min per account**. Violations return **HTTP 503 (NOT 429)** with no `Retry-After` header. The client exponentially backs off (5s × attempt, 3 tries). The cron's per-tick budget is ~163 API calls (1 projects + 80 inventory + 80 lifetime-stats + 80 by_date) — ~27% of one minute's quota, well within bounds.

## Endpoints

| Endpoint | Purpose | Notes |
|---|---|---|
| `GET /v1/medias.json?page=N&per_page=100` | Inventory pagination | Returns empty list when exhausted. Pagination safety cap = 50 pages (5000 medias). |
| `GET /v1/projects.json?page=N&per_page=100` | Project lookup | Fallback for `project_name` resolution when media payload omits it. |
| `GET /v1/medias/{hashed_id}/stats.json` | Lifetime aggregates | Cross-check values only; `wistia_media_daily` is the canonical time-series. |
| `GET /modern/stats/medias/{hashed_id}/by_date?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD` | **Per-day stats — the load-bearing source** | Requires `X-Wistia-API-Version: 2026-03` header. Returns list of `{date, load_count, play_count, hours_watched}`, zero-activity days = zeros (not nulls). |

`/v1/medias/{id}/engagement` is documented but 404s on this account's API version. Don't use it.

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

**Window:** `2024-01-01` → today (≈ 875 days as of 2026-05-24). Wistia returns zeros for days before account/media existence — no error.

**Volume:** 80 medias × ~875 days = ~70k row-upserts max. At ~10 upserts/sec via PostgREST, backfill takes ~2 minutes plus API call latency (~160 Wistia calls × ~300ms ≈ 50s). Total wall time ~3 minutes; fits comfortably in Vercel's cron `maxDuration: 300`.

**Smoke gate (mandatory before `--apply`):** smoke mode upserts the full inventory but only ONE media's per-day data. Per CLAUDE.md § Operational patterns. Re-runnable; safe to re-trigger.

**Bulk `--apply` is Drake-gated** at first invocation (first large-scale production write). Re-runs after parser fixes are not gated — idempotency contract holds.

## Idempotency

Three layers, same shape as the Meta sheet ingestion:

1. **PK on `wistia_media_daily (hashed_id, day)`** — duplicate inserts collapse via `ON CONFLICT DO UPDATE`.
2. **PK on `wistia_medias.hashed_id`** — inventory refreshes don't duplicate.
3. **Rolling-window restate** — the cron deliberately re-pulls the most-recent 14 days every tick; late-arriving Wistia counts overwrite cleanly.

## Failure modes + debugging

| Symptom | Likely cause | Action |
|---|---|---|
| Cron audit row `wistia_token_unavailable` | `WISTIA_API_TOKEN` missing in Vercel env | Drake adds the token to Vercel env vars + redeploys |
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
SELECT hashed_id, sum(play_count) AS plays_7d, sum(hours_watched) AS hours_7d
FROM wistia_media_daily
WHERE hashed_id IN ('i1173gx76b', 'nbump1crwb')
  AND day >= current_date - interval '7 days'
GROUP BY hashed_id;

-- The TYP video per discovery report
SELECT day, play_count, hours_watched
FROM wistia_media_daily
WHERE hashed_id = 'fbgjxwe62y'
  AND day >= current_date - interval '14 days'
ORDER BY day DESC;
```

## Explicit DEFERRALS (NOT in this ingestion)

Per the spec — these belong to the future aggregation/dashboard layer:

- **Canonical-VSL selection.** The discovery report identified two currently-active VSLs (`i1173gx76b` Direct Closer Funnel + `nbump1crwb` v2). The Engine sheet's "VSL" metric may be one of them, both combined, or include Base 44 (`6qq1eq4wmq`). Aggregation queries pick.
- **Canonical-TYP selection.** Discovery identified `fbgjxwe62y` as the clear winner among the 7 Confirmation Page videos. Aggregation can default to that and let an override be added later.
- **Engagement-rate + avg-view-duration derivations.** Formulas in `docs/schema/wistia_media_daily.md`. Live in the aggregation layer.
- **Engagement-rate semantic confirmation.** Wistia's "engagement" = "average % of video watched." Aggregation-layer engineer should verify that matches the Engine-sheet author's intent before exposing the metric.

## Out of scope (future specs)

- **Visitor / unique-viewer metrics** — the per-day endpoint doesn't expose `visitors` (lifetime stats do). If the Engine sheet ever needs per-day unique viewers, we'd need a different surface (raw event API or a different stats endpoint).
- **Per-page-section breakdowns** — the Confirmation Page Vids project has 7 videos on the same page; if a future metric needs "engagement on confirmation page as a whole" we'd aggregate across all 7 hashed_ids.
- **Stale-data alerting** — no Slack alert today if the cron hasn't ticked successfully in N hours. Add if it becomes a real ops problem.
- **Scheduled inventory refresh decoupled from daily stats** — could optimize by only refreshing `wistia_medias` once daily instead of every 3h, but the cost is negligible (~80 lifetime-stats calls per tick) and the simplicity is worth it.
