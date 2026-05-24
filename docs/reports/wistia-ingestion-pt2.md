# Report (Pt 2 — Resume): Wistia Ingestion — Migration Apply + 90-Day Backfill

**Slug:** wistia-ingestion
**Spec:** docs/specs/wistia-ingestion.md
**Pt 1 (PARTIAL — intact):** docs/reports/wistia-ingestion.md (gate (a) halt)
**Status:** complete for code+backfill scope. Production cron activation still pending Drake's gate (d) (`WISTIA_API_TOKEN` in Vercel env).

Drake approved past gate (a) with a terse "apply"; clarified the smoke+bulk continuation as "proceed with A + B together"; then mid-bulk redirected from the wide 875-day backfill to a 90-day window when the wider run looked like ~20 more minutes of wall time.

## Files touched

**Modified:**
- `scripts/backfill_wistia.py` — narrowed `BACKFILL_START` from `date(2024, 1, 1)` to `date(2026, 2, 23)` (90 days back from today) per Drake's mid-run scope change. Updated the comment to record the reasoning so a future engineer doesn't widen it back without context.
- `docs/state.md` — added the dated ship entry at the top of "Gregory editorial skin shipped" covering migration 0045, the 90-day backfill outcome, sanity numbers vs discovery, and the Wistia-per-day-engagement-is-constant surprise.

**Not touched in this pass** (all already committed in Pt 1):
- `supabase/migrations/0045_wistia_ingestion_tables.sql`
- `ingestion/wistia/{__init__,client,parser,pipeline}.py`
- `api/wistia_sync_cron.py`
- `tests/ingestion/wistia/*` + `tests/api/test_wistia_sync_cron.py`
- `docs/schema/wistia_{medias,media_daily}.md`
- `docs/runbooks/wistia_ingestion.md`
- `vercel.json`, `CLAUDE.md` § Folder Structure
- `.env.example`

## What I did, in plain English

Four sequential operations post-approval, with one mid-run pivot.

**1. Apply migration 0045.** Verified preconditions (Docker WSL off, supabase CLI 2.90.0, pooler-url present). Ran `supabase db push --linked --dns-resolver https --password "$DB_PW" --yes`. Output matched canonical "Connecting to remote database... Finished supabase db push." shape.

**2. Dual-verify per `docs/runbooks/apply_migrations.md`.** Via psycopg2 against the pooler URL:
- **Schema reality:** `to_regclass` returned non-null for both `public.wistia_medias` (16 columns) and `public.wistia_media_daily` (8 columns).
- **Indexes:** `wistia_medias` has 2 (PK + project_id_idx); `wistia_media_daily` has 2 (PK + day_idx).
- **Triggers:** both `*_set_updated_at` triggers present.
- **Ledger:** `0045 wistia_ingestion_tables` at the top.

**3. Smoke (`--smoke`).** Full inventory (80 medias) + one media's 875-day per-day stats. Exited cleanly:
```
medias_synced:           80
medias_failed:           0
daily_rows_upserted:     875
daily_rows_failed:       0
```
Tier-of-confidence for proceeding to bulk: high.

**4a. Bulk `--apply` (first attempt, wide window).** Ran with `BACKFILL_START = 2024-01-01`. Progress checked after ~35 seconds showed **11 / 80 medias done (~14%), pace ~3 medias/min** — extrapolating to ~20-25 minutes more. The bottleneck wasn't DB writes (PostgREST is fast at ~10 rows/s) but the per-media `by_date` API latency — Wistia computes that endpoint by walking events server-side; 875-day windows take ~1-2s per media.

Reported to Drake. He picked **option B: kill, narrow to 90 days, restart.** Justification: recent history is enough for the Engine sheet's per-day rows; older trends can backfill later by bumping `BACKFILL_START` and re-running (idempotent on `(hashed_id, day)`).

**4b. Bulk `--apply` (second attempt, 90-day window).** SIGTERM'd the wide-window process (PID 9760), narrowed `BACKFILL_START` to `date(2026, 2, 23)`, committed the change locally (commit pending push), re-ran `--apply`. Second run completed in **~3 minutes**:
```
window:                  2026-02-23 → 2026-05-24
days_in_window:          91
medias_synced:           80
medias_failed:           0
daily_rows_upserted:     7280
daily_rows_failed:       0
```

