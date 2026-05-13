# Report: Gregory — Ella pre-redesign fixes (output column + message rendering)
**Slug:** gregory-ella-pre-redesign-fixes
**Spec:** docs/specs/gregory-ella-pre-redesign-fixes.md
**Status:** halted — fix #1 (escalation Output column) hit hard stop #3; fixes #2-#5 shipped

## Files touched

**Created:**

- `lib/slack/render-mrkdwn.tsx` — Slack-mrkdwn → React renderer. Two-pass tokenizer: paragraph split on `\n{2,}`, per-line inline scan for `*bold*` / `_italic_` / `~strike~` / `` `code` `` / ``` ```block``` ``` / `<link|label>` / `<#chan|name>` / `• bullets`. Composes the existing `renderMentions` helper for `<@U...>`. No external deps per spec § Decision 6.
- `app/(authenticated)/ella/runs/[id]/expandable-message.tsx` — 500-char-truncate + "Show more"/"Show less" client component. Truncation is on the source string (not CSS) so page weight stays low. Word-boundary-aware cut when possible.
- `scripts/verify-ella-pre-redesign-fixes.ts` — Playwright harness for fixes #2-#5.

**Modified:**

- `lib/db/ella-runs.ts` — added `triggering_message_full_text: string | null` to `EllaRunDetail`. Populated by plucking the trigger row's `text` from the same `rawMsgs` already fetched for `thread_messages` — no extra round trip. Returns null when the trigger row is the synthesized fallback (slack_messages didn't have the trigger), so the page can fall back to `input_summary` explicitly.
- `app/(authenticated)/ella/runs/[id]/page.tsx` — wired `<ExpandableMessage>` into the Triggering message + Ella's response sections (with `output_summary` fallback). Removed `<SurroundingMessagesSection>` JSX call + the component definition.

## What I did, in plain English

Four of five fixes shipped. Fix #1 (the list-view Output column for escalation rows) hit hard stop #3 — surfaced below for Drake's call.

**Fix #2 — Triggering message full text + truncation.** Extended `EllaRunDetail` with a new `triggering_message_full_text` field. Reuses the messages already fetched for `thread_messages` — the trigger row's `text` was always there, just not exposed. Detail page falls back to `input_summary` when the trigger row is the synthesized fallback (which happens when realtime Slack ingest hadn't landed yet at run time).

**Fix #3 — Ella's response truncation.** `slack_response_text` is already the full Slack message text per `fetchSlackResponseTexts` (not summarized), so no data-layer change was needed. Just routed through `<ExpandableMessage>` for the truncate + mrkdwn render.

**Fix #4 — Slack-mrkdwn renderer.** New `lib/slack/render-mrkdwn.tsx`. ~150 non-comment lines of implementation; handles every syntax form the spec listed plus paragraph + soft-break handling. Composes the existing `renderMentions` helper as a pre-pass so the tokenizer doesn't have to special-case `<@U...>` inline. Unmatched delimiters render as literals (Slack does the same).

**Fix #5 — Surrounding messages section removed.** Deleted both the JSX call and the component function definition from `page.tsx`. Data-layer paths (`fetchLastNChannelMessages`, `thread_messages` field on `EllaRunDetail`) stay intact for future re-add per spec § E. Fix #2 reuses the same `rawMsgs` array that fed `thread_messages` — the data layer code paths actually find a second consumer here.

**Fix #1 — Hard-stopped.** See What's needed to unblock below.

## Verification

- **TypeScript** — `npx tsc --noEmit` clean.
- **ESLint** — `npx next lint` clean.
- **Playwright** — `scripts/verify-ella-pre-redesign-fixes.ts` ran against the preview URL. Two passes: first failed on a harness bug (`Show more` button text flips to `Show less` after click, breaking the indexed clicker); fixed by switching to `.first()` re-querying. Second pass captured all five screenshots cleanly.

### Captured screenshots (in `scripts/.preview/`)

- `ella-detail-no-surrounding.png` — full detail page; Surrounding messages section is absent (confirmed via DOM probe: `Surrounding messages section present: false`).
- `ella-triggering-collapsed.png` — Triggering message at ~500 chars with `Show more (11344 more chars)` link visible, plus the new "summary fallback" indicator path (not visible on this particular run since the run had a full Slack message).
- `ella-triggering-expanded.png` — same section fully expanded. mrkdwn rendering visible: bold headers, italic emphasis, bullet lines preserved, line breaks rendering correctly.
- `ella-response-collapsed.png` — Ella's response at ~500 chars with `Show more (3327 more chars)` link.
- `ella-response-expanded.png` — Ella's response fully expanded with mrkdwn rendering.

The target run was `f2e7427f-9206-43c4-9421-8b0f7d66d81e` — chosen because it had both messages long enough to demo truncation.

## Surprises and judgment calls

- **Hard stop #3 fired on fix #1.** The spec assumed Ella's escalation DMs land in `slack_messages` and can be joined like the main channel responses. They don't. The Slack ingestion pipeline (`ingestion/slack/pipeline.py`) only ingests client channels (and explicit extras). DMs to CSMs aren't tracked. The escalation DM body is constructed in-memory by `agents/ella/passive_dispatch.py:_fire_escalation_dm` and never persisted anywhere queryable beyond the haiku_reasoning in `webhook_deliveries.payload`. Both spec options (i) and (ii) presuppose the message is queryable — neither works. Surfacing per the hard stop. See What's needed to unblock.

- **Renderer line count.** The new `lib/slack/render-mrkdwn.tsx` is 239 total lines but ~150 non-comment / non-blank lines. Under the spec's 200-line trigger for "reconsider a markdown library." Comment density is high to document edge cases (Slack mrkdwn's quirks aren't intuitive). Chose to keep the comments rather than tighten — they're the kind of context the next reader needs.

