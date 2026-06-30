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
| `match_field_name` | `text` | **New-model campaigns** (migration 0115): the custom-field NAME to match. Resolved to a Close cf id (via `close_custom_field_definitions`) AND a GHL field id (via `ghl_custom_field_definitions`) — a lead in **either** Close or GHL carrying that field = `match_value` belongs. `NULL` ⇒ a legacy `close_cf_id` campaign. |
| `match_value` | `text` | New-model: the **exact** value the field must hold. |
| `close_cf_id` | `text` | **Legacy campaigns only** (nullable since 0115). The Close custom-field id that flags membership (presence-based). Used by Revival/Jacob; `NULL` for new-model campaigns. |
| `floor_at` | `timestamptz` | Campaign start. Per-lead anchor = `greatest(date_created, floor_at)`; only activity at/after the anchor counts. |
| `is_active` | `boolean` | Not null, default `true`. The switcher lists active campaigns. |
| `sort_order` | `int` | Not null, default `0`. Two roles: (1) switcher ordering, and (2) **campaign precedence** for mutual exclusivity — a lead tagged by more than one campaign is counted only under the one with the **highest** `sort_order` (the most specific). See `refresh_outbound_facts` (migration 0103) and `outbound_lead_facts.md`. |

## Seed

Two rows today:

| key | label | close_cf_id | floor_at | sort_order | migration |
|---|---|---|---|---|---|
| `revival` | DC Revival | `cf_QivXkWBvr34UIDkUBKXNCQo6woarc62wEbIacWWbN7P` | `2026-06-03T04:00:00Z` | 0 | 0093 |
| `jacob` | Jacob | `cf_m0ooiwIyM3qqKXpPPuWolmLWJxoS5EbHfsOW5Om46G1` | `2026-06-20T04:00:00Z` | 1 | 0099 |

`jacob` (ECJ Reactivation) has `sort_order > revival`, so the leads it shares with revival (the SMS tool
stamps every Jacob lead with the `DC Revival Lead` CF too) are counted under `jacob` only. Jacob is also
**roster-based**: `outbound_campaign_roster` holds the ECJ CSV (email/phone), and `shared/outbound_campaign_tag.py`
(hooked in `api/close_events.py`) auto-tags matching leads with the Jacob CF in Close.

## What reads it

- `refresh_outbound_facts(p_campaign_key)` (0095/0103) — looks up `close_cf_id`, `floor_at`, **and**
  `sort_order` (to exclude leads owned by a higher-precedence campaign), then materializes
  `outbound_lead_facts`.
- `outbound_funnel(p_campaign_key, …)` (0093/0094; date range 0102) and
  `outbound_funnel_by_rep(p_campaign_key, …)` (0104/0105) — read the facts for the funnel and the per-rep
  block. Surfaced by `lib/db/funnel-revival.ts` → the Outbound page; the switcher lists `is_active` rows.

## Two campaign models

- **Legacy** (`match_field_name IS NULL`): Revival + Jacob. Membership = `close_cf_id`
  presence in `close_leads`, with **mutual exclusivity** (a lead tagged by a higher
  `sort_order` legacy campaign is dropped — migration 0103). These two are finished and
  **read-only** in the adder.
- **New-model** (`match_field_name` + `match_value` set, migration 0115): membership = a lead
  carrying that exact custom-field value in **Close OR GHL** (the name resolves to a Close cf
  id and/or a GHL field id). **No exclusivity** — campaigns are independent, so a lead matching
  two campaigns is counted in **both** (by design). The GHL arm of `refresh_outbound_facts`
  sources responded/called/connected from `ghl_messages` and closes from
  `airtable_full_closer_report` joined on `lead_id = ghl_contacts.id`.

## Adding a campaign

Use the admin page **`/sales-dashboard/outbound-campaigns`** (no SQL, no deploy): name +
custom-field name + exact value + start date. On save it inserts the row and refreshes the
facts (via `api/outbound_campaign_refresh.py`), so it appears in the Outbound switcher with a
populated funnel immediately. **Re-tag** re-runs the match after a field/value change. The
`*/15` `outbound_facts_refresh_cron` keeps every active campaign fresh. Aggregation
(connected = ≥90s call, anchor, monotonic backfill, $300/plan cash) is campaign-agnostic.
