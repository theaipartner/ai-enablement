# Runbook: Microsoft Clarity Ingestion (Daily Self-Healing Cron, No Backfill)

Schema doc: `docs/schema/clarity_metrics_daily.md`. Migration: `0049_clarity_metrics_daily.sql`.

This runbook covers source endpoint, auth, the no-backfill model, the daily cron, the manual wrapper, failure modes, and what's intentionally deferred.

## What this ingestion does

Mirrors Microsoft Clarity page metrics into `clarity_metrics_daily`. **One** API endpoint, **one** call per cron tick, **nine** metric blocks per response, **~200** rows upserted per tick (split across 8-9 distinct paths × 9 metrics).

Source for three Engine-sheet FUNNELS rows (paths updated 2026-05-25 after Zain's project rename — see `ingestion/clarity/__init__.py` for canonical values):
- **Landing Page Visits** (row 25; `Traffic.totalSessionCount` for `/lp-vsl`)
- **Avg Time on Landing Page** (row 26; `EngagementTime.active_time` for `/lp-vsl`)
- **Avg Time on Thank-You Page** (row 37; `EngagementTime.active_time` for `/lp-confirmation`)

Row 37 was originally mis-tagged "Wistia" on the Engine sheet; discovery confirmed Clarity has per-URL time-on-page. **Re-tag the sheet** (not in scope here; flagged in the report).

## Architecture

```
   ┌─────────────────────────────────────┐
   │ Microsoft Clarity (external)        │
   │   www.clarity.ms/export-data        │
   │   /api/v1/project-live-insights     │
   └─────────────────┬───────────────────┘
                     │ GET ?numOfDays=3&dimension1=URL
                     │ Authorization: Bearer <CLARITY_API_KEY>
                     ▼
   ┌─────────────────────────────────────┐
   │ api/clarity_sync_cron.py            │
   │   Vercel cron @ 0 10 * * * (UTC)    │
   │   CRON_SECRET bearer auth           │
   └─────────────────┬───────────────────┘
                     │ ingestion/clarity/pipeline.sync_clarity_metrics_daily
                     │   → fetch (1 req) → parse → batch upsert
                     ▼
   ┌─────────────────────────────────────┐
   │ clarity_metrics_daily               │
   │   PK (snapshot_date, metric, url)   │
   │   typed cols + raw jsonb            │
   └─────────────────────────────────────┘
```

## The defining constraint — NO BACKFILL

Clarity's API returns **only the last 1-3 days**. Period. There is no historical endpoint.

- **History accumulates from cron-start onwards.** Older data not pulled is permanently unrecoverable.
- **Daily cron with `numOfDays=3` self-heals up to 2 missed days.** A 3-day or longer outage = permanent gap.
- **Re-pulls are idempotent.** Composite-PK on (snapshot_date, metric_name, url) with batched upsert + last-write-wins.
- **The cron uses 1 of 10 daily reqs.** Massive headroom for re-probes during incidents.

## Auth

- **Token:** `CLARITY_API_KEY` (Personal Access Token / admin-only). Bearer header on every call.
- **Where it must be set:**
  - **`.env.local`** for local runs (`scripts/sync_clarity.py`, tests).
  - **Vercel project env vars** for the deployed cron. Add it explicitly, never silently.
- **Token generation:** Clarity → Settings → Data Export → Generate new API token. **Admin-only**; if you're not admin, Nabeel runs it. Naming convention: 4-32 chars, alphanumerics + `- _ .` only. No spaces or special characters.
- **Rotation:** if 401s start appearing in the cron audit, admin regenerates the token. Update both `.env.local` AND Vercel; redeploy.

## Endpoint

| Endpoint | Purpose | Notes |
|---|---|---|
| `GET https://www.clarity.ms/export-data/api/v1/project-live-insights` | The ONLY endpoint we hit. Query params: `numOfDays={1,2,3}` + `dimension1=URL` (+ up to `dimension2`, `dimension3` if ever needed). | **Method is GET, not POST.** The discovery spec said POST; the actual Microsoft Learn docs and our successful 200 call confirm GET. |

**Request:**
```http
GET /export-data/api/v1/project-live-insights?numOfDays=3&dimension1=URL HTTP/1.1
Host: www.clarity.ms
Authorization: Bearer <CLARITY_API_KEY>
Accept: application/json
User-Agent: ai-enablement/1.0 (+drake@theaipartner.io)
```

**Response shape** (`200 OK`):
```json
[
  {"metricName": "Traffic",        "information": [{...row with Url}, ...]},
  {"metricName": "EngagementTime", "information": [...]},
  ... 9 blocks total ...
]
```

Each row has metric-specific fields + a `Url` dimension value (capital U). `Url: null` appears once in Traffic — the all-URLs aggregate row, stored under sentinel `__total__`.

## Rate limit

- **10 reqs/project/day** — hard cap. Returns HTTP 429 "Exceeded daily limit" when exceeded.
- **1000 rows per response** — no pagination. Our typical response is ~200 rows; nowhere near.
- **3 dimensions per request max** — we use 1 (`dimension1=URL`).

The daily cron uses 1 req. Manual `--apply` and `--smoke` invocations each ALSO burn 1 req against the shared project budget — be frugal during dev.

## Cron

| Field | Value |
|---|---|
| Path | `/api/clarity_sync_cron` |
| Schedule | `0 10 * * *` (UTC; ~5/6 AM ET) |
| Auth | `Authorization: Bearer ${CRON_SECRET}` |
| Vercel maxDuration | 60s |
| Audit source | `clarity_sync` in `webhook_deliveries` |

Why daily, not more frequent: Clarity data is daily-grained and the 3-day re-pull self-heals up to 2 missed days. Hourly would be wasteful (and would consume budget meant for incident re-probes).

Manual trigger:
```bash
curl -i -X POST \
  -H "Authorization: Bearer $CRON_SECRET" \
  https://ai-enablement-sigma.vercel.app/api/clarity_sync_cron
```

## Manual sync wrapper

```bash
.venv/bin/python scripts/sync_clarity.py             # dry-run (no API call, no DB write)
.venv/bin/python scripts/sync_clarity.py --smoke     # 1 real API call, parse, NO DB write
.venv/bin/python scripts/sync_clarity.py --apply     # 1 real API call, parse, UPSERT
.venv/bin/python scripts/sync_clarity.py --apply --days 1   # narrower window
```

**Each `--smoke` / `--apply` burns 1 of 10 daily project reqs.** The cron uses 1 on its own. Coordinate during incident debugging — if someone is running manual syncs and the cron also fires, you can hit the cap.

`--smoke` is the canonical pre-`--apply` gate per CLAUDE.md § Operational patterns. It exercises the full fetch + parse path against the real API without DB writes, so parser drift surfaces before any DB row lands.

## Cold start

There is NO backfill — the first cron tick (or `--apply` invocation) loads whatever Clarity has for the last 3 days. From then on, history accumulates one daily snapshot at a time.

If the cron is paused for >3 days, the missed window is permanently gone. Acceptable by design; the aggregation layer should report "data not yet captured" rather than misleading zeros.

## Canonical config — which paths are which

`ingestion/clarity/__init__.py` holds three load-bearing constants:

```python
LANDING_PAGE_PATH    = "/lp"            # row 25 / 26 source
THANK_YOU_PAGE_PATH  = "/confirmation"  # row 37 source
DEFAULT_TIME_METRIC  = "active_time"    # 'active_time' | 'total_time'
```

Both `total_time` and `active_time` are mirrored at ingest — flipping the default is a one-line aggregation-layer change, no re-ingest. Changing the canonical paths is also one line; everything Clarity returns is stored regardless of which path is canonical.

## Footguns

### 1. HTTP/2 ConnectionTerminated on per-row upserts

The supabase-py client's httpx-backed HTTP/2 transport drops streams after ~96 sequential per-row upserts against the pooler. The pipeline batches ALL parsed rows into a SINGLE `.upsert(rows_list, on_conflict=...)` call to dodge this. Don't refactor back to per-row.

### 2. URLs are NOT normalized

Clarity returns full query strings (`?event_id=...&fbp=...&utm_*=...`). 45 raw URL strings in discovery collapsed to just 8 paths. Aggregation MUST group by `url_path` (the derived `urlparse(url).path` column), not `url`.

### 3. GET, not POST

The discovery spec said POST; the actual API is GET with query params. Both Microsoft Learn docs and our 200 confirm GET. If anyone reads the discovery report's older draft and tries POST, they'll hit 400 / 404.

### 4. Url field capitalization differs request-vs-response

Request: `dimension1=URL` (all caps). Response field: `Url` (capital U, lowercase rl). The parser accepts a few capitalizations defensively.

### 5. The Engine row 37 ("Avg Time on Thank-You Page") was tagged Wistia on the sheet

Discovery resolved this: Clarity has per-URL time-on-page; it's a Clarity metric. **Re-tag the sheet manually** (or via a separate spec to update the rollup definitions).

### 6. Manual --apply consumes the shared 10/day budget

Don't loop-retry. Don't run --smoke + --apply back-to-back unless you have a reason. The cron uses 1/day; leave headroom for incident re-probes.

## Failure modes + debugging

| Symptom | Likely cause | Action |
|---|---|---|
| Cron audit `clarity_token_unavailable` | `CLARITY_API_KEY` missing in Vercel | Add it in Vercel; redeploy. |
| Cron audit `errors: ["...HTTP 401..."]` | Token expired/revoked | Admin regenerates Clarity token; update `.env.local` + Vercel. |
| Cron audit `errors: ["...HTTP 429..."]` | Daily 10-req cap exceeded | Wait 24h. Check if manual `--apply` runs piled on top of the cron. |
| Cron audit `errors: ["batch upsert (N rows): ..."]` | Supabase write transport failure | Check `webhook_deliveries.processing_error` for the full exception. Re-run the cron tick manually (idempotent). |
| `rows_parsed=0` | Clarity returned empty `information` arrays | Possible Clarity-side outage or zero-traffic-period. Check `body` in the audit row. |
| `distinct_paths` missing `/lp` or `/confirmation` | A canonical page got no traffic in the 3-day window | Investigate the funnel separately; not an ingestion bug. |
| `distinct_paths` shows a new path | New funnel route launched. | Possibly want to expand canonical config; chat with Aman. |

## Out of scope (future specs)

- **Aggregation-layer SQL views** for the three named Engine-sheet rows. Will need to handle the per-snapshot 3-day rolling-sum semantic (each row is "3 days as observed on snapshot_date") + the `url_path = '__total__'` filter.
- **Multi-dimension probes** (e.g. URL × Browser, URL × Country) — we have 2 unused dimensions per request. Add when a Q comes that needs them.
- **`/conf` vs `/confirmation` reconciliation** — (team decision); trivial to expand the canonical config either way.
- **6 quality-signal blocks as UX alarms** — RageClickCount surge alerting, etc. Stored cold today in `raw`.
- **Engine sheet row-37 re-tag** — Wistia → Clarity. Manual sheet edit; flagged in the report.
- **Daily total deduplication strategy** — the aggregation layer chooses how to reduce overlapping 3-day-rolling snapshots into clean per-day metrics.
