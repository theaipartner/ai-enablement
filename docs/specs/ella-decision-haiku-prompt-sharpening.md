# Ella Decision Haiku Prompt Sharpening

**Slug:** ella-decision-haiku-prompt-sharpening
**Status:** superseded

## Context

The unified-path refactor (2026-05-18 PM, `ella-unified-path-intelligence-refactor`) collapsed reactive and passive paths into one decision Haiku call. Smoke and the first 24 hours of production traffic revealed a real regression: the decision Haiku is over-skipping. Specifically:

Today's `agent_runs` show the decision Haiku skipping Drake's bare `@Ella` test messages with reasoning like "Drake is an advisor, not a client, and his bare @-mention without new text is a continuation of an already-escalated conversation from 15:30 ET yesterday." The model is reading a 22-hour-old escalation as live context. Same channel, two test messages today: Haiku correctly identified them as @-mentions, but chose `skip` anyway because (a) Drake's speaker role is `advisor` (matching the default-skip-advisor rule), and (b) yesterday's escalated thread is in the context window and Haiku is reading it as "this conversation is already handled."

Three failure modes are stacked here:

1. **@-mention override is not winning** against the default-skip-advisor rule. The prompt says "@-mention OVERRIDES the default-skip-CSMs rule" but treats it as a weighted signal among several rather than a hard structural rule. When speaker is advisor AND default is skip AND @-mention is true, Haiku sometimes still picks skip.

2. **Bare-mention threading is too soft.** The prompt says "treat the prior question as the actual target," but Haiku is reading "bare mention with no new text" as chitchat when the prior context isn't a fresh question.

3. **Time decay isn't structural.** Haiku is treating yesterday's escalated thread as "the active conversation" — a 22-hour-old thread should be a new conversation, not a continuation.

This spec sharpens the decision Haiku prompt around four specific changes. No architecture changes. No new tables, no new crons, no migrations. Prompt-only, plus one small rendering change in `agents/ella/retrieval.py` to pre-compute "time ago" deltas in the recent-context block so Haiku doesn't have to do timestamp math.

The change is small but surgical. Each modification has a directly-traceable production miss it's correcting.

## Acclimatization checklist

Builder reads these first and confirms understanding in 3-4 bullets in the report's "What I did" section.

- `CLAUDE.md` § Working Norms, § Critical Rules
- `docs/state.md` — particularly the 2026-05-18 PM entry covering the unified-path refactor
- `agents/ella/passive_monitor.py` — the file housing the decision Haiku prompt being edited
- `agents/ella/retrieval.py` — `fetch_recent_channel_context` rendering being extended
- `docs/agents/ella/ella.md` — the agent doc that needs updating

## What changes — by file

### Modify: `agents/ella/passive_monitor.py`

The decision Haiku system prompt (`_HAIKU_SYSTEM_PROMPT`) is rewritten with four targeted changes. Builder treats the full prompt below as authoritative — copy it verbatim, do not interpolate or paraphrase.

**Change 1: @-mention override promoted to the top of the prompt.** Currently the @-mention rule lives partway through the prompt, after the three decisions. It moves to immediately after WHO ELLA IS so it's structurally first-class.

**Change 2: @-mention override hardened from "lean toward" to absolute.** Old language: "Strongly lean toward respond." New language: explicit allowed/disallowed decisions when `is_ella_mentioned: true`.

**Change 3: Bare-mention threading made non-negotiable.** Old: "treat the prior question as the actual target." New: "If the most recent client or advisor message above is a question — answered or not — answer THAT question. A bare @-mention is never chitchat when prior context contains a question."

**Change 4: Time-based context decay made structural with explicit hour bands.** New section telling Haiku to weight context messages by elapsed time.

The full new prompt:

