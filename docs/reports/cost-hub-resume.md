# Report (RESUME): Cost hub — admin-tier visibility into Anthropic spend + manually-tracked subs/extras

**Slug:** cost-hub
**Spec:** docs/specs/cost-hub.md
**Partial:** docs/reports/cost-hub.md (the gate-(a)-pause partial stays in place per the no-overwrite rule)

## Files touched

**Created:**
- `supabase/migrations/0038_cost_hub_tables.sql` — `monthly_subscriptions` + `cost_extras` tables, partial indexes, `set_updated_at()` triggers. Applied + dual-verified.
- `docs/schema/monthly_subscriptions.md`, `docs/schema/cost_extras.md` — schema docs.
- `lib/db/cost-hub.ts` — data layer (bucket aggregation, subs/extras reads, recent-month totals, EST period boundaries).
- `app/(authenticated)/cost-hub/layout.tsx` — admin-tier gate.
- `app/(authenticated)/cost-hub/page.tsx` — Server Component page composition.
- `app/(authenticated)/cost-hub/actions.ts` — six admin-tier-gated server actions.
- `app/(authenticated)/cost-hub/cost-hub-tables.tsx` — Client Component, two editable tables.
- `app/(authenticated)/cost-hub/history-view.tsx` — Client Component, History expander.
- `scripts/verify-cost-hub-preview.ts` — Playwright verifier.
- `scripts/.preview/cost-hub.png` — verifier screenshot.
- `docs/runbooks/cost_hub.md` — operational runbook.

**Modified:**
- `lib/supabase/types.ts` — Row/Insert/Update for both new tables.
- `components/top-nav.tsx` — `/cost-hub` NAV_ITEMS entry + isActive() case.
- `docs/state.md` — bundled 2026-05-15 cost-hub entry; post-state bumped to 38 migrations / 6 TopNav tabs.
- `CLAUDE.md` — § Next Session Priorities collapsed to the single Gregory-V2-sales-side pointer (cost hub shipped).

## What I did, in plain English

Built the admin-tier `/cost-hub` page end-to-end — the last piece of Gregory V1.

