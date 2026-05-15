# Align Ella page summary to cost hub windows + codify timezone standard
**Slug:** ella-summary-est-alignment-and-timezone-adr
**Status:** in-flight

Three bundled tasks per the bundling escape valve (single related concern: cost-figure alignment between cost hub and Ella page).

1. **Code fix:** `getEllaSummaryStats` window math → EST calendar periods matching cost hub.
2. **Scope fix:** Ella page summary headline includes all LLM-cost-bearing Ella runs (including `passive_monitor` skip-decision Haiku spend) so it matches cost hub Ella Sonnet + Ella Haiku totals exactly.
3. **Doc work:** New ADR codifying the timezone standard + audit `vercel.json` crons to ensure each carries an EST-equivalent comment.

## Context Builder needs

Read these first, confirm understanding in 4-5 bullets:

- `lib/db/ella-runs.ts:1194-1295` — `getEllaSummaryStats()` — the function this spec changes. Note the `setHours(0,0,0,0)` server-local-time anchor and the rolling-7d/rolling-30d math; both need replacing.
- `lib/db/cost-hub.ts` — `getEstPeriodBoundary(kind: 'today' | 'week' | 'month')` is the existing EST-anchored period-boundary primitive. This spec reuses it for Ella page parity.
- `docs/reports/cost-hub-vs-ella-cost-discrepancy-diagnostic.md` — the diagnostic that informs this spec. Read this to understand exactly what the gap was and what the cross-checks confirmed.
- `app/(authenticated)/ella/runs/page.tsx` — where `getEllaSummaryStats` is consumed. The summary band's labels ("Runs · today", "Cost · today") need to match the new EST anchoring; otherwise Drake is back to "labels don't match what they show."
- `vercel.json` — cron schedule entries that need EST-equivalent comments.
- `docs/decisions/` — existing ADRs (0001 foundational stack, 0002 title convention enforcement). New ADR 0003 follows the same template.

## Task 1: Ella page summary window math → EST calendar periods

`lib/db/ella-runs.ts:1196-1202` currently:

```ts
const now = new Date()
const todayStart = new Date(now)
todayStart.setHours(0, 0, 0, 0)
const weekStart = new Date(todayStart)
weekStart.setDate(weekStart.getDate() - 6)
const monthStart = new Date(todayStart)
monthStart.setDate(monthStart.getDate() - 29)
```

Three problems:
1. `setHours` runs in **server-local time** (UTC on Vercel), not EST.
2. `weekStart -= 6` is a **rolling 7-day window**, not "since Monday."
3. `monthStart -= 29` is a **rolling 30-day window**, not "calendar month from the 1st."

