# slack_channels

Slack channel metadata, mapped to clients where applicable.

## Purpose

Mirror every Slack channel we care about so agents can reason about scope (client vs. internal), privacy, and Ella's behavior without calling Slack's API. `passive_monitoring_enabled` is the per-channel kill switch for Ella's V2 passive-monitoring behavior.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | PK |
| `slack_channel_id` | `text` | Unique, not null. Slack `C...` id — stable across renames |
| `name` | `text` | Not null. Current channel name; may change |
| `client_id` | `uuid` | FK → `clients.id`. Null for internal channels |
| `is_private` | `boolean` | Not null |
| `is_archived` | `boolean` | Default `false` |
| `passive_monitoring_enabled` | `boolean` | Default `false`. Per-channel kill switch for Ella's V2 passive-monitoring behavior. Renamed from `ella_enabled` in migration 0029 (Batch 2.3). |
| `test_mode` | `boolean` | Default `false`. Per-channel test mode for passive monitoring. When `true`, the passive monitor's author-type gate accepts `team_member` messages in addition to `client` messages so Drake can smoke-test Ella as himself. NEVER enable on a production client channel — test_mode runs are tagged in `agent_runs.trigger_metadata.test_mode_run=true` for audit-filter purposes. Added in migration 0031. |
| `metadata` | `jsonb` | Extensible |
| `created_at` | `timestamptz` | |
| `updated_at` | `timestamptz` | Bumped by trigger |

## Relationships

- Logical join from `slack_messages.slack_channel_id` → `slack_channels.slack_channel_id` (text equality, not a FK — messages can land before the channel record is written)
- FK to `clients`

## Populated By

- Slack ingestion: bulk load on bot install, plus periodic refresh and `channel_created` / `channel_rename` / `channel_archive` event handlers
- `scripts/seed_clients.py` and the onboarding RPC `create_or_update_client_from_onboarding` populate fresh rows with `passive_monitoring_enabled=false`
- Dashboard: the `/clients/[id]` Details box "Slack channel ID" cell (`setClientSlackChannel` in `lib/db/clients.ts`). It updates the client's active channel row's `slack_channel_id` **in place** (never deletes the old row), or inserts a new row (`name` seeded with the id as a placeholder Slack sync later overwrites, `is_private=true`) when the client has none. Empty input unlinks (`client_id` → null), it does not delete

## Read By

- Ella (reactive path resolves `client_id` for scoping retrieval; passive path gates on `passive_monitoring_enabled` AND the global `ELLA_PASSIVE_MONITORING_ENABLED` env var; `test_mode` widens the author-type gate from `client`-only to `client`+`team_member` for the smoke-test channel)
- `ingestion/slack/realtime_ingest.py` (passive-monitor fork dispatches when `passive_monitoring_enabled=true`; threads `test_mode` into the payload so `agents/ella/passive_monitor.py:_evaluate` can apply the Gate 2 bypass)
- `api/passive_ella_cron.py` (re-checks the per-channel toggle before draining each pending row — Drake may flip it off during the 1-minute queue wait)
- Dashboards (channel → client views)

## Example Queries

Channels where Ella's passive monitoring is enabled and a client is attached:

```sql
select sc.*, c.full_name
from slack_channels sc
join clients c on c.id = sc.client_id
where sc.passive_monitoring_enabled = true
  and sc.is_archived = false
  and c.archived_at is null;
```

Resolve a Slack channel id to its client:

```sql
select client_id
from slack_channels
where slack_channel_id = $1;
```

Enable passive monitoring for a specific channel (Drake's gate (d)):

```sql
update slack_channels
   set passive_monitoring_enabled = true
 where slack_channel_id = '<channel_id>';
```

Enable test_mode for smoke testing (intended for `#ella-test-drakeonly` only):

```sql
update slack_channels
   set test_mode = true
 where slack_channel_id = 'C0AUWL20U8J';
```

Filter test_mode passive runs out of production audit metrics:

```sql
select count(*) from agent_runs
 where agent_name='ella' and trigger_type='passive_monitor'
   and (trigger_metadata->>'test_mode_run' is null
     or trigger_metadata->>'test_mode_run' != 'true');
```