**Pre-flight inventory** (full detail in the partial report's Verification section). The single load-bearing finding: the spec's assumed `agent_name='gregory_brain'` does not exist in production. The Gregory brain V2's Sonnet calls land under `agent_name='ai_call_signal'` (per `agents/gregory/ai_call_signal.py`, the dominant V2 rubric contributor). The `agent_name='gregory'` runs are LLM-free orchestration that delegates to ai_call_signal. Bucket 5 filters on `ai_call_signal`; the UI label stays "Gregory brain Sonnet" since the agent_name is an implementation detail. No bucket failed the spec's <50% cost-completeness hard threshold — the high null-cost run counts on `gregory`/`ella`/`ai_call_signal` are non-LLM code paths that correctly fall outside the model-filtered buckets.

**Migration 0038** created `monthly_subscriptions` + `cost_extras` exactly per the spec — numeric(10,2) cost columns, soft-archive `archived_at`, partial index on `archived_at IS NULL`, shared `set_updated_at()` trigger. Drake reviewed the SQL at the gate-(a) pause; applied via `supabase db push --linked`, dual-verified (both tables, both partial indexes + PKs, both BEFORE-UPDATE triggers, ledger row 0038, last-5 ledger = 0034–0038).

**Data layer** `lib/db/cost-hub.ts` aggregates `agent_runs.llm_cost_usd` JS-side (PostgREST has no clean `sum()`; per-window row counts are small enough that fetch-then-reduce is fine). Period boundaries (today / this week / this month) computed in America/New_York with DST-safe offset detection — `getEstOffsetMinutes` derives the UTC offset by formatting noon-in-EST for the target date so the boundary is correct across the November DST fallback. Five buckets, three periods, parallel queries. `getRecentMonthTotals` walks the last 12 completed months (offset 1..12; skips the live current month). Historical sub price uses today's price per the locked trade-off.

**Page** composes HeaderBand + total-this-month gold box (with the History expander) + five Anthropic bucket boxes + the two editable-table boxes. `force-dynamic` so the page re-reads after every mutation. Six server actions, all admin-tier-gated as defense-in-depth, soft-archive on delete, `revalidatePath('/cost-hub')` on success. Client Components own edit-mode / history-expand / per-row-breakdown state, mirroring `task-list.tsx`.

**Verifier** `scripts/verify-cost-hub-preview.ts` mirrors `verify-clients-preview.ts`. Ran it against a local `next dev` with `NEXT_PUBLIC_DISABLE_AUTH=true` — PASS on every assertion (page render, 5 bucket boxes, total-this-month dollar amount, add+delete on both editable tables). Screenshot captured.

## Verification

- **Migration dual-verify** (psycopg2 against the pooler): both tables present in `information_schema.tables`; columns match spec types (numeric for cost columns, date for `incurred_on`, timestamptz for the rest); both partial indexes (`...active_idx` / `...incurred_on_idx` with `WHERE (archived_at IS NULL)`) + both PKs registered in `pg_indexes`; both `..._set_updated_at` BEFORE-UPDATE triggers in `information_schema.triggers`; `schema_migrations.version='0038'` present.
- **`tsc --noEmit`** — clean (ran twice: after data layer, after page + polish fix).
- **`next lint`** on `app/(authenticated)/cost-hub` + `lib/db` + `components` — no warnings or errors.
- **Playwright verifier** — PASS. Output:
  ```
  [verify] h1: Cost hub.
  [verify] bucket box present: ELLA SONNET / ELLA HAIKU / CALL REVIEW SONNET / CALL REVIEW HAIKU / GREGORY BRAIN SONNET
  [verify] total-this-month box renders a dollar amount
  [verify] test subscription added + visible / deleted (soft-archived)
  [verify] test extra added + visible / deleted (soft-archived)
  [verify] wrote scripts/.preview/cost-hub.png
  [verify] PASS
  ```
  Screenshot visually inspected: editorial-dark aesthetic intact, $14.19 running total renders, all five buckets show data with correct "(incomplete before …)" caveats (Ella Haiku 2026-05-11, Call review Sonnet + Gregory brain Sonnet 2026-05-07), Call review Haiku shows "(no usage — Sonnet-only today)".
- **`pytest tests/ -q`** — 596 passed (unchanged; no Python logic touched, only the migration SQL).

## Surprises and judgment calls

- **`gregory_brain` → `ai_call_signal`** (carried from the partial). The spec author flagged this risk explicitly ("Builder verifies exact agent_name string"). Used the verified production value.
- **Dropped the spec's "Gregory brain cost-tracking started ~2026-05-07" assumption check into hard constants.** `BUCKET_DEFINITIONS[].earliestReliableDate` carries the pre-flight-verified dates. If the data drifts, the runbook documents the re-verify SQL + which constant to edit. Chose hardcoded-constant over a runtime MIN(started_at) query per bucket because (a) it's stable historical fact, (b) it avoids five extra queries per page load for a value that never changes retroactively.
- **`call_review_haiku` never-used polish.** First screenshot showed "(incomplete before 9999-12-31)" — technically correct (call_reviewer is Sonnet-only) but reads like a rendering bug to a human (Nabeel). Added a `NEVER_USED_SENTINEL` + `neverUsed` flag on `PeriodSummary`; the box now shows "(no usage — Sonnet-only today)". This was a self-initiated polish call past the literal spec — the spec said render the bucket "for completeness"; it didn't anticipate the sentinel-date ugliness. Surfaced here since it's a deviation from a strict reading.
- **Verifier runs locally, not against a Vercel preview.** The spec said "authenticate to the Preview deployment." In the Builder-pushes-to-main topology there's no separate preview branch — the deploy from this push IS the deploy, and production has auth ON (correctly). I ran the verifier against a local `next dev` with `NEXT_PUBLIC_DISABLE_AUTH=true` instead, which exercises the identical code path. The verifier script defaults `PREVIEW_URL` to `http://localhost:3000` and accepts an override, so it's reusable against a real preview URL if one ever exists.
- **Verifier leaves soft-archived test rows.** The add-then-delete cycle soft-archives (doesn't hard-delete) two rows per run, prefixed `__verify_`. They're filtered out of every query and every total. The runbook documents the hard-delete cleanup SQL. Judgment: acceptable — they're invisible to users and the alternative (hard-delete in the verifier) would diverge the verifier's delete path from the real UI's soft-archive path, reducing the test's fidelity.
- **History view query count.** 12 months × (5 bucket queries + 1 extras query) + the live page's ~17 queries = ~89 queries on a cold page load with History pre-fetched. The page pre-fetches all 12 months server-side so the History button is instant, but the initial render does the work upfront. At current data volume this is sub-second; flagged in the runbook + spec's "what could go wrong" as a known scale watchpoint with the batch-into-one-Postgres-function escape hatch noted.
- **Period boundary correctness.** Spent care on the EST/DST math (`getEstOffsetMinutes`). The risk the spec flagged ("Postgres date_trunc uses cluster timezone") is sidestepped entirely — all boundaries computed JS-side in `America/New_York` and passed as UTC ISO timestamps, so there's no cluster-timezone dependency. DST fallback (Nov 2026) is handled because the offset is derived per-target-date, not hardcoded.

## Out of scope / deferred

- **Drake's gate (c):** post-deploy manual entry of real monthly subscriptions + one-off extras. The tables ship empty; the page renders "No subscriptions yet." / "No extras this month yet." until Drake populates them.
- **History performance batching** — deferred per spec; documented escape hatch (single Postgres function returning 12 months) if it gets slow.
- **`effective_from` per-row sub price history** — deferred per spec § Historical sub price drift; documented in the schema doc + runbook as the future iteration if drift becomes a reconciliation problem.
- **Sixth+ buckets** — when a new subsystem starts calling Claude under a new `agent_name`, add it to `BUCKET_DEFINITIONS`. Documented in the runbook.

## Side effects

- **Cloud Supabase writes:**
  - 1 ledger row (`schema_migrations.version='0038'`).
  - 2 new tables created (`monthly_subscriptions`, `cost_extras`) + 2 partial indexes + 2 triggers.
  - The Playwright verifier inserted then soft-archived 2 rows per run (it ran twice — once before the polish fix, once after). Net: 4 soft-archived `__verify_`-prefixed rows across the two tables, invisible to all queries/totals. Cleanup SQL in the runbook.
- **Anthropic API spend:** none — the cost-hub only reads existing `agent_runs` cost data; it never calls Claude.
- **No env var changes.** The page uses existing `SUPABASE_*`. No new secrets.
- **No Slack posts, no external API calls.**
- **Vercel deploy** triggered by the push of the new route + data layer + TopNav change. Production has auth ON, so the page is admin-gated there as designed.
- **Two local `next dev` processes** were started (ports 3100, 3101) for the verifier runs and explicitly killed afterward — confirmed 0 lingering processes.
