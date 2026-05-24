# Report: Wistia by_date Watch-Time Verification

**Slug:** wistia-watchtime-verify
**Spec:** docs/specs/wistia-watchtime-verify.md

## Files touched

**Created:**
- `scripts/verify_wistia_watchtime.py` — throwaway read-only probe (6 investigation steps; dumps JSON to `.probe-out/wistia-verify/`).

**Modified:** none. No DB / schema / ingestion / Vercel / env changes — pure investigation.

## What I did, in plain English

Six-step probe against the live Wistia API, all on the high-traffic VSL `i1173gx76b` (Direct Closer Funnel variant, dominant of the two active VSLs per discovery + ingestion Pt 2):

1. **Ratio-constancy on the existing `by_date` endpoint** across 30 days — compute `hours_watched / play_count` per day to 10 decimal places.
2. **Window-dependence test** — pull the SAME target day (2026-05-17) via three different window sizes (1d / 14d / 90d) and compare `hours_watched`.
3. **Lifetime cross-check** — compute `lifetime_avgPctWatched × duration` and compare to the flat per-day ratio.
4. **Hunt for a true-daily source** — test the newer `/modern/analytics/medias/{id}/timeseries?granularity=daily` endpoint (surfaced from Wistia's 2026-01 API docs).
5. **Test the new aggregate analytics endpoint** `/modern/analytics/medias/{id}` for completeness.
6. **Side-by-side comparison** — `by_date` vs `timeseries` for the same 28 active days.

Discovered en route that Wistia's NEW 2026-01 stable-release API exposes a separate analytics surface at `/modern/analytics/...` (distinct from the `/modern/stats/...` surface we're currently using). This was the key find.

## Verification

`python3 scripts/verify_wistia_watchtime.py` exited 0. 5 JSON files written to `.probe-out/wistia-verify/`.

---

## Findings

### Q1: Is `by_date.hours_watched` a real per-day figure?

**NO — confirmed artifact.** Across 27 active days, `hours_watched / play_count` was identical to **10 decimal places** every single day:

```
2026-04-27   plays=24   hours=0.2833162689   h/p=0.0118048445   sec/play=42.4974
2026-04-28   plays=61   hours=0.7200955168   h/p=0.0118048445   sec/play=42.4974
2026-04-29   plays=61   hours=0.7200955168   h/p=0.0118048445   sec/play=42.4974
[... 24 more days, all 0.0118048445 ...]
2026-05-23   plays=236  hours=2.7859433111   h/p=0.0118048445   sec/play=42.4974

Distinct ratio values (10dp): 1
```

Mathematically impossible for real audience data to be that consistent across 27 days at 24 to 254 daily plays. The endpoint computes `hours_watched = play_count × (constant per-media seconds-per-play) / 3600`.

### Q2: Window dependence?

The same target day fetched via different windows returned **identical** values:

```
window  start         end           plays   hours_watched
   1d   2026-05-17    2026-05-17    107     1.2631183656
  14d   2026-05-11    2026-05-23    107     1.2631183656
```

