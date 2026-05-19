# Ella @-Mention Structural Override

**Slug:** ella-at-mention-structural-override
**Status:** shipped

## Context

Three iterations of prompt-engineering the decision Haiku to honor "@-mention trumps all" have failed in production. v1 said "lean toward respond." v2 said "skip is FORBIDDEN unless referential" with three explicit sub-cases. The 22:20 UTC test today still produced `skip` on a bare `<@Ella>` from Drake, with Haiku rationalizing: "Drake (advisor) posted a bare @-mention 3h 55m ago in an ACTIVE conversation where he was already escalated to Scott yesterday."

The pattern is clear: Haiku finds rationalizations no matter how absolute we make the rule, because the prompt asks it to weigh competing signals (speaker role, conversation activity, prior resolution state) alongside the @-mention. Even with "skip is FORBIDDEN" copy, the model satisfies the *letter* of the override while skipping anyway by reclassifying the input ("this isn't really a fresh @-mention, it's a continuation of an active conversation").

This is not a Haiku capability issue. It's prompt-design overload. The decision Haiku does real, useful judgment work — but only when "should Ella respond" is the genuine question. When the @-mention has already answered that question, we shouldn't be asking the model again.

This spec moves the @-mention handling out of the decision Haiku entirely. When `is_ella_mentioned=true`, the passive dispatch layer bypasses the decision Haiku and routes structurally — with a small focused classifier Haiku call to pick the response shape. The decision Haiku continues to handle non-@-mention passive observation where the "should I interject" question is genuinely judgment-laden.

