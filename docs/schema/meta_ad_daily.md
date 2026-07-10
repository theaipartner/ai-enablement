# meta_ad_daily

Account-level (paid) daily Meta ad-spend mirror. One row per day.

> **Source changed 2026-06-30 — now the Meta Marketing API.** This table is
> fed from `level=account` of the **Meta Insights API**
> (`/act_<id>/insights`) via `ingestion/meta_ads/` → `api/meta_sync_cron.py`.
> Schema unchanged. `ctr` ← Meta `inline_link_click_ctr` (link CTR);
> `frequency` and `cost_per_unique_link_click` are now **Meta-native** (were
> derived); `ctr_source_raw='meta_api'`. **Cortana is retired as a source**
> (`ingestion/cortana/` kept unscheduled for revert). ⚠ The Meta token in use
> is a never-expiring USER token (since 2026-07-10) — still person-tied; see
> `docs/runbooks/meta_ads_ingestion.md` § warnings. Per-campaign / ad-set /
> per-ad grain live in `cortana_campaign_daily` / `cortana_adset_daily` /
> `cortana_ad_daily` (same source swap).
>
> *(History: fed by the Cortana Attribution API 2026-05-29 → 2026-06-30, and by
> a Cortana → Google-Sheet pipeline before that.)*

## Purpose

Source data for the Engine sheet's ADVERTISING section (Total Adspend, Frequency, Total Impressions, Unique Link Clicks, Cost per Impression, Cost per Unique Link Click, Click Through Rate). Per CLAUDE.md § Core Principles, the Gregory aggregation layer reads from here — not the API directly.

Cortana is the team's Meta-consolidation tool (avoids Meta-API fatigue). A 3-hour Vercel cron (`api/cortana_sync_cron.py`) pulls a trailing 4-ET-day window from Cortana's `attribution/data` endpoint and upserts the "Meta Ads" source row into this table. Cortana/Meta restate recent days (~72h) with corrected numbers; the upsert's last-write-wins on `day` is the desired behavior — the latest pull of a day is the most complete.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `day` | `date` | PK. Calendar day the metrics are attributed to. Same day re-pulled overwrites (Cortana restate). |
| `frequency` | `numeric` | Source: Sheet col "Frequency". |
| `amount_spent` | `numeric` | Source: Sheet col "Amount Spent" (USD; defensive numeric parse strips `$` and `,`). |
| `impressions` | `integer` | Source: Sheet col "Impressions". |
| `clicks_all` | `integer` | Source: Sheet col "Clicks (All)". |
| `link_clicks` | `integer` | Source: Sheet col "Link Clicks". |
| `unique_link_clicks` | `integer` | Source: Sheet col "Unique Link Clicks". |
| `cpm` | `numeric` | Source: Sheet col "CPM (Cost per 1,000 Impressions)". |
| `cost_per_unique_link_click` | `numeric` | Source: Sheet col "Cost per Unique Link Click". |
| `ctr` | `numeric` | Meta's real link CTR (Cortana `ctr`). (Was derived `link_clicks/impressions*100` in the Sheet era because the Sheet's CTR column was broken — see § CTR history.) |
| `cost_per_unique_link_click` | `numeric` | DERIVED `amount_spent / unique_link_clicks` (Cortana's `costPerUniqueInlineLinkClick` is null at row grain). |
| `frequency` | `numeric` | DERIVED `impressions / reach` (Cortana returns it null at row grain). |
| `ctr_source_raw` | `text` | Provenance marker. Now `'cortana_attribution'`. (Sheet-era rows held `1899-12-31`, the serial-0 bug.) |
| `created_at` / `updated_at` | `timestamptz` | Standard. `updated_at` reflects the last cron pull that restated this day. Trigger: `set_updated_at`. |

## CTR history

In the Sheet era (pre-2026-05-29) the Sheet's "CTR" column was broken —
Cortana exported it as a date serial, every row reading `1899-12-31`
(Sheets serial 0). The ingestion layer worked around it by deriving
`ctr = link_clicks / impressions * 100` and stashing the broken raw
value in `ctr_source_raw`.

Since the cutover to the **Cortana Attribution API**, `ctr` is Meta's
real link CTR (the API's `ctr` field), and `ctr_source_raw` is a plain
provenance marker (`'cortana_attribution'`). The derivation is gone.

## Indexes

PK on `day` covers the only meaningful access pattern (point lookup + DESC scan for last-N-days aggregates). No separate index needed.

## Idempotency

`UPSERT ON CONFLICT (day)`. Re-running the cron at any cadence is a no-op-equivalent — values refresh, no duplicates. Cortana's same-day restatement (observed: 2 rows for `2026-05-23` with slightly different spend numbers, `450.9` vs `449.33`) collapses to one mirror row holding the latest values.

## What populates it

- `ingestion.cortana.pipeline.sync_cortana_range(db, client, start, end)` — orchestrator (writes this table + `cortana_campaign_daily` + `cortana_ad_daily`).
- `api/cortana_sync_cron.py` — Vercel cron at `0 */3 * * *`, trailing 4-ET-day window. Catches Meta's ~72h restatements.
- Manual catch-up: `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://ai-enablement-sigma.vercel.app/api/cortana_sync_cron`, or `scripts/backfill_cortana.py --days N --apply --cloud`. Idempotent.

## What reads from it

Future Gregory aggregation layer for the Engine sheet's ADVERTISING + cost-per-X derived rates (Cost per opt-in, Cost per MQL, Cost per Direct Book, Cost per Triage, Cost per Booked Meeting, etc. — joins on `campaign_id` / `ad_id` from `close_leads` when computing cost-per-funnel-event metrics).

## Example queries

Last 7 days of ad spend:
```sql
SELECT day, amount_spent, impressions, ctr
FROM meta_ad_daily
WHERE day >= current_date - interval '7 days'
ORDER BY day DESC;
```

Total spend month-to-date + average CTR:
```sql
SELECT
  SUM(amount_spent) AS total_spend,
  AVG(ctr) AS avg_ctr_pct
FROM meta_ad_daily
WHERE day >= date_trunc('month', current_date);
```

Days where Cortana ingestion hasn't completed (partial row):
```sql
SELECT day FROM meta_ad_daily
WHERE impressions IS NULL OR amount_spent IS NULL
ORDER BY day DESC;
```