- **The data layer paths Drake said to preserve are now actually consumed by fix #2.** Spec § E said keep `fetchLastNChannelMessages` + `thread_messages` field even though the UI is gone — for "future re-add." Fix #2's `triggering_message_full_text` reuses the same `rawMsgs` array, so the data paths find a second use today. The "preserved for the future" framing converts to "actively consumed."

- **`slack_response_text` is already the full text.** Spec § C asked Builder to "verify" this and add a join if not — verified by reading `fetchSlackResponseTexts`. It reads `match.text` from `slack_messages` directly, no truncation. No data-layer change needed.

- **Truncation choice: source-string vs CSS.** Spec was explicit ("actually truncate the rendered string so page weight stays low"). Implemented as source-string truncate with word-boundary detection. Side effect: when truncated mid-`*bold` syntax, the unmatched `*` renders literally — clean visual.

- **Renderer mid-cut behavior across the truncate.** The `Mrkdwn` component is fed the truncated string post-cut, then tokenizes. If the cut lands in the middle of `<https://...|label>`, the `<` becomes literal. Tested mentally on edge cases; the renderer's "unmatched syntax renders as literal" behavior degrades gracefully. Documented in a comment on `ExpandableMessage`.

- **Removed the JSX call AND the function definition for SurroundingMessagesSection.** Spec § E said: "Delete the JSX call. Delete the component function definition too if no other surface uses it." Grep confirmed no external imports. Both removed.

- **The Playwright harness target run had no "summary fallback" path.** The run I picked (which had `Show more` buttons available) happened to be one where slack_messages had the trigger row — so the new "summary fallback" indicator (the amber inline text on the trigger metadata line when `triggering_message_full_text` is null and we're rendering `input_summary` instead) doesn't appear in the screenshot. The code path is tested at typecheck time but not visually demonstrated. If you want a visual demo of the fallback path, find a run where realtime ingest was lagging — those will have `input_summary` only.

## What's needed to unblock fix #1

Spec hard stop #3 anticipated three options. Drake decides:

**(a) Accept a partial-render that shows the escalation status as-is.** Keep the current `"escalated via DM; csm=Lou Perez; dm_ok=True"` display. Maybe polish the rendering (parse out `csm=...` and render "Ella escalated to **Lou Perez**" with the dm-ok pill), but no real message text. Cheapest. Zero new code paths.

**(b) Extend the data model to track the escalation message.** Persist the constructed body in `webhook_deliveries.payload` (next to the audit row at `agents/ella/passive_dispatch.py:244`) so the dashboard can read it back. Migration: none — `payload` is a `jsonb`. Code change: one line in `_fire_escalation_dm` to add `body: body` to the `audit_payload` dict before insert. Dashboard change: extend `getEllaRunsList` to look up the matching `webhook_deliveries` row by some join key (slack_channel_id + triggering_message_ts, both already in `payload`). ~30 lines total across two files. Forward-only — historical escalation rows stay without the body until backfilled separately. Recommended option if Drake cares about the actual message.

**(c) Defer.** Leave the Output column as-is for escalation rows; revisit when Ella V2 work returns. Same as (a) but explicitly punt rather than polish.

**(d) Synthetic reconstruction (Builder's lean).** Reconstruct the body from existing data — slack_channel_id + triggering_message_ts (for the permalink) + `haiku_reasoning` (already on `EllaRunDetail`) + the fixed template literal from `_fire_escalation_dm`. Cheaper than (b) — no schema change, no data write change. Drift risk: if the template literal in passive_dispatch ever changes, the dashboard render diverges from what was actually sent. Mitigation: write a code comment in both files linking them so future changes update together.

Drake picks. Once chosen, Builder ships fix #1 in a follow-up commit; no additional Playwright needed if option (a) or (d); option (b) needs Vercel function logs spot-check on a fresh escalation to confirm the body lands in `payload`.

## Out of scope / deferred

- Fix #1 (escalation Output column) — pending Drake's call from the four options above.
- Drake's gate (c) manual verification on the deploy preview — click around, confirm mrkdwn rendering looks right on real messages, confirm Surrounding messages is gone from the visual scan.
- The Ella visual redesign (next spec; Design's job).
- Edge-case mrkdwn quirks (nested bold-in-italic, unmatched delimiters in unusual positions) — the renderer's "literal fallback" handles them gracefully; surfacing as a known limit only if a CSM reports a real rendering bug.
- Tests beyond Playwright screenshots — deferred per spec.

## Side effects

- **Pushed to `gregory-csm-visual-fixes` branch** (NOT main, per spec § Hard stop #1). Four commits in this spec's slice:
  - `63f8721` — spec cherry-picked (earlier turn).
  - `2fa1aef` — fixes #2-#5: renderer + expandable + data-layer extension + page wiring + SurroundingMessages removal.
  - `e5b89fd` — Playwright harness.
  - This report's commit (next).
- **No DB writes, no Slack posts, no external API calls** from this run. Playwright was read-only (Show more toggles are client-side state).
- **Status flag left `in-flight`.** Feature branch convention; Drake handles the flip on merge. Also, fix #1 is unresolved — `in-flight` is the accurate state regardless of the convention.
- **Local working-tree files preserved** from session start. Five new PNGs in `scripts/.preview/`.
- **No new dependencies** added (no markdown library per spec § Decision 6).
- **Harness file landed in commit; not a side effect in the report sense**, but worth noting it lives at `scripts/verify-ella-pre-redesign-fixes.ts` for future re-runs.
