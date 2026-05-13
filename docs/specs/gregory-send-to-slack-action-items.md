# Gregory — Send to Slack: open action items
**Slug:** gregory-send-to-slack-action-items
**Status:** in-flight

## Context

The Action items box on `/clients/[id]` has a "Send to Slack" button shipped as a placeholder during the redesign. This spec wires it to a real Slack post.

When a CSM clicks the button, Gregory posts a short bulleted summary of the client's open action items to the client's mapped Slack channel. Format is loose and conversational, not a formal report — designed to surface what's pending in the room with the client without ceremony.

Same Slack stack as Ella — `WebClient` from `@slack/web-api`, posting as the configured bot user, channel ID sourced from `clients.slack_channel_id`. The infrastructure exists; this spec wires a new caller.

Working branch: `gregory-csm-visual-fixes` (same as the active CSM visual fixes + action items transfer work). Preview URL: `https://ai-enablement-git-gregory-csm-visual-fixes-drakeynes-projects.vercel.app`. Auth bypassed on Preview, Playwright can hit.

## Reference reads (in this order)

1. `app/(authenticated)/clients/[id]/page.tsx` — Action items box. Find the "Send to Slack" button placeholder; trace where the click handler lives (likely in `action-items-list.tsx` or similar). The button's structure stays; we wire its action.
2. `app/(authenticated)/clients/[id]/action-items-list.tsx` (or equivalent — Builder finds the actual file) — the client component rendering the action items + the Send-to-Slack button. The button gains a new `onClick` calling a new server action.
3. `lib/db/clients.ts` — `getClientById` returns `client.slack_channel_id`. The new server action reads from `clients` to resolve the channel. Verify the field name matches.
4. Find the Slack client used by Ella for posting — likely `lib/slack/` or wherever Ella's `chat.postMessage` lives. Reuse the same client, same bot identity. Don't introduce a second Slack client.
5. `app/(authenticated)/clients/[id]/actions.ts` — existing server actions for the client detail page. New `sendActionItemsToSlackAction` lands here.
6. `docs/schema/clients.md` — verify `slack_channel_id` (or whichever field) is the right column. Confirm it can be null.

**Acclimatization checkpoint:** before writing any code, confirm in 4–5 bullets in your first commit message: (a) the exact location of the Slack client used by Ella for `chat.postMessage` — file path + import name, (b) the column name on `clients` holding the Slack channel ID (verify nullability), (c) where the Send to Slack button placeholder lives today (file + line), (d) the dry-run env var name you'll add (e.g. `SLACK_DRY_RUN=true`), (e) any unexpected drift between this spec and what you find.

## Decisions locked in by Director

From Drake/Director conversation 2026-05-14.

1. **Server action: `sendActionItemsToSlackAction(clientId: string)`.** Returns `{ success: true } | { success: false; error: string }`. Reads the client's open action items + channel ID, formats the message, posts via the existing Slack `WebClient`, returns success/failure.

