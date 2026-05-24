# Meta Ad Spend Ingestion (Google Sheet)
**Slug:** meta-sheet-ingestion
**Status:** in-flight
**Target branch:** main

## ⚠️ Landscape note

Close live ingestion went live earlier today (`close-live-webhooks` — receiver deployed + Close subscription registered + verified end-to-end). There's also a separate Ella worktree on `ella-worktree`. **Stay on `main`, this is a new independent source.** `git status` + `git log --oneline -10` before starting; the tree moved a lot today.

## Why this exists

The Engine sheet's ADVERTISING section needs Meta ad data (spend, impressions, clicks, CTR, CPM, frequency). Per Drake + the team's setup, Meta data is NOT pulled from Meta's API directly (deliberate — the team uses a tool called Cortana to consolidate Meta data and avoid API fatigue). Instead, **Cortana exports daily ad metrics into a Google Sheet**, and that Sheet is our ingestion source. This spec ingests that Sheet on a daily cadence into a new mirror table.

This is the second sales-side data source (after Close). Same principle as Close: **mirror the raw data into Supabase, compute Engine-sheet metrics on top.**

## The source — known shape (Drake provided real data)

- **Sheet ID:** `1XX6MV7dqAsjlWOiwkuKe9d1uWc1qFR4Dt1CfCVfK8d4`
- **Tab:** first sheet, `gid=0`.
- **One row per day.** Columns (exact headers):
  `Day, Frequency, Amount Spent, Impressions, Clicks (All), Link Clicks, Unique Link Clicks, CPM (Cost per 1,000 Impressions), Cost per Unique Link Click, CTR (Link Click-Through Rate)`
- Sample rows:
  - `2026-05-23, 1.16, 450.9, 6088, 183, 105, 102, 74.06, 4.42, <broken>`
  - `2026-05-02, 1.26, 1632.6, 27328, 781, 471, 425, 59.74, 3.84, <broken>`
- Updated daily (Cortana writes a new row per day; may also restate the current day).

**Two data-quality facts already observed — handle these, don't trust the raw values blindly:**
1. **The CTR column is broken** — it renders as a serial-date string (`1899-12-31`, `1900-01-01`) instead of a percentage. This is the classic Sheets "percentage formatted as date" bug (serial 0 = 1899-12-31, serial 1 = 1900-01-01). **Do NOT ingest the CTR column's literal value.** Instead **compute CTR ourselves** = `Link Clicks / Impressions * 100`, stored as a numeric. Note in the schema doc that the source CTR column is unreliable and we derive it. (Optionally also store the raw broken value in a `ctr_source_raw text` column for forensic transparency — Builder's call, low priority.)
2. **Duplicate `Day` rows** — `2026-05-23` appeared twice in the sample with slightly different numbers (450.9 vs 449.33 spend). The sheet appears to restate the current/recent day. **Upsert keyed on `day` (date) with last-write-wins** so a restated day overwrites cleanly rather than duplicating. Confirm this is the right behavior in the report (it almost certainly is — the latest pull of a given day is the most complete).

## Auth — reuse the existing Google OAuth (with a scope gate)

The Teams calendar-sync cron (`api/teams_calendar_sync_cron.py`) already authenticates to Google using Drake's stored OAuth token via `shared/google_oauth.py::get_valid_access_token(team_member_id)`. **Reuse this exact path** — do NOT stand up a service account or new credential.

