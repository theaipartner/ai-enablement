# client_journey_stage_history

Append-only audit trail for `clients.journey_stage` changes.

## Purpose

Preserve when a client moved between funnel positions (`business_setup`, `business_setup_activation_done`, `prospecting`, `first_closing_call_taken`, `first_closed_deal`, `ten_k_month` per the migration 0028 CHECK on `clients.journey_stage`) so the dashboard's Lifecycle & Standing section can show a journey-stage timeline. Same application-layer write pattern as `client_status_history` — the dashboard's edit endpoint writes both `clients.journey_stage` and a new history row in the same transaction.

**This table has NO CHECK constraint on `journey_stage`** (mirrors the `client_status_history` pattern). The history is append-only audit; if the vocab on `clients.journey_stage` is ever widened or renamed in a future migration, existing history rows with retired values stay valid as historical records. CHECK on history would prevent that.

Seeded at migration time (`0017_client_page_schema_v1.sql`) with one row per non-archived client whose `journey_stage` is non-null. Most existing clients have null `journey_stage`, so the seed produced 0 rows on first run.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | PK |
| `client_id` | `uuid` | FK → `clients.id`, not null. No cascade |
| `journey_stage` | `text` | Nullable — mirrors `clients.journey_stage` nullability so the application can record a transition into "no stage" |
| `changed_at` | `timestamptz` | Default `now()` |
| `changed_by` | `uuid` | FK → `team_members.id`. Nullable for the same reasons as `client_status_history.changed_by` |
| `note` | `text` | Optional free-text reason for the change |

## Relationships

- FK to `clients` (no cascade)
- FK to `team_members` via `changed_by`

## Populated By

- Migration `0017_client_page_schema_v1.sql` seed — one row per non-archived client with non-null journey_stage (0 rows on first apply)
- Gregory dashboard's journey-stage-edit endpoint (Chunk B) — every change writes both `clients.journey_stage` and a new row here

## Read By

- Gregory dashboard's Lifecycle & Standing section on `/clients/[id]` (journey-stage timeline)
- Future cohort reporting (e.g. "how long did clients sit in business_setup before reaching first_closed_deal?")

## Example Queries

Journey-stage timeline for one client, newest first:

```sql
select journey_stage, changed_at, changed_by, note
from client_journey_stage_history
where client_id = $1
order by changed_at desc;
```

Median time spent in `business_setup` before transitioning to any later stage (rough estimate):

```sql
with stage_changes as (
  select client_id, journey_stage, changed_at,
         lead(changed_at) over (partition by client_id order by changed_at) as next_changed_at
  from client_journey_stage_history
)
select percentile_cont(0.5) within group (order by extract(epoch from (next_changed_at - changed_at)) / 86400) as median_days
from stage_changes
where journey_stage = 'business_setup'
  and next_changed_at is not null;
```
