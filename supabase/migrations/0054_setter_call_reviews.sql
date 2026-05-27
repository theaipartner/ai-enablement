-- 0054_setter_call_reviews.sql
-- Second half of the setter-call AI review pipeline. Pairs 1:1 with
-- setter_call_transcripts; one Sonnet review per transcript.
--
-- Spec discussion 2026-05-27: ship v1 against the existing 55
-- transcripts, no golden-set tuning gate — Drake reviews real output
-- post-deploy and iterates the prompt directly.
--
-- HARD ISOLATION (same rules as setter_call_transcripts):
--   - Sales-only. Not in the `documents` table. No vector embeddings.
--     match_document_chunks() never sees this row.
--   - No client_id FK. The link to a Close lead lives in close_calls.
--   - Cost columns inline (sonnet_*_tokens, sonnet_cost_usd) rather
--     than the shared agent_runs table — keeps sales LLM spend
--     reporting self-contained inside /sales-dashboard.
--
-- Idempotency: PK is close_call_id. Re-running the reviewer on a
-- transcript is a safe UPSERT — re-runs replace the row when we tune
-- the prompt or swap models. Prompt version is captured per row so
-- past reviews stay attributable to the prompt that generated them.
--
-- The cascade FK to setter_call_transcripts means dropping a transcript
-- drops its review too. That's intentional — reviews are derived data;
-- if the source transcript is gone, the review has no truth basis.


create table setter_call_reviews (
  close_call_id text primary key
    references setter_call_transcripts (close_call_id) on delete cascade,

  -- Sentiment — 1-2 sentence arc, free-text (no enum, the value is
  -- prose). The structured DQ/score signals live in their own columns.
  sentiment text not null,

  -- Lead grading
  lead_score smallint not null check (lead_score between 0 and 10),
  lead_score_reason text not null,

  -- DQ flag — Drake's "VERY obviously upset only" bar.
  -- Advisory only; humans flip the lead in Close themselves.
  should_be_dqd boolean not null,
  dq_reason text,
  check (should_be_dqd = false or dq_reason is not null),

  -- Outcome
  booked boolean not null,
  no_book_reason text,
  check (booked = true or no_book_reason is not null),

  -- Strengths / weaknesses — 0-2 each, NOT mandatory. Stored as
  -- jsonb arrays of {point, evidence} objects per the v1 prompt
  -- shape. An empty list is the common case; padding to hit a count
  -- is forbidden by the prompt.
  setter_strengths jsonb not null default '[]'::jsonb,
  setter_weaknesses jsonb not null default '[]'::jsonb,

  -- Lead intel — fixed-vocabulary "key:value" strings. The prompt
  -- pins the vocabulary; new keys land here only via prompt updates
  -- or model invention (latter discouraged).
  lead_attributes text[] not null default '{}',

  -- Talk-time math — computed in-app from setter_call_transcripts.words
  -- (NOT from the LLM, which would guess). Setter identification uses
  -- the heuristic "whoever opens the call is the setter" with content-
  -- based fallback; full algorithm in agents/setter_call_reviewer/
  -- talk_time.py. All three are nullable for the case where the
  -- transcript had no diarization labels.
  setter_words integer,
  prospect_words integer,
  talk_ratio_setter numeric(5, 4),

  -- Sonnet provenance + cost
  model text not null,
  prompt_version text not null,
  sonnet_input_tokens integer,
  sonnet_output_tokens integer,
  sonnet_cost_usd numeric(10, 6),

  -- Slack notification trail (so we never double-post). Filled when
  -- the future Slack-post step lands; nullable for now.
  slack_channel text,
  slack_message_ts text,
  slack_posted_at timestamptz,

  reviewed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table setter_call_reviews is
  'Sonnet structured analysis of setter calls. Display-only on /sales-dashboard/calls; advisory DQ flag is for humans to evaluate, never auto-applied to Close. Sales-side only — NOT retrievable by Ella / CS surfaces.';

comment on column setter_call_reviews.should_be_dqd is
  'Aggressive bar: only VERY obviously upset (not tough objection handling). Advisory only — true here does NOT change the lead in Close; humans review and flip status manually.';

comment on column setter_call_reviews.setter_strengths is
  '0-2 items max per prompt v1. Empty array is the expected steady state — the prompt forbids padding to hit a count.';

comment on column setter_call_reviews.setter_weaknesses is
  '0-2 items max per prompt v1. Empty array allowed.';

comment on column setter_call_reviews.lead_attributes is
  '"key:value" strings from a fixed vocabulary (business_type, stage, revenue_band, team_size, primary_channel, main_blocker). New keys arrive only via prompt updates.';

create index setter_call_reviews_reviewed_at_idx
  on setter_call_reviews (reviewed_at desc);

create index setter_call_reviews_dq_idx
  on setter_call_reviews (should_be_dqd) where should_be_dqd = true;

create index setter_call_reviews_lead_score_idx
  on setter_call_reviews (lead_score);

create trigger setter_call_reviews_set_updated_at
  before update on setter_call_reviews
  for each row execute function set_updated_at();
