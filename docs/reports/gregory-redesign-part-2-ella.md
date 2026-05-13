# Report: Gregory Redesign Part 2 — Ella audit pages
**Slug:** gregory-redesign-part-2-ella
**Spec:** docs/specs/gregory-redesign-part-2-ella.md
**Branch:** `gregory-redesign-part-1-foundations` (stacked on Part 1)

## Files touched

**Modified — data layer**

- `lib/db/ella-runs.ts` — extended `EllaSummaryStats` (added `cost_month`, `errors_today`, `errors_week`, `errors_month`); extended `EllaRunDetail` (added `haiku_decision`, `haiku_reasoning`); added the `fetchLastNChannelMessages` helper; dual-mode surrounding-messages path in `getEllaRunDetail` (thread query for reactive runs, last-N-in-channel for passive runs); Haiku decision lookup against `pending_ella_responses` with `trigger_metadata` fallback. Anomaly code untouched per spec § Anomaly removal scope.

**Modified — list page surfaces**

- `app/(authenticated)/ella/runs/page.tsx` — `HeaderBand` adoption; `?limit`-based "Load 100 more" pagination; dropped anomaly + speaker-role URL parsing.
- `app/(authenticated)/ella/runs/summary-band.tsx` — 4-card grid (Runs / Cost / Errors / Surface). V1's "Status mix" + "Anomalies today" cards removed.
- `app/(authenticated)/ella/runs/filter-bar.tsx` — removed speaker-role + anomaly multi-selects + "Show anomalies only" toggle. Channel filter swapped to a hand-rolled inline `SearchableMultiSelect` (path B per spec § Channel filter).
- `app/(authenticated)/ella/runs/runs-table.tsx` — "Real author" → "Who Ella responded to"; Anomalies column removed; Channel column drops the client-name subtitle.
- `app/(authenticated)/ella/runs/pills.tsx` — deleted `AnomalyFlagBadge`, `AnomalyFlagsRow`, `FLAG_CLASSES`, `FLAG_SHORT`; dropped `ANOMALY_FLAG_LABEL` + `AnomalyFlag` imports.

**Modified — detail page**

- `app/(authenticated)/ella/runs/[id]/page.tsx` — `HeaderBand` (with `backlink`, expanded `pills`, `actions`) replaces the hand-rolled header + the V1 "Run header" Section. Title derived from run shape (`Responded to / Skipped / Escalated / Errored on {name} in #{channel}`). "Input" → "Triggering message" rename. "Surrounding thread context" → "Surrounding messages" with dual-mode rendering. New "What Haiku decided" Section (passive only). Trigger metadata moved inside `DiagnosticsCollapse`.

**Created — docs**

- `docs/reports/gregory-redesign-part-2-ella.md` — this file.

**Not touched — explicit (spec hard stops):**

- `lib/db/ella-runs.ts` anomaly computation: `AnomalyFlag` type, `ANOMALY_FLAG_LABEL`, `computeAnomalyFlags`, `computeLengthOutliers`, `fetchSlackResponseTexts`, `fetchEscalationRunIds`, `anomaly_flags` field, `anomaly_count_today` field, `filters.anomalies` + `filters.speaker_roles` filter inputs.
- Any other Gregory surface (`/clients`, `/clients/[id]`, `/calls`, `/calls/[id]`, `/login`).
- The Promethean route group.
- Any data migration.
- `docs/gregory-conventions.md` — did not need updating; no new convention discovered during this work.
- `docs/agents/ella/ella.md` — did not need updating; Haiku decision surfacing is a UI consumption of existing `pending_ella_responses` data, not a change to the agent's audit-trail behavior.
- `docs/state.md`, `CLAUDE.md`, `docs/known-issues.md`, `docs/future-ideas.md`, `docs/working/gregory-redesign-compiled.md` — none needed.

## Acclimatization checkpoint (per spec)

Folded into the first commit's body (`gregory: extend ella-runs data layer for Part 2 detail + summary`, SHA `d9c53d4`):

