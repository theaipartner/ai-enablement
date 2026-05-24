# Runbook: Meta Ad-Spend Ingestion (Google Sheet)

Spec: `docs/specs/meta-sheet-ingestion.md`. Schema doc: `docs/schema/meta_ad_daily.md`.

This runbook covers the source-of-truth Sheet, OAuth setup, the cron cadence, idempotency, the broken-CTR-derivation rationale, failure modes, and the scope-reauth procedure (which we already executed once on 2026-05-24; documented so the next time isn't a surprise).

## What this ingestion does

Pulls the Cortana → Meta-ad-spend Google Sheet on a 3-hour Vercel cron and upserts each day's row into `meta_ad_daily`. Idempotent on `day` PK. Same code path serves both the cron AND any manual full-history backfill (the Sheet IS the history; one pull loads everything currently there).

## The source

- **Sheet ID:** `1XX6MV7dqAsjlWOiwkuKe9d1uWc1qFR4Dt1CfCVfK8d4`
- **Tab:** first tab. Discovered via `GET /v4/spreadsheets/{id}?fields=sheets.properties` per cron tick (so a future tab-rename doesn't break the cron). Today the tab is literally named `Sheet1`.
- **Columns (verified 2026-05-23, header order):**
  1. Day
  2. Frequency
  3. Amount Spent
  4. Impressions
  5. Clicks (All)
  6. Link Clicks
  7. Unique Link Clicks
  8. CPM (Cost per 1,000 Impressions)
  9. Cost per Unique Link Click
  10. CTR (Link Click-Through Rate) — **BROKEN** (see below)
- **Update cadence:** Cortana writes a new row per day and restates the current day with corrected numbers over the day. Sample observed: `2026-05-23` appeared twice in the sheet with `450.9` vs `449.33` spend — both rows landed in the source array; last-write-wins collapses to one mirror row.

## Architecture

```
   ┌─────────────────────┐
   │ Cortana (external)  │
   └──────────┬──────────┘
              │ writes daily row(s)
              ▼
   ┌─────────────────────┐
   │ Google Sheet        │
   │ (Sheet1, A:J)       │
   └──────────┬──────────┘
              │ GET /v4/spreadsheets/{id}/values/Sheet1!A:J
              │ (bearer = Drake's OAuth token, sheets.readonly scope)
              ▼
   ┌─────────────────────┐
   │ api/meta_sheet_     │  every 3 hours via Vercel Cron
   │ sync_cron.py        │  CRON_SECRET bearer auth
   └──────────┬──────────┘
              │ uses ingestion/meta/pipeline.sync_meta_ad_daily
              ▼
   ┌─────────────────────┐
   │ meta_ad_daily       │  upsert on day; idempotent
   │ (Supabase)          │
   └─────────────────────┘
```

## Auth

Reuses Drake's existing Google OAuth token (the one the Teams calendar-sync cron uses). The token now carries BOTH scopes:

- `https://www.googleapis.com/auth/calendar.readonly` (original — keeps the Teams cron working)
- `https://www.googleapis.com/auth/spreadsheets.readonly` (added 2026-05-24)

Token row lives in `oauth_tokens` keyed on `(team_member_id, provider='google')`. `shared/google_oauth.py:get_valid_access_token(drake_id)` reads + refreshes + returns the bearer.

### If the scope ever needs to widen again

The same scope-reauth procedure we executed on 2026-05-24 (commit `e54a602`):

1. **Widen the SCOPE constant** in two files, identical one-line edit each:
   - `lib/google/oauth.ts` line 26
   - `app/api/auth/google/callback/route.ts` line 21

   Google OAuth scope is space-separated; `buildAuthUrl` passes it verbatim. `access_type=offline` and `prompt=consent` are already set, so reconsent re-shows the consent screen (now listing the wider scope set) and re-mints a refresh token.

2. **Push + wait for Vercel auto-deploy** (~1-2 min).

3. **Confirm the Google Cloud project has the relevant API enabled.** Cloud Console → APIs & Services → Library → search the API → click Enable if not already. Without this, the reauth succeeds but the first API call returns 403.

4. **Open `https://ai-enablement-sigma.vercel.app/api/auth/google/connect` in a browser** (signed into the dashboard, creator-tier). Google consent screen lists all scopes. Click consent. Callback writes the refreshed token; `oauth_tokens.scope` updates.

5. **Verify with the scope check** (see § Verification below).

## Cron cadence

`0 */3 * * *` — every 3 hours starting at the top of the hour. Reasoning:

- Cortana restates the current day with corrected numbers over the day; a several-times-daily pull catches restatements without burning API quota.
- Sheets API has generous free quota (300 requests per minute per project; we're ~8 calls/day from this cron).
- Could go more aggressive (hourly) if metric freshness needs it, or less (daily) if the restatement window proves narrow. 3h is the comfortable middle.

The cron also serves as the historical backfill — the Sheet IS the history, so the first tick after deploy loads everything currently there (today's sample: 23 days, 2025-05-02 → 2026-05-23). No separate `scripts/backfill_meta.py` needed.

## Idempotency

Single upsert key: `day`. Three layers:

1. **PK on `meta_ad_daily.day`** — duplicate-day inserts collide; `ON CONFLICT (day) DO UPDATE` refreshes the row.
2. **Cortana same-day restatement** — multiple Sheet rows for the same `day` collapse to one mirror row (last-write-wins, which is desired).
3. **Cron re-runs** — a manual extra trigger after the scheduled cron just re-upserts the same data with no duplicates.

## Failure modes + debugging

| Symptom | Likely cause | Action |
|---|---|---|
| Cron audit row `processing_status='failed'` with `oauth_token_unavailable` | OAuth token revoked or refresh failed | Re-run scope check (below); if scope is intact, reconnect at `/api/auth/google/connect` |
| Cron audit row with `discover_tab_title` error / 403 | Sheets API not enabled in GCP project, OR Drake's token missing sheets scope | Confirm API enabled in Cloud Console; if scope missing, re-do § Scope reauth above |
| Cron audit row with `fetch_values` error | Sheet ID wrong, Drake lost share access, Sheet temporarily deleted | Confirm Sheet ID + Drake's access to the Sheet |
| All days have NULL `frequency` (or similar) | Cortana renamed/removed that column; parser is name-keyed so missing columns surface as warnings + leave the column NULL | Update `HEADER_TO_COLUMN` in `ingestion/meta/parser.py` if the column got renamed |
| `ctr` differs significantly from what Meta reports | Defensive — derived from our `link_clicks / impressions`; if Cortana's column meanings drifted (e.g. Link Clicks now means All Clicks), surface to team | Cross-check one day against Meta Ads Manager UI |
| `ctr_source_raw` is NOT `1899-12-31` on new rows | Cortana fixed the broken column 🎉 | Consider switching `ctr` from derived to direct, document the deprecation of the derivation in a follow-up spec |
| Cron 401s | `CRON_SECRET` mismatch | Confirm Vercel env var matches `Authorization: Bearer` header |

## Verification

### Scope check (one-off)

```python
.venv/bin/python -c "
import os
from pathlib import Path
from urllib.parse import quote
import psycopg2
for ln in Path('.env.local').read_text().splitlines():
    if '=' in ln and not ln.startswith('#'):
        k, _, v = ln.partition('=')
        os.environ[k.strip()] = v.strip().strip('\"').strip(\"'\")
pooler = Path('supabase/.temp/pooler-url').read_text().strip()
at = pooler.index('@')
dsn = f\"{pooler[:at]}:{quote(os.environ['SUPABASE_DB_PASSWORD'], safe='')}{pooler[at:]}\"
conn = psycopg2.connect(dsn, connect_timeout=15)
cur = conn.cursor()
cur.execute('''
  SELECT t.scope FROM oauth_tokens t JOIN team_members tm ON tm.id = t.team_member_id
  WHERE tm.email = 'drake@theaipartner.io' AND t.provider = 'google'
''')
print(cur.fetchone()[0])
"
```

Expected output includes `https://www.googleapis.com/auth/spreadsheets.readonly`.

### End-to-end (after deploy)

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  https://ai-enablement-sigma.vercel.app/api/meta_sheet_sync_cron
```

Expected: JSON response with `rows_parsed` = days in the Sheet, `rows_upserted` = same, `days_range` = `[oldest, newest]`. Then `SELECT count(*) FROM meta_ad_daily;` ≥ that count.

## Out of scope (future specs)

- **Per-campaign / per-adset breakdown** — Cortana's Sheet is aggregated at the daily account level. If we eventually need per-campaign cost-per-X joins against Close's `campaign_id`, we'd need either (a) Cortana to add a campaign-grouped sheet/tab or (b) a Meta API ingestion alongside (which the team deliberately avoided).
- **Multi-day backfill replay** — not needed; the Sheet IS the history. If Cortana ever truncates old data, a saved Sheet snapshot would be the source.
- **Multi-sheet / multi-tab support** — single-tab assumption. Trivial to widen `SHEET_ID` to a list + iterate, but no need today.
- **Alerting on stale data** — no row for `current_date` after a few hours implies Cortana hasn't written today's data; could surface as a Slack alert if it becomes a real ops problem.
