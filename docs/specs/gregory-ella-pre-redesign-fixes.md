# Gregory — Ella pre-redesign fixes (output column + message rendering)
**Slug:** gregory-ella-pre-redesign-fixes
**Status:** in-flight

## Context

Four bugs on the Ella audit pages need to land before Design starts the visual redesign pass. The visual redesign requires the live preview to render correctly so Design's mocks reference real shipped content, not broken rendering. This spec fixes the rendering first; Design follows after.

The bugs:

1. **List view — escalation rows show status string in Output column.** Rows where Ella escalated (sent a DM to the CSM) currently render `"escalated via DM; csm=Lou Perez; dm_ok=True"` as their Output value. That's a status string, not Ella's actual message. Same shape as the `"queued (respond_substantive); pending_id=..."` placeholder fixed in the action-items-transfer-fix spec. The fix is analogous: when the row matches an escalation pattern in `output_summary`, fall through to a Slack-message join — but resolving to the CSM's DM channel (not the client's channel), since that's where the actual escalation message lives.

2. **Detail page triggering message is truncated.** The `Triggering message` section renders `run.input_summary`, which is documented as "Short human-readable input description" — i.e. summarized at write time. The full Slack message text (40+ lines on some runs) is unavailable. The fix is to join `slack_messages` on `(slack_channel_id, slack_ts) = (run.slack_channel_id, run.trigger_ts)` and read the full text. Display: truncate at ~500 chars in the rendered output with a "Show more" expand to full length. Don't truncate via CSS — actually truncate the rendered string so the page weight stays low.

3. **Detail page Ella's response has the same issue.** The full response lives in `slack_messages` for the bot's outgoing message; the page currently reads `output_summary` (200-char limit per the data layer comment) or `slack_response_text`. Confirm which field is most complete; use the most complete source. Same truncate-at-500-with-Show-more pattern.

