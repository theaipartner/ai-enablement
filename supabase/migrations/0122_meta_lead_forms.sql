-- 0122_meta_lead_forms.sql
-- Mirrors for Meta lead-gen (instant form) data — the Digital College ads
-- funnel. Three tables, all fed by ingestion/meta_ads/leads_pipeline.py via
-- api/meta_leads_sync_cron.py:
--
--   meta_lead_forms        — form registry (one row per leadgen form on the page)
--   meta_form_leads        — one row per form submission (the opt-in event),
--                            with the Meta ad/adset/campaign attribution ids
--                            that join the cortana_* spend mirrors and
--                            close_leads.{ad_id,adset_id,campaign_id}
--   meta_leadgen_campaigns — which campaigns are lead-form campaigns, detected
--                            from the adset discriminator (optimization_goal=
--                            LEAD_GENERATION + destination_type=ON_AD). This is
--                            the ad-spend scoping set for the DC ads funnel
--                            page: spend rows in cortana_campaign_daily whose
--                            platform_entity_id is in this table are "DC ads"
--                            spend.
--
-- ⚠ Meta retains leads ~90 days via the API — this mirror is the durable copy.
-- See docs/runbooks/meta_leads_ingestion.md.

create table meta_lead_forms (
  form_id text primary key,
  page_id text not null,
  name text,
  status text,
  form_created_time timestamptz,
  questions jsonb not null default '[]'::jsonb,
  raw jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table meta_lead_forms is
  'Registry of Meta lead-gen (instant) forms on our Facebook page(s). One row per form. Fed by api/meta_leads_sync_cron.py from GET /{page_id}/leadgen_forms. See docs/schema/meta_lead_forms.md.';
comment on column meta_lead_forms.form_id is
  'Meta leadgen form id (e.g. 1053168367400164). Joins meta_form_leads.form_id.';
comment on column meta_lead_forms.questions is
  'The form''s question list as Meta returns it ([{key,label,type,id},…]) — documents what fields leads carry (the 7/8 Basic Form is full_name + phone_number only, NO email).';

create trigger meta_lead_forms_set_updated_at
  before update on meta_lead_forms
  for each row execute function set_updated_at();

alter table meta_lead_forms enable row level security;


create table meta_form_leads (
  lead_id text primary key,
  form_id text not null,
  page_id text,
  created_time timestamptz not null,

  -- Attribution (absent when is_organic — a form fill not reached via an ad).
  ad_id text,
  ad_name text,
  adset_id text,
  adset_name text,
  campaign_id text,
  campaign_name text,
  is_organic boolean not null default false,
  platform text,

  -- Flattened answers (the current form is name+phone; email stays null until
  -- some future form collects it). field_data preserves the raw answer list.
  full_name text,
  phone_number text,
  email text,
  field_data jsonb not null default '[]'::jsonb,
  raw jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table meta_form_leads is
  'One row per Meta lead-form submission (the DC-funnel opt-in event). Durable mirror — Meta only retains leads ~90 days. Attribution ids join cortana_*_daily.platform_entity_id and close_leads.{ad_id,adset_id,campaign_id}; the Meta→Close bridge creates the matching close_leads row (funnel_name=Digital College) within seconds. See docs/schema/meta_form_leads.md.';
comment on column meta_form_leads.lead_id is
  'Meta leadgen id — stable across refetches; upsert key.';
comment on column meta_form_leads.created_time is
  'When the person submitted the form (UTC) — the opt-in timestamp.';
comment on column meta_form_leads.is_organic is
  'True when the form was filled without an ad click (no ad/adset/campaign ids).';
comment on column meta_form_leads.phone_number is
  'As Meta returns it (E.164, e.g. +17086688748). The identity key for these leads — the current form collects NO email.';

create index meta_form_leads_created_time_idx on meta_form_leads (created_time desc);
create index meta_form_leads_form_idx on meta_form_leads (form_id);
create index meta_form_leads_campaign_idx on meta_form_leads (campaign_id);
create index meta_form_leads_phone_idx on meta_form_leads (phone_number);

create trigger meta_form_leads_set_updated_at
  before update on meta_form_leads
  for each row execute function set_updated_at();

alter table meta_form_leads enable row level security;


create table meta_leadgen_campaigns (
  campaign_id text primary key,
  campaign_name text,
  account_id text,
  page_id text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table meta_leadgen_campaigns is
  'Campaigns detected as lead-form campaigns: any campaign with an adset whose optimization_goal=LEAD_GENERATION and destination_type=ON_AD (the instant-form discriminator — old website/Wix campaigns are OFFSITE_CONVERSIONS). THE ad-spend scoping set for the DC ads funnel page: cortana_campaign_daily rows whose platform_entity_id is here are DC-ads spend. Re-scanned every meta_leads_sync tick. See docs/schema/meta_leadgen_campaigns.md.';
comment on column meta_leadgen_campaigns.campaign_id is
  'Meta campaign id. Joins cortana_campaign_daily.platform_entity_id, close_leads.campaign_id, meta_form_leads.campaign_id.';
comment on column meta_leadgen_campaigns.last_seen_at is
  'Last sync tick whose adset scan still saw this campaign (campaigns are never deleted here — spend history must stay scoped).';

create trigger meta_leadgen_campaigns_set_updated_at
  before update on meta_leadgen_campaigns
  for each row execute function set_updated_at();

alter table meta_leadgen_campaigns enable row level security;
