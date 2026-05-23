# Ella reply-as-human-account — safety investigation (read-only, NO change)
**Slug:** ella-reply-as-human-investigation
**Status:** in-flight

**Target branch: ella-worktree**

> Handed to Builder in the worktree (paste-to-Code). Save to docs/specs/ella-reply-as-human-investigation.md in the worktree. The Close backfill on main is a separate local OS process; touch nothing Close-related regardless. Execution in the worktree, not main.

## Why this exists

Drake wants Ella's @-mention REPLIES to come from the human Slack account (`SLACK_USER_TOKEN`, renders APP-tag-free) instead of the bot/APP account, while keeping BOTH identities valid as @-mention *triggers*. This is a known-good past behavior (the M1.4 two-token strategy) that was in place during the "former glory" era.

**This is an INVESTIGATION spec, not a change spec.** Replying-as-human touches the identity layer that is historically entangled with a duplicate-message problem, AND there is an open known-issue (`author_type='bot'` — `SLACK_USER_TOKEN` identity resolution may be broken) that could make replying-as-human unsafe. We do NOT make the change until we understand whether it's safe. The deliverable is a report answering the safety questions; Director scopes the actual change (or a prerequisite fix) only after.

**Hard rule: this spec makes NO code change, NO token flip, NO deploy. Read-only investigation + report. If you find yourself editing posting logic, STOP — that's the follow-up spec.**

## What's already known (from Director's read — verify, don't re-derive)

- `shared/slack_post.py:post_message` (bot-token ONLY) is what the current `handle_at_mention` uses. So Ella replies as the bot/APP today. Confirmed.
- `api/slack_events.py:_post_to_slack` is the M1.4 TWO-TOKEN path (user-token-first, bot-token fallback) — the "reply as human" capability. It is currently **dead code**: the `app_mention` branch is a logged no-op, so `_post_to_slack` has no live caller. Confirm this (grep for callers).
- The historical DUPLICATE cause is documented in `api/slack_events.py`'s `app_mention` branch comment: Slack fires a parallel `message` event alongside every `app_mention`; handling both double-fired. The fix was making `app_mention` a no-op and routing through the `message` path (+ the `webhook_deliveries` dedup gate). **This was about EVENT HANDLING, not reply identity.** Verify this understanding against the code + the resolved known-issues entries (`docs/known-issues.md` — the two RESOLVED duplicate entries).

## The questions to answer

