# Report (PARTIAL): Wistia Ingestion — Data Model + Backfill + Live Cron

**Slug:** wistia-ingestion
**Spec:** docs/specs/wistia-ingestion.md
**Discovery:** docs/reports/wistia-discovery.md
**Status:** halted — awaiting Drake's SQL review on migration 0045 (gate (a)). All code + tests + docs in place. Dry-run end-to-end against live Wistia is green. Only the migration apply + smoke + bulk backfill remain.

## Files touched

**Created:**
- `supabase/migrations/0045_wistia_ingestion_tables.sql` — two new mirror tables (`wistia_medias` reference + `wistia_media_daily` time-series).
- `ingestion/wistia/__init__.py` — module docstring.
- `ingestion/wistia/client.py` — stdlib-urllib Bearer-auth client; the three endpoints (medias paginated, projects paginated, by_date with the required `X-Wistia-API-Version: 2026-03` header); 503 back-off (Wistia rate-limit signal).
- `ingestion/wistia/parser.py` — pure projection (raw fields → row dicts); zero derivations (engagement-rate + avg-view-duration belong to the aggregation layer per spec).
- `ingestion/wistia/pipeline.py` — orchestrator (`sync_wistia`); fail-soft per media; `SyncOutcome` dataclass; `sync_wistia_rolling` convenience wrapper for the cron's rolling 14-day window.
- `api/wistia_sync_cron.py` — Vercel serverless cron mirroring `api/meta_sheet_sync_cron.py` shape; 14-day rolling window; `CRON_SECRET` bearer auth; audit row to `webhook_deliveries` with `source='wistia_sync'`.
- `scripts/backfill_wistia.py` — `--smoke` / `--apply` / `--limit` modes per the operational convention. Backfill window starts at `2024-01-01` (~875 days as of today).
- `tests/ingestion/wistia/__init__.py` — pytest discovery marker.
- `tests/ingestion/wistia/test_parser.py` — 13 parser tests (live-shape payloads, missing-payload graceful degrade, project-lookup fallback, zero-activity-day handling, the LOAD-BEARING hours-not-seconds unit guard).
- `tests/ingestion/wistia/test_pipeline.py` — 9 pipeline orchestration tests (happy path, lifetime-stats failure still writes inventory, by_date fail-soft, iter_medias fatal, max_medias cap, projects-failure-is-warning, rolling-window math, outcome defaults).
- `tests/api/test_wistia_sync_cron.py` — 9 cron-shell tests (6 auth + 3 orchestration covering token-missing path, happy-path audit shape, error truncation).
- `docs/schema/wistia_medias.md` — full column reference.
- `docs/schema/wistia_media_daily.md` — full column reference + the engagement-rate / avg-view-duration derivations.
- `docs/runbooks/wistia_ingestion.md` — source / auth / cron cadence / failure modes / verification queries / explicit DEFERRALS list.

