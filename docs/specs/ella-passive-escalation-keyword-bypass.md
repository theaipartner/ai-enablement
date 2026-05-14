# Add escalation-keyword bypass to Ella passive monitoring Gate 4

**Slug:** ella-passive-escalation-keyword-bypass
**Status:** in-flight

## Context

The passive-monitoring pipeline in `agents/ella/passive_monitor.py` runs six gates in order before Haiku is called. Gate 4 (KB relevance) is the failure mode we're fixing: it skips any message whose top KB chunk similarity falls below `ELLA_PASSIVE_KB_RELEVANCE_THRESHOLD` (default 0.30). The intent was to avoid wasting Haiku tokens on context-thin messages. The unintended effect is that escalation-worthy messages with no curriculum anchor — cancellation intent, refund demands, frustration, crisis content — get silently dropped before Haiku can ever evaluate them.

Real production gap surfaced 2026-05-14 during the post-deploy smoke test of the unified escalation routing. Three test messages tripped Gate 4 with similarities 0.22, 0.23, 0.28:

- "I'm really frustrated, I want to talk about canceling my account"
- "hey ella this sad company of clankers to shove it and give me my god damn money back"
- "I want my money back"

All three are exactly what passive escalation is supposed to catch. Haiku never saw any of them.

The fix is a cheap pre-gate keyword bypass: scan the message for high-signal escalation keywords before Gate 4. If hit, **skip Gate 4 and let Haiku decide**. Haiku still gets to override (it can return `skip` if context overrides the keyword signal); we just stop dropping the message at a gate that wasn't designed for escalation detection.

This is **not** auto-escalation by keyword. The keyword list only bypasses the relevance gate. The actual escalate/skip/respond decision still belongs to Haiku.

## Files Builder reads first (acclimatization)

Read these in order, then confirm in 4-5 bullets:

1. `agents/ella/passive_monitor.py` — the full file. Look specifically at `_evaluate` (the gate sequence), `_kb_search` (Gate 4's vector call), the relevance-threshold logic, and the `_HAIKU_SYSTEM_PROMPT` (you don't edit the prompt in this spec, but you need to confirm Haiku's escalate criteria match the keyword list you're building).
2. `tests/agents/ella/test_passive_monitor.py` — the existing gate tests. The new gate's tests should match this pattern.
3. `docs/agents/ella/ella.md` § Passive monitoring / Gate 4 — update for the new bypass.
4. `docs/runbooks/ella_passive_monitoring.md` — update if it documents the gate sequence.

## Decisions baked in (do NOT re-litigate)

