-- 0057_cortana_ad_campaign_daily.sql
--
-- Per-campaign and per-ad daily mirrors of the Cortana Attribution API
-- (https://app.usecortana.ai/api/v1/.../attribution/data). Replaces and
-- enriches the old Cortana → Google-Sheet → meta_ad_daily pipeline,
-- which was broken (CTR exported as a date serial) and account-level
-- only.
--
-- Spec/discovery: docs/runbooks/cortana_ingestion.md.
-- Schema docs: docs/schema/cortana_ad_daily.md, cortana_campaign_daily.md.
--
-- Three grains are ingested (one ET calendar day at a time, upserted):
--   - source grain ("Meta Ads" row) → meta_ad_daily   (existing table,
--     unchanged schema; ctr/frequency are now REAL Meta numbers)
--   - campaign grain                → cortana_campaign_daily  (this file)
--   - ad grain                      → cortana_ad_daily        (this file)
--
-- Design decisions:
--   1. PK (day, entity_key). entity_key = Cortana's `dimensionKey`
--      ("<name>|||<platformEntityId>") — stable + unique within a day.
--      Idempotent upsert so the cron re-pulls a trailing window and
--      Meta's ~72h restatements just overwrite (last-write-wins).
--   2. Typed columns for every metric we model + `conversions` jsonb
--      (the per-entity attributed-funnel blob: lead / qualified_lead /
--      appointment_booked / purchase / ... each {count,uniqueCount,
--      revenue,costPer}) + `raw` jsonb holding the FULL original row so
--      no field is lost, even ones not yet modeled (rankings, creative-
--      analysis tags). Per Drake: "ingest everything we can."
--   3. Video metrics (video_plays, thru_plays, hook_rate, ...) are the
--      Meta IN-FEED ad-creative video stats — NOT the landing-page VSL
--      (that's Wistia, tracked separately). Image ads carry NULLs here.
--   4. Counts are integer; money/rates are numeric (variable precision,
--      matching meta_ad_daily 0044). frequency is DERIVED in ingestion
--      (impressions/reach) — Cortana returns it null at row grain.
--   5. Attributed conversion COUNTS (leads/bookings/closes per ad) are
--      net-new attribution data, NOT a duplicate of the raw lead/
--      booking/close records held by Typeform/Calendly/Close — they are
--      the ad↔outcome join we have nowhere else.

-- ===========================================================================
-- cortana_campaign_daily
-- ===========================================================================

create table cortana_campaign_daily (
  day date not null,
  entity_key text not null,             -- Cortana dimensionKey (name|||metaId)
  entity_name text,                     -- Cortana dimension (campaign name)
  platform_entity_id text,              -- Meta campaign id (join key, future)
  cortana_entity_id text,               -- Cortana's internal uuid for the campaign
  platform text,                        -- 'facebook' / ...
  status text,
  effective_status text,
  campaign_objective text,              -- e.g. OUTCOME_LEADS
  currency text,

  -- spend / delivery
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

  -- traffic (ad-attributed landing-page visits)
  page_views integer,
  unique_visitors integer,

  -- attributed funnel rollups (totals; per-event detail in `conversions`)
  leads integer,
  meta_platform_leads integer,
  total_conversions integer,
  total_revenue numeric,
  total_ltv numeric,
  average_order_value numeric,
  cost_per_conversion numeric,
  roas numeric,
  roi numeric,

  -- creative performance (Meta in-feed ad video — NOT the LP VSL/Wistia)
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

  -- campaign-only budget fields
  daily_budget numeric,
  lifetime_budget numeric,
  budget_source text,

  -- per-entity attributed conversions, keyed by event type
  conversions jsonb not null default '{}'::jsonb,
  -- full original API row — the "ingest everything" guarantee
  raw jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (day, entity_key)
);

comment on table cortana_campaign_daily is
  'Per-campaign daily mirror of the Cortana Attribution API (groupBy=campaign). One row per (ET day, campaign). Idempotent upsert; Meta ~72h restatements overwrite. See docs/schema/cortana_campaign_daily.md.';
comment on column cortana_campaign_daily.entity_key is
  'Cortana dimensionKey "<name>|||<platformEntityId>". PK component with day.';
comment on column cortana_campaign_daily.frequency is
  'DERIVED impressions/reach (Cortana returns null at row grain).';
comment on column cortana_campaign_daily.conversions is
  'Per-event-type attributed conversions: {event_type: {count,uniqueCount,revenue,costPer}}. event_types incl lead, qualified_lead, appointment_booked, direct_closer_bookings, purchase, all_payments, ...';
comment on column cortana_campaign_daily.raw is
  'Full original Cortana row (jsonb) — preserves every field, incl ones not modeled as typed columns.';

create index cortana_campaign_daily_day_idx on cortana_campaign_daily (day desc);
create index cortana_campaign_daily_platform_entity_idx
  on cortana_campaign_daily (platform_entity_id);

create trigger cortana_campaign_daily_set_updated_at
  before update on cortana_campaign_daily
  for each row execute function set_updated_at();

-- ===========================================================================
-- cortana_ad_daily  (same shape minus campaign budget fields)
-- ===========================================================================

create table cortana_ad_daily (
  day date not null,
  entity_key text not null,             -- Cortana dimensionKey (name|||metaId)
  entity_name text,                     -- Cortana dimension (ad name / asset id)
  platform_entity_id text,              -- Meta ad id (join key, future)
  cortana_entity_id text,
  platform text,
  status text,
  effective_status text,
  campaign_objective text,
  currency text,

  spent numeric,
  impressions integer,
  reach integer,
  frequency numeric,
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

comment on table cortana_ad_daily is
  'Per-ad daily mirror of the Cortana Attribution API (groupBy=ad). One row per (ET day, ad). Powers per-ad lead/close attribution + creative performance. See docs/schema/cortana_ad_daily.md.';
comment on column cortana_ad_daily.entity_key is
  'Cortana dimensionKey "<name>|||<platformEntityId>". PK component with day.';
comment on column cortana_ad_daily.conversions is
  'Per-event-type attributed conversions for this ad: {event_type: {count,uniqueCount,revenue,costPer}}. Leads-by-ad lives here (conversions->lead->>count).';
comment on column cortana_ad_daily.raw is
  'Full original Cortana row (jsonb) — preserves every field.';
comment on column cortana_ad_daily.video_plays is
  'Meta IN-FEED ad-creative video plays — NOT the landing-page VSL (Wistia). NULL for image ads.';

create index cortana_ad_daily_day_idx on cortana_ad_daily (day desc);
create index cortana_ad_daily_platform_entity_idx
  on cortana_ad_daily (platform_entity_id);

create trigger cortana_ad_daily_set_updated_at
  before update on cortana_ad_daily
  for each row execute function set_updated_at();