2. **Message format:**

   ```
   *Open action items we discussed:*
   • <item description 1>
   • <item description 2>
   • <item description 3>
   ```

   - First line uses Slack mrkdwn bold (`*…*`, single asterisks — not Markdown's `**…**`). Slack's mrkdwn flavor matters; the action's `chat.postMessage` call uses `mrkdwn: true` (default) and passes the text as-is.
   - Bullets use `•` (Unicode bullet, U+2022), not `-` or `*`.
   - Each item is the action item's `description` field as-is. No reformatting of the item text itself.
   - No header beyond the first line, no footer, no client name, no signature.
   - If the client has zero open action items, the button is already in a disabled state (per § E below); the action shouldn't be reachable. Defensive guard: action returns `{ success: false, error: 'No open action items' }` if called anyway.

3. **Fresh data on send.** The action re-queries the client's open action items at send time, not from the rendered page state. If a CSM edits an item milliseconds before clicking Send, the new description goes out. This is the database, not the React tree.

4. **Channel resolution: automatic from `clients.slack_channel_id`.** No CSM picker, no override. If null, the button is disabled at render time (§ E).

5. **Sender identity: the existing Ella/Gregory bot.** Reuse the same Slack WebClient Ella posts with. No new bot, no new auth, no new token.

6. **Dry-run mode for testing.** Add a `SLACK_DRY_RUN` env var. When set to `"true"`, the action builds the message and resolves the channel ID like normal, but instead of calling `chat.postMessage`, it logs the full payload (channel ID + rendered message) to `console.info` and returns `{ success: true }`. The CSM sees the "Sent ✓" confirmation in the UI as if it had been real. Drake unsets the env var when ready to ship for real. Default behavior (env var unset or any value other than `"true"`) is real send.

7. **Post-send UX:** show "Sent ✓" in place of the button for ~3 seconds, then the button disappears entirely. Same idea as the original "click → confirm → disappear" Design call.

8. **Button disabled when `clients.slack_channel_id` is null.** Render time. Tooltip on hover: `"No Slack channel mapped for this client."`. No click, no error path needed.

9. **Observability: log every send.** Server-side `console.info` with `{ client_id, channel_id, message_length, item_count, dry_run, timestamp }`. Visible in Vercel function logs. Not user-facing. The point is post-incident debuggability if a message goes to the wrong channel or contains wrong content — the log tells us exactly what was sent where.

10. **Playwright visual verification required.** Same hard requirement as the prior two specs. Builder runs the Playwright harness against the preview with `SLACK_DRY_RUN=true`, screenshots the button states (idle, sending, sent, disabled), and confirms the dry-run log captures the expected payload.

## What success looks like

### A. Server action

`sendActionItemsToSlackAction(clientId: string)` in `app/(authenticated)/clients/[id]/actions.ts`:

1. Fetch the client's `slack_channel_id` and open action items from the database. Don't trust client-side state.
2. If `slack_channel_id` is null, return `{ success: false, error: 'No Slack channel mapped for this client' }`.
3. If the open action items array is empty, return `{ success: false, error: 'No open action items' }`.
4. Build the message text per Decision 2's format.
5. Log the payload (`console.info(JSON.stringify({ event: 'send_action_items_to_slack', client_id, channel_id, message_length, item_count, dry_run, timestamp }))`).
6. If `process.env.SLACK_DRY_RUN === 'true'`, log the full message body to `console.info` and skip the `chat.postMessage` call.
7. Otherwise, call `chat.postMessage({ channel, text, mrkdwn: true })` via the existing Slack `WebClient`.
8. On Slack API failure, return `{ success: false, error: '<api error message>' }`. The Slack client's typed errors should propagate cleanly.
9. On success, return `{ success: true }`.

No `revalidatePath` needed — sending doesn't change anything visible on either route. The Action items list doesn't change on send (items don't auto-complete; CSM still has to mark them done explicitly).

### B. Message format helper

Pure function — easy to test, easy to read. Roughly:

```typescript
function formatActionItemsMessage(items: Array<{ description: string }>): string {
  const bullets = items.map(it => `• ${it.description}`).join('\n')
  return `*Open action items we discussed:*\n${bullets}`
}
```

Builder can co-locate with the server action or factor to `lib/slack/format-action-items.ts` — judgment call.

### C. Button wiring

The existing "Send to Slack" button in the Action items box becomes interactive:

1. Idle state: shows "Send to Slack" with the existing gold-bordered styling.
2. On click: button text changes to "Sending…" or a small spinner appears.
3. On success: button text changes to "Sent ✓" with a brief gold-tinted background flash.
4. After ~3 seconds: the button disappears entirely (component-level conditional render or state-driven hide).
5. On failure: button text changes to "Failed — try again" in red-tinted styling for ~5 seconds, then reverts to idle. The error is also surfaced via `console.error` for debugging.

Use the existing `EditableField` / inline-edit error pattern as a precedent for the failure UX — same inline-tooltip approach if it fits, or just inline button text change if simpler.

### D. Disabled state

When `client.slack_channel_id` is null at render time, the button renders disabled with tooltip `"No Slack channel mapped for this client."`. No click handler attached. The action server-side guard from § A.2 is defensive belt-and-suspenders — should never be hit if § D works correctly.

### E. Dry-run mode

Env var: `SLACK_DRY_RUN` (string). Read at action execution time via `process.env.SLACK_DRY_RUN === 'true'`.

When dry-run mode is on:

- Action runs through everything except the `chat.postMessage` call.
- Logs the full message body to `console.info`: `{ event: 'send_action_items_to_slack_DRY_RUN', client_id, channel_id, message_body }`.
- Returns `{ success: true }` — UI flows as if it had really sent.
- The Vercel function log shows what would have been sent.

Drake sets `SLACK_DRY_RUN=true` on Preview environment while testing. Unsets before merging to main (or leaves it explicitly off on Production, scoped per env). Verify with Builder before merge that the env var is NOT set on Production.

### F. Playwright visual verification

Required. `scripts/verify-send-to-slack.ts` (or extend existing harness):

1. Navigate to `/clients/[id]` for a client with open action items + a mapped Slack channel. Builder picks a stable test client.
2. Screenshot the Action items box with the "Send to Slack" button in idle state.
3. Click the button.
4. Screenshot the transitional state ("Sending…").
5. Wait for completion.
6. Screenshot the "Sent ✓" state.
7. Wait 4 seconds.
8. Screenshot the post-send state (button gone).
9. Navigate to a client WITHOUT a mapped Slack channel (or temporarily set the channel to null via DB if no such client exists in prod). Screenshot the disabled button state with tooltip.
10. Confirm via Vercel function logs that the dry-run payload was logged with the expected client_id, channel_id, and message body.

Screenshots inline in the report. The report explicitly confirms each screenshot demonstrates the expected behavior. If any state doesn't render correctly, iterate.

## Hard stops

1. **Do not push to `main`.** Push commits to `gregory-csm-visual-fixes` branch. Drake merges manually after review.

2. **Do not flip Status to shipped without Playwright screenshots demonstrating all four button states** (idle, sending, sent, disabled) AND a confirmed dry-run log entry in Vercel function logs.

3. **Do not run the Playwright verification with `SLACK_DRY_RUN` unset.** If unset, real messages will go to real channels. Builder verifies the env var is `'true'` before running the harness.

4. **If the Slack `WebClient` reuse turns out to be non-trivial** (e.g. it's not exported, or requires a constructor with credentials not currently in env), surface before duplicating. Don't ship a second Slack client. Worth a wait-and-discuss if the reuse fails.

5. **If `clients.slack_channel_id` doesn't exist or has a different name** (e.g. `slack_channel`, `channel_id`, or it's in `clients.metadata` JSON), surface. The disabled-button logic and channel resolution depend on the field being a direct column.

## Think this through yourself — what could go wrong

- **Slack mrkdwn formatting.** Slack uses its own flavor of Markdown — single asterisks for bold, not double. `**bold**` shows up as literal asterisks. Builder uses single-asterisks per Decision 2. If items in the action description happen to contain `*` or `_` characters, those will be interpreted as Slack mrkdwn and could render weird. **Mitigation:** Slack's API has `mrkdwn: false` for plain text, but losing bold for the header line. Worth: items rarely contain `*` in practice. Build with mrkdwn: true, accept the edge case, surface if it becomes visible. The Vercel log catches anything weird.

- **Item descriptions with newlines.** If an action item description has embedded `\n` chars, the bullet list will look broken — one bullet per logical item, but the second line of a multi-line item starts at column 0 instead of indented. **Mitigation:** join lines within a description with `' / '` or just leave them; CSMs notice and fix the source if it's ugly.

- **Long item lists.** If a client has 30 open items, the Slack message gets long. Slack's `chat.postMessage` text limit is 40,000 chars. Practically not an issue at current data shapes (Drake noted no client has even 10). **Mitigation:** none preemptively.

- **The button disappearing after success.** This is intentional per Decision 7 — once sent, the visual disappears so the CSM doesn't accidentally re-send. But what if they want to send again with a new edit? **Mitigation:** refresh the page; button reappears. Acceptable — sending to Slack is "I'm done with this for now" gesture; new edits is a different session.

- **Production env var contamination.** If `SLACK_DRY_RUN=true` accidentally lands on Production, real users click and nothing happens (silent dry-run). CSMs would notice the channels never getting messages and report. Drake reverts the env var. **Mitigation:** the spec hard-stop calls for confirming env var status on Production before merge. Builder names the production env var status in the report.

- **Race condition between read + send.** Action reads items, builds message, sends. If a CSM edits an item in between (e.g. another CSM session, or themselves in another tab), the sent message reflects the read-time state. **Mitigation:** acceptable — the action runs in tens of milliseconds; the race window is tiny. CSMs can re-send if needed.

- **The bot's identity on the destination channel.** The Ella bot is in many channels but maybe not all. If the bot isn't a member of the client's mapped channel, `chat.postMessage` fails with `not_in_channel`. **Mitigation:** the error propagates back to the UI; CSM sees "Failed — try again" and the underlying Slack error in console. CSM (or Drake) adds the bot to the channel. Not in scope to auto-invite.

## Mandatory doc-update list

- `docs/state.md` — possibly. New shipped capability; worth one bullet noting Send-to-Slack action items wired. Builder's call within existing voice.
- `docs/known-issues.md` — only if something surfaces during build.
- `docs/agents/gregory.md` — possibly. Send-to-Slack from the client detail page is a new bot behavior on Gregory's side; one short paragraph if the doc has a section on bot interactions.
- `docs/agents/ella/ella.md` — no update needed; Send-to-Slack uses the same bot Ella uses but isn't part of Ella's behavior.
- `docs/runbooks/design-handoff.md` — no update needed.
- `CLAUDE.md` — no update needed.

## Out of scope for this spec (explicit)

- Two-way Slack interaction (clients replying to action items in Slack and having those reflected in Gregory).
- Automated sends (cron-triggered Slack posts of stale action items).
- Per-CSM customization of the message format.
- Sending from any surface besides `/clients/[id]` (e.g. from `/calls/[id]` directly).
- Action items including due dates, owners, or other context in the Slack message (description only).
- Confirmation modal before sending (no "Are you sure?" — click is the confirm).
- Undo / unsend (Slack doesn't really support this; CSM can manually delete from Slack if needed).
- Sending closed/completed action items, only `status='open'` items go out.
- Multi-channel send (one client = one channel).
- Auto-inviting the bot to channels where it isn't a member.
- Tests beyond Playwright screenshots — deferred.
