# meta_ad_daily

Mirror of the Cortana → Google-Sheet Meta ad-spend rows. One row per day.

## Purpose

Source data for the Engine sheet's ADVERTISING section (Total Adspend, Frequency, Total Impressions, Unique Link Clicks, Cost per Impression, Cost per Unique Link Click, Click Through Rate). Per CLAUDE.md § Core Principles, the Gregory aggregation layer reads from here — not the Sheet directly.

Cortana is the team's Meta-consolidation tool (avoids Meta-API fatigue). It writes one row per day into a Google Sheet (Sheet ID `1XX6MV7dqAsjlWOiwkuKe9d1uWc1qFR4Dt1CfCVfK8d4`, first tab). A 3-hour Vercel cron (`api/meta_sheet_sync_cron.py`) pulls the Sheet and upserts into this table. Cortana restates the current day with corrected numbers over the day; the upsert's last-write-wins on `day` is the desired behavior — the latest pull of a day is the most complete.

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
| `ctr` | `numeric` | **DERIVED**: `link_clicks / impressions * 100`. NULL when impressions is 0 or missing. NOT the Sheet's source CTR column — see § Why CTR is derived below. |
| `ctr_source_raw` | `text` | Forensic: the Sheet's raw CTR cell. Today always `1899-12-31` (the serial-0 bug). |
| `created_at` / `updated_at` | `timestamptz` | Standard. `updated_at` reflects the last cron pull that restated this day. Trigger: `set_updated_at`. |

## Why CTR is derived

The Sheet's "CTR (Link Click-Through Rate)" column is broken — Cortana exports it formatted as a date serial, so every row reads `1899-12-31` (Sheets serial 0 = the classic percentage-formatted-as-date bug). Mirroring it as text would poison aggregation queries; mirroring it as numeric would silently insert `0` on every row.

Two columns split the responsibility:

- `ctr` = `link_clicks / impressions * 100`, computed in `ingestion.meta.parser._derive_ctr`. This is what the aggregation layer reads.
- `ctr_source_raw` = the raw broken Sheet text, captured for forensic transparency. If Cortana ever fixes the export, future-readers can see when the fix held; if a different column starts exhibiting the same drift, the precedent is established.

Verified live on 2026-05-23: 23 days of data, every `ctr_source_raw` value is the string `1899-12-31`.

## Indexes

PK on `day` covers the only meaningful access pattern (point lookup + DESC scan for last-N-days aggregates). No separate index needed.

## Idempotency

`UPSERT ON CONFLICT (day)`. Re-running the cron at any cadence is a no-op-equivalent — values refresh, no duplicates. Cortana's same-day restatement (observed: 2 rows for `2026-05-23` with slightly different spend numbers, `450.9` vs `449.33`) collapses to one mirror row holding the latest values.

## What populates it

- `ingestion.meta.pipeline.sync_meta_ad_daily(db, access_token)` — orchestrator.
- `api/meta_sheet_sync_cron.py` — Vercel cron at `0 */3 * * *` (every 3 hours starting at the top of the hour). Catches Cortana's same-day restatements without burning needless Sheets API calls.
- Manual catch-up: re-trigger the cron manually with `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://ai-enablement-sigma.vercel.app/api/meta_sheet_sync_cron`. Idempotent.

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
