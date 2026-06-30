# outbound_lead_facts

Materialized per-lead facts for the **Outbound funnel** — one row per `(campaign_key, close_id)`. The
lead_cycles equivalent for the outbound/revival side: it precomputes each lead's funnel signals so the
dashboard reads a small table instead of scanning the raw `close_sms` / `close_calls` / Airtable tables
on every page load.

Added in migration `0095_outbound_lead_facts.sql`.

## Why it exists

The original `outbound_funnel()` (0093/0094) aggregated the raw signals *live* — 66k SMS + 20k calls +
a JSONB scan over 13k leads — on every request, ~23s, past the 8s PostgREST timeout, so the page
crashed. This table moves that work off the page load (see § What populates it); reads become
sub-second and stay that way as outbound grows.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `campaign_key` | `text` | PK part. FK-ish to `outbound_campaigns.key` (e.g. `'revival'`). |
| `close_id` | `text` | PK part. The lead's **native id** — a Close lead id for Close-sourced leads, or a **GHL contact id** for GHL-sourced ones (new-model campaigns, migration 0115). Named `close_id` for history; treat it as an opaque key. **Exclusivity depends on the campaign model:** legacy pools (Revival/Jacob) stay mutually exclusive (0103), so a Close id appears under only one legacy campaign; **new-model campaigns are independent** (no exclusivity), so the *same* lead CAN appear under two `campaign_key`s by design. |
| `anchor` | `timestamptz` | `greatest(date_created, campaign floor)` — only activity at/after this counts. |
| `first_reply` | `timestamptz` | First inbound SMS since anchor (null = no reply). |
| `has_inbound` | `boolean` | Responded (an inbound SMS since anchor). |
| `any_call` | `boolean` | ≥1 call since anchor (Called). |
| `call90` | `boolean` | A ≥90s call (either direction) = **Connected**. |
| `first_dial` | `timestamptz` | First outbound call after `first_reply` (the speed-to-dial start). |
| `booked` / `booked_dc` / `booked_ht` | `boolean` | Triage booking status (DC / HT). |
| `showed` | `boolean` | A closer form present (showed). |
| `closed` | `boolean` | A DC plan was sold (`dc_plans` filled). |
| `plan_units` | `int` | Total Base44/Wix × Mo/Yr plan units across the lead's closing forms (cash = units × $300). |
| `base44_monthly` / `base44_yearly` / `wix_monthly` / `wix_yearly` | `int` | Plan-unit breakdown. |
| `marked_no_plan` | `int` | "DC Closed" forms with no plan (a show, not a close). |
| `reply_bucket` / `dial_bucket` / `conn_bucket` | `smallint` | 2-hour ET bucket (0–11) of first_reply / first_dial / connecting call — for the time-of-day chart. |
| `updated_at` | `timestamptz` | Last refresh. |

The funnel stages (responded → called → connected → booked → showed → closed) are NOT stored — they're the
monotonic backfill computed at read time in `outbound_funnel()` from the boolean flags above (cheap over a
small table).

## What populates it

- `refresh_outbound_facts(p_campaign_key)` (migration 0095; exclusivity 0103; **re-sourced for new-model
  + GHL in 0115**) — full recompute for one campaign: a `DELETE` + `INSERT` of all that campaign's leads,
  in one transaction (concurrent reads see the prior snapshot until commit). The function **branches on
  the campaign model:**
  - **Legacy** (Revival/Jacob — `match_field_name IS NULL`): Close-only via `close_cf_id`, with the **0103
    exclusivity** — the `leads` CTE drops any lead that also carries the CF of a higher-`sort_order`
    campaign. This is why Jacob's leads (the SMS tool also stamps them `DC Revival Lead`) count under
    `jacob` only, never double-counted in `revival`. Unchanged byte-for-byte by 0115.
  - **New-model** (`match_field_name` + `match_value` set): matches a custom-field **name=value** across
    **Close** (`close_leads`, name→cf via `close_custom_field_definitions`) **and GHL** (`ghl_contacts` +
    `ghl_messages`, name→id via `ghl_custom_field_definitions`; closes from Airtable joined on
    `lead_id = ghl_contacts.id`). **No exclusivity** — campaigns are independent and overlap is allowed.
- `api/outbound_facts_refresh_cron.py` — Vercel cron (`*/15 * * * *`) that calls
  `refresh_outbound_facts()` for every active `outbound_campaigns` row, via a psycopg2 pooler connection
  (the 15s refresh exceeds PostgREST's 8s timeout). Audits to `webhook_deliveries`
  (source `outbound_facts_refresh`).

## What reads it

- `outbound_funnel(p_campaign_key, p_start default null, p_end default null)` (0095; date range added in
  0102) — aggregates this table into `{funnel, called, timeOfDay, activeFrom, activeTo}`. With `p_start`/
  `p_end` it filters by `anchor` (a lead's campaign-entry date) — the **cohort** scope. Read by
  `lib/db/funnel-revival.ts` (`getOutboundFunnel`) → the `/sales-dashboard/outbound` page, which always
  passes a range (default `[campaign start → today]`).
- `outbound_funnel_by_rep(p_campaign_key, p_start, p_end)` (0104; totals 0105; **NULL = all-campaigns**
  0108; **GHL call arm** 0115; shape regression fixed 0116→**0117**) — uses this table as the campaign's
  lead universe (`p_campaign_key IS NULL` = every campaign, the "All" view), then joins **`close_calls`
  AND `ghl_messages`** for dials/connections (rep via `close_user_id` / `ghl_user_id`) and the Airtable
  closer reports for closes/cash. Returns `{ reps, totals }` (a bare array silently empties the per-rep
  table — getOutboundByRep reads `d.reps`/`d.totals`). **Activity-scoped** (calls by activity time, closes
  by form date in the window), not anchor/cohort-scoped.
