# Cost hub vs Ella runs cost discrepancy diagnostic
**Slug:** cost-hub-vs-ella-cost-discrepancy-diagnostic
**Status:** in-flight

Read-only investigation. Builder identifies the actual cause of the apparent cost mismatch between `/cost-hub`'s Ella buckets and `/ella/runs`. **No code changes — fix specs come later if needed.**

## Context Builder needs

Read these first, confirm understanding in 4-5 bullets:

- `lib/db/cost-hub.ts` — the bucket aggregation logic. Especially `aggregateBucketWindow` (the `agent_runs` filter), `getEstPeriodBoundary` (the period boundaries in EST → UTC), and `BUCKET_DEFINITIONS` (the agent_name + model prefix filters per bucket).
- `lib/db/ella-runs.ts` — the Ella audit dashboard's data layer. Specifically how it computes the cost/runs summary at the top of `/ella/runs`. The relevant function is likely a counter or summary aggregator over `agent_runs` with `agent_name='ella'`.
- `app/(authenticated)/ella/runs/page.tsx` — the page composition. What time window does the summary band cover? Is it filtered by URL params, defaulting to all-time, last 30 days, etc.?
- `agent_runs` table — particularly `agent_name`, `trigger_type`, `started_at`, `llm_cost_usd`, `llm_model` columns.

## Drake's observation

The cost hub `/cost-hub` shows totals per Ella bucket (Today / This week / This month). The Ella runs page `/ella/runs` shows its own cost summary. The numbers don't match. Drake's initial hypothesis was timezone; Director's pushback was that the more likely causes are (a) different time windows or (b) different filter semantics, not timezone. This spec confirms.

## Task: Diagnose

Run these inventory queries against cloud `agent_runs` via psycopg2 (read-only — same pattern as the cost-hub pre-flight inventory). Surface the output in the report verbatim — not summarized.

### Query 1: Cost hub's Ella Sonnet bucket exactly as it runs

Replicate the cost hub's "this month" filter for Ella Sonnet:

```sql
SELECT
  COUNT(*) AS runs,
  COALESCE(SUM(llm_cost_usd), 0) AS total_cost
FROM agent_runs
WHERE agent_name = 'ella'
  AND llm_model LIKE 'claude-sonnet%'
  AND started_at >= '<this-month-start-EST-as-UTC>'
  AND started_at < '<now-as-UTC>'
  AND llm_cost_usd IS NOT NULL;
```

Builder computes the UTC boundary from the actual EST month boundary (today is 2026-05-15, EDT — so May 1 00:00 EDT = May 1 04:00 UTC).

Do the same for Ella Haiku (model LIKE `claude-haiku%`).

### Query 2: Same window, no filters

```sql
SELECT
  COUNT(*) AS runs,
  COALESCE(SUM(llm_cost_usd), 0) AS total_cost,
  COUNT(*) FILTER (WHERE llm_cost_usd IS NULL) AS null_cost_runs,
  COUNT(DISTINCT llm_model) AS distinct_models,
  COUNT(DISTINCT trigger_type) AS distinct_triggers
FROM agent_runs
WHERE agent_name = 'ella'
  AND started_at >= '<this-month-start-EST-as-UTC>'
  AND started_at < '<now-as-UTC>';
```

This isolates how many Ella rows in the same window are NOT counted by the cost hub bucket filter — non-LLM rows (null cost), model variants not matching `claude-sonnet*` or `claude-haiku*`, etc.

### Query 3: Break down by `trigger_type`

```sql
SELECT
  trigger_type,
  llm_model,
  COUNT(*) AS runs,
  COALESCE(SUM(llm_cost_usd), 0) AS total_cost
FROM agent_runs
WHERE agent_name = 'ella'
  AND started_at >= '<this-month-start-EST-as-UTC>'
  AND started_at < '<now-as-UTC>'
GROUP BY trigger_type, llm_model
ORDER BY total_cost DESC;
```

This shows the actual shape of Ella's `agent_runs` distribution this month: which trigger_types fire, which models they use, what they cost. Useful to identify any trigger_type not bucketed by cost hub (e.g., if there's a `passive_monitor` trigger_type that doesn't produce LLM cost but counts as a "run" on the Ella page).

### Query 4: Find the actual Ella page summary aggregator

Read `lib/db/ella-runs.ts` and `app/(authenticated)/ella/runs/page.tsx` to find:

- What `agent_runs` query powers the summary band on `/ella/runs`?
- What `started_at` window does it use? Is it server-controlled, URL-param-controlled, or all-time?
- Does it filter on cost (e.g., `llm_cost_usd IS NOT NULL`) or count every row regardless?
- Does it filter on a specific `trigger_type` subset, or count all Ella runs?
- Are anomaly-flagged rows included or excluded?
- Are skip-decision rows counted as "runs" with $0 cost?