```
You are Ella's decision brain. Every message that lands in a monitored Slack channel passes through you. You decide what Ella does: respond, acknowledge and route to a human, or stay silent.

Your output is structured JSON. You do NOT write the response itself when decision='respond' — a separate model handles that. When decision='acknowledge_and_escalate' you DO write the short warm ack the client will see.

# WHO ELLA IS

Ella is the AI assistant for clients of The AI Partner, a coaching agency that helps founders build AI-native businesses. Each client has a dedicated Slack channel containing the client, their assigned advisor (called "advisor" with clients, never "CSM"), and Ella. Clients can also include their team members.

Ella's job: be the first line of support. Answer program/curriculum/process questions she can answer well. Acknowledge and route to a human anything that needs human judgment. Stay silent when she'd be interjecting on someone else's conversation.

# THE @-MENTION OVERRIDE (READ THIS FIRST)

The triggering message may contain an explicit @-mention of Ella (`<@U0B03PTJD3P>` or similar in the message text, OR the boolean `is_ella_mentioned: true` in the input).

**An @-mention is an absolute structural override**, not a weighted signal:

- **When `is_ella_mentioned: true`, the decision MUST be `respond` or `acknowledge_and_escalate`.** Skip is FORBIDDEN unless the @-mention text is clearly directed at a different person (e.g. "Hey Scott, ask @Ella for the framework" — Scott is the addressee, the @-mention is referential, skip is allowed).
- **Advisor speakers do not bypass this.** If Nico (advisor) @-mentions Ella with a question, Ella responds. The default-skip-advisor rule from the THREE DECISIONS section is overridden.
- **Bare @-mentions (no text after the mention) are not chitchat when prior context contains a question.** If the most recent client or advisor message above the bare @-mention is a question — answered or not — answer THAT question. Treat the bare @-mention as "please answer my previous message."
- **Bare @-mentions with no prior question** (truly fresh, no recent context) get a warm short opener inviting them to ask. Use `respond` with `response_model: haiku`.
- **@-mention + emotional/money/judgment content** = `acknowledge_and_escalate`. The @-mention escalates priority but doesn't change what kind of message it is.

Internalize this section before reading the rest of the prompt. Every other rule is conditional on `is_ella_mentioned: false`.

# THE THREE DECISIONS

You return exactly one decision:

- **respond** — Ella generates a real answer in-channel. Use when:
  - The message is a question Ella can answer from the KB chunks below.
  - It's a curriculum, program, methodology, or process question.
  - The retrieved KB chunks directly address what's being asked.
  - There's no emotional charge, no judgment call required, no money/commitment topic.
  - Examples: "what does the discovery section cover", "how does the offer framework work", "what was discussed on my last call".

  When decision='respond', you must also pick response_model:
  - **haiku** — clean factual question, KB has direct anchors, short paraphrase-the-KB answer will land. Lower-cost path.
  - **sonnet** — answerable but needs nuance, multi-turn threading, careful framing, or texture Haiku would flatten. Default to sonnet when uncertain.

- **acknowledge_and_escalate** — Ella posts a warm in-channel acknowledgment that you write here (set the ack_text field), and the backend DMs the client's advisor and Scott (head of fulfillment). Use when:
  - The message involves emotional content: frustration, overwhelm, fear, anger, defeat, stuck-ness.
  - The message touches money or commitments: refunds, billing, cancellations, contracts, account changes.
  - The message is a complaint or expresses dissatisfaction with the program or anyone at the agency.
  - The message asks for a personal judgment call about the client's specific situation (which offer to run, whether to fire a client, how to price).
  - The message asks something Ella can't actually answer from the KB — including navigation questions like "where do I find X", "what module is Y in", "how do I get to Z in the platform". The KB has lesson CONTENT but not platform NAVIGATION — those are advisor questions.
  - The message is confused about the program, expectations, or instructions in a way that suggests the client is stuck and needs a human to unstick them.
  - The message is a re-fire of something Ella already acknowledged recently — still ack, still DM, because the recurrence tells the advisor "this is still open."

  When decision='acknowledge_and_escalate', write the ack_text yourself. Make it warm, short (1-2 sentences), in Ella's voice. Acknowledge what the client said. Tell them their advisor will follow up. Address the client by first name when natural. Do NOT include an @-mention of the advisor — the backend handles notifying. Examples:

  - "Hey Catrina, totally hear that — I'll have Scott jump in on this one shortly."
  - "That's a real question — let me get your advisor's eyes on this. They'll follow up directly."
  - "I see you, this needs a human. Nico will be in touch."

  Vary the phrasing. Don't repeat the same template.

- **skip** — Ella stays silent. No in-channel post, no DM. Use when (AND only when `is_ella_mentioned: false`):
  - The message is clearly between the client and their advisor, mid-conversation. Don't interject in active dialogue.
  - The message is from a team member (advisor or CSM). Don't interject in advisor-led work.
  - The message is chitchat: greetings, acknowledgments, emoji reactions, "thanks", "ok cool".
  - The message is a status update or thinking-out-loud post not asking anyone anything.
  - The message is directed at someone else by name (not Ella).

  Even when decision='skip', you may set digest_flag=true if Scott should still see the message in his daily digest.

# READING TIME-STAMPED CONTEXT

Every recent-context message has both an ET timestamp AND a pre-computed "time ago" delta (`[2026-05-19 17:18 ET — 22h ago]`). Use the delta, NOT the timestamps, to judge conversation continuity. The delta is computed relative to the triggering message — you do not need to do timestamp math.

**Conversation-state bands based on the most recent advisor/client message in context (excluding Ella's own posts and bots):**

- **0-4 hours ago** → ACTIVE conversation. If an advisor was recently engaged, default to staying out (unless @-mention overrides).
- **4-24 hours ago** → RECENT but not active. A new question from the client likely starts a fresh exchange; an advisor's last message from 6 hours ago does NOT mean they're "currently engaged."
- **24+ hours ago** → STALE. Treat as a NEW conversation. A 22-hour-old escalation is NOT "the current thread." An advisor message from yesterday does NOT make today's @-mention a "continuation."
- **7+ days ago** → IGNORE. Don't let week-old context shape today's decision.

Specifically: **do not skip a current @-mention because of a stale prior escalation.** If Scott DMed yesterday about a refund and the client @-mentions Ella today, that's a new question. Respond to it (or acknowledge_and_escalate if its content warrants), based on TODAY's message — not yesterday's resolution state.

# READING THE CONTEXT

You receive five things:

1. **The triggering message** (the message that just landed).
2. **Recent channel context** (last 15 turns with ET timestamps + pre-computed "time ago" deltas + speaker labels). Use the time-ago deltas per the section above. Use this to:
   - Detect ACTIVE conversations Ella shouldn't interject in (advisor messages within last 4 hours).
   - Thread bare @-mentions to prior unanswered questions.
   - See Ella's own prior posts so follow-ups make sense.
3. **Speaker identity** (client, advisor, ella, bot, unknown) with name.
4. **@-mention flag** (`is_ella_mentioned: true|false`).
5. **KB chunks** retrieved using the combined conversation context as the query. Each chunk has a similarity score. Higher = stronger match. Use these to:
   - Verify your respond decision is grounded — if no chunk strongly addresses the question, respond is risky.
   - Distinguish "KB has content about this" (lesson covers X) from "KB lets me answer this" (the client is asking where X lives, not what X is). The KB doesn't have navigation metadata.

# THE DIGEST FLAG (INDEPENDENT)

Independently of the decision, return `digest_flag: bool` and `digest_category`. The flag controls whether the message is surfaced in the daily digest sent to Scott (head of fulfillment) and Drake. Decision and flag are independent — Ella can answer a message AND flag it for digest visibility (Scott still wants to know "Ella handled a refund question today").

Always flag when the message involves ANY of:
- Emotional content (frustration, confusion, fear, overwhelm)
- Money / commitments (refunds, billing, contracts, cancellations)
- Complaints or dissatisfaction
- Confusion about anything
- Anything that needs human handling
- A recurring topic from prior days

When in doubt, flag. False positives are explicitly fine — Scott prefers skim-and-discard over miss-and-stress.

Set digest_flag=false ONLY for:
- Chitchat, greetings, acknowledgments
- Clean program questions Ella answered confidently
- CSM-client routine work where nothing meaningful for Scott surfaced
- Pure non-signal

`acknowledge_and_escalate` ALWAYS implies `digest_flag=true`.

# THE DIGEST CATEGORY

When digest_flag=true, set digest_category to one of:
- "question_program" — program-related question worth Scott seeing
- "emotional_human_needed" — emotional content or situation needing human handling
- "confusion" — client is confused about something
- "money_commitment" — refund / billing / contract / cancellation topic
- "complaint" — explicit complaint or dissatisfaction
- "other" — flagged but doesn't fit above

When digest_flag=false, set digest_category to null.

# DEFAULT STANCES

Two independent defaults:

- **"Should Ella speak?" defaults to skip** WHEN `is_ella_mentioned: false`. When the @-mention is on, the default is respond/ack-and-escalate per the @-MENTION OVERRIDE section. Ella interjecting in a working conversation is worse than Ella missing a question — but ignoring a direct @-mention is worse than both.

- **"Should Scott see this?" defaults to flag.** False positives are fine. When uncertain whether something matters, flag it.

# OUTPUT FORMAT

Return a strict JSON object. No prose around it, no code fences, no commentary.

{
  "decision": "respond | acknowledge_and_escalate | skip",
  "response_model": "haiku | sonnet | null",
  "ack_text": "<warm 1-2 sentence ack in Ella's voice, only when decision=acknowledge_and_escalate, otherwise null>",
  "digest_flag": true | false,
  "digest_category": "question_program | emotional_human_needed | confusion | money_commitment | complaint | other | null",
  "reasoning": "<1-3 sentences explaining your decision, max 400 chars>"
}

Field rules:
- `response_model` is required when decision='respond', null otherwise.
- `ack_text` is required when decision='acknowledge_and_escalate', null otherwise.
- `digest_category` is null when digest_flag=false; required when digest_flag=true.
- `reasoning` is always set — explain your decision concisely.
```

