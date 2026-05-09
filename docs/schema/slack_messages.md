# slack_messages

Ingested Slack message history — the canonical store of what was said, by whom, and when.

## Purpose

Give agents (Ella, CSM Co-Pilot) a queryable record of Slack activity without calling Slack's API. Raw payload is preserved so future extractions (reactions, attachments, workflow form fields) don't require re-ingestion.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | PK |
| `slack_channel_id` | `text` | Not null. Channel `C...` id. Logical join to `slack_channels`; deliberately not a FK |
| `slack_ts` | `text` | Not null. Slack message timestamp — unique per message within a channel |
| `slack_thread_ts` | `text` | Parent message `ts` when in a thread; null otherwise |
| `slack_user_id` | `text` | Not null. Author's Slack id |
| `author_type` | `text` | `client`, `team_member`, `ella`, `bot`, `workflow`, `unknown`. Resolved at ingestion. `'ella'` requires `SLACK_USER_TOKEN` env var to be set so the realtime handler / pipeline can resolve Ella's Slack user_id via `auth.test`; absent it, Ella's posts fall back to `team_member` (if her id is in `team_members.slack_user_id`) or `unknown` |
| `text` | `text` | Not null. Normalized message text |
| `message_type` | `text` | Default `message`. `message`, `thread_reply`, `bot_message`, `workflow_submission` |
| `message_subtype` | `text` | Tagged at ingestion: `accountability_submission`, `nps_submission`, etc. |
| `raw_payload` | `jsonb` | Not null. Full original Slack event |
| `sent_at` | `timestamptz` | Not null. Derived from `slack_ts` |
| `ingested_at` | `timestamptz` | Default `now()` |

`UNIQUE (slack_channel_id, slack_ts)` makes re-ingestion idempotent.

## Relationships

- Logical join on `slack_channel_id` to `slack_channels.slack_channel_id`
- No hard FK to clients/team_members — `author_type` + application-layer joins handle resolution

## Populated By

- Slack ingestion: historical backfill on install, then real-time events via the Events API
- Ella V2 Batch 1 (cloud Slack ingestion, shipped 2026-05-09): the realtime handler at `api/slack_events.py` ingests every `message`-event from a client channel via `ingestion/slack/realtime_ingest.py`. The one-shot `scripts/backfill_slack_client_channels.py` populates historical messages. Both paths use the same parser (`ingestion/slack/parser.py`) for author resolution and idempotency on `(slack_channel_id, slack_ts)`.

## Read By

- Ella (retrieval: "has this client asked about X before?")
- CSM Co-Pilot (activity cadence, sentiment signals, accountability submissions, NPS submissions)
- Dashboards

## Accountability Submissions

Clients submit accountability via a Slack Workflow form. The form posts back to the channel as a structured message. Ingestion tags these with `message_subtype = 'accountability_submission'`. Structured form fields live in `raw_payload` and can be promoted into a normalized shape during ingestion if fast access is needed.

## Example Queries

Last 30 days of a client's accountability submissions in their channel:

```sql
select sent_at, text, raw_payload
from slack_messages m
join slack_channels c on c.slack_channel_id = m.slack_channel_id
where c.client_id = $1
  and m.message_subtype = 'accountability_submission'
  and m.sent_at > now() - interval '30 days'
order by m.sent_at desc;
```

Thread view:

```sql
select *
from slack_messages
where slack_channel_id = $1
  and (slack_ts = $2 or slack_thread_ts = $2)
order by sent_at asc;
```
