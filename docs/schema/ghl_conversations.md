# ghl_conversations

Mirror of GoHighLevel conversations — one per contact thread. Exists mainly to
**drive incremental message pulls**: each conversation's messages are re-fetched
only when its `last_message_date` moves past the `messages_synced_at` watermark.
Added in migration `0114`.

Populated by `ingestion/ghl/pipeline.py` (`sync_conversations_and_messages`).
Runbook: `docs/runbooks/ghl_ingestion.md`.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `id` | `text` | **PK.** GHL conversation id. |
| `contact_id` | `text` | → `ghl_contacts.id`. Indexed. |
| `location_id` | `text` | Sub-account id. |
| `type` | `text` | e.g. `TYPE_PHONE`. |
| `last_message_date` | `timestamptz` | Latest message time (GHL sends epoch ms; normalized to UTC). Drives the incremental decision. Indexed. |
| `last_message_type` | `text` | `TYPE_SMS` / `TYPE_CALL` / … |
| `date_added` / `date_updated` | `timestamptz` | Conversation timestamps. |
| `raw` | `jsonb` | Full GHL conversation object. |
| `messages_synced_at` | `timestamptz` | **Watermark.** Set to `now()` after a clean message pull. Re-pull happens when `last_message_date > messages_synced_at` (or this is null). Advanced **only** on a clean pull so failures retry. |
| `synced_at` | `timestamptz` | Last upsert time. |

## Relationships

- `contact_id` → `ghl_contacts.id`.
- `id` ← `ghl_messages.conversation_id`.

## Example queries

```sql
-- Conversations needing a message re-pull next tick.
select count(*) from ghl_conversations
where messages_synced_at is null or last_message_date > messages_synced_at;
```
