-- 0106_lead_cycles_source_form_id.sql
-- Per-landing-page funnel scoping. Each opt-in cycle is reconstructed from a
-- specific Typeform (SFedWelr = Main LP, Os4c0q6V = Training LP, …). Until now
-- lead_cycles only stored source='typeform' (which form was lost), so the
-- Funnel page's landing-page dropdown could re-scope the LP/VSL/Typeform summary
-- but NOT the funnel boxes — they stayed combined across LPs.
--
-- Add source_form_id so the tagger can stamp each cycle with the form it came
-- through; getSpeedToLeadCohort then filters by it when an LP is selected.
-- Nullable + backfilled by a full retag (the tagger now populates it).

alter table lead_cycles add column if not exists source_form_id text;

-- Cohort reads filter by (source_form_id, opt_in_at) when an LP is selected.
create index if not exists ix_lead_cycles_source_form
  on lead_cycles (source_form_id, opt_in_at);

comment on column lead_cycles.source_form_id is
  'Typeform form_id this opt-in cycle was reconstructed from (e.g. SFedWelr=Main LP, Os4c0q6V=Training LP). Drives per-landing-page funnel scoping. Null for legacy rows until the next full retag.';