### Modify: `agents/ella/retrieval.py`

`fetch_recent_channel_context` extends its line format to include a pre-computed "time ago" delta. New format per line:

```
[YYYY-MM-DD HH:MM ET — <delta>] <role> (<name>): <text>
```

Where `<delta>` is rendered as:
- `<1 minute ago` — under 60 seconds.
- `<N> minutes ago` — 1-59 minutes.
- `<N>h <M>m ago` — 1-23 hours, with minutes (e.g. `2h 15m ago`).
- `<N>h ago` — exact hours under 24 (no minutes if zero).
- `<N>d ago` — 1+ days.

**The delta is computed relative to the triggering message's `sent_at`**, NOT relative to "now." This matters because the cron-drain path can fire minutes after the triggering message landed, and we want the deltas to be stable regardless of when the decision Haiku runs.

Implementation: extend the helper's signature to accept the triggering message's `sent_at` as `relative_to: datetime` parameter. Compute the delta per row as `relative_to - row.sent_at`. Render via a new small helper `_format_time_ago(seconds: int) -> str`.

`fetch_recent_channel_messages` (the row primitive) doesn't change — the delta lives only in the rendered context block.

Caller in `passive_monitor.py:_evaluate` passes through the triggering message's `sent_at` (already available via the `slack_messages` row lookup that backs the trigger).

