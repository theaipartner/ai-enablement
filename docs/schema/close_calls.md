# close_calls

Mirror of Close `Call` activities. Aggregation source for Engine-sheet dial metrics.

## Purpose

Daily dial counts (Setter Dials, Closer Dials, Total Dials), connected-calls metrics ("Calls Connected" = duration > 0 per Close convention), time-to-first-dial, and average-triage-call-duration. Inventory probe: 87 calls across 25 leads, 84% with ≥1 call, 5 distinct setter/closer user_ids in sample.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `close_id` | `text` | PK. Close `acti_*` id. Idempotency key. |
| `lead_id` | `text` | NOT NULL. Loose ref to `close_leads.close_id`. |
| `contact_id` | `text` | Contact called (optional). |
| `user_id` | `text` | Close `user_*` of the caller. Setter / closer identification. |
| `direction` | `text` | `'inbound'` / `'outbound'` / null. |
| `status` | `text` | Close call status (`'completed'`, `'no-answer'`, etc.). |
| `duration` | `integer` | Seconds. Close convention. |
| `disposition` | `text` | Free-text disposition. |
| `voicemail_url` | `text` | |
| `recording_url` | `text` | |
| `phone` / `local_phone` / `remote_phone` | `text` | |
| `note` | `text` | Caller's note. |
| `dialer_id` | `text` | `'power_dialer'` / `'predictive_dialer'` / null. |
| `source` | `text` | Close source field. |
| `date_created` | `timestamptz` | When Close created the row. |
| `activity_at` | `timestamptz` | When the call actually occurred (per Close docs: `date_created` = synced, `activity_at` = actual event). |
| `raw_payload` | `jsonb` | |
| `synced_at` / `created_at` / `updated_at` | `timestamptz` | |

## Indexes

- `close_calls_user_date_idx (user_id, date_created DESC) WHERE user_id IS NOT NULL` — per-rep dial counts.
- `close_calls_lead_id_idx (lead_id, date_created DESC)` — per-lead call timeline.
- `close_calls_direction_date_idx (direction, date_created DESC)` — inbound/outbound splits.
- `close_calls_date_idx (date_created DESC)` — period aggregations.

## Idempotency

`UPSERT ON CONFLICT (close_id)`. Activities are immutable in Close.

## What populates it

`ingestion.close.pipeline.sync_lead()` — bundled `/activity/?lead_id=&_type__in=Call,SMS,LeadStatusChange` pull, dispatched by `_type`.

## Example queries

Per-day outbound dials this week by user:
```sql
SELECT date_trunc('day', date_created) AS day, user_id, count(*) AS dials
FROM close_calls
WHERE direction = 'outbound'
  AND date_created >= current_date - interval '7 days'
GROUP BY 1, 2 ORDER BY 1, 3 DESC;
```

Calls connected (duration > 0):
```sql
SELECT count(*) FROM close_calls
WHERE direction = 'outbound' AND duration > 0
  AND date_created >= current_date - interval '7 days';
```