**Modified:**
- `vercel.json` — added `api/wistia_sync_cron.py` per-file runtime (`maxDuration: 300` for headroom on Wistia API latency) + cron schedule `30 */3 * * *` (offset from the meta sync's `0 */3` to avoid traffic-spike overlap).
- `CLAUDE.md` — § Folder Structure adds `ingestion/wistia/`.
- `.env.example` — added `WISTIA_API_TOKEN` entry (Bearer auth, Account-Owner-only token page, required in BOTH `.env.local` AND Vercel).

**NOT touched in this pass** (deferred to Pt 2 resume after gate (a) approval):
- `docs/state.md` — ship entry lands after migration applies + smoke + bulk-backfill row count is known.

## What I did, in plain English

### Acclimatization

Re-confirmed the discovery findings (`docs/reports/wistia-discovery.md`):
- Per-day stats ARE available via `/modern/stats/medias/{id}/by_date` (requires `X-Wistia-API-Version: 2026-03` header).
- Per-day endpoint returns volume metrics only — `{date, load_count, play_count, hours_watched}`. Engagement-rate + avg-view-duration are DERIVED.
- `hours_watched` is in HOURS as float, NOT seconds (load-bearing — pre-converting in ingestion would double-multiply downstream).
- ~80 medias in the account; trivial volume.
- Wistia returns HTTP 503 (not 429) on rate-limit, no Retry-After header.

Tree clean before start; next migration is 0045 (matches the spec).

### Migration 0045

Two tables:

- **`wistia_medias`** (reference, `hashed_id` PK, ~80 rows): name, duration_seconds, project_id/name, media_type, five lifetime-aggregate columns from `/v1/medias/{id}/stats.json` for cross-check, Wistia-side created/updated timestamps, + standard lifecycle + `set_updated_at` trigger.

- **`wistia_media_daily`** (time-series, composite PK `(hashed_id, day)`): load_count + play_count + hours_watched + lifecycle. **`hours_watched` documented in the column comment as HOURS not seconds**. PK covers per-media-per-day point lookups + per-media DESC scans; secondary index on `day DESC` for cross-video daily rollups.

Loose FK posture on `wistia_media_daily.hashed_id` → `wistia_medias.hashed_id` (no hard constraint; backfill order isn't guaranteed; aggregation layer left-joins). Same pattern as `close_calls` / `close_sms`.

### Module + cron + backfill

Pattern is a direct shape-clone of `ingestion/meta/`:

- **`client.py`** — stdlib `urllib`, Bearer auth, `MODERN_API_VERSION = "2026-03"` pinned on by_date calls. 503 back-off mirrors the discovery probe's posture (exponential, 3 tries).
- **`parser.py`** — `parse_media(media_json, stats_json, project_name_by_id)` + `parse_by_date_entry(hashed_id, entry)`. Pure projection. `hours_watched` stays in HOURS. `project_id` coerced to text (Wistia returns int; we store text). Lifetime-stats payload-missing → graceful (inventory row lands without lifetime fields).
- **`pipeline.py`** — `sync_wistia(client, db, start_date, end_date, max_medias=None)` orchestrator. Per-media fail-soft (stats 404 → warning, inventory still lands; by_date failure → error in outcome, other medias continue). `SyncOutcome` carries counts + window + warnings + errors. `sync_wistia_rolling(window_days=14)` for the cron.
- **`api/wistia_sync_cron.py`** — Vercel cron mirroring `meta_sheet_sync_cron`. 14-day rolling window per tick. Audit row to `webhook_deliveries` with truncation (errors capped to 50 in the audit payload, with `errors_truncated: true` flag).
- **`scripts/backfill_wistia.py`** — three modes (dry-run / smoke / apply). Smoke writes the full inventory + one media's per-day stats over the wide 2024-01-01 → today window. Required before bulk `--apply`. Dry-run already verified end-to-end (875 days returned for the test media; auth + endpoints all wired correctly).

### vercel.json cron schedule

`30 */3 * * *` — every 3 hours at the **30-minute mark**, offset from `meta_sheet_sync_cron`'s `0 */3 * * *` so the two analytics syncs don't traffic-spike simultaneously. Reuses `CRON_SECRET` (no new auth env var); requires `WISTIA_API_TOKEN` in Vercel env (gate (d), called out below).

`maxDuration: 300` for headroom on Wistia API latency. Per-tick budget: 1 projects + 80 inventory + 80 lifetime-stats + 80 by_date = ~163 calls, ~27% of 600/min quota.

### Documentation

- Two schema docs covering columns + derivations + example queries.
- One runbook covering source/auth/cadence/failure-modes/verification + an explicit DEFERRALS section listing what the aggregation layer is responsible for (canonical-VSL selection, engagement-rate semantic confirmation, etc.).
- `.env.example` entry calls out the dual-location requirement (both `.env.local` for backfill AND Vercel for cron) — Drake's gate-(d) action.
- `CLAUDE.md` § Folder Structure adds `ingestion/wistia/`.

## Verification

- **`python3 -m py_compile`** on every new file — exit 0.
- **`.venv/bin/python -m pytest tests/ingestion/wistia/ tests/api/test_wistia_sync_cron.py -v`** — **31/31 passing** in 2.54s.
- **Full suite: `.venv/bin/python -m pytest tests/ -q`** — **796/796 passing** in 10.14s (+31 from this spec, no regressions).
- **`.venv/bin/python scripts/backfill_wistia.py`** (dry-run) — auth OK, iter_medias works (peeked 10 medias including `v1xlfys5y2` "AI Ads Bot"), by_date works for the full 875-day window (`2024-01-01` → `2026-05-24`), zero-activity days return zeros as designed. Full ingestion path wired up end-to-end.
- **NOT verified yet** — migration apply (HARD STOP for gate (a)), smoke against real DB (requires migration applied first), bulk backfill (Drake-gated post-smoke).

## Surprises and judgment calls

- **`maxDuration: 300` on the cron instead of 60.** The teams-calendar / meta-sync crons use 60; I bumped to 300 because Wistia's by_date computation walks events server-side and could be slower on big-traffic medias. The per-tick budget (~163 calls × ~300ms each) is ~50s in steady state but a single 503-backoff (5s) on a few medias could push past 60. 300 gives plenty of headroom while still well under Vercel's 900s limit. Easy to dial down if it proves overkill.
- **`hours_watched` stays in HOURS deliberately.** Documented in three places: the migration column comment, the parser docstring, and a dedicated test (`test_parse_by_date_hours_watched_units_are_hours_not_seconds`). The temptation to pre-convert to seconds is real and would silently double-multiply when the aggregation layer applies its own `× 3600` based on Wistia's documented unit. Tests guard against drift.
- **Backfill window starts at 2024-01-01.** Discovery noted no documented `start_date` ceiling, but a literally-unbounded backfill is silly. Picked a sane account-creation-era floor that covers everything currently of interest (~875 days). If older history is ever needed, bump `BACKFILL_START` in `scripts/backfill_wistia.py` and re-run (idempotent).
- **80 medias ingested, not scoped to "relevant" ones.** Per Drake's spec decision — mirror everything per Core Principle #1, decide what to use at aggregation time. Base 44 / Old VSL / future-funnel videos come along for free at ~30 KB total payload per media history. The canonical-VSL/TYP selection lives in the aggregation layer.
- **Engagement-rate is NOT stored.** Pre-computing it in ingestion would lock the canonical-VSL decision (which two VSLs to combine? include Base 44?) into the mirror, which the spec explicitly forbids. Aggregation layer computes per-day from raw volume + media duration. The `lifetime_avg_percent_watched` cross-check stays as an integer percentage in `wistia_medias` for sanity-checking but is NOT the source of truth.
- **Project IDs stored as text.** Wistia returns project IDs as integers (e.g. `10515824`), but storing as text matches the cross-table convention (close_leads, close_opportunities all use text IDs). Parser coerces.
- **Lifetime stats failure on a per-media basis is a WARNING, not an error.** The inventory row lands without lifetime fields — they're a cross-check, not the source of truth. Tested via `test_sync_lifetime_stats_failure_still_writes_inventory`. This shape lets a partial-Wistia-outage still update inventory.
- **Project-list fetch failure is also a warning.** Most media payloads include `project.name` inline; the `/projects.json` lookup is a fallback. Tested via `test_sync_projects_failure_is_warning_not_error`.
- **Cron interval is 3h, same as Meta.** Discovery + spec didn't specify a different cadence. 3h is the comfortable middle — Wistia's late-arriving event counts settle within hours, and the rolling-window self-heal means a missed tick costs at most one cron interval of staleness.
- **Pipeline orchestration is intentionally serial, not parallel.** Per-media calls run one at a time, not concurrently. Rate-limit safety + Vercel-cron simplicity > marginal speed. If we ever need to ingest 1000+ medias, parallelize with a connection-pool + 429 backoff in the client.
- **No standalone audit-row insert for inventory-only refresh.** Sync writes one audit row per tick covering the whole cycle (inventory + per-day). If we want separate observability for "inventory refresh failed but daily worked," that'd be a future refinement; today the cron logs both in one row.

## Out of scope / deferred (Pt 2 resume work after gate (a) approval)

- **Apply migration 0045** via `supabase db push --linked` per `docs/runbooks/apply_migrations.md`.
- **Dual-verify** (schema reality via `to_regclass` on both tables + ledger via `supabase_migrations.schema_migrations`).
- **Add `WISTIA_API_TOKEN` to Vercel env vars** (gate (d) — Drake adds, redeploys).
- **Smoke `scripts/backfill_wistia.py --smoke`** against real DB on one media end-to-end. Drake confirms result.
- **Bulk `--apply`** for full-history backfill (~80 medias × 875 days = ~70k rows max).
- **Manual cron trigger** via Vercel dashboard to verify the rolling-window 14-day refresh works against now-populated tables.
- **Update `docs/state.md`** with the ship entry.
- **Write `docs/reports/wistia-ingestion-pt2.md`** resume report.

Held for future specs (separate Director scope):
- **Aggregation layer + dashboard surfaces** — engagement-rate + avg-view-duration derivations, canonical-VSL/TYP picks.
- **Stale-data alerting** if the cron fails silently.
- **Visitor / unique-viewer per-day metrics** — current by_date endpoint doesn't expose them.
- **Inventory-refresh decoupling** from the per-day cron (negligible cost today; revisit if media count grows 10×).

## Side effects

- **Wistia API:** ~12 read-only calls during the dry-run smoke (1 projects-list (not called in dry-run), 1 inventory page, 1 by_date for 1 media over the 875-day window). No writes. Well under 600/min quota.
- **Supabase:** zero writes (migration not applied yet → tables don't exist). One read of project metadata during landscape check.
- **Slack / external services:** none touched.
- **Local filesystem:** no `.probe-out/` dumps in this spec (discovery probe already populated `.probe-out/wistia/` in the prior pass).
- **No `.env.local` modifications.** Token read-only.
- **Vercel:** `vercel.json` edited (per-file runtime + cron schedule for `wistia_sync_cron`). On push the function deploys + cron registers. Cron will fire every 3h but will fail with `wistia_token_unavailable` until `WISTIA_API_TOKEN` lands in Vercel env (gate (d)). No operational damage — audit rows will just say `failed`.
- **No new env vars added** to Vercel in this pass. `WISTIA_API_TOKEN` is documented but adding to Vercel is gate (d).

---

## What's needed to unblock

**Drake's SQL review on `supabase/migrations/0045_wistia_ingestion_tables.sql`** (spec gate (a)).

Key things to sanity-check:

1. **`wistia_medias` shape.** `hashed_id` PK; 15 columns (5 inventory + 5 lifetime cross-check + 2 Wistia timestamps + 3 lifecycle); `set_updated_at` trigger; one secondary index on `project_id`. ~80 rows expected.
2. **`wistia_media_daily` shape.** Composite PK `(hashed_id, day)`; load_count/play_count/hours_watched (NOT NULL, defaults to 0); `hours_watched` is `numeric` storing HOURS (column comment loudly says so). Secondary index on `day DESC` for cross-video rollups.
3. **Loose-FK posture** — `wistia_media_daily.hashed_id` is NOT a hard FK to `wistia_medias`. Same pattern as close_calls / close_sms. Confirm OK.
4. **Index choices** — PK covers per-media access, secondary day-DESC covers cross-video daily aggregates. Confirm or call out what's missing.
5. **`maxDuration: 300` on the cron** (vs 60 for teams/meta) — reasoning in Surprises above. Confirm OK or specify a different cap.
6. **Cron schedule `30 */3 * * *`** — offset from meta's `0 */3` to avoid spike overlap. Confirm.

After approval, the Pt 2 resume sequence is:
```bash
# 1. Apply
DB_PW=$(...)
supabase db push --linked --dns-resolver https --password "$DB_PW" --yes

# 2. Dual-verify (psycopg2 against pooler — same shape as 0043/0044 verification)

# 3. Add WISTIA_API_TOKEN to Vercel env vars (gate (d) — Drake)

# 4. Smoke
.venv/bin/python scripts/backfill_wistia.py --smoke

# 5. Drake confirms smoke result, then:
.venv/bin/python scripts/backfill_wistia.py --apply

# 6. Manual cron trigger from Vercel dashboard to verify rolling-window refresh

# 7. Update state.md + write docs/reports/wistia-ingestion-pt2.md
```

Pt 2 resume report goes at `docs/reports/wistia-ingestion-pt2.md` per the partial-report convention; this PARTIAL stays intact.
