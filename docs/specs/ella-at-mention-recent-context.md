# Ella @-mention conversational context — last 3 mention exchanges + use-it-to-answer
**Slug:** ella-at-mention-recent-context
**Status:** in-flight

**Target branch: ella-worktree**

> Handed to Builder in the worktree (paste-to-Code). Save to docs/specs/ella-at-mention-recent-context.md in the worktree. Execution stays in the ella-worktree worktree at ~/projects/ai-enablement-ella, NOT main. The Close-ingestion backfill on main is a separate local OS process — git operations don't affect it — but still touch nothing Close-related (ingestion/close/*, Close specs/schema).

## Why this exists

After the @-mention / passive split (`docs/reports/ella-at-mention-passive-split.md`, shipped + smoke-passing 2026-05-23), the restored @ handler answers questions well but treats each @-mention in isolation — Drake observed she "responds to the immediate message with no knowledge of what was said before." She can't thread a conversation ("you asked me about X earlier, here's how Y connects").

Important nuance discovered while scoping: the @ handler ALREADY fetches recent context. `handle_at_mention` in `agents/ella/agent.py` calls `fetch_recent_channel_context(slack_channel_id, before_ts=...)` and passes it into `_build_at_mention_system_prompt`. So context is technically IN the prompt. The problem is two-fold:

1. **The context is too broad and noisy for the @ use case.** `fetch_recent_channel_context` pulls the last 15 RAW channel turns (all client/advisor crosstalk, every message). For an @-mention handler, what's useful is "the recent things people asked ME and how I answered" — not 15 turns of unrelated channel chatter.
2. **The prompt only points Sonnet at the context for the FIRM AFTER FIRST check, not for answering.** The `_AT_MENTION_EXTENSION` (in `agent.py`) mentions recent context only in the FIRM AFTER FIRST rule ("check recent context for a prior escalation"). Nothing instructs Sonnet to USE the prior conversation to inform its answer. So she reads it for firm-after-first and ignores it for continuity.

Drake's design: give the @ handler the **last 3 @-mention EXCHANGES in this channel** (each = the user's @-mention + Ella's reply to it, excluding the current one), and instruct Sonnet to use them for conversational continuity. This is deliberately NARROWER than the passive path's 15-turn fetch — tight, relevant, cheap.

## Drake's confirmed design decisions

1. **Last 3 @-mention EXCHANGES, not just the questions.** Each exchange = the triggering @-mention message + Ella's response to it. ~6 messages of tightly relevant history. Knowing what was asked without what she answered is half a conversation.
2. **This channel only.** Last 3 @-mention exchanges in the CURRENT channel. Never cross-channel (each client channel is its own conversation; cross-channel context would be wrong and a privacy leak).
3. **Single source feeding both answering AND firm-after-first.** This last-3-exchanges context replaces the current broad `fetch_recent_channel_context` call in the @ handler. It powers (a) conversational continuity in the answer AND (b) the FIRM AFTER FIRST check (which becomes MORE accurate — "was one of my last 3 mention replies an escalation on this topic?" is sharper than scanning 15 raw turns). Two birds.

## What this fixes as a side effect