**BUT:** the existing token was authorized for the Calendar scope (`_CALENDAR_SCOPE = .../auth/calendar.readonly` in `shared/google_oauth.py`). Reading a Sheet needs the Sheets scope (`https://www.googleapis.com/auth/spreadsheets.readonly`) or a Drive read scope. The token row in `oauth_tokens` stores a `scope` column (see `shared/google_oauth.py` — it's persisted + refreshed). **First thing Builder does after acclimatization: read the stored token's `scope` for Drake's `team_member_id` and check whether it includes a Sheets-capable scope.**

- **If the scope covers Sheets** → proceed; the ingestion calls `get_valid_access_token` and hits the Sheets API, no reauth needed.
- **If it does NOT** → **HARD STOP and tell Drake.** Drake will re-authorize the Google connection with the added Sheets scope (one-time consent; re-mints the token with both scopes). Builder should state exactly which scope string to add and where the connect flow lives (the Next.js connect/callback routes that wrote the original token — `lib/google/oauth.ts` per the google_oauth.py docstring). Do NOT attempt to add scopes programmatically or work around it; this is Drake's one-time action. Drake has said: "tell code to try if the oauth covers the sheets scope, if not I will give it."

Note: if the Google Cloud project's OAuth consent screen doesn't have the Sheets API enabled / scope registered, the reauth alone won't fix it — flag that the Sheets API may need enabling in the Google Cloud console too. Surface this as part of the hard-stop instructions if scope is missing.

## How to read the sheet

Google Sheets API v4 values endpoint:
`GET https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values/{range}` with `Authorization: Bearer <token>`. Range like `Sheet1!A:J` (confirm the actual tab name — it may not be literally "Sheet1"; you can `GET /v4/spreadsheets/{id}?fields=sheets.properties.title` to discover the tab title first). Returns a `values` array of row arrays. Parse the header row to map columns by NAME (not position — column order could change if Cortana's export changes), then each subsequent row → a `meta_ad_daily` record. Use `urllib` (no new SDK dep), matching the calendar cron's posture.

## What to build

1. **Migration 0044** — `meta_ad_daily` table. Suggested columns (validate/adjust): `day date PRIMARY KEY` (or unique), `frequency numeric`, `amount_spent numeric`, `impressions integer`, `clicks_all integer`, `link_clicks integer`, `unique_link_clicks integer`, `cpm numeric`, `cost_per_unique_link_click numeric`, `ctr numeric` (DERIVED = link_clicks/impressions*100, NOT the broken source column), optionally `ctr_source_raw text`, plus standard `created_at`/`updated_at` + `set_updated_at` trigger. Follow the 0043 / recent-migration conventions. **HARD STOP for Drake's SQL review before apply** (gate (a)). It's a single simple table — review should be quick. After approval, apply + dual-verify per `docs/runbooks/apply_migrations.md` (psql not installed → psycopg2 against the pooler URL).
2. **`ingestion/meta/` module** (mirror the `ingestion/close/` + `ingestion/fathom/` shape) — a thin Sheets client + parser (row-array → typed record, header-name-keyed, CTR derived) + pipeline (idempotent upsert on `day`). Numeric parsing must be defensive (strip commas/currency if present; the sample looked clean but Cortana exports can drift).
3. **`api/meta_sheet_sync_cron.py`** — daily Vercel cron. Mirror `api/teams_calendar_sync_cron.py` exactly: `CRON_SECRET` bearer auth, resolve Drake's `team_member_id`, `get_valid_access_token`, fetch sheet, upsert, audit to `webhook_deliveries` with `source='meta_sheet_sync'`, fail-soft, summary row. Daily cadence (the sheet updates daily) — propose the cron schedule in `vercel.json` (e.g. once every few hours to catch the daily restate + same-day corrections, or once daily — Builder recommends; a few-times-daily poll is cheap and catches restatements).
4. **A manual backfill path** — the sheet already holds history (the sample showed all of May). A simple `--apply` run of the same pipeline against the full sheet range backfills it (the sheet IS the history; no separate API needed). One idempotent pull loads everything. Confirm re-running is a no-op (upsert on `day`).

## Gates / hard stops

- **Sheets scope check** → if the existing OAuth token lacks Sheets scope, HARD STOP + tell Drake exactly what to add. Don't work around it.
- **Migration 0044 SQL review** before apply (gate a).
- **`vercel.json` cron addition + any env var** → the cron reuses existing env vars (`CRON_SECRET`, `GOOGLE_OAUTH_CLIENT_ID/SECRET`, `SUPABASE_*`) so likely NO new env var needed — confirm. Adding the cron schedule to `vercel.json` is a deploy-affecting change; flag it (gate d-adjacent) but it's low-risk since it reuses the established cron pattern. The SHEET_ID could be a constant in the code or an env var — Builder's call; if env var, flag it.
- Read-only against Google (we only GET the sheet). Never write to the sheet. Never echo tokens.

## What success looks like

- Scope check done + reported (pass, or hard-stop with exact reauth instructions).
- Migration 0044 applied + dual-verified (after Drake's review).
- `ingestion/meta/` reads the sheet, derives CTR, upserts idempotently on `day`.
- `api/meta_sheet_sync_cron.py` runs on a daily-ish Vercel cron, reusing the calendar cron's auth pattern.
- Backfill: one pull loads all history currently in the sheet; row count + date range reported (e.g. "loaded N days, 2026-05-02 → 2026-05-23").
- Re-run idempotency confirmed (upsert on day, no dupes; restated days overwrite).
- Sanity check: a couple of computed CTR values shown vs the link_clicks/impressions math, confirming the derive works and the broken source column is correctly ignored.

## Think this through — what could go wrong

Tab name isn't literally "Sheet1" (discover it). Column order or header text drifts in a future Cortana export (header-name keying mitigates; log + skip unmapped columns rather than crash). The broken CTR column — already handled by deriving, but watch for OTHER columns silently breaking the same way (CPM or cost-per could format oddly too; defensive numeric parse + log anomalies). Timezone on `Day` (is it the ad account's tz? probably fine as a plain date, but note it). The scope check passing but the Sheets API not being enabled on the GCP project (different failure — surface clearly). Duplicate-day restatement (handled by upsert, confirm). Empty/partial current-day row if Cortana hasn't finished writing (tolerate — upsert will correct on next poll). Surface all honestly.

## Mandatory doc updates

- `docs/schema/meta_ad_daily.md` — the new table + the CTR-is-derived note + the broken-source-column caveat.
- `docs/runbooks/meta_sheet_ingestion.md` — source sheet, auth (reused Google OAuth + scope requirement), cron cadence, backfill, idempotency, failure modes, the scope-reauth procedure if it ever needs redoing.
- `.env.example` — only if a new var is added (SHEET_ID if env-var'd); otherwise note it reuses existing Google + cron vars.
- `docs/state.md` — add the Meta sheet ingestion entry once shipped (migration 0044, new table, cron, backfill row count).
- `CLAUDE.md` § Folder Structure — add `ingestion/meta/` line.
- Report at `docs/reports/meta-sheet-ingestion.md`.
