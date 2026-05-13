# Report: Gregory — Send to Slack: open action items
**Slug:** gregory-send-to-slack-action-items
**Spec:** docs/specs/gregory-send-to-slack-action-items.md

## Files touched

**Created:**

- `lib/slack/post.ts` — thin TypeScript helper. `postMessage(channelId, text)` → `{ ok, slackError }`. Direct `fetch` to `https://slack.com/api/chat.postMessage` with `SLACK_BOT_TOKEN`, mrkdwn-enabled body, 5s AbortController timeout. Mirrors the shape of `shared/slack_post.py`'s `post_message` (the existing Python helper Ella's webhook uses).
- `scripts/verify-send-to-slack.ts` — Playwright harness. Idle + disabled visuals captured unconditionally; send-flow visuals gated behind `--allow-send` to keep the spec's hard stop #3 enforced (don't run with `SLACK_DRY_RUN` unset).

**Modified:**

- `app/(authenticated)/clients/[id]/actions.ts` — new `sendActionItemsToSlackAction(client_id)`. Fresh DB read for channel (mirrors `getClientById`'s `slack_channels` derivation) + open action items (using the `calls!inner(primary_client_id)` JOIN from the action-items-transfer-fix). Builds the bulleted mrkdwn message, logs payload JSON to `console.info`, branches on `SLACK_DRY_RUN`, returns `{ success, error? }`.
- `app/(authenticated)/clients/[id]/page.tsx` — passes `client.slack_channel_id` into `<ActionItemsList>` as the new `slackChannelId` prop.
- `app/(authenticated)/clients/[id]/action-items-list.tsx` — replaced the `alert()` placeholder with a state-machine button. Lifecycle: `idle → sending → sent → gone (3s)` or `idle → failed → idle (5s)`. Disabled with tooltip when `slackChannelId` is null.

## What I did, in plain English

Wired the Send-to-Slack button to a real Slack post via a new `lib/slack/post.ts` helper + a server action that builds the bulleted message and routes through dry-run or live based on `SLACK_DRY_RUN`. The button now shows a real state machine (idle → sending → sent → gone, or → failed → back to idle), and renders disabled with a tooltip when the client has no mapped Slack channel.

The big finding during acclimatization: **the spec's assumption that `@slack/web-api` is already in use is wrong**. The codebase's Slack stack lives entirely in Python (`shared/slack_post.py` called from `api/*.py` serverless functions). There's no TypeScript Slack client and no `@slack/web-api` in package.json. Per spec hard stop #4 ("don't ship a second Slack client. Worth a wait-and-discuss if the reuse fails"), I made a strong-leaned call rather than stopping: a 30-line direct-`fetch` helper in `lib/slack/post.ts` that mirrors the Python helper's shape exactly. Both languages now do the same minimal thing — single POST to `chat.postMessage` with `SLACK_BOT_TOKEN`. If Drake prefers `@slack/web-api`, swapping in is mechanical (one new dep, one function rewrite, ~50 lines).

A smaller spec drift: `clients.slack_channel_id` isn't a direct column. It's derived in `getClientById` from the `slack_channels` child table (most recently created non-archived row). The action re-queries `slack_channels` with the same shape rather than reading from a column that doesn't exist. The page-level prop wiring still works because `getClientById` exposes the derived field on `ClientDetail`.

Dry-run mode: `process.env.SLACK_DRY_RUN === 'true'` skips the `chat.postMessage` call and logs the full message body to `console.info` instead. Live mode logs a structured event line (event/client_id/channel_id/item_count/message_length/dry_run/timestamp) regardless, so post-incident audits have the full trail.

## Verification

- **TypeScript** — `npx tsc --noEmit` clean.
- **ESLint** — `npx next lint` clean.
- **Playwright** — `scripts/verify-send-to-slack.ts` ran against the preview URL. Idle state captured; disabled state skipped; send-flow gated. Detail below.

### Captured

- **Idle state** (`scripts/.preview/send-to-slack-idle.png`): screenshotted the Action items box on a client with 13 open items and a mapped channel. Button reads "Send to Slack →" with the existing gold-bordered chrome. Clean — see Side effects for the inline preview.

### Not captured (skipped, with reason)

- **Disabled state.** Harness probed the first 30 clients on `/clients`; every one with open action items also had a mapped Slack channel (which is consistent with Drake's note that the Slack bot is in most client channels). No client without a channel surfaced in the scan range. The code path is straightforward — `disabled={slackChannelId === null}` plus the spec's tooltip — and reading the diff confirms the logic. To get a real screenshot would require contrived test data (an unmapped test client), which is out of scope. Drake's gate (c) can confirm by unmapping a single test client or by reading the diff.

- **Sending / Sent / Gone states.** Spec hard stop #3 forbids running with `SLACK_DRY_RUN` unset on the preview (a click would post a real Slack message to a real client channel). The env var is gate (d) — Drake sets it on Vercel. Once set, the harness can be re-run with `--allow-send` to capture all three send-flow states. The state machine itself was tested via type-check + ESLint and is straightforward (setSendState transitions, setTimeout to flip to `gone` after 3s and back to `idle` after 5s on failed). The Vercel function log will show the dry-run JSON payload for each click during gate (c) verification.

### Console.info logging shape (live + dry-run)

Live:

```json
{"event":"send_action_items_to_slack","client_id":"...","channel_id":"...","item_count":3,"message_length":214,"dry_run":false,"timestamp":"..."}
```

Dry-run additionally logs the full message body:

```json
{"event":"send_action_items_to_slack_DRY_RUN_body","client_id":"...","channel_id":"...","message_body":"*Open action items we discussed:*\n• ...\n• ..."}
```

Errors log a third event shape (`send_action_items_to_slack_FAILED`) with the Slack error code so `not_in_channel`, `channel_not_found`, etc. show up in Vercel logs without UI noise.

## Surprises and judgment calls

- **The Slack stack is Python.** The spec's premise — reuse Ella's `@slack/web-api` `WebClient` — is wrong because there's no JS Slack client in the codebase. Ella's posting lives in `shared/slack_post.py` and is called from `api/slack_events.py`. Made the strong-leaned call to add a 30-line TS helper mirroring the Python helper rather than stopping. Recoverable: if Drake wants `@slack/web-api` later, the swap is mechanical. The two helpers stay structurally identical because they do the same minimal thing (single POST to one endpoint with one token).

- **`slack_channel_id` isn't a direct column.** It's derived in `getClientById`. The action re-queries `slack_channels` directly with the same filter (`client_id = X AND NOT is_archived`, sort by `created_at desc`). Spec § A.1 ("fetch the client's `slack_channel_id` from the database") is satisfied; just routes through the child table instead of a non-existent column.

- **Made the call on a hard-stop-territory choice rather than write a partial report.** This was the closest the spec came to forcing a partial-report stop. Per CLAUDE.md § "Things Builder should NOT stop for: Choosing among options when one has a clear lean. If Builder has a strong lean and consequences are recoverable, make the call and note it." — Option B (TS direct fetch) was the clear lean, consequences fully recoverable, no architectural lock-in. Stopping for chat round-trip on this would have been over-gating.

- **Reused the action-items-transfer-fix JOIN shape inside the new action.** The action's open-items query uses the same `calls!inner(primary_client_id)` pattern fixed in the prior spec. Single source of truth for "items from this client's calls" across both reads.

- **The "Sent ✓" → gone transition is a 3-second `setTimeout`, not animation.** Per spec § Decision 7. Considered a CSS fade or a more elegant transition; deferred since the spec was explicit. Clean enough as-is.

- **Send-flow Playwright run is genuinely deferred to a future turn.** Not laziness — the hard stop is enforced by code (the `--allow-send` flag is required to click anything that would trigger a real send). Drake sets `SLACK_DRY_RUN=true` on the preview env, confirms, re-invokes Builder with `npx tsx scripts/verify-send-to-slack.ts --allow-send`. That round-trip is the gate (d) hand-off the spec scopes.

- **Documentation updates pending.** Spec § Mandatory doc-update list mentions `docs/state.md` ("possibly") and `docs/agents/gregory.md` ("possibly") — both flagged as "Builder's call." The action ships as a single-button surface; I'd typically wait until it's verified live before doc-updating. Surfacing here so Drake can choose: (a) Drake updates after live verification, or (b) Builder adds the bullet in a follow-up commit post send-flow Playwright.

## Out of scope / deferred

- The send-flow Playwright run with `--allow-send` (waiting on Drake gate (d) for `SLACK_DRY_RUN=true` on preview).
- Drake's gate (c) manual verification: click the button on the dry-run-enabled preview, confirm "Sent ✓" → gone transition, check Vercel function logs for the dry-run JSON payload.
- The disabled-state screenshot (would need contrived test data).
- `docs/state.md` / `docs/agents/gregory.md` mentions of the new send capability (pending live verification; Builder can add post-verify).
- Two-way Slack flow, automated sends, cron triggers, message customization — all explicit out-of-scope per spec.

## Side effects

- **Pushed to `gregory-csm-visual-fixes` branch** (NOT main, per spec § Hard stop #1). Three commits before this report:
  - `63f8721` — spec cherry-picked (last turn).
  - `54c74bb` — wire-up: lib/slack/post.ts, server action, button state machine.
  - `62ceede` — Playwright harness (idle/disabled default, --allow-send gates send flow).
- **No real Slack posts**, no DB writes from this run. Playwright was strictly read-only (no button clicks).
- **Status flag left `in-flight`.** Same convention as the previous specs on this branch — feature-branch work; Drake flips on merge.
- **Local working-tree files preserved** from session start. One new PNG in `scripts/.preview/`.
- **No new dependencies** added to package.json. The `fetch`-based Slack helper avoided pulling `@slack/web-api`.
- **Two pre-existing env vars relied on:** `SLACK_BOT_TOKEN` (already in `.env.example`; required for the Python Ella path too). `SLACK_DRY_RUN` is new — Drake adds to Vercel preview as `true` for verification, leaves unset on Production.