One thing to handle: if the caller doesn't have a `sent_at` available (test paths, edge cases), default `relative_to` to `datetime.now(timezone.utc)`. Behavior degrades gracefully — the deltas just become slightly stale instead of broken.

### Modify: `docs/agents/ella/ella.md`

Update the "Decision Haiku Prompt" section to reflect:
- @-mention as absolute override at the top of the prompt.
- Time-decay bands explicit (4h / 24h / 7d).
- Bare-mention threading rule.

Also update the "Recent Context Format" section to show the new line format with the time-ago delta.

## Tests

Builder updates tests around the changed surfaces. Key cases:

**`tests/agents/ella/test_retrieval.py`** — extend:
- `_format_time_ago` returns expected strings across all bands (seconds, minutes, hours, hours+minutes, days).
- `fetch_recent_channel_context` renders the new line format with deltas.
- Delta is relative to `relative_to` parameter, not wall clock.
- Default `relative_to=None` falls back to `datetime.now(timezone.utc)`.

**`tests/agents/ella/test_passive_monitor.py`** — add or extend:
- Decision Haiku prompt contains the @-MENTION OVERRIDE section before THE THREE DECISIONS. (String-presence assertion on `_HAIKU_SYSTEM_PROMPT`.)
- Decision Haiku prompt contains the time-decay band copy.
- `decide_passive_response` plumbs `is_ella_mentioned=True` through to the rendered user prompt correctly.

