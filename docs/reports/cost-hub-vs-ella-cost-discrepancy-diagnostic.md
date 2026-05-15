# Report: Cost hub vs Ella runs cost discrepancy diagnostic

**Slug:** cost-hub-vs-ella-cost-discrepancy-diagnostic
**Spec:** docs/specs/cost-hub-vs-ella-cost-discrepancy-diagnostic.md

## Files touched

**Created:**
- `docs/reports/cost-hub-vs-ella-cost-discrepancy-diagnostic.md` — this report.

**No code or other docs modified** — read-only investigation per the spec.

## What I did, in plain English

Drake observed the `/cost-hub` Ella buckets and the `/ella/runs` summary band show different cost/run numbers. I read both data layers and ran inventory queries against cloud `agent_runs`.

**Conclusion: (D) Multiple causes — dominated by (A) different windows + (B) different filters, plus a real-but-secondary timezone inconsistency in the Ella page.** Neither page has an *aggregation* bug; both are internally correct against their own definitions. They answer different questions, so they were never going to match.

### 1. Are the cost hub numbers correct?

Yes. The cost hub bucket query, run directly against the DB for "this month" (EST calendar month, cost-bearing rows), reproduces what the page renders:

- **Ella Sonnet:** 34 runs, **$1.1403**
- **Ella Haiku:** 36 runs, **$0.1007**
- Combined: 70 runs, **$1.2410**

Filter (`lib/db/cost-hub.ts:aggregateBucketWindow`): `agent_name='ella'` + `llm_model LIKE 'claude-sonnet%'`/`'claude-haiku%'` + `started_at` in `[EST-month-start, now)` + `llm_cost_usd IS NOT NULL`. Period boundary is EST-anchored via `getEstPeriodBoundary` (May 1 00:00 EDT = `2026-05-01T04:00:00Z`). Correct per its own definition: "Anthropic LLM spend, by model, in the EST calendar month."

### 2. Are the Ella page numbers correct?

Yes, per its own (different) definition. `getEllaSummaryStats()` (`lib/db/ella-runs.ts:1194`) takes no args — it is **not** filtered by the page's filter bar. Replicating its exact filter:

- **today:** 5 runs, $0.1102
- **week (rolling 7d):** 37 runs, $1.0470
- **month (rolling 30d):** 65 runs, **$1.7807**

It counts **response-scope** runs only: `status IN (success,escalated,error)` AND `trigger_type IN (slack_mention, bare_mention, app_mention, passive_substantive, passive_general_inquiry)` OR (`passive_monitor` AND `trigger_metadata->>'haiku_decision'='escalate'`). Cost is `SUM(llm_cost_usd ?? 0)` over that scope. Correct per its definition: "what Ella actually did (responses), rolling 30 days."

### 3. The actual gap between the two

Two independent drivers, isolated by holding one variable constant at a time:

**Driver 1 — window length & shape.** Cost hub "month" = EST *calendar* month (May 1 → now, ~15 days). Ella page "month" = *rolling 30 days* from UTC midnight (Apr 16 → now). Holding the *filter* constant and applying the **cost-hub filter to the Ella page's rolling-30d window**: 93 runs / **$1.8728** (vs the cost hub's own 70 / $1.24 for the shorter calendar window). The longer window alone moves the cost hub figure $1.24 → $1.87.

**Driver 2 — response-scope vs all-cost-bearing.** Holding the *window* constant at the cost-hub calendar month:
- cost-hub filter: 70 runs / $1.2410
- Ella response-scope: 41 runs / **$1.1489**

The ~$0.09 / 29-run gap is **passive_monitor Haiku skip-decision rows**. The cost hub's "Ella Haiku" bucket ($0.1007, 36 rows) is almost entirely Haiku *skip evaluations* — the gate that decides "don't respond." The Ella page deliberately excludes these from its headline (they're observations, not responses) and breaks today's slice out separately as `skip_cost_today`. Query 3 shows the shape clearly:

| trigger_type | llm_model | runs | cost |
|---|---|---|---|
| slack_mention | claude-sonnet-4-6 | 31 | $1.0472 |
| passive_monitor | claude-haiku-4-5-20251001 | 36 | $0.1007 |
| passive_substantive | claude-sonnet-4-6 | 3 | $0.0931 |
| passive_general_inquiry | (null) | 1 | $0.0000 |
| bare_mention | (null) | 2 | $0.0000 |
| passive_monitor | (null) | 194 | $0.0000 |

The 194 null-model `passive_monitor` rows are pre-Haiku gate skips (kill switch / no_kb_match / csm_directed / firm_after_first) — zero cost, counted as "runs" by neither page's cost figure but they inflate Ella's raw run count. The 36 Haiku `passive_monitor` rows are the skip-vs-escalate decisions that *do* cost money and *are* in the cost hub's Haiku bucket but *not* in the Ella page's response-scope headline.

### 4. Is there a timezone bug?

**Yes — a real but secondary inconsistency, not the dominant cause.** `lib/db/ella-runs.ts:1196-1202`:

```ts
const now = new Date()
const todayStart = new Date(now)
todayStart.setHours(0, 0, 0, 0)          // SERVER-LOCAL midnight, not EST
const weekStart = new Date(todayStart)
weekStart.setDate(weekStart.getDate() - 6)   // rolling 7d, not "since Monday"
const monthStart = new Date(todayStart)
monthStart.setDate(monthStart.getDate() - 29) // rolling 30d, not calendar month
```