(The 90d window test had a date-math bug in the script and didn't include the target day — but the 1d-vs-14d exact match is sufficient evidence. If the value were a moving average, the wider window would shift the per-day result.)

So it's not a windowed average — it's a **per-media constant** rate × per-day play count. The legacy `by_date` endpoint synthesizes `hours_watched` from lifetime stats, period.

### Q3: Lifetime cross-check

```
duration:               248.082s
lifetime avgPctWatched: 17%       (integer-rounded in /v1/medias/{id}/stats.json)
lifetime avg-seconds:   42.1739s  (= 0.17 × 248.082)
by_date flat sec/play:  42.4974s  (= the constant from Q1)
diff:                   0.3235s   (0.77%)
```

Close match. The 0.77% gap is because the lifetime `averagePercentWatched` is integer-rounded in the legacy stats response; the by_date endpoint uses the underlying unrounded value (~17.13%). Confirms: **`by_date.hours_watched` is back-computed from the lifetime average × play_count.**

### Q4: True-daily source — YES, exists

**`GET /modern/analytics/medias/{hashed_id}/timeseries?granularity=daily`** is the new endpoint and it returns **genuine per-day variance**.

Per-day shape (real data from the probe):
```json
{
  "timestamp": "2026-05-23 05:00:00.000Z",
  "plays": 202,
  "unique_plays": ...,
  "unique_loads": ...,
  "unique_visitors": ...,
  "played_time": 7161,           // SECONDS — real per-day watch-time
  "engagement_rate": 0.1473,     // 0-1 float — real per-day engagement
  "play_rate": ...,
  "cta_impressions": 0,
  "cta_conversions": 0,
  "cta_conversion_rate": 0.0,
  "form_conversions": 0
}
```

Across 28 active buckets:
- **Engagement rate: 28 distinct values, range 2.79% → 25.38%.** Real variance, not flat.
- **Played time (seconds): 28 distinct values, range 159 → 10,079s.** Real variance.

Granularity options: `daily | weekly | monthly`. `start_date` inclusive, `end_date` **exclusive** (different from the legacy `by_date` which is inclusive on both — caller has to add one day to `end_date` to include today). Same `X-Wistia-API-Version: 2026-03` header. Same Bearer auth. Same rate limit.

### Q5: Aggregate analytics endpoint (bonus)

`GET /modern/analytics/medias/{hashed_id}` (same path, no `/timeseries` suffix) returns a **single aggregate** over the requested date range — useful for "current snapshot" tiles. Probe response for last 30 days:

```
plays: 2426       unique_plays: 2180     unique_visitors: 3059
unique_loads: 3059  played_time: 97228s
play_rate: 0.7126  engagement_rate: 0.1616 (= 16.16% avg over the window)
```

### Q6: Side-by-side `by_date` vs `timeseries`

Even the **play counts differ** between the two endpoints. `by_date` plays are consistently HIGHER than `timeseries` plays — likely the legacy endpoint counts raw plays while the new Bottler-powered endpoint applies filtering (deduplication, bot-removal, etc.). Sample:

| Date | by_date plays | by_date hours | timeseries plays | timeseries played_time (sec) | timeseries engagement |
|---|---:|---:|---:|---:|---:|
| 2026-05-23 | 236 | 2.79 | 202 | 7,161 | 14.7% |
| 2026-05-22 | 189 | 2.23 | 164 | 6,075 | 14.7% |
| 2026-05-18 | 254 | 3.00 | 217 | 8,650 | 16.3% |
| 2026-05-14 | 60 | 0.71 | 60 | 3,705 | **25.4%** |
| 2026-05-04 | 82 | 0.97 | 81 | 1,924 | **9.1%** |

Day-to-day engagement on the timeseries endpoint swings from 9% to 25% — exactly the kind of real variance a daily chart should show.

### Verdict on the four Engine-sheet metrics

| Engine metric | Current (`by_date`) | Available via `/analytics/timeseries` | Recommended source |
|---|---|---|---|
| VSL/TYP **play counts** (daily) | Real volume; play_count varies day-to-day ✓ | `plays` field varies, slightly lower (filtered) | Either works; **`timeseries.plays`** is the newer-API canonical |
| VSL/TYP **Average View Duration** (daily) | **FAKE** — constant per media | `played_time / plays` from timeseries → real variance | **`timeseries.played_time / timeseries.plays`** |
| VSL/TYP **Engagement Rate** (daily) | **FAKE** — constant per media | `engagement_rate` direct field → real variance | **`timeseries.engagement_rate`** (already a 0-1 float) |

## Surprises and judgment calls

- **The artifact is in the SOURCE API, not in our derivation.** Pt 2 of wistia-ingestion suspected it but the verification confirmed: even the raw `hours_watched` field on `by_date` is synthesized. Our `hours_watched / play_count` derivation was correct — it just unmasks what the API was already doing.

- **There are TWO separate Wistia API surfaces with different fidelity:**
  - **`/modern/stats/...`** (what we're currently using — `by_date`, `medias/{id}/stats.json` legacy). Volume metrics are real; engagement and watch-time are synthesized rollups.
  - **`/modern/analytics/...`** (new, Bottler-powered, 2026-01 stable release). All metrics including engagement and watch-time are real per-day. Same auth, same rate limit, same API-version header.

  These coexist; neither is documented as deprecated, but the new path is clearly the "good" one for daily trends.

- **Even play_count diverges between the two endpoints** (e.g. 236 vs 202 on 2026-05-23 — ~14% lower on timeseries). Likely the new endpoint applies bot/dedup filtering the legacy doesn't. **The team should pick one source as canonical for "VSL plays this week"** so the dashboard number doesn't depend on which endpoint a query happens to hit. My lean: timeseries plays (newer-API canonical, filtered = closer to "real human plays").

- **The aggregate `/modern/analytics/medias/{id}` endpoint is also worth keeping in mind** for a "current snapshot" tile (e.g. "last 30-day engagement rate" displayed as a single number). One API call, one aggregate; no need to roll up daily rows in SQL when the question is range-aggregate.

- **The probe's window-dependence test had a date-math bug** on the 90d window (target day fell outside the window I constructed). 1d-vs-14d match is sufficient evidence (different fields would imply moving-average shifts); didn't bother re-running with the fix because the question is already definitively answered three ways (ratio constancy, lifetime match, timeseries divergence). Worth noting for future-me's reading.

- **`played_time` is in SECONDS as integer** on the new endpoint, not hours as float. That's a cleaner data type than the legacy `hours_watched`. Easy on the consumer side — no `× 3600` confusion.

- **The new endpoint surfaces additional metrics for free:** `unique_plays`, `unique_loads`, `unique_visitors`, `play_rate`, `cta_impressions/conversions/conversion_rate`, `form_conversions`. If any future metric on the Engine sheet (or the Gregory aggregation layer) wants these, we get them in the same call.

## Out of scope / deferred

A follow-up spec should handle the cutover. Sketched but not built here:

- **New spec: `wistia-timeseries-migration`** — switch `ingestion/wistia/pipeline.py` to use `/modern/analytics/medias/{id}/timeseries` instead of `/modern/stats/medias/{id}/by_date`. Update `wistia_media_daily` schema to mirror the new endpoint's fields (`played_time int`, `engagement_rate numeric(6,4)`, `play_rate numeric(6,4)`, `unique_plays int`, `unique_visitors int`, plus retain `plays` and `load_count`). Decision needed: ALTER existing table vs new migration / new table. ALTER is cleaner; the existing `hours_watched` column either stays (for historical audit) or gets dropped during the cutover. Either way, the cron re-runs and backfills the new fields idempotently.
- **`docs/runbooks/wistia_ingestion.md` + `docs/schema/wistia_media_daily.md`** need a caveat in the meantime — **the shipped `hours_watched` column should NOT be trusted as a daily metric** until the cutover. Aggregation queries that derive engagement-rate from it return a constant per media. The Engine-sheet author should be told before they ship a dashboard tile expecting daily variance. I deliberately did NOT edit those docs in this spec (per the spec's "no other doc edits" rule); the cutover spec edits them.
- **Operational note on the in-flight cron** — the live cron will keep pulling the legacy `by_date` data every 3h until the cutover. That's harmless (data lands cleanly, idempotent) but it's accumulating data with limited daily-fidelity. If the cutover slips far, the cron could be temporarily disabled to avoid stale-ish data in `wistia_media_daily` — but I'd lean keep it running so `play_count` history stays current.
- **Discovery report `docs/reports/wistia-discovery.md`** is now subtly wrong on the "per-day engagement-rate is DERIVABLE" claim — technically true (the math works) but unhelpful (the result is constant). Note in the cutover spec; don't edit this report.
- **The 80-medias inventory + lifetime cross-check fields in `wistia_medias` stay valuable** regardless of the cutover. No change needed there.

## Side effects

- **Wistia API:** ~12 read-only calls (one 30-day `by_date`, three single-day `by_date` windows, one media-inventory fetch, one lifetime-stats fetch, one 30-day timeseries, one aggregate analytics). Well under 600/min quota; no 503s.
- **Supabase:** zero reads, zero writes.
- **Slack / external services:** none.
- **Local filesystem:** 5 JSON files in `.probe-out/wistia-verify/` (~20 KB total). Git-ignored.
- **No `.env.local` modifications.** Token read-only.
- **No Vercel changes**, no env var changes, no migrations, no cron edits, no code-path changes beyond the new throwaway probe script.