The smoke-1 FIRM-AFTER-FIRST over-firing (Drake hammered the same question repeatedly and Ella kept saying "I've already answered this, picking it up directly"). With context scoped to the last 3 actual mention exchanges, the firm-after-first judgment reasons over real prior exchanges instead of a fuzzy 15-turn window — so it should fire more precisely. NOT the primary goal, but expect it to improve. (Don't over-tune for it; the real-world trigger pattern — a client asking the identical question 4× in 10 min — is rare.)

## Acclimatization checklist

Read first, confirm in 4 bullets:

- `agents/ella/agent.py` — `handle_at_mention` (the `fetch_recent_channel_context` call + `_build_at_mention_system_prompt`) and the `_AT_MENTION_EXTENSION` constant (the FIRM AFTER FIRST section that references recent context). These are the two edit sites.
- `agents/ella/retrieval.py` — `fetch_recent_channel_messages` (the row-level primitive: `slack_messages` rows before a ts, oldest→newest, includes Ella's posts) and `fetch_recent_channel_context` (the 15-turn formatter). The new helper is modeled on these.
- `ingestion/slack/realtime_ingest.py` `detect_at_mentions` — the canonical "is this message an Ella @-mention?" logic (checks both bot + human user_id). The new fetch must identify PRIOR mention messages using the SAME definition so "mention exchange" is consistent with what triggers the handler.
- How Ella's own replies are identified in `slack_messages` — NOTE the open known-issue: Ella's posts are currently tagged `author_type='bot'` not `'ella'` (the `SLACK_USER_TOKEN` resolution bug). So "Ella's reply to a mention" can't be found reliably by `author_type='ella'`. See § What could go wrong for how to pair mentions with replies robustly given this.

## What to do

1. **Add a fetch helper** (in `retrieval.py`, alongside the existing fetchers) that returns the last N (default 3) @-mention exchanges in a channel before a given ts. An "exchange" = a message that @-mentions Ella (per `detect_at_mentions`'s both-user-ids definition) PLUS Ella's reply to it. Implementation approach (use your judgment, but):
   - Fetch a reasonable window of recent `slack_messages` rows before `before_ts` (e.g. last ~30 messages, enough to contain 3 mention exchanges in a normal channel), oldest→newest.
   - Identify the mention messages in that window (re-use `detect_at_mentions` or its mention-regex against each message's text + the resolved Ella user_ids).
   - Pair each mention with Ella's reply: the next message after it authored by Ella. **Because of the `author_type='bot'` bug, don't rely solely on `author_type='ella'`** — pair by "the next message from Ella's known user_id(s) (bot or human) after the mention," resolving Ella's user_ids the same way `detect_at_mentions` does. Tolerate a missing reply (mention with no answer yet → include the mention alone).
   - Return the last 3 such exchanges (or fewer if the channel has fewer), formatted for the prompt — reuse the ET-timestamp + role-label + time-ago formatting style from `fetch_recent_channel_context` so it reads consistently. Exclude the current triggering message.
   - Channel-scoped only (the `slack_channel_id` arg). Empty → empty string.

2. **Wire it into `handle_at_mention`.** Replace the `fetch_recent_channel_context(...)` call in the @ handler with the new last-3-exchanges fetch. The passive path's use of `fetch_recent_channel_context` stays UNTOUCHED — this change is @-handler-only. (Leave `fetch_recent_channel_context` in place; passive still uses it.)

3. **Update `_AT_MENTION_EXTENSION`** (the prompt) so the recent-exchanges context is used for BOTH:
   - **Answering / continuity:** add an instruction that Sonnet should use the recent @-mention exchanges to understand the ongoing conversation and reference prior context naturally when relevant (e.g. "you asked about X earlier — building on that…"), without forcing it (don't reference prior context when the new question is unrelated).
   - **FIRM AFTER FIRST:** keep the rule, but reframe it to read against the last-3-exchanges block ("if one of your recent exchanges below was an escalation on this same topic, route harder rather than re-answering"). Make clear FIRM AFTER FIRST fires on a prior ESCALATION, not merely a prior answer to a similar question — this is the precision fix that addresses the smoke-1 over-firing.
   - Make sure the recent-exchanges block is actually present in the assembled prompt and clearly labeled (a section header like `# RECENT @-MENTION EXCHANGES IN THIS CHANNEL` so Sonnet knows what it's looking at).

4. **Tests.** Cover: (a) the new fetch returns the last 3 mention exchanges, channel-scoped, paired with Ella's replies; (b) pairing works when Ella's reply is tagged `author_type='bot'` (the known bug) — i.e. pairing is by user_id, not author_type; (c) a mention with no reply yet is included alone; (d) fewer than 3 exchanges → returns what exists; (e) the @ handler passes the new context into the prompt; (f) cross-channel messages are NOT included. Stub Sonnet/Slack/DB as the existing @-handler tests do.

## What success looks like

- An @-mention that follows up on a prior @-mention gets an answer that's aware of the earlier exchange (Drake can verify: ask a question, then ask a follow-up that only makes sense with the first — she should connect them).
- FIRM AFTER FIRST fires on genuine prior escalations, not on a merely-repeated answerable question (smoke-1 pattern improves).
- The passive path is untouched (still uses the 15-turn `fetch_recent_channel_context`).
- Full pytest suite green.

## Hard stops

- **@-handler-only.** Do not change the passive path's context fetch. `fetch_recent_channel_context` stays as-is for passive.
- **Channel-scoped only.** The fetch must never pull messages from other channels. This is a privacy invariant — verify it in a test.
- **No migration, no env-var, no Close touches.** Code + tests + the prompt constant only. If you think a migration is needed, STOP and surface (gate a).
- **Do NOT try to fix the `author_type='bot'` bug here** — work AROUND it (pair by user_id). That bug is a separate open known-issue with its own eventual spec; touching it here is scope creep and it's entangled with the SLACK_USER_TOKEN investigation that's deliberately deferred.
- Operate in ella-worktree, not main.

## What could go wrong — think this through yourself

Seeds: the `author_type='bot'` bug means you CANNOT find Ella's replies by `author_type='ella'` — pair by Ella's resolved user_id(s) instead (bot OR human, same as `detect_at_mentions`), or you'll get zero replies paired and the context will be all-questions-no-answers. The fetch window sizing is a judgment call — fetch enough raw messages to reliably contain 3 mention exchanges (a chatty channel might have many non-mention messages between mentions; ~30-message lookback is a reasonable start, but if a channel mentions Ella rarely you might not find 3 — that's fine, return what exists). Don't accidentally include the CURRENT triggering message as one of the "prior" exchanges (filter on `before_ts` strictly). Watch token cost: 3 exchanges of ~6 messages is small, but if any single prior message was huge, cap/truncate per-message like `fetch_recent_channel_context` does (`max_chars`). And: the mention-detection on prior messages must use the same both-user-ids definition as the live trigger — if you only check the bot id, mentions of the human account won't be recognized as prior exchanges, and the context will be inconsistent with what actually triggers Ella.

## Mandatory doc updates

- `docs/agents/ella/ella.md` — update the @-Mention Handling section to note the @ path uses last-3-mention-exchanges context (distinct from passive's 15-turn context); changelog entry.
- `docs/reports/ella-at-mention-recent-context.md` — the report.
- Flip this spec's Status to shipped in the same commit as the report IF the full suite is green and you're confident; otherwise leave in-flight pending a Drake smoke (a follow-up @-mention conversation in #ella-test-drakeonly that confirms continuity). State which in the report.
- If the smoke-1 firm-after-first improvement is worth a note, add it to `docs/agents/ella/followups.md` (don't claim it's fully fixed unless a test proves it).
