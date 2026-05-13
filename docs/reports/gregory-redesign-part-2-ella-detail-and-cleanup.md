# Report: Gregory Redesign Part 2 — Ella detail page + list cleanup
**Slug:** gregory-redesign-part-2-ella-detail-and-cleanup
**Spec:** docs/specs/gregory-redesign-part-2-ella-detail-and-cleanup.md
**Branch:** `gregory-redesign-part-1-foundations` (stacked)

## Files touched

**Created**

- `lib/slack/render-mentions.ts` — extracted `<@U...>` / `<@W...>` mention rendering out of `getEllaRunsList`'s closure into shared module. Exports `renderMentions(text, nameMap)` (pure transform) and `collectMentionedUserIds(texts)` (regex scan + dedup). Both list and detail data paths consume the same transforms.
- `docs/reports/gregory-redesign-part-2-ella-detail-and-cleanup.md` — this file.

**Modified — data layer**

- `lib/db/ella-runs.ts` —
  - **Response-scope filter switched from haiku_decision-based to trigger_type-based.** Set: `slack_mention` / `bare_mention` / `app_mention` / `passive_substantive` / `passive_general_inquiry`, plus `passive_monitor` where `haiku_decision = 'escalate'` (no substantive row exists for escalate runs).
  - **Reverse Haiku lookup** in `getEllaRunDetail` for `passive_substantive` / `passive_general_inquiry`: `trigger_metadata.pending_id` → `pending_ella_responses` row → its `haiku_decision` + `haiku_reasoning` + linked `agent_run_id`. Forward lookup retained for `passive_monitor`.
  - **Forwarded Haiku cost + tokens** on `EllaRunDetail` (`haiku_agent_run_id`, `haiku_cost_usd`, `haiku_input_tokens`, `haiku_output_tokens`) so the detail page can display the "true total" for substantive events.
  - **Shared mention rendering** applied to `input_summary`, `output_summary`, `slack_response_text`, `haiku_reasoning`, every `thread_messages[].text`. New `buildUserNameMap` generic helper replaces the inline clients + team_members lookup.
  - **Surrounding messages always returns 5** centered on the trigger (reactive: thread query limit(20) + `centerWindowAroundTrigger`; passive: existing `fetchLastNChannelMessages` 4 preceding + trigger). **Trigger-inclusion guarantee** synthesizes a trigger row from run metadata if slack_messages doesn't have it.
  - Dropped the `queued (` placeholder skip from the prior spec's projection (rows whose `output_summary` carried that placeholder are now hidden by the trigger_type filter; no special-case needed).
  - `getEllaSummaryStats`'s response-scope predicate aligned with the new trigger_type-based filter.

**Modified — list-page UI**

- `app/(authenticated)/ella/runs/summary-band.tsx` — Cost card hint reverts to `{week} this week · {month} this month` (drops the `skip cost today` segment per Decision 2). `skip_cost_today` field stays on `EllaSummaryStats` for future use; removing it would cascade through the projection + every caller and saves nothing real.
- `app/globals.css` — scoped `tbody tr` border under `[data-theme="gregory-editorial"]` bumped from `--color-geg-border` (0.08 opacity) to `--color-geg-border-strong` (0.14). Per-row visual separation now reads clearly without an outer container.

**Modified — detail page**

