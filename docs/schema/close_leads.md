# close_leads

Mirror of Close CRM lead objects. The funnel-relevant lead custom-field subset is denormalized as typed columns for fast aggregation queries; the complete `custom.cf_*` map is kept in `custom_fields_raw` jsonb so any future field can be consumed without a migration.

## Purpose

Source data for the Gregory sales-side aggregation layer that produces the Engine sheet's APPOINTMENT SETTING + CLOSING metrics. Per CLAUDE.md § Core Principles, agents and the dashboard query this table, not Close directly.

## Columns

### Identity + core lead fields
| Column | Type | Notes |
|--------|------|-------|
| `close_id` | `text` | PK. Close's stable lead id (e.g. `lead_WjHtHd...`). Idempotency key. |
| `display_name` | `text` | Lead's display name in Close. |
| `description` | `text` | Free-text description. |
| `url` | `text` | Optional Close URL. |
| `status_id` | `text` | Current lead status id (`stat_*`). Maps to the 11-status pipeline. |
| `status_label` | `text` | Denormalized status label for read-time convenience. |
| `contacts` | `jsonb` | Close `contacts` array (rarely queried; never the primary aggregation surface). |
| `addresses` | `jsonb` | Close `addresses` array. |
| `created_by` / `updated_by` | `text` | Close user IDs (`user_*`). |
| `date_created` / `date_updated` | `timestamptz` | Close lifecycle timestamps — source of truth for cohort windows. |

