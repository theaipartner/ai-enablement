# pending_ella_responses

Queue of pending Ella passive-monitoring responses.

## Purpose

Created in migration 0030 for Ella V2 Batch 2.3 passive monitoring. When the Haiku-side decision module (`agents.ella.passive_monitor.evaluate_passive_trigger`) returns `respond_substantive` or `respond_general_inquiry`, a row lands here with `respond_after_ts = now() + 4 minutes`. The per-minute Vercel cron at `/api/passive_ella_cron` drains the queue, runs the CSM-intervention check, and dispatches the response (or cancels the row when a gate flips).

Only `respond_*` decisions persist here. `skip` and `escalate` decisions never land in this table — `skip` is recorded on the `agent_runs` row only, `escalate` fires a synchronous backend DM to the primary CSM at decision time.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | PK, default `gen_random_uuid()` |
| `agent_run_id` | `uuid` | FK → `agent_runs.id`, not null. Points at the `trigger_type='passive_monitor'` row written at decision time |
| `slack_channel_id` | `text` | Not null. Matches `slack_channels.slack_channel_id` (not a FK; mirrors the `slack_messages` convention) |
| `triggering_message_ts` | `text` | Not null. The Slack ts of the message that triggered the passive decision |
| `triggering_message_slack_user_id` | `text` | Not null. The author of the triggering message (for speaker resolution at generation time) |
| `haiku_decision` | `text` | Not null. CHECK enforces enum: `respond_substantive`, `respond_general_inquiry` |
| `haiku_reasoning` | `text` | Truncated 1-2 sentence string from Haiku's structured output |
| `respond_after_ts` | `timestamptz` | Not null. Earliest wall-clock time the cron may generate this response. Insert-time default `now() + 4 minutes` |
| `status` | `text` | Not null, default `'queued'`. CHECK enforces enum: `queued`, `responded`, `cancelled_csm_intervened`, `cancelled_kill_switch`, `cancelled_channel_disabled`, `error` |
| `error_message` | `text` | Populated when `status='error'`. Truncated 2000 chars |
| `created_at` | `timestamptz` | Default `now()` |
| `responded_at` | `timestamptz` | Set by the cron when it marks the row `'responded'` |

## Constraints

- `UNIQUE (slack_channel_id, triggering_message_ts)` — defense-in-depth against duplicate inserts from the same message re-firing.
- Partial index `pending_ella_responses_due_idx` on `(respond_after_ts) WHERE status = 'queued'` — the cron's hot-path SELECT.

## Relationships

- FK to `agent_runs` (one queue row per decision; many runs per channel)

## Populated By

- `agents/ella/passive_dispatch.py:persist_passive_evaluation` — the realtime-ingest passive branch calls this after `evaluate_passive_trigger` returns a respond_* decision.

## Read By

- `api/passive_ella_cron.py:run_passive_ella_cron` — drains queued rows whose `respond_after_ts <= now()`, LIMIT 50 per invocation.
- `agents/ella/agent.py:respond_to_passive_trigger` and `:handle_passive_general_inquiry` — receive the row as their argument and resolve channel + speaker + triggering message text from its fields.

## Example Queries

Queued rows due now (the cron's hot path):

```sql
select *
  from pending_ella_responses
 where status = 'queued'
   and respond_after_ts <= now()
 order by respond_after_ts asc
 limit 50;
```

Status breakdown over the last 24 hours:

```sql
select status, count(*)
  from pending_ella_responses
 where created_at > now() - interval '24 hours'
 group by status
 order by count(*) desc;
```

Backlog depth at any given moment:

```sql
select count(*) as queued_count
  from pending_ella_responses
 where status = 'queued';
```

If the cron stops firing, this number grows monotonically until the kill switch is flipped (which marks every queued row `cancelled_kill_switch` on the next drain).
