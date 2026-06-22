# Ella reply-as-human-account — route @ replies through user-token-first posting
**Slug:** ella-reply-as-human
**Status:** in-flight

**Target branch: ella-worktree**

> Handed to Builder in the worktree (paste-to-Code). Save to docs/specs/ella-reply-as-human.md in the worktree. The Close backfill on main is a separate local OS process; touch nothing Close-related. Execution in the worktree, not main.

## Why this exists

Ella's @-mention replies currently post as the BOT/APP account (via `shared.slack_post.post_message`, which is `SLACK_BOT_TOKEN`-only). Drake wants replies to come from the HUMAN account (`SLACK_USER_TOKEN`) — renders APP-tag-free, the polish from the M1.4 era. Both mention TARGETS (bot + human) stay valid triggers; only the reply IDENTITY changes.

The safety investigation (`docs/reports/ella-reply-as-human-investigation.md` — READ IT FIRST) proved this is safe to ship with NO prerequisite fix:
- The historical duplicate problem was about inbound EVENT handling (parallel `app_mention`+`message` delivery), independently fixed by the dedup gate. It is orthogonal to reply identity.
- Ella's own posts don't loop: posts from `SLACK_USER_TOKEN`'s user_id (`U0B03PTJD3P`) get `author_type='ella'` (parser checks `ella_user_id` FIRST), and Gate 2 in `passive_monitor._evaluate` skips `ella` author types — same protection that makes bot-posting safe today. Proven by 42 historical `'ella'`-tagged rows + live Gate-2 skips on 99 self-posts over 14 days.
- The open `author_type='bot'` known-issue was MISDIAGNOSED — no parser bug. The bot-tagging is correct behavior for bot-posted messages. Switching to user-token posting restores `'ella'` tagging automatically. (This spec's change effectively resolves that known-issue.)
- Both tokens are confirmed present in the environment. `SLACK_USER_TOKEN` → `U0B03PTJD3P`; `SLACK_BOT_TOKEN` → `U0ATX2Y8GTD`.

This is a small, well-scoped, de-risked change. The investigation named the exact files/lines. Build it carefully — it touches the @ handler's live posting path that smoke-passed this session; do not regress it.

## What to do

1. **Add `post_message_as_user_first` to `shared/slack_post.py`.** Model it on the proven M1.4 two-token pattern in `api/slack_events.py:_post_to_slack`: try `SLACK_USER_TOKEN` via `call_chat_post_message` first; on ANY failure (token unset, transport exception, Slack `ok=false` like missing_scope/not_in_channel) fall back to `SLACK_BOT_TOKEN` via `call_chat_post_message`. Return the SAME dict shape as the existing `post_message`: `{"ok": bool, "slack_error": str|None, "ts": str|None}`. Never raise (fire-and-forget safe, like `post_message`). Support the same `thread_ts` / `blocks` kwargs for signature-compatibility even if the @ handler doesn't use them today. Tokens never logged.
   - **Do NOT modify the existing `post_message`.** Internal-CS posts (per-call summaries, accountability cron, digest, unanswered-flagger) must stay bot-only — they post to internal channels where the APP tag is fine and where a user-token post would be wrong. Only the @ handler's CLIENT-channel replies should render as the human.

2. **Route `handle_at_mention`'s reply posts through the new helper.** There are FOUR `post_message(...)` call sites in `agents/ella/agent.py` that post Ella's CLIENT-FACING reply — ALL of them should switch to `post_message_as_user_first`:
   - The main answer post (the `post_result = post_message(payload.slack_channel_id, response_text)` after the Sonnet call succeeds).
   - The escalation ack post — NOTE: this is the SAME `post_result = post_message(...)` line; the escalate branch posts `response_text` (the warm ack) via that same call before the fanout. So converting the main post line covers both answer and ack. Verify this is one line, not two.
   - The Sonnet-failure canned-line post (`post_message(payload.slack_channel_id, canned)` in the `except` branch).
   - The bare-mention post (`post_result = post_message(payload.slack_channel_id, response)` in `_handle_bare_mention`).

   All four are client-facing Ella replies → all four become `post_message_as_user_first`. Update the import in `agent.py` accordingly (add `post_message_as_user_first`; keep `post_message` imported only if still used elsewhere in the file — check; if the @ handler was its only user, swap the import).

3. **Delete the dead `_post_to_slack` in `api/slack_events.py`** and its test file `tests/api/test_slack_events_post.py`. `_post_to_slack` has zero production callers (the `app_mention` branch is a logged no-op). Confirm zero callers via grep before deleting. The new `shared.slack_post.post_message_as_user_first` supersedes it. If `test_slack_events_post.py` contains reusable test scaffolding for the two-token behavior, repurpose those cases against the new helper rather than losing the coverage.

4. **Tests.** Cover `post_message_as_user_first`'s four paths: (a) user-token present and succeeds → posts via user token, returns ok; (b) user-token present but fails (ok=false) → falls back to bot, returns ok; (c) user-token present but raises (transport) → falls back to bot; (d) user-token unset → goes straight to bot. Plus: `handle_at_mention` calls `post_message_as_user_first` (not `post_message`) for the answer, the escalate-ack, the failure-canned-line, and the bare-mention — assert the call target on each of the four sites. Stub `call_chat_post_message` / `urllib` as the existing slack_post tests do; no live calls.

## What to KEEP / not regress

- The @ handler's behavior is otherwise UNCHANGED — same Sonnet call, same JSON parse, same escalation fanout, same status-honesty, same last-3-exchanges context. This spec ONLY changes which token posts the reply. Do not touch the prompt, the retrieval, the escalation logic, or the run-status handling.
- `post_message` (bot-only) stays exactly as-is for all internal-CS callers.
- The escalation DM fan-out (`fire_escalation_dms`) is unrelated to this and stays bot-driven — only the in-channel client-facing reply changes identity.

## What success looks like

- Ella's @-mention replies in client channels post as the human account (no APP tag) when `SLACK_USER_TOKEN` is set; fall back to bot (APP tag) if it's unset or fails.
- Post-deploy verification (Drake / gate c): query `slack_messages` for Ella posts in the first hour → `author_type='ella'` returns (restoring the historical pattern; was `'bot'` pre-this-change). Plus a visual check in `#ella-test-drakeonly`: @-mention Ella, confirm her reply renders WITHOUT the APP badge.
- Full pytest suite green. (No TS touched — confirm via git diff --stat.)

## Hard stops

- **Do NOT modify the existing `post_message`** — internal-CS posts stay bot-only. Add a NEW helper alongside it.
- **No env-var changes.** `SLACK_USER_TOKEN` is already set (investigation confirmed). If it were NOT set, the helper's bot-fallback handles it gracefully — but do not add/remove/rename env vars (gate d).
- **No migration, no Close touches.** Code + tests + docs only.
- **Do NOT change the @ handler's logic beyond the post-call target.** Same Sonnet call, same parse, same fanout. This is a posting-identity change, nothing more. If you find yourself editing the prompt or the escalation flow, STOP — out of scope.
- Operate in ella-worktree, not main.
- If grep finds ANY live caller of `_post_to_slack` (the investigation says there are none, but verify), STOP and surface before deleting it.

## What could go wrong — think this through yourself

Seeds: the escalate-ack and the main-answer post are the SAME line in the current code (the escalate branch reuses `post_result` from the post above it) — make sure you don't double-post by adding a second post call in the escalate branch; just convert the one shared line. Watch the `agent.py` import line — if you swap `post_message` for `post_message_as_user_first` but `post_message` is still referenced somewhere you didn't convert, you'll get a NameError; grep `post_message` in agent.py and convert intentionally. The new helper must return the EXACT dict shape `handle_at_mention` already expects (`post_result.get("ok")`) or the `posted=` telemetry breaks. The user-token-first fallback must be truly catch-all (any exception → bot path) so a user-token hiccup never drops a client reply — mirror `_post_to_slack`'s broad except. And: confirm a user-token post still returns a usable `ts` if any caller relies on it (the @ handler doesn't seem to use the returned ts, but keep the shape honest). Finally — the bare-mention and canned-failure posts don't capture/use the result much, but convert them too for consistency (Ella should render as human on EVERY client-facing reply, not just the substantive ones).

## Mandatory doc updates

- `docs/agents/ella/ella.md` — § Response Location: note @ replies post via user-token-first (human identity, APP-tag-free), bot fallback; passive/internal posts stay bot. Changelog entry.
- `docs/known-issues.md` — RESOLVE the `author_type='bot'` entry: this change restores `'ella'` tagging by restoring user-token posting; the entry was misdiagnosed (no parser bug). Reference this spec + the investigation report. (This is the one known-issues edit this spec OWNS — the investigation explicitly handed it to the change spec.)
- `docs/reports/ella-reply-as-human.md` — the report. Mark PARTIAL pending Drake's gate (c) post-deploy verification (the `author_type='ella'` query + the no-APP-badge visual check); flip the spec to shipped when smoke passes.
- `docs/agents/ella/followups.md` — note the M1.4 rollback procedure still applies (unset `SLACK_USER_TOKEN` → bot fallback, no code change).
