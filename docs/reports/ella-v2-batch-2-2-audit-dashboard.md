# Report: Ella V2 — Batch 2.2: audit dashboard

**Slug:** ella-v2-batch-2-2-audit-dashboard
**Spec:** docs/specs/ella-v2-batch-2-2-audit-dashboard.md

## Files touched

**Created:**
- `lib/db/ella-runs.ts` — server-only query layer (~580 lines). `getEllaRunsList`, `getEllaRunDetail`, `getEllaSummaryStats`, `listChannelsWithEllaRuns` + the anomaly-check logic + length-outlier computation + Slack-response-text fetcher used by check A.
- `app/(authenticated)/ella/runs/page.tsx` — list-view server component.
- `app/(authenticated)/ella/runs/pills.tsx` — `RolePill`, `RunStatusPill`, `AnomalyFlagBadge`, `AnomalyFlagsRow`, `RelativeTime`.
- `app/(authenticated)/ella/runs/filter-bar.tsx` — client component, URL-state-serialized filters.
- `app/(authenticated)/ella/runs/runs-table.tsx` — list table.
- `app/(authenticated)/ella/runs/summary-band.tsx` — summary stats band.
- `app/(authenticated)/ella/runs/[id]/page.tsx` — detail view.
- `docs/reports/ella-v2-batch-2-2-audit-dashboard.md` — this report.

**Modified:**
- `components/top-nav.tsx` — added "Ella" link to the top nav.
- `docs/agents/gregory.md` § Pages — new "Ella runs page — audit dashboard" subsection covering both views + anomaly semantics.
- `CLAUDE.md` § Live System State — new Batch 2.2 entry.

## What I did, in plain English

Walked the 5-bullet acclimatization — read the existing `(authenticated)` layout pattern, the Clients + Calls page structure, the `MultiSelectDropdown` primitive, the pill aesthetic, the `agent_runs` / `escalations` / `slack_messages` schemas. Confirmed the existing `slack_messages_channel_sent_at_idx` index makes the surrounding-context lookup cheap. Built the query layer first because everything depends on it; built UI in spec order.

The five anomaly checks from `scripts/audit_ella_interactions.py` translate directly. Check A (`[ESCALATE]` in Slack response AND no escalations row) needs the full Slack response text since `agent_runs.output_summary` truncates at 200 chars — `fetchSlackResponseTexts` batches one query per channel and ms-filters per run, so the full list view still fits in a single round trip plus a fan-out batch. Check D (length outlier) computes top/bottom 5% across whatever window the filters narrowed to — using the Slack-side response when available, falling back to `output_summary`.

