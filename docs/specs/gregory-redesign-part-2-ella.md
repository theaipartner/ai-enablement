# Gregory Redesign Part 2 — Ella audit pages
**Slug:** gregory-redesign-part-2-ella
**Status:** in-flight

## Context

This is the first per-page Part 2 spec. It applies the Part 1 foundation (primitives + conventions doc at `docs/gregory-conventions.md`, shipped in PR #?) to the two Ella audit surfaces: `/ella/runs` (list) and `/ella/runs/[id]` (detail). It stacks on the existing `gregory-redesign-part-1-foundations` branch — both Parts ship in one PR.

The Phase 1a `/ella/runs` writeup in `docs/working/gregory-redesign-compiled.md` § 2.5 was speculative and contains assumptions superseded by Drake/Director conversation 2026-05-12 → 2026-05-13. **This spec is the authoritative source for what the pages become.** Do not cross-reference § 2.5 for design decisions; the per-page list below is canonical.

Drake's product framing for these pages: Ella has graduated from "experimental thing we audit closely" (Batch 1.5 era) to "shipped tool people use" (post-Batch-2.3). The current pages were built for the audit era — dense, dev-facing, anomaly-letter-coded, jargon-heavy. They need to read like the dashboard surface for a working assistant, not a debug log.

## Reference reads (in this order)

1. `docs/gregory-conventions.md` (on this branch) — what HeaderBand / EmptyStateAwareSection / DiagnosticsCollapse / inline-edit / empty-state rules require. This spec composes those.
2. `app/(authenticated)/ella/runs/page.tsx`, `summary-band.tsx`, `filter-bar.tsx`, `runs-table.tsx`, `pills.tsx`, `app/(authenticated)/ella/runs/[id]/page.tsx` — the current pages. Know what's there before editing.
3. `lib/db/ella-runs.ts` — the data layer. Anomaly-flag computation lives here; **leave the data layer's anomaly code alone** (see § Anomaly removal scope below). The data layer needs two additions (channel-context fetch for the detail page, Haiku decision read from `pending_ella_responses`) but no removals.
4. `docs/schema/pending_ella_responses.md` — Haiku decision fields shape (`haiku_decision`, `haiku_reasoning`). Used by the new "What Haiku decided" detail-page section.
5. `docs/schema/agent_runs.md` and `docs/schema/slack_messages.md` — already familiar to Builder; refresh on the `trigger_metadata` shape adapter notes in `lib/db/ella-runs.ts` if needed.

**Acclimatization checkpoint:** before writing any code, confirm in 4–5 bullets in your first commit message: (a) the file map you intend to touch (creates, modifies, deletes), (b) which Part 1 primitives compose each surface, (c) the new data-layer query path for "last 5 messages in channel" for the detail surrounding-context section, (d) the Haiku decision read path (`pending_ella_responses` lookup keyed by `agent_run_id`), (e) any unexpected drift between this spec and what you find in the codebase. If (e) is non-trivial, surface to Drake before continuing past the first commit.

## Decisions locked in by Director

From Drake/Director conversation 2026-05-13. Build to these — do not re-litigate.

1. **Anomalies removed from all user-facing surfaces** (list table column, list filter bar, detail page row). The data-layer computation in `lib/db/ella-runs.ts` (`computeAnomalyFlags`, `computeLengthOutliers`, `fetchSlackResponseTexts`, `fetchEscalationRunIds`, the `AnomalyFlag` type, `ANOMALY_FLAG_LABEL`) stays exactly as-is. Future alert-source work may consume it; surfacing it now is the harm. See § Anomaly removal scope for the precise UI delete list.

2. **Top metric strip** = three count cards (Runs / Cost / Errors) + the Surface card. Each count card shows today big, week + month smaller below, matching the current "Today" card's layout (big number + two hint lines).

3. **Filter bar** = From, To, Channel (searchable combobox), Status. Speaker role filter, anomaly filter, and "Show anomalies only" toggle removed entirely. Filter bar gets a subtle tint matching the metric cards above it (see § Visual treatment).

4. **List table columns** = When, Channel (just channel name), Who Ella responded to (responder name + role pill), Status, Input (shortened preview), Tokens · Cost. Anomalies column removed. The chevron column at the end stays.

5. **"Who Ella responded to"** = author of the triggering message. Reactive @-mention runs → @-mention author. Passive-monitor runs → message author. The data layer already computes this correctly under `real_author_name` / `real_author_role`; this is a label change with a semantic clarification. If the responder is a CSM (role=`advisor`), their name lands in this column.

6. **Channel column** simplifies to just the channel name (`#channel-name`). The client-name subtitle currently rendered below the channel name is removed — that information is redundant when "Who Ella responded to" is its own column showing the actual person.

7. **Pagination** = load 100 initially, "Load 100 more" button at bottom. Default sort `started_at desc` (newest first) stays.

8. **Surface card** value stays `Ella V2`. Hint line becomes `your personal assistant` (replacing the current dev-facing `agent_name='ella' only`).

9. **Detail page HeaderBand expanded.** The current standalone "Run header" Section block (channel, real author, status, anomaly flags, cost / tokens / duration, model) is removed. Its content (minus anomalies, minus the raw UUID display, minus the slack_channel_id parenthetical) gets promoted into the HeaderBand region. After this change, the detail page's HeaderBand carries: eyebrow `ELLA · RUN`, title (see § Detail page title below), pills slot (Status + Trigger-type), actions slot (cost · tokens · duration). Below the HeaderBand, a meta-row renders: Channel · Who Ella responded to (with role pill) · Started at (relative + absolute on hover) · Model.

10. **Surrounding thread context** renders for both reactive and passive runs. For reactive runs (when `thread_ts` is present), keeps the existing thread-message query. For passive runs (no `thread_ts`), fetches the last 5 messages in the channel up to and including the trigger message, ordered chronologically with the trigger highlighted (existing amber-bg pattern). Existing placeholder copy ("Likely a synthetic test ts predating the backfill window...") is removed — it's wrong for passive runs and the new code path makes it unnecessary.

11. **What Haiku decided** is a new detail-page section that renders only for passive-monitor runs (`trigger_type='passive_monitor'`). Reads `haiku_decision` + `haiku_reasoning` from `pending_ella_responses` keyed by `agent_run_id`. Renders the decision (one of `respond_substantive`, `respond_general_inquiry`, `skip`, `escalate`) as a labeled value, followed by the reasoning paragraph. For reactive runs, the section is hidden entirely (`<EmptyStateAwareSection mode='hide'>` — there was no Haiku step). The existing "Haiku decision" section with placeholder text "N/A — pre-passive-monitoring run" is removed.

12. **Trigger metadata** (the raw JSON dump section at the bottom of the detail page) goes inside `<DiagnosticsCollapse>` per Decision 5 from Part 1. Collapsed by default for everyone, expandable per session.

13. **HeaderBand adoption** on both pages. List page: `<HeaderBand eyebrow="ELLA · AUDIT" title="Run history." actions={<{count} RUNS>} />`. Detail page: per Decision 9 above. The list page also gets the backlink prop unused (it's a top-level page); the detail page gets `backlink={{ href: '/ella/runs', label: 'BACK TO ELLA RUNS' }}` replacing the current hand-rolled Link element.

## Anomaly removal scope (precise)

**Remove from UI:**

- `summary-band.tsx`: the "Anomalies today" `<Stat>` card. Reduce the grid from `md:grid-cols-5` to `md:grid-cols-4`.
- `filter-bar.tsx`: the `ANOMALY_FLAG_LABEL`, `ANOMALY_OPTIONS` constants; the Anomaly flags `<MultiSelectDropdown>`; the "Show anomalies only" checkbox label; the `anomalies` and `anomalyOnly` reads; the imports of `AnomalyFlag` type. Also the speaker-role `ROLE_OPTIONS` and its `<MultiSelectDropdown>`.
- `runs-table.tsx`: the `<TableHead>Anomalies</TableHead>` column, the `<TableCell>` rendering `<AnomalyFlagsRow flags={r.anomaly_flags} />`, the import of `AnomalyFlagsRow`.
- `pills.tsx`: delete the `AnomalyFlagBadge` and `AnomalyFlagsRow` exports and their `FLAG_CLASSES` + `FLAG_SHORT` constants. The `ANOMALY_FLAG_LABEL` import from `lib/db/ella-runs` can also be removed from this file since nothing else uses it.
- `[id]/page.tsx`: the `<KeyValue label="Anomaly flags" ... />` row in the Run header section (the section itself is being removed for a different reason — see Decision 9 — so this is implicitly handled, but call it out explicitly to prevent the anomaly row sneaking back in elsewhere).
- `page.tsx` (list): the `ANOMALY_VALUES` set, the `anomalies` parse logic, the `anomalies_only` superset-filter logic, the related read of `get('anomalies_only')`. Speaker-role reads (`roles`, `filters.speaker_roles`) also go.

**Leave alone in `lib/db/ella-runs.ts`:**

- `AnomalyFlag` type export
- `ANOMALY_FLAG_LABEL` constant
- `computeAnomalyFlags`, `computeLengthOutliers`, `fetchSlackResponseTexts`, `fetchEscalationRunIds` functions
- Anomaly-flag computation inside `getEllaRunsList`, `getEllaRunDetail`, `getEllaSummaryStats`
- `anomaly_flags` field on `EllaRunsListRow` and `EllaRunDetail` (still computed, just no UI consumer)
- `anomaly_count_today` field on `EllaSummaryStats` (still computed, no UI consumer)
- The `filters.anomalies` field on `EllaRunsListFilters` and its in-JS filter (no UI sets it, but the data layer accepts it for future alert-source use)
- The `filters.speaker_roles` field and its in-JS filter (same rationale)

This is intentional. The computation does real work and may become an alert source. The UI just stops surfacing it.

## What success looks like

### A. List page (`/ella/runs`)

- HeaderBand at top using the Part 1 primitive: eyebrow `ELLA · AUDIT`, title `Run history.`, actions slot showing `{count} RUNS` in the existing geg-eyebrow + geg-numeric style.
- Below the HeaderBand, a metric-card row of four cards in a responsive grid (`grid-cols-2 md:grid-cols-4`):
  - **Runs:** today's count big (`text-lg font-semibold tabular-nums`), hint line below in the existing small-text style: `{week} this week · {month} this month`.
  - **Cost:** today's cost big (`$N.NNNN` formatting matches current `fmtCost`), hint: `${week} this week · ${month} this month`. Add a `cost_month` field to `EllaSummaryStats` if not already present (the underlying data is computed; verify and add the projection if needed).
  - **Errors:** today's error count (count of runs with `status='error'` started today), hint: `{week} this week · {month} this month`. Add `errors_today` / `errors_week` / `errors_month` fields to `EllaSummaryStats` — these don't exist today; compute from the existing `status_counts` rollup or by filtering the same `monthRuns` query already in `getEllaSummaryStats`.
  - **Surface:** value `Ella V2`, hint `your personal assistant`. Plain styling — no big-number treatment, just a labeled card matching the others' frame.
- Filter bar below the metric row: From date, To date, Channel (searchable combobox — see § Channel filter below), Status multi-select. Tinted background `bg-zinc-50/50` already in use; keep it but verify the tint reads as "matched to the cards above." If the cards have white backgrounds, the filter bar's current zinc-50/50 tint already provides the subtle differentiation Drake asked for — confirm visually and adjust only if needed. **Builder's call** within the design tokens; no new tokens.
- Table below: columns When, Channel, Who Ella responded to, Status, Input, Tokens · Cost, plus the chevron column. Column changes per Decision 4 + 6. The "Real author" header label becomes "Who Ella responded to." The Channel column shows only `#{channel_name}` (no client-name subtitle).
- Pagination: load 100 initially. "Load 100 more" button below the table. The data layer's `getEllaRunsList` already supports `limit` + `offset` — surface a server-action or query-param-driven mechanism that increments the visible row count by 100 on click. URL state (so the deeper view is shareable) is preferred over local state; use `?limit=200`, `?limit=300`, etc., parsed in `page.tsx`. Default unspecified = 100.
- Default sort `started_at desc` (matches current behavior — no change).

### B. Detail page (`/ella/runs/[id]`)

- Backlink renders via the HeaderBand `backlink` prop, not a hand-rolled Link. `{ href: '/ella/runs', label: 'BACK TO ELLA RUNS' }`.
- HeaderBand with the expanded content per Decision 9:
  - **Eyebrow:** `ELLA · RUN`
  - **Title:** see § Detail page title below.
  - **Pills slot:** the `<RunStatusPill status={run.status} />` plus a small trigger-type label (e.g. `@-mention` for `slack_mention` / `bare_mention`, `passive monitor` for `passive_monitor`). Use a low-key `<Badge>` variant for the trigger-type label so the status pill is the visual anchor.
  - **Actions slot:** `{cost} · {tokens} · {duration_ms}ms` in the existing font-mono small-text treatment from the current Run header section. Right-aligned by HeaderBand convention.
- Below the HeaderBand, a meta-row (single row of labeled values, not a Section): `Channel` (linked to the channel's client detail page if `client_id` available, otherwise plain text), `Who Ella responded to` (name + RolePill inline), `Started at` (relative time + absolute on hover, matches current `RelativeTime` component pattern but absolute since the existing detail uses `toLocaleString()`), `Model`. Keep this terse — it's a single row of contextual chrome below the title, not a full Section.
- "Input" section stays as a Section (the input message in a zinc-50 box, trigger-type / ts / thread_ts footer beneath). Section header label changes from `Input` to `Triggering message` — that's the user-facing description.
- "Surrounding thread context" section stays as a Section with the new dual-mode query (Decision 10). Section header label changes from `Surrounding thread context` to `Surrounding messages` (covers both threaded and unthreaded). Implementation:
  - When `run.thread_ts` is present (reactive path), use the existing thread-message query. No change.
  - When `run.thread_ts` is null (passive path), add a new query path in `lib/db/ella-runs.ts` that fetches the last 5 `slack_messages` in `run.slack_channel_id` with `sent_at <=` the trigger message's `sent_at`, ordered ascending. If `run.trigger_ts` is present, derive the trigger's `sent_at` by joining to `slack_messages` on `(slack_channel_id, slack_ts) = (run.slack_channel_id, run.trigger_ts)`. If the trigger message isn't in `slack_messages` (synthetic test data), fall back to fetching the last 5 messages before `run.started_at`. Name-resolution path (clients + team_members lookup) mirrors the existing thread-context resolution.
  - Both modes flag the trigger message with the existing amber-50 background. Both share the same render code; only the fetch differs.
  - Empty case: if neither query returns messages, render `<EmptyStateAwareSection>` in `stub` mode with copy `No surrounding messages available.` (drops the dev-facing placeholder).
- "Ella's response" section stays (Client-facing / Captured handoff / output_summary fallback / error_message all retained). No structural changes — this section was already doing the right thing.
- "What Haiku decided" — new Section, conditional on `trigger_type='passive_monitor'`:
  - Data: extend `getEllaRunDetail` to look up the `pending_ella_responses` row for this run (`agent_run_id = run.id`). Add `haiku_decision` and `haiku_reasoning` fields to the `EllaRunDetail` type.
  - Render: section header `What Haiku decided`. Two KeyValue rows: `Decision` showing the decision value formatted human-readably (`respond_substantive` → "Respond — substantive", `respond_general_inquiry` → "Respond — general inquiry", `skip` → "Skip", `escalate` → "Escalate"), and `Reasoning` showing `haiku_reasoning` as a wrapped paragraph.
  - If no `pending_ella_responses` row exists for the run (which shouldn't happen for `passive_monitor` runs but might for `skip` decisions per the table doc: "skip decisions never land in this table"), render a fallback: `Decision` cell pulls from `run.trigger_metadata.haiku_decision` (which the passive_monitor adapter notes are stored there), `Reasoning` pulls from `run.trigger_metadata.haiku_reasoning`. If both are absent, the section renders with `<EmptyStateAwareSection mode='stub' stubContent="No Haiku decision recorded for this run.">`.
- "Escalation" section (the existing conditional render for `run.escalation`) stays unchanged.
- "Trigger metadata" goes inside `<DiagnosticsCollapse>`. Collapsed by default, expandable. The current standalone `<Section title="Trigger metadata">` wrapper is removed; the DiagnosticsCollapse provides its own framing. The JSON dump rendering stays the same inside the collapse.
- The pre-existing standalone "Run header" Section is removed entirely per Decision 9.

### § Detail page title

The current title `Run detail.` is generic and forgettable. Per § 2.7 of the compiled doc, Director's suggestion was to derive the title from channel + author + decision (e.g. `Skipped: Trevor Heck's acknowledgment`). **Builder's call within this constraint:** the title should be human-readable, derived from the run's actual content, and consistent across trigger types. My lean: `{Verb}: {responder_name} in #{channel_name}` where the verb is one of `Responded to`, `Skipped`, `Escalated`, `Errored`, derived from `run.status` + `trigger_metadata.haiku_decision` for passive runs. Examples: `Responded to Trevor Heck in #trevor-heck`, `Skipped Mary Smith in #mary-smith`, `Errored on Bob Jones in #bob-jones`. If `responder_name` is null, fall back to the role pill text or `unresolved`. Builder writes this derivation; surface in Surprises if the heuristic produces awkward results on real data.

### § Channel filter

Today's `MultiSelectDropdown` works at 28 channels. At 100+ channels (Drake's stated concern) the dropdown becomes unworkable. Two paths:

- **A.** Replace `MultiSelectDropdown` with a searchable combobox built on shadcn's `<Command>` primitive (already part of the shadcn surface, may need adding to `components/ui/`).
- **B.** Wrap the existing `MultiSelectDropdown` with a search input at its top — minimal change, less polished, faster to ship.

**Director's lean: A.** Builder's call between A and B; favor A unless the shadcn Command primitive doesn't already exist in `components/ui/` AND adding it would expand the spec scope (it shouldn't — Command is small). If B is chosen, flag in Surprises.

### C. Data layer changes (`lib/db/ella-runs.ts`)

- **Add fields to `EllaSummaryStats`:** `cost_month: number`, `errors_today: number`, `errors_week: number`, `errors_month: number`. Compute from the existing `monthRuns` window inside `getEllaSummaryStats`. Existing fields stay.
- **Extend `getEllaRunDetail` with Haiku decision read.** Query `pending_ella_responses` by `agent_run_id = id`. Add `haiku_decision: string | null` and `haiku_reasoning: string | null` to the `EllaRunDetail` type. If no row, both null (caller falls back to `trigger_metadata` per Decision 11 fallback).
- **Add new helper:** `fetchLastNChannelMessages(channelId: string, beforeTs: string, n: number = 5)` returning the same shape as the existing `threadMessages` array (`slack_ts`, `slack_user_id`, `author_type`, `display_name`, `text`, `sent_at`, `is_trigger`). Used by the detail page's "Surrounding messages" section when `thread_ts` is null. Name-resolution mirrors the existing in-detail logic.
- **Anomaly code untouched** per § Anomaly removal scope. The existing `anomaly_flags` field on `EllaRunsListRow` / `EllaRunDetail` keeps getting computed; UI just doesn't render it.

### D. Pills.tsx cleanup

- Remove `AnomalyFlagBadge`, `AnomalyFlagsRow`, `FLAG_CLASSES`, `FLAG_SHORT`. Remove the `ANOMALY_FLAG_LABEL` / `AnomalyFlag` import from `@/lib/db/ella-runs` (since nothing in pills.tsx uses it anymore after these deletions).
- `RolePill`, `RunStatusPill`, `RelativeTime` stay.

### E. Tests

No tests. Same rationale as Part 1 — no TS test infra in the repo, deferred to `gregory-ts-test-infra`. Visual verification at the deploy preview is the verification surface.

### F. Branch + PR workflow

Stack on `gregory-redesign-part-1-foundations` per Drake's call. Commits land on that branch alongside Part 1's commits. The existing PR's title and body get updated by Builder to reflect both Parts:

- Title: `Gregory redesign Part 1 — foundations + Part 2 — Ella audit pages`
- Body: extend the existing PR description with a new section summarizing Part 2 changes. Link this spec and the Part 2 report.

Do NOT merge. Drake reviews the deploy preview and merges manually.

## Hard stops

1. **If extending `EllaSummaryStats` with the new `errors_*` fields requires re-querying** (i.e. the existing `monthRuns` window doesn't carry status info needed to compute errors per timeframe), stop and surface. The existing query already pulls `status`, so this should be a pure projection change — but verify.

2. **If the Haiku decision lookup against `pending_ella_responses` returns null for a meaningful fraction of `passive_monitor` runs in production data** (i.e. the schema doc's claim "skip decisions never land in this table" turns out to mean Haiku decisions are unreadable for most passive runs), stop and surface. The fallback path (read from `trigger_metadata`) is the resolution but worth flagging that the section is mostly-stub.

3. **If Builder discovers that the surrounding-messages query for passive runs returns confusing context** (e.g. the trigger message itself isn't reliably in `slack_messages` because passive monitoring fires before realtime ingest catches up), stop and surface. Possible mitigation is to include the trigger message synthetically from the run record. Don't silently render gappy context.

4. **If the "Who Ella responded to" rename surfaces actual data-quality issues** (e.g. a run that responded to a different person than the data-layer `real_author_name` resolves to), stop and surface. The column rename is a label change predicated on the data layer being correct — if it's not, that's a data issue, not a UI fix.

That's the hard-stop list. Routine commits, the Channel filter A/B decision, the detail-page title heuristic, the filter-bar tint adjustment, and all other design-within-contract choices are Builder's call — note in Surprises if non-obvious.

## Think this through yourself — what could go wrong

- **Anomaly removal breaks an import chain.** The `AnomalyFlagsRow` deletion in `pills.tsx` cascades to imports in `runs-table.tsx` and `[id]/page.tsx`. Both should already be cleaned by the column / Run-header removals, but TypeScript will catch any stragglers at build time. **Mitigation:** `npm run build` clean is the contract — if it's not clean, fix the import before continuing.

- **Filter-bar speaker-role removal leaves dead URL params.** Users with bookmarked `?role=advisor` URLs will hit the page; the data-layer filter still accepts `speaker_roles` (intentionally, see § Anomaly removal scope), but the UI doesn't set it. Result: bookmarked filtered URLs still work, the UI just can't display the active filter. **Mitigation:** acceptable — bookmarked URLs are rare for an internal audit dashboard. Don't add UI to display the filter; that's anti-goal.

- **Surrounding-messages query performance.** The new `fetchLastNChannelMessages` runs per-detail-page-render. Channel message counts vary wildly — a high-volume channel could have thousands of messages, and ordering descending + limiting to 5 should be cheap with the existing index on `(slack_channel_id, sent_at)` (verify via the existing slack_messages query patterns). **Mitigation:** if the index isn't there, the query is still 5-row LIMIT-bounded and should be sub-100ms. If perf shows up as a problem, that's a future-spec concern. Don't preemptively optimize.

- **HeaderBand on the detail page exposing too much.** Promoting channel + responder + status + cost into the HeaderBand means the page chrome is denser than the list page's HeaderBand. **Mitigation:** the conventions doc allows the HeaderBand's `actions` and `pills` slots to carry rich content. As long as the eyebrow + serif title remain the visual anchor, the band reads correctly. Builder's visual judgment on layout within the slots.

- **Haiku decision fallback to `trigger_metadata` may render stale data.** The passive_dispatch adapter writes `haiku_decision` / `haiku_reasoning` into `trigger_metadata`, but those are write-once at decision time. If the `pending_ella_responses` row was updated (status flipped, error message added), the metadata copy on `agent_runs` doesn't reflect it. **Mitigation:** read from `pending_ella_responses` as primary, fall back to `trigger_metadata` only when no row exists. Don't show both.

- **Stacking on the Part 1 branch means the PR diff doubles.** Drake's review burden grows. **Mitigation:** Drake's explicit call to stack. The trade-off is acknowledged; Builder doesn't second-guess.

- **The detail page title heuristic could produce awkward results.** `Responded to John Smith in #john-smith` is fine. `Errored on unresolved in #trevor-heck` reads weird. **Mitigation:** Builder uses real data to validate the heuristic on at least 5 runs covering all status / trigger-type combinations. If awkward results show up, adjust the heuristic and note in Surprises.

## Mandatory doc-update list

End-of-work, update these docs explicitly. For each, either commit the change or state in the report that the doc didn't need updating and why.

- `docs/gregory-conventions.md` — possibly. If anything Builder discovers during this Part 2 work suggests the conventions doc needs clarification (e.g. how HeaderBand's `pills` slot composes with `actions` slot for dense detail-page chrome), add a one-paragraph clarification. State in the report whether it was updated.
- `docs/working/gregory-redesign-compiled.md` — does not need updating. The compiled doc is the historical input; this spec supersedes § 2.5 and § 2.7 for what shipped.
- `CLAUDE.md` — does not need updating.
- `docs/state.md` — does not need updating. No batch shipped; the Ella audit pages are a UI rework, not a new subsystem.
- `docs/agents/ella/ella.md` — possibly. If the Haiku decision surfacing changes how the agent's audit-trail is documented, add a one-paragraph note. State in the report.
- `docs/known-issues.md` — only if something surfaces during build.
- `docs/future-ideas.md` — possibly. If Builder identifies follow-up work (e.g. the anomaly data eventually feeding alerts), add an entry under the appropriate section.

## Out of scope for this spec (explicit)

- `/clients`, `/clients/[id]`, `/calls`, `/calls/[id]` — Part 2 specs each.
- The `/ella` Nabeel-facing dashboard (§ 2.6 of compiled doc) — explicitly deferred.
- Any new alert source consuming the data-layer anomaly computation — future spec.
- Migrating `app/(authenticated)/clients/editable-cell.tsx` to the new `InlineEditableField` primitive — Part 2 clients-list spec.
- Any schema migration. Decision 11's Haiku decision read uses existing `pending_ella_responses` columns; no migration needed.
- Tests (deferred to `gregory-ts-test-infra` per Part 1 precedent).
- The Phase 1a `/ella/runs` Director-decide questions in § 2.5 of the compiled doc — superseded by this spec's decisions.