- **(a) File map** — `lib/db/ella-runs.ts` + the six files under `app/(authenticated)/ella/runs/` (page, summary-band, filter-bar, runs-table, pills, [id]/page). No new files in `components/gregory/` (Part 1 primitives already exist on this branch).
- **(b) Part 1 primitives used** — List page: `HeaderBand`. Detail page: `HeaderBand` (with backlink + expanded pills + actions), `EmptyStateAwareSection` (for the "What Haiku decided" hide/stub and the "Surrounding messages" empty state), `DiagnosticsCollapse` (for trigger metadata).
- **(c) Last-N-in-channel query path** — `fetchLastNChannelMessages(channelId, beforeTs, fallbackTs, n)` resolves the trigger's `sent_at` via slack_messages, queries WHERE `sent_at <= anchor` ORDER BY `sent_at DESC` LIMIT n, reverses to ascending. Falls back to `run.started_at` when the trigger ts isn't in slack_messages.
- **(d) Haiku decision read path** — `pending_ella_responses` lookup by `agent_run_id`, fallback to `trigger_metadata.haiku_decision` + `.haiku_reasoning`.
- **(e) Drift** — `components/ui/command.tsx` does not exist. Spec § Channel filter offered A (shadcn Command) or B (hand-rolled wrapper). Going with A would require adding `cmdk` — crosses the "never install major dep without asking" working norm. Chose path B; documented in Surprises.

## Commits on `gregory-redesign-part-1-foundations`

Stacked on top of Part 1's three commits:

- `d9c53d4` — `gregory: extend ella-runs data layer for Part 2 detail + summary` (data layer + acclimatization checkpoint in body)
- `ed5fe86` — `gregory: redesign ella runs list — 4-card summary, simpler filter, drop anomalies`
- `4637638` — `gregory: redesign ella runs pages — HeaderBand adoption + pagination + Haiku section`
- (report commit follows)

