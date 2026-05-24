-- 0045_wistia_ingestion_tables.sql
-- Mirror tables for Wistia video analytics (the FUNNELS section of the
-- Engine sheet: VSL Engagement Rate, VSL Average View Duration, TYP
-- Engagement Rate, TYP Average View Duration).
--
-- Spec: docs/specs/wistia-ingestion.md.
-- Discovery: docs/reports/wistia-discovery.md (per-day stats verified
-- available via /modern/stats/medias/{id}/by_date; engagement-rate +
-- avg-view-duration are DERIVED from raw volume + media duration).
-- Schema docs: docs/schema/wistia_medias.md + wistia_media_daily.md.
-- Runbook: docs/runbooks/wistia_ingestion.md.
--
-- Design decisions (per spec):
--
--   1. Ingest ALL 80 medias' raw per-day stats (Core Principle #1 —
--      mirror everything, decide what to use at aggregation time).
--      Volume is trivial (~80 medias × ~500 days = ~40k rows max).
--
--   2. Engagement-rate + avg-view-duration are NOT stored — DERIVED
--      at aggregation time from (hours_watched, play_count,
--      duration_seconds). This spec only stores raw. Reasoning: the
--      derivations live in the future dashboard/aggregation layer
--      where canonical-VSL/TYP selection also happens; pre-computing
--      here would lock the choice.
--
--   3. `hours_watched` is in HOURS as a float (Wistia API quirk —
--      e.g. 0.085 ≈ 5m6s). Stored raw; aggregation layer converts
--      via × 3600 to get seconds. Loudly documented in the column
--      comment.
--
--   4. Loose FK posture on `wistia_media_daily.hashed_id` →
--      `wistia_medias.hashed_id`. Backfill order doesn't guarantee
--      reference rows land first; aggregation layer left-joins for
--      label resolution. Same pattern as close_calls / close_sms.
--
--   5. `wistia_medias.lifetime_avg_percent_watched` is an INTEGER per
--      Wistia's API (e.g. 25 for 25%). Stored as int to match the
--      source; aggregation layer can use the derived per-day figure
--      for precision when needed.

-- ============================================================================
-- wistia_medias — reference table, one row per media
-- ============================================================================
--
-- ~80 rows in this org today. Refreshed each cron tick from
-- /v1/medias.json + /v1/medias/{id}/stats.json. The lifetime_* fields
-- are denormalized cross-check values — the daily mirror is the
-- canonical source for time-series queries.

create table wistia_medias (
  hashed_id text primary key,
  name text,
  duration_seconds numeric,
  project_id text,
  project_name text,
  media_type text,

  -- Lifetime aggregates from /v1/medias/{id}/stats.json. Refreshed on
  -- every sync. Cross-check values, NOT the time-series source.
  lifetime_page_loads integer,
  lifetime_visitors integer,
  lifetime_plays integer,
  lifetime_percent_of_visitors_clicking_play integer,
  lifetime_avg_percent_watched integer,

  -- Wistia-side lifecycle timestamps (created/updated AT WISTIA, not
  -- in our DB). Distinct from our row's created_at/updated_at.
  wistia_created_at timestamptz,
  wistia_updated_at timestamptz,

  -- Our lifecycle
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table wistia_medias is
  'Mirror of Wistia /v1/medias.json + /v1/medias/{id}/stats.json. Reference table for the time-series wistia_media_daily. ~80 rows in this org today. Refreshed each cron tick.';

comment on column wistia_medias.lifetime_avg_percent_watched is
  'Wistia averagePercentWatched — INTEGER percentage (e.g. 25 for 25%). Lifetime aggregate cross-check; aggregation layer derives the per-day equivalent from wistia_media_daily for precision.';

comment on column wistia_medias.duration_seconds is
  'Media duration in SECONDS as float (e.g. 305.6 = 5m05s). Required by the engagement-rate derivation: rate = hours_watched*3600 / (play_count * duration_seconds) * 100.';

create index wistia_medias_project_id_idx on wistia_medias (project_id) where project_id is not null;

create trigger wistia_medias_set_updated_at
  before update on wistia_medias
  for each row execute function set_updated_at();

-- ============================================================================
-- wistia_media_daily — per-day stats mirror, one row per (media, day)
-- ============================================================================
--
-- Source: GET /modern/stats/medias/{hashed_id}/by_date — returns a
-- list of {date, load_count, play_count, hours_watched}, one entry
-- per calendar day. Zero-activity days return zeros, not nulls.
--
-- Idempotency: UPSERT ON CONFLICT (hashed_id, day). The cron pulls a
-- rolling 14-day window every 3h, so the most-recent days get
-- restated on every tick — last-write-wins is the desired behavior
-- (newer pulls reflect Wistia's most-recent counts after late-arriving
-- view events).

create table wistia_media_daily (
  hashed_id text not null,
  day date not null,
  load_count integer not null default 0,
  play_count integer not null default 0,

  -- HOURS as float (Wistia API convention). Aggregation layer
  -- converts via × 3600 to get seconds. See migration header for
  -- the engagement-rate + avg-view-duration derivations.
  hours_watched numeric not null default 0,

  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (hashed_id, day)
);

comment on table wistia_media_daily is
  'Per-day stats mirror from /modern/stats/medias/{id}/by_date. Idempotent UPSERT on (hashed_id, day). Refreshed on a rolling 14-day window every 3h via api/wistia_sync_cron.';

comment on column wistia_media_daily.hours_watched is
  'HOURS as float (Wistia API quirk — e.g. 0.085 ≈ 5m6s). NOT seconds. Aggregation layer converts via × 3600.';

-- Per-day cross-video rollups (e.g. "total hours_watched across all
-- VSL variants on day X") scan by `day`. PK covers per-media-per-day
-- point lookups.
create index wistia_media_daily_day_idx on wistia_media_daily (day desc);

create trigger wistia_media_daily_set_updated_at
  before update on wistia_media_daily
  for each row execute function set_updated_at();
