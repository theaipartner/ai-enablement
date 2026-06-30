# `clarity_metrics_daily`

Microsoft Clarity per-URL, per-day page-metric mirror. Source for three
Engine-sheet FUNNELS rows: **Landing Page Visits** (row 25), **Avg Time
on Landing Page** (row 26), **Avg Time on Thank-You Page** (row 37 —
re-tagged from "Wistia" after Clarity discovery confirmed time-on-page
is available per URL).

**Migration:** `supabase/migrations/0049_clarity_metrics_daily.sql`
**Runbook:** `docs/runbooks/clarity_ingestion.md`

## The defining constraint — NO BACKFILL POSSIBLE

Clarity's Data Export API returns ONLY the last 1, 2, or 3 days. There is no historical-range endpoint. **History accumulates from cron-start onwards.** A daily cron pulling `numOfDays=3` self-heals up to 2 missed days; a >3-day outage is a permanent gap.

The cron in `api/clarity_sync_cron.py` runs at `0 10 * * *` UTC (~5/6 AM ET) and uses **1 of the 10 daily reqs/project** Clarity allows. Re-pulls are idempotent (composite-PK upsert with last-write-wins).

## Columns

| column | type | nullable | notes |
|---|---|---|---|
| `snapshot_date` | `date` | NO | PK part. UTC date of the cron tick. The data IS "last 3 days rolled up" — there's no per-day breakdown inside Clarity's response. |
| `metric_name` | `text` | NO | PK part. One of: `Traffic`, `EngagementTime`, `ScrollDepth`, `DeadClickCount`, `RageClickCount`, `QuickbackClick`, `ExcessiveScroll`, `ScriptErrorCount`, `ErrorClickCount`. |
| `url` | `text` | NO | PK part. Raw URL with full query string preserved (Clarity does NOT normalize). Sentinel `'__total__'` when Clarity returned `Url: null` (the all-URLs aggregate row in Traffic). |
| `url_path` | `text` | NO | Derived `urlparse(url).path`. Aggregation queries group by this column to roll up the per-querystring variants. Sentinel `'__total__'` matches the url sentinel. |
| `total_session_count` | `integer` | YES | Traffic block only. |
| `total_bot_session_count` | `integer` | YES | Traffic block only. |
| `distinct_user_count` | `integer` | YES | Traffic block only. |
| `pages_per_session_percentage` | `numeric` | YES | Traffic block only. |
| `total_time` | `integer` | YES | EngagementTime block only — seconds. Includes idle tab time. |
| `active_time` | `integer` | YES | EngagementTime block only — seconds. Active-interaction time. Default canonical "time on page" per the spec's `DEFAULT_TIME_METRIC` constant. |
| `raw` | `jsonb` | YES | Full per-URL row dict from the metric block. SOURCE OF TRUTH for the 6 quality-signal blocks (DeadClickCount/RageClickCount/etc.) where typed columns aren't populated. For Traffic + EngagementTime rows, redundant with the typed columns (kept for forensic transparency). |
| `created_at` | `timestamptz` | NO | First-write time. |
| `updated_at` | `timestamptz` | NO | Maintained by `clarity_metrics_daily_set_updated_at` trigger. Reflects the last cron pull that restated this row. |

**Primary key:** `(snapshot_date, metric_name, url)` — natural key; doubles as the `ON CONFLICT` target for idempotent upsert.

**Indexes:**

| index | columns | purpose |
|---|---|---|
| `clarity_metrics_daily_pkey` | (snapshot_date, metric_name, url) | implicit PK btree |
| `clarity_metrics_daily_url_path_date_idx` | (url_path, snapshot_date desc) | "all metrics for `/lp` last 30 days" |
| `clarity_metrics_daily_metric_date_idx` | (metric_name, snapshot_date desc) | "all EngagementTime rows last week" |

## Canonical config — which paths are which

