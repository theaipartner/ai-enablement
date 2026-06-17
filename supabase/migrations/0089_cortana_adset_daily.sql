-- 0089_cortana_adset_daily.sql
--
-- Per-ad-set daily mirror of the Cortana Attribution API, sourced from
-- groupBy=medium. Closes the documented "ad-set gap" (the cascade's Ad
-- Set level previously had neither a name nor spend — see
-- docs/sales/data-model.md § cascade).
--
-- Why groupBy=medium: the Cortana API has NO ad-set grouping (its enum is
-- source|campaign|medium|ad), and the per-ad rows carry no parent ad-set
-- reference. But Meta's URL template populates utm_medium with the ad-set
-- name, and Cortana keys each medium row to the real Meta ad-set id via
-- `platformEntityId`. Verified 2026-06-17: that id matches
-- close_leads.adset_id on 21/22 cohort ad sets (the miss is a junk
-- `{{adset.id}}` unfilled-macro row), and per-ad-set `spent` partitions
-- total spend to the cent against the campaign + ad feeds.
--
-- Same shape as cortana_ad_daily (the per-ad mirror) minus nothing — the
-- medium grain returns the full _SHARED_FIELDS metric set. Rows are
-- filtered in ingestion to those with a numeric platformEntityId, which
-- drops the organic / placement noise the medium grouping also emits
-- ("Bot Traffic", "calendly.com", "instagram_reels", "no referrer", ...).
--
-- Schema doc: docs/schema/cortana_adset_daily.md.

create table cortana_adset_daily (
  day date not null,
  entity_key text not null,             -- Cortana dimensionKey (name|||metaId)
  entity_name text,                     -- Cortana dimension (ad-set name, e.g. "Broad")
  platform_entity_id text,              -- Meta ad-set id (joins close_leads.adset_id)
  cortana_entity_id text,
  platform text,
  status text,
  effective_status text,
  campaign_objective text,
  currency text,

  spent numeric,
  impressions integer,
  reach integer,
  frequency numeric,                    -- DERIVED impressions/reach
  clicks integer,
  inline_link_clicks integer,
  unique_clicks integer,
  unique_inline_link_clicks integer,
  ctr numeric,
  unique_ctr numeric,
  cpm numeric,
  cost_per_inline_link_click numeric,
  cost_per_lead numeric,
  cost_per_thru_play numeric,

  page_views integer,
  unique_visitors integer,

  leads integer,
  meta_platform_leads integer,
  total_conversions integer,
  total_revenue numeric,
  total_ltv numeric,
  average_order_value numeric,
  cost_per_conversion numeric,
  roas numeric,
  roi numeric,

  video_plays integer,
  thru_plays integer,
  video_p25 integer,
  video_p50 integer,
  video_p75 integer,
  video_p100 integer,
  avg_watch_time numeric,
  hook_rate numeric,
  hold_rate numeric,
  completion_rate numeric,
  likes integer,
  comments integer,
  shares integer,
  saves integer,

  conversions jsonb not null default '{}'::jsonb,
  raw jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (day, entity_key)
);

comment on table cortana_adset_daily is
  'Per-ad-set daily mirror of the Cortana Attribution API (groupBy=medium, filtered to numeric platformEntityId). One row per (ET day, ad set). Names + spend for the funnel cascade Ad Set level. platform_entity_id joins close_leads.adset_id. See docs/schema/cortana_adset_daily.md.';
comment on column cortana_adset_daily.entity_key is
  'Cortana dimensionKey "<name>|||<platformEntityId>". PK component with day.';
comment on column cortana_adset_daily.entity_name is
  'Cortana dimension = utm_medium = the Meta ad-set name (e.g. "Broad", "Influencers lyd AI").';
comment on column cortana_adset_daily.platform_entity_id is
  'Meta ad-set id. Joins close_leads.adset_id + lead_cycles (cascade Ad Set filter).';
comment on column cortana_adset_daily.frequency is
  'DERIVED impressions/reach (Cortana returns null at row grain).';
comment on column cortana_adset_daily.conversions is
  'Per-event-type attributed conversions for this ad set: {event_type: {count,uniqueCount,revenue,costPer}}.';
comment on column cortana_adset_daily.raw is
  'Full original Cortana row (jsonb) — preserves every field.';

create index cortana_adset_daily_day_idx on cortana_adset_daily (day desc);
create index cortana_adset_daily_platform_entity_idx
  on cortana_adset_daily (platform_entity_id);

create trigger cortana_adset_daily_set_updated_at
  before update on cortana_adset_daily
  for each row execute function set_updated_at();
