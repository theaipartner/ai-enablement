# ADR 0003: Timezone Conventions — Store UTC, Render EST

**Date:** 2026-05-15
**Status:** Accepted
**Decision makers:** Drake (with Director, prompted by the cost-hub vs `/ella/runs` cost-figure mismatch)

## Context

Two surfaces computed "today / this week / this month" differently and showed mismatched cost numbers (diagnostic: `docs/reports/cost-hub-vs-ella-cost-discrepancy-diagnostic.md`). The cost hub anchored periods to America/New_York; `getEllaSummaryStats` used `new Date().setHours(0,0,0,0)` — **server-local** time (UTC on Vercel) — plus rolling 7-/30-day windows instead of calendar periods. Same underlying `agent_runs` data, two different definitions of "this month", so the totals never agreed.

The fix needed a stated standard, not just a one-off patch, so the next surface that needs a calendar boundary doesn't reinvent it (and reintroduce the same skew). Director explicitly rejected a "sweep UTC out of the codebase" — UTC storage is correct; the inconsistency was only in *display/period* math.

## Decision

**Storage:** all timestamps stored in UTC. Postgres `timestamptz` columns; UTC ISO-8601 strings in jsonb metadata. No timezone-local storage — DST math on stored values is a footgun and `timestamptz` is UTC internally anyway.

**Display + period boundaries:** all user-facing time labels and all date-range *aggregation* boundaries are computed in **America/New_York** (EST/EDT, DST-aware). The team is ET-based; "this month" on a dashboard means the ET calendar month.

**Canonical period definitions** (when used in displays / aggregations):

- **Today** = ET start of the current calendar day → now.
- **This week** = most recent Monday 00:00 ET → now.
- **This month** = first of the current calendar month 00:00 ET → now.

**Crons:** scheduled in UTC (Vercel's scheduler is UTC-native; `vercel.json` is strict JSON and cannot carry inline comments). The UTC→ET translation for every cron is documented in `docs/runbooks/cron_schedule.md`, kept in sync when a cron is added or rescheduled.

**Code home:** `lib/time/est-periods.ts` owns the canonical TS boundary primitives (`getEstPeriodBoundary`, `getEstOffsetMinutes`, `getEstMonthStart`). Any TS surface needing an ET calendar boundary imports from there — never re-derives locally. Python ops code (psycopg2 scripts, ingestion) follows the same definitions via `zoneinfo.ZoneInfo('America/New_York')`, passing UTC ISO timestamps to queries.

**Rationale:** store-UTC/render-ET keeps stored data unambiguous and portable while making every human-facing number mean what an ET-based team expects. Centralizing the boundary math in one module makes "what is this month" a single testable definition instead of N subtly-different inline computations. DST is handled by `Intl.DateTimeFormat` / `zoneinfo` — never by hardcoded offsets.

## Consequences

### Positive

- `/cost-hub` and `/ella/runs` now report identical cost/run figures for the same period (verified: exact match on today/week/month, delta $0.00).
- One place to fix or test calendar-boundary logic; future surfaces (`/teams`, FAQ cron, any new dashboard) inherit the correct definition for free.
- The standard is written down — the next "why don't these two numbers match" question has an answer instead of a re-investigation.

### Negative / accepted

- ET-anchored boundaries mean a "day" boundary lands at 04:00/05:00 UTC — anyone reading raw `agent_runs` by UTC date will see a 4-5h offset vs the dashboards. Acceptable: the dashboards are the product; raw-SQL spelunkers can apply the same `ZoneInfo` rule (documented here + in the cron runbook).
- Cron EST equivalents live in a sibling doc, not inline in `vercel.json` (strict JSON constraint). Drift risk if someone reschedules a cron and forgets the doc — mitigated by the mandatory-doc-update discipline and the doc being short.

## Known deviations + status

- **`getEllaSummaryStats` server-local-time anchor + rolling windows + response-scope cost filter** — *fixed 2026-05-15* (spec `ella-summary-est-alignment-and-timezone-adr`). Now uses `lib/time/est-periods` boundaries + all-LLM-cost-bearing scope.

This ADR is the durable record. Future timezone deviations discovered during other work get appended here as they are found and fixed — a codebase-wide audit/sweep is explicitly out of scope (Director's call; it would be churn without a driving need).

## Implementation pointers

- **Standard / code home:** `lib/time/est-periods.ts`.
- **Consumers today:** `lib/db/cost-hub.ts`, `lib/db/ella-runs.ts:getEllaSummaryStats`.
- **Cron UTC→ET map:** `docs/runbooks/cron_schedule.md`.
- **Origin:** diagnostic `docs/reports/cost-hub-vs-ella-cost-discrepancy-diagnostic.md`; spec `docs/specs/ella-summary-est-alignment-and-timezone-adr.md`.

## Review

Revisit if: the team's working timezone changes (not ET); a surface legitimately needs a non-ET period (per-client local time?) — handle locally with a documented exception, don't bend the standard; or cron-doc drift causes a real incident (then move to a JSON-with-build-step or a generated doc).