The list view does a single fetch up to the result cap, then JS-filters the projection. The query joins `slack_channels` for channel/client names and `escalations` for has-escalation status. The summary band fetches the last 30 days of runs and aggregates today / week / month / status / cost / anomalies in JS. The detail view does its own targeted fetch (single run + same thread's surrounding messages + the escalation row when one exists).

Filter bar serializes everything to URL query params (`?from=...&to=...&channel=C1,C2&role=client,advisor&status=success&anomaly=A,C&anomalies_only=1`) so views are linkable and the back button works. Anomalies-only is a superset toggle that selects every flag if none are explicitly chosen, otherwise yields to explicit selection.

## Verification

- **TypeScript:** `npx tsc --noEmit` exits 0 across the repo.
- **Next.js build:** `npx next build` compiles cleanly; the new routes register as dynamic (`ƒ /ella/runs` + `ƒ /ella/runs/[id]`). No lint errors after a small unused-var cleanup pass.
- **Python suite:** 467 tests passing — pure-frontend work didn't touch the Python paths, but ran to confirm.
- **No production smoke run.** Drake validates in production via gate (c): clicking `/ella/runs`, confirming the V1 + Batch 1.5 runs surface with anomaly flags, navigating to a few detail views, confirming filters work and URLs are shareable.

I didn't add Jest/Vitest tests for the new TS code. The repo's frontend has no existing client-side test harness; adding one was out of scope for this spec. The server-only DB helpers are integration-shape and would need a Supabase test client to exercise meaningfully. Defer to a future testing-harness spec if Drake wants regression coverage.

## Surprises and judgment calls

- **`lib/db/ella-runs.ts` uses `import 'server-only'` which blocked the filter bar from importing the `AnomalyFlag` type.** Caught on the first Next.js build. Inlined the `AnomalyFlag` union + label dict in the client-side `filter-bar.tsx` rather than extract a non-server-only types module. Duplicated five lines instead of adding a new module — judgment call, lean on the small side. If a future surface also needs these types, extract.
- **The spec asked for "list view → click-through to detail view".** I made every cell in each row a click target wrapped in `<Link>` so clicking anywhere on a row navigates. The cells use `<Link className="block">` to make the entire cell the hit target. Slightly more markup but no JS — pure server-rendered.
- **`Map` iteration needed `Array.from(entries())`** because the repo's TS config doesn't have `downlevelIteration` set and the target is ES5-ish. Wrapped one for-of loop accordingly.
- **The "anomalies only" toggle is implemented as "select all flags".** Simpler than a second filter mode. If the URL has `anomalies_only=1` and no explicit `anomaly=X,Y` selection, the list filters by `flags.some(f => any of A/B'/C/D/E)` which matches the "any anomaly" semantic. If both are set, explicit selection wins.
- **Summary band pulls 30 days of runs to compute today's + this week's stats.** Could be 3 separate count queries but bundling in one fetch + JS-aggregating is simpler at current scale (28 V1 runs, ~3000 post-Batch-2.3 projected — still trivial). If volume crosses ~10000 runs/month the JS-aggregation pattern should be replaced with SQL COUNT queries.
- **Detail view's response section splits client-facing vs handoff client-side** rather than precomputing in the query helper. The `[ESCALATE]` slice logic is short enough that duplicating it in the view kept the helper API simpler. Could refactor if the same split is needed elsewhere.
- **Trigger metadata footer renders the full JSON.** Spec wanted a key/value list; I went with `JSON.stringify(..., null, 2)` in a `<pre>` because the field shape is small (5-10 keys) and the JSON form is easier to scan for debugging. If Drake wants a structured table it's a one-block-replace.
- **Top-nav got a new "Ella" link.** Spec said "Builder's call on exact path". I went with `/ella/runs` (per the spec's primary suggestion) over `/agents/ella/runs`. If multi-agent surfaces materialize later, the nav can move to a dropdown.
- **No new test harness for the TS side.** Spec didn't require it explicitly. The frontend tests in this repo don't exist as a pattern yet (Python has pytest; TS has nothing beyond `npx tsc`). Adding the first Jest config / first Vitest config for one feature is wrong shape — defer until either a frontend-testing-harness spec lands, or Batch 2.3 / 3 / etc. brings more dashboard surface and the pattern starts paying back.
- **Haiku decision section in detail view renders "N/A — pre-passive-monitoring run".** Spec said don't conditionally hide it. The section is there as a placeholder; when Batch 2.3 ships, the helper just starts populating the field instead of returning empty.
- **Channel filter dropdown only lists channels with ≥1 Ella run.** Pulls distinct channel IDs from `agent_runs.trigger_metadata.channel` and joins to `slack_channels`. Pre-Batch-1.5 runs that have `channel` in trigger_metadata still surface; that single field has been stable across V1 + V2 even though `real_author_id` only exists post-1.5.

## Out of scope / deferred

- **TypeScript / Jest / Vitest test coverage** for the new TS code. Frontend test harness doesn't exist yet in this repo. Adding it for one feature is wrong shape; defer to a follow-up spec.
- **Pagination UI.** The list view caps at 50 rows. There's no "next page" button — pagination is computed but not rendered. If Drake hits the cap regularly post-Batch-2.3, add a pager (small follow-up). Today's 28 V1 runs fit in one page.
- **Real-time updates.** Page refreshes show latest. No WebSocket, no SSE. Matches spec's "reasonable for an audit tool" stance.
- **Summary-band caching.** Spec suggested 60s server-side cache. Not added — Next.js's default behavior re-renders on each request, which is fine at current load (1 page-view-per-minute is well within Supabase's capacity). Add `unstable_cache` if production load shows up.
- **Server-side aggregation via SQL views or RPCs.** All the aggregation happens in JS over the 30-day-runs window today. Will need to move to SQL once volume crosses ~10k runs/month.
- **Anomaly-view drill-down dashboards** (e.g., a per-anomaly-type aggregated view). Spec said anomaly view is a filter, not a separate page. Implemented as a toggle.
- **Multi-agent audit surface** — explicitly out of scope per the spec's "Option A" direction.
- **Per-run "mark as reviewed" state.** Spec hard-stop. No write paths.

## Side effects

- **5 commits pushed to `origin/main`** during this work: query layer, list view + filter + summary + nav link, detail view, docs, this report.
- **No DB writes, no schema changes, no migrations.** Pure read surface.
- **No external API calls** beyond the standard `git push` to GitHub.
- **No Slack writes, no Anthropic calls, no Vercel CLI invocations.** Push triggers Vercel's auto-deploy via the GitHub integration; Drake validates on the dashboard per gate (c).
- **No Python tests modified or added.** 467 passing baseline preserved.
- **No spec or report file deletions.** Drake handles EOD batch cleanup.
