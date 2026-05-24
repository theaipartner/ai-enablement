-- 0046_wistia_timeseries_columns.sql
-- Cut the Wistia per-day ingestion over from the legacy by_date
-- endpoint (synthesized hours_watched, fake daily engagement) to the
-- new /modern/analytics/medias/{id}/timeseries endpoint (real per-day
-- played_time + engagement_rate + bot-filtered plays).
--
-- Spec: docs/specs/wistia-timeseries-migration.md
-- Verification: docs/reports/wistia-watchtime-verify.md (proves the
--   legacy by_date hours_watched is play_count × per-media constant —
--   identical ratio to 10 decimal places across 27 active days — and
--   shows timeseries endpoint returns 28 distinct engagement values
--   2.79%–25.38% across the same days).
--
-- Design decisions baked in here (per spec):
--
--   1. ALTER, don't replace. Existing rows + the legacy columns stay;
--      the new columns get populated going forward by the migrated
--      pipeline. Same (hashed_id, day) PK — no row keying change.
--
--   2. The two endpoints disagree on play counts (timeseries is
--      bot-filtered, ~14% lower per verification report). To avoid
--      corrupting the existing play_count series at the cutover
--      boundary, the new filtered count lands in a SEPARATE column
--      `plays_filtered`. The aggregation layer picks canonical.
--
--   3. `hours_watched` stays (DEPRECATED but NOT dropped). Historical
--      audit value; the cutover pipeline doesn't overwrite it on
--      existing rows. New rows get `hours_watched = 0` (the column
--      default — wasted bytes for a value the new endpoint doesn't
--      report, but cheaper than fragmenting the schema with a NULL
--      semantic change). Column comment marks deprecation.
--
--   4. `played_time_seconds` is INTEGER seconds (the timeseries
--      endpoint returns it that way). NOT hours-as-float. Loudly
--      different from the deprecated `hours_watched`.
--
--   5. `engagement_rate` is NUMERIC(6,4) — a 0–1 float (e.g. 0.1473
--      for 14.73%). Stored RAW, not ×100. Aggregation/display formats.
--      Same shape for `play_rate` and `cta_conversion_rate`.
--
--   6. CTA + form fields mirrored from the same payload (cheap; mirror-
--      everything-Close-sends per Core Principle #1). cta_conversions
--      + form_conversions are the load-bearing ones; cta_impressions
--      + cta_conversion_rate also captured.

-- Add the timeseries-sourced columns. All nullable defaults — pre-
-- cutover rows have NULLs until the migrated pipeline re-touches them.
alter table wistia_media_daily
  add column played_time_seconds integer,
  add column engagement_rate numeric(6, 4),
  add column play_rate numeric(6, 4),
  add column plays_filtered integer,
  add column unique_plays integer,
  add column unique_visitors integer,
  add column unique_loads integer,
  add column cta_impressions integer,
  add column cta_conversions integer,
  add column cta_conversion_rate numeric(6, 4),
  add column form_conversions integer;

-- Loudly mark the legacy column deprecated. Column kept (not dropped)
-- as historical audit; aggregation layer must NOT trust it for daily
-- watch-time / engagement. See verification report.
comment on column wistia_media_daily.hours_watched is
  'DEPRECATED (2026-05-24 cutover). Was sourced from /modern/stats/medias/{id}/by_date which synthesized this value as play_count × per-media constant (= lifetime_avg_pct × duration). NOT a true per-day metric. Use played_time_seconds for real daily watch-time. Column retained for historical audit; NOT refreshed by the post-cutover pipeline.';

comment on column wistia_media_daily.play_count is
  'LEGACY play count from /modern/stats/medias/{id}/by_date. Raw plays (not bot-filtered). Pre-cutover rows have this; the post-cutover pipeline does NOT update this column. Use plays_filtered for bot-filtered counts from the new timeseries endpoint. Both columns coexist by design — the two endpoints disagree on play counts (timeseries ~14% lower per verification report).';

comment on column wistia_media_daily.load_count is
  'LEGACY load count from by_date endpoint, same deprecation note as play_count. Use unique_loads for the timeseries-sourced bot-filtered equivalent.';

comment on column wistia_media_daily.played_time_seconds is
  'Real per-day watch time, SECONDS as integer. Source: /modern/analytics/medias/{id}/timeseries.played_time. The replacement for the deprecated hours_watched column.';

comment on column wistia_media_daily.engagement_rate is
  'Real per-day engagement rate, 0–1 float (e.g. 0.1473 for 14.73%). Source: timeseries.engagement_rate. Stored RAW — display layer formats to percentage. Verification report showed range 2.79%–25.38% across 28 days on the probe media (real variance, not the constant artifact of the legacy by_date approach).';

comment on column wistia_media_daily.plays_filtered is
  'Bot-filtered plays count from the new timeseries endpoint. Distinct from play_count (legacy by_date raw plays); verification showed timeseries ~14% lower (e.g. 202 vs 236 on 2026-05-23). Aggregation layer picks canonical between the two.';

comment on column wistia_media_daily.play_rate is
  'plays / unique_loads, 0–1 float. Source: timeseries.play_rate. Stored raw.';

comment on column wistia_media_daily.cta_conversion_rate is
  'cta_conversions / cta_impressions, 0–1 float. Source: timeseries.cta_conversion_rate. Stored raw.';

comment on table wistia_media_daily is
  'Per-day stats mirror. Post-2026-05-24 cutover: source is /modern/analytics/medias/{id}/timeseries?granularity=daily (real per-day engagement + watch-time). Pre-cutover columns (load_count, play_count, hours_watched) sourced from the legacy /modern/stats/medias/{id}/by_date and are DEPRECATED — see column comments. Idempotent UPSERT on (hashed_id, day). Rolling 14-day window refresh every 3h via api/wistia_sync_cron.';

-- No new indexes — existing (hashed_id, day) PK + day DESC index cover
-- the access patterns; the new columns join via the same PK.
