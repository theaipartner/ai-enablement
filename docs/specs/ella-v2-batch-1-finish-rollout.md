# Ella V2 Batch 1 — finish operational rollout

**Slug:** ella-v2-batch-1-finish-rollout
**Status:** in-flight

## Context

Batch 1 code shipped 2026-05-09 (per CLAUDE.md § Live System State). The realtime handler at `api/slack_events.py` and the historical backfill at `scripts/backfill_slack_client_channels.py` exist and are tested. What never ran: the operational rollout — populating `slack_messages` from the 8 channels Ella's bot is currently a member of, and verifying live ingestion fires when new messages arrive.

State today: `slack_messages` is empty in cloud. `webhook_deliveries WHERE source='slack_message_ingest'` is empty. The Slack app's event subscription was updated this weekend (`message.channels` added) but no traffic since then has confirmed the path works end-to-end.

This spec finishes the rollout for the 8 known-good channels (where the bot already has membership), verifies live ingestion is operational, and softens the backfill script's hard-stop on `bot_not_in_channel` so when the bot is added to more channels in the future, a single bulk backfill run won't abort on the first non-member channel.

The 129 other client channels (where Ella's bot is NOT yet a member) are deliberately out of scope for this spec — they require Drake-led ops work to add the bot, which is happening separately. Once the bot is in those channels, the same backfill script (with the softened hard-stop landing in this spec) will work against them with no further changes.

## Three tasks, one spec, one Builder session

Per CLAUDE.md § Bundling escape valve: these tasks are sequential and related. Builder commits each as its own logical commit per § Commits, then writes one report at the end covering all three.

---

### Task 1 — Soften backfill hard-stop on `bot_not_in_channel`

**Goal.** Modify `scripts/backfill_slack_client_channels.py` so a `bot_not_in_channel` error on any one channel doesn't abort the entire run. Instead, log the failure with a clear marker, continue to the next channel, and report a summary at the end with per-error-type counts.

**Why.** Today's behavior is `return 4` on the first `bot_not_in_channel` (line 168 of the script). When Drake eventually adds Ella to all 137 client channels and we run a full backfill, any channel that's still missing the bot for any reason (CSM forgot, channel archived between invite and backfill, etc.) will kill the entire bulk run. We want it to skip cleanly and process the rest.

**Out of scope on this softening:** other error types. `bot_not_in_channel` is the specific one we need to soften because it's the legitimate "bot wasn't successfully invited" case. Other errors (network, auth, malformed response) should still be reported per-channel but not crash the run either — but the existing per-channel error-collection logic (lines 195-201) already handles that correctly. Just `bot_not_in_channel` needs the hard-stop removed.

**Implementation notes:**
- Replace the `return 4` block (lines 159-170) with a log-and-continue pattern.
- The summary at the end (lines 204-206) should add a per-error-type count, e.g., `"Errors: 129 (bot_not_in_channel: 129)"`.
- `--smoke` mode keeps its current behavior — single channel, dry-run; the `not args.smoke` exit path is preserved.

**Acceptance test.** Running `--apply` against a mix of in-channel and not-in-channel channels should:
- Successfully backfill the in-channel ones.
- Log per-not-in-channel-channel "skipped" lines.
- Print a summary including the bot_not_in_channel count.
- Exit 0 if all in-channel channels succeeded, exit 1 if any in-channel channel had a different error.

---

### Task 2 — Backfill the 8 known-good channels into cloud

**Goal.** Populate cloud `slack_messages` with historical messages from the 8 channels Ella's bot is currently a member of. Use the modified backfill script from Task 1.

**The 8 channels** (slack_channel_id, client name; from a verified dry-run 2026-05-10):
- `C09FA7EQRDL` — Musa Elmaghrabi
- `C09GA380JRM` — Javi Pena
- `C0AUWL20U8J` — Javi Pena (duplicate-looking — note in report whether this is a real distinct channel or stale data)
- `C0AEEPVK36W` — Trevor Heck
- `C0AFEC456JG` — Dhamen Hothi
- `C0AF40ARZHD` — Jenny Burnett
- `C0AQQFG5UEP` — Art Nuno
- `C09TYEPLGBX` — Fernando G

**Sequence Builder follows:**

1. **Verify `slack_channels.client_id` is populated for all 8 channels** before backfilling. Run a query like:

```sql
select slack_channel_id, name, client_id
from slack_channels
where slack_channel_id in (
  'C09FA7EQRDL','C09GA380JRM','C0AUWL20U8J','C0AEEPVK36W',
  'C0AFEC456JG','C0AF40ARZHD','C0AQQFG5UEP','C09TYEPLGBX'
);
```

If any row has `client_id IS NULL`, hard-stop and surface — backfill against that channel will skip every message as `skipped_non_client_channel` because of the realtime-ingestion's first gate (which mirrors backfill's gate logic via the shared parser). The fix is upstream of this spec (populate `slack_channels.client_id` correctly), not a band-aid here.