- **Keyword bypass affects ONLY Gate 4.** Gates 1 (kill switch), 2 (author-type), 3 (CSM-directed), and 5 (firm-after-first) still run. A kill-switch-off channel doesn't suddenly fire Haiku because of a keyword hit. A team_member message in a non-test_mode channel still skips at Gate 2 regardless of keywords.
- **Keyword matching is case-insensitive, simple substring/word-boundary, not regex-heavy.** A linear scan over a short list of keywords is the right level of investment. Real escalation detection still happens at Haiku — the keyword list is just the "let Haiku look at this one" trigger.
- **No auto-escalation by keyword.** Even if "cancel" appears, the flow still goes to Haiku. Haiku decides. Keyword presence biases the pipeline toward "let the model decide," nothing more.
- **The keyword list is in code, not a config table.** Single Python frozenset constant in `passive_monitor.py`. If iteration becomes painful later, that's a follow-up to move it to a config row or env var.
- **Crisis keywords (self-harm) are included in the list.** Same bypass mechanism, no special crisis-handling path. Haiku's escalate criteria already cover "emotional or crisis content," and the reactive path's prompt directs Ella to surface 988 when appropriate (already observed working in production 2026-05-14). Crisis content getting *to* Haiku is the gap; once there, the existing prompt handles it.
- **Logging the bypass.** When the keyword bypass fires, the `agent_runs.trigger_metadata` carries `kb_relevance_bypass_keyword=<matched_word>` so the audit dashboard surfaces which keyword triggered. Cheap, makes debugging trivial.
- **Gate naming cleanup is deferred.** The misleading `trigger_metadata.haiku_decision` field name (populated even when Haiku didn't run) is a separate cleanup, not in this spec's scope.

## Implementation plan

### 1. Add the keyword list constant

In `agents/ella/passive_monitor.py`, near the top with the other module constants (alongside `_STOP_WORDS`), add:

```python
# Escalation-keyword bypass list. Messages containing any of these
# tokens skip Gate 4 (KB relevance) and proceed directly to Haiku.
# This protects against the failure mode where escalation-worthy
# content has no curriculum anchor and gets dropped at the relevance
# gate. Haiku still makes the final decision; keyword presence only
# decides whether Haiku gets to look.
#
# Match is case-insensitive, word-boundary (whole word or phrase).
# Multi-word phrases match as substrings within the message text.
#
# Categories mirror Haiku's auto-escalate fence in _HAIKU_SYSTEM_PROMPT:
#   - Money / commitment (cancel, refund, money back, charge, billing, contract, ...)
#   - Complaints / dissatisfaction (frustrated, angry, disappointed, complaint, ...)
#   - Crisis / self-harm (kill myself, end my life, suicide, hurt myself, ...)
#   - Quitting / leaving (quit, leaving, done with, stop coming, ...)
#   - Legal threats (lawyer, lawsuit, sue, legal action, ...)
_ESCALATION_BYPASS_KEYWORDS = frozenset({
    # Money / commitment
    "cancel", "cancelling", "canceling", "refund", "refunded",
    "money back", "my money", "chargeback", "dispute", "billing",
    "charge", "charged", "contract", "agreement",

    # Complaints / dissatisfaction
    "frustrated", "frustrating", "angry", "pissed", "disappointed",
    "complaint", "complain", "unhappy", "fed up",

    # Crisis / self-harm
    "kill myself", "end my life", "suicide", "suicidal",
    "hurt myself", "harm myself", "want to die", "end it all",

    # Quitting / leaving
    "quit", "quitting", "leaving", "done with this", "done with you",
    "stop coming", "wasted my time",

    # Legal
    "lawyer", "lawsuit", "sue you", "legal action", "attorney",
})
```

Builder calibrates the final keyword list with judgment — the above is the starter set, not a fixed prescription. Two principles:
- **Include common phrasings.** "Money back" and "my money" are different surface forms; both belong.
- **Don't include weak signals.** "Help," "confused," "stuck" are not escalation keywords — they're normal client questions that Gate 4 should still gate on.

### 2. Add the bypass check helper

```python
def _has_escalation_bypass_keyword(message_text: str) -> str | None:
    """Returns the matched keyword if the message contains any escalation
    bypass keyword, None otherwise. Case-insensitive substring match.

    Returns the keyword (not just a boolean) so the caller can log
    which trigger fired for audit purposes.
    """
    if not message_text:
        return None
    text_lower = message_text.lower()
    for keyword in _ESCALATION_BYPASS_KEYWORDS:
        if keyword in text_lower:
            return keyword
    return None
```

Builder's call on whether to use word-boundary regex vs substring. My lean: **substring match is fine**. False-positive risk ("cancellation policy" matches "cancel") is acceptable because Haiku is the final arbiter, and the cost of an extra Haiku call is trivial.

### 3. Wire the bypass into `_evaluate`

In the Gate 4 block in `_evaluate`, change from:

```python
# Gate 4: KB-relevance gate. Cheap vector search; if nothing comes
# back above threshold we skip the Haiku call.
threshold = _kb_relevance_threshold()
kb_chunks = _kb_search(
    payload.triggering_message_text, payload.channel_client_id
)
relevant_chunks = [c for c in kb_chunks if c.similarity >= threshold]
if not relevant_chunks:
    return PassiveEvaluation(...)
```

To:

```python
# Gate 4: KB-relevance gate. Cheap vector search; if nothing comes
# back above threshold we skip the Haiku call — UNLESS the message
# contains an escalation bypass keyword, in which case we let Haiku
# decide even on context-thin messages.
threshold = _kb_relevance_threshold()
kb_chunks = _kb_search(
    payload.triggering_message_text, payload.channel_client_id
)
relevant_chunks = [c for c in kb_chunks if c.similarity >= threshold]

bypass_keyword = _has_escalation_bypass_keyword(
    payload.triggering_message_text
)

if not relevant_chunks and bypass_keyword is None:
    # No KB anchor AND no escalation keyword — drop at Gate 4 as before.
    return PassiveEvaluation(...)  # existing skip path
```

The Gate 5 firm-after-first check then runs as today, then Haiku is called with whatever `relevant_chunks` we have (possibly empty list — the `_render_kb_block` helper already handles the empty case gracefully and renders `(none)`).

### 4. Surface the bypass in `trigger_metadata`

The bypass keyword (when set) needs to flow through to `passive_dispatch.py:persist_passive_evaluation` so it lands in `agent_runs.trigger_metadata`. Two cleanest options:

**Option A** — add `bypass_keyword: str | None = None` to `PassiveEvaluation`. The persistence layer reads it and writes `trigger_metadata.kb_relevance_bypass_keyword=<value>` when non-None.

**Option B** — add it to `PassiveDecision.reasoning` as a prefix when the bypass fires (e.g., "bypass_keyword=cancel; <Haiku's reasoning>"). Less structured; harder to query.

Builder's call. My lean is **A** — explicit field, structured audit data, easier to query later.

### 5. Tests

In `tests/agents/ella/test_passive_monitor.py`, add a new test class for the bypass behavior. Mirror the existing gate test patterns. Cover:

- **Bypass + no KB chunks** — message contains "cancel," KB returns nothing, Haiku gets called. Mock Haiku to return `escalate`; assert decision flows through.
- **Bypass + KB chunks present** — message contains "refund" AND KB returns relevant chunks. Bypass doesn't change behavior here; Haiku gets called as it would have anyway. Assert `bypass_keyword` is still set in the result for audit purposes.
- **No bypass + no KB chunks** — control case; existing Gate 4 skip behavior preserved.
- **Keyword case-insensitivity** — "CANCEL" and "Cancel" and "cancel" all match.
- **Multi-word keyword** — "money back" matches when it appears as a phrase.
- **Each keyword category at least once** — sample one keyword from each of the five categories (money, complaints, crisis, quitting, legal) and assert it triggers bypass.
- **No bypass keyword in message** — message like "what's the offer ladder lesson" with no escalation keywords passes through Gate 4 normally.

Builder's existing test fixtures should make this straightforward. If new fixtures are needed, keep them tight and named for the case they exercise.

### 6. Doc updates

- `docs/agents/ella/ella.md` § Passive monitoring or wherever the gate sequence is described — add the bypass to Gate 4's description. One paragraph at most.
- `docs/runbooks/ella_passive_monitoring.md` — if it has a "Why didn't Ella respond?" troubleshooting section, add the bypass to the explanation of Gate 4. If there's a SQL query for "show me messages that hit the bypass," include it: `SELECT id, output_summary, trigger_metadata->>'kb_relevance_bypass_keyword' FROM agent_runs WHERE agent_name='ella' AND trigger_type='passive_monitor' AND trigger_metadata ? 'kb_relevance_bypass_keyword' ORDER BY started_at DESC LIMIT 20;`
- `docs/state.md` — new entry describing what shipped. Mention the keyword list, the bypass behavior, the audit field, and the test count.

## What success looks like

1. **Re-running the failed test messages now reaches Haiku.** Posting "I want my money back" in `#ella-test-drakeonly` results in an `agent_runs` row with `haiku_decision` actually populated by a Haiku call (not the synthetic gate-skip text), and Haiku very likely returns `escalate`. DMs fire as expected.
2. **`agent_runs.trigger_metadata.kb_relevance_bypass_keyword`** is set on the run for the keyword that triggered the bypass.
3. **Messages with no escalation keywords AND no KB anchor still skip at Gate 4.** Control case: "what's the offer ladder lesson" with no curriculum match should still skip the same way.
4. **Test suite passes.** `pytest tests/` green.
5. **Existing production passive escalations continue to work.** The 7 production passive-monitored channels should see no behavior regression for messages that did escalate yesterday.

## Hard stops

- **Don't lower `ELLA_PASSIVE_KB_RELEVANCE_THRESHOLD` as part of this spec.** Bypass is the right lever; the threshold stays at 0.30 for non-keyword messages.
- **Don't add auto-escalation logic to the bypass.** Bypass routes to Haiku. Haiku decides. If you find yourself writing `if bypass_keyword: return escalate`, stop.
- **Don't move the keyword list to a config table or env var in this spec.** Single Python constant; iterate from there if needed.
- **Don't touch Haiku's prompt.** Haiku's escalate criteria already cover everything in the keyword list. Editing the prompt is a separate spec if needed.

## What could go wrong

- **The keyword list is too broad and bypass fires on benign messages.** Real cost: extra Haiku calls (~$0.001 each). Haiku correctly says "skip" on the benign ones. Mitigation: start with the conservative list above; tune from production data.
- **The keyword list is too narrow and misses real escalations.** Same failure mode as today, just with a smaller surface. Iterate by adding to the list when you see a missed case.
- **A false positive on a "respond_substantive" case.** Example: "I want to cancel my next call." That's a legitimate scheduling-adjacent message, not a financial-cancellation. Haiku is the override; the prompt should already handle this correctly because the auto-escalate fence talks about "cancellations" in the contract sense, not the scheduling sense. If Haiku gets this wrong in production, the fix is at the prompt level, not the keyword list.
- **The `PassiveEvaluation` dataclass change ripples to callers.** It's a frozen dataclass; adding a new field with a default value is backward-compatible. Verify no caller treats it as positional.

## Mandatory doc-update list

- `agents/ella/passive_monitor.py` — keyword constant, helper function, Gate 4 wired with bypass.
- `agents/ella/passive_dispatch.py` — `trigger_metadata.kb_relevance_bypass_keyword` field plumbed through (if Option A from § 4).
- `tests/agents/ella/test_passive_monitor.py` — new test cases.
- `docs/agents/ella/ella.md` — Gate 4 description updated.
- `docs/runbooks/ella_passive_monitoring.md` — troubleshooting section updated.
- `docs/state.md` — new entry.

## Commit shape

One feature commit ("feat: add escalation-keyword bypass to Ella passive Gate 4") + one docs commit + report commit. Push at end.