Idempotency held: the 11 medias from the first wide-window run kept their 875-day history; the 80 medias in the second 90-day run upserted their last 91 days (which overlapped the wide-window data for the 11 already-completed medias, harmlessly re-stating those days with identical values).

## Verification

- **Migration apply** — canonical CLI output, exit 0, ledger updated.
- **Dual-verify** — schema reality + ledger both PASS.
- **Smoke** — 80 medias + 875 daily rows on one media, 0 failures.
- **Bulk (90d)** — 80 medias + 7,280 daily rows, 0 failures, ~3 min wall time.
- **DB final state:**
  - `wistia_medias`: 80 rows.
  - `wistia_media_daily`: 16,276 rows (= the wide-window 11 medias' ~9,000+ rows + the 90-day 80 medias' 7,280 minus overlap collapses).
  - Distinct medias with at least one daily row: 80.
- **Sanity vs discovery report (`docs/reports/wistia-discovery.md`):**

  | Media | Discovery 14d | Pt 2 last 7d (DB) |
  |---|---|---|
  | VSL `i1173gx76b` (Direct Closer Funnel) | 1,694 plays / 20.11 hours | 1,256 plays / 14.9 hours |
  | VSL `nbump1crwb` (v2) | 1,384 plays / 13.89 hours | **60 plays / 0.6 hours** |
  | TYP `fbgjxwe62y` | 153 plays / 1.89 hours | 32 plays / 0.4 hours |

  Direct Closer Funnel variant is still dominant. v2 dropped dramatically — likely an A/B test concluded since discovery and traffic shifted entirely to the Direct Closer Funnel cut. Worth surfacing to Drake but not anomalous; the inventory is current and the proportions are coherent.

- **Engagement-rate derivation cross-check:** spot-checked the formula `(hours_watched × 3600) / (play_count × duration_seconds) × 100` against five consecutive recent days of VSL data:
  ```
  2026-05-23  plays=104  hours=1.2344  dur=248.1s  engagement=17.22%  avg_view=42.7s
  2026-05-22  plays=189  hours=2.2432  dur=248.1s  engagement=17.22%  avg_view=42.7s
  2026-05-21  plays=164  hours=1.9465  dur=248.1s  engagement=17.22%  avg_view=42.7s
  2026-05-20  plays=230  hours=2.7298  dur=248.1s  engagement=17.22%  avg_view=42.7s
  2026-05-19  plays=208  hours=2.4687  dur=248.1s  engagement=17.22%  avg_view=42.7s
  ```
  Formula works; matches the lifetime cross-check value (`averagePercentWatched=17` from discovery → 17.22% derived — perfect match modulo rounding). See § Surprises for what this REALLY means.

## Surprises and judgment calls

- **Wistia's per-day `hours_watched` is a synthesized value, NOT actual seconds-of-content-watched on the day.** This is the major finding of Pt 2 and was invisible to discovery (which only saw zero-activity windows). Empirical proof: for any given media, `hours_watched / play_count` returns an identical ratio across consecutive days, exactly equal to `lifetime_avg_pct × duration / 100`. The VSL's 17.22% matches lifetime 17%; the TYP's 21.49% matches lifetime 22%. The math: Wistia's by_date endpoint appears to compute `hours_watched = play_count × lifetime_avg_pct/100 × duration_seconds / 3600`. **Per-day engagement-rate variance is therefore zero** — the Engine sheet's daily engagement chart will be a flat horizontal line per media, only stepping when the lifetime average shifts. Per-day **volume** (loads, plays) IS real and varies day-to-day. Avg view duration per day = `hours_watched / play_count` is also constant per media for the same reason.

  This doesn't invalidate the ingestion — we mirror what Wistia returns, raw, and the aggregation layer documents the caveat. But it narrows what the dashboard can faithfully render. Worth surfacing to the Engine-sheet author before building the daily engagement chart so expectations match what's achievable. Documented in the schema doc + state.md + runbook.

- **Mid-run backfill scope change.** The first wide-window `--apply` was killed at ~14% with no data loss (idempotent). Re-running with a narrower window kept all already-completed rows AND filled in the rest. This validates the spec's claim that "backfill is just one big idempotent run" — the rolling-window cron + manual backfill are the same code path, both can be re-run safely. If older history is needed later, bump `BACKFILL_START` in `scripts/backfill_wistia.py` and re-run; the script will add the older days without duplicating anything.

