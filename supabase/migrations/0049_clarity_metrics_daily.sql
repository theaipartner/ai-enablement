-- 0049_clarity_metrics_daily.sql
-- Mirror table for Microsoft Clarity page metrics — source for THREE
-- Engine-sheet FUNNELS rows:
--   * Landing Page Visits           (row 25; Traffic.totalSessionCount)
--   * Average Time on Landing Page  (row 26; EngagementTime.totalTime/activeTime)
--   * Average Time on Thank-You Page (row 37; same EngagementTime)
--
-- Spec: docs/specs/clarity-ingestion.md
-- Discovery: docs/reports/clarity-discovery.md (real response shape;
--   8 distinct paths from 45 URL+QS variants in 3 days; both
--   totalTime + activeTime per URL; null-URL aggregate row in Traffic;
--   the row-37 "Wistia" mis-tag is actually a Clarity metric).
-- Schema doc: docs/schema/clarity_metrics_daily.md.
-- Runbook: docs/runbooks/clarity_ingestion.md.
--
-- ============================================================================
-- The defining constraint — NO BACKFILL POSSIBLE.
-- ============================================================================
-- Clarity's Data Export API returns ONLY the last 1-3 days, ever. There
-- is no historical-range endpoint. History accumulates going-forward
-- from the moment the cron starts firing. A daily cron pulling
-- numOfDays=3 self-heals up to 2 missed days; a >3-day outage = a
-- permanent gap (acceptable; documented).
--
-- Idempotent upsert on (snapshot_date, metric_name, url) — re-pulling
-- the same 3-day window cleanly overwrites because Clarity may refine
-- recent-day aggregates and last-write-wins is the desired behavior.
--
-- Migration number is 0049, NOT auto-detected next. Calendly took 0047
-- on main; Typeform claimed 0048 on the parallel worktree-b (not yet
-- merged at the time this lands). The spec explicitly hardcodes 0049
-- to avoid colliding with the unmerged Typeform migration.
--
-- ============================================================================
-- Schema design — hybrid (typed-columns + jsonb catch-all)
-- ============================================================================
-- Clarity returns NINE metric blocks per response, each with a
-- different field shape:
--
--   Traffic           → totalSessionCount, totalBotSessionCount,
--                       distinctUserCount, pagesPerSessionPercentage, Url
--   EngagementTime    → totalTime, activeTime, Url
--   ScrollDepth       → ScrollDepth (single numeric field), Url
--   DeadClickCount    → DeadClickCount, Url
--   RageClickCount    → RageClickCount, Url
--   QuickbackClick    → QuickbackClick, Url
--   ExcessiveScroll   → ExcessiveScroll, Url
--   ScriptErrorCount  → ScriptErrorCount, Url
--   ErrorClickCount   → ErrorClickCount, Url
--
-- Hybrid choice: typed columns for the Traffic + EngagementTime hot
-- fields (these feed the three named Engine-sheet metrics; aggregation
-- queries are cleaner with real columns + indexes) PLUS a `raw` jsonb
-- catch-all for everything else. The 6 quality-signal blocks
-- (DeadClickCount, RageClickCount, etc.) live in jsonb because:
--   (a) they're single-field metrics — typed columns would balloon the
--       column count for low value today
--   (b) they're not currently on the Engine sheet
--   (c) jsonb leaves room for future Clarity field additions without
--       another migration
--
-- The parser ALSO writes the full row dict into `raw` regardless of
-- metric_name — so the typed columns are a denormalized convenience
-- for the hot path; `raw` is the source of truth if anyone needs a
-- field we didn't promote.
--
-- ============================================================================
-- Sentinel handling for the null-URL aggregate row
-- ============================================================================
-- Traffic has ONE row per response where `Url: null` — Clarity's
-- "all URLs total" aggregate. Lean per spec: store with a clear
-- sentinel so the daily total is queryable.
--
-- Both `url` and `url_path` use the literal string `'__total__'` when
-- Clarity returned null. This avoids:
--   * NULL semantics in the composite PK (NULLs compare distinct in
--     btree by default, breaking idempotent upsert)
--   * a separate "total" table or column for what's really just
--     another per-segment row
--
-- Queries filtering specific paths use `url_path != '__total__'`.

