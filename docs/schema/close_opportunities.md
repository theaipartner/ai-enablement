# close_opportunities

Mirror of Close Opportunity objects.

## Purpose

**Workflow markers, NOT money.** Per the inventory report, all 30 sampled opportunities had `value = $1 USD` placeholder. The opportunity object in this org tracks a parallel state machine (`Opt-Ins` → `Confirmed booking` → `DQ`) that gives a coarser funnel signal than the lead-status pipeline. Useful when the team wants opp-level counts distinct from lead-status equivalents.

**Canonical money source for the Engine sheet's CLOSING section is Closer EOC Forms** (separate ingestion source, not yet built). The lead custom fields `amount_of_Nth_payment?` on `close_leads` are a secondary cross-validation source. `close_opportunities.value` is NOT the money source.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `close_id` | `text` | PK. Close `oppo_*` id. |
| `lead_id` | `text` | NOT NULL. Loose ref to `close_leads`. |
| `status_id` | `text` | Opportunity status id. |
| `status_label` | `text` | Denormalized — `'Opt-Ins'` / `'Confirmed booking'` / `'DQ'` typical values. |
| `status_type` | `text` | `'active'` / `'won'` / `'lost'`. |
| `value` | `integer` | Cents. **$1 placeholders in this org — NOT money.** Mirrored for completeness only. |
| `value_currency` | `text` | `'USD'` typical. |
| `value_period` | `text` | `'one_time'` / `'monthly'` / `'annual'`. |
| `value_formatted` | `text` | Close's pre-formatted display string. |
| `annualized_value` / `expected_value` | `integer` | Cents. Same caveat as `value`. |
| `note` | `text` | Free-text. |
| `user_id` / `contact_id` | `text` | |
| `created_by` / `updated_by` | `text` | |
| `date_created` / `date_updated` | `timestamptz` | |
| `date_won` / `date_lost` | `date` | When the opp moved to won/lost. |
| `confidence` | `integer` | 0-100. |
| `raw_payload` | `jsonb` | |
| Lifecycle cols | | Standard. |

## Indexes

- `close_opportunities_lead_id_idx (lead_id)` — per-lead opp lookup.
- `close_opportunities_status_id_idx (status_id, date_created DESC)` — per-status counts.
- `close_opportunities_date_won_idx (date_won DESC) WHERE NOT NULL`.
- `close_opportunities_date_lost_idx (date_lost DESC) WHERE NOT NULL`.

## Idempotency

`UPSERT ON CONFLICT (close_id)`.

## What populates it

`ingestion.close.pipeline.sync_all_opportunities()` — paginated `/opportunity/` walk during backfill + incremental.

## What reads from it

Future Gregory sales-side aggregation layer. Distinct from `close_lead_status_changes` — opportunities can change status independently of leads (and on a slightly different timeline / granularity).

## Example query

Opportunities created in last 7 days by status:
```sql
SELECT status_label, count(*)
FROM close_opportunities
WHERE date_created >= current_date - interval '7 days'
GROUP BY 1 ORDER BY 2 DESC;
```
