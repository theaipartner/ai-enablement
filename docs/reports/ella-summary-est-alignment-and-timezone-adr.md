# Report: Align Ella page summary to cost hub windows + codify timezone standard

**Slug:** ella-summary-est-alignment-and-timezone-adr
**Spec:** docs/specs/ella-summary-est-alignment-and-timezone-adr.md

## Files touched

**Created:**
- `lib/time/est-periods.ts` — canonical EST/EDT calendar-boundary module (`getEstPeriodBoundary`, `getEstOffsetMinutes`, `getEstMonthStart`), pure date math, no server dependency.
- `docs/decisions/0003-timezone-conventions.md` — the timezone standard ADR.
- `docs/runbooks/cron_schedule.md` — UTC→ET map for all `vercel.json` crons (strict-JSON workaround).
- `docs/reports/ella-summary-est-alignment-and-timezone-adr.md` — this report.

**Modified:**
- `lib/db/cost-hub.ts` — the 3 EST helpers moved out to `lib/time/est-periods.ts`; now imports `getEstPeriodBoundary` + `getEstMonthStart` from there. Pure refactor, zero logic change. `formatMonthLabel` stayed (label formatter, not a boundary).
- `lib/db/ella-runs.ts` — `getEllaSummaryStats` rewritten: EST calendar boundaries + all-LLM-cost-bearing scope; dead `skip_cost_today` + response/skip-scope machinery removed; `EllaSummaryStats` type + doc comments updated.
- `docs/state.md` — single bullet under the 2026-05-15 block.

## What I did, in plain English

This executes the fix the prior diagnostic (`docs/reports/cost-hub-vs-ella-cost-discrepancy-diagnostic.md`) pointed at.

**Task 1 (window math + shared module).** Extracted cost-hub's three EST boundary helpers verbatim into a new `lib/time/est-periods.ts` so there's one definition of "this month in ET" instead of N inline ones. Refactored `cost-hub.ts` to import them back — byte-identical functions, so cost-hub's numbers are provably unchanged (tsc + lint clean; the post-fix cross-check also confirms cost-hub still reports what it did). Then rewrote `getEllaSummaryStats`'s window math from `new Date().setHours(0,0,0,0)` + rolling-7d/30d (server-local time = UTC on Vercel) to `getEstPeriodBoundary('today'|'week'|'month')` — the same EST calendar boundaries the cost hub uses.

**Task 2 (scope).** Replaced the response-scope filter (which excluded `passive_monitor` skip-decision Haiku spend) with all-LLM-cost-bearing scope: `agent_name='ella' AND llm_cost_usd IS NOT NULL`. The summary headline now means "all Ella LLM spend," matching the cost hub's combined Ella Sonnet + Ella Haiku buckets exactly. Dropped the now-dead `skip_cost_today` field, its computation, and the whole response/skip-scope apparatus (`RESPONSE_TRIGGER_TYPES`, `isResponseScope`, `isSkipScope`, `responseRuns`, `skipRuns`) — `summary-band.tsx` never rendered `skip_cost_today`. `errors_*` widened from response-scope to "every Ella run that errored in the EST window" (judgment call — see below). `status_counts` + `anomaly_count_today` recomputed over the new scope / unchanged respectively.

**Task 3 (docs).** ADR 0003 codifies store-UTC/render-ET, the canonical period definitions, `lib/time/est-periods.ts` as the code home, crons-in-UTC with the doc-mapped ET equivalents, and explicitly bounds scope ("no codebase-wide UTC sweep"). It logs the `getEllaSummaryStats` server-local anchor as a fixed deviation. `vercel.json` is strict JSON (Vercel deploys it directly — no inline comments), so per the spec's strict-JSON branch the cron UTC→ET map lives in the new `docs/runbooks/cron_schedule.md`, covering all 6 current crons with a keep-in-sync note.

## Verification