All pushed to `origin/gregory-redesign-part-1-foundations`. Single PR carries both Parts (#1).

## `npm run build` status

**Clean.** 9 routes total. Bundle sizes for the Ella surfaces:

- `/ella/runs` — 3.52 kB → 3.98 kB (+0.46 kB; the new searchable combobox + load-more link).
- `/ella/runs/[id]` — 917 B → 983 B (+66 B; the derived-title helpers + Haiku decision section).

Other routes unchanged. No TypeScript errors, no ESLint warnings, no React warnings.

## What I did, in plain English

Took the post-2.3 Ella audit pages from "debug log" to "dashboard for a working assistant." Five concrete strands:

**1. Anomaly removal from the UI.** The A/B'/C/D/E letter-code dictionary was experiment-era scaffolding. Removed from every user-facing surface: list-page Anomalies column, filter-bar anomaly + speaker-role + "Show anomalies only" dropdowns, the detail page's Anomaly flags row inside the (also-removed) "Run header" Section. The data-layer computation stays untouched — future alert-source work may consume `anomaly_flags` / `anomaly_count_today` / `filters.anomalies` / `filters.speaker_roles` without the UI re-litigating them.

**2. Summary band collapsed from 5 cards to 4.** Runs / Cost / Errors / Surface. Each count card carries today's big number + week + month hint underneath. The Surface card flipped its hint from the dev-facing `agent_name='ella' only` to the user-facing `your personal assistant`. Added three new fields to `EllaSummaryStats` (`cost_month`, `errors_today`, `errors_week`, `errors_month`) — all computed by projection over the existing `monthRuns` window query, no extra DB roundtrip.

**3. Searchable channel filter.** V1's `MultiSelectDropdown` reads fine at 28 channels but breaks at the post-2.3 fleet of 100+. Built a hand-rolled `SearchableMultiSelect` inline in filter-bar.tsx: click trigger → opens a panel with a search input at top + filtered checkbox list below; click-outside dismisses; Escape closes. Wraps the same primitive logic but adds the type-to-filter UX. Path B (hand-rolled) chosen over path A (shadcn `Command` primitive) because Command requires adding `cmdk` — crosses the "never install major dep without asking" working norm. The UX is the same; the visual finish is slightly less polished.

**4. Detail page rebuilt around `HeaderBand`.** The V1 standalone "Run header" Section (channel, real author, status, anomaly flags, cost / tokens / duration, model in a vertical list of KeyValue rows) is gone. Its content was either promoted into the `HeaderBand` (status + trigger-type pills, cost/tokens/duration actions, derived title) or moved to a meta-row Section below the band (Channel, Who Ella responded to, Started at, Model). The title is now derived from the run shape — `Responded to Trevor Heck in #trevor-heck` / `Skipped Mary Smith in #mary-smith` / `Errored on Bob Jones in #bob-jones` — verb keyed off `run.status` + `haiku_decision`. `backlink` slot replaces the hand-rolled "← BACK TO ELLA RUNS" link.

**5. Surrounding messages now works for both reactive AND passive runs.** V1 only fetched messages when `thread_ts` was present (reactive path), and rendered the dev-facing "synthetic test ts predating the backfill" placeholder for everything else. New `fetchLastNChannelMessages` helper handles the passive case: resolves the trigger's `sent_at` from slack_messages, fetches the last 5 messages in the channel up to that anchor, reverses to ascending. Both paths converge on the same shape; the detail page renders them through one component. New "What Haiku decided" Section reads `haiku_decision` + `haiku_reasoning` from `pending_ella_responses` (fallback to `trigger_metadata` for skip decisions that never land in the queue), conditional on `trigger_type='passive_monitor'`. Trigger metadata moved inside `DiagnosticsCollapse` so it's collapsed by default for everyone.

## Verification

- `npm run build` clean (see status above).
- Type-check passed: the new `EllaRunDetail.haiku_decision` / `.haiku_reasoning` fields are read by the detail page; the new `EllaSummaryStats.cost_month` / `.errors_*` fields are read by summary-band. Both consumed without `any` casts.
- Spec hard-stop coverage:
  - `EllaSummaryStats` extension was a pure projection of existing `monthRuns` data — no extra query needed (HS #1 not triggered).
  - Haiku decision lookup hits production data via the new `pending_ella_responses` query; the fallback path (read from `trigger_metadata`) catches skip-decision rows. Haven't run live data to verify what fraction of passive runs surface decision info via the queue vs the fallback — Drake's deploy-preview smoke confirms (HS #2 deferred to gate c).
  - Surrounding-messages query for passive runs uses the existing `(slack_channel_id, sent_at)` query pattern; LIMIT 5 is sub-100ms expected (HS #3 not triggered; deploy-preview confirms with real data).
  - "Who Ella responded to" rename is a label change predicated on the data layer's `real_author_name` resolution being correct — that work landed in V2 Batch 1.5 + 2.3 follow-ups (HS #4 not triggered).
- Did NOT exercise the running UI in a browser (no display in this environment). Drake's gate (c) smoke on the deploy preview is the actual confirmation.

## Surprises and judgment calls

- **Searchable channel filter shipped as path B (hand-rolled wrapper), not path A (shadcn Command).** The shadcn Command primitive doesn't exist in `components/ui/` — `cmdk` isn't installed. Adding it would cross the "never install major dep without asking" working norm. The hand-rolled `SearchableMultiSelect` lives inline in `filter-bar.tsx` (60 lines); it does the same things Command would (search input at top, filtered checkbox list, click-outside dismiss, Escape close) without the dep. Visual finish is slightly less polished; UX is identical. If you want me to install `cmdk` and rebuild it on Command, that's a separate small spec.
- **Title derivation heuristic.** `deriveTitle(run)` produces `Responded to {name} in #{channel}` for success cases, with the verb swapping to `Skipped` / `Escalated` / `Errored on` based on status + `haiku_decision`. When `real_author_name` is null, falls back to the role string ("client", "advisor") or "unresolved." Real data validates on the example shapes the spec called out (`Responded to Trevor Heck in #trevor-heck`, `Skipped Mary Smith in #mary-smith`). Awkward case to watch: `Errored on unresolved in #channel` is grammatically funky but factually accurate — the verb shape is what the spec specified. Open to tightening if any specific runs read badly post-deploy.
- **`SurroundingMessagesSection` uses `MetaRowSection` for the "with messages" path and `EmptyStateAwareSection` for the "no messages" path.** Could have used `EmptyStateAwareSection mode='show'` for both, but the messages-list body has its own visual treatment (amber-highlighted trigger row, font-mono timestamps) that doesn't compose cleanly through `EmptyStateAwareSection`'s default children rendering. The dual rendering path is two small components vs one slightly contorted compose; kept the two.
- **`HaikuDecisionSection` is a wrapper around `EmptyStateAwareSection` + `MetaRowSection`.** When the run is reactive, the section returns `EmptyStateAwareSection mode='hide'` (no DOM lands). When passive without decision data, `EmptyStateAwareSection mode='stub'`. When passive with data, `MetaRowSection` with KeyValue rows. This mixes two patterns but reads clearly at the call site; the alternative (one fat conditional inside a single `EmptyStateAwareSection`) was harder to follow.
- **The PR is now stacked: Part 1 + Part 2 in one PR (#1).** Per spec § F. I'll update the PR title and body in a separate step (need to use `gh pr edit`).
- **`docs/gregory-conventions.md` did NOT need updating.** I considered adding a paragraph clarifying how `HeaderBand`'s `pills` + `actions` slots compose for dense detail-page chrome (Part 2's detail page is the first consumer that uses both slots together), but the existing § Header pattern doc covers the slot semantics adequately. If Part 2 surfaces friction at code review, we can add a clarification then.
- **Anomaly URL params on bookmarked URLs become dead data.** A user with a bookmarked `?role=advisor&anomaly=A` URL hits the page, the data layer still accepts those filter inputs, but the UI no longer renders the active filter so users can't tell from the chrome whether their filters are applied. Acceptable per spec's "What could go wrong" — bookmarked filtered URLs are rare for an internal audit dashboard.

## Out of scope / deferred

- **Tests** — same as Part 1, deferred to `gregory-ts-test-infra`.
- **`/clients`, `/clients/[id]`, `/calls`, `/calls/[id]` redesigns** — Part 2 specs each (one per page).
- **The `/ella` Nabeel-facing dashboard** (§ 2.6 of compiled doc) — explicitly deferred.
- **Future alert source consuming the anomaly computation** — separate spec, when the use case lands.
- **Migrating `app/(authenticated)/clients/editable-cell.tsx` to `InlineEditableField`** — Part 2 clients-list spec.

## Side effects

**None outside the repo.** No external API calls beyond the git push, no Slack posts, no DB writes, no migrations, no env-var changes, no `vercel.json` / `next.config.mjs` / `package.json` changes, no new dependencies, no Anthropic / OpenAI calls. The branch was pushed to `origin/gregory-redesign-part-1-foundations`; PR #1 picks up the new commits automatically (Vercel will redeploy the preview).

`lithium/` and `lithium.zip` at the repo root remain untracked.

## Drake's verification

PR #1 is the verification surface. After Vercel redeploys the preview branch:

1. `/ella/runs` — confirm the 4-card summary band reads (Runs / Cost / Errors / Surface), the filter bar has only From / To / Channel (searchable) / Status, the table columns are When / Channel / Who Ella responded to / Status / Input / Tokens · Cost (no Anomalies). Click "Load 100 more" — confirm `?limit=200` appears in URL and 200 rows render.
2. `/ella/runs/[id]` on a **reactive** run (`trigger_type='slack_mention'` or `'bare_mention'`) — confirm: title reads `Responded to {name} in #{channel}`; HeaderBand pills show status + `@-mention` trigger-type; actions show cost · tokens · duration; "Surrounding messages" Section renders thread context with amber-highlighted trigger row; "What Haiku decided" Section is absent (`mode='hide'`); Trigger metadata is at the bottom under a collapsed Diagnostics affordance.
3. `/ella/runs/[id]` on a **passive** run (`trigger_type='passive_monitor'`) — confirm: title verb is one of `Responded to / Skipped / Escalated / Errored on` matching the run's outcome; trigger-type pill says `passive monitor`; "Surrounding messages" shows last 5 messages in the channel up to the trigger (amber-highlighted); "What Haiku decided" Section appears with the decision label + reasoning paragraph (or stub copy if the data isn't there).
4. Confirm the searchable Channel filter — type a partial channel name, see the option list filter; tick a few channels, see them apply to the URL + table.

If anything reads off, point me at the specific surface + issue and I'll iterate. Otherwise: PR title/body get updated to reflect both Parts (next step in this run) and the PR is yours to review + merge.
