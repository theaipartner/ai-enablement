-- 0110_landing_pages.sql
-- Move the landing-page registry from code into the DB so landing pages can be
-- added/edited in Gregory (the admin "Add Landing Page" page) instead of a code
-- deploy. Today the registry lives in FOUR code spots that must stay in sync:
--   - lib/db/landing-pages.ts          (the registry the dropdown + LP detail read)
--   - lib/db/funnel-assets.ts          (HIGH_TICKET_TYPEFORM_FORM_IDS — TS read lock)
--   - shared/lead_tagging.py           (OPT_IN_FORMS + INVEST_FIELD_REF — the tagger)
--   - api/typeform_insights_cron.py    (FORM_IDS — "starts" capture)
-- These collapse into the two tables below, which BOTH TS and Python read.
--
-- Two tables:
--   landing_pages       — one row per LP: display + Wistia assets + dropdown config.
--   landing_page_forms  — the form SET per LP (an LP can own >1 form). form_id is
--                         UNIQUE, so a form belongs to at most one LP (the
--                         partition that keeps per-LP opt-in counts clean). Each
--                         row also carries that form's per-form qualification
--                         config (which Typeform field + which answers qualify),
--                         replacing the single global INVEST_FIELD_REF / >=$2,000
--                         rule. The union of form_ids here is the eligible opt-in
--                         set (was OPT_IN_FORMS / HIGH_TICKET_TYPEFORM_FORM_IDS).
--
-- This migration ONLY creates + seeds the tables to mirror today's code registry
-- EXACTLY. No read path changes here — those land in a later step, each verified
-- against current funnel numbers before cut-over.
--
-- RLS enabled, no policies (deny-default), matching V1 posture: the dashboard
-- reads via the service-role admin client and the tagger via the postgres role
-- (psycopg2) — both bypass RLS.

-- ---------------------------------------------------------------------------
-- landing_pages — one row per landing page (display + assets + dropdown).
-- ---------------------------------------------------------------------------
create table if not exists landing_pages (
  slug                    text primary key,         -- ?lp=<slug>, stable key (kebab)
  label                   text not null,            -- dropdown + detail eyebrow
  lp_path                 text,                     -- canonical path, reference/labeling
  lp_url                  text,                     -- full link pasted into the adder (nullable)
  typeform_label          text,                     -- Typeform section subtitle
  vsl                     jsonb not null default '[]'::jsonb,  -- [{hashedId,label}, ...]
  confirm_video_hashed_id text,                     -- thank-you / confirmation video
  confirm_video_label     text,
  active                  boolean not null default true,
  sort_order              int not null default 0,   -- dropdown ordering
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

comment on table landing_pages is
  'Landing-page registry (was lib/db/landing-pages.ts). One row per LP: dropdown label, canonical path, Wistia VSL(s) + confirm video, ordering. The form set + qualification live in landing_page_forms. Read by the LP dropdown, LP detail page, and the funnel scoping.';

alter table landing_pages enable row level security;

-- ---------------------------------------------------------------------------
-- landing_page_forms — the form SET per LP + per-form qualification config.
-- ---------------------------------------------------------------------------
create table if not exists landing_page_forms (
  id                bigserial primary key,
  landing_page_slug text not null references landing_pages (slug) on delete cascade,
  form_id           text not null unique,           -- Typeform form_id; UNIQUE => one LP per form
  typeform_title    text,                            -- form title (display/reference)
  qualify_field_ref text,                            -- Typeform field ref the qualification reads
  qualify_answers   text[] not null default '{}',    -- answer LABELS that qualify the lead
  is_primary        boolean not null default true,   -- the LP's current collecting form
  created_at        timestamptz not null default now()
);

create index if not exists ix_landing_page_forms_slug on landing_page_forms (landing_page_slug);

comment on table landing_page_forms is
  'The Typeform form SET each landing page owns (usually one; >1 after a form change, since editing an LP ADDS a form — old form''s cycles stay counted). form_id UNIQUE => a form belongs to at most one LP. Carries per-form qualification (qualify_field_ref + qualify_answers) replacing the global INVEST_FIELD_REF/>=$2,000 rule. The union of form_ids is the eligible opt-in set (was OPT_IN_FORMS / HIGH_TICKET_TYPEFORM_FORM_IDS / FORM_IDS).';

alter table landing_page_forms enable row level security;

-- updated_at bump on landing_pages (mirrors the team_members trigger pattern).
create or replace function set_updated_at_landing_pages()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_landing_pages_updated_at on landing_pages;
create trigger trg_landing_pages_updated_at
  before update on landing_pages
  for each row execute function set_updated_at_landing_pages();

-- ---------------------------------------------------------------------------
-- Seed — EXACT mirror of today's code registry (lib/db/landing-pages.ts +
-- funnel-assets.ts + lead_tagging.py). Qualifying answers = the non-"under"
-- choices, reproducing qual_from_investment ("under" not in label => qualified).
-- ---------------------------------------------------------------------------
insert into landing_pages
  (slug, label, lp_path, lp_url, typeform_label, vsl, confirm_video_hashed_id, confirm_video_label, active, sort_order)
values
  ('main', 'Main LP · /lp-vsl', '/lp-vsl', null,
   'SFedWelr coaching application',
   '[{"hashedId":"i1173gx76b","label":"Vídeo Motion · Nabeel (Horizontal) · Direct Closer Funnel"}]'::jsonb,
   '4v9rok4kct', 'V2 precall shortened', true, 0),
  ('training', 'Training LP · /training', '/training', 'https://join.theaipartner.io/training',
   '6/20 Longer Form · Call Funnel',
   '[{"hashedId":"t05pq6ra0u","label":"6/20 · New VSL · Call Funnel"}]'::jsonb,
   '4v9rok4kct', 'V2 precall shortened', true, 1)
on conflict (slug) do nothing;

insert into landing_page_forms
  (landing_page_slug, form_id, typeform_title, qualify_field_ref, qualify_answers, is_primary)
values
  ('main', 'SFedWelr', 'US TF Funnel -> CF (go.theaipartner.io/lp) -> Closer Funnel',
   '5138f17b-eb31-4d36-bacb-88a8c83326ed',
   ARRAY['$8,000', '$5,000 and $8,000', '$2,000 and $5,000'], true),
  ('training', 'Os4c0q6V', '6/20 | Longer Form | Call Funnel',
   '5138f17b-eb31-4d36-bacb-88a8c83326ed',
   ARRAY['$8,000', '$5,000 and $8,000', '$2,000 and $5,000'], true)
on conflict (form_id) do nothing;
