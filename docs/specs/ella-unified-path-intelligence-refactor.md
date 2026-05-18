# Ella Unified-Path Intelligence Refactor

**Slug:** ella-unified-path-intelligence-refactor
**Status:** in-flight

## Context

Yesterday's spec (`ella-architecture-refactor-and-daily-digest`) collapsed the passive monitor gates and introduced the daily digest. Shipped this morning, tested in `#ella-test-drakeonly` this afternoon. Smoke surfaced two real problems plus a deeper product-shape question:

1. **Double-fire on @-mention.** Reactive and passive paths both evaluated the same message because the realtime ingest fork doesn't know to skip when Ella's user_id is mentioned. Result: Ella posts twice (one Haiku-side response, one Sonnet-side response) on the same @-mention.

2. **Haiku misjudged "KB content vs KB navigation."** Client asked "how do I find the sales lessons" — Haiku decided `respond_haiku_self`, response Haiku confidently answered with what the lessons *contain* instead of recognizing it can't answer *where they live*. Same failure on the Sonnet side. Neither model recognized the question was unanswerable from the KB.

3. **Conversation context not load-bearing in decisions.** When Drake @-mentioned Ella with no text after asking "where do I find it" a turn earlier, the bare-mention short-circuit served a generic warm opener instead of threading to the prior question. The system treats each message in isolation when it should be reasoning about whether this message is a continuation, a fresh start, a CSM-client back-and-forth Ella should stay out of, or an @-mention that overrides default-skip rules.

Drake's framing of the feeling: "I am not speaking with someone who actually reads the messages and has an understanding of what I'm asking." That's a product-quality issue, not a bug. The architecture from yesterday's spec is *mechanically* working but *behaviorally* tone-deaf.

This spec refactors Ella's behavior around one principle: **one Haiku decision per message, full context, soft rules in the prompt rather than hardcoded gates.** Reactive (@-mention) and passive collapse into one pipeline; the @-mention becomes a signal Haiku weighs, not a routing path. The decision outcome set is simplified from four to three (`respond` / `acknowledge_and_escalate` / `skip`), with `acknowledge_and_escalate` *always posting an in-channel warm ack* so the client never sees silence on emotional or human-needed messages. Bare-mention short-circuit is removed — bare mentions flow through Haiku and get judged in context. The Haiku-or-Sonnet response-model picker stays as a sub-field on the `respond` decision; the `[FALLBACK_TO_SONNET]` fallback mechanism is removed (it patched a decision-layer problem in the wrong place).

Two retrieval improvements are load-bearing for the new design:

