# Gregory Redesign Part 2 — Ella detail page + list cleanup
**Slug:** gregory-redesign-part-2-ella-detail-and-cleanup
**Status:** in-flight

## Context

Third Ella spec. Drake walked the deploy preview on 2026-05-13 and surfaced seven issues spanning both the list page (`/ella/runs`) and the detail page (`/ella/runs/[id]`). Most are bugs Builder shipped at the wrong layer or missed; one is a real cross-stack issue requiring a tiny Python change in the Ella agent. This spec resolves all of them.

**Stacks on the existing `gregory-redesign-part-1-foundations` branch.** Same PR.

The seven issues, grouped by surface:

**List page:**
1. Row dividers are too subtle on the dark theme. Need clearer visual separation between rows without an outer container box.
2. Cost card hint should drop the `skip cost today` segment — minimal value, adds visual noise. Wrong call by Director in the prior spec.
3. `output_summary` field starts with `queued (respond_substantive); pending_id=...` for passive-monitor response runs, and the current code prefers it over the Slack fallback because it's non-empty. Result: list rows show queue-placeholder strings instead of Ella's actual response.

**Detail page:**
4. Triggering message and Ella's response render raw `<@U...>` mention syntax and raw `:emoji:` shortcodes. The list page renders both correctly (something in the list-page path is doing the right thing). The fix is to identify what mechanism the list page uses and apply it to the detail page.
5. Section order is wrong. Should be: Context → Triggering message → Ella's response → Surrounding messages → Haiku decision → Diagnostics.
6. Surrounding messages section only renders for runs with `thread_ts` (i.e. reactive @-mention runs). Passive-monitor runs (no thread) hit an empty-state branch. The prior spec mandated a fallback to "last 5 messages in channel" for those — Builder either didn't ship it or shipped it broken. Currently most detail pages show one message (the trigger itself, amber-highlighted) and nothing else.
7. Haiku decision section only renders for `passive_monitor` runs. Should render for ALL runs: real Haiku reasoning for passive runs, synthetic reasoning for reactive @-mention runs (because the @-mention itself is the reason).

**Cross-stack:**
- `agent_runs.llm_model` for passive-monitor response runs records the Haiku decision model (`claude-haiku-4-5-20251001`) rather than the Sonnet response model. Users care about the response model; that's what should be recorded. Requires a small Python fix in the Ella agent + a one-query backfill of existing wrong rows.

## Reference reads (in this order)

1. The prior two Ella specs (`docs/specs/gregory-redesign-part-2-ella.md`, `docs/specs/gregory-redesign-part-2-ella-list-polish.md`) and their reports. Most of their content stands; this spec is targeted corrections.
2. `lib/db/ella-runs.ts` — list/detail data layer. `output_text` projection, `fetchSlackResponseTexts`, mention-rendering helper, surrounding-messages query. **The mention-rendering helper currently lives inside `getEllaRunsList`'s closure.** This spec factors it out into a shared module so the detail page can call it.
3. `app/(authenticated)/ella/runs/[id]/page.tsx` — detail-page surface. Section order + the Haiku section + the surrounding-messages section all live here.
4. `app/(authenticated)/ella/runs/runs-table.tsx` — list-page table. Inspect how this currently renders emojis correctly. The mechanism is what we apply to the detail page.
5. `agents/ella/` — Python agent code. Find where the response-generation `agent_runs` row gets its `llm_model` field written. That's the line to fix.
6. `docs/schema/agent_runs.md` — `llm_model` field shape. Used for the backfill query.

**Acclimatization checkpoint:** before writing any code, confirm in 4–5 bullets in your first commit message: (a) the file map you intend to touch (this spec spans list + detail + Python + a backfill), (b) the precise mechanism the list page uses to render emojis correctly today — the answer to issue 4's research question, (c) where in the Python agent code the response-generation `llm_model` gets written, (d) the surrounding-messages fallback query for passive runs (5-message window centered on the trigger or 5 messages ending at the trigger?), (e) any unexpected drift between this spec and what you find in the codebase. If (e) is non-trivial, surface to Drake before continuing past the first commit.

