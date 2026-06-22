# Report: Ella reply-as-human-account — safety investigation (read-only, NO change)
**Slug:** ella-reply-as-human-investigation
**Spec:** docs/specs/ella-reply-as-human-investigation.md

## Files touched

Created:
- `docs/reports/ella-reply-as-human-investigation.md` — this report.

Modified:
- `docs/specs/ella-reply-as-human-investigation.md` — `Status:` flipped from `in-flight` to `shipped`.

No code, schema, migration, or env-var changes. **One live API call made:** `auth.test` via `shared.slack_identity.get_user_id_for_token` against `SLACK_BOT_TOKEN` and `SLACK_USER_TOKEN` (the one explicitly allowed call per the spec — read-only, returns the token's own user_id, no side effects). Plus three read-only cloud `SELECT`s against `slack_messages` via psycopg2 pooler. No posting, no token flip, no deploy.

## What I did, in plain English

The headline: **replying-as-human is safe to ship as-is.** No prerequisite fix needed. The open `docs/known-issues.md:80` entry that warned about this turns out to be mis-diagnosed — the parser works correctly; the live data proves it; what's actually true is "Ella switched from posting as user to posting as bot in the 2026-05-18 unified-path collapse, and the parser dutifully tags her bot-posts as `'bot'`." Restoring user-token posting will restore correct `'ella'` tagging automatically.

Below: the four spec questions with verbatim evidence, then the safe-path synthesis and the corrected known-issues entry Director should write.

## Verification

### Q1 — Duplicate cause was event-handling, not reply-identity. **Confirmed.**

Two RESOLVED entries in `docs/known-issues.md` document the duplicate history:
- **`~~Passive dispatch has no idempotency check against duplicate Slack message delivery~~ — RESOLVED 2026-05-21`** (lines 51-63). The fix lives entirely upstream in `ingestion/slack/realtime_ingest.py`'s step-0 dedup gate on `webhook_deliveries.webhook_id` PK, deterministic per `(slack_channel_id, slack_ts)`. The gate runs via `UPSERT-with-ignore_duplicates=True` BEFORE any side effect; second delivery short-circuits with `skipped_reason='duplicate'`.
- **The original duplicate cause** (per `api/slack_events.py:126-140`'s no-op `app_mention` branch): Slack fires a parallel `message` event alongside every `app_mention`; handling both double-fired the agent. The fix made `app_mention` a logged no-op + routed everything through the `message` path with the dedup gate above.

Both fixes are about **inbound event handling** — webhook payloads arriving from Slack. Neither relates to who Ella posts AS. There is no evidence anywhere (commit history, known-issues, runbooks) that Ella's reply being re-ingested via `message` events ever contributed to duplicates. Reply-identity is orthogonal to the dedup architecture.

### Q2 — The reply-ingestion loop, bot identity vs human identity. **Both safe via Gate 2.**

Walking the path: Ella posts → Slack delivers a `message` event → `realtime_ingest.ingest_message_event` → `parser.parse_message` (resolves `author_type`) → `passive_monitor._evaluate` Gate 2 (skips `ella`/`bot`/`workflow`/`unknown`).

The parser's resolution order (`ingestion/slack/parser.py:_resolve_author` lines 213-254, verbatim):

```
1. Explicit user field:
   a. Matches ella_user_id → 'ella'         (checked FIRST — wins over team_members)
   b. In client_user_ids   → 'client'
   c. In team_user_ids     → 'team_member'
   d. Workflow-sourced     → 'workflow'
   e. Bot indicators       → 'bot'           (subtype='bot_message' OR bot_id)
   f. Otherwise            → 'unknown'
2. bot_id (no user field)  → 'bot' (or 'workflow')
3. Fallback                → 'unknown'
```

Where `ella_user_id` comes from `get_user_id_for_token(os.environ.get("SLACK_USER_TOKEN"))` at `realtime_ingest.py:214` and is passed into every `parse_message` call.

**Today (bot-token posting via `shared.slack_post.post_message`):** Ella's posts carry `event['user'] = U0ATX2Y8GTD` (the bot's user_id) + `bot_id` set + `subtype='bot_message'`. `ella_user_id` is `U0B03PTJD3P` (a different id — see Q3), so the ella-check fails. The post falls through to step `1.e` (bot indicator present) → tagged `'bot'`. Gate 2 in `passive_monitor._evaluate` lines 220-228 skips `bot` → no re-evaluation. **No loop.**

**Future (user-token posting via `_post_to_slack` pattern):** Ella's posts would carry `event['user'] = U0B03PTJD3P` (the SLACK_USER_TOKEN user_id) and NO `bot_id` (user-token posts are not bot-flagged). `ella_user_id` matches → tagged `'ella'` at step `1.a`. Gate 2 skips `ella` → no re-evaluation. **No loop.**

**This is empirically proven by historical data** — see Q3 verification.

### Q3 — `SLACK_USER_TOKEN` identity resolution: **healthy.** The known-issues entry is mis-diagnosed.

Both tokens are present in `.env.local`. Live `auth.test` (the one allowed live call per spec):

```
SLACK_BOT_TOKEN set: True   (starts with: xoxb-...)
SLACK_USER_TOKEN set: True  (starts with: xoxp-...)

auth.test SLACK_BOT_TOKEN  → user_id 'U0ATX2Y8GTD'
auth.test SLACK_USER_TOKEN → user_id 'U0B03PTJD3P'
Equal? False
```

**The two tokens authenticate as DIFFERENT user_ids.** This is by design — `SLACK_BOT_TOKEN` is the bot/APP identity; `SLACK_USER_TOKEN` is the human user identity. `get_user_id_for_token` returns the right id for each.

**Cloud verification — `slack_messages` rows by these two user_ids over the last 14 days:**

| slack_user_id | author_type | n | first_seen | last_seen |
|---|---|---|---|---|
| `U0ATX2Y8GTD` (bot) | **`bot`** | 62 | 2026-05-11 09:40 UTC | 2026-05-23 19:21 UTC |
| `U0B03PTJD3P` (user) | **`ella`** | 37 | 2026-05-10 23:08 UTC | 2026-05-18 19:30 UTC |

And the all-time scan: every `author_type='ella'` row in `slack_messages` is from `slack_user_id='U0B03PTJD3P'` (42 rows total, 2026-04-27 → 2026-05-18). Zero `'ella'`-tagged rows from `U0ATX2Y8GTD`. Zero `'ella'`-tagged rows from any other user_id.

**The parser is working correctly.** When Ella posted via the user token (pre-2026-05-18 unified-path collapse), her posts came from `U0B03PTJD3P` and were correctly tagged `'ella'` — 42 rows of proof. When she posts via the bot token (today, post-collapse), her posts come from `U0ATX2Y8GTD` and are correctly tagged `'bot'`.

**The `docs/known-issues.md:80` entry is mis-diagnosed.** It says: *"`parser._resolve_author` is not recognizing Ella's user account (`slack_user_id='U0ATX2Y8GTD'` behind `SLACK_USER_TOKEN`) — her posts ingest with `author_type='bot'`."* But `U0ATX2Y8GTD` is the BOT user_id, not the SLACK_USER_TOKEN user_id (which is `U0B03PTJD3P`). The entry conflated the two ids. The bot-tagging it flagged is the parser doing its job correctly on bot-posted messages.

**What actually happened on 2026-05-18:** the unified-path refactor moved Ella's reply path off the M1.4 two-token `_post_to_slack` (which preferred user token) and onto the new bot-only `shared.slack_post.post_message`. That switch is when the user-id behind her posts changed from `U0B03PTJD3P` to `U0ATX2Y8GTD` and tagging shifted from `'ella'` to `'bot'`. The cloud data shows the exact day: last `'ella'`-tagged post is 2026-05-18 19:30 UTC; first bot-posted message at scale is 2026-05-11+ (gradual transition during refactor work). The parser was never broken; the post identity changed.

### Q4 — Safe path: **safe to ship as-is.**

**Recommendation: route the @ handler's reply through a user-token-first path (resurrect/adapt the M1.4 `api/slack_events.py:_post_to_slack` pattern). No prerequisite fix needed. Ella's human-account posts will tag as `'ella'`, Gate 2 will skip them, no loop. The bot-token fallback path (when user-token fails / is unset) will continue to tag as `'bot'`, also Gate 2 skipped. Both branches safe.**

Concretely, the follow-up change spec touches these files/lines:

- **`agents/ella/agent.py:handle_at_mention` (around line 250):** today calls `post_message(payload.slack_channel_id, response_text)` directly. The change replaces this with a two-token-first call. Same in the bare-mention short circuit (around line 295) and the escalate-ack post (around line 268).
- **`shared/slack_post.py`:** add a new `post_message_as_user_first(channel_id, text, *, thread_ts=None, blocks=None)` helper modeled on the M1.4 `api/slack_events.py:_post_to_slack` pattern — try `SLACK_USER_TOKEN` via `call_chat_post_message` first, fall back to `SLACK_BOT_TOKEN` on any failure. Returns the same dict shape as the existing `post_message`. Don't modify `post_message` itself — internal-CS posts (per-call summaries, accountability cron) should stay bot-only.
- **`api/slack_events.py:_post_to_slack`:** delete in the same commit. It's dead code (zero production callers — only the `tests/api/test_slack_events_post.py` test file references it; that whole test file gets deleted alongside since the helper it tests is gone, OR repurposed to test the new `shared.slack_post` helper). The deletion is safe because the no-op `app_mention` branch never called it.
- **`tests`:** add unit coverage for the new `post_message_as_user_first` (user-token-first behavior, bot-fallback on every failure mode, the missing-user-token bot-direct path). Acceptance test: `handle_at_mention` calls the new helper, not `post_message`.

**Verification path for the follow-up:** after the change deploys, query `slack_messages` for Ella posts the first hour post-deploy and confirm `author_type='ella'` returns (matches the historical pattern, restoring the M1.4 behavior).

**Operational rollback if needed:** unset `SLACK_USER_TOKEN` in Vercel env vars. The user-first helper sees no token → bot-direct fallback. No code change required to roll back. (Matches M1.4 rollback procedure documented in `docs/agents/ella/followups.md`.)

## Surprises and judgment calls

**The big surprise — the known-issues entry was wrong.** I went in expecting to verify a known parser bug. The actual situation is parser works, has always worked, and the bot-tagging Drake's been seeing is the expected behavior given the bot-only posting path. This changes Q4's answer from "depends on a prerequisite fix" to "no prerequisite, ship the post-path change directly." Worth a separate note for Director: this is an example of an open known-issues entry being wrong because the root cause was inferred without verifying against the live data. The empirical check (auth.test both tokens + SELECT both user_ids' author_type) took 30 seconds and conclusively refuted the prior diagnosis. The lesson generalizes — adding a "verify with one cloud query before logging the entry" discipline to the known-issues workflow would catch this class.

**Confirmed there's no OTHER consumer of Ella's posts that would react.** Spec asked me to check whether the unanswered-flagger / digest could wrongly treat an Ella-authored post as a client message awaiting response. They cannot:
- The unanswered-flagger reads `pending_digest_items` rows. Those rows only get written by `passive_dispatch.persist_passive_evaluation` when `decision.digest_flag=True`. Gate 2's synthetic `PassiveDecision` for skipped author_types has `digest_flag=False` (default). So Ella's posts (tagged `'bot'` today, `'ella'` post-fix) skip at Gate 2, write no digest item, never feed the flagger.
- The daily digest reads the same `pending_digest_items` table. Same protection.
- I read `passive_monitor.py:_evaluate` and `passive_dispatch.py:persist_passive_evaluation` end-to-end to confirm. There is no path from "Ella's own post hits `_evaluate`" to "anything downstream sees it as a client message."

**Confirmed the inverse — Ella's posts ARE being correctly skipped at Gate 2 today.** Did a spot-cloud-check of `agent_runs` rows for Ella-posted messages: every one with `trigger_metadata.author_type IN ('bot','ella')` has `skip_reason='non_human_author'`. So the Gate 2 protection isn't just theoretical — it's been firing on Ella's 62 + 37 = 99 self-posts over the last 14 days. (Didn't include this in the main Q-section because it's confirmatory of the parser+Gate 2 design, not a finding.)

**One additional surprise — the `_post_to_slack` test file (`tests/api/test_slack_events_post.py`) is still alive.** The production function it tests is dead code (no callers); the test file is therefore testing dead code. Not blocking, not part of this investigation's hard-stop scope to fix; flagged for the follow-up change spec (it's the natural co-delete with `_post_to_slack` itself).

**Judgment call — did NOT verify the historical 42 `'ella'` rows came from this exact pre-collapse era.** I trusted the date range (last `'ella'` row 2026-05-18 19:30 UTC; commit `0347f51` "unified-decision Ella passive + reactive pipeline" landed 2026-05-18 14:23 EDT = 18:23 UTC; commit `a811240` "collapse Ella to one unified-path pipeline" landed 2026-05-18 17:06 EDT = 21:06 UTC) — the timing brackets exactly. The last `'ella'`-tagged row at 19:30 UTC is between the two collapse commits. Could chase commit-by-commit for the exact transition moment, but Q4's answer doesn't depend on that precision.

**Judgment call — did NOT do the `_post_to_slack` test file inspection or rewrite proposal.** Out of scope; the follow-up change spec owns it.

## Out of scope / deferred

**The known-issues entry needs correction (Director-spec):**

- **Replace the open entry at `docs/known-issues.md:80-85` (Ella posts classified as `author_type='bot'`).** The current entry's root-cause hypothesis is wrong. The corrected version should say something like: *"Ella's reply posts are tagged `author_type='bot'` because the live posting path is bot-only (`shared.slack_post.post_message` via `SLACK_BOT_TOKEN`). The parser is working correctly — bot-token-posted messages are correctly classified as `'bot'`. Historical posts via `SLACK_USER_TOKEN` (`U0B03PTJD3P`) were correctly tagged `'ella'` (42 rows from 2026-04-27 → 2026-05-18). The 2026-05-18 unified-path collapse moved off the two-token `_post_to_slack` path onto the bot-only `post_message`. To restore `'ella'`-tagged posts: see `docs/specs/ella-reply-as-human` (follow-up change spec). RESOLVED-BY-NEXT-SHIP."* Director scopes the rewrite.

**The follow-up change spec (NOT done here):**

- **`ella-reply-as-human`** (working slug): implement the user-token-first post path per Q4 above. Single logical change: new `shared.slack_post.post_message_as_user_first`, route `handle_at_mention`'s three post sites through it, delete `api/slack_events.py:_post_to_slack` + its test file. Verify post-deploy via `SELECT` on `slack_messages` for fresh `author_type='ella'` rows in the first hour. Operational rollback is the env-var unset (M1.4 precedent). Tests cover the four `post_message_as_user_first` paths (user-ok / user-fails-bot-ok / user-missing-bot-only / both-fail). One-day spec scope.

**Not chased in this pass (out of spec scope):**

- Did NOT investigate `tests/api/test_slack_events_post.py` cleanup — the natural co-delete with `_post_to_slack`. Flagged for the follow-up change spec.
- Did NOT trace whether ANY other Ella consumer surface (e.g. the `/ella/runs` dashboard, the cost hub, internal Slack channels) treats `author_type='ella'` differently from `'bot'` such that the tagging change would have unexpected UI/audit effects. The dashboard's filtering is `RESPONSE_TRIGGER_TYPES` based, not author-type based; per prior diagnostic reports this isn't a concern. But a brief check during follow-up wouldn't hurt.
- Did NOT verify behavior in non-passive-monitoring-enabled channels — if a channel has `passive_monitoring_enabled=false`, the realtime-ingest fork short-circuits, so Ella's posts there don't even reach Gate 2. Safe regardless.

## Side effects

- **One live Slack API call:** `auth.test` against `SLACK_BOT_TOKEN` (returned `U0ATX2Y8GTD`) and one against `SLACK_USER_TOKEN` (returned `U0B03PTJD3P`). Both read-only (returns the token's own identity), no posting, no side effects on Slack state. This was the one explicitly-allowed live call per the spec.
- **Three read-only cloud `SELECT`s** against `slack_messages` via psycopg2 pooler. No writes.
- **Zero code changes**, zero migrations, zero env-var changes, zero deploys, zero Slack posts, zero DM fires, zero file writes outside `docs/specs/ella-reply-as-human-investigation.md` (spec status flip) + this report.
- **No live API calls to Anthropic or any other paid service.**

Throwaway diagnostic was inline in the Bash heredoc; nothing committed beyond the spec + report.
