-- 0044_meta_ad_daily.sql
-- Mirror table for Meta ad-spend data sourced from the Cortana → Google
-- Sheet pipeline.
--
-- Spec: docs/specs/meta-sheet-ingestion.md.
-- Schema doc: docs/schema/meta_ad_daily.md.
-- Runbook: docs/runbooks/meta_sheet_ingestion.md.
--
-- Background. The Engine sheet's ADVERTISING section needs Meta data
-- (spend, impressions, clicks, CTR, CPM, frequency). Per Drake + team
-- setup, Meta data is NOT pulled from Meta's API — the team uses a
-- tool called Cortana that consolidates Meta data and writes a daily
-- row into a Google Sheet (Sheet ID
-- `1XX6MV7dqAsjlWOiwkuKe9d1uWc1qFR4Dt1CfCVfK8d4`). This table mirrors
-- that Sheet's row-per-day into Supabase; the Gregory aggregation
-- layer reads from here.
--
-- Same principle as Close (CLAUDE.md § Core Principles #1+#2): mirror
-- the raw data; agents query our DB, not the Sheet.
--
-- Design decisions (validated against live Sheet read on 2026-05-23):
--
--   1. PK is `day date` (one row per day). Idempotent upsert on `day`
--      means the daily cron can re-pull the Sheet without duplicating;
--      Cortana restates the current day with corrected numbers and
--      that restated row simply overwrites (last-write-wins, which is
--      the desired behavior — the latest pull of a day is the most
--      complete).
--
--   2. CTR IS DERIVED, not ingested. The Sheet's "CTR" column is
--      broken — Cortana exports it formatted as a date serial (every
--      row reads `1899-12-31` = serial-0). Storing that as text would
--      poison aggregation queries. Instead the ingestion layer
--      computes `ctr = link_clicks / impressions * 100` and stores
--      it here; the broken source value is preserved in
--      `ctr_source_raw` for forensic transparency (so a future audit
--      can verify the data drift / confirm the fix held).
--
--   3. Numeric columns are NUMERIC (variable precision) rather than
--      fixed-precision because the Sheet's values include decimals
--      with no consistent scale (`450.9`, `1632.6`, `74.06`, `1.16`).
--      Integers (impressions, clicks counts) are integer.
--
--   4. Standard `created_at` / `updated_at` + `set_updated_at` trigger,
--      same shape as 0038/0043 ship — `updated_at` reflects the last
--      upsert (= the last cron pull that restated the day's values).

create table meta_ad_daily (
  day date primary key,

  -- Direct mirrors of the Sheet's numeric columns. Defensive nulls so
  -- a partial-row write (e.g. Cortana hasn't finished writing today)
  -- doesn't blow up; aggregation layer treats NULL as "data not yet
  -- recorded for this day."
  frequency numeric,
  amount_spent numeric,
  impressions integer,
  clicks_all integer,
  link_clicks integer,
  unique_link_clicks integer,
  cpm numeric,
  cost_per_unique_link_click numeric,

  -- DERIVED — link_clicks / impressions * 100, computed in the
  -- ingestion layer (NOT the Sheet's broken CTR column). NULL when
  -- impressions is 0 or missing.
  ctr numeric,

  -- Forensic: the raw value Cortana wrote for CTR. Today every row
  -- reads `1899-12-31` (Sheets serial 0 = the percentage-formatted-as-
  -- date bug). If Cortana ever fixes the export, this column will
  -- show the change without code edits; if a different column starts
  -- exhibiting the same drift, we'll have precedent for handling it.
  ctr_source_raw text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table meta_ad_daily is
  'Mirror of Cortana → Google-Sheet Meta ad-spend rows. One row per day, idempotent upsert on day. CTR is derived (link_clicks/impressions*100); the Sheet''s source CTR column is broken (formats as date serial 1899-12-31). See docs/schema/meta_ad_daily.md.';

comment on column meta_ad_daily.day is
  'Calendar day the metrics are attributed to. Source: Sheet col A (literal date string). PK; same day re-pulled overwrites (Cortana restates current day with corrected numbers — last-write-wins is desired).';

comment on column meta_ad_daily.ctr is
  'DERIVED: link_clicks/impressions*100. NOT the Sheet''s CTR column — that one is broken (formats as date serial). See migration 0044 comment for context.';

comment on column meta_ad_daily.ctr_source_raw is
  'Forensic capture of the Sheet''s CTR column raw text. Today always `1899-12-31` (the serial-0 bug). If Cortana ever fixes the export this column will reflect that without code changes.';

-- Recent-day-first ordering matches how the aggregation layer will
-- query this table (last-7-days, last-30-days for ADVERTISING-section
-- rollups + cost-per-X derived rates). Single-column index on the
-- PK already covers DESC scans, so no separate idx needed.

create trigger meta_ad_daily_set_updated_at
  before update on meta_ad_daily
  for each row execute function set_updated_at();