## Decisions locked in by Director

From Drake/Director conversation 2026-05-13. Build to these.

1. **Row dividers on the list page get clearer contrast.** Bump the shadcn `TableRow` default border-b from its current near-invisible treatment to something visibly readable on the dark gregory-editorial theme. No outer container; rows are flush against the page. Builder reads the existing `--color-geg-border` and `--color-geg-border-strong` tokens; if neither produces the right contrast, escalate (don't invent a new token).

2. **Cost card hint reverts** to `${week_total} this week · ${month_total} this month`. The `${skip_today} skip cost today` segment goes. The `skip_cost_today` field on `EllaSummaryStats` can stay in the type for future use (cheap to leave; removing it touches the type + the projection + every caller); flag in Surprises if you choose to remove it.

3. **`output_text` projection prefers the Slack fallback over placeholder `output_summary` values.** Logic: if `output_summary` is null OR empty OR starts with `queued (`, fall through to the Slack-message join. The `queued (` prefix is the passive-monitor's placeholder pattern. If the Slack fallback also returns nothing, render `—` muted (existing behavior). Don't try to detect other placeholder patterns — this is the only known one; if more surface, future spec.

4. **Emoji + mention rendering on the detail page matches the list page.** Builder's research task per the acclimatization checkpoint: identify how the list page's emoji rendering works today, then apply the same to detail-page text fields. Likely candidates: a CSS font that ships unicode emoji (so `:fire:` shortcodes wouldn't actually render — but they do in the list, so something is converting them) OR a transform somewhere in the list table's render path OR Slack's API converts shortcodes to unicode at ingest time before the text lands in `slack_messages.text`. Whichever it is, apply consistently. Mentions are a separate concern — the existing `<@U...>` → `@First Last` helper inside `getEllaRunsList` gets factored out into `lib/slack/render-mentions.ts` and called from both list and detail data paths.

5. **Detail page section order** becomes (top to bottom):
   - HeaderBand (existing — unchanged)
   - Context block (existing — unchanged)
   - Triggering message
   - Ella's response
   - Surrounding messages
   - Haiku decision
   - Escalation (existing — unchanged, conditional render)
   - Diagnostics collapse (existing — unchanged, contains trigger metadata JSON)

   The top (HeaderBand + Context) and bottom (Escalation + Diagnostics) stay as-is. Only the four middle sections reorder.

6. **Surrounding messages section renders for ALL runs.** Always shows 5 messages, the trigger plus up to 4 surrounding (chronologically nearest). For reactive runs with `thread_ts`, this is the existing thread query but capped at 5. For passive runs without `thread_ts`, the fallback query: pull the 4 messages immediately preceding `trigger_ts` (or `started_at` if `trigger_ts` is null), plus the trigger itself, ordered chronologically with the trigger highlighted via the existing amber-bg pattern. If fewer than 5 messages exist in the channel, render what's available. **No empty-state branch** — if the section renders, it has at least the trigger.

7. **Haiku decision section renders for ALL runs.** Two paths:
   - Passive monitor runs: existing logic — read `haiku_decision` + `haiku_reasoning` from `pending_ella_responses` (keyed by `agent_run_id`), fall back to `trigger_metadata.haiku_decision` / `trigger_metadata.haiku_reasoning`. If both empty, render `<EmptyStateAwareSection mode='stub' stubContent="No Haiku decision recorded for this run.">` (the same stub the prior spec specified).
   - Reactive @-mention runs (`trigger_type IN ('slack_mention', 'bare_mention')`): synthetic content. Decision label: `"Responded — direct mention"`. Reasoning: `"Direct @-mention from {responder_name}"` where `responder_name` is `run.real_author_name`. If `real_author_name` is null, fall back to `"Direct @-mention from {responder_role}"` (e.g. `"Direct @-mention from advisor"`).

8. **`agent_runs.llm_model` records the response model, not the decision model.**
   - **Python change:** in the Ella agent code, the `agent_runs` row written for response generation (passive runs that result in `respond_substantive` or `respond_general_inquiry`) should write `llm_model = '<sonnet model string>'` rather than the Haiku model used for the decision. Builder identifies the exact file + line. The Haiku decision is a sub-step within the same logical run; its cost is folded into the run's total but its model identifier isn't the user-facing answer to "what model did this response come from."
   - **Backfill:** one-shot UPDATE on `agent_runs` matching `agent_name='ella'` AND `trigger_type='passive_monitor'` AND `trigger_metadata->>'haiku_decision' IN ('respond_substantive', 'respond_general_inquiry')` SET `llm_model='<sonnet model string>'`. Builder reads the current Sonnet model identifier from the Python agent code or `shared/claude_client.py` to get the correct string; doesn't hardcode a guess. The backfill is a Drake-gated migration apply (gate (a) — SQL review first).
   - **Going forward:** Python fix in the same commit as everything else. Backfill is a separate apply gated on Drake.

## What success looks like

### A. List page row dividers (`runs-table.tsx`)

Current state: shadcn `TableRow` default `border-b` is rendering near-invisibly on the dark theme. Increase contrast.

- Option 1 — apply a stronger border-bottom utility at the row level (e.g. `border-b border-[var(--color-geg-border-strong)]`). Builder's call.
- Option 2 — apply a divider pattern via a different element (e.g. `<tr>`'s `divide-y` ancestor classes won't work here cleanly with shadcn's structure; ignore this option).

Builder picks the cleanest in-token approach. The visual target: row separators are obviously visible at a casual glance but don't fight the eye. If neither `--color-geg-border` nor `--color-geg-border-strong` produces the right contrast, surface — don't invent a token.

### B. Cost card hint revert (`summary-band.tsx`)

Remove the `· ${skip_today} skip cost today` segment from the Cost card's hint. The hint becomes:

```
${fmtCost(stats.cost_week)} this week · ${fmtCost(stats.cost_month)} this month
```

The `skip_cost_today` field on `EllaSummaryStats` can stay (it's cheap; future use) or be removed (cleaner). Builder's call; flag in Surprises which path was taken and why.

### C. `output_text` placeholder skip (`lib/db/ella-runs.ts`)

In the `output_text` projection inside `getEllaRunsList`, modify the preference logic:

```
const isPlaceholder = (s: string | null) => s != null && s.trim().startsWith('queued (')
const output_text =
  r.output_summary && r.output_summary.trim() && !isPlaceholder(r.output_summary)
    ? r.output_summary
    : (responseTexts.get(r.id) ?? null)
```

Apply mention rendering to the resulting `output_text` as today. If both `output_summary` and the Slack fallback are empty/null, `output_text` is null; table renders `—` muted (existing behavior).

### D. Factor mention rendering into shared module

Move the `<@U...>` → `@First Last` helper out of `getEllaRunsList`'s closure into `lib/slack/render-mentions.ts`. Export:

- `renderMentions(text: string, nameMap: Map<string, string>): string` — pure function, applies the regex replace.
- A helper to build the name map from a batch of texts: `collectMentionedUserIds(texts: string[]): Set<string>` — extracts all `<@U...>` IDs from a list of texts, deduped. Same logic that's currently inline in `getEllaRunsList`.
- The actual DB lookup (`clients` + `team_members` batched query) can stay in `lib/db/ella-runs.ts` if it's specific to that surface, or move into `lib/slack/` if it's reusable. Builder's call; the goal is just: call the same `renderMentions` function from both `getEllaRunsList` and `getEllaRunDetail`.

Apply mention rendering in `getEllaRunDetail` to: `input_summary`, `output_summary`, `slack_response_text`, and every `thread_messages[].text`. Pass a name map built from all four sources' mention IDs combined with the existing trigger-author resolution.

### E. Emoji rendering on detail page

**Research task first, code change second.** Builder reads the list page's current render path and identifies what makes emojis come through correctly there. The Output cell in `runs-table.tsx` reads `row.output_text` and renders it inside a `<span className="text-muted-foreground">` truncated to 80 chars. Nothing in that render path explicitly transforms `:fire:` → 🔥. So one of these is true:

- **(1)** Slack's API converts shortcodes to unicode before they reach `slack_messages.text` at ingest time, so `output_text` already contains unicode emojis by the time it's rendered.
- **(2)** A CSS font/glyph substitution is happening somewhere in the page chain.
- **(3)** The text is sanitized somewhere upstream that does shortcode conversion.

Builder identifies which (~5 minutes of grep + inspecting actual `slack_messages.text` values for emoji-containing messages). Whichever it is, the detail page's text fields need the same treatment.

If the answer is (1): the detail page already calls `slack_messages.text` directly for the surrounding-messages section (via `getEllaRunDetail`'s thread query), so that section's text already has unicode emojis. The triggering message and Ella's response sections read from `trigger_metadata` (input) and `slack_response_text` (output) respectively — both should already have unicode if Slack converts at ingest. If they don't render correctly on the detail page today, the bug is in the rendering path on the detail page specifically, not the data.

If the answer is (2) or (3): apply the same mechanism to the detail page.

**Build the fix based on what Builder finds.** Surface the actual mechanism in the report's Surprises section so the next spec writer knows.

### F. Detail page section order (`app/(authenticated)/ella/runs/[id]/page.tsx`)

Reorder the JSX. Current order (per the prior spec's execution):

1. Backlink
2. HeaderBand
3. Context (channel, responder, started, model — already promoted up from the prior spec)
4. Triggering message
5. Surrounding messages
6. Ella's response
7. Haiku decision (conditional on passive_monitor)
8. Escalation (conditional)
9. Trigger metadata (inside Diagnostics)

New order:

1. Backlink
2. HeaderBand
3. Context
4. **Triggering message**
5. **Ella's response**
6. **Surrounding messages**
7. **Haiku decision (always renders)**
8. Escalation (conditional)
9. Diagnostics (with trigger metadata)

Pure JSX reorder for sections 4-7. Top (1-3) and bottom (8-9) unchanged.

### G. Surrounding messages always renders 5 (`lib/db/ella-runs.ts` + detail page section)

Modify `getEllaRunDetail`'s surrounding-messages fetch:

- If `thread_ts` is present (reactive path): existing thread query, but `.limit(5)` instead of the current `.limit(20)`. The 5 most relevant messages are: the trigger itself + 4 surrounding. Logic: order by `sent_at` ascending across the thread; pick the 5 messages closest to the trigger by index (trigger + 2 before + 2 after, or trigger + 4 before if no after messages, etc.). Builder's call on the precise centering algorithm; the visual goal is "the trigger plus immediate context."
- If `thread_ts` is null (passive path): NEW query. Fetch the 4 messages in `slack_channel_id` with `sent_at <` the trigger's `sent_at`, ordered descending by `sent_at`, limit 4. Then construct the result array as `[...preceding (reversed to ascending), trigger]` so the 5 messages render chronologically with the trigger last (matches how the trigger appears in conversation flow). The trigger's `sent_at` is resolved by joining `slack_messages` on `(slack_channel_id, slack_ts) = (channel_id, trigger_ts)`. If the trigger isn't in `slack_messages` (synthetic test data), fall back to using `run.started_at` as the cutoff.

The thread-messages array in `EllaRunDetail` always has at least the trigger (because the trigger itself counts). If the channel has fewer than 5 total messages, render what's there. **No empty-state.**

Detail page section consumes the messages as today (existing render code with amber-bg on the trigger row works for both paths).

### H. Haiku decision section always renders (detail page section)

For reactive @-mention runs (where `trigger_type IN ('slack_mention', 'bare_mention')` and no `pending_ella_responses` row), build synthetic content:

- `Decision`: `Responded — direct mention`
- `Reasoning`: `Direct @-mention from {real_author_name}` (fall back to `from {real_author_role}` if name is null, fall back to `Direct @-mention` if both null)

For passive runs: existing logic from the prior spec — read from `pending_ella_responses` or `trigger_metadata` fallback. Stub state for missing data.

The section's `<EmptyStateAwareSection>` wrapper changes from conditional-on-trigger-type to always-mode-show. The conditional logic moves into the section's content (which content path to render based on trigger type).

### I. Python fix: `agent_runs.llm_model` records response model

Builder identifies the file. Likely path: `agents/ella/passive_monitor.py` or `agents/ella/agent.py` or similar. The response-generation code path (the path that runs Sonnet after Haiku decides to respond) writes an `agent_runs` row; that row's `llm_model` field should be the Sonnet model string, not the Haiku model string.

The Haiku decision is a sub-step within the same run. Its cost is folded into the run's `llm_cost_usd` total (existing behavior); its model identifier doesn't need to surface. If the Python code structures the Haiku decision as a separate agent_runs row (rather than a sub-step), that's a different design and would need a different fix — surface in Surprises.

Builder reads the Sonnet model identifier from `shared/claude_client.py` or wherever the model constants live; doesn't hardcode a string guess.

### J. Backfill migration

Generate a one-shot SQL migration:

```sql
update agent_runs
set llm_model = '<sonnet model string read from agent code>'
where agent_name = 'ella'
  and trigger_type = 'passive_monitor'
  and trigger_metadata->>'haiku_decision' in ('respond_substantive', 'respond_general_inquiry');
```

**This is a Drake-gated apply per CLAUDE.md.** Builder generates the migration file, surfaces the SQL to Drake for review, waits for approval, then applies via the standard path (`supabase db push --linked --dns-resolver https --password "$DB_PW" --yes`). Dual-verify post-apply (row count of updated rows matches the row count of pre-apply rows matching the predicate).

The migration applies to existing rows. The Python fix from § I applies to new rows. The backfill is one-time; future runs are correct without further intervention.

### K. PR + branch

Same branch, same PR. Title gets updated by Builder to reflect all three spec batches:

- Title: `Gregory redesign Part 1 — foundations + Part 2 — Ella (full)`
- Body: extend with a section summarizing this spec's changes; link this spec and the report.

## Hard stops

1. **Before applying the backfill migration (§ J).** SQL review by Drake first per gate (a). Don't apply without explicit approval. The predicate is narrow but the WHERE clause has zero room for typos.

2. **If the Python agent code structures the Haiku decision as a separate `agent_runs` row** (rather than a sub-step within the response run), stop and surface. The `llm_model` fix in § I assumes one row per logical response, with the Haiku call as a sub-step. If reality is two rows (one for the decision, one for the response), the fix is different (probably: leave both rows, but expose only the response row on the detail/list pages; mark the Haiku row as `internal` somehow).

3. **If the emoji-rendering research (§ E) reveals that emojis are NOT rendering on the list page** — i.e. Drake's screenshot was misread — stop and surface. The whole § E plan depends on the list working correctly today.

4. **If the surrounding-messages 5-cap (§ G) results in the trigger not appearing in the array** for some edge case (e.g. a trigger that's not in `slack_messages`), stop and surface. The section must always include the trigger; the rest is context around it.

## Think this through yourself — what could go wrong

- **The row-divider contrast change could read as heavy if `--color-geg-border-strong` is too dark.** Builder's visual judgment. If neither token reads right, surfacing for a new token is fine — that's the conventions doc working as intended.

- **Skip_cost_today field removal would cascade.** Removing it from the type means updating every caller. If Builder chooses to keep the field unused, the type stays the same — easier. Either is acceptable; Surprises explains the call.

- **Placeholder `queued (` detection is brittle.** If the Python passive-dispatch code changes its placeholder format, the detection misses. **Mitigation:** the spec's hard-coded prefix is documented; if the format changes, both the dispatch and the detection have to update together. A test would catch drift; no test infra. Accept the brittleness, document the dependency.

- **Mention rendering helper factoring out is straightforward** but the name-map building logic may be tangled with the rest of `getEllaRunsList`. Builder's call on whether to extract the whole pipeline or just the regex-replace function. The visible-from-outside contract is `renderMentions(text, nameMap)`; the rest is implementation detail.

- **Emoji rendering research is the unknown.** Builder may discover the answer is mundane (Slack converts at ingest, the data already has unicode) or weird (some font trick). If it's mundane, the detail-page fix is "make sure detail page reads the same data source." If it's weird, the fix is more involved. Spec accepts both outcomes.

- **The 5-message centering algorithm for threads has ambiguity.** "Trigger + 4 surrounding" could mean: 2 before + trigger + 2 after, or 4 before + trigger, or 0 before + trigger + 4 after. Visual goal: the trigger is in context. **Mitigation:** Builder defaults to 2 before + trigger + 2 after for threads with messages on both sides of the trigger; falls back to whichever side has more messages if asymmetric. Surface in Surprises if the visual reads weird.

- **Synthetic Haiku reasoning for reactive runs is honest but may read awkwardly** when next to real Haiku reasoning on passive runs. The decision label `Responded — direct mention` and reasoning `Direct @-mention from {name}` are short by design; they shouldn't compete visually with the longer real-reasoning text. **Mitigation:** consistent rendering across both paths; the visual difference is just length, which is fine.

- **The Python fix may live in a file Builder hasn't touched.** Reading the relevant agent code first (per acclimatization point c) is the safety net. If the Python is structured surprisingly, Builder surfaces before writing the fix.

- **The backfill migration's row count could be larger than expected.** If Drake's deploy preview shows 20-40 in-scope runs but the backfill predicate matches 100+ rows in the DB, the discrepancy may be old rows that were filtered out by the response-scope predicate at the UI layer but are still in the data. **Mitigation:** Builder reports the pre-apply matched row count to Drake before applying. If it's surprising, Drake reviews before approving.

## Mandatory doc-update list

- `docs/specs/gregory-redesign-part-2-ella.md` — does not need updating. Superseded in parts by this spec, but the spec-history audit trail lives in the per-spec files, not edits to prior ones.
- `docs/specs/gregory-redesign-part-2-ella-list-polish.md` — does not need updating. Same rationale.
- `docs/gregory-conventions.md` — possibly. If Builder extracts a meaningful pattern around "list pages prefer rendered content over placeholder strings" or "section ordering matches workflow order," add a short note. State explicitly in the report whether updated.
- `docs/agents/ella/ella.md` — likely. The Python `llm_model` change is an agent-behavior change; document it briefly under whatever section covers run logging.
- `CLAUDE.md` — does not need updating.
- `docs/state.md` — does not need updating.
- `docs/known-issues.md` — possibly. If the Python `llm_model` bug had a documented entry, remove it. If not, no entry to add now (it's getting fixed).
- `docs/future-ideas.md` — only if Builder identifies a follow-up worth tracking (e.g. detecting more placeholder patterns beyond `queued (`).

## Out of scope for this spec (explicit)

- `/clients`, `/clients/[id]`, `/calls`, `/calls/[id]` — Part 2 specs each.
- The `/ella` Nabeel-facing dashboard — deferred.
- The data-layer anomaly computation — untouched; future alert source.
- Migrating `app/(authenticated)/clients/editable-cell.tsx` to `InlineEditableField` — Part 2 clients-list spec.
- Tests — deferred to `gregory-ts-test-infra`.
- Detecting placeholder patterns beyond `queued (` — future spec if more surface.
- Slack syntax beyond `<@U...>` mentions and `:emoji:` shortcodes — future spec.
