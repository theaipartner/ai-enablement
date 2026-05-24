# Report (PARTIAL): Wistia Timeseries Cutover

**Slug:** wistia-timeseries-migration
**Spec:** docs/specs/wistia-timeseries-migration.md
**Verification (the proof this cutover exists):** docs/reports/wistia-watchtime-verify.md
**Status:** halted — awaiting Drake's SQL review on migration 0046 (gate (a)). All code + tests + docs in place. Dry-run end-to-end against live Wistia is green (timeseries endpoint returns the expected per-day variance). Only the migration apply + smoke + bulk re-backfill remain.

## Files touched

**Created:**
- `supabase/migrations/0046_wistia_timeseries_columns.sql` — ALTER `wistia_media_daily` to add 11 timeseries-sourced columns; legacy columns kept (deprecated, not refreshed).

**Modified:**
- `ingestion/wistia/client.py` — added `fetch_timeseries(hashed_id, start_date, end_date, granularity='daily')`. Critical: callers pass INCLUSIVE end_date (matching every other source in the codebase); method adds +1 day internally before hitting the API (the new endpoint takes end_date EXCLUSIVE — the verify report's #1 footgun). Kept `fetch_by_date` with a deprecation note in the docstring.
- `ingestion/wistia/parser.py` — added `parse_timeseries_entry(hashed_id, entry)`. Maps `timestamp[:10]` → `day`; stores `played_time` as seconds-int + `engagement_rate` as 0-1 float RAW (no ×100). Deliberately does NOT include the legacy `load_count` / `play_count` / `hours_watched` columns in the row dict, so pre-cutover values on those columns are preserved by the upsert. Kept `parse_by_date_entry` with deprecation note.
- `ingestion/wistia/pipeline.py` — `sync_wistia` now calls `client.fetch_timeseries` + `parse_timeseries_entry` instead of the by_date pair. Error label changed `by_date {hid}` → `timeseries {hid}`. Docstring updated.
- `scripts/backfill_wistia.py` — `BACKFILL_START = date.today() - timedelta(days=30)` per Drake's spec decision (was 90d). Dry-run path now hits `fetch_timeseries` instead of `fetch_by_date`.
- `tests/ingestion/wistia/test_parser.py` — 8 new tests for `parse_timeseries_entry` (happy path with verbatim verify-probe data, the engagement_rate-is-0-to-1 + played_time-is-seconds load-bearing contracts, timestamp→day extraction, missing/short timestamp guards, zero-activity preserves nulls, "does not touch legacy columns" — the cutover's critical invariant).
- `tests/ingestion/wistia/test_pipeline.py` — renamed `fetch_by_date` → `fetch_timeseries` across 5 existing tests; added `test_sync_post_cutover_does_not_overwrite_legacy_columns` to lock the legacy-preservation contract.
- `docs/schema/wistia_media_daily.md` — full rewrite. Now documents two distinct column groups (post-cutover live + pre-cutover deprecated), the date-semantics-gotcha, the new aggregation-layer formulas, updated example queries.
- `docs/runbooks/wistia_ingestion.md` — endpoint table updated (timeseries is the live source, by_date marked deprecated). New "Date semantics gotcha" subsection. Backfill window updated from 875d → 30d (with the history of narrowings preserved in the comment). Example queries switched to post-cutover columns. DEFERRALS section updated to remove the "engagement-rate is derived" note (it's now a direct field).

**NOT touched in this pass** (deferred to Pt 2 resume after gate (a) approval):
- `docs/state.md` — ship entry lands after migration applies + smoke + bulk-re-backfill verifies real-variance values.

## What I did, in plain English

### Acclimatization

Re-read the verification report's verdict: legacy `by_date.hours_watched` is `play_count × per-media constant` (proven by identical-to-10-decimals ratio across 27 active days); new `/modern/analytics/medias/{id}/timeseries?granularity=daily` returns real per-day variance for `played_time` + `engagement_rate` + bot-filtered `plays`. Both endpoints coexist; neither documented as deprecated; new one is clearly the Bottler-powered "good" source.

Read current `ingestion/wistia/` module state on disk (vs my memory) and the 0045 migration's exact `wistia_media_daily` column list.

### Migration 0046 design (ALTER not replace)

Per spec's recommendation. Eleven new columns:

- `played_time_seconds integer` — real per-day watch time (replaces the synthesized `hours_watched`)
- `engagement_rate numeric(6,4)` — 0-1 float, stored RAW, NOT ×100
- `play_rate numeric(6,4)` — 0-1 float
- `plays_filtered integer` — NEW column distinct from legacy `play_count` (the two endpoints disagree by ~14% per bot filtering; mixing them in one column would corrupt the series at the cutover boundary)
- `unique_plays`, `unique_visitors`, `unique_loads` — bot-filtered uniques
- `cta_impressions`, `cta_conversions`, `cta_conversion_rate`, `form_conversions` — mirror-everything-Wistia-sends per Core Principle #1; cheap to include in the same payload

All nullable defaults so pre-cutover rows have NULLs for the new columns until the migrated pipeline re-touches them.

**Legacy columns (`load_count`, `play_count`, `hours_watched`) kept** (not dropped) as historical audit. Column comments loudly mark deprecation + point at replacements. Pre-cutover values stay on existing rows; post-cutover pipeline doesn't touch them so they don't get nulled.

### Pipeline cutover

`sync_wistia` now calls `client.fetch_timeseries(start_iso, end_iso)` instead of `fetch_by_date`. The new client method takes the SAME inclusive-end signature as the old one (matching the convention used by `sync_wistia_rolling`, the cron, the backfill — all unchanged) but internally adds +1 day before hitting the new endpoint (which takes end_date EXCLUSIVE).

`parse_timeseries_entry` is the new projection function. Critical contract baked in + tested: the row dict it returns includes ONLY post-cutover columns. `load_count` / `play_count` / `hours_watched` are deliberately absent so the supabase-py upsert preserves whatever value was already on the row (post-cutover the pipeline doesn't refresh them; pre-cutover values stay as audit trail).

### Backfill window narrowed: 90d → 30d

Per spec. The cron still runs the rolling 14-day window every 3h; the manual backfill script's `BACKFILL_START` is 30d back from today. The comment in the script preserves the full narrowing history (875 → 90 → 30) so future-me can see why the floor is where it is.

### Test additions

40 wistia tests now (was 31; +8 timeseries-parser tests + 1 new pipeline test for the no-legacy-overwrite contract; 5 existing pipeline tests renamed `by_date` → `timeseries`). Full suite at 805/805 green (was 796 before this spec).

Critical test additions:
- `test_parse_timeseries_entry_engagement_rate_is_raw_0_to_1` — guards against accidentally storing ×100.
- `test_parse_timeseries_entry_played_time_is_seconds_integer` — guards against a hours-vs-seconds repeat of the `by_date` mistake.
- `test_parse_timeseries_does_not_touch_legacy_columns` — the cutover's load-bearing invariant.
- `test_sync_post_cutover_does_not_overwrite_legacy_columns` — same contract at the orchestrator level (inspects the actual upsert call's row dict).

## Verification

- **`python3 -m py_compile`** on every changed Python file — exit 0.
- **`.venv/bin/python -m pytest tests/ingestion/wistia/ tests/api/test_wistia_sync_cron.py -v`** — **40/40 passing** in 1.44s.
- **Full suite `.venv/bin/python -m pytest tests/ -q`** — **805/805 passing** in 6.79s (+9 from this spec, no regressions).
- **`.venv/bin/python scripts/backfill_wistia.py`** (dry-run) — auth OK, inventory paginated, `fetch_timeseries` returned 31 days for the test media `v1xlfys5y2` over the `2026-04-24 → today` window. (31 = 30 days back + today; client's +1-day exclusive-end conversion working as designed.) Per-day entries include `timestamp` field; for zero-activity media all other fields absent (matches the verify probe's observation — Wistia omits zero-value fields on inactive medias).
- **NOT yet verified** — the migration itself (HARD STOP for gate (a)); smoke against real DB on one media's full timeseries (depends on the migration); bulk re-backfill (Drake-gated post-smoke); the real-variance sanity check on `i1173gx76b` engagement (the whole point — should swing 2.79–25% per the verify report).

## Surprises and judgment calls

- **End_date conversion lives in the CLIENT, not the pipeline.** Cleanest place to absorb the inclusive-vs-exclusive boundary mismatch — every caller stays on the inclusive convention. Alternative (pipeline pre-adjusts before calling) would make `fetch_timeseries` callable only from one place + bury the gotcha. Documented in the client docstring + the runbook's "Date semantics gotcha" subsection.

- **`parse_timeseries_entry` returns `None` values for missing fields rather than coalescing to defaults** (different from `parse_by_date_entry` which coalesces). Reasoning: the new endpoint omits zero-value fields on inactive medias (verified during dry-run on `v1xlfys5y2` "AI Ads Bot" — only `timestamp` came back, all other fields absent). Coalescing to 0 would silently fabricate data; passing `None` through to the upsert means the column gets its DB default (0 for integers, NULL otherwise depending on schema). For the new columns I set them all nullable, so None → NULL is the correct behavior — distinguishes "Wistia returned 0" from "Wistia didn't include the field." Worth knowing for aggregation queries that should treat NULL as "no signal" rather than "zero activity."

- **Did NOT drop the legacy columns.** Spec said don't drop yet; I kept them with deprecation notes in column comments + the schema doc + the runbook. The aggregation layer needs to be told (loudly, in the schema doc) to NOT use `hours_watched` / `play_count` / `load_count` for daily metrics. If a future dashboard author misses the deprecation notes, the engagement-rate-from-hours_watched formula will silently return the constant artifact again. Tradeoff vs cleaner-state by dropping: keeping audit fidelity > columns-budget. Acceptable; revisit if confusion accumulates.

- **`fetch_by_date` retained on the client.** Spec leaned this way. The method is cheap (no runtime cost when unused) and lets future ad-hoc audit queries hit the legacy endpoint without re-implementing it. Docstring marks deprecated; the pipeline + cron + backfill all use `fetch_timeseries` exclusively.

- **Timezone bucketing alignment.** Wistia's new endpoint timestamps show `05:00:00.000Z` (e.g. `2026-04-27 05:00:00.000Z`), which is midnight EDT (UTC-4). The date portion `2026-04-27` represents EDT calendar day. Legacy `by_date` returned `"date": "2026-04-27"` directly (no time). Cross-check during verify showed identical dates on identical-content days, so the cutover boundary doesn't introduce a one-day shift. Documented in the parser docstring.

- **`engagement_rate` precision: `numeric(6,4)`.** Holds values like `0.1473` exactly. The new endpoint returns more precision than that (the probe showed `0.09078344712810592`), but 4 decimal places = 0.01% precision is way past what any dashboard would render. Tradeoff: smaller bytes per row vs full-precision audit. I'd lean keep `numeric(6,4)`; if it ever feels limiting, ALTER to `numeric` (unbounded) — cheap one-line change.

- **CTA + form columns ingested even though zero today.** Verify probe showed all-zero for these on the VSL — no CTAs configured. Per Core Principle #1 mirror-everything-Wistia-sends, kept them anyway. Cheap (1 byte per row null vs absent column). When CTAs get set up on a confirmation page or similar, the data lands automatically without a follow-up migration.

- **No `lifetime_avg_percent_watched` deprecation.** This field on `wistia_medias` is still a useful cross-check (lifetime aggregate from the legacy `/v1/medias/{id}/stats.json` — separate endpoint, accurate for what it does, not the daily artifact). Unchanged.

## Out of scope / deferred (Pt 2 resume work)

Held for after gate (a) approval:

- **Apply migration 0046** via `supabase db push --linked`.
- **Dual-verify** (schema reality + column count + ledger).
- **Smoke** — `scripts/backfill_wistia.py --smoke` on one media; verify post-cutover columns populate and pre-cutover columns aren't overwritten.
- **Bulk `--apply`** — all 80 medias × 30 days = ~2,400 rows. Drake-gated; quick (~3-5 min wall time).
- **Sanity verification:** confirm engagement_rate VARIES day-to-day for `i1173gx76b` (the whole point — should swing ~2.79% → ~25.38% per the verify report's empirical range).
- **Update `docs/state.md`** with the ship entry: migration 0046, cutover details, real-daily variance now in DB, follow-up gate-(d) status (token already in Vercel from prior ship).
- **Write `docs/reports/wistia-timeseries-migration-pt2.md`** resume report.

Held for separate / future specs:

- **Drop legacy columns** (`hours_watched`, `play_count`, `load_count`) — defer until the aggregation layer + dashboard have been stable on the new columns for a few weeks. Migration would be one-line ALTER + a state.md note.
- **Aggregation layer SQL views** for canonical-VSL aggregate / TYP per-day series — separate spec.
- **Stale-data alerting** if the cron stops working — separate spec.
- **`docs/reports/wistia-discovery.md`** is now subtly wrong on the "per-day engagement-rate is DERIVABLE" claim. Spec says don't edit that historical report; the watchtime-verify report supersedes it. Worth a one-line note pointing readers forward — but doing it would violate the spec's "no other doc edits" instruction. Leaving as-is per spec.

## Side effects

- **Wistia API:** ~12 read-only calls during the dry-run verification (one iter_medias page + one lifetime-stats + one timeseries on the test media). No writes.
- **Supabase:** zero writes (migration not applied yet → new columns don't exist). One read of `wistia_medias` during the existing-state acclimatization.
- **Local filesystem:** no `.probe-out/` dumps. `.env.local` unchanged.
- **Slack / external services:** none touched.
- **Vercel:** no deploy / cron / env changes — the cron will keep running every 3h. Until migration 0046 applies, the cron will FAIL with a column-not-found error when it tries to upsert the new fields. That's the operational window between this push and gate (a) approval — short (Drake's gate is fast historically). Audit rows will say `failed` per tick; no production damage; idempotent recovery once the migration lands.
- **No tests changed at the cron level** — the cron just calls the pipeline; the pipeline cutover is fully exercised in pipeline tests.
- **No new env vars added.**

---

## What's needed to unblock

**Drake's SQL review on `supabase/migrations/0046_wistia_timeseries_columns.sql`** (spec gate (a)).

Key things to sanity-check:

1. **ALTER vs replace decision.** Eleven new columns added to existing `wistia_media_daily`. Legacy columns kept. Pre-cutover rows have NULLs on new columns; post-cutover values populate via the migrated pipeline. Confirm OK.
2. **`engagement_rate numeric(6,4)`** — 0-1 float precision. Considered `numeric` (unbounded); chose bounded for storage discipline. Confirm or specify different precision.
3. **`plays_filtered` as a SEPARATE column from legacy `play_count`** — the two endpoints disagree by ~14% (bot/dedup filtering). Reusing the column would corrupt the series at the cutover boundary. Confirm the separate-column choice.
4. **Legacy columns deprecated but kept.** Column comments loudly say so. Aggregation layer (future) must not use them for daily metrics. Confirm or call out preference to drop them in a follow-up.
5. **CTA + form columns** included even though zero today (Core Principle #1: mirror everything). Confirm OK or remove.
6. **No new indexes** — the existing PK on `(hashed_id, day)` + `day DESC` index cover the access patterns. Confirm.

After approval the Pt 2 resume sequence is:

```bash
# 1. Apply
DB_PW=$(...)
supabase db push --linked --dns-resolver https --password "$DB_PW" --yes

# 2. Dual-verify (psycopg2 against pooler; same shape as prior migrations)

# 3. Smoke
.venv/bin/python scripts/backfill_wistia.py --smoke

# 4. Drake confirms smoke, then:
.venv/bin/python scripts/backfill_wistia.py --apply

# 5. Sanity SQL: confirm engagement_rate VARIES for i1173gx76b last 14d
#    (expect range ~2.79% → ~25.38% per the verify report)

# 6. Update state.md + write docs/reports/wistia-timeseries-migration-pt2.md
```

Pt 2 resume report goes at `docs/reports/wistia-timeseries-migration-pt2.md` per the partial-report convention; this PARTIAL stays intact.