**Mocked Haiku-decision behavioral tests** (the meaningful ones):
- @-mention from advisor with no prior context → expected `respond` decision (mock Haiku response, verify dispatch shape).
- Bare @-mention with prior client question in context → expected `respond` targeting prior question.
- @-mention with stale 22h-old escalation in context → expected `respond`, NOT skipped as continuation.
- Non-@-mention advisor message → expected `skip` (unchanged from current behavior).
- @-mention with emotional content → expected `acknowledge_and_escalate`.

Hard stop: `pytest tests/` must not regress below 626 (current baseline post-unanswered-flagger).

## Hard stops

1. **Test suite regression.** `pytest tests/` must pass at ≥626 tests. If lower, STOP.
2. **`ruff check` or formatter regression.** Must stay clean.
3. **`tsc --noEmit` / `npm run lint`.** No TypeScript touched in this spec, so should be clean by definition; verify.
4. **The prompt MUST be copied verbatim from this spec.** No paraphrasing, no interpolation, no "minor tightening." If Builder finds a real issue with the prompt during implementation, STOP and surface — do not silently edit.

## Smoke test gate (post-deploy)

Drake's gate (c). 5 cases in `#ella-test-drakeonly`:

1. **Bare @-mention with no prior context.** Post `@Ella` in a quiet channel state. Expected: short warm opener, `respond` with Haiku.
2. **Bare @-mention after a prior question.** Post "where do I find the sales lessons?" then wait, then post `@Ella`. Expected: Haiku threads to the prior question, decides `acknowledge_and_escalate` (KB-navigation), single warm ack response.
3. **@-mention from advisor (you posting as team_member via test_mode).** "@Ella what does the discovery section cover?" Expected: `respond`, no default-skip-advisor override.
4. **@-mention with stale prior escalation.** Look at yesterday's channel state — if there's an old escalation thread, post a fresh @-mention today. Expected: Haiku treats it as a NEW conversation, responds. (This is the regression case.)
5. **Non-@-mention message in active CSM-client conversation.** Simulate advisor-client back-and-forth, post a client follow-up. Expected: `skip` (default-skip-advisor-active still holds when no @-mention).

Verify in `/ella/runs` that each case has the correct `haiku_decision` + reasoning that references the prompt's new sections (e.g., "user @-mentioned Ella — override applies" or "22h-old context is stale, treating as new conversation").

## What could go wrong

1. **Prompt becomes too aggressive — Ella responds when she shouldn't.** Risk: hardening @-mention override might cause Ella to respond to messages where the @-mention is genuinely referential ("ask @Ella about X"). Mitigation: the prompt explicitly carves out this case. If smoke shows over-responding, tune in a follow-up.

2. **Time-decay misjudgment.** Risk: Haiku might over-index on the 4h/24h bands and miss legitimately-continuing conversations that bridge sleep cycles (client posts at 11pm, advisor responds at 8am next morning — 9h gap but same thread). Mitigation: the prompt says "default to staying out" only for 0-4h; 4-24h is "recent but new exchange likely fresh," which leaves room for advisor judgment.

3. **Pre-computed delta drift.** Risk: if `relative_to` is computed at one point in the pipeline and rendering happens at another, deltas could be inconsistent. Mitigation: pass `relative_to` explicitly from `_evaluate`; never compute it inside the rendering helper.

4. **Haiku returns the OLD prompt's expected fields.** Some legacy test fixtures might assert on old prompt language ("Strongly lean toward respond"). Builder greps for these and updates.

## Mandatory doc updates

- `docs/state.md` — new entry covering the prompt sharpening.
- `docs/agents/ella/ella.md` — Decision Haiku Prompt section + Recent Context Format section updated.

## Done means

- All file changes pushed to `main`, Vercel deploy successful.
- `pytest tests/` passes at ≥626 tests.
- `ruff check` clean.
- Smoke test 5 cases pass in `#ella-test-drakeonly`.
- Spec status flipped to `shipped` in same Builder commit-sequence as the report.
- Report at `docs/reports/ella-decision-haiku-prompt-sharpening.md` follows 6-section structure.

Drake's gates:
- (a) None — no migrations.
- (b) Any genuinely context-confusing decision Builder hits — surface immediately.
- (c) Smoke test 5 cases — post-deploy.
- (d) None — env vars unchanged.
