# Wistia by_date Watch-Time Verification
**Slug:** wistia-watchtime-verify
**Status:** in-flight
**Target branch:** main

## ⚠️ Landscape note

Wistia ingestion shipped + backfilled (90 days) on `main`. Close + Meta live. Separate Ella worktree on `ella-worktree`. **Stay on `main`.** `git status` + `git log --oneline -10` first.

## Why this exists — a real data-quality problem surfaced

We ingested Wistia per-day stats and computed average view duration = `hours_watched * 3600 / play_count` per day. **The derived avg-view-duration is IDENTICAL every single day for a given video** across 40+ days:
- `i1173gx76b`: 42.5s every day May 11–23, then 42.7s every day Apr–May 10
- `nbump1crwb`: 36.1s every day
- `fbgjxwe62y`: 44.5s every day

**This is almost certainly an artifact, not real viewer behavior.** Real daily avg-view-duration would vary day to day. The value changing EXACTLY at the 14-day-from-today boundary (42.5 → 42.7) is the tell: it looks like `hours_watched` in the `by_date` response is NOT a true per-day watch-time figure but is instead derived from a lifetime/windowed average — i.e. `hours_watched ≈ play_count × (constant avg-seconds-per-play)`. If so, the per-day ratio is constant by construction and carries zero independent daily signal.

**`play_count` per day looks genuinely real** (it varies sensibly: 236, 189, 164…). It's specifically `hours_watched` (and therefore avg-view-duration AND engagement-rate, both derived from it) that's suspect.

This matters: TWO of the four Wistia Engine-sheet metrics (VSL + TYP **Average View Duration**, and **Engagement Rate**) depend on `hours_watched`. If `hours_watched` is a smeared lifetime average, those two metrics are FAKE as daily series — a flat line that will look broken on Nabeel's dashboard. We need to know definitively before building any dashboard tile on them.

**This is a READ-ONLY verification probe. No schema, no migration, no ingestion changes, no UI.** Output is a probe script + a short findings report. The fix (if any) is a SEPARATE spec decided after we see the truth.

## The question to answer definitively

**Does Wistia's `/modern/stats/medias/{id}/by_date` endpoint return TRUE per-day watch-time, or a windowed/lifetime average smeared across days?**

Concretely, for a single high-traffic video over ~30 days, determine:
1. Is `hours_watched` on a given day exactly `play_count × constant`? (Compute `hours_watched / play_count` per day and see if it's flat to many decimal places — if yes, it's a constant, confirming the artifact.)
2. Does the constant CHANGE depending on the `start_date`/`end_date` window you request? (Pull the SAME single day's data via different window requests — e.g. a 7-day window vs a 90-day window vs a 1-day window ending on that day — and see if `hours_watched` for that day differs. If the per-day value depends on the requested window, it's a windowed average, not a fixed daily fact.)
3. Is there a DIFFERENT field, endpoint, parameter, or API version that returns true daily watch-time / engagement / seconds-watched? Investigate:
   - Does `by_date` accept other metrics or a `metrics=` / `fields=` param?
   - Is there a `by_event` / per-play / events endpoint that gives individual play durations we could sum per day?
   - The legacy `/v1/stats/` endpoints — do any expose daily seconds-watched or engagement?
   - Account-level vs media-level stats differences.
   - Read the current Wistia Stats API docs (https://docs.wistia.com) for what daily-granular watch-time options actually exist.

## How to investigate

Probe script `scripts/verify_wistia_watchtime.py` (throwaway, dumps to git-ignored `.probe-out/wistia-verify/`), read-only, Bearer auth via `WISTIA_API_TOKEN` from `.env.local`, the `X-Wistia-API-Version: 2026-03` header on by_date. Steps:

1. **Confirm the artifact.** Pull `by_date` for `i1173gx76b` (highest traffic) over a 30-day window. Print per-day `play_count`, `hours_watched`, and `hours_watched/play_count` to 6+ decimals. Confirm whether the ratio is constant.
2. **Test window-dependence.** Request a SINGLE specific recent day (say 7 days ago) three ways: (a) a 1-day window `start=end=that day`, (b) a 14-day window containing it, (c) a 90-day window containing it. Compare `hours_watched` for that day across the three. If it differs → it's a windowed average → the daily number is not a real daily fact. Paste the three values side by side.
3. **Cross-check against lifetime.** Pull `/v1/medias/{id}/stats.json` lifetime `averagePercentWatched` + the media `duration`. Compute lifetime avg-seconds = `averagePercentWatched/100 × duration`. Compare to the flat per-day avg-seconds we derived (42.5s). If they match closely → confirms `by_date` hours_watched is just back-computed from the lifetime average.
4. **Hunt for a true-daily source.** Try every documented avenue for real daily watch-time/engagement (other params on by_date, event-level endpoints, legacy stats endpoints). For each, paste what it returns. Goal: find a field that gives genuinely-varying daily watch-time, OR conclude definitively that none exists via the API.

## What success looks like

Findings report at `docs/reports/wistia-watchtime-verify.md` (six-section structure) stating definitively:
- **Is `hours_watched` per-day real or a windowed-average artifact?** (With the ratio-constancy + window-dependence evidence — paste real numbers.)
- **Does a true daily watch-time / engagement source exist anywhere in the Wistia API?** (Yes + which endpoint/field, or No.)
- **Verdict on the four Engine-sheet metrics:**
  - VSL/TYP **play counts** — confirmed real daily? (almost certainly yes)
  - VSL/TYP **Average View Duration** + **Engagement Rate** — can these be true daily series, or only lifetime/rolling-window figures?
- **Options for Drake to decide** (frame as input, not a settled call):
  - If no true-daily source: accept avg-view-duration/engagement as LIFETIME or ROLLING-WINDOW figures (a single current number, not a daily trend), and surface them that way on the dashboard — OR
  - If a true-daily source exists: a follow-up spec to switch ingestion to it.
  - What to do with the already-ingested (possibly-artifact) `hours_watched` column — keep (play_count is fine, hours is a lifetime-smear cross-check), or stop trusting it for dailies.

Concrete acceptance: the window-dependence test (step 2) is run with real numbers pasted; a definitive yes/no on whether daily watch-time is real; a clear recommendation on how the two duration/engagement metrics should be represented.

## Hard stops

- `WISTIA_API_TOKEN` missing/401 → stop + report.
- Repeated 503s → back off, report partial.
- Never write to Wistia. Never write Supabase. Never echo the token. No migrations, no env/Vercel/cron changes, no ingestion-code changes — this is pure investigation.

## Think this through

It's possible the artifact is real viewer behavior coincidentally flat (unlikely across 40+ days at 3 different videos). It's possible `hours_watched` IS real daily but our derivation is wrong (check the math — but identical-to-6-decimals across many days strongly implies a constant). It's possible Wistia only ever computes engagement as a lifetime rollup and there's genuinely no daily watch-time via API (the likely-painful answer — if so, say it plainly; the dashboard then shows engagement as a single current stat, not a trend). The play-count daily series is still valuable regardless. Surface honestly.

## Mandatory doc updates

- Report at `docs/reports/wistia-watchtime-verify.md`.
- No other doc edits (pure investigation). If the verdict implies the shipped `wistia_ingestion` runbook/schema docs need a caveat (e.g. "hours_watched is not a true daily metric"), NOTE that in the report's deferred section for a follow-up edit — don't edit them in this spec.
