-- 0030_pending_ella_responses.sql
-- Ella V2 Batch 2.3: queue table for pending passive-monitoring
-- responses. Inserted by ingestion/slack/realtime_ingest.py's passive
-- branch when the Haiku decision is respond_substantive or
-- respond_general_inquiry; drained every minute by
-- api/passive_ella_cron.py.
--
-- Only "respond_*" decisions land here. `skip` and `escalate` outcomes
-- are recorded on the agent_runs row only — escalate fires a backend
-- DM synchronously inside the ingest path (no queue, no delay), skip
-- is the no-op success path.

create table pending_ella_responses (
  id                                 uuid primary key default gen_random_uuid(),
  agent_run_id                       uuid not null references agent_runs(id),
  slack_channel_id                   text not null,
  triggering_message_ts              text not null,
  triggering_message_slack_user_id   text not null,
  haiku_decision                     text not null
    check (haiku_decision in (
      'respond_substantive',
      'respond_general_inquiry'
    )),
  haiku_reasoning                    text,
  respond_after_ts                   timestamptz not null,
  status                             text not null default 'queued'
    check (status in (
      'queued',
      'responded',
      'cancelled_csm_intervened',
      'cancelled_kill_switch',
      'cancelled_channel_disabled',
      'error'
    )),
  error_message                      text,
  created_at                         timestamptz not null default now(),
  responded_at                       timestamptz,
  unique (slack_channel_id, triggering_message_ts)
);

comment on table pending_ella_responses is
  'Queue of pending Ella passive-monitoring responses. Inserted by ingestion/slack/realtime_ingest.py''s passive branch when Haiku decides respond_substantive or respond_general_inquiry. Drained by api/passive_ella_cron.py every minute. Only respond_* decisions persist here — skip / escalate outcomes record on agent_runs only.';

comment on column pending_ella_responses.agent_run_id is
  'FK to the agent_runs row written at decision time (trigger_type=''passive_monitor'', status=''success''). Lets the cron resolve the haiku metadata + speaker context without re-parsing the Slack event.';

comment on column pending_ella_responses.respond_after_ts is
  'Earliest wall-clock time at which the cron may generate this response. Set at insert time to now() + 4 minutes (the midpoint of the spec''s 3-5 min CSM-intervention window).';

comment on column pending_ella_responses.status is
  'Terminal status enum. queued = waiting for the cron. responded = Ella posted. cancelled_csm_intervened = a team_member message landed in the channel between insert and drain. cancelled_kill_switch / cancelled_channel_disabled = a global or per-channel gate flipped during the wait. error = generation failed.';

-- Partial index for the cron's hot-path query
-- (SELECT ... WHERE status='queued' AND respond_after_ts <= now()
--  ORDER BY respond_after_ts ASC).
-- Queued rows are the only ones the cron ever picks; the partial
-- predicate keeps the index small even as terminal rows accumulate.
create index pending_ella_responses_due_idx
  on pending_ella_responses (respond_after_ts)
  where status = 'queued';

alter table pending_ella_responses enable row level security;