`setHours(0,0,0,0)` operates in the **server's local timezone**. On Vercel that's **UTC**, so the Ella page's "today" starts at UTC midnight, while the cost hub's "today" starts at EST midnight (`getEstPeriodBoundary`) — a 4-hour skew (5h in winter). And "week"/"month" are rolling-N-days, not calendar periods. So "Today"/"This week"/"This month" on the two pages legitimately label different spans. No `started_at::date` or `date_trunc(... )` UTC-vs-EST bug exists in either query path — the inconsistency is purely the `setHours`-on-server-local-time boundary in `getEllaSummaryStats`. It is **not** what produces the headline mismatch (window length + skip-filter dominate), but it means even "Today" can't be expected to agree between the two pages.

## Verification

All 5 spec queries ran read-only against cloud `agent_runs` (psycopg2 / pooler, same pattern as prior pre-flight inventories). Boundaries computed: cost-hub month = `2026-05-01T04:00:00+00:00` (May 1 00:00 EDT); Ella page = UTC-midnight-anchored rolling windows (`today=2026-05-15T00:00:00Z`, `month=2026-04-16T00:00:00Z`); `now=2026-05-15T22:11:53Z`. Code paths quoted verbatim from `lib/db/cost-hub.ts` (`aggregateBucketWindow`, `getEstPeriodBoundary`, `BUCKET_DEFINITIONS`) and `lib/db/ella-runs.ts:1194-1295` (`getEllaSummaryStats` — response-scope predicate + window math) and `app/(authenticated)/ella/runs/page.tsx:64-68` (`getEllaSummaryStats()` called with no filter args; the page's filter bar drives `getEllaRunsList`, not the summary band).

### Side-by-side (this run, 2026-05-15 22:11 UTC)

| Metric | Cost hub (Ella Sonnet+Haiku, "this month") | Ella runs page summary ("month") |
|---|---|---|
| Total runs | 70 | 65 |
| Total cost | $1.2410 | $1.7807 |
| Time window | EST calendar month: May 1 04:00Z → now (~15d) | Rolling 30d from UTC midnight: Apr 16 00:00Z → now |
| Boundary anchor | EST midnight (`getEstPeriodBoundary`) | server-local (=UTC on Vercel) midnight (`setHours`) |
| Filter on cost? | yes (`llm_cost_usd IS NOT NULL`) | no (`?? 0`; null-cost rows count as $0 runs) |
| Trigger types included | ALL (any trigger_type with a sonnet/haiku model) | response-scope only (excludes passive_monitor skip rows) |
| Includes Haiku skip-decision spend? | yes ($0.1007 in the Haiku bucket) | no (headline); `skip_cost_today` breaks out today's slice |

Window-isolated cross-check: cost-hub filter on the Ella page's rolling-30d window = 93 / $1.8728. Filter-isolated cross-check: Ella response-scope on the cost-hub calendar month = 41 / $1.1489.

## Surprises and judgment calls

- **The headline driver is window length, not the skip-filter.** I expected the passive_monitor-skip exclusion to be the big one; it's actually ~$0.09. The dominant gap is that the Ella page's "month" is a *rolling 30 days* (~$1.87 worth of runs) vs the cost hub's *calendar month* (~$1.24, ~15 days in so far). Both numbers grow apart purely because one window is 2× longer right now and will converge late in a calendar month.
- **The Ella page summary ignores the filter bar entirely.** `getEllaSummaryStats()` is called with no args (`page.tsx:67`); only `getEllaRunsList` consumes the URL filters. So the summary band is fixed at "rolling 30d, response-scope" regardless of what the user filters the table to — a likely source of Drake's confusion (filtering the table doesn't move the summary).
- **The timezone issue is real but I'm explicitly NOT calling it the bug.** Per the spec's pushback against a "UTC sweep," I'm naming the exact file:line (`lib/db/ella-runs.ts:1196-1202`) and characterizing it as a latent inconsistency, not prescribing a fix. It genuinely doesn't drive the visible mismatch.
- **`passive_monitor` produces 194 zero-cost "runs" in the window.** Neither page's *cost* figure is affected, but it massively inflates Ella's raw run count vs its LLM-cost-bearing run count (267 total Ella rows in the cost-hub window, only 70 cost-bearing). Worth knowing for any future "why does Ella show N runs but only $X" question.

## Out of scope / deferred

- **No fix.** Per spec, fix specs come later if Drake wants them. If a reconciliation is desired, the cheapest path is documentation (a one-liner on each surface explaining "cost hub = LLM spend, EST calendar month, all paths; /ella/runs = response activity, rolling 30d") rather than code — the two pages measure different things on purpose. A code fix would mean picking one definition and forcing both pages onto it, which loses information (the cost hub *should* count skip-decision Haiku spend; the Ella page *shouldn't* in its "what did Ella do" headline).
- **The `getEllaSummaryStats` timezone inconsistency** (`lib/db/ella-runs.ts:1196-1202`) is a candidate for a future doc-only or small-fix spec — flagged here, not actioned.

## Side effects

- **None.** Read-only `SELECT`s against `agent_runs` via the pooler. No writes, no API calls, no Slack posts, no env changes, no code/doc modifications. The only repo change is this report file.
