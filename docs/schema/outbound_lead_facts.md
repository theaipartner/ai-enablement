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
| `close_id` | `text` | PK part. The Close lead id. A lead double-tagged across campaigns is materialized only under its **most specific** campaign (see § What populates it), so the campaigns are mutually exclusive — no `close_id` appears under two `campaign_key`s. |
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

- `refresh_outbound_facts(p_campaign_key)` (migration 0095; mutual-exclusivity added in 0103) — full
  recompute for one campaign: a `DELETE` + `INSERT` of all that campaign's leads, in one transaction
  (concurrent reads see the prior snapshot until commit). ≈15s for the `revival` campaign. **Exclusivity
  (0103):** the `leads` CTE drops any lead that also carries the Close CF of a *more specific* campaign
  (one with a higher `outbound_campaigns.sort_order`). This is why all of Jacob's leads — which the SMS
  tool also stamps with the `DC Revival Lead` CF — are counted under `jacob` only, never double-counted in
  `revival`.
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
- `outbound_funnel_by_rep(p_campaign_key, p_start, p_end)` (0104; totals added in 0105) — uses this table
  as the campaign's lead universe, then joins `close_calls` (dials/connections) and the Airtable closer
  reports (closes/cash) for the per-rep "By rep" block. Returns `{ reps, totals }`. Unlike the funnel it is
  **activity-scoped** (calls by `activity_at`, closes by form date in the window), not anchor/cohort-scoped.