If all 8 have `client_id` populated: proceed.

2. **Smoke run** on one channel to validate the pipeline end-to-end against real Slack API:

```bash
.venv/bin/python scripts/backfill_slack_client_channels.py --smoke --channel-id C09FA7EQRDL
```

Confirm output shows `messages_in_window > 0`. If zero, surface — that channel may be empty or the `--days 90` window is wrong.

3. **Apply** for each of the 8 channels individually:

```bash
.venv/bin/python scripts/backfill_slack_client_channels.py --apply --channel-id <id>
```

Per channel. Builder runs all 8 sequentially.

Why per-channel rather than a single batched `--apply`: the script (even with Task 1's softening) iterates the full 137-channel list and returns `bot_not_in_channel` for 129 of them. Per-channel is cleaner output and trivially scriptable — Builder loops over the 8 IDs.

4. **Post-backfill verification.** Query cloud `slack_messages` after each channel's apply:

```sql
select slack_channel_id, count(*), max(sent_at), min(sent_at)
from slack_messages
where slack_channel_id = '<id>'
group by slack_channel_id;
```

Reports row count, oldest message, newest message. Builder includes a summary table in the report covering all 8 channels.

**Acceptance criteria.**
- All 8 channels backfilled to cloud `slack_messages`.
- Total row count in `slack_messages` matches the sum of per-channel counts.
- No errors during backfill. (If any channel errors, surface and don't proceed to Task 3 — diagnose first.)

---

### Task 3 — Verify live ingestion is operational

**Goal.** Prove that a message posted in one of the 8 channels lands in cloud `slack_messages` via the live realtime path within seconds. This is the proof-of-life test we keep needing.

**Why.** The Slack app config was updated over the weekend; if the reinstall didn't take effect or the URL verification didn't fully succeed, `message.channels` events won't actually be flowing to our handler. Until we see a row in `webhook_deliveries WHERE source='slack_message_ingest'`, we don't know the live path works.

**Sequence Builder follows:**

1. **Pre-test baseline query.** Snapshot current row counts in cloud:

```sql
select count(*) as wd_count
from webhook_deliveries
where source = 'slack_message_ingest';

select count(*) as sm_count
from slack_messages;
```

Both numbers go in the report as the "before" state. (After Task 2, `sm_count` should be the post-backfill total. `wd_count` is likely 0 if nothing has happened post-backfill, since backfill writes to `slack_messages` directly without going through `webhook_deliveries`.)

2. **Drake posts a test message.** Builder cannot do this — Drake posts a message in `#ella-test-drakeonly` (channel `C09GA380JRM`) with a recognizable test string like `[ingest test 2026-05-10]`. Builder pauses execution and surfaces a clear "Drake: please post the test message" prompt with the exact channel name + suggested text.

3. **Post-test verification queries.** After Drake confirms posting, Builder queries:

```sql
-- Did the realtime path receive the event and create an audit row?
select webhook_id, processing_status, processing_error,
       payload->>'slack_channel_id' as channel,
       payload->>'slack_ts' as ts,
       payload->>'skip_reason' as skip_reason,
       processed_at
from webhook_deliveries
where source = 'slack_message_ingest'
order by processed_at desc
limit 5;

-- Did the message land in slack_messages?
select slack_channel_id, slack_ts, slack_user_id, author_type, text, sent_at
from slack_messages
where slack_channel_id = 'C09GA380JRM'
order by sent_at desc
limit 5;
```

3a. **Expected outcome.** A new `webhook_deliveries` row should exist with `processing_status='processed'` and no `skip_reason`. A new `slack_messages` row should exist with the test message text. The whole thing should land within 5-10 seconds of Drake posting.

3b. **If the audit row exists but `slack_messages` doesn't:** the message was received and ingested-or-skipped, but something filtered it. Check `processing_error` and `skip_reason` to diagnose.

3c. **If neither row exists:** Slack isn't reaching our handler. Builder surfaces this with a clear "live ingestion is NOT operational" finding and writes diagnostic guidance in the report. Do NOT attempt to fix the Slack app config — that's Drake's gate (d). Just diagnose and report.

3d. **If `webhook_deliveries` rows exist but they're tagged `skipped_non_client_channel`:** the channel allowlist gate is rejecting it. Verify `slack_channels.client_id` for that channel — same check as Task 2 step 1 but for the test channel specifically. If the gate is wrongly rejecting, that's a real bug worth surfacing for follow-up.

**Acceptance criteria.**
- A `webhook_deliveries` row appears with the expected status.
- A `slack_messages` row appears with the test message.
- Both within 10 seconds of Drake posting.
- If any of those don't happen, the report has a clear diagnostic with the queries that were run and their results — not a fix attempt.

---

## Hard stops

- **`slack_channels.client_id` missing for any of the 8 backfill channels** → stop, surface. The fix is upstream and Drake should know.
- **Smoke run returns zero `messages_in_window`** → stop, surface. The `--days 90` window may be wrong, or the channel may genuinely be empty.
- **Slack API rate-limiting during the backfill** → don't retry aggressively. The Slack client already handles backoff; if the backoff isn't enough, surface and let Drake decide whether to wait or run later.
- **Live ingestion test fails (Task 3, no rows landing)** → stop after diagnosing. Do NOT modify the Slack app config, the realtime handler, or the signing-secret env var. All of those are Drake's gates (d). Builder's job is "tell Drake what's broken," not "fix it."
- **Any change to `vercel.json`** → not needed for this spec; if Builder thinks one is needed, hard-stop.
- **Any new env var or scope** → not needed; if Builder thinks one is needed, hard-stop.

## Mandatory doc updates

- **`scripts/backfill_slack_client_channels.py` module docstring** — update the "Hard-stops if any channel returns `bot_not_in_channel`" line to reflect the new behavior (logs + continues; reports per-error-type counts).
- **`docs/runbooks/slack_message_ingest.md` § Failure modes + debugging** — update the "Symptom: backfill says `bot_not_in_channel` for a channel" entry. Today it says "hard-stops"; update to reflect log-and-continue behavior + summary count.
- **CLAUDE.md § Live System State, the 2026-05-09 Ella V2 Batch 1 entry** — append a sentence noting the backfill of 8 channels completed (date, total row count) and live ingestion verified operational.
- **No new schema docs needed.** No tables added.
- **No `docs/known-issues.md` entry** unless Task 3 surfaces something genuinely unfixed (e.g., live path not reaching handler).

## Side effects expected

Per CLAUDE.md § Builder behavior § Side effects:

- **Slack API calls.** `conversations.history` for each of the 8 channels (READ — no Slack-side state change). `users.info` calls for author resolution as needed.
- **Cloud DB writes.** Up to ~2,914 rows in `slack_messages` (the V1 local-backfill count, give or take). Audit-row writes in `webhook_deliveries` only for the live-ingestion test in Task 3.
- **Drake's actions.** One test message posted in `#ella-test-drakeonly` during Task 3.

NOT expected:
- Any Slack channel membership changes (no `conversations.invite` calls).
- Any change to Vercel env vars or Slack app config.
- Any Slack messages posted by Builder or Ella.

## What could go wrong

Think this through before writing code:

- The smoke run in Task 2 succeeds but a later channel's `--apply` produces zero inserts despite `messages_in_window > 0` — possible if `slack_channels.client_id` is populated for some channels but not others, and the parser silently skips ineligible messages.
- Slack rate-limiting hits mid-backfill — the underlying SlackClient should backoff, but if not, partial state lands in `slack_messages` and the run aborts.
- The 90-day window doesn't cover all V1 history — if V1 backfill happened > 90 days ago, the cloud backfill captures only the recent portion. If Drake wants the full V1 history mirrored, this spec doesn't cover it (would require lifting the `--days 90` default, which is a separate decision).
- Task 3 test message lands but takes > 30 seconds — could indicate Vercel cold-start latency on a function that hasn't been hit in a while. Note timing in the report.
- The two Javi Pena channel rows (`C09GA380JRM` and `C0AUWL20U8J`) might be a duplicate-channel issue in `slack_channels` rather than two real channels — Builder verifies in the schema-check step and surfaces if so.

## Commit + report

Three logical commits per CLAUDE.md § Commits:
- `fix(backfill): soften bot_not_in_channel hard-stop, add per-error summary` — Task 1.
- `ops(backfill): backfill 8 known-good Slack channels to cloud` — Task 2 (this is mostly an ops task, but the report itself is the artifact, so the commit captures the doc updates that go with it).
- `docs: update slack ingest docs post-rollout-verification` — the doc updates from § Mandatory doc updates.

Plus the final `docs: add report for ella-v2-batch-1-finish-rollout` commit per the report-writing convention.

Report at `docs/reports/ella-v2-batch-1-finish-rollout.md` per CLAUDE.md § Spec and report convention.
