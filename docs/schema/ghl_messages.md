# ghl_messages

Mirror of GoHighLevel conversation **messages** — SMS *and* calls in one stream
(GHL collapses both into messages). The GHL counterpart of `close_sms` +
`close_calls`. One row per message. Added in migration `0114`.

Populated by `ingestion/ghl/pipeline.py` (`sync_conversations_and_messages`). The
outbound funnel's responded / called / connected signals + rep attribution read
here. Runbook: `docs/runbooks/ghl_ingestion.md`.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `id` | `text` | **PK.** GHL message id. |
| `conversation_id` | `text` | → `ghl_conversations.id`. Indexed. |
| `contact_id` | `text` | → `ghl_contacts.id`. Indexed with `date_added`. |
| `location_id` | `text` | Sub-account id. |
| `message_type` | `text` | `TYPE_SMS`, `TYPE_CALL`, `TYPE_EMAIL`, `TYPE_ACTIVITY_*`. Indexed with `direction`. |
| `direction` | `text` | `inbound` / `outbound`. |
| `status` | `text` | `delivered` (SMS) / `completed` · `voicemail` · `no-answer` · `busy` · `failed` (calls). |
| `user_id` | `text` | The rep, set on **calls** → `team_members` (the SMS blasts are automation, no user). |
| `call_duration` | `int` | `meta.call.duration` in seconds (calls only). |
| `call_status` | `text` | `meta.call.status` (mirrors `status` for calls). |
| `body` | `text` | Message body (SMS text). |
| `date_added` | `timestamptz` | Message timestamp. |
| `raw` | `jsonb` | Full GHL message object. |
| `synced_at` | `timestamptz` | Last upsert time. |

## Funnel signal rules

- **responded** = a row with `message_type='TYPE_SMS'` and `direction='inbound'`.
- **called** = `message_type='TYPE_CALL'` and `direction='outbound'`.
- **connected** = `message_type='TYPE_CALL'` AND `call_status='completed'` AND
  `call_duration >= 90`. The `>=90` matches Close's "connected" definition (keeps
  the unified Outbound funnel comparable across Close + GHL pools); the
  `='completed'` guard drops long voicemail recordings. **`status='completed'`
  alone is *not* connected** — ~78% of completed calls observed were < 90s
  (pickup-and-hangups).

## Relationships

- `conversation_id` → `ghl_conversations.id`; `contact_id` → `ghl_contacts.id`.
- `user_id` → a GHL user → `team_members` (mapping TBD in Phase 2/3, by email).

## Example queries

```sql
-- Connected calls per rep in the GHL outbound pool.
select user_id, count(*)
from ghl_messages
where message_type = 'TYPE_CALL' and call_status = 'completed' and call_duration >= 90
group by user_id order by 2 desc;
```
