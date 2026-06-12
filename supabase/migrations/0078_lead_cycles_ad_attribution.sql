-- 0078_lead_cycles_ad_attribution.sql
-- Denormalize source-ad attribution onto lead_cycles so the funnel can be
-- filtered (and later SQL-aggregated) by ad without joining close_leads.
-- Stamped by the tagger (shared/lead_tagging.py) from close_leads at retag time.

alter table lead_cycles
  add column if not exists ad_id       text,
  add column if not exists ad_name     text,
  add column if not exists campaign_id text;

-- Supports the per-ad filter's WHERE and the eventual GROUP BY ad_id.
create index if not exists lead_cycles_ad_id_idx
  on lead_cycles (ad_id) where ad_id is not null;
