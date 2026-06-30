# Runbook: Cortana Attribution Ingestion (Meta ad data)

Schema docs: `docs/schema/cortana_ad_daily.md`, `docs/schema/cortana_campaign_daily.md`, `docs/schema/meta_ad_daily.md`.
Migration: `supabase/migrations/0057_cortana_ad_campaign_daily.sql`.

## What this ingestion does

Pulls the team's Meta ad data from **Cortana's Attribution API** (not
the Meta API directly — Cortana is the team's Meta-consolidation tool)
and mirrors it into three tables. Replaces the prior Cortana →
Google-Sheet → `meta_ad_daily` pipeline (`ingestion/meta/`,
`api/meta_sheet_sync_cron.py`), which was broken (CTR exported as a
date serial `1899-12-31`) and account-level only.

| Grain | groupBy | Table | Notes |
|---|---|---|---|
| account (paid) | `source` → "Meta Ads" row | `meta_ad_daily` | unchanged schema; feeds the live /sales-dashboard ADVERTISING section. CTR + frequency are now REAL Meta numbers. |
| campaign | `campaign` | `cortana_campaign_daily` | + budget/status/objective |
| ad | `ad` | `cortana_ad_daily` | per-ad lead/close attribution + creative performance |

Per CLAUDE.md § Core Principles: Cortana is a replaceable adapter in
its own module (`ingestion/cortana/`); the dashboard reads the mirror
tables, never the API.

## The API

- **Base:** `https://app.usecortana.ai/api/v1`
- **Auth:** `Authorization: Bearer sk-ak-...` (API key generated in
  Cortana → Settings → API Keys).
- **Endpoint:** `GET /businesses/{businessId}/attribution/data`
- **Key params:** `startDate`, `endDate` (ISO `...Z`, **strict** — see
  landmine 2), `groupBy` (`source|campaign|medium|ad`),
  `attributionModel` (`last_click` default; also `first_click`,
  `paid_priority`, `scientific`), `timezone`, `currency`.
- **Response:** `{ data: { data: [...rows], dailySummary: [], globalTotals: {} }, filters: {} }`.
  Rows aggregate over the **whole** requested range — `dailySummary`
  is always empty for this account, so daily grain = one single-ET-day
  window per call.

### Credentials (env vars)

- Local: `CORTANA_API_KEY` + `CORTANA_BUSINESS_ID` in `.env.local`.
- Production: set the same two vars in **Vercel** Production env vars.
  Business ID `b97a1874-7be6-41d4-bba1-8df9ffd69e18` is not a secret;
  the API key is.

## Four landmines (all hit + solved during discovery 2026-05-29)

1. **Cloudflare blocks `Python-urllib`** → HTTP 403, body
   `error code: 1010` (banned browser signature). The client sends a
   browser `User-Agent`; that passes. Not an auth problem.
2. **Datetimes must be `...Z`, no microseconds.** The API validates
   with a strict Zod `.datetime()` that rejects Python's `+00:00`
   offset. Use `CORTANA_DT_FORMAT` (`%Y-%m-%dT%H:%M:%SZ`).
3. **Cloud PostgREST HTTP/2 drops on repeated local→cloud writes**
   (`httpx.RemoteProtocolError: ConnectionTerminated`, ~3 streams in).
   Same issue MARCH_ANALYSIS_HANDOFF flagged for reads. The **cron**
   (Vercel→cloud) uses the supabase client and is fine; the **local
   backfill** writes via **psycopg2** (`--cloud` flag) to bypass
   PostgREST entirely.
4. **Day attribution runs one ET day ahead of the window (fixed
   2026-05-29 eve).** A `[D 00:00, D+1 00:00)` ET window comes back
   carrying day **D+1**'s spend, not D's — so the first cutover stored
   every row one day early (today blank, yesterday holding the
   day-before's number). `et_day_window(day)` now sends the window that
   **ends** at `day` 00:00 ET (starts the prior ET midnight); verified
   against ground truth (`[05-27, 05-28) ET` → 05-28's $745.75). Guarded
   by `tests/ingestion/cortana/test_pipeline.py`. If daily numbers ever
   look shifted again, check this window first.

## Field map (read off live responses — the OpenAPI types rows as opaque)

`ingestion/cortana/parser.py` is the source of truth. Highlights:

| Our column | Cortana field | |
|---|---|---|
| `meta_ad_daily.amount_spent` | `spent` | |
| `meta_ad_daily.impressions` | `impressions` | |
| `meta_ad_daily.link_clicks` | `inlineLinkClicks` | |
| `meta_ad_daily.unique_link_clicks` | `uniqueInlineLinkClicks` | |
| `meta_ad_daily.cpm` | `cpm` | |
| `meta_ad_daily.ctr` | `ctr` | **real** now |
| `meta_ad_daily.frequency` | — | DERIVED `impressions/reach` |
| `meta_ad_daily.cost_per_unique_link_click` | — | DERIVED `spent/uniqueInlineLinkClicks` |
| `cortana_*.entity_key` | `dimensionKey` (`name\|\|\|metaId`) | PK component |
| `cortana_*.platform_entity_id` | `platformEntityId` | Meta id (future join to Close) |
| `cortana_*.conversions` | `conversions` | per-event-type blob (leads/bookings/closes per ad) |
| `cortana_*.raw` | (whole row) | full catch-all jsonb |

**Conversion event types** seen in `conversions` / `globalTotals.uniqueByEventType`:
`lead`, `qualified_lead`, `non_qualified_leads`, `non_booking_opts_in`,
`first_message_response`, `setter_connected_call`, `total_setter_triages`,
`total_closer_triages`, `overall_triages`, `appointment_booked`,
`intro_call_booked`, `direct_closer_bookings`, `live_calls`, `no_show`,
`downsell`, `purchase`, `all_payments`. These are **attribution counts**
(which ad/campaign drove the outcome) — net-new data, NOT a duplicate of
the raw lead/booking/close records in Typeform/Calendly/Close.

> Video metrics (`video_plays`, `thru_plays`, `hook_rate`, …) are the
> **Meta in-feed ad-creative** video stats, NOT the landing-page VSL
> (that's Wistia, `i1173gx76b`/`nbump1crwb`). Image ads carry NULLs.

## Cron

`api/cortana_sync_cron.py`, Vercel `0 */3 * * *`. Re-pulls a trailing
**4-ET-day** window each tick and upserts — absorbs Meta's ~72h
spend/conversion restatements (last-write-wins on the PKs). Audit row
to `webhook_deliveries` with `source='cortana_sync'`.

Manual trigger:
```bash
curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \
  https://ai-enablement-sigma.vercel.app/api/cortana_sync_cron
```

## Backfill

```bash
# smoke: one complete day end-to-end, NO writes (run first)
.venv/bin/python scripts/backfill_cortana.py --smoke

# seed cloud (production) — psycopg2 path, last 3 days
.venv/bin/python scripts/backfill_cortana.py --days 3 --apply --cloud
```

Data horizon: Cortana attribution data begins **~2026-02-28**. March/May
(the data-guide validation cohorts) and everything June-forward are
covered; pre-Feb-2026 is not retrievable from Cortana.

## Cutover from the Sheet pipeline

The Sheet cron (`meta_sheet_sync_cron`) and this cron both write
`meta_ad_daily` — do **not** run both. Cutover order:

1. Add `CORTANA_API_KEY` + `CORTANA_BUSINESS_ID` in Vercel Production env vars.
2. Push the commit that swaps the cron in `vercel.json`
   (`meta_sheet_sync_cron` → `cortana_sync_cron`).
3. Verify the first `cortana_sync_cron` tick (audit row + a fresh
   `meta_ad_daily` row with `ctr_source_raw='cortana_attribution'`).

The Sheet code (`ingestion/meta/`, `api/meta_sheet_sync_cron.py`) stays
in the repo unscheduled for instant revert.

## Known gaps

- **Local DB** doesn't have the 0057 tables — the local Supabase is a
  divergent offline-dev mirror stuck at migration 0011 (pre-existing,
  unrelated). Cloud (production) is the system of record and is current.
- **Dashboard wiring** for the new tables (per-ad/per-campaign views) is
  future work; this ingestion just lands the data.
