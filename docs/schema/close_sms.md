# close_sms

Mirror of Close SMS activities — the dominant channel.

## Purpose

SMS was 67% of all activity in the inventory probe vs Email's 6%. "First Message Response" is SMS + Call, **not email**. The auto-SMS-on-opt-in flow that defines funnel entry lives here.

Aggregation surface for: First Message Responses (inbound after the auto-outbound), SMS volume per period, response rates.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `close_id` | `text` | PK. Close `acti_*` id. |
| `lead_id` | `text` | NOT NULL. Loose ref. |
| `contact_id` | `text` | |
| `user_id` | `text` | Sender (for outbound) or null (for inbound). |
| `direction` | `text` | `'inbound'` / `'outbound'`. |
| `status` | `text` | `'sent'` / `'delivered'` / `'inbound'` / etc. |
| `text` | `text` | Message body. |
| `local_phone` / `remote_phone` | `text` | |
| `date_created` | `timestamptz` | Synced timestamp. |
| `date_sent` | `timestamptz` | When the SMS was actually sent. |
| `activity_at` | `timestamptz` | Close's authoritative timestamp. |
| `raw_payload` | `jsonb` | |
| Lifecycle cols | | Standard. |

## Indexes

- `close_sms_lead_id_idx (lead_id, date_created DESC)` — per-lead SMS thread.
- `close_sms_direction_date_idx (direction, date_created DESC)` — inbound/outbound splits (the load-bearing query for First Message Response).
- `close_sms_date_idx (date_created DESC)` | period aggregations.

## Idempotency

`UPSERT ON CONFLICT (close_id)`.

## What populates it

`ingestion.close.pipeline.sync_lead()` — bundled with Calls + LeadStatusChange in one `/activity/` call.

## Example query

First Message Responses today — inbound SMS replies to leads that had an outbound SMS in the prior 24h:
```sql
WITH outbound_today AS (
  SELECT DISTINCT lead_id FROM close_sms
  WHERE direction = 'outbound' AND date_created >= current_date - interval '1 day'
)
SELECT count(DISTINCT s.lead_id)
FROM close_sms s
JOIN outbound_today o USING (lead_id)
WHERE s.direction = 'inbound' AND s.date_created >= current_date - interval '1 day';
```
