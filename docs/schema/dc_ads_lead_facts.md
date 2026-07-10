# dc_ads_lead_facts

Per-lead funnel facts for the **DC ads funnel page**
(`/sales-dashboard/dc-ads`) — Digital College Meta-form opt-ins mirrored into
Close, with their downstream stage flags. Sibling of `outbound_lead_facts`
(same stage semantics, different membership + anchor). Migrations 0123–0125.

## Purpose

The page's funnel/speed/time-of-day/by-rep numbers must not aggregate
thousands of activity rows per page load. `refresh_dc_ads_facts()` rebuilds
this small table (delete + insert, one transaction) and the page reads it via
`dc_ads_funnel(p_start, p_end)` / `dc_ads_funnel_by_rep(p_start, p_end)` —
sub-second.

**Membership:** `close_leads` where `funnel_name='Digital College'` AND
`campaign_id in (select campaign_id from meta_leadgen_campaigns)` and not
excluded. **Anchor:** `greatest(date_created, latest_opt_in_date)` — the
Meta→Close bridge matches returning phone numbers to their existing Close
lead and re-stamps `latest_opt_in_date`, so a re-opted April lead anchors at
its July form submit, not its original creation.

**Deliberate differences from outbound** (inbound ad opt-ins, not cold
outbound): `first_dial` = first outbound call after the opt-in (no
"replied first" precondition); speed-to-dial = opt-in → dial; no "responded"
funnel stage (`has_inbound` kept for reference); `optin_bucket` replaces
`reply_bucket`.

## Columns

Same stage set as `outbound_lead_facts` (see that machinery in migrations
0093–0119): `close_id` (PK), `anchor`, `first_reply`, `has_inbound`,
`any_call`, `call90`, `first_dial`, `booked`/`booked_dc`/`booked_ht` (setter
triage), `showed`/`closed` (closer report), `plan_units` +
`base44_monthly/yearly` + `wix_monthly/yearly` (cash = plan_units × $300),
`marked_no_plan`, `optin_bucket`/`dial_bucket`/`conn_bucket` (2-hour ET
buckets 0–11), `updated_at`.

## Populated by / read by

- **Writes:** `refresh_dc_ads_facts()` called by
  `api/outbound_facts_refresh_cron.py` (15-min tick, after Close/Airtable
  syncs) and by `ingestion/meta_ads/leads_pipeline.py` after each lead sync.
- **Reads:** `dc_ads_funnel()` / `dc_ads_funnel_by_rep()` RPCs behind
  `lib/db/dc-ads.ts`.

## Example queries

```sql
select dc_ads_funnel('2026-07-08T04:00:00Z', '2026-07-15T04:00:00Z');
select dc_ads_funnel_by_rep('2026-07-08T04:00:00Z', '2026-07-15T04:00:00Z');
```

Runbook: `docs/runbooks/meta_leads_ingestion.md`.