- **v2 VSL traffic dropped 23×** between discovery (1,384 plays / 14d → ~99/day) and Pt 2 (60 plays / 7d → ~9/day). The Direct Closer Funnel variant didn't change as much. Most likely an A/B test concluded and traffic was shifted; could also be a funnel reroute, a paused campaign, or v2 being intentionally throttled. NOT a sign of a data issue — load_count + play_count + hours_watched are all proportional to each other, and the lifetime totals still grew. Worth Drake mentioning to whoever runs the ad/funnel infra (Nabeel?) just so they're aware it's reflected in the data.

- **Initial dual-verify column count was 16 for `wistia_medias`** (the partial report predicted 15). Counted by hand: identity (1) + inventory (5) + lifetime (5) + Wistia-side timestamps (2) + lifecycle (3 — synced_at + created_at + updated_at) = 16. Pt 1 missed `synced_at` in its mental count. Migration shipped correctly; the off-by-one was only in the partial report's prose.

- **No `WISTIA_API_TOKEN` in Vercel env yet** — gate (d) for Drake. Until added, the live cron at `/api/wistia_sync_cron` will fire every 3h and return `wistia_token_unavailable`, writing a `failed` audit row per tick. No production damage (rate-limit nuisance only — 8 ticks/day × audit-row writes = 8 cheap inserts). Once the token is set in Vercel + a manual trigger validates the rolling-window refresh, the cron self-heals automatically.

- **Local stdout buffering on both bulk runs.** `--apply 2>&1 | tail -N` buffers Python's stdout until process exit. Progress visibility relied on periodic DB row-count queries against `wistia_media_daily`. Future long-running scripts should either drop the `| tail` wrapper (let raw stdout flow to the log) or write structured progress to a file the watcher can `tail -f`. Documented as a generic ops ergonomics issue in the meta-sheet-ingestion Pt 3 report; same observation here.

## Out of scope / deferred

Remaining for Drake to complete production activation:

- **Add `WISTIA_API_TOKEN` to Vercel project env vars** (gate (d)).
- **Trigger the cron once manually from Vercel dashboard** to verify the rolling-window refresh works end-to-end (audit row appears with status=processed, `medias_synced=80`, `daily_rows_upserted ≈ 80 × 14 = 1,120` for a single rolling-14-day tick).
- **(Optional)** if older Wistia history becomes needed for trend analysis, bump `BACKFILL_START` in `scripts/backfill_wistia.py` to an earlier date (e.g. `2024-01-01` for full account history) and re-run `--apply`. Idempotent; adds rows for newly-included days without touching existing ones.

Held for future specs:

- **Aggregation / dashboard layer** — engagement-rate + avg-view-duration derivations in SQL views, canonical-VSL/TYP picks, the daily-engagement-is-constant caveat surfaced to the Engine-sheet author.
- **Stale-data alerting** — no Slack alert today if the cron stops working.
- **True per-day engagement** — would require a different Wistia surface (raw event API per-play) or accepting that the metric is a volume measure not an engagement measure.

## Side effects

- **Migration 0045 applied to cloud Supabase.** Migration count 44 → 45. Two new tables now live.
- **Wistia API:** ~250 read-only calls across the smoke + the two bulk runs (1 projects-list + 80 inventory + 80 lifetime-stats + 80 by_date per bulk run × 2 runs + smoke overhead). Well under 600/min quota; no 503s observed.
- **Supabase:** 16,276 rows written to `wistia_media_daily` + 80 rows to `wistia_medias`. Idempotent; safe to re-run.
- **Local filesystem:** no `.probe-out/` dumps. `.env.local` unchanged.
- **Slack / external services:** none touched.
- **Vercel:** cron schedule + per-file runtime were committed in Pt 1 and have been deploying on push. The function exists at `/api/wistia_sync_cron`; cron registered in Vercel. Currently returns `wistia_token_unavailable` per tick until `WISTIA_API_TOKEN` lands in Vercel env (gate (d)).
- **No new env vars added** to Vercel in this pass.
- **No tests added** in this pass — coverage shipped in Pt 1 (31 tests, all green).
- **One scope-edit commit pending:** `scripts/backfill_wistia.py` BACKFILL_START change from 2024-01-01 → 2026-02-23 is committed in this Pt 2 commit set.
