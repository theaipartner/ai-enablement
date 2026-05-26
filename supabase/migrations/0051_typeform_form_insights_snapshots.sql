-- Migration 0051: typeform_form_insights_snapshots
--
-- Append-only snapshots of Typeform's /insights/{form_id}/summary
-- endpoint. The endpoint returns LIFETIME totals only — no date
-- filtering supported (verified during discovery — every `since`,
-- `until`, `from`, `to`, `start_date`, `end_date`, `period`,
-- `granularity` variation returned identical lifetime values).
--
-- To derive per-day starts/visits, we snapshot the lifetime total
-- every 15 minutes via a Vercel cron. Day N's starts is derived as
-- (latest snapshot at start of day N+1).total_visits
--   minus (latest snapshot at start of day N).total_visits.
--
-- Pre-snapshot history is unrecoverable (the API can't tell us what
-- the lifetime total was at any past moment). Days before the first
-- snapshot show "—" on the dashboard.
--
-- Idempotency: PK on (form_id, snapshot_at). Re-running a cron tick
-- with the same minute would no-op; in practice each tick fires at a
-- distinct timestamp.

create table if not exists typeform_form_insights_snapshots (
  form_id text not null,
  snapshot_at timestamptz not null default now(),
  total_visits integer,
  unique_visits integer,
  responses_count integer,
  completion_rate numeric(5,2),
  average_time_seconds integer,
  raw jsonb,
  created_at timestamptz not null default now(),
  primary key (form_id, snapshot_at)
);

-- Hot-path lookups: "most recent snapshot for this form" and "first
-- snapshot at-or-after a given instant for this form" both walk this
-- index. DESC matches the typical "give me the latest snapshot"
-- query shape.
create index if not exists typeform_form_insights_snapshots_form_time_idx
  on typeform_form_insights_snapshots (form_id, snapshot_at desc);

comment on table typeform_form_insights_snapshots is
  'Append-only snapshots of Typeform /insights/{form_id}/summary. Lifetime totals captured every 15min via cron; per-day starts derived by snapshot deltas. See docs/runbooks/typeform_insights.md.';
comment on column typeform_form_insights_snapshots.total_visits is
  'Lifetime form page views at snapshot_at. Day-start delta = today''s starts.';
comment on column typeform_form_insights_snapshots.responses_count is
  'Lifetime submissions at snapshot_at. Day-start delta = today''s completions.';
comment on column typeform_form_insights_snapshots.completion_rate is
  'Typeform-reported lifetime completion rate at snapshot_at (0-100). For day-specific rate, divide derived day starts/completions.';
comment on column typeform_form_insights_snapshots.raw is
  'Full /insights/summary response for forensic re-parse.';
