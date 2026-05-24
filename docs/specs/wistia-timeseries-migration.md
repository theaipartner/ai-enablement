# Wistia Timeseries Cutover — Real Daily Watch-Time + Engagement
**Slug:** wistia-timeseries-migration
**Status:** in-flight
**Target branch:** main

## ⚠️ Landscape note

Close + Meta + Wistia all live on `main`. Separate Ella worktree on `ella-worktree`. **Stay on `main`.** `git status` + `git log --oneline -10` first; re-read current file state.

## Why this exists

Verification (`docs/reports/wistia-watchtime-verify.md` — READ IT FIRST) proved the legacy `/modern/stats/medias/{id}/by_date` endpoint we currently ingest **synthesizes** `hours_watched` as `play_count × a per-media constant` — so derived avg-view-duration + engagement-rate are FLAT (fake) as daily series. The probe found the fix: **`/modern/analytics/medias/{id}/timeseries?granularity=daily`** returns GENUINE per-day variance (real `played_time` seconds, real `engagement_rate`, bot-filtered plays). This spec cuts ingestion over to it so all four Engine-sheet Wistia metrics become real daily series.

This is a surgical cutover of an already-shipped pipeline — NOT a rebuild. Reuse everything in `ingestion/wistia/`; swap the endpoint + fields.

## Authoritative source for endpoint shape

`docs/reports/wistia-watchtime-verify.md` Q4 has the verified response shape. Key facts (re-verify against live API as you build):
- **Endpoint:** `GET /modern/analytics/medias/{hashed_id}/timeseries?granularity=daily&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD`
- **Header:** `X-Wistia-API-Version: 2026-03` (same as current). Bearer auth (same). Same 600/min limit + 503 handling.
- **CRITICAL date semantics:** `start_date` inclusive, **`end_date` EXCLUSIVE** — DIFFERENT from the legacy `by_date` (inclusive both). To include today, request `end_date = today + 1 day`. Get this right or you silently drop the latest day.
- **Per-day fields:** `timestamp` (use the date portion), `plays`, `unique_plays`, `unique_loads`, `unique_visitors`, `played_time` (SECONDS, integer — NOT hours), `engagement_rate` (0–1 float, e.g. 0.1473), `play_rate`, `cta_impressions`, `cta_conversions`, `cta_conversion_rate`, `form_conversions`.
- `granularity` also supports `weekly|monthly` (we use `daily`).

## Drake's decisions (bake in)

- **Backfill 30 days only** (not the prior 90/875). `start_date = today - 30d`.
- The cutover should keep `play_count` history continuity in mind but Drake has chosen a 30-day window for the new fields — don't backfill further.

## Schema decision — ALTER vs new table

**Read `docs/schema/wistia_media_daily.md` + the 0045 migration first** to see the exact current columns. Current table (from 0045): `(hashed_id, day)` PK, `load_count`, `play_count`, `hours_watched`, lifecycle.

