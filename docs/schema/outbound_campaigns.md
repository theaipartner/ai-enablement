# outbound_campaigns

Registry of outbound (SMS-tagged) campaigns that the Outbound funnel can render. One row per campaign.
Lets the `/sales-dashboard/outbound` page (and a future "tag type" dropdown) pick which lead set to
aggregate, without hardcoding a single Close custom field.

Added in migration `0093_outbound_funnel_fn.sql` alongside the `outbound_funnel()` function.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `key` | `text` | **PK.** Stable slug passed to `outbound_funnel(p_campaign_key)` (e.g. `'revival'`). |
| `label` | `text` | Human display name (e.g. `'DC Revival'`) — for the dropdown. |
| `close_cf_id` | `text` | The Close custom-field id that flags a lead as part of this campaign. A lead is in-campaign when `close_leads.custom_fields_raw ->> close_cf_id` is non-empty. |
| `floor_at` | `timestamptz` | Campaign start. Per-lead anchor = `greatest(date_created, floor_at)`; only activity at/after the anchor counts. |
| `is_active` | `boolean` | Not null, default `true`. The dropdown lists active campaigns. |
| `sort_order` | `int` | Not null, default `0`. Dropdown ordering. |

## Seed

One row today (migration 0093):

| key | label | close_cf_id | floor_at |
|---|---|---|---|
| `revival` | DC Revival | `cf_QivXkWBvr34UIDkUBKXNCQo6woarc62wEbIacWWbN7P` | `2026-06-03T04:00:00Z` |

## What reads it

- `outbound_funnel(p_campaign_key)` (migrations 0093/0094) — looks up `close_cf_id` + `floor_at`, then
  aggregates the funnel / called / time-of-day for that campaign. Read by `lib/db/funnel-revival.ts`
  (`getOutboundFunnel`) → the Outbound page.

## Adding a campaign

Insert a row (key, label, the Close custom-field id, the campaign start). The Outbound page can then
render it via `outbound_funnel('<key>')`; wiring the dropdown to list `is_active` rows is the only UI
work. No function change — the aggregation logic (connected = ≥90s call, anchor, monotonic backfill,
$300/plan cash) is campaign-agnostic.
