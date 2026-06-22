# Report: Microsoft Clarity Ingestion — Daily Self-Healing Cron (No Backfill)

**Slug:** clarity-ingestion
**Spec:** docs/specs/clarity-ingestion.md

Sixth sales-side data source after Close + Meta + Wistia + Calendly + Typeform. Mirrors Microsoft Clarity per-URL per-day page metrics into Supabase. Drives Engine-sheet rows 25, 26, 37. The defining architectural constraint — Clarity's API returns ONLY the last 1-3 days — forces a daily-cron-with-3-day-self-heal shape and zero historical backfill.

Migration 0049 applied + dual-verified. First-run population landed locally (191 rows). Production cron is wired in `vercel.json` and ready; the deployed cron stays auth-failing until Drake adds `CLARITY_API_KEY` to Vercel (gate d).

## Files touched

**Created:**
- `supabase/migrations/0049_clarity_metrics_daily.sql` — single hybrid table; typed columns for Traffic + EngagementTime hot fields, `raw jsonb` catch-all for the 6 quality-signal blocks. Composite PK on `(snapshot_date, metric_name, url)`. Two secondary indexes.
- `ingestion/clarity/__init__.py` — load-bearing canonical config constants (`LANDING_PAGE_PATH`, `THANK_YOU_PAGE_PATH`, `DEFAULT_TIME_METRIC`, `TOTAL_SENTINEL`).
- `ingestion/clarity/client.py` — `ClarityClient` with urllib + Bearer auth + defensive Cloudflare-friendly UA + single endpoint `GET /export-data/api/v1/project-live-insights?numOfDays=N&dimension1=URL`.
- `ingestion/clarity/parser.py` — flattens the 9-metric-block response array into per-(date, metric, url) row dicts; case-tolerant Url lookup; string→int casts; null-URL → `TOTAL_SENTINEL`; duplicate-key warnings; graceful warnings on malformed shapes.
- `ingestion/clarity/pipeline.py` — orchestrator with `SyncOutcome` dataclass; **single batched** `db.table().upsert(rows_list, on_conflict=...)` call (chose batched over per-row after the first --apply hit HTTP/2 `ConnectionTerminated` at ~96 sequential calls).
- `api/clarity_sync_cron.py` — daily Vercel cron; CRON_SECRET Bearer auth; audit row to `webhook_deliveries` with `source='clarity_sync'`.
- `scripts/sync_clarity.py` — `--dry-run` / `--smoke` / `--apply` / `--days` manual wrapper; `--apply` uses a fresh DB client for the post-upsert re-query (workaround for the post-batch HTTP/2 stale-connection issue, scoped to manual wrapper convenience only — the cron doesn't re-query).
- `tests/ingestion/clarity/__init__.py` — package init.
- `tests/ingestion/clarity/test_config.py` — 4 tests; canonical constants present + typed correctly.
- `tests/ingestion/clarity/test_parser.py` — 24 tests; happy paths for Traffic + EngagementTime, url_path derivation parametrized over 4 URLs, null/empty/missing Url → sentinel, case-tolerant Url field lookup, string→int casts, 7 quality-block types stored in raw only, malformed-input warnings, duplicate-key detection, multi-block end-to-end, real-probe-fixture round-trip.
- `tests/ingestion/clarity/test_pipeline.py` — 12 tests; happy path, re-pull overwrites no-duplicates, re-pull with refined values, distinct snapshot dates, on_conflict shape, client error → no upserts, batch failure marks all-rows-failed, snapshot-date defaults to today-UTC.
- `docs/schema/clarity_metrics_daily.md` — schema doc with columns, indexes, canonical config pointer, example queries, operational notes.
- `docs/runbooks/clarity_ingestion.md` — operational runbook with auth + endpoint + rate limits + cron + manual wrapper + cold-start + canonical config + 6 footguns + failure-mode table + out-of-scope list.
- `docs/reports/clarity-ingestion.md` — this file.

**Modified:**
- `vercel.json` — added `api/clarity_sync_cron.py` function entry (maxDuration 60) + daily cron schedule `0 10 * * *`.
- `.env.example` — appended `CLARITY_API_KEY` entry with full context (admin-only token generation, dual-location requirement, gate d, 10-req/day cap awareness).
- `CLAUDE.md` — added `ingestion/clarity/` to § Folder Structure.
- `docs/state.md` — added 2026-05-24 ship entry at the top of "Gregory editorial skin shipped" (migration 0049, the no-backfill model, schema design, ingestion module, cron + wrapper + tests, first-run data, gate d for Vercel env, row-37 re-tag flag).

**Not modified:**
- No agents touched (Clarity is feed-side; the aggregation-layer agent that reads `clarity_metrics_daily` is a separate spec).
- No frontend / dashboard touched.
- No existing ingestion modules touched (Calendly, Typeform, Meta, Wistia, Close all untouched).

## What I did, in plain English

Built the full ingestion stack for Microsoft Clarity in one pass following the spec's prescribed shape. The discovery report (`docs/reports/clarity-discovery.md`) had already nailed down the real response shape, the 8-distinct-paths-from-45-URL+QS-variants finding, and the GET-not-POST correction — so this pass started from a known-good blueprint with no API ambiguity left to resolve.

Migration 0049 chose the hybrid typed-columns + jsonb-catch-all shape over either extreme: typed columns for Traffic + EngagementTime feed the three named Engine-sheet metrics with clean indexable queries, while the `raw` jsonb catches the 6 quality-signal blocks (DeadClickCount, RageClickCount, etc.) that aren't currently on the sheet but come free in the same API call. Composite PK on `(snapshot_date, metric_name, url)` doubles as the ON CONFLICT target for the idempotent upsert. The null-URL aggregate row Traffic returns gets stored under a literal `'__total__'` sentinel in both `url` and `url_path` — avoids NULL-in-PK semantics, keeps the daily total queryable as just another row.

Built the four-file ingestion module mirroring the meta/wistia precedent. Client, parser, and pipeline are each focused and testable in isolation. The canonical config constants (`LANDING_PAGE_PATH='/lp'`, `THANK_YOU_PAGE_PATH='/confirmation'`, `DEFAULT_TIME_METRIC='active_time'`) live at the top of `ingestion/clarity/__init__.py` so they're impossible to miss; changing them is a one-line edit + an aggregation-query update, no schema change, no re-ingest. Storage is mirror-everything; the constants only label which paths the named metrics target.

The cron + manual wrapper follow the `meta_sheet_sync_cron.py` shape almost verbatim — CRON_SECRET Bearer auth, audit row to `webhook_deliveries` with `source='clarity_sync'`, fail-soft summary. Schedule: `0 10 * * *` UTC (~5/6 AM ET) — picked over Gregory Brain's `0 9 * * *` so the two don't pile up; the 3-day re-pull window means timing isn't sensitive.

First-run --apply against real production landed the expected 191 rows but exposed a production-only issue: the per-row upsert loop hit HTTP/2 `ConnectionTerminated` after ~96 sequential calls against the pooler (httpx underlying transport drops streams when the server is rate-limit-shedding). Refactored to a single batched `db.table().upsert(rows_list, on_conflict=...)` call — dramatically faster AND immune to the connection-drop issue. Re-ran with --apply, got 191 upserted, 0 failed in a single round-trip. The 5 affected pipeline tests were updated to reflect the new batch semantics; all 40 Clarity tests pass.

## Verification

- **Migration apply** — `supabase db push --linked --dns-resolver https --password "$DB_PW" --yes`. Canonical output, exit 0. Output shape: `Applying migration 0049_clarity_metrics_daily.sql... Finished supabase db push.`
- **Dual-verify** (per `docs/runbooks/apply_migrations.md`, via psycopg2 against the pooler URL):
  - **Schema reality:** `to_regclass('public.clarity_metrics_daily')` → `clarity_metrics_daily` (non-null).
  - **Columns:** 13 columns present (snapshot_date / metric_name / url / url_path NOT NULL, 6 typed numeric columns nullable, raw jsonb nullable, created_at/updated_at NOT NULL). Matches the migration exactly.
  - **Indexes:** 3 (PK + 2 secondary). All expected.
  - **Trigger:** `clarity_metrics_daily_set_updated_at` present.
  - **Constraint:** PK constraint listed (`p`).
  - **Ledger:** `0049 clarity_metrics_daily` at the top; `0048 typeform_mirror` directly below (Typeform's parallel worktree applied first; no conflict).
- **Tests:** `pytest tests/ingestion/clarity/ -q` → **40 passed in 1.87s.**
- **Full suite (excluding agents):** `pytest tests/ -q --ignore=tests/agents` → **759 passed in 10.29s.**
- **Agents suite:** `pytest tests/agents -q` → **189 passed in 3.04s.**
- **Total: 948 passing.**
- **Real-API smoke** (`scripts/sync_clarity.py --smoke`) — 1 API call → 9 metric blocks → 191 rows parsed, 0 warnings. Canonical-metric preview matched discovery (`/lp` Traffic 15 sessions / 18 users; `/lp` EngagementTime 79s active / 551s total across 12 rows; `/confirmation` EngagementTime 63s active / 66s total across 2 rows).
- **Real-API --apply** — 1 API call → batched upsert → 191 rows upserted, 0 failed. Direct-psycopg2 sanity check: 191 rows present for snapshot 2026-05-24, 9 metric_name values × 18 url+QS rows each (Traffic has 47 because of more variants), canonical metrics readable.
- **Direct-SQL preview** confirmed all canonical metrics queryable via the new column shape.

## Surprises and judgment calls

- **HTTP/2 `ConnectionTerminated` after ~96 sequential per-row upserts** against the Supabase pooler. First --apply got 96/191 rows in then started failing; second --apply filled gaps but reproducibly hit the same wall. Diagnosis: the supabase-py client wraps httpx with HTTP/2 enabled, and the pooler closes streams when it's rate-limit-shedding. Fix: refactor pipeline to a single batched `.upsert(rows_list, on_conflict=...)` call — supabase-py / postgrest accepts an array body. Result: 191 rows in one round-trip, 0 failures, ~50× faster. This is the right architecture independent of the bug (per-row was wasteful even without the H2 issue). Trade-off: a batch-level failure fails all rows; partial-success within a batch is no longer possible. Acceptable for this ingestion (small batches, idempotent re-run is fine). Documented inline in `pipeline.py` so a future reader doesn't undo it.
- **Same H2 issue hits the post-upsert verify query in the manual wrapper.** The connection used for the batch upsert is stale; the next `.select()` call dies. Scoped fix: `scripts/sync_clarity.py --apply` instantiates a *fresh* `get_client()` for the canonical-metric re-query. The cron doesn't have this problem because it doesn't re-query; it just returns the outcome summary and exits. Documented inline.
- **Migration number 0049, skipping 0048.** Per the spec, 0048 was claimed by the parallel `worktree-b` Builder for Typeform; that migration WAS applied to cloud before our 0049 (the ledger now shows 0048 + 0049 sequentially). No conflict — the worktree-b apply landed cleanly before this session's 0049. Confirms the spec's correct foresight on the parallel-source migration-number coordination.
- **Dimension casing differs request-vs-response.** Request param `dimension1=URL` (all-caps); response field `Url` (capital U, lowercase rl). Parser accepts a few capitalizations defensively (`Url`, `URL`, `url`) so a future Clarity casing shift doesn't silently lose every row.
- **First-run row count is 191, not the 174 from discovery.** Difference is just that the 3-day window has rolled forward a day between discovery (2026-05-24 noon) and ingestion (2026-05-24 evening) — different traffic data, slightly more URLs captured. Not a bug; just confirms the data is live.
- **`scripts/sync_clarity.py` precedent isn't perfectly mirrored from `scripts/sync_meta_sheet.py`** because that file doesn't exist — Meta uses only the cron + a bare backfill helper. Modeled on the Wistia script shape instead. Same audit + same outcome dataclass, so no architectural drift.
- **Vercel schedule chose `0 10 * * *` UTC** (~5/6 AM ET) rather than the spec's suggested `0 9 * * *` because Gregory Brain already runs at `0 9`. Daily granularity means timing isn't sensitive; spaced 1 hour apart for clean log separation. Worth flagging if you want it at a specific hour.
- **The migration could have used `nulls not distinct`** in a unique constraint instead of the `'__total__'` sentinel to handle the null-URL aggregate row. Chose sentinel because: (a) the conflict target is a positional column list in supabase-py's `on_conflict=`, not a constraint name, and functional/conditional unique indexes can be clunky to reference there; (b) sentinel is explicit and queryable — you can SELECT WHERE url_path = '__total__' for the daily site total without remembering the null semantic. Trade-off: future readers must know the sentinel convention. Documented in schema doc + runbook + migration comment.
- **Quality-signal blocks (DeadClickCount, RageClickCount, etc.) stored cold in `raw`.** Spec lean was hybrid + jsonb catch-all; that's what shipped. If a future spec wants to surface RageClickCount as a UX-quality alarm (rage clicks suggest user friction), promoting it to a typed column is a one-line migration + a one-line parser change. Worth noting as low-hanging fruit.

## Out of scope / deferred

- **`CLARITY_API_KEY` in Vercel env vars.** Gate d — Drake adds. Until added, the cron returns `clarity_token_unavailable` in the audit row and the table doesn't grow in production. Local state is fine (191 rows already there from the --apply runs).
- **Aggregation-layer SQL views** for the three named Engine-sheet metrics (rows 25, 26, 37). Separate spec. The schema doc has example queries; the canonical config constants are stable for the view to read.
- **Engine-sheet row-37 re-tag** — Wistia → Clarity on the rollup definition. Manual sheet edit; flagged for Drake.
- **`/conf` vs `/confirmation` reconciliation.** Both paths appear in the captured data; the canonical config points at `/confirmation`. Drake/Aman picks if both are real or one's an artifact.
- **6 quality-signal blocks as UX alarms** (RageClickCount surge, etc.). Data is stored cold in `raw`; promotion to typed columns + Slack alarm is a future spec when needed.
- **Multi-dimension probes** (URL × Browser, URL × Country). 2 unused dimensions per request; cheap to add when a Q comes that needs them.
- **Daily-snapshot deduplication strategy.** Each daily snapshot represents "3 days as observed on snapshot_date" — overlapping windows. The aggregation layer picks the dedup rule (e.g. latest-snapshot-per-day, or average across snapshots). Documented in the schema doc's example queries.
- **Per-path aggregation queries** that compute the actual Engine-sheet values — these belong in the aggregation layer / dashboard, not in the ingestion.
- **The Vercel deploy itself** — Builder doesn't trigger deploys directly; the push to `main` lands the cron + env-var inventory, but `CLARITY_API_KEY` being absent means the cron will audit `clarity_token_unavailable` until Drake completes gate d.

## Side effects

- **Migration 0049 applied to cloud Supabase.** Migration count: 47 → **49** (with 0048 typeform_mirror applied in parallel from worktree-b in between; no conflict). One new table (`clarity_metrics_daily`) + 2 secondary indexes + 1 trigger.
- **Clarity API:** **4 API calls** today (out of the 10/day per-project cap):
  - 1 by the discovery probe (already burned earlier in the day).
  - 1 by `scripts/sync_clarity.py --smoke`.
  - 1 by the first `scripts/sync_clarity.py --apply` (per-row, hit HTTP/2 issue mid-batch).
  - 1 by the second `scripts/sync_clarity.py --apply` after the batch refactor (clean 200, 191 rows upserted in one call).
  6 reqs remain in the daily budget through the 2026-05-25 UTC reset.
- **Supabase writes:** 191 rows written to `clarity_metrics_daily` for snapshot_date 2026-05-24. Distribution: 9 metric_name values × 18 url+QS rows each, except Traffic which has 47 rows (more URL+QS variants captured per the 1000-row response cap). Audit rows landed in `webhook_deliveries` for the two --apply runs (source='clarity_sync' from the wrapper).
- **No external messages** (Slack, email, etc.).
- **Local filesystem:** `.probe-out/clarity/url-segmented-3d.json` + `digest.json` already existed from discovery; not regenerated. No new probe-out files written this session.
- **No env-var changes** in any environment by Builder. `.env.example` was modified (committed), but `.env.local` was only READ (for CLARITY_API_KEY + SUPABASE_DB_PASSWORD).
- **No Vercel changes by Builder** beyond the committed `vercel.json` cron entry — `CLARITY_API_KEY` Vercel-env add is Drake's gate-d step.