- `app/(authenticated)/ella/runs/[id]/page.tsx` — section reorder (Triggering message → Ella's response → Surrounding messages → Haiku decision); Haiku decision section always renders (synthetic for reactive @-mentions); HeaderBand actions slot displays summed cost for substantive runs via `rollupCost`; Diagnostics gains a cost-breakdown panel above the trigger_metadata JSON when there's a linked Haiku row; `triggerTypeDisplay` extended for `passive_substantive` / `passive_general_inquiry`.

**Not touched (per verifications)**

- **Python:** spec § I asked for an `agent_runs.llm_model` fix in the Ella agent. Verified `agents/ella/agent.py:_call_claude` already calls `shared.claude_client.complete(run_id=run_id)` which writes `llm_model = model` (default Sonnet) when a `run_id` is provided. `passive_substantive` rows already correctly record Sonnet. **No-op.**
- **Backfill migration:** spec § J asked for a one-shot UPDATE on `agent_runs` for passive_monitor rows. Predicate matches Haiku-decision rows (which now correctly carry Haiku's model — that's the right answer for that row). The detail/list pages no longer surface those rows except for escalate cases. **No-op.**
- **`agents/ella/`:** untouched per the spec drift surfacing — Option A on the list filter handles the architecture cleanly via reverse lookup on the dashboard side.

## Acclimatization checkpoint (per spec)

Folded into the first commit's body (`gregory: ella-runs data layer — trigger_type filter + reverse Haiku + mentions helper`, SHA `2b78043`):

- **(a) File map** — `lib/slack/render-mentions.ts` (new) + `lib/db/ella-runs.ts` + `app/globals.css` + `summary-band.tsx` + `[id]/page.tsx`. No Python, no backfill (verifications below).
- **(b) Emoji mechanism on the list page** — Slack's API ships text with unicode emojis natively; `ingestion/slack/parser.py` + `realtime_ingest.py` take text as-is. The list-page "just works" because the source data has unicode. The detail page reads the same data sources, so should also see unicode. Mention syntax is the part that needed the helper.
- **(c) Python `llm_model` write path** — `agents/ella/agent.py:273-298` (`_call_claude`) calls `shared/claude_client.py:complete(run_id=...)` which at line 119 writes `llm_model = model` (default `claude-sonnet-4-6`). `respond_to_passive_trigger` calls `_call_claude` with `run_id=run_id`. **`passive_substantive` rows already record Sonnet correctly. Skip § I + § J.**
- **(d) Surrounding-messages centering** — reactive thread: fetch up to 20, in-JS center 5-window around trigger (`centerWindowAroundTrigger`). Passive: existing `fetchLastNChannelMessages` (4 preceding + trigger). Trigger-inclusion guarantee synthesizes a trigger row when not in slack_messages.
- **(e) Non-trivial drift surfaced before any code** — spec assumed one agent_runs row per logical passive response with Haiku as a sub-step. Reality: two separate rows (passive_monitor + passive_substantive / passive_general_inquiry linked via pending_id). Drake confirmed Option A: hide passive_monitor non-escalate rows; show substantive + reactive + escalate-passive_monitor. Detail page reverse-looks-up the Haiku row.

## Commits on `gregory-redesign-part-1-foundations`

Stacked on the prior three Ella spec executions:

- `2b78043` — `gregory: ella-runs data layer — trigger_type filter + reverse Haiku + mentions helper` (acclimatization checkpoint in body)
- `5fd4faa` — `gregory: ella-runs list+detail polish — borders, Cost hint revert, detail rewrite`
- (report commit follows)

PR #1 picks up all three automatically.

## `npm run build` status

**Clean.** 9 routes total. Bundle sizes:
- `/ella/runs` — 3.98 kB (unchanged from prior Part 2 ship; trigger_type filter swap is a logic-only change).
- `/ella/runs/[id]` — 983 B (unchanged; detail-page rewrite is JSX reorder + new section + new cost-rollup helper, all server-rendered).

## Surprises and judgment calls

- **Spec architecture drift was the headline.** Verified before any code work. The two-row architecture (passive_monitor + passive_substantive / _general_inquiry) means the spec's premise of "Haiku as sub-step within the response run" doesn't hold. Drake's Option A pick — hide passive_monitor non-escalate rows, surface substantive + reactive + escalate-passive_monitor — is implemented via the new trigger_type filter set. Reverse Haiku lookup via `trigger_metadata.pending_id` handles the detail page's "what did Haiku decide" question for substantive rows.
- **Python § I + Backfill § J are no-ops.** Verified via two-step grep: `shared/claude_client.py:complete` writes `llm_model` when called with `run_id`; `agents/ella/agent.py:_call_claude` passes `run_id` through; `respond_to_passive_trigger` calls it with `run_id=run_id`. Sonnet-response rows record Sonnet model. The "wrong model" issue was actually on `passive_monitor` rows (which correctly record Haiku) — those rows are now hidden from the list/detail except for escalate cases, so the visible issue disappears with the filter change. Backfill predicate would touch only Haiku-decision rows, which is the right answer for that row, so no update needed.
- **Emoji mechanism turned out to be "Slack sends unicode."** Spec asked Builder to research; the research result was mundane (Slack's API emits unicode, no transform happens in our ingest). If the detail page surfaces shortcodes anywhere, it's because that specific field's data path differs from slack_messages.text. After this work, every text field on the detail page goes through `renderMentions` and reads source data that Slack delivered as unicode. If shortcodes still appear post-deploy, point me at the specific surface + run; the fix is per-field-data-path.
- **`skip_cost_today` field stays on `EllaSummaryStats`.** Decision 2 reverted the Cost-card hint that consumed it; removing the field would cascade through the projection + caller types. Cheap to leave; called out for cleanup-later if it bothers anyone.
- **`centerWindowAroundTrigger` handles edge cases** (trigger at start / end of array, trigger not found, array smaller than n). Returns up to n messages with the trigger included whenever possible. If the trigger isn't in the input array, falls through to `slice(0, n)` and the trigger-inclusion guarantee elsewhere appends a synthesized trigger row.
- **Trigger-inclusion guarantee uses run metadata when slack_messages doesn't have the trigger.** Synthesizes a row with `slack_ts = trigger_ts`, `author_type = trigger_metadata.author_type || 'unknown'`, `text = run.input_summary || '(triggering message not in slack_messages)'`, `sent_at = run.started_at`. Visible as the trigger row (amber bg + "← trigger" suffix) in the section. Renders honestly when the data is incomplete rather than leaving the section unanchored. The "fallback text" reads okay in normal cases (input_summary is usually present) and is honest when it's not.
- **Cost-breakdown panel in Diagnostics renders only when haiku_cost_usd or haiku_input_tokens or haiku_output_tokens is non-null.** For reactive runs and escalate-passive_monitor runs (no linked Haiku), the panel is hidden. The trigger_metadata JSON dump is always present.

## Out of scope / deferred

- Per-page redesigns of `/clients`, `/clients/[id]`, `/calls`, `/calls/[id]` — Part 2 specs each.
- Tests — deferred to `gregory-ts-test-infra`.
- Slack syntax handling beyond `<@U...>` mentions + native unicode emojis — future spec.
- Detecting more placeholder patterns beyond `queued (` — moot under the trigger_type filter; rows with placeholder text are now filtered out before projection.
- Anomaly data-layer code — untouched per all prior Ella specs.

## Side effects

**None outside the repo.** No external API calls beyond the git push, no Slack posts, no DB writes, no migrations, no env-var changes, no `vercel.json` / `next.config.mjs` / `package.json` changes, no new dependencies, no Anthropic / OpenAI calls. Two commits pushed to `origin/gregory-redesign-part-1-foundations` (`2b78043` + `5fd4faa`); PR #1 picks up automatically and Vercel will redeploy the preview.

## Drake's verification

After PR preview redeploys:

1. **`/ella/runs` row count drops further.** Previous spec dropped from ~152 → ~30-40 by excluding `haiku_decision=skip`. This spec further drops by hiding all `passive_monitor` rows except escalate ones — so the row count is now "one row per Ella response (Sonnet substantive + canned general-inquiry + reactive @-mention) plus escalate-only DMs." Expected: significantly fewer rows, no more `queued (...)` placeholder strings.
2. **Output column shows real responses.** No more `queued (respond_substantive); pending_id=...` strings — those rows are filtered out entirely. The visible rows show Ella's actual response text (truncated to 80 chars) with `<@First Last>` mentions resolved.
3. **Row dividers visibly readable.** The `border-strong` bump should make rows clearly separated.
4. **Detail page section order:** Context → Triggering message → Ella's response → Surrounding messages → Haiku decision → (Escalation) → Diagnostics.
5. **Haiku section always renders.** Reactive @-mention runs show `Decision: Responded — direct mention` + `Reasoning: Direct @-mention from {responder}`. Passive substantive runs show the real Haiku decision + reasoning (from the reverse pending_id lookup).
6. **Surrounding messages always shows context** including the trigger (amber-highlighted). Passive runs that previously rendered an empty section now show up to 4 preceding messages + the trigger.
7. **Cost displays match the "true total".** Passive substantive runs show Sonnet response + Haiku decision summed in the HeaderBand actions slot. Diagnostics breakdown reveals the components.
8. **Mentions render as `@First Last` on the detail page too** (input_summary, Ella's response, surrounding messages, Haiku reasoning).

If any read wrong, point me at the surface + the issue.
