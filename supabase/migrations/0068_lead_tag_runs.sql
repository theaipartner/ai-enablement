-- 0068_lead_tag_runs.sql
--
-- Observability log for the lead tagger (shared/lead_tagging.py). One row per
-- retag run — whether triggered by the cron (periodic), a webhook (per-lead),
-- or a manual/backfill invocation. Powers the exception-only admin page: we
-- surface ONLY runs that errored or that produced an anomaly (a set-once
-- identity tag that changed/regressed, or the periodic recompute disagreeing
-- with stored state = drift). Routine successful runs are logged too but are
-- not shown on the page — they're there for audit / volume trend.
--
-- Deliberately lightweight: this is a log, not a source of truth. The tags
-- themselves live on lead_cycles / lead_cycle_stages.

create table if not exists lead_tag_runs (
  id          bigint generated always as identity primary key,
  ran_at      timestamptz not null default now(),
  trigger     text not null,        -- 'cron' | 'webhook:close' | 'webhook:calendly' | 'webhook:typeform' | 'webhook:airtable' | 'backfill' | 'manual'
  lead_ids    text[],               -- leads retagged (null for a full/all-leads run)
  lead_count  integer,
  ok          boolean not null,     -- false = the run raised
  error       text,                 -- message + short trace when ok = false
  anomalies   jsonb,                -- [{close_id, kind, detail}] — set-once regressions / drift; null when clean
  duration_ms integer,
  created_at  timestamptz not null default now()
);

comment on table lead_tag_runs is
  'Observability log for the lead tagger (shared/lead_tagging.py). One row per retag run (cron / webhook / backfill / manual). The exception-only admin page surfaces rows where ok=false OR anomalies is not null. Not a source of truth — tags live on lead_cycles/lead_cycle_stages.';
comment on column lead_tag_runs.trigger is
  'What invoked the run: cron, webhook:<source>, backfill, or manual.';
comment on column lead_tag_runs.anomalies is
  'jsonb array of {close_id, kind, detail} — a previously-set identity tag (direct/reactive/dq) that changed or cleared on recompute, or cron-vs-stored drift. null = clean run.';

-- Recency for the page; partial index for the exception feed (errors + anomalies).
create index if not exists idx_lead_tag_runs_ran on lead_tag_runs (ran_at desc);
create index if not exists idx_lead_tag_runs_attention on lead_tag_runs (ran_at desc)
  where (not ok or anomalies is not null);
