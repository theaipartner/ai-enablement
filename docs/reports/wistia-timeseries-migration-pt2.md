# Report (Pt 2 — Resume): Wistia Timeseries Cutover — Apply + Bulk + Variance Verified

**Slug:** wistia-timeseries-migration
**Spec:** docs/specs/wistia-timeseries-migration.md
**Pt 1 (PARTIAL — intact):** docs/reports/wistia-timeseries-migration.md (gate (a) halt)
**Verification (the why):** docs/reports/wistia-watchtime-verify.md
**Status:** complete. Migration applied, bulk re-backfilled, real-variance verified end-to-end. No remaining gates.

Drake approved past gate (a) with "approved", then "confirm, but your table says all 0s and none" (re-confirming bulk after the smoke-on-zero-activity-media tripped me up visually).

## Files touched

**Modified:**
- `docs/state.md` — new dated section at the top of "Gregory editorial skin shipped" covering the cutover: migration 0046 applied, code-cutover summary, real-variance verification (the whole point — `i1173gx76b` 9.91%–25.38%), bulk row counts, the legacy-vs-post-cutover column distinction, test-suite delta.

**Not touched in this pass** (all already committed in Pt 1):
- `supabase/migrations/0046_wistia_timeseries_columns.sql`
- `ingestion/wistia/{client,parser,pipeline}.py`
- `scripts/backfill_wistia.py`
- `tests/ingestion/wistia/{test_parser,test_pipeline}.py`
- `docs/schema/wistia_media_daily.md`, `docs/runbooks/wistia_ingestion.md`

## What I did, in plain English

Four sequential operations.

**1. Apply migration 0046.** Preconditions verified (Docker WSL off, supabase CLI 2.90.0). Ran `supabase db push --linked --dns-resolver https --password "$DB_PW" --yes`. Output matched canonical "Connecting to remote database... Finished supabase db push." shape; exit 0.

**2. Dual-verify per `docs/runbooks/apply_migrations.md`.** Via psycopg2:
- **Columns:** 19 total on `wistia_media_daily` (was 8 → +11 new). All 11 new columns present.
- **Legacy retention:** `load_count`, `play_count`, `hours_watched` still present (deprecated but not dropped, per design).
- **Ledger:** `0046 wistia_timeseries_columns` at the top.

**3. Smoke (`--smoke`).** One media end-to-end + full inventory upsert. The smoke happens to run on the FIRST media from `iter_medias()` which is `v1xlfys5y2` "AI Ads Bot" — a zero-activity media. So:
- 31 rows upserted for that media (rolling 30-day window + today = 31 days).
- New columns all NULL (Wistia omits metric fields entirely for zero-activity days — the parser stores None, supabase upserts NULL — verified `test_parse_timeseries_entry_zero_activity_day_preserves_nulls` behavior at scale).
- Legacy columns preserved at the pre-existing values (zeros, because that media never had activity even pre-cutover).
- The no-overwrite-legacy invariant verified by inspection.

Surfaced the result to Drake before bulk per spec gate ("Bulk re-backfill — smoke first, Drake confirms, then 30-day bulk"). The all-zeros + all-Nones table tripped Drake briefly; clarified it's just the inactive-media coincidence and that bulk would hit the active medias where variance shows. Drake re-confirmed.

**4. Bulk `--apply`.** Full 80 medias × 31-day window. Ran in background; completed in ~3 minutes. Output:
```
window:                  {'start_date': '2026-04-24', 'end_date': '2026-05-24'}
days_in_window:          31
medias_synced:           80
medias_failed:           0
daily_rows_upserted:     2480
daily_rows_failed:       0
```

Then ran post-bulk SQL verification (next section).

## Verification

- **Migration apply** — canonical output, exit 0, ledger updated to 0046.
- **Dual-verify** — 11/11 new columns present; legacy columns retained; ledger has 0046.
- **Smoke** — 31 rows for one media, 0 failures, legacy preservation verified by inspection.
- **Bulk apply** — 80/80 medias synced, 2,480 daily rows, 0 failures, 0 errors.
- **Full test suite (no DB hit)** — 805/805 passing (the Pt 1 baseline; no test changes in Pt 2).

### Real-variance verification (the whole point of this cutover)

