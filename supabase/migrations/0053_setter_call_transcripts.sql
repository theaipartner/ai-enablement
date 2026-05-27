-- 0053_setter_call_review_tables.sql
-- Setter-call transcription pipeline — first half of the AI-review build.
-- Persists Deepgram nova-3 transcripts for eligible close_calls rows
-- (recording present, duration >= 90s).
--
-- The downstream `setter_call_reviews` table (Sonnet structured analysis)
-- is intentionally NOT created in this migration. Sequencing decision
-- (2026-05-27): land transcripts first, surface them in the sales-
-- dashboard Calls page, let Drake read 10-20 and pick a golden set; the
-- review prompt + table get built against that golden set.
--
-- "Setter" prefix is deliberate. Closers may set for themselves, and
-- their closing calls happen over video (not in Close), so the working
-- rule for V1 is: ANY recorded Close call >= 90s = setter call. The name
-- documents intent, not a JOIN constraint.
--
-- HARD ISOLATION FROM CS SIDE — this table is sales-only by design.
--   - Not referenced in the `documents` table.
--   - No vector embeddings, no inclusion in match_document_chunks().
--   - No client_id FK; sales pipeline is decoupled from clients/CSM
--     surfaces. The link to a Close lead lives in close_calls.lead_id
--     and we follow it ONLY in the sales-dashboard UI, never from any
--     CS-side retrieval path. Ella (CS chatbot) must never see this
--     data.
--   - Deepgram cost columns inline below rather than written to the
--     shared agent_runs table, so sales cost reporting stays self-
--     contained inside the sales-dashboard.
--
-- Idempotency: PK is close_call_id (matches close_calls.close_id, an
-- acti_* string). Re-running the pipeline on a call is a safe UPSERT.
-- Transcripts re-run if the model changes (e.g. nova-3 → nova-4 later).
--
-- Audio is NEVER persisted on our side. Deepgram URL-ingest fetches
-- the call recording directly from Close's pre-signed S3 URL during
-- transcription, so we keep the transcript text only. Close deletes
-- recordings 30 days after the call (close_calls.raw_payload->>
-- 'recording_expires_at'); we have a hard deadline to transcribe
-- inside that window or the audio is gone for good.


-- ============================================================================
-- setter_call_transcripts — Deepgram output, keyed 1:1 to a Close call
-- ============================================================================

create table setter_call_transcripts (
  close_call_id text primary key references close_calls (close_id) on delete cascade,

  -- Deepgram provenance / replay info
  deepgram_request_id text not null,
  model text not null,                    -- e.g. 'nova-3'
  duration_s numeric(10, 3) not null,     -- audio duration Deepgram saw

  -- Quality + content
  confidence numeric(5, 4),               -- 0-1, top-line confidence
  transcript_text text not null,          -- smart-formatted single string
  words jsonb not null,                   -- [{word, start, end, speaker, ...}]
  speaker_count smallint,                 -- distinct speakers detected (typ. 2)

  -- Cost telemetry — self-contained, not in agent_runs
  deepgram_cost_usd numeric(10, 6),

  -- Full payload for debugging / re-extraction without re-billing Deepgram
  raw_response jsonb,

  transcribed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table setter_call_transcripts is
  'Deepgram nova-3 transcripts for Close call recordings >= 90s. Sales-side only. NOT retrievable by Ella / CS surfaces. One row per close_calls.close_id.';

comment on column setter_call_transcripts.words is
  'Word-level Deepgram output: [{word, punctuated_word, start, end, confidence, speaker}]. Used downstream to compute setter/prospect word counts and talk ratio when the review layer is built.';

create index setter_call_transcripts_transcribed_at_idx
  on setter_call_transcripts (transcribed_at desc);

create trigger setter_call_transcripts_set_updated_at
  before update on setter_call_transcripts
  for each row execute function set_updated_at();