4. **Markdown/mrkdwn rendering on both messages.** Today both the triggering message and Ella's response render as plain text inside a `<pre>` block (or whitespace-pre-wrap). Slack-formatted text (`*bold*`, `_italic_`, `• bullet`) renders as raw characters. The fix is a small Slack-mrkdwn renderer that interprets:
   - `*text*` → bold
   - `_text_` → italic
   - `~text~` → strikethrough
   - `<@USERID>` → resolved name (helper already exists in `lib/slack/render-mentions.ts` — reuse)
   - `<#CHANNELID|name>` → `#name` (no resolution needed; the human-readable name is already in the syntax)
   - Bullet points (`•` at line start) → proper list rendering
   - Line breaks preserve as `<br/>` or paragraph splits
   - Code blocks (` ``` `) → preserved as monospace

The renderer is small (under 100 lines) and lives in `lib/slack/render-mrkdwn.tsx` (React component) or `lib/slack/render-mrkdwn.ts` (string-to-React-elements helper). Builder picks based on cleanest composition.

Plus removal:

5. **Detail page Surrounding messages section — remove from the UI.** Drake's call: cut entirely. The data layer call (`fetchLastNChannelMessages`, the trigger-inclusion logic, the join through `slack_messages`) STAYS in `getEllaRunDetail` so re-adding the UI later is trivial. Just delete the `<SurroundingMessagesSection>` JSX render from `app/(authenticated)/ella/runs/[id]/page.tsx`. Drop the component definition too if no other surface uses it (verify via grep).

Working branch: `gregory-csm-visual-fixes` (same as active CSM/action-items work). Preview URL: `https://ai-enablement-git-gregory-csm-visual-fixes-drakeynes-projects.vercel.app`. Auth bypassed on Preview.

## Reference reads (in this order)

1. `app/(authenticated)/ella/runs/[id]/page.tsx` — current detail page rendering. The triggering message renders at the `<MetaRowSection title="Triggering message">` block; Ella's response at the next section. Surrounding messages at `<SurroundingMessagesSection>`.
2. `app/(authenticated)/ella/runs/page.tsx` and `app/(authenticated)/ella/runs/runs-table.tsx` (or wherever the list column rendering lives) — the Output column. Find where escalation rows hit the placeholder branch and fall through to nothing better.
3. `lib/db/ella-runs.ts` — `getEllaRunsList` (Output column data path) and `getEllaRunDetail` (detail page data path). Both need extension: the list to resolve escalation DMs; the detail to fetch full message text.
4. `lib/slack/render-mentions.ts` — existing helper. Reuse for `<@USERID>` rendering inside the new mrkdwn renderer.
5. `docs/schema/agent_runs.md` — confirms `input_summary` and `output_summary` are summarized at write time. Justifies the slack_messages join for the full text.
6. `docs/schema/slack_messages.md` — the table being joined. Confirm `slack_ts` is the right join key (vs `event_ts` or other).
7. Search for any existing Slack-mrkdwn formatting helper in the repo — Drake mentioned "we already created something for this so Ella doesn't respond with the formatting issues." Builder finds it via grep (`mrkdwn`, `format_slack`, `markdown_to_slack`, `slack_format`). If found, reuse instead of building new. If not found, build the new helper.

**Acclimatization checkpoint:** before writing any code, confirm in 4–6 bullets in your first commit message: (a) whether an existing Slack-mrkdwn helper exists in the codebase — quote the file path if so, "not found" if not, (b) the exact column on `slack_messages` matching the `agent_runs.trigger_ts` value (likely `slack_ts`), (c) for escalation DMs — the channel ID source (is it on `agent_runs`, derived from `trigger_metadata`, or resolved via the CSM team_member's DM channel? Verify), (d) the file map you intend to touch, (e) your renderer architecture — pure function returning React elements, or a component, (f) any unexpected drift between this spec and what you find.

## Decisions locked in by Director

From Drake/Director conversation 2026-05-14.

1. **Output column for escalation rows shows the actual DM Ella sent**, sourced from `slack_messages` via the CSM's DM channel. Same fallback chain as `queued (` placeholders: if `output_summary` matches an escalation placeholder pattern (something like `escalated via DM; csm=...; dm_ok=...`), fall through to the Slack join. If the Slack message isn't found, render `—` muted as last resort.

2. **Both message sections on the detail page show full text** via `slack_messages` join (not `input_summary` / `output_summary`). Truncate the rendered string at 500 chars with a "Show more" expand toggle. The toggle reveals the full message. State is local to the section, no URL persistence.

3. **Slack-mrkdwn rendering applies to both detail-page messages.** Same renderer. Renderer supports the subset listed in the Context above. Existing mention-rendering helper composes inside.

4. **Surrounding messages section removed from the UI**. Data layer paths stay intact for future re-add.

5. **List view Output column rendering — keep the existing mention/emoji rendering** that was shipped in the prior Ella list-polish spec. The escalation fix adds a new fallback path; the existing path stays.

6. **No new dependencies.** Don't pull `react-markdown` or similar. The renderer is small enough to write directly; bringing in a library adds bundle weight and shipping risk for a feature that doesn't need the full markdown surface.

7. **Playwright visual verification REQUIRED.** Same hard requirement as the prior three specs. Builder verifies on the deploy preview before flipping shipped. Screenshots inline in the report covering: list view escalation row's Output column, detail page triggering message (truncated + expanded states), detail page Ella's response (truncated + expanded states), confirmation that Surrounding messages section is gone.

## What success looks like

### A. List view — escalation Output rendering

In `lib/db/ella-runs.ts`, the `getEllaRunsList` projection currently falls through `output_summary` → Slack join → null for the Output text. Extend the placeholder-skip logic to recognize escalation status strings:

```typescript
const ESCALATION_PLACEHOLDER_PATTERN = /^escalated via DM/i

const isPlaceholder = (s: string | null) =>
  s != null && (
    s.trim().startsWith('queued (') ||
    ESCALATION_PLACEHOLDER_PATTERN.test(s.trim())
  )
```

When the row matches escalation, the fallback join needs to find the CSM's DM message, not the client channel. Two real options:

- **(i)** Parse the CSM identity from `trigger_metadata` or `output_summary` (e.g. `csm=Lou Perez`), resolve to the CSM's `team_member` row, then find the DM channel. Multi-step.
- **(ii)** Find the most recent message from the Ella bot in any channel within ~30 seconds of `started_at`. Simpler but less precise; could accidentally pull a different bot message.

Builder picks based on what data is actually available. Spec § Hard stop 3 covers the case where neither path works cleanly.

When the message is found, render it through the existing mention/emoji rendering pipeline (consistency with non-escalation rows). When not found, render `—` muted.

### B. Detail page — triggering message full text + truncation

In `getEllaRunDetail`, add a new field to `EllaRunDetail`: `triggering_message_full_text: string | null`. Populate via slack_messages join: `slack_messages.text` where `(slack_channel_id, slack_ts) = (run.slack_channel_id, run.trigger_ts)`. If no match (synthetic test data, ingest delay), `triggering_message_full_text` is null; the page falls back to `run.input_summary` as today.

In `app/(authenticated)/ella/runs/[id]/page.tsx`, the `Triggering message` section renders `run.triggering_message_full_text ?? run.input_summary`, truncated to 500 chars with a "Show more" button. Builder picks the truncation point at a word boundary (cleanest) or just at char 500 with an ellipsis (simplest). Word boundary is preferred but not blocking.

Truncation state is a small client component (`'use client'`) wrapping the message render — `useState` for expanded/collapsed, click "Show more"/"Show less" to toggle.

### C. Detail page — Ella's response full text + truncation

In `getEllaRunDetail`, verify `slack_response_text` is the most complete source for Ella's outgoing message. If yes, that's what the page renders. If `slack_response_text` is also summarized or capped, extend with a fresh join to `slack_messages` for the bot's outgoing message in the channel.

The handoff-extraction logic (the `[ESCALATE]` marker split) stays unchanged. Render the client-facing portion through the new mrkdwn renderer with the 500-char truncate + "Show more" pattern.

### D. Slack-mrkdwn renderer

Create `lib/slack/render-mrkdwn.tsx` (React component) or `lib/slack/render-mrkdwn.ts` (string-to-React helper). Builder's call on architecture.

Supports:

- `*text*` → `<strong>text</strong>`
- `_text_` → `<em>text</em>`
- `~text~` → `<del>text</del>`
- ` ```code``` ` → `<pre><code>code</code></pre>` (block) or `<code>code</code>` (inline)
- `<@USERID>` → resolved name via existing mention helper
- `<#CHANNELID|channel-name>` → `#channel-name`
- `<https://...|link text>` → `<a href="https://...">link text</a>`
- Bullet lines starting with `• ` → list rendering (visual bullet preserved, line break after)
- Single newline → soft break (`<br/>` or paragraph)
- Double newline → paragraph break

What it does NOT support (out of scope):

- Tables
- Numbered lists (Slack doesn't render these in mrkdwn anyway)
- HTML escaping beyond what React provides naturally
- Custom emoji (`:emoji_name:` stays as raw text)

The renderer is purely formatting — it doesn't sanitize for XSS because we control the message source (Ella's prompt output + Slack-ingested client messages, both already trusted in this app).

### E. Surrounding messages section — UI removal

Delete the `<SurroundingMessagesSection>` JSX call in `app/(authenticated)/ella/runs/[id]/page.tsx`. Delete the component function definition in the same file. The data layer paths (`fetchLastNChannelMessages`, the trigger-inclusion logic) stay in `lib/db/ella-runs.ts` for future re-add. The `thread_messages` field on `EllaRunDetail` also stays — costs nothing and preserves the contract.

### F. Playwright visual verification

Required. `scripts/verify-ella-pre-redesign-fixes.ts` (or extend existing harness):

1. Navigate to `/ella/runs` on the preview.
2. Find an escalation row visually (or via the table data). Screenshot the row showing the new Output column rendering.
3. Click into a non-escalation passive run. Screenshot the detail page showing: triggering message section (truncated, "Show more" visible), Ella's response section (truncated, "Show more" visible), no Surrounding messages section.
4. Click "Show more" on the triggering message. Screenshot the expanded state.
5. Click "Show more" on Ella's response. Screenshot the expanded state.
6. Click into an escalation run from the list. Screenshot the detail page to confirm rendering consistency.

Screenshots inline in the report. Each screenshot has a one-line caption explaining what it demonstrates.

## Hard stops

1. **Do not push to `main`.** Push commits to `gregory-csm-visual-fixes` branch.

2. **Do not flip Status to shipped without Playwright screenshots demonstrating all five surfaces** (list escalation Output, detail page triggering message collapsed + expanded, detail page Ella's response collapsed + expanded, surrounding messages gone).

3. **If the escalation DM source can't be cleanly resolved** (neither (i) nor (ii) from § A works, e.g. `trigger_metadata` doesn't carry the CSM identity and the bot-message-search returns ambiguous results), stop and surface. Drake decides whether to (a) accept a partial-render that shows the escalation status as-is, (b) extend the data model to track the escalation message, or (c) defer.

4. **If an existing Slack-mrkdwn helper is found during acclimatization** but its surface differs significantly from what § D needs (e.g. it's Python and would need a TS port, or it handles a different syntax set), surface before duplicating. Don't ship two helpers.

5. **If the renderer turns out to need 200+ lines** for the supported syntax set, surface — the simple-direct-implementation premise is wrong and we should reconsider whether a lightweight markdown library is the right answer.

## Think this through yourself — what could go wrong

- **`slack_messages` join might not have the trigger message indexed.** If a run fires and Slack's realtime ingest hasn't caught up, the `(slack_channel_id, slack_ts)` lookup returns null. Mitigated: fall back to `input_summary` as today. Render still works, just at the summary length.

- **`slack_response_text` field on `EllaRunDetail` might already be the full response.** If so, no data-layer change needed for Ella's response — just the renderer + truncation. Builder verifies during acclimatization.

- **Mrkdwn edge cases.** What happens with `*nested *bold* text*`? With `*text` (unmatched asterisk)? With `_word_with_underscores_`? Real Slack messages are messy. Mitigation: the renderer handles the common cases per § D; weird edge cases render as-is (the asterisk shows up). Document the limit in code comments; if a CSM reports an actually-broken rendering, file a follow-up.

- **The "Show more" toggle breaks SSR.** It's `'use client'`, has state, renders different content based on expanded/collapsed. SSR initial render uses collapsed state; hydration matches. Should be straightforward; Builder uses the established client-component pattern in this codebase.

- **Truncation at 500 chars might cut mid-mrkdwn-tag.** Truncating `"Here's the report: *Pain p"` mid-bold means the renderer sees an unmatched `*`. Mitigation: truncate first, render second. The renderer's "render unmatched syntax as-is" behavior handles it. The cut text looks weird but doesn't crash.

- **Escalation DM resolution might surface CSMs who aren't in `team_members`.** Edge case if an escalation went to someone outside the team. Mitigated: render `—` if resolution fails, log to console.warn for visibility.

- **Removing surrounding messages might reveal a dependency.** Other components might import from the deleted code path. Mitigation: TypeScript catches it at build time; Builder fixes any broken import before pushing.

## Mandatory doc-update list

- `docs/state.md` — no update needed.
- `docs/known-issues.md` — only if the renderer's edge cases surface as a known limit worth tracking.
- `CLAUDE.md` — no update needed.
- `docs/agents/ella/ella.md` — no update needed.
- `docs/runbooks/design-handoff.md` — no update needed.

## Out of scope for this spec (explicit)

- The Ella visual redesign (Design's job, after this spec lands).
- Adding new sections to the detail page.
- Action items, Slack send-to-channel, or any non-Ella surface.
- Numbered lists, tables, or other unsupported mrkdwn syntax in the renderer.
- Custom emoji rendering (`:emoji_name:`).
- Re-adding the Surrounding messages section (will happen in Design's redesign if Design wants).
- Backfilling truncated `input_summary` values in the database (we just bypass them; the column stays as-is).
- Tests beyond Playwright screenshots — deferred.