After this spec, the function should use the same EST calendar boundaries as cost hub:
- **Today** = EST start-of-day (cost hub's `getEstPeriodBoundary('today')`).
- **Week** = EST most-recent-Monday at 00:00 (cost hub's `getEstPeriodBoundary('week')`).
- **Month** = EST first-of-month at 00:00 (cost hub's `getEstPeriodBoundary('month')`).

Implementation choice — Builder picks one:

- **(A) Import from `lib/db/cost-hub.ts`.** Export `getEstPeriodBoundary` from cost-hub and call it from ella-runs. Pro: single source of truth. Con: cross-imports between data-layer modules — slightly awkward.
- **(B) Extract `getEstPeriodBoundary` + `getEstOffsetMinutes` into a shared `lib/time/est-periods.ts`** and import from both call sites. Pro: cleaner separation, future timezone helpers find a clear home. Con: net-new file.

Director's lean: **B**. The shared module gives the standard a code home; future timezone work (`/teams` Meeting Tracker, Friday FAQ cron) can import from it instead of recomputing locally. Make `lib/time/est-periods.ts` the canonical location for EST period boundaries, then refactor `cost-hub.ts` to import from there + update `ella-runs.ts` to do the same. Pure refactor — zero logic change for cost hub.

Page labels (`app/(authenticated)/ella/runs/page.tsx`): summary band's "Today" / "This week" / "This month" labels stay accurate after the fix (these names now describe EST calendar periods, which is what they always implied). No copy change needed unless Builder finds a label that explicitly says "rolling" — surface and update if so.

## Task 2: Scope fix — include skip-decision Haiku spend

Today, `getEllaSummaryStats` filters its cost-bearing rows to "response scope":

```ts
status IN (success, escalated, error)
AND (
  trigger_type IN (slack_mention, bare_mention, app_mention, passive_substantive, passive_general_inquiry)
  OR (trigger_type = 'passive_monitor' AND trigger_metadata->>'haiku_decision' = 'escalate')
)
```

This deliberately excludes `passive_monitor` skip-decision Haiku rows (the Haiku gate that decides "don't respond"). Per the diagnostic, ~$0.10/month of legitimate Haiku spend sits in this excluded scope.

**After this spec, the summary headline includes all LLM-cost-bearing Ella runs**, matching cost hub's combined Ella Sonnet + Ella Haiku bucket exactly. Filter shifts to:

```ts
agent_name = 'ella'
AND llm_cost_usd IS NOT NULL
AND started_at >= <est_period_start>
```

Two consequences worth being explicit about:

1. **Headline meaning changes** from "what did Ella do" to "all Ella LLM spend." That's the alignment Drake asked for — both pages now measure the same thing.
2. **Existing `skip_cost_today` / `skip_cost_week` / `skip_cost_month` breakouts can stay** if they're surfaced separately on the page. Builder checks: if the page renders these separately as "of which, gate decisions: $X", great — the headline becomes all-up and the breakout retains the audit-grade detail. If they're not surfaced, no need to keep computing them.

Verification after Task 1 + Task 2: re-run the diagnostic's Query 1 (cost hub Ella S+H combined) and Query 5 (Ella page summary) for `today`/`week`/`month`. Expected: exact match across both pages on all three periods. Builder reports the cross-check numbers in the report.

## Task 3a: ADR 0003 — Timezone conventions

New file `docs/decisions/0003-timezone-conventions.md`. Same template as ADR 0001/0002. Captures:

**The standard:**
- **Storage:** All timestamps stored in UTC (Postgres `timestamptz` columns; UTC ISO strings in metadata).
- **Display + period boundaries:** All user-facing time labels and date-range queries computed in America/New_York (EST/EDT, DST-aware).
- **Crons:** Scheduled in UTC (Vercel scheduler is UTC-native). Each cron entry in `vercel.json` carries an EST-equivalent comment for human readability (e.g., `0 19 * * 5  # Friday 15:00 EDT / 14:00 EST — FAQ digest`).
- **Period definitions** when used in displays / aggregations:
  - "Today" = EST start of current calendar day → now.
  - "This week" = most recent Monday 00:00 EST → now.
  - "This month" = first of current calendar month 00:00 EST → now.

**Code home:** `lib/time/est-periods.ts` (created in Task 1) owns the canonical period-boundary primitives. Future TS code that needs an EST calendar boundary imports from there. Python ops code (psycopg2 scripts, ingestion pipelines) follows the same convention — compute boundaries in `zoneinfo.ZoneInfo('America/New_York')`, pass UTC ISO timestamps to queries.

**Rationale:** Captures the "store-UTC-render-EST" trade-off, why we don't store in EST (DST math, Postgres timestamptz internals), and the explicit "don't sweep UTC out of the codebase" principle.

**Known deviations + status:** Lists the pre-2026-05-15 `getEllaSummaryStats` server-local-time anchor as a previously-fixed deviation. ADR is the durable record. Future deviations get added here as they're discovered + fixed.

ADR style: short, declarative, status-as-of-date. Match the existing ADR 0002 length (~50-80 lines max).

## Task 3b: `vercel.json` cron comment audit

Read every entry under `crons:` in `vercel.json`. For each one, ensure the schedule has an inline or adjacent comment showing the EST equivalent. Examples:

```jsonc
{
  "path": "/api/faq_digest_cron",
  "schedule": "0 19 * * 5"   // Friday 15:00 EDT / 14:00 EST — FAQ digest
}
```

If `vercel.json` doesn't support inline comments (strict JSON), put the comments in a sibling doc — `docs/runbooks/cron_schedule.md` already might exist or Builder creates it. The audit:
- Inventory every cron's UTC schedule.
- Compute the EST/EDT equivalent.
- Add comments inline OR in the sibling doc.
- Surface in the report: which crons existed, which got comments, which already had them.

If `vercel.json` is strict JSON (Vercel deploys it directly), Builder picks the sibling-doc path. No need to introduce a comment-stripping build step just for readability.

## Hard stops

None. Tasks are reversible — git revert + redeploy on any regression. The ADR + cron comments are doc-only.

Specifically not gated:
- The window/scope change is verified via cross-check queries, not by deploy.
- No migration. No env var changes. No Slack posts.

## Hard-numerical thresholds

- **Post-fix cross-check.** After Task 1 + Task 2, run the diagnostic's Query 1 and Query 5 against cloud. The two should return **exactly the same numbers** for `today`, `this week`, and `this month` cost figures. If they differ by more than $0.01 on any period (rounding tolerance), Builder stops and surfaces — the fix didn't take.

## What could go wrong

- **The shared module refactor introduces an import cycle.** `lib/db/cost-hub.ts` and `lib/db/ella-runs.ts` both consume `lib/time/est-periods.ts`. Should be clean (one-way dependency), but Builder verifies via `tsc --noEmit`.
- **Date math for "week" silently wrong around weekday boundaries.** `getEstPeriodBoundary('week')` in cost-hub uses `weekday=1` (Monday) as the anchor. Builder verifies the existing logic against a known-Monday test case before assuming correctness.
- **Skip-cost breakouts removed when they shouldn't be.** If the page uses `skip_cost_today` (etc.) somewhere visible, removing them silently breaks the surface. Builder greps for usage before deciding to remove or keep them as a separate breakout.
- **ADR drift.** The ADR captures "the standard going forward." Builder doesn't audit existing deviations across the whole codebase — only flags any encountered during this spec's work. Catalog of all timezone deviations is out of scope for the ADR (would require a sweep we explicitly decided against).

## Mandatory doc-update list

- `docs/decisions/0003-timezone-conventions.md` (new)
- `docs/runbooks/cron_schedule.md` if Builder takes the sibling-doc path for cron comments (or `vercel.json` comments inline if strict JSON allows).
- `docs/state.md` — single bullet under the 2026-05-15 entry covering the alignment + ADR.
- No CLAUDE.md update (the ADR is the durable record).

## Acceptance criteria

- `lib/time/est-periods.ts` exists with the canonical EST period boundary helpers.
- `lib/db/cost-hub.ts` imports from `lib/time/est-periods.ts` (refactor, no logic change).
- `lib/db/ella-runs.ts:getEllaSummaryStats` uses EST calendar boundaries + counts all LLM-cost-bearing Ella runs.
- Cross-check: cost hub Ella S+H "today" / "week" / "month" = Ella page summary "today" / "week" / "month", exactly.
- ADR 0003 in place.
- Every `vercel.json` cron has an EST-equivalent comment (inline or in sibling doc).
- `tsc --noEmit` + `next lint` clean. `pytest tests/ -q` still 607 passing (no Python touched).

## Sequence

1. Extract `lib/time/est-periods.ts` from cost-hub's existing helpers.
2. Refactor `cost-hub.ts` to import from it. Verify nothing changes (cross-check cost-hub numbers before vs after).
3. Update `getEllaSummaryStats` to use EST calendar boundaries + all-LLM-spend scope.
4. Verify Ella page summary now matches cost hub numbers exactly (cross-check Queries 1 + 5 from the diagnostic).
5. Write ADR 0003.
6. Audit + comment `vercel.json` crons.
7. State.md entry.