The change is bounded: one new module (`agents/ella/mention_classifier.py`), additions to `passive_dispatch.py` for the structural branch, and prompt removal of @-mention-related sections from `_HAIKU_SYSTEM_PROMPT` (since they're no longer needed). No new tables, no migrations, no env vars.

Crucially: this preserves all the response behaviors we already have — Haiku self-answers vs Sonnet, the `acknowledge_and_escalate` ack copy generation, the digest flag. The only thing changing is *who decides what shape to use* on @-mention messages.

## Acclimatization checklist

- `CLAUDE.md` § Working Norms, § Critical Rules
- `docs/state.md` — particularly today's entries (v1 deploy, v2 deploy, smoke diagnostic)
- `docs/reports/ella-decision-haiku-prompt-sharpening-smoke-diagnostic.md` — the v1 failure analysis
- `docs/reports/ella-decision-haiku-prompt-sharpening-v2.md` — the v2 shipped state
- `agents/ella/passive_monitor.py` — `_HAIKU_SYSTEM_PROMPT` (heavily edited in v1 and v2; this spec removes the @-mention sections); `_evaluate` function (this spec adds the structural branch upstream)
- `agents/ella/passive_dispatch.py` — the dispatch routing layer
- `agents/ella/digest_response.py` — the response Haiku module (this spec reuses it)
- `agents/ella/agent.py` — Sonnet response path (this spec reuses the pending-response queue)

## Architecture — overview

### The new flow

Per message hitting the passive monitor:

1. **Gates** (kill switch + author type) — unchanged.
2. **KB vector search + recent context fetch** — unchanged.
3. **@-mention check** — read `is_ella_mentioned` from the payload.

**If `is_ella_mentioned: true` → STRUCTURAL BRANCH (new):**

4a. Call the new `classify_mention_response` function (the classifier Haiku — tiny prompt, 4-enum output).
5a. Branch on classifier output:
    - `respond_haiku` → response Haiku generates and posts.
    - `respond_sonnet` → queue in `pending_ella_responses`.
    - `acknowledge_and_escalate` → post ack, write `escalations` row, fire DMs to Scott + primary advisor.
    - `warm_opener` → response Haiku generates a short warm opener.
6a. Independently, the classifier also returns `digest_flag` + `digest_category`. If `digest_flag=true`, write `pending_digest_items`.
7a. Write `agent_runs` row with the structural decision.

**If `is_ella_mentioned: false` → DECISION HAIKU PATH (existing):**

4b. Call `decide_passive_response` (the current decision Haiku) — unchanged behavior for non-@-mention messages.
5b. Dispatch routes per the existing 3-outcome model.

### Why a classifier instead of fully hardcoding

The @-mention answers "should Ella respond" structurally — that part is removed from LLM judgment. But "what *shape* of response" still needs reading the message:

- Is the question answerable from the KB chunks? (Haiku-handled vs Sonnet-handled)
- Is the message emotional/money/judgment? (`acknowledge_and_escalate` vs `respond`)
- Is the @-mention bare with no real content? (`warm_opener`)
- Should this also flag for Scott's digest?

These are real classification questions that benefit from LLM judgment. The key difference vs the decision Haiku: the classifier has NO "should I respond" question to escape into. The output enum doesn't include `skip`. The only outputs are response shapes.

### Why this prompt won't have the same failure mode

The current decision Haiku has 7+ sections of prompt weighing competing signals (speaker role, conversation activity, time decay, KB relevance, @-mention override, default stances, etc.). The model can pick any one of these to justify any outcome. The classifier prompt has ONE job: shape the response. No "should I" decisions. No competing rules. ~30 lines instead of ~200.

The classifier still might pick the wrong shape — e.g., choose `warm_opener` for a substantive question — but the cost of that error is small (Ella posts something instead of nothing), versus today's failure where the cost is large (Ella posts nothing on an explicit request).

### What the decision Haiku still does

Non-@-mention messages. This is the genuine judgment surface — does Ella interject in a CSM-client conversation, does she answer an emotional message from a client, does she stay out of a routine logistics message. All the soft-rules and time-decay reasoning still apply here. This spec doesn't touch that path's behavior.

We also strip the @-mention sections from the decision Haiku prompt because they're vestigial — no @-mention message reaches this code path anymore. Removing them shortens the prompt and reduces the surface area for rationalizations leaking back into non-@-mention decisions.

### What we lose

The referential carve-out — "Hey Scott, ask @Ella about X" — used to be a `skip` outcome. Under this spec, that bare @-mention triggers the classifier, which most likely outputs `warm_opener` ("Hey Drake, what can I help with?"). That's a misfire on a rare case. Acceptable trade vs the current behavior where every @-mention from advisors is being skipped.

## What changes — by file

### New: `agents/ella/mention_classifier.py`

New module. ~80 lines. Owns the classifier Haiku call.

```python
"""Classifier Haiku for @-mention messages.

When a message has `is_ella_mentioned=true`, the passive_dispatch layer
bypasses the full decision Haiku and calls this classifier instead. The
question "should Ella respond" is already answered by the @-mention
itself — the classifier only picks the response shape.

Public entry: `classify_mention_response(payload, kb_chunks, recent_context,
primary_csm, channel_client)`.

Returns a `MentionClassification` carrying the response shape + digest
flag + token counts + cost.
"""
```

System prompt (load-bearing; Builder copies verbatim):

```
You are Ella's mention-response classifier. A user has explicitly @-mentioned Ella in a Slack channel. Your job is ONLY to decide what SHAPE of response Ella should give — never whether to respond. Responding is already decided by the @-mention itself.

# YOUR ONLY DECISION

Pick exactly one response shape:

- **respond_haiku** — A second small model will write the response. Use when:
  - The triggering message contains a clear, factual program/curriculum/process question.
  - The retrieved KB chunks below directly address what's being asked.
  - A short paraphrase-the-KB answer would land cleanly.
  - No emotional charge, no money/commitment topic, no personal judgment call.

- **respond_sonnet** — A larger model will write the response. Use when:
  - The message is a question Ella can answer but needs nuance, multi-turn threading, or careful framing.
  - The retrieved KB chunks help but the answer needs texture a small model would flatten.
  - When uncertain between haiku and sonnet, pick sonnet.

- **acknowledge_and_escalate** — Ella will post a warm ack in-channel and the backend will DM the client's advisor + Scott. Use when:
  - The message involves emotional content (frustration, overwhelm, fear, anger, defeat).
  - The message involves money or commitments (refunds, billing, cancellations, contracts).
  - The message is a complaint or expresses dissatisfaction.
  - The message asks for a personal judgment call about the client's specific situation.
  - The message asks about platform navigation ("where do I find X" / "what module is Y in") — the KB has lesson content but not navigation metadata, the advisor handles those.
  - The message indicates the user is confused and stuck in a way that needs a human.

  When picking this shape, you ALSO write the ack_text — short (1-2 sentences), warm, in Ella's voice. Acknowledge the user, mention the advisor will follow up. Do NOT @-mention the advisor in the text (the backend handles notification). Address by first name when natural.

  Examples:
  - "Hey Catrina, totally hear that — I'll have Scott jump in on this one shortly."
  - "Let me get your advisor's eyes on this. They'll follow up directly."
  - "I see you, this needs a human. Nico will be in touch."

- **warm_opener** — Ella will post a brief friendly opener inviting the user to ask. Use when:
  - The @-mention is bare (no text after the mention) AND no clear question exists in recent context.
  - The @-mention text is too short or vague to classify ("hey", "thanks", "yo").
  - The @-mention seems casual or social rather than substantive.

# WHAT YOU DO NOT DO

You never output `skip`. You never decide "this doesn't need a response." The user @-mentioned Ella — that decision is made. You only pick the SHAPE.

If you find yourself reasoning "this doesn't really warrant a response because..." — STOP. The user explicitly invited Ella. Pick the smallest appropriate shape (often warm_opener) but never skip.

# DIGEST FLAG (INDEPENDENT)

Independently, return digest_flag and digest_category. The flag controls whether the message surfaces in Scott + Drake's daily digest. Set digest_flag=true when the message involves any of:
- Emotional content
- Money / commitments
- Complaints or dissatisfaction
- Confusion that needs human handling
- A recurring topic from prior days
- Anything Scott would want to see

When in doubt, flag. False positives are explicitly fine.

`acknowledge_and_escalate` always implies `digest_flag=true`.

When digest_flag=true, also pick digest_category:
- "question_program" | "emotional_human_needed" | "confusion" | "money_commitment" | "complaint" | "other"

When digest_flag=false, digest_category is null.

# OUTPUT FORMAT

Return strict JSON. No prose, no code fences, no commentary.

{
  "shape": "respond_haiku | respond_sonnet | acknowledge_and_escalate | warm_opener",
  "ack_text": "<warm 1-2 sentence ack in Ella's voice, only when shape=acknowledge_and_escalate, otherwise null>",
  "digest_flag": true | false,
  "digest_category": "question_program | emotional_human_needed | confusion | money_commitment | complaint | other | null",
  "reasoning": "<1-2 sentences explaining your choice, max 300 chars>"
}

Field rules:
- `ack_text` is required when shape='acknowledge_and_escalate', null otherwise.
- `digest_category` is null when digest_flag=false, required when digest_flag=true.
```

User prompt template:

```
# TRIGGERING MESSAGE

{message}

# SPEAKER

{speaker_role} ({speaker_name})

# RECENT CHANNEL CONTEXT (last 15 turns)

{recent_context_with_timestamps}

# KB CHUNKS

{kb_block}

# CLASSIFY

Pick the response shape. The @-mention is already explicit — you do NOT decide whether to respond.
```

**`MentionClassification` dataclass:**

```python
@dataclass(frozen=True)
class MentionClassification:
    shape: str  # 'respond_haiku' | 'respond_sonnet' | 'acknowledge_and_escalate' | 'warm_opener'
    ack_text: str | None
    digest_flag: bool
    digest_category: str | None
    reasoning: str
    haiku_cost_usd: Decimal
    haiku_input_tokens: int
    haiku_output_tokens: int
```

**Public function `classify_mention_response`** — Builder writes this following the shape of `decide_passive_response` in `passive_monitor.py`. Same Haiku model (`claude-haiku-4-5-20251001`), same client, same `max_tokens` (~600 should be plenty), same retry/error handling. Same JSON parse + validation pattern.

Output parsing safer-fallback: if classifier returns malformed JSON or out-of-enum shape, default to `warm_opener` with an empty ack_text. Reasoning: any failure → safest response is a warm opener; never a skip, never a substantive misfire.

### Modify: `agents/ella/passive_monitor.py`

**`_HAIKU_SYSTEM_PROMPT` — strip @-mention sections.** The current prompt has substantial @-mention copy: the `# THE @-MENTION OVERRIDE (READ THIS FIRST)` section, the worked example, references throughout. Remove all of these. The decision Haiku prompt becomes shorter and focused on its remaining job: deciding what to do with non-@-mention passive observation.

Specifically remove or update:
- The entire `# THE @-MENTION OVERRIDE (READ THIS FIRST)` section.
- The `# WORKED EXAMPLE — RESOLVED-THREAD BARE MENTION` section.
- All references to `is_ella_mentioned` and @-mention behavior throughout the prompt body.
- The "@-mention is a strong override signal" bullets in the THE @-MENTION SIGNAL section (entire section can be cut).
- The conditional language in the THREE DECISIONS section that references @-mention exceptions ("AND only when is_ella_mentioned: false" — that conditional becomes unconditional now since the prompt only runs for non-@-mention messages).
- The DEFAULT STANCES section's conditional on `is_ella_mentioned: false` — becomes unconditional.

Add a one-line preamble at the top:

```
You are Ella's decision brain for PASSIVE OBSERVATION messages — messages where the user did NOT @-mention Ella. @-mention messages are routed separately. Your job is to decide what Ella does with this overheard message: respond, acknowledge_and_escalate, or skip.
```

Builder treats this surgery carefully — the prompt is structurally important, so removal needs to leave a coherent document. Re-read the prompt end-to-end after edits to confirm.

**`PassiveDecision` dataclass — unchanged.** The 3-outcome model still applies for the decision-Haiku-handled non-@-mention path.

### Modify: `agents/ella/passive_dispatch.py`

**Add structural @-mention branch.** Before calling `decide_passive_response`, check `payload.is_ella_mentioned`. If true, call `classify_mention_response` instead and route per the classifier output.

New dispatch shape (pseudocode):

```python
def dispatch(payload, kb_chunks, recent_context, ...):
    if payload.is_ella_mentioned:
        classification = classify_mention_response(payload, kb_chunks, recent_context, ...)
        return _dispatch_mention(payload, classification, ...)
    else:
        evaluation = decide_passive_response(payload, kb_chunks, recent_context, ...)
        return _dispatch_passive(payload, evaluation, ...)
```

**New `_dispatch_mention` function** handles the four shapes:

- `respond_haiku` → call `digest_response.generate_response`, post to Slack, write `agent_runs` row with cost from BOTH calls (classifier + response Haiku).
- `respond_sonnet` → insert `pending_ella_responses` row with `haiku_decision='respond_substantive'` (the existing per-minute cron's expected enum value — same compatibility shim as today).
- `acknowledge_and_escalate` → post `classification.ack_text` to channel, call `escalations.escalate()`, fire DMs via `fire_escalation_dms()` to Scott + primary advisor, write `agent_runs` row with `status='escalated'`.
- `warm_opener` → call `digest_response.generate_response` with a special prompt hint (or pre-compose a short stock opener — Builder's call; lean toward letting response Haiku generate it for voice consistency). Post to Slack.

For ALL shapes: if `classification.digest_flag=true`, insert a `pending_digest_items` row.

`trigger_metadata` for mention-path runs:

```python
{
    "triggering_slack_channel_id": ...,
    "triggering_message_ts": ...,
    "is_ella_mentioned": True,
    "mention_classifier_shape": classification.shape,
    "mention_classifier_reasoning": classification.reasoning,
    "ack_text": classification.ack_text,
    "digest_flag": classification.digest_flag,
    "digest_category": classification.digest_category,
    "skip_reason": None,  # never skipped on mention path
    # ... existing fields
}
```

Note the new field `mention_classifier_shape` distinguishes classifier-handled runs from decision-Haiku-handled runs in `/ella/runs`.

**Existing `_dispatch_passive` function** stays unchanged for the non-@-mention path.

### Modify: `agents/ella/digest_response.py`

Add support for a `warm_opener` mode. Current `generate_response` returns a substantive answer; needs to also handle the "post a brief friendly opener" case.

Options:
- **A.** Add a `mode` parameter to `generate_response`. When `mode='warm_opener'`, the user prompt instructs Haiku to write a 1-sentence warm opener inviting the user to ask. Default `mode='substantive'` keeps current behavior.
- **B.** Don't use response Haiku for warm openers; pre-compose a short stock message ("Hey {name}, what can I help with?") in dispatch code.

Lean: **A**, slightly more cost but keeps voice consistent across response shapes and lets the opener address the user by name naturally.

### Modify: `agents/ella/agent.py`

**`respond_to_passive_trigger` (the Sonnet drain path)** — verify it still works correctly when invoked from the new mention-path dispatch. It currently reads from `pending_ella_responses`; the mention-path `respond_sonnet` shape writes to the same table with the same shim, so this should be a no-op. Builder verifies.

### Modify: `docs/agents/ella/ella.md`

Substantial documentation update:
- New section: "@-Mention Handling (Structural)" describing the bypass + classifier flow.
- Update "Decision Haiku Prompt" section to note it now ONLY runs for non-@-mention messages.
- Add the classifier Haiku prompt + decision shapes to the agent doc.

### Modify: `docs/state.md`

New entry under today's date covering the structural override.

### Tests

**`tests/agents/ella/test_mention_classifier.py`** (new):
- Happy path: KB-answerable question → `respond_haiku`.
- Nuanced question → `respond_sonnet`.
- Emotional content → `acknowledge_and_escalate` with ack_text populated.
- Bare @-mention, no context → `warm_opener`.
- Bare @-mention with prior unanswered question → `respond_sonnet` or `respond_haiku` (whichever fits the prior question).
- Bare @-mention with stale/resolved prior thread → `warm_opener` (NOT skip — assert classifier doesn't try to output skip).
- Malformed JSON → safer-fallback to `warm_opener`.
- Out-of-enum shape → safer-fallback to `warm_opener`.
- `digest_flag` independent of shape.

**`tests/agents/ella/test_passive_dispatch.py`** (extend):
- `is_ella_mentioned=true` → calls `classify_mention_response`, NOT `decide_passive_response`.
- `is_ella_mentioned=false` → calls `decide_passive_response`, NOT `classify_mention_response`.
- Mention-path `respond_haiku` → calls digest_response, posts to Slack.
- Mention-path `respond_sonnet` → queues `pending_ella_responses`.
- Mention-path `acknowledge_and_escalate` → posts ack, writes escalations row, fires DMs.
- Mention-path `warm_opener` → calls digest_response in warm_opener mode.
- Mention-path `digest_flag=true` → writes `pending_digest_items`.
- `trigger_metadata` includes `mention_classifier_shape` for mention runs and `haiku_decision` for passive runs.

**`tests/agents/ella/test_passive_monitor.py`** (modify):
- Update existing prompt-shape assertions — @-mention sections REMOVED from `_HAIKU_SYSTEM_PROMPT`. Assert their absence.
- Remove tests for @-mention behavior in the decision Haiku (those move to test_mention_classifier).
- Existing non-@-mention decision tests stay green.

**`tests/agents/ella/test_digest_response.py`** (extend):
- `mode='warm_opener'` returns a short friendly opener.
- `mode='substantive'` (default) returns full response.

Hard stop: `pytest tests/` must pass at ≥635 (current baseline post-v2).

## Hard stops

1. **Test suite regression.** `pytest tests/` must pass at ≥635 tests. Some tests get rewritten (decision Haiku @-mention tests move to classifier tests) but net count should stay flat or grow.

2. **`ruff check`** on touched files must stay clean.

3. **`tsc --noEmit` / `npm run lint`** clean. No TS touched in this spec.

4. **Classifier prompt copied verbatim from this spec.** No paraphrasing during implementation. If Builder finds an issue, STOP and surface.

5. **Decision Haiku prompt surgery must leave a coherent document.** After removing @-mention sections, Builder re-reads the prompt end-to-end and confirms it still flows. If sections feel orphaned, restructure or flag.

## Smoke test gate (post-deploy)

Drake's gate (c). 6 cases in `#ella-test-drakeonly`. The first three are THE critical regression cases — they validate the structural fix actually closed the failure:

1. **Bare `<@Ella>` from Drake (advisor) in a channel with stale/resolved escalation in context.** Expected: `respond` (any shape), single response posted. Verify in `/ella/runs` the trigger_metadata shows `mention_classifier_shape` populated (NOT `haiku_decision='skip'`). Most likely shape: `warm_opener`.

2. **Bare `<@Ella>` from Drake in a quiet channel.** Expected: `respond/warm_opener`, friendly short opener posted.

3. **`<@Ella> what does the discovery section cover?`** Expected: `respond_haiku` (KB-answerable factual question), KB-grounded answer posted.

4. **`<@Ella>` with emotional content** ("@Ella I'm really frustrated, where do I actually find this stuff?"). Expected: `acknowledge_and_escalate`, warm ack posted in-channel, DMs to Scott + primary advisor fire.

5. **Non-@-mention message in active conversation** (chitchat without @-mention). Expected: routes through decision Haiku, `skip`. Confirms non-mention path still works.

6. **Non-@-mention emotional content** ("I'm really frustrated lately" without @-mention). Expected: routes through decision Haiku, `acknowledge_and_escalate`. Confirms emotional content handling on the non-mention path still works.

Verify in `/ella/runs` that cases 1-4 have `trigger_metadata.mention_classifier_shape` set and `trigger_metadata.haiku_decision` is null/absent, and cases 5-6 have `trigger_metadata.haiku_decision` set and `mention_classifier_shape` null/absent.

If cases 1-3 still fail to produce a response, STOP — the structural bypass isn't firing. Hand back with the agent_runs row contents.

## What could go wrong

1. **Classifier picks `warm_opener` for substantive questions.** Risk: a real KB question gets a "Hey what's up?" instead of an answer. Acceptable — the user can rephrase. The classifier prompt explicitly distinguishes substantive vs casual, but edge cases will exist.

2. **`is_ella_mentioned` detection fails on some Slack mention shape.** If the regex/detection doesn't catch a mention, the message routes to the decision Haiku and we're back to today's failure mode. Mitigation: existing detection has been working per the diagnostic data (true/false correctly resolved across all tested cases). Risk is low.

3. **Double classifier-and-decision Haiku calls.** If the branch logic is wrong, both could fire. Mitigation: explicit `if/else` in dispatch, plus the new `trigger_metadata` field distinguishes which ran — `/ella/runs` would show the bug immediately.

4. **`respond_sonnet` shape on the mention path conflicts with how the per-minute cron drains.** Today the cron expects `haiku_decision='respond_substantive'`. The mention-path writes the same value to `pending_ella_responses` for compatibility (same shim as v1). Builder verifies this works end-to-end.

5. **Cost increase.** Mention-path runs the classifier (~1 Haiku call) plus the response Haiku (if `respond_haiku` or `warm_opener`). Today's mention-path runs the decision Haiku plus response Haiku. Net: same or +1 small call. Roughly flat cost.

6. **Drake re-tests the same advisor-in-test-channel pattern and the warm opener feels weird.** The classifier will pick `warm_opener` for bare @-mentions from advisors with stale context — that's by design but might feel slightly off. Acceptable; the alternative is the current silence which is worse.

## Mandatory doc updates

- `docs/state.md` — new entry today.
- `docs/agents/ella/ella.md` — substantial update for the structural @-mention path and classifier.
- `docs/runbooks/ella_passive_monitoring.md` — update to reflect the two-path dispatch (mention via classifier, non-mention via decision Haiku).

## Done means

- All file changes pushed to `main`, Vercel deploy successful.
- `pytest tests/` passes at ≥635 tests.
- `ruff check` clean.
- Smoke test cases 1-6 pass in `#ella-test-drakeonly`. Cases 1-3 are the critical regression validation.
- Spec status flipped to `shipped` in same Builder commit-sequence as the report.
- Report at `docs/reports/ella-at-mention-structural-override.md` follows 6-section structure.

Drake's gates:
- (a) None — no migrations.
- (b) Any genuinely context-confusing decision Builder hits — surface immediately.
- (c) Smoke test cases 1-6 — post-deploy.
- (d) None — env vars unchanged.