### Marketing attribution (~100% populated)
`utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `source`, `funnel_name`, `funnel_type`, `ad_name`, `ad_id`, `adset_id`, `campaign_id` — all `text`. Drive the FUNNELS section + cost-per-X derived rates (joined to Meta spend on `campaign_id` / `ad_id`).

### Opt-in lifecycle
| Column | Type | Notes |
|--------|------|-------|
| `date_first_opted_in` | `date` | First opt-in date for this lead. |
| `latest_opt_in_date` | `timestamptz` | Most recent opt-in (leads can opt in multiple times). |
| `number_of_opt_ins` | `integer` | Count of opt-ins to date. |

### Qualification signals (form-level — Typeform output)
| Column | Type | Notes |
|--------|------|-------|
| `investment` | `text` | Disposable-income bucket. Drives Tier split (see `tier` below). |
| `monthly_income` | `text` | Income bucket. |
| `marketing_qualified` | `text` | `'Yes'` / `'No'`. |
| `overnight_lead` | `text` | `'Yes'` / `'No'`. |

### Derived
| Column | Type | Notes |
|--------|------|-------|
| `tier` | `text` | `'tier_1'` (qualified for closer, ≥ $2k disposable) / `'tier_2'` (unqualified, routes to setter) / `null` (unknown). Derived in ingestion from `investment` per `ingestion.close.parser.derive_tier`. |

### Booking lifecycle
`date_of_first_booked_call`, `latest_date_of_booked_call`, `date_first_connected` (`date`); `date_call_scheduled_for` (`timestamptz`); `direct_call_booked`, `confirmed_booking`, `call_connected`, `showed`, `triage_showed` (`text` — typically `'Yes'`/`'No'` or `'TRUE'`/`'FALSE'`).

| Column | Type | Notes |
|--------|------|-------|
| `reactivated_at` | `timestamptz` | When a direct-booking lead (booked an Ai Partner Strategy Call) lost that strat-call spot, at the **earliest** of three additive triggers: (A) confirmation form (`airtable_setter_triage_calls` `form_type='Closer Triage Form'`) `call_status` ~ `Setter pipeline` (setter handover); (B) first closer EOC form (`airtable_full_closer_report`) outcome = ghost/no-show/cancel; (C) the strat meeting lapsing silently — the lead has a direct strat booking, **no active (status != `canceled`) future strat booking**, and the latest non-canceled booking's `start_time + 3h` is in the past (`reactivated_at` = that `start_time + 3h`; the 3h grace absorbs a drag-dropped reschedule's cancel→recreate gap). **DQ never triggers** (a DQ'd lead is a direct that DQ'd); **reschedule never triggers** by itself; a lead that **attended** a strat meeting (close/deposit/follow-up/DQ EOC outcome) is **never lapse-reactivated** (trigger C is showed-blocked — triggers A & B already exclude showed outcomes). Set once / earliest-wins, never cleared. `null` = never reactivated. Added migration `0063`; trigger C added `0065`. Populated by `scripts/backfill_reactivated_at.py` + maintained by `tag_reactivated_leads()` via the Airtable cron. Drives the `/sales-dashboard/leads` reactivation funnel + scopes that funnel's post-handover activity (dials/connected/books/shows/closes counted only after this timestamp). |

### Ownership
| Column | Type | Notes |
|--------|------|-------|
| `closer_owner_id` | `text` | Close `user_*` id of the assigned closer. |
| `setter_owner_id` | `text` | Close `user_*` id of the assigned setter. |

### Cancellation / reschedule
| Column | Type | Notes |
|--------|------|-------|
| `no_show_or_cancellation` | `text` | `'Yes'` / `'No'`. |
| `no_show_or_cancellation_date` | `timestamptz` | When the no-show was recorded. |
| `number_of_reschedules` | `integer` | Reschedule count. |

### Closing / payment (sparse — populated on closed leads only)
`type_of_payment_on_call`, `contract_sent`, `closed`, `lost_deal`, `payment_plan_type`, `total_monthly_creative_payments`, `amount_of_1st_payment` … `amount_of_5th_payment` (`text` — source values are text-typed and may carry currency markers like `'$1,133'`); `date_contract_sent`, `date_closed`, `date_of_1st_payment` … `date_of_5th_payment` (`date`).

**Not the canonical money source.** The Engine sheet's closing-funnel money is sourced from Closer EOC Forms, NOT Close. These cfs are mirrored for cross-validation only.

### Cross-system + catch-all
| Column | Type | Notes |
|--------|------|-------|
| `airtable_student_record_id` | `text` | Join key to Airtable student rows. |
| `custom_fields_raw` | `jsonb` | NOT NULL DEFAULT `{}`. Map of `cf_*` → raw value for every custom field on the lead. Aggregation layer can query with jsonb operators for cfs not denormalized as typed columns. |
| `raw_payload` | `jsonb` | Full Close API response — audit / replay if the parser evolves. |

### Lifecycle
| Column | Type | Notes |
|--------|------|-------|
| `synced_at` | `timestamptz` | When ingestion last upserted this row. |
| `created_at` / `updated_at` | `timestamptz` | Standard. `updated_at` trigger via `set_updated_at()`. |

## Indexes

- `close_leads_status_id_idx (status_id)` — per-status funnel counts.
- `close_leads_date_created_idx (date_created DESC)` — cohort windows.
- `close_leads_date_updated_idx (date_updated DESC)` — incremental polling.
- `close_leads_date_first_opted_in_idx (date_first_opted_in DESC)` — opt-in cohort attribution.
- `close_leads_tier_idx (tier) WHERE tier IS NOT NULL` — Tier 1 / Tier 2 booked-meeting splits.
- `close_leads_closer_owner_idx (closer_owner_id) WHERE NOT NULL` — per-closer performance.
- `close_leads_setter_owner_idx (setter_owner_id) WHERE NOT NULL` — per-setter performance.
- `close_leads_funnel_name_idx (funnel_name) WHERE NOT NULL` — funnel-name splits (Closer Funnel vs Direct Booking Funnel).
- `close_leads_campaign_id_idx (campaign_id) WHERE NOT NULL` — Meta-spend join.

## Idempotency

`UPSERT ON CONFLICT (close_id)`. Re-running the backfill or pipeline is a no-op-equivalent — values refresh, no duplicates.

## What populates it

- `ingestion.close.pipeline.sync_lead()` — per-lead end-to-end (full lead JSON + activities).
- `ingestion.close.pipeline.sync_all_leads()` — bulk paginator.
- `ingestion.close.pipeline.sync_recently_updated_leads()` — incremental for the polling cron (when shipped).

## What reads from it

- Future Gregory sales-side aggregation layer (in design). No agents query it directly today.

## Example queries

Tier 1 booked meetings this week:
```sql
SELECT count(*)
FROM close_leads
WHERE tier = 'tier_1'
  AND confirmed_booking = 'Yes'
  AND latest_date_of_booked_call >= current_date - interval '7 days';
```

Per-closer leads in `Unconfirmed Booking - Handed over` (current snapshot):
```sql
SELECT closer_owner_id, count(*)
FROM close_leads
WHERE status_id = 'stat_GZca7DExvxZ2FkjKNFgWxqrlKwB1ULxA2xKrYszhVf5'
GROUP BY closer_owner_id
ORDER BY 2 DESC;
```

Catch-all jsonb access (e.g. some cf not denormalized):
```sql
SELECT close_id, custom_fields_raw->>'cf_abc123'
FROM close_leads
WHERE custom_fields_raw ? 'cf_abc123';
```