Lives in `ingestion/clarity/__init__.py` (intentionally visible, like Calendly's `CLOSER_EVENT_TYPE_NAMES`):

```python
LANDING_PAGE_PATH    = "/lp"            # row 25 / 26 source path
THANK_YOU_PAGE_PATH  = "/confirmation"  # row 37 source path
DEFAULT_TIME_METRIC  = "active_time"    # 'active_time' | 'total_time'
TOTAL_SENTINEL       = "__total__"
```

**Changing the canonical paths is one-line + an aggregation-query update — no schema change, no re-ingest.** Storage is mirror-everything; the constants only label which paths feed the named metrics.

## Why the hybrid schema (typed + jsonb)

Clarity returns 9 metric blocks with heterogeneous shapes. The hybrid choice:

- **Typed columns** for Traffic + EngagementTime fields — these feed the three named Engine-sheet metrics; aggregation queries are cleaner with real columns + indexes.
- **`raw` jsonb** for everything else — the 6 quality blocks each have a single integer field named the same as the metric; promoting them to columns would bloat the schema for low value. The `raw` column also catches any future Clarity field additions without a migration.

## Example queries

### Landing-page sessions for the last 30 days (rolling-3-day snapshots)

```sql
select snapshot_date, sum(total_session_count) as sessions
from clarity_metrics_daily
where metric_name = 'Traffic'
  and url_path = '/lp'
  and snapshot_date >= current_date - interval '30 days'
group by snapshot_date
order by snapshot_date desc;
```

Note: each `snapshot_date` represents a 3-day rolling sum at that observation time, NOT a single day. The aggregation layer chooses how to deduplicate (e.g. taking the latest snapshot per day, or averaging).

### Avg active time on the thank-you page (per snapshot)

```sql
select snapshot_date,
       sum(active_time)::float
         / nullif(sum(total_session_count_join.total_session_count), 0)
         as avg_active_seconds_per_session
from clarity_metrics_daily eng
join clarity_metrics_daily total_session_count_join
  on eng.snapshot_date = total_session_count_join.snapshot_date
 and eng.url = total_session_count_join.url
 and total_session_count_join.metric_name = 'Traffic'
where eng.metric_name = 'EngagementTime'
  and eng.url_path = '/confirmation'
group by snapshot_date
order by snapshot_date desc;
```

(Or the simpler `avg(active_time)` if "average per pageview row" is enough.)

### Daily total Clarity saw (the null-URL aggregate)

```sql
select snapshot_date, total_session_count, distinct_user_count
from clarity_metrics_daily
where metric_name = 'Traffic'
  and url_path = '__total__'
order by snapshot_date desc;
```

### What paths is Clarity actively seeing?

```sql
select distinct url_path
from clarity_metrics_daily
where snapshot_date = (select max(snapshot_date) from clarity_metrics_daily)
order by url_path;
```

## What populates this table

- **`api/clarity_sync_cron.py`** — daily Vercel cron at `0 10 * * *` UTC. 1 API call → 9 metric blocks → ~200 rows upserted per tick.
- **`scripts/sync_clarity.py --apply`** — manual wrapper, same code path. Use for cold-start or forced refresh.

Both invoke `ingestion.clarity.pipeline.sync_clarity_metrics_daily(db, client)` which batches all parsed rows into a SINGLE `.upsert(rows_list, on_conflict=...)` call. Per-row was the original implementation; production hit HTTP/2 `ConnectionTerminated` after ~96 sequential calls against the pooler. Batching solves it AND is dramatically faster.

## What reads this table

The aggregation layer for the three named Engine-sheet metrics (rows 25, 26, 37). Future readers may surface the 6 quality-signal blocks (e.g. RageClickCount as a UX-quality alarm); for now they're stored cold in `raw`.

## Operational notes

- **Cron rate budget:** 1 req/day of the 10/day cap. Manual `--apply` runs ALSO burn the shared budget — be frugal during dev (a couple of smokes max; the cron handles ongoing ingestion).
- **Cold start:** the first cron tick (or `--apply` invocation) loads whatever Clarity has for the last 3 days. There's nothing more to backfill — history accumulates from this point.
- **Clarity refines recent-day aggregates** — each pull's value for a (date, metric, url) row overwrites the prior value (last-write-wins per the PK). This is desired.
- **`Url: null` rows are stored under the `__total__` sentinel,** not dropped. Filter `url_path != '__total__'` for per-page queries; query `url_path = '__total__'` for the daily site-wide aggregates.
- **`go.theaipartner.io` is the only domain Clarity sees.** If a funnel page ever moves to a different subdomain/domain, it vanishes from Clarity until the install is updated.

## Open questions / future work

- **`/conf` vs `/confirmation`** — two paths look like they could be the same funnel page. Stored separately by url_path; the canonical config points at `/confirmation`. To be reconciled (team decision) if both are real.
- **`pages_per_session_percentage`** — semantic unclear from name alone; not currently consumed.
- **6 quality-signal blocks** — stored cold in `raw`. Promote to typed columns + add a Slack alarm if a future spec wants UX-quality monitoring.
- **`Engine row 95 "Follow Up Meetings"`** — different source (Calendly territory).
