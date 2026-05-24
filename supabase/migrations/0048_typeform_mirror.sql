-- 0048_typeform_mirror.sql
-- Typeform mirror tables — top-of-funnel opt-in / lead capture mirror.
--
-- Spec: docs/specs/typeform-ingestion.md.
-- Discovery: docs/reports/typeform-discovery.md (31 forms, ~10k responses
-- on the active Setter Funnel, response shape captured, history backfill
-- + cursor pagination viable, field.ref stable across funnel variants).
-- Schema docs: docs/schema/typeform_forms.md + typeform_responses.md.
-- Runbook: docs/runbooks/typeform_ingestion.md.
--
-- Design principle (CLAUDE.md § Core Principles #1+#2): our DB is the
-- source of truth; agents query Supabase, not Typeform. These tables
-- mirror Typeform raw objects so the future sales dashboard can read
-- the lead stream in SQL without live calls to Typeform.
--
-- What this is (Drake clarified): top-of-funnel **opt-ins / program
-- inquiries** — people who fill the funnel forms and become leads.
-- This is NOT client data. There is NO `clients` join key, NO identity
-- resolution into the alternate_emails / alternate_names pattern, NO
-- auto-creation of client rows from a Typeform response. The mirror is
-- self-contained; downstream lead → client mapping (if it ever happens)
-- is a separate future arc.
--
-- Migration number 0048 is PINNED — main owns through 0047 (Calendly).
-- Don't auto-detect the next migration number from this worktree's
-- filesystem because another session is migrating against the same
-- ledger simultaneously.
--
-- PII posture (per spec § PII): mirror raw. emails + phones + names
-- live in `typeform_responses.answers` jsonb; respondent IPs live in
-- `typeform_responses.hidden.ip`. The data already exists in Typeform's
-- DB so the mirror creates no new exposure surface, and Supabase is
-- service-role-only. Test fixtures + reports MUST mask; the mirror DB
-- itself stores raw.

-- ============================================================================
-- typeform_forms — form-definition mirror (one row per form)
-- ============================================================================
--
-- ~31 rows in this account today. Refreshed on every cron tick (cheap
-- — small payloads) so the question-ref → title dictionary stays in
-- sync with Typeform-side form edits. Read by the future sales
-- dashboard to label question refs without re-fetching from Typeform.

create table typeform_forms (
  -- Identity
  form_id text primary key,
  title text,

  -- Typeform-side last-edited timestamp (distinct from our updated_at).
  -- Used to detect "this form was edited" — but the answers in
  -- typeform_responses carry their own field-shape snapshot via
  -- `answers[].field`, so historical responses remain self-describing
  -- even if the form was edited after submission.
  last_updated_at timestamptz,

  -- Question dictionary. Flattened fields[] (group fields are unwrapped
  -- so each inner field is a top-level entry with an `_in_group` ref).
  -- Each entry: { id, ref, title, type, properties: {...}, _in_group? }.
  fields jsonb,

  -- Names of hidden fields the form supports (utm_*, ad_id, fbp, etc.).
  -- These are the marketing attribution keys — flat string array.
  hidden_fields jsonb,

  -- When we last pulled GET /forms/{id} into this row.
  definition_synced_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table typeform_forms is
  'Mirror of Typeform GET /forms/{form_id} definitions. Reference table; ~31 rows in this account. Refreshed each cron tick. Read by future sales dashboard to label answer field refs. NO clients join (these are lead-form definitions, not client data).';

comment on column typeform_forms.fields is
  'Flattened fields[] from the Typeform form definition. Group fields are unwrapped so each inner field is a top-level entry with `_in_group` carrying the group ref. Each entry shape: { id, ref, title, type, properties }.';

comment on column typeform_forms.hidden_fields is
  'Flat array of hidden-field names the form supports (utm_source, utm_medium, ad_id, fbp, fbc, ip, event_id, campaign_id, adset_id, etc.). Per-response hidden values land in typeform_responses.hidden as a string→string map keyed on these names.';

-- Recently-edited forms surface first in operational lookups.
create index typeform_forms_last_updated_idx
  on typeform_forms (last_updated_at desc) where last_updated_at is not null;

create trigger typeform_forms_set_updated_at
  before update on typeform_forms
  for each row execute function set_updated_at();

-- ============================================================================
-- typeform_responses — submission mirror (one row per response)
-- ============================================================================
--
-- Idempotent on response_id (= the Typeform response `token`). Same
-- string in both fields; we pick response_id as the semantic name.
-- Webhook + backfill + cron-backstop all upsert here; double-write is
-- a no-op.
--
-- form_id is a LOOSE foreign key — backfill order isn't guaranteed to
-- land the form-definition row before its responses (the receiver may
-- see a response for a form whose definition hasn't been pulled yet).
-- Aggregation reads left-join; the FK is a soft pointer, not enforced.
-- Same pattern as close_calls.lead_id and wistia_media_daily.hashed_id.

create table typeform_responses (
  -- Identity. Typeform's `response_id` and `token` carry the same
  -- string — we mirror as one column with the semantic name. Stable
  -- across the response's lifetime.
  response_id text primary key,

  -- Soft FK to typeform_forms — see preamble.
  form_id text not null,

  -- Typeform-side timestamps. landed_at is when the respondent
  -- arrived at the form; submitted_at is when they hit submit. Both
  -- come from the Responses API + the webhook envelope verbatim.
  landed_at timestamptz,
  submitted_at timestamptz,

  -- Browser / UA / referer fingerprint. Useful for downstream de-bot
  -- or channel inference. Keys verified in discovery: browser,
  -- network_id, platform, referer, user_agent.
  metadata jsonb,

  -- Marketing-attribution payload (utm_*, ad_id, ad_name, adset_id,
  -- campaign_id, fbp, fbc, ip, event_id, funnel). NOT respondent PII
  -- per the spec's PII decision (mirror raw — these are tracking
  -- params, not user-typed content). Keys are a subset of the parent
  -- form's typeform_forms.hidden_fields.
  hidden jsonb,

  -- Typeform's calculated payload — `{ score: 0 }` on the funnel
  -- forms today (scoring not enabled). Mirrored for forward-compat
  -- with forms that DO use Typeform's calculated logic.
  calculated jsonb,

  -- The raw answers[] array. Each element is type-tagged:
  --   { field: { ref, id, type }, type: "<answer-type>",
  --     "<answer-type>": <value> }
  -- Answer-type ∈ { choice, choices, email, text, long_text,
  -- phone_number, number, boolean, date, url, ... }. Stable across
  -- form variants because field.ref is author-assigned (verified in
  -- discovery — same ref for the same question across PWSNd0h2 /
  -- poifwp1H / SFedWelr).
  --
  -- CONTAINS RAW PII (emails, phones, free-text names). Test
  -- fixtures + the discovery report mask; the mirror stores raw per
  -- Drake's gate decision (data already in Typeform's DB; Supabase
  -- is service-role-only). See spec § PII.
  answers jsonb,

  ingested_at timestamptz not null default now(),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table typeform_responses is
  'Mirror of Typeform GET /forms/{form_id}/responses items + form_response webhook payloads. One row per submission, idempotent on response_id. Top-of-funnel opt-in stream — NOT client data; no clients join, no identity resolution. PII (email/phone/name) lives raw in `answers` jsonb; respondent IPs live in `hidden.ip`. Backfill via scripts/backfill_typeform.py; live updates via api/typeform_events.py; reconciliation backstop via api/typeform_sync_cron.py.';

comment on column typeform_responses.answers is
  'Raw answers[] array as returned by Typeform. Type-tagged; field.ref is the stable key (author-assigned, unique within form, stable across funnel-variant edits). Contains raw PII (emails, phones, free-text names) per Drake gate decision (mirror raw; data already in Typeform).';

comment on column typeform_responses.hidden is
  'Marketing attribution payload — string→string map of (utm_*, ad_*, fbp, fbc, ip, event_id, campaign_id, adset_id, funnel). Tracking params + respondent IP. Keys are a subset of parent form''s typeform_forms.hidden_fields.';

-- Per-form recency queries — "responses on this form, newest first":
create index typeform_responses_form_submitted_idx
  on typeform_responses (form_id, submitted_at desc);

-- Cross-form recency queries — "all opt-ins in the last N days":
create index typeform_responses_submitted_idx
  on typeform_responses (submitted_at desc);

create trigger typeform_responses_set_updated_at
  before update on typeform_responses
  for each row execute function set_updated_at();