create table clarity_metrics_daily (
  -- Natural key — Clarity has no stable per-row id; the (date, metric,
  -- url) tuple IS the row's identity. Composite PK doubles as the
  -- ON CONFLICT target for idempotent upserts.
  snapshot_date date not null,
  metric_name text not null,
  url text not null,

  -- Derived from `url` at ingest time: urlparse(url).path. Aggregation
  -- queries group by this column because Clarity does NOT normalize
  -- URLs — the 3-day discovery sample had 45 URL+QS variants reducing
  -- to just 8 distinct paths. Storing both keeps the raw forensic
  -- value AND makes the aggregation join cheap.
  url_path text not null,

  -- Hot typed columns from Traffic
  total_session_count integer,
  total_bot_session_count integer,
  distinct_user_count integer,
  pages_per_session_percentage numeric,

  -- Hot typed columns from EngagementTime — BOTH stored (the
  -- aggregation default is active_time per the spec's canonical
  -- config, but storing both means the choice is switchable in the
  -- aggregation layer without re-ingesting).
  total_time integer,                   -- seconds
  active_time integer,                  -- seconds

  -- Catch-all. Parser writes the entire metric's per-URL row dict in
  -- here regardless of metric_name. For the 6 quality-signal blocks
  -- (DeadClickCount, RageClickCount, QuickbackClick, ExcessiveScroll,
  -- ScriptErrorCount, ErrorClickCount) this is the ONLY column with
  -- meaningful data. For Traffic + EngagementTime rows, it's a
  -- forensic duplicate of the typed columns.
  raw jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (snapshot_date, metric_name, url)
);

comment on table clarity_metrics_daily is
  'Microsoft Clarity per-URL per-day metrics mirror. Idempotent upsert ON CONFLICT (snapshot_date, metric_name, url). NO historical backfill possible — Clarity''s API returns only the last 1-3 days. History accumulates from cron start; >3-day outage = permanent gap. See docs/schema/clarity_metrics_daily.md.';

comment on column clarity_metrics_daily.url is
  'Raw URL as returned by Clarity in the row''s Url field. NOT normalized — query strings preserved. The sentinel string ''__total__'' is used when Clarity returned Url: null (the all-URLs aggregate row in Traffic).';

comment on column clarity_metrics_daily.url_path is
  'urlparse(url).path — derived at ingest. Aggregation queries group by this column to roll up the per-querystring variants. The sentinel ''__total__'' matches the url sentinel for the aggregate row.';

comment on column clarity_metrics_daily.metric_name is
  'Clarity''s metricName: Traffic | EngagementTime | ScrollDepth | DeadClickCount | RageClickCount | QuickbackClick | ExcessiveScroll | ScriptErrorCount | ErrorClickCount. All 9 blocks mirrored from the single daily API call.';

comment on column clarity_metrics_daily.active_time is
  'EngagementTime.activeTime in seconds — time user was actively interacting (clicks, scrolls). Default canonical "time on page" metric per the spec''s canonical config; better engagement signal than total_time which includes idle tab time.';

comment on column clarity_metrics_daily.total_time is
  'EngagementTime.totalTime in seconds — total time on page including idle. Stored alongside active_time so the aggregation layer can switch between them without re-ingesting.';

comment on column clarity_metrics_daily.raw is
  'Full per-URL row dict from the metric block, regardless of metric_name. Source of truth for the 6 quality-signal blocks (DeadClickCount, RageClickCount, etc.) where typed columns aren''t populated. Future-proofs against Clarity adding fields without requiring a migration.';

-- Aggregation queries pivot on:
--   * (url_path, snapshot_date) — "give me all metrics for /lp last 30 days"
--   * (metric_name, snapshot_date) — "all EngagementTime rows last week"
-- The PK index (snapshot_date, metric_name, url) already covers
-- date-bounded lookups; these two cover the path-rollup + per-metric
-- query patterns.

create index clarity_metrics_daily_url_path_date_idx
  on clarity_metrics_daily (url_path, snapshot_date desc);

create index clarity_metrics_daily_metric_date_idx
  on clarity_metrics_daily (metric_name, snapshot_date desc);

create trigger clarity_metrics_daily_set_updated_at
  before update on clarity_metrics_daily
  for each row execute function set_updated_at();
