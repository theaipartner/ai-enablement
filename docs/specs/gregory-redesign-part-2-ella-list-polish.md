# Gregory Redesign Part 2 — Ella audit list page polish
**Slug:** gregory-redesign-part-2-ella-list-polish
**Status:** in-flight

## Context

The Part 2 Ella spec (`docs/specs/gregory-redesign-part-2-ella.md`) was specced before Drake had walked the deploy preview. Walking it surfaced four issues with the list page (`/ella/runs`) that the prior spec didn't catch — three visual, one major data-shape. This spec corrects them. The Part 2 Ella detail-page work (`/ella/runs/[id]`) is deferred to the next spec; **list page only here**.

**Stacks on the existing `gregory-redesign-part-1-foundations` branch.** Same PR.

The four issues Drake surfaced 2026-05-13:

1. **Major data-shape issue:** the Run history list shows every `agent_runs` row with `agent_name='ella'`. That includes passive-monitor evaluations where Haiku decided "skip" — which means every accountability-bot message, every CSM message, every channel message Ella observed produces a row, regardless of whether Ella actually spoke. The list is mostly skip-decision noise. The deploy preview shows 152 runs for the month; the vast majority are skips on accountability-bot posts. This is the wrong scope for a user-facing audit.
2. **"Input" column is wrong concept** once the scope changes. The triggering message matters for the detail page (it's why Ella decided to speak), but on the list the column should show what Ella actually said. Rename to "Output" and source from Ella's outgoing message.
3. **Filter bar tint reads wrong** — it currently floats on the dark page background and looks pasted in rather than matching the metric cards.
4. **Table chrome reads wrong** — the table is in a single bounded box that visually competes with the metric cards above. Drake wants per-row borders, transparent background, slightly more vertical padding per row.

This spec is a focused polish + data-correctness pass on the list. It does not touch the detail page, does not touch the data-layer anomaly code, does not touch the prior spec's already-correct decisions (HeaderBand adoption, Surface card hint copy, "Who Ella responded to" column rename, etc.).

## Reference reads (in this order)

1. `docs/specs/gregory-redesign-part-2-ella.md` — the prior Ella spec. Most of it stands. This spec amends specific sections; do not re-execute the prior spec's already-correct work.
2. `app/(authenticated)/ella/runs/page.tsx`, `summary-band.tsx`, `filter-bar.tsx`, `runs-table.tsx` — current list-page files.
3. `lib/db/ella-runs.ts` — data layer. Two new query paths needed (Ella's outgoing message text per run, Haiku decision read for the response-scope filter).
4. `docs/schema/pending_ella_responses.md` — Haiku decision shape, used for the response-scope filter.
5. `docs/schema/slack_messages.md` — Ella's outgoing messages are queried from here (`author_type='ella'`).
6. `docs/gregory-conventions.md` — Part 1 conventions. HeaderBand pattern.

**Acclimatization checkpoint:** before writing any code, confirm in 4–5 bullets in your first commit message: (a) the file map you intend to touch (this spec is narrow — list page + summary band + filter bar + table + the data layer's list-mode query, nothing else), (b) the precise filter predicate for "Ella responded" — the SQL or in-JS shape, (c) the Ella-outgoing-message join: which key resolves the run → message link, and the fallback when no message is found, (d) the readable-Slack-mention rendering approach (resolving `<@U...>` user IDs to names), (e) any unexpected drift between this spec and what you find in the codebase. If (e) is non-trivial, surface to Drake before continuing.

## Decisions locked in by Director

From Drake/Director conversation 2026-05-13. Build to these — do not re-litigate.

1. **"Ella responded" filter = response-attempt scope.** The list shows only runs where Ella attempted to send a message. Filter predicate: `status IN ('success', 'escalated', 'error')` AND `(trigger_metadata->>'haiku_decision' IS NULL OR trigger_metadata->>'haiku_decision' != 'skip')`. The status filter alone is insufficient — passive-monitor skip-decisions write `status='success'` on `agent_runs` (the run succeeded; Haiku decided not to respond). The haiku_decision check excludes those. Reactive @-mention runs have no `haiku_decision` field (the IS NULL branch keeps them). See § A for implementation details.

2. **Output column replaces Input column.** Column header label: `Output`. Source: `output_summary` from `agent_runs` if present; fallback to a join against `slack_messages` (Ella's outgoing message in the same channel within ~5 min of `started_at`) if `output_summary` is null or empty. The fallback join already exists in the data layer as `fetchSlackResponseTexts`. Show first ~80 chars, truncated with ellipsis. If both sources are empty (shouldn't happen for in-scope rows but possible for errored runs), render `—` muted.

3. **Render Slack mentions as readable names.** When the output text contains `<@U0XXXX>` syntax, resolve the user ID against the same clients + team_members name map already used elsewhere in the data layer. Replace with `@First Last`. Unresolvable IDs fall back to the existing `<@U0XXXX>` rendering (don't strip the syntax if the lookup fails — better to show the raw form than to silently lose the mention).

4. **Top metric cards reflect response-scope counts and costs.** "Runs" today / week / month counts are all response-scope (the filter from Decision 1 applied). "Errors" likewise. "Cost" gets a special treatment:
   - Big number: total response-scope cost for today
   - Hint line: `${week_total} this week · ${month_total} this month · ${skip_today} skip cost today`
   - Only the today figure breaks out skip-cost; week and month show response-scope total only.
   - This means the cost card has more text in the hint than the others — that's expected and acceptable.

5. **Filter bar tint matched to metric cards.** Today the filter bar uses `bg-zinc-50/50` which reads pale on the dark `gregory-editorial` theme. Change to a tint that visually anchors to the metric cards above — the metric cards use `--color-geg-bg-elev` (or whatever the equivalent elevated-surface token is in the theme). The filter bar should sit on the same surface tier. Builder reads the actual token from the cards' rendered output and applies it to the filter bar's outer container.

6. **Table chrome stripped of bounded box; per-row borders.** Remove the `rounded-md border bg-white` wrapper around the `<Table>` element. Each row gets a `border-bottom: 1px solid var(--color-geg-border)` (or equivalent existing token). No outer box. Background transparent. Increase vertical padding per row — the existing shadcn `<TableRow>` / `<TableCell>` default is tight; bump cell padding by adding a className that increases py to roughly the same height as the metric cards' breathing room (eyeballing the screenshot: roughly `py-3` instead of the shadcn default). Builder's visual judgment within the existing tokens.

7. **Pagination "Load 100 more" button only renders when total count > 100.** Today's response-scope row count is likely under 100, so the button won't render at all. Pre-existing pagination spec from the prior spec (URL-state-driven `?limit=N`) stays — this is just a render guard. If `total <= currentLimit`, no button.

8. **Default `started_at desc` sort stays.**

9. **HeaderBand, Surface card copy, "Who Ella responded to" column rename, channel-column simplification, anomalies removal** all stay as specced in the prior Ella spec. Don't redo them.

## What success looks like

### A. Data layer: response-scope filter (`lib/db/ella-runs.ts`)

Add a new filter to `EllaRunsListFilters` OR (preferred) apply the response-scope predicate unconditionally in `getEllaRunsList`. **Preferred path:** unconditional. The page exists to show Ella's responses; making it a toggle adds surface area for no real reason. If Drake later wants a "show skipped runs too" view, that's a different page or a future toggle, not list-page state.

Implementation:

- In `getEllaRunsList`, after the existing `agent_name='ella'` and status filters apply, add: `.in('status', ['success', 'escalated', 'error'])` if no explicit status filter is passed by the caller, otherwise intersect the caller's status list with the response-scope set. (If the caller passes `status=skipped`, return zero rows rather than overriding — but the UI never passes that. Builder's call on whether to enforce the intersection at query time or in the projection.)
- Then, after rows are fetched, filter in-JS: `runs.filter(r => extractTriggerField(r.trigger_metadata, 'haiku_decision') !== 'skip')`. (Doing this in SQL via `.not('trigger_metadata->>haiku_decision', 'eq', 'skip')` would also work and would be cheaper at scale; Builder's call. The data layer already filters several things in-JS, so in-JS is consistent with existing patterns.)
- The `total` count returned by `getEllaRunsList` reflects the response-scope row count, post-filter. **This matters for the count display in the HeaderBand actions slot and for the "Load 100 more" render guard.**

### B. Data layer: outgoing-message text join

The existing `fetchSlackResponseTexts` function already does most of this — it returns a `Map<runId, slack_text>` for anomaly-A detection. Repurpose its output for the Output column:

- Call it (already called) inside `getEllaRunsList`.
- Add a new field to `EllaRunsListRow`: `output_text: string | null`. Populate as: prefer non-empty `output_summary`, fallback to `responseTexts.get(r.id)`, else null.
- Existing `slack_response_text` field stays as-is (it's used by the anomaly-A check and the detail page).
- The list-page table reads `output_text`, not `output_summary` or `slack_response_text` directly. Cleaner separation.

### C. Data layer: readable Slack mentions

Add a helper in `lib/db/ella-runs.ts` (or in a small utility file if Builder prefers — `lib/slack/render-mentions.ts` is fine):

- Input: text containing `<@U0XXXX>` syntax, plus a name map (`Map<slack_user_id, full_name>`).
- Output: text with each `<@U0XXXX>` replaced by `@First Last` if resolvable, left as-is if not.
- The name map is built once per `getEllaRunsList` call. The existing `fetchUserNameMap` covers triggering-message authors; this needs a broader map covering anyone Ella mentions in her output. **Build the map by extracting all `<@U0XXXX>` user IDs from every row's `output_text`, dedup, then do one batched `clients` + `team_members` lookup.** Same shape as the existing user-name-resolution pattern.
- Apply the rendering at the data-layer level so the table receives already-readable text. The table component stays dumb — no mention-parsing in the React tree.

### D. Data layer: cost-by-scope projections

In `getEllaSummaryStats`, the existing computation walks `monthRuns` once. Extend it:

- After the existing `cost_today` / `cost_week` computation, add `skip_cost_today`: same window predicate but on rows where `extractTriggerField(r.trigger_metadata, 'haiku_decision') === 'skip'`.
- Add the existing fields `cost_month`, `errors_today`, `errors_week`, `errors_month` from the prior spec — if not yet added by the prior spec's execution, add them now. (Builder verifies whether the prior spec's work added them; if yes, skip; if no, add.)
- The existing `cost_today` / `cost_week` should themselves reflect response-scope only — apply the skip-filter to the cost rollup the same way it's applied to the count rollup. This is a semantic clarification: the cost card shows what Ella's responses cost, with skip-cost called out separately.
- Update `EllaSummaryStats` type accordingly.

### E. List page (`page.tsx`)

- The HeaderBand actions slot reads `{count} RUNS` where count is the response-scope total. No change to the markup if HeaderBand is already in place from the prior spec's execution; verify the count source is the post-filter total.
- The metric card row reflects the new data shape per Decision 4. The Cost card's hint line has the extra `· ${skip_today} skip cost today` segment.
- Pagination guard: only render "Load 100 more" when `total > currentLimit`.

### F. Filter bar (`filter-bar.tsx`)

- Outer container: replace `bg-zinc-50/50` with the matched-to-cards tint. Builder reads the cards' background from the rendered output and applies the same token. If the cards use a Tailwind utility class rather than an inline style, use the same class.
- No other changes to the filter bar. (Channel combobox, anomaly removal, speaker-role removal all already specced in the prior Ella spec.)

### G. Table (`runs-table.tsx`)

- Remove the `<div className="rounded-md border bg-white">` outer wrapper.
- Each `<TableRow>` gets a bottom border via a className additive — the existing shadcn TableRow may already have a border; verify. If it does, the visual change is just removing the outer box; if it doesn't, add the per-row border.
- Background transparent (remove the `bg-white` from any wrapper).
- Vertical row padding: increase per Decision 6. Builder's visual judgment.
- Output column replaces Input column. Header: `Output`. Cell: render `row.output_text` truncated to 80 chars with ellipsis, mentions already resolved at the data layer. If `output_text` is null, render `—` in muted color.
- All other columns (When, Channel, Who Ella responded to, Status, Tokens · Cost, chevron) stay per the prior spec.

### H. Summary band (`summary-band.tsx`)

- Cost card hint becomes the new format per Decision 4: `${week_total} this week · ${month_total} this month · ${skip_today} skip cost today`. Use a `·` separator throughout to match the other cards' style.
- All four cards reflect response-scope counts (Runs / Errors) or response-scope cost (Cost). Surface card unchanged.

## Hard stops

1. **If the response-scope filter (Decision 1) results in zero rows for production data** — e.g. if all of Drake's actual Ella response history happens to write `haiku_decision='skip'` due to a data-shape misunderstanding — stop and surface. Builder validates by querying production data (read-only) and confirming the post-filter count is non-zero and matches Drake's intuition (he expects "far less than 152, probably 20-40"). If the count is wildly off (zero, or still 100+), the filter predicate is wrong.

2. **If the Slack-mention rendering surfaces edge cases the spec doesn't cover** (e.g. `<#C0XXX|channel-name>` channel-link syntax, `<!here>` / `<!channel>` broadcast syntax, `<https://example.com|link text>` URL syntax), do NOT try to handle them in this spec. Render `<@U...>` only; leave the rest untouched. Note in Surprises if other syntax appears commonly enough to warrant a future pass.

3. **If the filter-bar tint match (Decision 5) doesn't have an obvious token** — i.e. the metric cards use inline RGBA or a one-off color rather than a named token — stop and surface. Don't invent a new token or hardcode a hex value; the conventions doc requires existing tokens only. Possible resolution is to extract a token in this spec (after Drake reviews), or to wrap both surfaces in the same utility class.

4. **If the row-border treatment (Decision 6) requires modifying the shadcn `Table` primitive itself** rather than adding classes at the call site, stop and surface. Per the conventions doc, shadcn primitives are reused, not forked. A className additive at the row level is fine; a structural rewrite of `components/ui/table.tsx` is a different spec.

## Think this through yourself — what could go wrong

- **The response-scope filter may exclude runs Drake wants to see.** Errored runs where Ella tried to respond and failed are kept (status='error' is in-scope). But what about reactive @-mention runs where the LLM call itself errored before any Slack write — those have status='error' but no `haiku_decision`. The IS NULL branch keeps them, which is correct. **Mitigation:** Builder spot-checks a few error-status rows in production data to confirm the right ones surface.

- **The outgoing-message join may miss messages.** Ella's outgoing messages should land in `slack_messages` via realtime ingest, but timing matters — a run that just happened may not yet have its outgoing message in `slack_messages` by the time the page renders. **Mitigation:** the existing `fetchSlackResponseTexts` already handles this with a 5-min window post-`started_at`. If a row's output isn't yet ingested, `output_summary` is the fallback; if both are missing, the cell renders `—`. Acceptable for a very fresh run.

- **Skip-cost on the Cost card may be confusing.** "Total cost today: $0.50 · $X this week · $Y this month · $0.30 skip cost today" reads as four parallel values. The "skip cost today" might look like it adds to the total. **Mitigation:** the label is explicit ("skip cost today"). If during build Builder finds the visual reads ambiguous, surface in Surprises and propose a small layout tweak (e.g. break skip-cost onto its own line, or render it muted). Director's lean: keep it inline; humans read labels.

- **Slack-mention rendering may produce names with no @ prefix.** The data layer's `clients.full_name` / `team_members.full_name` are stored bare (no `@`). The rendering must prepend `@` to disambiguate from plain text. **Mitigation:** the helper output is `@${full_name}` always; never bare. Documented in the helper's contract.

- **The row-border treatment may double-border with shadcn's defaults.** shadcn's `TableRow` may already render a border (typical pattern). Removing the outer box while keeping the row border is the goal; doubling borders is the failure mode. **Mitigation:** Builder visually verifies and adjusts. If shadcn's default row border is the right thickness and color, no change needed beyond removing the outer wrapper.

- **The metric-card cost display now has four values where the others have three.** Visual asymmetry. **Mitigation:** acceptable — Drake's call. The Cost card carries more information; that's fine. If it visually breaks, Builder uses a slightly smaller hint-text size for that card only. Surface in Surprises if used.

- **`getEllaRunsList`'s `total` count now reflects post-filter rows.** Anything else that reads this value (currently just the HeaderBand actions slot) needs to be consistent. **Mitigation:** grep for usages; there should be just the one. Confirm in the report.

## Mandatory doc-update list

- `docs/specs/gregory-redesign-part-2-ella.md` — does not need updating. This spec amends a few of its decisions but doesn't supersede it; the prior spec's still-relevant sections (HeaderBand adoption, Channel column rename, Surface card copy, "Who Ella responded to" rename, anomaly removal) stand. The amendment is captured in this spec's existence, not in an edit to the prior file.
- `docs/gregory-conventions.md` — possibly. If Builder needs to articulate the response-scope filter as a Gregory-wide pattern (e.g. "list pages show user-meaningful events, not raw observations"), add a one-paragraph note. State in the report.
- `CLAUDE.md` — does not need updating.
- `docs/state.md` — does not need updating.
- `docs/agents/ella/ella.md` — possibly. If the response-scope filter changes how Ella's audit-trail is documented, add a one-paragraph note.
- `docs/known-issues.md` — only if something surfaces during build.
- `docs/future-ideas.md` — possibly. If Drake later wants a "show all runs including skips" view for debugging, that's a future spec; add an entry under the appropriate section if Builder thinks it's worth tracking.

## Out of scope for this spec (explicit)

- The detail page (`/ella/runs/[id]`). Next spec.
- Any change to the data layer's anomaly computation. Untouched, as per prior spec.
- Adding a "show skipped runs" toggle on the list. Future, if needed.
- Handling Slack syntax beyond `<@U...>` mentions. Future, if other syntax appears.
- Refactoring shadcn's Table primitive. Per conventions, reused as-is.
- Tests — deferred to the future `gregory-ts-test-infra` spec.
