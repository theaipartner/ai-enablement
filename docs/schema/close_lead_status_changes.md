# close_lead_status_changes

Mirror of Close's `LeadStatusChange` activity — every timestamped lead-status transition.

## Purpose

The funnel-spine event stream. Aggregation source for the Engine sheet's status-flip metrics: Hand Downs, DQs, Downsells, Booked Meetings, No Shows, Deposits, Client. Inventory probe showed 51 events across 25 sampled leads — densely populated.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `close_id` | `text` | PK. Close activity id (e.g. `acti_...`). Idempotency key. |
| `lead_id` | `text` | NOT NULL. References the lead (loose FK — no cross-table constraint; see § Why no FK). |
| `old_status_id` | `text` | Previous lead status (`stat_*`). Null on first-creation status. |
| `old_status_label` | `text` | Denormalized for read convenience. |
| `new_status_id` | `text` | New lead status (`stat_*`). |
| `new_status_label` | `text` | Denormalized. |
| `user_id` | `text` | Close `user_*` of whoever changed the status. |
| `date_created` | `timestamptz` | When the status changed in Close. |
| `raw_payload` | `jsonb` | Full activity JSON — audit / replay. |
| `synced_at` / `created_at` / `updated_at` | `timestamptz` | Standard. |

## Indexes

- `close_lead_status_changes_new_status_date_idx (new_status_id, date_created DESC)` — per-day "leads that became X" counts.
- `close_lead_status_changes_lead_id_idx (lead_id, date_created DESC)` — per-lead transition history.
- `close_lead_status_changes_date_idx (date_created DESC)` — period aggregations.

## Why no FK on `lead_id`

Backfill order doesn't guarantee the `close_leads` row lands before all its activity rows. Loose ref keeps backfill resilient; aggregation layer left-joins to `close_leads` for label resolution. Same pattern in `close_calls` and `close_sms`.

## Idempotency

`UPSERT ON CONFLICT (close_id)`. Activities are immutable in Close, so re-runs always write identical data.

## What populates it

`ingestion.close.pipeline.sync_lead()` — fetches `/activity/?lead_id=&_type__in=LeadStatusChange` per lead and upserts each row.

## What reads from it

Future Gregory sales-side aggregation layer. The 11 status IDs the org uses are documented in `docs/reports/close-smartview-discovery.md` § Lead status pipeline.

## Triage-count canonical choice

**For "Total Closer Triages" the canonical source is `close_leads.triage_showed = 'Yes'`, NOT a status transition here.** The Engine sheet's "Total Closer Triages" means "the phone call where a human qualifies the lead". A status flip to `Unconfirmed Booking - Handed over` marks the hand-OVER, not the triage call itself.

This table IS the canonical source for **Hand Downs** (closer → setter after failed contact attempts) and most other status-flip Engine metrics. See `docs/runbooks/close_ingestion.md` § Triage-count for the full reasoning and the gap risk (triage_showed cf needs to be filled in reliably by closers).

## Example queries

Per-day Hand Downs in the last 7 days (status flip into the Handed-over status):
```sql
SELECT date_trunc('day', date_created) AS day, count(*)
FROM close_lead_status_changes
WHERE new_status_id = 'stat_GZca7DExvxZ2FkjKNFgWxqrlKwB1ULxA2xKrYszhVf5'
  AND date_created >= current_date - interval '7 days'
GROUP BY 1 ORDER BY 1;
```

DQ rate this week (DQs / total transitions):
```sql
SELECT
  count(*) FILTER (WHERE new_status_id = 'stat_Sy5P7oFaIcdSOAON2XY1ELblocmqzvnB7ie7cMQllSX')::float
  / NULLIF(count(*), 0) AS dq_rate
FROM close_lead_status_changes
WHERE date_created >= current_date - interval '7 days';
```