Quote the relevant code snippets verbatim in the report.

### Query 5: Compute the Ella page summary's numbers exactly as it does

Once Builder has the Ella page's filter logic, re-run that filter against cloud `agent_runs` and compare against cost hub bucket 1 + bucket 2's combined totals for the same time window.

The expected output: a side-by-side table in the report showing:

| Metric | Cost hub (Ella Sonnet + Haiku, this month) | Ella runs page summary |
|---|---|---|
| Total runs | X | Y |
| Total cost | $X | $Y |
| Time window | <window> | <window> |
| Filter on cost? | yes/no | yes/no |
| Trigger types included | <list> | <list> |

Builder synthesizes the actual cause: window mismatch, filter mismatch, both, neither (real timezone bug), or some other shape Director didn't anticipate.

## What to report

In the report's "What I did, in plain English" section, the diagnosis should clearly answer:

1. **Are the cost hub numbers correct?** I.e., does the cost hub bucket query, run directly against the DB, produce the same numbers as the page renders?
2. **Are the Ella page numbers correct?** Same question — does the Ella summary query produce the same numbers as the page renders?
3. **What's the actual gap between the two?** Concretely: what is the cost hub counting that the Ella page isn't (or vice versa)?
4. **Is there a timezone bug anywhere in the chain?** Specifically: any `started_at::date` without a timezone cast? Any `date_trunc('day', ...)` against UTC instead of EST? Any place where calendar-day boundaries don't match what the page label says?

The report should produce one of these conclusions:

- **(A) Different windows by design.** Cost hub = "this month in EST"; Ella page = "all time" or "last 30 days" or whatever it actually shows. No bug. Documentation could clarify the difference for future Drake.
- **(B) Different filters by design.** Cost hub filters on `llm_model LIKE 'claude-sonnet%'` (LLM-cost-bearing only); Ella page counts all Ella runs including skip-decisions and non-LLM paths. No bug — they're showing different concepts. Documentation could clarify.
- **(C) Real bug.** Either a timezone bug (calendar day mismatch) or an aggregation bug (one of the pages computes wrong against its own filters). Builder identifies the offending file + line.
- **(D) Multiple causes.** Some combination — clearly enumerated.

Even if the answer is (A) or (B) (most likely), the report should document the gap explicitly so future agents reading this understand why the two pages don't match.

## What NOT to do

- **Do not modify any code.** This is investigation only. Even if Builder finds a real timezone bug, do not fix it — surface in the report for Drake's review.
- **Do not propose a "UTC sweep" or any "standardize on EST" code changes.** That's a separate doc-only spec coming later (per Director's pushback against blanket sweeps).
- **Do not modify any documentation.** The diagnostic informs the next spec; doc changes happen in that spec, not this one.

## Hard stops

None. Read-only operation throughout. If any query returns an unexpected error, surface in the report and continue with other queries.

## Hard-numerical thresholds

None. The diagnostic is informational, not gated on specific numbers.

## What could go wrong

- **The Ella page might not have a clear "summary cost" — could be a per-run cost column with no aggregate.** If the discrepancy Drake sees isn't an aggregate, it might be a single-row comparison (e.g., "this row says $0.0028 on /ella/runs but the cost hub bucket adds up to $0.10 — should it be $0.03?"). Builder asks Director for clarification if the page surface doesn't match the framing.
- **The numbers might match after all** and Drake misremembered or compared at different times. If they match exactly, the report says so — and the conclusion is "no discrepancy; possibly a transient observation Drake didn't recheck."
- **A real timezone bug surfaces somewhere unexpected.** E.g., the Ella page might compute "today" via `started_at::date = current_date` (UTC). Builder names the file + line; Drake decides the fix path.

## Mandatory doc-update list

- None for this spec. Diagnostic only.

## Acceptance criteria

- All 5 queries run; output captured in the report.
- Side-by-side comparison table present.
- Clear conclusion: A / B / C / D.
- File/line references for any real bug found.
- No code changes.

## Sequence

1. Read the Ella page surface — `app/(authenticated)/ella/runs/page.tsx`, `lib/db/ella-runs.ts`. Quote relevant filter/window logic.
2. Compute EST month boundaries as UTC ISO strings.
3. Run Queries 1-3.
4. Read Query 4's findings into Query 5.
5. Run Query 5.
6. Synthesize conclusion. Write report.

Report ships at `docs/reports/cost-hub-vs-ella-cost-discrepancy-diagnostic.md`. No code commit.