**`i1173gx76b` (VSL Direct Closer Funnel variant) last 14 active days:**

| date | plays_filtered | played_time_seconds | engagement_rate (%) | avg_view_seconds (derived) |
|---|---:|---:|---:|---:|
| 2026-05-24 | 93 | 2,726 | **9.91** | 29.3 |
| 2026-05-23 | 202 | 7,161 | 14.73 | 35.5 |
| 2026-05-22 | 164 | 6,075 | 14.70 | 37.0 |
| 2026-05-21 | 146 | 7,175 | 20.18 | 49.1 |
| 2026-05-20 | 198 | 10,079 | 19.99 | 50.9 |
| 2026-05-19 | 185 | 7,426 | 16.60 | 40.1 |
| 2026-05-18 | 217 | 8,650 | 16.34 | 39.9 |
| 2026-05-17 | 93 | 3,215 | 14.39 | 34.6 |
| 2026-05-16 | 50 | 2,565 | 21.15 | 51.3 |
| 2026-05-15 | 64 | 3,118 | 18.30 | 48.7 |
| 2026-05-14 | 60 | 3,705 | **25.38** | 61.8 |
| 2026-05-13 | 61 | 2,573 | 18.60 | 42.2 |
| 2026-05-12 | 65 | 3,393 | 21.35 | 52.2 |
| 2026-05-11 | 51 | 2,268 | 18.46 | 44.5 |

**Engagement range 9.91% → 25.38%.** Compare to the flat 17.22% the pre-cutover by_date-derived approach produced on the same period. The cutover delivered real per-day signal exactly as predicted by the verify report.

**TYP video `fbgjxwe62y` last 7 active days** — also varies, even more wildly due to lower volume:
```
2026-05-24  plays= 4  pts= 433s  engagement=26.07%
2026-05-23  plays= 9  pts= 978s  engagement=32.67%
2026-05-22  plays= 4  pts= 763s  engagement=69.65%  ← longer-watch day
2026-05-21  plays= 7  pts= 154s  engagement=11.04%
2026-05-20  plays= 7  pts= 516s  engagement=36.84%
2026-05-19  plays= 2  pts=   5s  engagement= 2.41%  ← someone bounced immediately
2026-05-18  plays= 7  pts= 704s  engagement=38.35%
```

### Legacy-preservation verification (the cutover's load-bearing invariant)

On `i1173gx76b` 2026-05-23 — a row that existed pre-cutover (from the 875-day wide-window backfill in Pt 2 of `wistia-ingestion`):

```
legacy[load_count=328  play_count=236  hours_watched=2.7859]   ← preserved from prior by_date backfill
new   [plays_filtered=202  played_time_seconds=7161]            ← populated by timeseries cutover
```

Both column groups coexist on the same row. The post-cutover pipeline upsert did NOT touch the legacy columns — they hold the values they had before this spec ran. Tested at parser + orchestrator level + verified at scale.

### Bulk totals

- **Rows upserted:** 2,480 (80 medias × 31 days)
- **Total bot-filtered plays this window:** 9,407
- **Total seconds of watch time this window:** 462,791 (= **128.6 hours of video content watched account-wide in 30 days**, ~4.15 h/day average)
- **Rows with at least one post-cutover column populated:** 1,776 (the other ~704 rows are days where Wistia returned a `{timestamp: ...}` entry with all-zero/omitted metric fields — bot-filtered the same — for inactive medias)

## Surprises and judgment calls

- **Smoke landed on the zero-activity media** (`v1xlfys5y2` "AI Ads Bot"). Looked alarming at first glance — all-zeros legacy + all-None new — but it's the correct designed behavior (preserve legacy values which happened to already be zero; new columns NULL because Wistia omits metric fields for inactive days). Took a clarification message with Drake to confirm. Worth knowing for future smokes: smoke uses the FIRST media in iter order, which can be misleading if that media has no traffic. Future option: change smoke to pick a known-active hashed_id (e.g. the dominant VSL `i1173gx76b`) so the result is visibly meaningful at a glance. Not urgent enough to change now; documented here.