1. **KB search uses combined recent-conversation context as the query**, not just the triggering message text. A bare "@Ella" or a short follow-up needs the prior turns to find the right anchors. Concretely: concatenate last 6 messages (including Ella's own posts) + the triggering message weighted 2x, embed, search.

2. **Recent context block includes ET timestamps and explicit speaker labels.** Haiku reads recency as a signal for "is this an active conversation Ella should stay out of." Today's `fetch_recent_channel_context` returns `[HH:MM] <author_type> <name>` but without dates — Haiku can't distinguish "30 seconds ago" from "3 days ago." New format adds full ET timestamps.

The change is significant but bounded to the same modules as yesterday — `passive_monitor.py`, `passive_dispatch.py`, `agent.py`, `prompts.py`, `retrieval.py`, the existing decision Haiku prompt. No new tables, no new crons, no new migrations. Migration 0040 (`pending_digest_items`) stays. Daily digest cron stays. The architecture surface shrinks; behavior gets sharper.

## Acclimatization checklist

Builder reads these files first and confirms understanding in 4-5 bullets in the report's "What I did" section. Note any place where the spec contradicts what's already shipped — the spec is the source of truth for this change, but reality-check is load-bearing because yesterday's spec just landed.

- `CLAUDE.md` § Working Norms, § Director / Builder System, § Critical Rules
- `docs/state.md` — yesterday's entry for context on what just shipped
- `agents/ella/passive_monitor.py` — current decision-Haiku module (just shipped, being refactored further)
- `agents/ella/passive_dispatch.py` — current dispatch (being simplified to three outcomes)
- `agents/ella/agent.py` — reactive path; the @-mention + bare-mention + Sonnet flow that's being collapsed into the passive path
- `agents/ella/prompts.py` — Sonnet response prompt; needs the KB-content-vs-navigation clarification
- `agents/ella/digest_response.py` — the response Haiku module (just shipped; staying but with a refined prompt)
- `agents/ella/retrieval.py` — `fetch_recent_channel_context` is being updated; new helper for KB-query construction
- `ingestion/slack/realtime_ingest.py` — `_maybe_dispatch_passive_monitor` fork point; this is where the @-mention de-dupe lives
- `api/slack_events.py` — reactive @-mention dispatcher; the file that fires `respond_to_mention`. The "dual-trigger" logic Builder mentioned lives here

## Architecture — overview

### One path

Reactive (@-mention) and passive collapse. Both flow through the same decision Haiku. The realtime ingest fork dispatches *every* client+team_member message to `evaluate_passive_trigger`. The reactive `respond_to_mention` entry point in `agent.py` is REMOVED — `api/slack_events.py` no longer dispatches to it. The decision Haiku reads "was this message @-mentioning Ella" as a signal in its context and weighs it accordingly.

Operationally this means: when a client @-mentions Ella, the realtime ingest fires once, the passive monitor evaluates once, dispatch routes once. No double-fire.

### Two gates only

1. **Kill switch.** `ELLA_PASSIVE_MONITORING_ENABLED != 'true'` → silent skip. No `agent_runs` row.
2. **Author type.** Author must be human (`client` or `team_member`). Author types `ella`, `bot`, `workflow`, `unknown` skip with an `agent_runs` row for audit (so we can see "we ignored a bot post"). The `test_mode` carve-out from today (`team_member` already accepted in test-mode channels) becomes the default — `team_member` messages are always evaluated by Haiku now because CSMs talk to Ella too (Nico's @Ella pattern).

That's it. KB-relevance gone (already gone yesterday). CSM-directed gone. Firm-after-first gone. Bare-mention short-circuit gone. KB search still runs as context. Everything else is Haiku's call.

### Three decisions

Decision Haiku output:

```json
{
  "decision": "respond | acknowledge_and_escalate | skip",
  "response_model": "haiku | sonnet | null",
  "ack_text": "<warm ack copy, only set when decision=acknowledge_and_escalate>",
  "digest_flag": true | false,
  "digest_category": "question_program | emotional_human_needed | confusion | money_commitment | complaint | other | null",
  "reasoning": "<1-3 sentence string explaining the decision, max 400 chars>"
}
```

The three outcomes:

- **`respond`** — Ella generates a response in-channel. Sub-field `response_model: 'haiku' | 'sonnet'` picks the responder. Haiku for clean factual program/curriculum questions with strong KB anchors. Sonnet for everything else that's still answerable (nuanced, conversational threading, judgment-adjacent but still in Ella's lane).

- **`acknowledge_and_escalate`** — Ella posts an in-channel warm acknowledgment + DM fires to Scott + primary advisor + `pending_digest_items` row written. The ack text is generated by Haiku in the same decision call (`ack_text` field) so it's context-aware rather than a canned template. Used for emotional messages, judgment calls, money/commitment topics, confusion that needs a human, questions Ella can't answer from KB.

- **`skip`** — Ella stays silent in-channel. No post, no DM. `pending_digest_items` row written only if `digest_flag=true`. Used for: chitchat / acknowledgments, CSM-client active dialogue Ella shouldn't interject in, messages directed at someone else without @-mentioning Ella, bot-like posts.

Independently of decision: `digest_flag` + `digest_category`. Same as today. `acknowledge_and_escalate` always implies `digest_flag=true`.

### Response model picker

When `decision='respond'`, `response_model` is required (string `'haiku'` or `'sonnet'`). Decision Haiku picks based on the criteria in the prompt:

- **`haiku`** — clean factual question, KB has direct anchors, no nuance needed, short paraphrase-the-KB answer would land.
- **`sonnet`** — everything else that's still answerable: nuanced questions, multi-turn threading, judgment-adjacent topics, anything Haiku would flatten.

Expected split at current volume: 30-40% Haiku, 60-70% Sonnet. Adjust prompt over time as we see real distribution.

No fallback mechanism. The `[FALLBACK_TO_SONNET]` token detection in `digest_response.py` is REMOVED. Reasoning: the fallback was insurance against Haiku responding weakly, but the failure mode it was patching ("Haiku confidently answers wrong because the KB lacks navigation") wasn't actually fixable by Sonnet — Sonnet would have made the same call from the same KB. The right fix is **decision Haiku picking the right model in the first place**. If Haiku-response is weak, that's a decision-layer prompt-tuning signal.

### `acknowledge_and_escalate` on both paths

Today's design (yesterday's spec) had `digest_only` silent on passive, ack-only on reactive. This is replaced. **`acknowledge_and_escalate` always posts a warm in-channel ack**, regardless of whether the message was @-mention or passive observation. The DM fan-out (Scott + primary advisor) fires too. The digest item gets written. The principle: client never sees silence on a message that warranted human attention.

### Soft rules in the prompt (not hardcoded gates)

The decision Haiku prompt explicitly tells the model how to reason about the cases that used to be gates:

- **CSM-authored messages without @-mention → default skip.** Unless the CSM is directing a question at Ella by name or @-mention. Soft rule: "Don't interject in CSM-client conversations. If an advisor is actively engaged, defer to them."
- **Active CSM-client dialogue → default skip.** Use recency of context messages to detect this. If the advisor has posted within ~15 minutes and the conversation is flowing, stay out.
- **@-mention is a strong override signal.** When Ella is explicitly @-mentioned, lean toward responding even when other rules would default-skip. The mention is an explicit invitation.
- **Bare @-mention with prior context → respond to the prior message.** No more bare-mention shortcut. If "@Ella" lands after an unanswered question, treat the prior question as the target. If there's no prior question, generic warm opener inside `respond_haiku_self`.
- **KB-content-vs-navigation rule.** "The KB contains *what* is in the curriculum (lesson content, frameworks, methodology) but does NOT contain navigation metadata (where lessons live in the platform UI, how to access modules, login/dashboard mechanics). Questions like 'where do I find X' / 'how do I get to Y' / 'what module is Z in' should route to `acknowledge_and_escalate` — Ella can describe X but can't tell the client where it lives. The advisor handles those."
- **Re-fire of a recently flagged topic → still ack + DM.** No firm-after-first suppression. If a client follows up "still waiting on my refund" after yesterday's ack, re-ack and re-fire the DM. The repeat fire tells Scott "this is the second day — still open."
- **Emotional / judgment / money-commitment → `acknowledge_and_escalate`.** Ella doesn't try to handle these herself. She acks warmly and routes to human.

### KB search uses combined-context query

