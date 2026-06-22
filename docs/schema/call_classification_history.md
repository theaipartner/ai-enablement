# call_classification_history

Append-only audit trail of manual edits to a call's classification fields.

## Purpose

When a CSM corrects a call's classification on the Calls detail page (category, type, or primary client),
each changed field is recorded here as one row. The history lets the team see who reclassified a call and
how it changed over time — classification is a judgment surface, so the edits are auditable. Append-only:
rows are never updated or deleted.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | PK, default `gen_random_uuid()` |
| `call_id` | `uuid` | Not null. The call that was edited. FK-style → `calls.id`. Indexed |
| `changed_by` | `uuid` | The `team_members` row that made the edit (nullable for system/unattributed changes) |
| `changed_at` | `timestamptz` | Not null, default `now()`. Indexed DESC |
| `field_name` | `text` | Not null. Which field changed — e.g. `call_category`, `call_type`, `primary_client_id` |
| `old_value` | `text` | Value before the edit (text-serialized; null if previously unset) |
| `new_value` | `text` | Value after the edit (text-serialized; null if cleared) |

Indexes: PK on `id`; `call_id`; `changed_at DESC`.

## Relationships

- `call_id` → `calls.id` (the edited call).
- `changed_by` → `team_members.id` (soft; nullable).

## Populated By

- The Calls detail page (`/calls/[id]`) classification edit flow — one row per changed field when a CSM
  saves a reclassification. (Re-running the ingestion classifier does **not** write here; this table records
  *human* edits only.)

## Read By

- The Calls detail page, to render the classification change history.
- Audit / diagnostics.

## Example Queries

Full edit history for one call (most recent first):

```sql
select changed_at, field_name, old_value, new_value, changed_by
from call_classification_history
where call_id = $1
order by changed_at desc;
```

Recent reclassifications across all calls:

```sql
select call_id, field_name, old_value, new_value, changed_at
from call_classification_history
order by changed_at desc
limit 50;
```