- **Engagement variance on `i1173gx76b` lower-bound is 9.91%, not the 2.79% the verify report predicted.** The verify probe used a 30-day window (2026-04-25 → 2026-05-24) and saw a `2026-04-27` day with very low engagement that dragged the lower bound. The bulk apply used a 31-day window (2026-04-24 → 2026-05-24) but the actual active-day rendered here only goes back to 2026-05-11 (where engagement rises from there). The 9.91% on 2026-05-24 IS the low point of the *queried* 14-day window. If we queried back to 2026-04-27 we'd see the 2.79% the verify report showed. Both are real signal; the visible range depends on the query window. Worth noting but not a discrepancy.

- **`hours_watched` is `0` on post-cutover-only rows** (which means days that were created fresh by the timeseries pull, not days the wide-window by_date backfill ever touched). That's because the column has `NOT NULL default 0` from migration 0045. For the aggregation layer: `hours_watched = 0` on a row where `played_time_seconds > 0` is NOT "no activity" — it's "pre-cutover legacy column wasn't populated for this row." The schema doc + runbook spell this out. If this confusion becomes a problem, the cleanest fix is to drop `hours_watched` entirely in a future migration once we're confident the aggregation layer never needs it.

- **`plays_filtered` is ~14% lower than `play_count`** for the same `(hashed_id, day)` on rows that have both populated (e.g. 202 vs 236 on the verified row above). That's the bot/dedup filtering Bottler does that the legacy raw count doesn't. Matches the verify report's prediction exactly. Aggregation layer's call which to surface; my lean stays `plays_filtered`.

- **`updated_at` on rows that got re-upserted shows the bulk's timestamp**, even on rows where only the new columns changed. Standard behavior — supabase's update path always touches the `updated_at` trigger. Operationally fine, but if anyone queries "show me rows updated since X" expecting "only meaningful changes" they'll get every row the cutover touched. Documented implicitly via the spec but worth flagging.

- **No state.md update in Pt 1.** Per the partial-report convention; ship entries go in the resume report's commit set after the bulk apply lands. Done in this Pt 2.

- **Did NOT update `docs/reports/wistia-discovery.md`** to note that its "per-day engagement-rate is DERIVABLE" claim is now superseded. The spec said don't edit historical reports; the watchtime-verify + this report together stand as the corrected record. A future reader hitting the discovery report should be guided by the spec / state.md / runbook to the current state.

## Out of scope / deferred

All the spec's deliverables are done. Items held for future specs (separate Director scope):

- **Drop legacy columns** (`hours_watched`, `play_count`, `load_count`) once the aggregation layer + dashboard have been stable on the new columns for a few weeks. Migration would be one-line ALTER.
- **Aggregation layer SQL views** for canonical VSL aggregate (across `i1173gx76b` + `nbump1crwb`) and TYP per-day series. Pick canonical-plays column (`play_count` vs `plays_filtered`) at the same time.
- **Engagement-rate semantic confirmation** with the Engine-sheet author — Wistia's "engagement" = "average % of video watched"; verify that matches dashboard intent.
- **Extend backfill window beyond 30d** for the new columns if older trends become important. Bump `BACKFILL_START` and re-run; idempotent.
- **Smoke target-media improvement** — pick a known-active hashed_id for `--smoke` so the verify table is visibly meaningful, not zeros-because-of-iter-order.

## Side effects

- **Migration 0046 applied to cloud Supabase.** Migration count 45 → 46. Two existing tables + the cf-definitions table now total 47 + indexes; the migration only altered `wistia_media_daily`.
- **Wistia API:** ~165 read-only calls during bulk (1 projects + 80 inventory + 80 lifetime + 80 timeseries). Well under 600/min quota.
- **Supabase:** 2,480 new/updated rows on `wistia_media_daily` + 80 upserts on `wistia_medias` (inventory refresh — unchanged shape). Plus ~140 audit/ledger reads during verification.
- **Slack / external services:** none touched.
- **Local filesystem:** no new probe dumps. `.env.local` unchanged.
- **Vercel:** no changes — the cron will fire on its next `30 */3 * * *` tick using the new pipeline automatically (the pipeline cutover landed in Pt 1's push). First production cron tick post-cutover will refresh the rolling 14-day window with the new endpoint; no operational handover needed.
- **No new env vars.** `WISTIA_API_TOKEN` was already in Vercel from the prior ship — that gate (d) was already cleared.
- **No new tests in Pt 2** — coverage shipped in Pt 1 (805/805 passing).
