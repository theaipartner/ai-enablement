# calendly_event_types

Reference table mirroring Calendly's event-type catalog. ~14 rows in the AI Partner org as of 2026-05-24 (per discovery).

## Purpose

Display labels + admin reference for the event types Calendly exposes. The aggregation layer **does NOT typically join `calendly_scheduled_events.event_type_uri` to this table** because 58% of historical events reference RETIRED event-type URIs absent from the active catalog (proven in discovery — `docs/reports/calendly-discovery.md`). Filter closer bookings by `calendly_scheduled_events.name` (case-insensitive) instead.

## Columns

| Column | Type | Notes |
|---|---|---|
| `uri` | `text` | PK. Stable Calendly URI, e.g. `https://api.calendly.com/event_types/{uuid}`. |
| `name` | `text` | Display name (e.g. "AI Partner Strategy Call"). Note casing in this column matches the catalog; events themselves may have drifted casing (e.g. "Ai Partner Strategy Call"). |
| `duration_minutes` | `integer` | Default meeting length. |
| `kind` | `text` | `solo` / `group` / etc. AI Partner: all `solo` today. |
| `active` | `boolean` | Whether this event type is currently bookable. |
| `scheduling_url` | `text` | The public Calendly URL for self-service booking. |
| `raw_payload` | `jsonb` | Full event-type payload for forensics. |
| `synced_at` | `timestamptz` | When ingestion last touched this row. |
| `created_at` / `updated_at` | `timestamptz` | Standard. `updated_at` trigger via `set_updated_at()`. |

## Indexes

PK on `uri`. No secondary indexes (~14 rows; full scans are trivial).

## Idempotency

`UPSERT ON CONFLICT (uri)`. Refreshed on each backfill tick + opportunistically.

## What populates it

- `ingestion.calendly.pipeline.sync_event_types()` — bulk refresh during backfill.
- `scripts/backfill_calendly.py` — runs the above as part of its sync.
- The webhook receiver does NOT touch this table (event-type create/update isn't a webhook event today).

## Example queries

Active event types ordered by name:
```sql
SELECT uri, name, duration_minutes, kind
FROM calendly_event_types
WHERE active = true
ORDER BY name;
```

The known closer event-type set (matched by the aggregation layer):
```sql
SELECT name FROM calendly_event_types
WHERE LOWER(name) IN ('ai partner strategy call');
```
(See `ingestion/calendly/__init__.py:CLOSER_EVENT_TYPE_NAMES` for the canonical set.)