- **tsc --noEmit:** clean (run after the cost-hub refactor, and again after the ella-runs rewrite).
- **next lint** (`lib/time`, `lib/db`): no warnings or errors.
- **pytest tests/ -q:** 607 passed — unchanged, no Python touched (sanity per acceptance criteria).
- **Post-fix cross-check** (the spec's hard-numerical threshold — cost hub Ella S+H vs new Ella summary must match within $0.01 on today/week/month). Replicated both filters against cloud `agent_runs` with EST boundaries computed identically to `lib/time/est-periods.ts`:

  | period | Cost hub (Ella S+H) | Ella summary (new) | match |
  |---|---|---|---|
  | today | 8 runs / $0.0758 | 8 runs / $0.0758 | ✅ exact |
  | week | 61 runs / $0.8974 | 61 runs / $0.8974 | ✅ exact |
  | month | 71 runs / $1.2437 | 71 runs / $1.2437 | ✅ exact |

  Delta $0.0000 and equal run counts on all three periods — well inside the $0.01 tolerance. The fix took.
- **Import-cycle check** (spec "what could go wrong"): `lib/time/est-periods.ts` has zero imports; `cost-hub.ts` and `ella-runs.ts` both depend on it one-way. No cycle (tsc would have flagged it; clean).
- **Refactor-is-pure check:** the 3 helpers were moved verbatim (diff is a pure cut/paste + import). cost-hub's `getEstPeriodBoundary`/`getEstMonthStart` call sites unchanged. Cross-check confirms cost-hub still produces its prior numbers.

## Surprises and judgment calls

- **`errors_*` scope widened beyond what the spec spelled out.** The spec was explicit about `total_*`/`cost_*` (all-cost-bearing) and silent on `errors_*`. The old code derived `errors_*` from `responseRuns`, which I removed. Rather than keep the response-scope machinery alive solely to feed errors, I recomputed `errors_*` as "every Ella run with `status='error'` in the EST window." This is *more* correct for an audit summary (error runs frequently have null `llm_cost_usd`, so they're not a `costRuns` subset — scoping errors to cost-bearing rows would *hide* failed runs, the opposite of what an "Errors" card should do) and it drops dead code. Flagging because it's a semantic change the spec didn't enumerate.
- **`status_counts` kept, not dropped.** Like `skip_cost_today` it's unrendered by `summary-band.tsx`. But the spec only greenlit dropping the *skip-cost* breakouts; `status_counts` is a separate typed public field and removing it is a type-surface change beyond the ask. I kept it and recomputed it over the new scope (one line, no type churn, no risk). Same reasoning for `anomaly_count_today` (kept, still iterates all runs).
- **`getEstMonthStart` moved too, though only cost-hub uses it.** The spec named `getEstPeriodBoundary` + `getEstOffsetMinutes` for extraction. `getEstMonthStart` is the same cohesive boundary-helper family (it calls `getEstOffsetMinutes`); splitting it off would mean a cost-hub-local function importing a helper from the shared module — an awkward half-split. Moved all three; the module's stated purpose is "EST period boundaries," which `getEstMonthStart` is. `formatMonthLabel` stayed in cost-hub (it's a label formatter, not a boundary, and only cost-hub uses it).
- **No page copy change.** The summary-band labels ("Runs · today", "X this week · Y this month") describe EST calendar periods post-fix, which is what they always implied. No "rolling" wording existed, so per the spec no copy change was needed.
- **`RESPONSE_TRIGGER_TYPES` still exists in `ella-runs.ts`** — but in `getEllaRunsList` (the table-list query), a *different* function the spec didn't touch. The response-scope concept is still correct for the run *table*; only the summary *headline* changed. Left it; not dead.

## Out of scope / deferred

- **No codebase-wide timezone audit** — ADR 0003 explicitly scopes this out (Director's call; churn without a driving need). Only the one known deviation (`getEllaSummaryStats`) was in scope and is fixed.
- **DST seasonal drift on fixed-time crons** is documented (cron_schedule.md + ADR 0003 § Consequences) but not changed — it's the accepted trade-off of UTC-scheduled crons, same as the FAQ-digest runbook already notes.
- **Drake gate (c):** eyeball `/ella/runs` and `/cost-hub` side by side post-deploy to confirm the headline figures now agree on real production data (the cross-check already proves it against cloud data; this is the visual confirmation).

## Side effects

- **No cloud writes.** The cross-check ran read-only `SELECT`s against `agent_runs` (psycopg2/pooler), then the temp script was deleted.
- **No migration, no env var changes, no Slack posts, no API spend.**
- **Vercel deploy** triggered by the push: the cost-hub refactor (no behavior change) + the `/ella/runs` summary now rendering EST-aligned all-spend figures. Both are admin/internal surfaces; no client-facing impact.
- Four commits on `main` (est-periods extraction+refactor / ella-runs alignment / ADR+cron-runbook / state.md+report).
