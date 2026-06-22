# webhook_deliveries

The idempotency + audit ledger for every inbound webhook and cron delivery.

## Purpose

One row per delivery attempt across all ingestion paths. It serves two jobs:

1. **Idempotency.** `webhook_id` is the primary key, so a receiver can check-or-insert to dedupe retries
   (external services re-deliver; crons overlap their windows). A duplicate delivery hits the existing row
   instead of reprocessing.
2. **Audit.** Every receiver and cron writes a row here with a `source` discriminator and a
   `processing_status`, so the health of every pipeline is queryable from one table (the `inspect_ingestion`
   runbook leans on this).

Some pipelines also store **non-delivery sentinel rows** here (e.g. the Airtable webhook cursor) keyed by a
synthetic `webhook_id` — same table, used as durable per-source scratch.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `webhook_id` | `text` | **PK.** The dedup key. Real deliveries use the source's event id; synthesized for sources without one (e.g. `airtable:<id>:<ts>:<hash>`) |
| `source` | `text` | Not null, default `'fathom_webhook'`. Which pipeline wrote the row — e.g. `slack_message_ingest`, `calendly`, `typeform_response_webhook`, `airtable_webhook`, `accountability_notification_cron`, `cs_call_summary_slack_post`, `ella_passive_escalation_dm`, `airtable_webhook_cursor` |
| `received_at` | `timestamptz` | Not null, default `now()`. When the delivery arrived. Indexed DESC |
| `processed_at` | `timestamptz` | When processing finished (null until then) |
| `processing_status` | `text` | Not null, default `'received'`. CHECK allows `received` / `processed` / `failed` / `duplicate` / `malformed`. Skip cases use `processed` + a `processing_error='skipped_*'` + `payload.skip_reason` |
| `processing_error` | `text` | Error detail or skip reason when not cleanly processed |
| `call_external_id` | `text` | Fathom-path convenience: the call's external id, for joining deliveries to `calls` |
| `payload` | `jsonb` | The delivery body (or a synthesized record for sentinel rows) |
| `headers` | `jsonb` | Request headers (signatures redacted where sensitive) |

Indexes: PK on `webhook_id`; `received_at DESC`; partial on `processing_status` WHERE `<> 'processed'`
(fast "what failed/needs attention" scans); partial on `(source, call_external_id)` WHERE `call_external_id
IS NOT NULL`.

## Relationships

- Soft link via `call_external_id` → `calls.external_id` (Fathom path). No hard FK — deliveries are logged
  regardless of whether the referenced row exists yet.

## Populated By

Every inbound receiver and cron, including:
- Webhooks: `api/fathom_events.py`, `api/slack_events.py`, `api/calendly_events.py`, `api/typeform_events.py`,
  `api/airtable_events.py`, `api/close_events.py`, `api/airtable_nps_webhook.py`, `api/airtable_onboarding_webhook.py`.
- Crons: each writes an audit row with `source=<cron_name>` (e.g. `accountability_notification_cron`,
  `clarity_sync`, `airtable_sync_cron`).
- Slack-post hooks (`cs_call_summary_post.py`, Ella escalation DMs) and the Airtable webhook cursor sentinel.

## Read By

- Receivers themselves, for the dedup check before processing.
- Ops / diagnostics — see `docs/runbooks/inspect_ingestion.md` and the per-source ingestion runbooks.

## Example Queries

Recent failures across all pipelines:

```sql
select source, webhook_id, processing_error, received_at
from webhook_deliveries
where processing_status = 'failed'
order by received_at desc
limit 50;
```

Delivery volume by source over the last day:

```sql
select source, processing_status, count(*)
from webhook_deliveries
where received_at > now() - interval '1 day'
group by source, processing_status
order by source;
```

Has a given event already been processed?

```sql
select processing_status, processed_at
from webhook_deliveries
where webhook_id = $1;
```