Currently `_kb_search` in `passive_monitor.py` embeds `payload.triggering_message_text` and searches against that single string. For Case 1 (Nico's "@Ella how should we structure those calls for Adam"), the search misses anchors because "those calls" requires knowing the conversation was about cold calls.

New behavior: build the embedding query from the last 6 messages (oldest → newest, *including* Ella's own posts) + the triggering message weighted 2x. Concretely:

```
{recent message 1}
{recent message 2}
...
{recent message 6}
{triggering message}
{triggering message}
```

Embed that combined string, run vector search. Returns chunks relevant to the conversation topic, not just the literal triggering text.

Edge cases:
- If recent context is empty (first message in a channel, or no prior messages within fetch window), the query is just the triggering message ×2.
- If recent context spans multiple topics, the search returns mixed-relevance chunks. Haiku is the precision filter; over-retrieval is fine.
- Triggering-message-2x weighting prevents stale-topic chunks from dominating when the triggering message starts a fresh thread.

This is a new helper function: `_build_kb_query(triggering_message, recent_messages) -> str`. Builder writes it; lives in `passive_monitor.py` or a new `agents/ella/kb_query_builder.py` module (Builder's call — single-use helper, can stay inline).

### Recent context format with ET timestamps

Today's `fetch_recent_channel_context` returns lines like `[HH:MM] <author_type> <name>: <text>` — time but no date. Haiku can't tell active-conversation (5 minutes ago) from stale-topic (3 days ago).

New format adds ET date + time + speaker role:

```
[2026-05-18 14:23 ET] client (Catrina Reeves): I'm not sure about my pricing
[2026-05-18 14:24 ET] advisor (Nico Sandoval): Let's think through it — what's your current rate?
[2026-05-18 14:25 ET] client (Catrina Reeves): $2k/mo per client
[2026-05-18 14:27 ET] advisor (Nico Sandoval): And how many clients can you handle right now?
[2026-05-18 14:28 ET] ella: Based on the discovery framework, you should...
```

Speaker role labels: `client`, `advisor` (NOT "CSM" — even in internal-facing context the prompt should use "advisor" so the model's mental model stays consistent with client-facing language), `ella` (Ella's own prior posts), `bot`, `unknown`.

Ella's posts are INCLUDED in the context — Drake's explicit call. If Ella answered a question and the client follows up "wait, what did you mean by X," Haiku needs to see Ella's prior answer to thread correctly.

Prompt instruction tells Haiku to weigh recency: "Messages within the last 15 minutes indicate an active conversation. Messages older than 1 hour are stale context. Use the timestamps to judge whether the triggering message continues an active thread or starts a fresh one."

## What changes — by file

### Modify: `agents/ella/retrieval.py`

**Function `fetch_recent_channel_context`** updated:

- Default `n_turns` stays 15. Default `max_chars` stays 8000.
- New line format: `[YYYY-MM-DD HH:MM ET] <role> (<name>): <text>` where role is one of `client`, `advisor`, `ella`, `bot`, `unknown` (NOT author_type — translate `team_member` → `advisor` here for consistency with Haiku's mental model).
- Date+time converted from `sent_at` (UTC) to ET via `zoneinfo.ZoneInfo('America/New_York')` for DST safety.
- Ella's own posts INCLUDED (today they're already included since the function doesn't filter by author_type; verify and document).
- For `author_type='team_member'`, the role label becomes `advisor`. Other types render as themselves.
- Truncation behavior unchanged.

**New function `build_kb_query_from_conversation`** added:

```python
def build_kb_query_from_conversation(
    triggering_message: str,
    recent_messages: list[dict[str, Any]],
    *,
    triggering_weight: int = 2,
) -> str:
    """Construct an embedding query from the triggering message plus
    the last N messages. Triggering message weighted 2x by repetition.

    `recent_messages` is the raw rows from slack_messages (or compatible
    dicts with a 'text' key). Returns a single concatenated string ready
    to embed."""
```

Used by `_kb_search` in `passive_monitor.py` to build the query before calling `search_for_client`. The `search_for_client` interface itself doesn't change — only the query text passed to it.

### Modify: `agents/ella/passive_monitor.py`

**`PassiveDecision` dataclass updated:**

```python
@dataclass(frozen=True)
class PassiveDecision:
    decision: str  # 'respond' | 'acknowledge_and_escalate' | 'skip'
    response_model: str | None = None  # 'haiku' | 'sonnet' | None — only set when decision='respond'
    ack_text: str | None = None  # only set when decision='acknowledge_and_escalate'
    digest_flag: bool = False
    digest_category: str | None = None
    reasoning: str = ""
    haiku_cost_usd: Decimal = Decimal("0")
    haiku_input_tokens: int = 0
    haiku_output_tokens: int = 0
```

**`_PASSIVE_DECISIONS` updated** to `{'respond', 'acknowledge_and_escalate', 'skip'}`.

**`_evaluate` pipeline updated:**

1. Gate 1: kill switch (unchanged).
2. Gate 2: author type — accept `client` AND `team_member` always (test_mode carve-out removed because team_member is now always accepted). `ella` / `bot` / `workflow` / `unknown` still skip.
3. Fetch recent context (15 turns, includes Ella's posts) BEFORE KB search — we need the messages to build the KB query.
4. Build KB query via `build_kb_query_from_conversation`.
5. KB vector search using the combined query.
6. Detect @-mention: check if Ella's user_id (`shared.slack_identity.get_user_id_for_token`) appears in the triggering message text. Boolean flag passed to Haiku in the prompt.
7. Resolve channel-mapped client + primary CSM (existing helpers).
8. Decision Haiku call with full context.

**Decision Haiku system prompt — full rewrite.** Replaces the current `_HAIKU_SYSTEM_PROMPT`. The new prompt is the load-bearing artifact of this spec — Builder copies it verbatim:

```
You are Ella's decision brain. Every message that lands in a monitored Slack channel passes through you. You decide what Ella does: respond, acknowledge and route to a human, or stay silent.

Your output is structured JSON. You do NOT write the response itself when decision='respond' — a separate model handles that. When decision='acknowledge_and_escalate' you DO write the short warm ack the client will see.

# WHO ELLA IS

Ella is the AI assistant for clients of The AI Partner, a coaching agency that helps founders build AI-native businesses. Each client has a dedicated Slack channel containing the client, their assigned advisor (called "advisor" with clients, never "CSM"), and Ella. Clients can also include their team members.

Ella's job: be the first line of support. Answer program/curriculum/process questions she can answer well. Acknowledge and route to a human anything that needs human judgment. Stay silent when she'd be interjecting on someone else's conversation.

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

- **skip** — Ella stays silent. No in-channel post, no DM. Use when:
  - The message is clearly between the client and their advisor, mid-conversation. Don't interject in active dialogue.
  - The message is from a team member (advisor or CSM) without @-mentioning Ella. Don't interject in advisor-led work.
  - The message is chitchat: greetings, acknowledgments, emoji reactions, "thanks", "ok cool".
  - The message is a status update or thinking-out-loud post not asking anyone anything.
  - The message is directed at someone else by name (not Ella).

  Even when decision='skip', you may set digest_flag=true if Scott should still see the message in his daily digest.

# THE @-MENTION SIGNAL

The triggering message text may contain an explicit @-mention of Ella (you'll see `<@U0B03PTJD3P>` or similar in the message text, or the boolean `is_ella_mentioned: true` in the input). This is the strongest signal in the system. When Ella is @-mentioned:

- Strongly lean toward respond. The @-mention is an explicit invitation.
- @-mention OVERRIDES the default-skip-CSMs rule. If Nico @-mentions Ella with a question, respond.
- @-mention with no follow-up text ("@Ella") and a prior unanswered question in the last few messages → treat the prior question as the actual target. Respond to that.
- @-mention with no follow-up text and no prior question → respond with a warm short opener inviting them to ask.
- @-mention + emotional/money/judgment content → still acknowledge_and_escalate. The @-mention escalates the priority but doesn't change what kind of message it is.

# READING THE CONTEXT

You receive five things:

1. **The triggering message** (the message that just landed).
2. **Recent channel context** (last 15 turns with full ET timestamps + speaker labels). Use this to:
   - Detect active conversations Ella shouldn't interject in (recent advisor messages within last 15 minutes = active).
   - Distinguish continuation messages from fresh-start messages (a question after silence is fresh; a question during active back-and-forth might be continuation).
   - Spot re-fires (a topic already acked recently — still ack again).
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

- **"Should Ella speak?" defaults to skip.** Ella interjecting in a working conversation is worse than Ella missing a question. When uncertain whether to respond, skip. When the message would warrant a human, prefer acknowledge_and_escalate over respond — never confidently answer a question that needs human judgment.

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

**User prompt template updated** to include the new structured context:

```
# TRIGGERING MESSAGE

{message}

# SPEAKER

{speaker_role} ({speaker_name})

# IS THIS AN @-MENTION OF ELLA?

{is_ella_mentioned}

# RECENT CHANNEL CONTEXT (last 15 turns, oldest first; includes Ella's own posts)

{recent_context_with_timestamps}

# TOP KB CHUNKS (retrieved using combined conversation context as query)

{kb_block}

# DECIDE

Return JSON with `decision`, `response_model`, `ack_text`, `digest_flag`, `digest_category`, and `reasoning`.
```

**`_parse_haiku_output` rewritten** to parse the new field set. Validation:
- `decision` in the new enum or default to skip.
- `response_model` required when decision='respond', else null. If decision='respond' but response_model is missing/invalid, default to `sonnet` (safer fallback than haiku — Sonnet is more forgiving on edge cases).
- `ack_text` required when decision='acknowledge_and_escalate', else null. If missing/empty when required, fall back to "Let me grab someone for this one — your advisor will take care of you" (the prior canned template, as last-resort safety).
- `digest_category` validated against the enum; null'd if invalid.
- `digest_flag` boolean coercion.

### Modify: `agents/ella/passive_dispatch.py`

**Module simplifies to three decision routings.** The current four-routing structure (skip / respond_haiku_self / respond_via_sonnet / digest_only) becomes three (respond / acknowledge_and_escalate / skip).

Routing:

- **`skip`** → `agent_runs` row with `status='success'`, `output_summary='skip: <reasoning_truncated>'`. If `digest_flag=true`, insert `pending_digest_items` row. No client-facing post, no DM.

- **`respond`** → Branch on `response_model`:
  - `response_model='haiku'` → call `digest_response.generate_response`, post to Slack via `shared.slack_post.post_message`. `agent_runs` row with `status='success'`, `output_summary=<response_truncated>`, cost accounting includes decision Haiku + response Haiku. If `digest_flag=true`, insert `pending_digest_items` row with `ella_responded=true`.
  - `response_model='sonnet'` → insert `pending_ella_responses` row with `haiku_decision='respond_substantive'` (the existing per-minute cron's expected enum value — same compatibility shim Builder added in yesterday's spec). `agent_runs` row with `status='success'`, `output_summary='queued (sonnet); pending_id=<id>'`. If `digest_flag=true`, insert `pending_digest_items` row with `ella_responded=true`.

- **`acknowledge_and_escalate`** → Post `decision.ack_text` to channel via `shared.slack_post.post_message`. Write `escalations` row via `agents.ella.escalation.escalate()`. Fan DMs out via `agents.ella.escalation_routing.fire_escalation_dms()` to Scott + primary advisor. Insert `pending_digest_items` row (always — implied by decision). `agent_runs` row with `status='escalated'`, `output_summary='ack_and_escalate; escalation_id=<id>; <dm_results>'`.

**Removed from this module:**
- The `_dispatch_respond_haiku_self` function and its `[FALLBACK_TO_SONNET]` detection branch — the fallback mechanism is gone. The respond-haiku path no longer falls through to Sonnet.
- The `digest_only` decision branch (collapsed into `acknowledge_and_escalate`).

**Added to this module:**
- `_dispatch_acknowledge_and_escalate` function — posts the ack, writes escalations row, fires DMs, writes digest item.

**`trigger_metadata` shape updated:**

```python
trigger_metadata = {
    "triggering_slack_channel_id": payload.slack_channel_id,
    "triggering_message_ts": payload.triggering_message_ts,
    "triggering_message_slack_user_id": payload.triggering_message_slack_user_id,
    "channel_client_id": payload.channel_client_id,
    "author_type": payload.author_type,
    "is_ella_mentioned": <bool>,  # new — recorded for audit
    "haiku_decision": decision.decision,  # one of the 3 new values
    "response_model": decision.response_model,  # new
    "ack_text": decision.ack_text,  # new
    "haiku_reasoning": decision.reasoning,
    "digest_flag": decision.digest_flag,
    "digest_category": decision.digest_category,
    "skip_reason": evaluation.skip_reason,
}
```

### Modify: `agents/ella/agent.py`

This is where the biggest behavioral change lands. The reactive @-mention entry point is being REMOVED from production traffic.

**`respond_to_mention` deprecation:** The function stays in the file (Builder doesn't delete it — the Sonnet response generation logic inside is reused by `respond_to_passive_trigger`) but it's no longer called by `api/slack_events.py`. The dispatcher in `slack_events.py` is updated to NOT call `respond_to_mention` anymore. All @-mentions flow through the realtime ingest → passive monitor path.

**`respond_to_passive_trigger` stays.** This is what the per-minute Sonnet cron calls when draining `pending_ella_responses`. It generates the Sonnet response and posts. Updates needed:
- Remove `[ESCALATE]` detection (already removed yesterday — verify).
- Update to read from the new `PassiveDecision` shape if any of its inputs come from `trigger_metadata`.

**`_handle_bare_mention` removed.** The bare-mention short-circuit goes away entirely. Bare @-mentions now flow through the full decision Haiku pipeline.

**`_BARE_OPENERS_*` constants removed.** No longer used.

**`_PASSIVE_GENERAL_OPENERS_*` constants removed.** No longer used (the `respond_general_inquiry` decision was already removed in yesterday's spec).

**`handle_passive_general_inquiry` removed.** Dead code now.

### Modify: `api/slack_events.py`

The reactive @-mention dispatcher is the file Drake's earlier diagnosis pointed at — the "dual-trigger" logic that was reshaping `message` events into `app_mention` shape.

**Update:** Remove the call to `agent.respond_to_mention`. The realtime ingest path (`ingest_message_event` → `_maybe_dispatch_passive_monitor` → `evaluate_passive_trigger`) is now the only path. The `app_mention` event handler in this file should either:
- Be removed entirely if it's redundant with the `message` event handler.
- Be kept but updated to log "deduped — handled via passive path" and return without firing `respond_to_mention`.

Builder reads the file and picks the cleanest option. The goal: ONE evaluation per Slack message regardless of whether it's a `message` event or an `app_mention` event.

### Modify: `agents/ella/digest_response.py`

The response Haiku module stays. Two changes:

1. **Remove `[FALLBACK_TO_SONNET]` detection.** The token + escape hatch goes away. If the response Haiku produces a weak response, that's a decision-Haiku-prompt issue, not a response-time issue.

2. **Update the response Haiku system prompt** with the same KB-content-vs-navigation clarification that's in the decision Haiku prompt. Add to the "WHAT YOU DO IF YOU CAN'T ANSWER" section:

```
The KB contains *what* is in the curriculum but does NOT contain navigation metadata. If the question is about where to find something in the platform UI, you cannot answer it — and the decision layer should have routed this to a human instead of to you. If you find yourself with this kind of question, respond with a short warm "I should get your advisor on this one — they can point you to where this lives" rather than guessing about platform navigation.
```

`DigestResponseResult.fallback_to_sonnet` field stays in the dataclass but always returns False (the field is vestigial — Builder can remove it in a follow-up cleanup).

### Modify: `agents/ella/prompts.py`

The Sonnet response prompt (`_BASE_PROMPT`) needs the same KB-content-vs-navigation clarification. Add to the "WHAT YOU CAN HELP WITH" section:

```
The KB contains *what* is in the curriculum (lesson content, frameworks, methodology) but does NOT contain navigation metadata (where lessons live in the platform UI, how to access modules, login/dashboard mechanics). If a client asks "where do I find X" or "how do I get to Y in the platform," recognize that you can describe X but can't tell them where it lives — say so warmly and route to the advisor. Don't invent platform navigation details.
```

The `[FALLBACK_TO_SONNET]` instruction (yesterday's spec added this) is REMOVED — Sonnet no longer has a fallback because the fallback mechanism is gone.

### Modify: `ingestion/slack/realtime_ingest.py`

**`_maybe_dispatch_passive_monitor` updated** to accept all human author types (`client` + `team_member`), not just `client`. The author-type gate logic is in `passive_monitor.py` itself — verify the fork doesn't pre-filter on author type before dispatching.

**Add @-mention detection.** Before building the `PassiveTriggerPayload`, check if Ella's user_id appears in the triggering message text. Pass the boolean through the payload to the decision Haiku.

Updated `PassiveTriggerPayload`:

```python
@dataclass(frozen=True)
class PassiveTriggerPayload:
    slack_channel_id: str
    triggering_message_ts: str
    triggering_message_slack_user_id: str
    triggering_message_text: str
    author_type: str
    channel_client_id: str
    is_ella_mentioned: bool = False  # new
    test_mode: bool = False  # kept for compat; team_member is now always accepted regardless
```

### Documentation updates

- **`docs/state.md`** — add new entry for today (2026-05-18 evening or 2026-05-19 depending on when this ships) covering the unified-path refactor.
- **`docs/agents/ella/ella.md`** — substantial rewrite. The Triggers section now describes the unified pipeline. The decision-tree section gets the 3-outcome model. The @-mention section gets the new "signal not separate path" framing. Style examples for ack_text added.
- **`docs/runbooks/ella_passive_monitoring.md`** — update gate pipeline (2 gates), update decision-tree section (3 outcomes), update troubleshooting (new `skip_reason` values, new `is_ella_mentioned` field).
- **`docs/runbooks/ella_daily_digest.md`** — no major changes; verify it doesn't reference removed decisions.
- **`docs/schema/pending_digest_items.md`** — no changes (table didn't change).

### Tests

Builder writes/updates tests for each changed surface:

**`tests/agents/ella/test_passive_monitor.py`** — substantial updates:
- Add tests for @-mention detection and prompt threading.
- Update for 3-outcome decision parsing.
- Add tests for the soft rules: active-CSM-dialogue → skip, CSM-with-@-mention → respond, bare-@-mention-with-prior-context → respond to prior, KB-navigation-question → acknowledge_and_escalate.
- Test the response_model picker output.
- Test ack_text presence/absence based on decision.

**`tests/agents/ella/test_passive_dispatch.py`** — rewrite for 3-outcome routing:
- `respond + response_model=haiku` → calls digest_response, posts to Slack.
- `respond + response_model=sonnet` → queues pending_ella_responses with `respond_substantive` shim.
- `acknowledge_and_escalate` → posts ack, writes escalations row, fires DMs, writes digest item.
- `skip + digest_flag=false` → only agent_runs row.
- `skip + digest_flag=true` → agent_runs + pending_digest_items.

**`tests/agents/ella/test_retrieval.py`** (new or extend existing):
- `fetch_recent_channel_context` returns new format with ET timestamps and role labels.
- `build_kb_query_from_conversation` weights triggering message 2x.
- Ella's own posts included in context (verify, write test if missing).

**`tests/agents/ella/test_agent.py`** — update:
- `respond_to_mention` no longer called by production code (test that `slack_events.py` doesn't dispatch to it).
- `respond_to_passive_trigger` still works for Sonnet drain.
- `_handle_bare_mention` and related helpers removed.

**`tests/api/test_slack_events.py`** (extend):
- `message` event with @-mention → ingested via realtime path, NO call to `respond_to_mention`.
- `app_mention` event → either deduped or not fired (depending on Builder's choice for handling this event type).

**`tests/agents/ella/test_digest_response.py`** — update:
- Remove `[FALLBACK_TO_SONNET]` detection tests.
- Add test for KB-navigation refusal pattern.

**Existing tests that should stay green:** All non-Ella tests. Daily digest cron tests. Migration / schema tests.

Total expected test count post-spec: roughly flat to baseline (some tests removed with deleted code paths, others added). Hard stop: `pytest tests/` must not regress below 609 (yesterday's post-ship count).

## Hard stops

1. **Test suite regression.** `pytest tests/` must pass at ≥609 tests. If lower, STOP and surface.

2. **`tsc --noEmit` or `npm run lint` regression.** Must stay clean. Any new warnings → STOP.

3. **Double-fire detection in smoke test.** When Drake posts an @-mention in `#ella-test-drakeonly`, Ella must respond EXACTLY ONCE. If two responses fire, STOP — there's still dual-trigger logic somewhere. Builder traces it and surfaces.

4. **Decision Haiku returns malformed JSON >5% of smoke test fires.** The new prompt is more complex; parse failures should be rare but if smoke shows >1 in 20 messages producing unparseable output, STOP and tune the prompt before deploying further.

5. **Hard-numerical threshold: `acknowledge_and_escalate` warm-ack generation produces empty/null ack_text in any smoke message.** If Haiku decides ack-and-escalate but doesn't populate `ack_text`, the dispatch layer falls back to the canned template (per the spec). Surface every fallback case in the report — if it happens >1 in 10 smoke fires, the prompt needs tuning.

## Smoke test gate (post-deploy)

Drake's gate (c). The test set from yesterday's spec gets expanded to cover the new behaviors:

1. **Bare @-mention with prior context.** Drake posts "where do I find the sales lessons" (no @-mention), waits, then posts "@Ella". Expected: Ella threads to the prior question. If the question is KB-navigation, expected decision is `acknowledge_and_escalate` with a warm ack mentioning the advisor. Verify ONE response, not two.

2. **Bare @-mention with no prior context.** Drake posts "@Ella" in a quiet channel state. Expected: Ella posts a warm short opener.

3. **@-mention with clean KB-anchored question.** Drake posts "@Ella what does the discovery section cover?" Expected: `respond` with `response_model=haiku` (clean factual, KB has direct anchors). Single response.

4. **@-mention with nuanced question.** Drake posts "@Ella I'm thinking about restructuring my offer — what's the right approach given my current setup?" Expected: `respond` with `response_model=sonnet`.

5. **@-mention with emotional content.** Drake posts "@Ella I'm really frustrated, where do I actually find this stuff?" Expected: `acknowledge_and_escalate` with warm ack + DM to Scott + Drake.

6. **Non-@-mention emotional content.** Drake posts "I'm really frustrated lately" without @-mention. Expected: `acknowledge_and_escalate` (emotional content triggers regardless of @-mention). Warm ack posts in-channel.

7. **Active CSM-client dialogue interjection test.** Drake posts a series of messages simulating advisor-client back-and-forth (using test_mode to send as team_member). Expected: Ella stays SILENT throughout the dialogue. No interjections.

8. **CSM @-mention question.** Drake posts (as team_member via test_mode) "@Ella how does the sales call framework work?" Expected: `respond` (the @-mention overrides the default-skip-CSMs rule). Single response.

9. **Manual digest curl** — after all the above, curl the digest with `?since=<isoT-1h>`. Expected: digest body contains entries for the emotional + KB-navigation messages with the right categories, and the ack-and-escalate messages are clearly attributed.

10. **`/ella/runs` dashboard check.** Verify the new `trigger_metadata` fields (`is_ella_mentioned`, `response_model`, `ack_text`) appear correctly. If the dashboard adapters don't surface these, log as a follow-up — not a blocker.

If any of 1-8 produces double-fire or wrong decision, STOP. Surface to Drake. Spec is iterative; the new prompt may need tuning before going live on production channels.

## What could go wrong

1. **Haiku misjudges "active CSM-client dialogue" → interrupts.** This is the highest-risk regression. Today's hardcoded gate caught all CSM-without-@-mention cases. New design relies on Haiku reading recency + speaker patterns. Mitigation: the soft rule is explicit in the prompt with examples; smoke test #7 specifically validates it. If smoke shows Ella interjecting, prompt needs tuning before broader rollout.

2. **Haiku picks `haiku` response model for messages that should be Sonnet → weak responses.** The expected split (30-40% Haiku) might be too aggressive. Mitigation: prompt instructs "default to Sonnet when uncertain." Monitor distribution after deploy.

3. **`ack_text` quality varies wildly.** Haiku generating ack copy each time means the warmth + tone will be inconsistent. Mitigation: the prompt has 3 examples; if smoke shows bad ack copy, add more examples and re-deploy.

4. **`is_ella_mentioned` detection misses edge cases.** Slack mention syntax is `<@U...>` but might appear in different forms (link-style mentions, etc.). Mitigation: Builder uses the same regex as `_is_directed_at_csm` (which has been working) and verifies via grep that all mention shapes are caught.

5. **KB query construction breaks on empty context.** If the channel has no prior messages and the triggering message is short ("@Ella"), the combined query might be too thin for good retrieval. Mitigation: triggering-message-2x weighting ensures at least *some* content in the query. Acceptable degradation; Haiku reads the empty-context state and adjusts.

6. **Reactive `respond_to_mention` removal breaks something else.** The function is called from `slack_events.py`. Builder greps for ALL call sites and verifies removing the dispatcher path doesn't break test fixtures or anything else.

7. **Active rollout risk.** This deploys to all 130 production channels immediately (Drake's Option A — fast rollout). If Haiku regression hits any client channel before smoke catches it, the misfire is visible to real clients. Mitigation: smoke test runs in test channel BEFORE the deploy completes (Vercel takes ~30s to swap; passive ingest keeps running on the OLD architecture until the swap completes — there's no "both paths active" window of any meaningful duration). Worst case if smoke surfaces a regression: Drake flips `ELLA_PASSIVE_MONITORING_ENABLED=false` globally while Builder fixes.

## Mandatory doc updates

- `docs/state.md` — new entry today.
- `docs/agents/ella/ella.md` — substantial rewrite.
- `docs/runbooks/ella_passive_monitoring.md` — update gate pipeline + decision tree + troubleshooting.

## Done means

- All file changes pushed to `main`, Vercel deploy successful.
- `pytest tests/` passes at ≥609 tests, no regression.
- `tsc --noEmit` + `npm run lint` clean.
- Smoke test in `#ella-test-drakeonly` passes for all 8 message cases.
- Manual digest curl produces correctly-formatted DM to Scott + Drake.
- Spec status flipped to `shipped` in same Builder commit-sequence as the report.
- Report at `docs/reports/ella-unified-path-intelligence-refactor.md` follows 6-section structure.

Drake's gates:
- (a) None — no migrations.
- (b) Any genuinely context-confusing decision Builder hits — surface immediately.
- (c) Smoke test in `#ella-test-drakeonly` across all 8 cases — post-deploy.
- (d) None — env vars unchanged.