**Q1 — Confirm the duplicate cause was event-handling, not reply-identity.** Verify from git history + the resolved known-issues entries that the duplicates came from double-handling the inbound `app_mention`+`message` events, NOT from Ella's reply being re-ingested and re-triggering her. If there's ANY evidence the reply-identity (posting as user vs bot) contributed to duplicates, surface it — that would change the safety calculus. (Director's read says it was purely event-handling, but verify.)

**Q2 — THE KEY SAFETY QUESTION: does Ella's own post get re-ingested and re-evaluated?** When Ella posts a reply (whether as bot or human), that post lands in the channel and Slack delivers it as a `message` event → `realtime_ingest.ingest_message_event` → potentially the passive/mention fork. Trace this path precisely:
   - When Ella posts as the BOT today, what `author_type` does her post get on ingest? (Gate 2 in `passive_monitor._evaluate` skips `ella`/`bot`/`workflow`/`unknown` author types — so a `bot`-tagged post is skipped, no re-evaluation. Confirm this is why bot-posting doesn't loop.)
   - If Ella posts as the HUMAN account (`SLACK_USER_TOKEN`), what `author_type` would that post get on ingest? This is where the open `author_type='bot'` known-issue matters: `parser._resolve_author` may not recognize `SLACK_USER_TOKEN`'s user_id. Determine: does a human-account post get tagged `ella`? `bot`? `client`? `unknown`? **If it gets tagged `client`, that's the danger** — it would pass Gate 2 and get evaluated, potentially triggering Ella to respond to her own message. Read `ingestion/slack/parser.py:_resolve_author` (or wherever author resolution lives) and trace exactly what author_type a `SLACK_USER_TOKEN`-posted message receives.

**Q3 — Is `SLACK_USER_TOKEN` identity resolution currently healthy?** The open known-issue says Ella's posts are tagged `author_type='bot'` instead of `'ella'`, suspected root cause: `get_user_id_for_token(SLACK_USER_TOKEN)` returns the wrong id or None. Determine the CURRENT state (read-only):
   - What does `get_user_id_for_token(SLACK_USER_TOKEN)` actually return? (A read-only `auth.test` call against the live token is acceptable here — it's a read, returns the token's own identity, no side effects. This is the one allowed live API call. Do NOT post anything.)
   - Does that returned user_id match the `slack_user_id` that Ella's existing posts appear under in `slack_messages`? (Query cloud `slack_messages` for recent Ella posts — the known-issue says they're under a specific user_id tagged `bot`.)
   - Is `SLACK_USER_TOKEN` even set in the current environment? (Check whether it's configured — its absence would mean the two-token path never activated, which itself explains why replies come from the bot.)

**Q4 — Given Q1-Q3, what's the safe path to reply-as-human?** Synthesize: is replying-as-human safe to ship as-is (just route the @ handler's post through a user-token-first path)? Or does the `author_type` resolution have to be FIXED FIRST so Ella's human-account posts are correctly recognized as `ella` (and thus skipped by Gate 2, not re-evaluated)? Name the prerequisite if there is one. This is the recommendation Director scopes the actual change from.

## Acclimatization checklist

Read first, confirm in 4-5 bullets:
- `api/slack_events.py` — the `app_mention` no-op branch + `_post_to_slack` (the dead two-token path) + confirm no live callers of `_post_to_slack`.
- `shared/slack_post.py` — `post_message` (bot-only, what the @ handler uses) + `call_chat_post_message` (the low-level transport both share).
- `agents/ella/agent.py:handle_at_mention` — confirm it posts via `post_message` (bot-only) today.
- `ingestion/slack/parser.py` — `_resolve_author` / author-type resolution. THE critical file for Q2/Q3 — how a posted message's author_type is determined, and how `ella_user_id` (from `SLACK_USER_TOKEN`) factors in.
- `agents/ella/passive_monitor.py:_evaluate` Gate 2 — confirms which author_types get skipped (the loop-prevention that makes bot-posting safe).
- `shared/slack_identity.py:get_user_id_for_token` — what it returns for `SLACK_USER_TOKEN`.
- `docs/known-issues.md` — the `author_type='bot'` open entry + the two RESOLVED duplicate entries.

## What to do

All read-only. Cloud SELECTs + code reads + ONE allowed `auth.test` read call (Q3). NO posting, NO token flip, NO code change, NO deploy.

1. Trace the reply-ingestion loop (Q2): follow an Ella post from `post_message`/`_post_to_slack` → Slack → `message` event → `ingest_message_event` → `parser` author resolution → `passive_monitor` Gate 2. Determine the author_type at each identity (bot vs human) and whether each gets skipped or evaluated.
2. Resolve the current `SLACK_USER_TOKEN` identity (Q3): the one allowed `auth.test` read, plus a cloud query of recent Ella posts' `slack_user_id` + `author_type` in `slack_messages`. Compare.
3. Confirm the duplicate history (Q1): git log + resolved known-issues read.
4. Synthesize the safe path (Q4).

## What success looks like

A report at `docs/reports/ella-reply-as-human-investigation.md` answering Q1-Q4 with evidence, ending with a clear recommendation:
- **Either:** "Safe to ship as-is — route the @ handler's reply through a user-token-first path (resurrect/adapt the M1.4 `_post_to_slack` pattern); Ella's human posts get author_type=X which Gate 2 skips, no loop."
- **Or:** "NOT safe yet — Ella's human-account posts would get author_type=`client`/`unknown` and re-evaluate. The `author_type='bot'` resolution bug must be fixed FIRST so human posts are tagged `ella`. Fix that, then reply-as-human is safe."
- With the specific files/lines the follow-up change-spec would touch (NOT changed here).

## Hard stops

- **READ-ONLY. No code change, no token flip, no deploy, no posting.** The single `auth.test` read (Q3) is the only live call — it reads the token's identity, posts nothing.
- Do NOT fix the `author_type='bot'` bug here even if the root cause becomes obvious — name it as the prerequisite if it is one, leave the fix for its own spec. (We do ONE careful thing at a time near the identity layer.)
- Operate in ella-worktree, not main. Touch nothing Close-related.
- If the investigation reveals the change is more entangled than Q1-Q4 anticipate, expand the report's findings — do NOT start implementing.

## What could go wrong — think this through yourself

Seeds: the `auth.test` call returns the identity of WHICHEVER token you pass — make sure you're testing `SLACK_USER_TOKEN`, not `SLACK_BOT_TOKEN`, for Q3. Ella's posts being tagged `bot` today might be WHY the loop doesn't happen now (bot is Gate-2-skipped) — so "fixing" author resolution to tag her posts as `ella` is fine (ella is also Gate-2-skipped) but tagging them `client` would be catastrophic (re-evaluation loop); make sure the recommendation accounts for which author_type the fix would produce. Also consider: even if a human-account post is correctly tagged and Gate-2-skipped, is there any OTHER consumer that would react to it (the unanswered-flagger? the digest?) — trace whether an Ella-authored human-account post could wrongly count as a "client message awaiting response." And: confirm whether `SLACK_USER_TOKEN` is even set in production — if it's not, the whole question is moot until it's configured (which is a gate-d Drake action).

## Mandatory doc updates

- Write the report to `docs/reports/ella-reply-as-human-investigation.md`.
- Flip this spec's Status to shipped in the same commit as the report (read-only investigation, no gate).
- No other doc edits. If findings warrant a known-issues update, NAME it in the report for Director to handle — don't edit known-issues directly.
