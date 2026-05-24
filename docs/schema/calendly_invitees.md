# calendly_invitees

Mirror of Calendly invitees. URI-keyed; one row per invitee per scheduled event.

## Purpose

Carries reschedule lineage + cancellation timestamps + no_show flag. The Engine sheet's "New Scheduled Meetings" filter is `rescheduled=false` on this table; "New Rescheduled Meetings" filter is `rescheduled=true`. Aggregation queries join `event_uri` → `calendly_scheduled_events.uri` for event-type filtering.

## Columns

### Identity + lineage
| Column | Type | Notes |
|---|---|---|
| `uri` | `text` | PK. `https://api.calendly.com/scheduled_events/{evt_uuid}/invitees/{inv_uuid}`. |
| `event_uri` | `text` | NOT NULL. Loose ref to `calendly_scheduled_events.uri`. No hard FK — webhook delivery order vs backfill order isn't guaranteed (invitee may arrive before its event lands locally; receiver fetches the event fresh anyway). |

### Identity / contact
| Column | Type | Notes |
|---|---|---|
| `email` | `text` | Invitee email. |
| `name` | `text` | Full name. |
| `first_name` / `last_name` | `text` | Split-name fields. |
| `timezone` | `text` | Invitee's local tz (display-relevant, not for date math — see § Date math note in `calendly_scheduled_events.md`). |

### Status + lineage
| Column | Type | Notes |
|---|---|---|
| `status` | `text` | `active` / `canceled`. |
| `invitee_created_at` | `timestamptz` | When the invitee was created in Calendly. UTC. |
| `invitee_updated_at` | `timestamptz` | Last Calendly modification. |
| `rescheduled` | `boolean` | NOT NULL default false. **True when this invitee REPLACES a prior one** (= the second leg of a reschedule). Engine row 93 "New Scheduled Meetings" filters `rescheduled=false`; row 94 "New Rescheduled" filters `rescheduled=true`. Load-bearing for not double-counting. |
| `old_invitee` | `text` | Prior-invitee URI when `rescheduled=true`. NULL otherwise. |
| `new_invitee` | `text` | Replacement-invitee URI populated on the CANCELED side of a reschedule pair. Lets aggregation reconstruct lineage from either direction. |
| `no_show` | `boolean` | NOT NULL default false. Calendly's native no-show flag. The Engine sheet currently sources No Show from a different system; potential consolidation TBD. |
| `cancel_url` | `text` | Calendly's cancellation deep-link (UI). |
| `reschedule_url` | `text` | Calendly's reschedule deep-link (UI). |
| `cancellation` | `jsonb` | Some endpoints include cancellation on the invitee too (separate from the event's `cancellation` field). Stored when present. |
| `raw_payload` | `jsonb` | Full invitee payload for forensics. |

### Lifecycle
| Column | Type | Notes |
|---|---|---|
| `synced_at` | `timestamptz` | When ingestion last touched this row. |
| `created_at` / `updated_at` | `timestamptz` | Standard. `updated_at` trigger via `set_updated_at()`. |

## Reschedule semantics — critical for not double-counting

A Calendly reschedule fires as TWO webhook events:

1. **`invitee.canceled`** on the OLD invitee. The old invitee row gets `status='canceled'` + `new_invitee=<URI of new invitee>`.
2. **`invitee.created`** on the NEW invitee. The new invitee row gets `status='active'`, `rescheduled=true`, `old_invitee=<URI of old invitee>`.

The Engine sheet's "New Scheduled Meetings" metric must count rows with `rescheduled=false` so the new invitee from a reschedule is NOT counted as a fresh booking. "New Rescheduled Meetings" counts rows with `rescheduled=true`. Tested in `tests/ingestion/calendly/test_pipeline.py::test_sync_invitee_and_event_reschedule_pair_no_double_count`.

## Indexes

- PK on `uri`.
- `(event_uri)` — most-common join key.
- `(invitee_created_at DESC)` — cohort window scans.
- `(rescheduled) WHERE rescheduled = true` — partial index for the rescheduled-count metric.
- `(status, invitee_created_at DESC)` — per-day status counts.

## Idempotency

`UPSERT ON CONFLICT (uri)`. Webhook redeliveries / backfill overlaps land cleanly.

## What populates it

- `ingestion.calendly.pipeline.upsert_invitee_from_payload()` — per-invitee upsert.
- `ingestion.calendly.pipeline.sync_invitee_and_event()` — webhook orchestration (invitee + parent event refresh).
- `ingestion.calendly.pipeline.sync_recent_events_with_invitees()` — backfill walker pulls invitees per event.

## Example queries

New Scheduled Meetings, last 7 days EDT:
```sql
SELECT (invitee_created_at AT TIME ZONE 'America/New_York')::date AS day_edt,
       count(*) AS new_scheduled
FROM calendly_invitees
WHERE status = 'active'
  AND rescheduled = false
  AND invitee_created_at >= now() - interval '7 days'
GROUP BY 1
ORDER BY 1 DESC;
```

Rescheduled Meetings, last 7 days EDT:
```sql
SELECT (invitee_created_at AT TIME ZONE 'America/New_York')::date AS day_edt,
       count(*) AS rescheduled_count
FROM calendly_invitees
WHERE status = 'active'
  AND rescheduled = true
  AND invitee_created_at >= now() - interval '7 days'
GROUP BY 1
ORDER BY 1 DESC;
```

No-shows in last 14 days:
```sql
SELECT (invitee_created_at AT TIME ZONE 'America/New_York')::date AS day_edt,
       count(*) AS no_show_count
FROM calendly_invitees
WHERE no_show = true
  AND invitee_created_at >= now() - interval '14 days'
GROUP BY 1
ORDER BY 1 DESC;
```