**Recommended: ALTER the existing table** (migration 0046) — add the real fields, keep the row keying. Don't drop `hours_watched` yet (keep as historical-audit/cross-check; mark deprecated in the column comment + schema doc). Add:
- `played_time_seconds integer` (real per-day watch-time)
- `engagement_rate numeric(6,4)` (0–1 float from the endpoint)
- `play_rate numeric(6,4)`
- `unique_plays integer`
- `unique_visitors integer`
- `unique_loads integer`
- (CTA/form fields: include `cta_conversions integer` + `form_conversions integer` if cheap — mirror-everything per principle #1 — Builder's call; skip the rest if they bloat without clear value, but lean toward including since they're free in the same payload)

Keep `plays` from the new endpoint in the existing `play_count` column? **NO — the two endpoints disagree on play counts** (timeseries is bot-filtered, ~14% lower per the verification report). Mixing them in one column corrupts the series at the cutover boundary. Decision: **store the new filtered plays in a NEW column `plays_filtered integer`** (or rename semantics clearly), and leave the legacy `play_count` as-is (legacy by_date source). The aggregation layer picks canonical. Document which is which loudly. **Confirm this approach in the report** — if Builder sees a cleaner option (e.g. the team only ever wants filtered plays, so just transition `play_count` going forward with a documented boundary date), surface it for Drake rather than deciding silently.
- **HARD STOP for Drake's SQL review before applying 0046** (gate a).

## What to build

1. **Migration 0046** — ALTER `wistia_media_daily` per above. Standard conventions. **Gate (a) SQL review before apply.** After approval, apply + dual-verify (`to_regclass` / `information_schema.columns` to confirm new columns + `supabase_migrations.schema_migrations` ledger; psycopg2 against pooler, psql not installed).
2. **`ingestion/wistia/client.py`** — add a `fetch_timeseries(hashed_id, start_date, end_date)` method hitting the new endpoint. Handle the **exclusive end_date** (add a day internally so callers pass an inclusive end and the method adds +1, OR document clearly — Builder's call, but be explicit). Keep the existing `by_date` method or remove it — see step 5.
3. **`ingestion/wistia/parser.py`** — add `parse_timeseries_entry(hashed_id, entry)` → row dict with the new fields. `played_time` stays SECONDS (no conversion). `engagement_rate` stays 0–1 float (don't ×100 — store raw, display layer formats). Map `timestamp` → `day` (date portion; watch timezone — the sample showed `05:00:00.000Z`, so the date is the UTC date of that timestamp; confirm it aligns with how by_date bucketed days so the cutover boundary doesn't double-count or gap).
4. **`ingestion/wistia/pipeline.py`** — switch the per-media daily pull from `by_date` to `timeseries`. Idempotent `UPSERT ON CONFLICT (hashed_id, day)` — same key, now writing the new columns. Re-running over the cutover boundary must cleanly overwrite (the new fields populate; `hours_watched` on already-existing rows stays as historical legacy unless re-pulled — decide + document whether the upsert nulls/keeps it).
5. **Decide the legacy `by_date` fate** — the cron will now pull timeseries. Keep the `by_date` client method for reference or remove it? Lean: keep the method (cheap, harmless) but the cron + backfill use timeseries exclusively. Document that `by_date` is no longer the daily source.
6. **Re-backfill 30 days** via `scripts/backfill_wistia.py` (update its window to 30d + point at the new path) — `--smoke` (one media end-to-end into the new columns) then `--apply` (all 80 medias, 30 days). **Smoke first, Drake confirms, then bulk** (gate). Volume tiny (80 × 30 = 2,400 rows).
7. **Update the cron** `api/wistia_sync_cron.py` — it calls the pipeline, so if the pipeline switches endpoints the cron follows automatically; confirm the rolling-window logic still passes correct (inclusive) dates and the pipeline handles the exclusive-end conversion. No cron schedule change.
8. **Tests** — update `tests/ingestion/wistia/test_parser.py` + `test_pipeline.py` for the new endpoint/fields. Add a test asserting `engagement_rate` is stored as 0–1 (not ×100) and `played_time` as seconds. Keep the hours-not-seconds guard on the legacy field if it remains. Full suite green before done.

## What success looks like

- Migration 0046 applied + dual-verified; new columns present.
- Pipeline pulls `/timeseries`, stores real per-day `played_time` + `engagement_rate` + filtered plays + uniques.
- 30-day backfill done; the three target videos (`i1173gx76b`, `nbump1crwb`, `fbgjxwe62y`) now show **day-to-day VARYING** engagement + avg-view-duration (the whole point — verify against the report's expected ranges, e.g. `i1173gx76b` engagement swinging ~9%–25%).
- Re-run idempotent (no dupes on `(hashed_id, day)`).
- Cron now feeds timeseries going forward; schedule unchanged.
- Tests updated + full suite green.
- A sanity query in the report showing varying daily engagement for a target video (proving the artifact is gone).
- Clear doc statement of the `play_count` (legacy) vs `plays_filtered` (new) distinction + that `hours_watched` is deprecated.

## Hard stops

- **Migration 0046 SQL review** before apply (gate a).
- **Bulk re-backfill** — smoke first, Drake confirms, then 30-day bulk.
- `WISTIA_API_TOKEN` missing/401 → stop. Repeated 503 → back off, partial.
- Never write to Wistia. Never echo token. No new Vercel env (token already in Vercel from the prior ship); no cron-schedule change.

## Think this through

Exclusive-end-date dropping today's data (the #1 footgun — test it). Timezone bucketing mismatch between by_date (old rows) and timeseries (new rows) causing a one-day shift at the cutover boundary — confirm the `timestamp`→`day` mapping matches the old day bucketing. Play-count discontinuity if you reuse the same column (hence the separate `plays_filtered` column). engagement_rate accidentally ×100 (store raw 0–1). The new endpoint missing data for very-low-traffic medias (tolerate empty). Re-backfill overwriting `hours_watched` with null on existing rows (decide: leave legacy values or null them — document). Surface honestly.

## Mandatory doc updates

- `docs/schema/wistia_media_daily.md` — new columns + the `play_count` (legacy/raw) vs `plays_filtered` (new/bot-filtered) distinction + `hours_watched` DEPRECATED note + `engagement_rate` is 0–1 + `played_time_seconds` is seconds.
- `docs/runbooks/wistia_ingestion.md` — endpoint change (by_date → timeseries), exclusive-end-date gotcha, the two-play-count-columns note, 30-day backfill window, the deprecation of the daily-engagement-from-hours_watched approach.
- `docs/state.md` — update the Wistia entry (migration 0046, cutover to timeseries, real daily engagement now available).
- Report at `docs/reports/wistia-timeseries-migration.md`.
- Note in the report that `docs/reports/wistia-discovery.md`'s "per-day engagement derivable" claim is superseded (don't edit that historical report).
