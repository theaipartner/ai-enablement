# Ella @-Mention Routing Gate + Assigned Advisor Context

**Slug:** ella-at-mention-routing-gate-and-advisor-context
**Status:** in-flight

## Context

Yesterday's 2026-05-19 EOD production misfire (entry in `docs/state.md`) put Ella's passive monitoring on emergency pause. Three structural gaps were identified in `docs/known-issues.md`. After the chat-side diagnostic this morning, the picture sharpened: **two of the three gaps collapse into one root cause**, and there's a fourth issue that surfaced from re-reading the misfire artifacts.

**The root cause.** Dhamen Hothi (client) posted `<@Scott> <@Lou> Who controls my sub account?...` in C0AFEC456JG at 16:58:14 ET — explicitly @-mentioning Scott and Lou, NOT Ella. His follow-up message 45 seconds later was simply `<@U0AR5684W0Y>` (Nico). Both messages should have been silently ignored by Ella because the client had clearly routed them to specific humans. Instead, all three acks fired through the decision Haiku path (`is_ella_mentioned=false`, `mention_classifier_shape=null` — the @-mention structural override from the prior evening worked correctly; this misfire came through the non-mention decision Haiku).

Two known-issues entries cover this:
- "Decision Haiku has no rule for 'client @-mentioned specific humans → Ella stays silent'" — the prompt's coverage is one vague line under `skip` (*"The message is directed at someone else by name (not Ella)"*) which Haiku failed to apply when the message content also matched `acknowledge_and_escalate` criteria (money/commitments — sub-account question reads as billing-adjacent).
- "No firm-after-first / rate-limit on acknowledge_and_escalate path" — was originally diagnosed as a separate problem (Dhamen's second message firing ack #3), but **the second message was `<@U0AR5684W0Y>` (Nico) — a fresh routing attempt to a third human, not a recurrence of the original escalation.** Firm-after-first wouldn't have suppressed it. The actual fix for both messages is "skip before Haiku" — the rate-limit problem evaporates when the routing-to-humans gate fires.

Drake's call after the chat-side diagnostic: **collapse Problem B and Problem C into one structural gate. Don't replace firm-after-first; remove the messages that would have re-triggered it.** The known-issues entry for firm-after-first becomes resolved-by-removal once this spec ships.

**The fourth issue: Ella named "Nico" in the ack despite Lou being the assigned CSM.** Re-reading the misfire, the in-channel ack text said "Nico will get you squared away." Lou is Dhamen's assigned primary CSM; Nico has no recent presence in C0AFEC456JG. Root cause traced to `agents/ella/passive_monitor.py`: `_fetch_primary_csm` is called every evaluation (returns the row) but the result **is never put into the prompt context**. `_USER_PROMPT_TEMPLATE` has triggering message, speaker, `is_ella_mentioned`, recent context, KB chunks — no `# ASSIGNED ADVISOR` block. Haiku literally does not see who's assigned, and when forced to name a human in freeform ack_text, picks from whoever's salient in its broader prompt — apparently sometimes Nico (one of three coaches named in `# WHO ELLA IS`). This wasn't in the original known-issues entries because it was only spotted today.

**Three changes, one spec.** They cohere because they all address the same misfire root cause from different angles:
1. **Pre-LLM @-mention routing gate** (structural — biggest change). If the triggering message contains any `<@U…>` mention AND none of those mentions is Ella, skip pre-LLM with a digest item written. No Haiku call, no in-channel ack, no DM fan-out.
2. **`pending_digest_items` row on the skip path.** Routed-to-humans messages still surface in Scott's daily digest (category `other`) so awareness isn't lost. Skip kills Ella's in-channel behavior, not Scott's visibility.
3. **Assigned advisor in Haiku's prompt context.** New `# ASSIGNED ADVISOR FOR THIS CLIENT` section in `_USER_PROMPT_TEMPLATE` populated from `_fetch_primary_csm`. Plus one line in the `acknowledge_and_escalate` section of `_HAIKU_SYSTEM_PROMPT` instructing Haiku to use the named advisor.

**Critical scoping decision.** Detection is "any @-mention that isn't Ella" — NOT "any @-mention of a known team_member that isn't Ella." Drake's explicit call to future-proof against new team members not yet in `team_members`, third-party guests, deactivated members whose IDs still appear in old messages, and anyone else. If a client @-mentions anyone other than Ella, Ella stays out. Also cheaper to implement — no DB query at the gate, pure string parsing.

**What this spec does NOT touch:**
- Migration 0042 (passive monitoring default-on). Stays applied. Both kill switches stay where they are (env var `true`, per-channel `false` on 136 rows, `true` on 1 row).
- The @-mention classifier surgery (`agents/ella/mention_classifier.py`). Stays as-is — that was the prior evening's structural fix and works correctly.
- The unified-path refactor (2026-05-18 PM). The single-path architecture stays.
- The daily digest cron (`api/ella_daily_digest_cron.py`). Unchanged.
- Idempotency on the dispatch path (Problem A from yesterday's known-issues). Still real, still needs a separate spec — handled next session, not this one. Independent enough not to bundle.
- Firm-after-first replacement (Problem B). **Resolved-by-removal:** this spec's routing gate kills the message class that would have re-triggered the gate. Drake's explicit decision. The known-issues entry for Problem B gets struck through (`~~text~~`) with a pointer to this spec's resolution.

Production resume after this spec ships is one step closer (Problem A still open), but not unblocked yet. Resume gate is "Problem A also fixed" — separate spec, separate session.

## Acclimatization checklist

Builder reads these first and confirms understanding in 3-4 bullets in the report's "What I did" section. Call out any contradictions with what's actually shipped.

- `CLAUDE.md` § Working Norms § Operational patterns — specifically the "structural fixes beat prompt iteration" working norm landed 2026-05-19 PM.
- `docs/state.md` — current state, especially the 2026-05-19 EOD entry covering the production misfire + emergency kill switch + the four shipped architecture pieces.
- `docs/known-issues.md` — three entries: "Passive dispatch has no idempotency check" (NOT this spec's scope — note for context), "No firm-after-first / rate-limit on acknowledge_and_escalate path" (this spec resolves by removal), "Decision Haiku has no rule for 'client @-mentioned specific humans → Ella stays silent'" (this spec's primary target).
- `agents/ella/passive_monitor.py` — full file. The `_HAIKU_SYSTEM_PROMPT`, `_USER_PROMPT_TEMPLATE`, `_evaluate`, `decide_passive_response`, `_fetch_primary_csm`. The structural-override branch on `payload.is_ella_mentioned` at the top of `_evaluate` is the precedent shape for this spec's pre-LLM gate.
- `agents/ella/mention_classifier.py` — the @-mention classifier from yesterday's evening surgery. Reference pattern: structural fix bypassing the decision Haiku for an enumerated decision the model kept rationalizing through.
- `ingestion/slack/realtime_ingest.py` — where `is_ella_mentioned` is detected upstream. The new "any non-Ella @-mention" detection needs to live HERE so it's plumbed through the same `PassiveTriggerPayload` shape Haiku already reads.
- `agents/ella/passive_dispatch.py` — where `pending_digest_items` rows get written. Need to add a write path for the new `routed_to_humans` skip case (writes digest item + audit row, no in-channel ack, no DM).
- `shared/slack_post.py` — not modified, but Builder should understand the post layer that the routing-gate path now skips.
- `tests/agents/ella/test_passive_monitor.py` — existing tests, especially the gate tests. New tests for the routing gate need to slot in here.
- `tests/ingestion/slack/test_realtime_ingest_passive_fork.py` — existing tests on the fork dispatch. New tests for non-Ella @-mention detection need to slot in here.

## Architecture — overview

### Three-layer change

**Layer 1: Detection (upstream, in `realtime_ingest.py`).** A new helper alongside the existing `is_ella_mentioned` detection. Parses all `<@U…>` user IDs from the triggering message text via regex. Returns a structured result the fork can branch on:

- `mentions: list[str]` — all detected user IDs from the message text.
- `is_ella_mentioned: bool` — true if Ella's bot ID OR human user ID appears in `mentions`. Existing field, repurposed from the existing detection.
- `is_routed_to_others: bool` — true if `mentions` is non-empty AND `is_ella_mentioned` is false.

The three boolean states are mutually exclusive on the routing decision:
- `mentions == []` → existing decision Haiku path (no change).
- `is_ella_mentioned == True` → existing classifier path (no change).
- `is_routed_to_others == True` (and not Ella) → NEW pre-LLM skip path.

**Layer 2: Gate in `passive_monitor.py`.** A new Gate 3 added to `_evaluate` between Gate 2 (author type) and the existing structural @-mention branch. If `payload.is_routed_to_others`, return a `PassiveEvaluation` with a new `skip_reason='routed_to_humans'`, no Haiku call, no recipient resolution.

**Layer 3: Dispatch on the routed-to-humans path.** `passive_dispatch.persist_passive_evaluation` gets a new branch: when `evaluation.skip_reason == 'routed_to_humans'`, write a `pending_digest_items` row with category `other` + a `routed_to_humans=True` flag in metadata (so daily-digest rendering can surface the routing signal if helpful), write an `agent_runs` row for audit, and stop. No in-channel post, no DM, no escalations row.

### The fourth change (assigned advisor in Haiku context)

Independent of the above three but bundled in the same spec because the misfire root cause is the same. Two edits to `passive_monitor.py`:

1. **`_USER_PROMPT_TEMPLATE` gains a new section:**

```
# ASSIGNED ADVISOR FOR THIS CLIENT

{primary_advisor_name}
```

Populated from the existing `_fetch_primary_csm` result. Null-safe: when no assignment exists OR the field doesn't resolve to a human name, render `(no primary advisor assigned)`. Inserted after the `# SPEAKER` section, before `# IS THIS AN @-MENTION OF ELLA?` — gives Haiku the structured fact early in context.

2. **`_HAIKU_SYSTEM_PROMPT` gains one line in the `acknowledge_and_escalate` section:**

After the existing `Do NOT include an @-mention of the advisor — the backend handles notifying.` line, add:

> When naming the advisor in ack_text, use the name from the ASSIGNED ADVISOR FOR THIS CLIENT section above. Do not name a different advisor even if a different advisor's name appears in the recent channel context.

This is a soft prompt rule, but anchored to a structured field rather than free-floating context. If Haiku continues to drift after this lands, the harder structural move is the placeholder-token approach (Haiku writes `{ADVISOR_FIRST_NAME}`, code substitutes pre-post). Defer to a future spec only if this prompt change isn't enough.

### Why pre-LLM and not Haiku-level

Yesterday's working norm landed in CLAUDE.md is explicit: when an LLM keeps rationalizing through an enumerated decision (`skip`/`respond`/`acknowledge_and_escalate`), the fix is to make the wrong outcome structurally impossible at the schema layer. Three prompt iterations on @-mention handling failed last week; the structural classifier surgery fixed it.

Same shape here. The current prompt has one line covering routed-to-humans (*"The message is directed at someone else by name (not Ella)"*). Haiku failed to apply it because the message content also matched `acknowledge_and_escalate` criteria (money/commitments). A stronger prompt rule would be the fourth attempt at the same shape. Pre-LLM detection routes the message away from Haiku entirely — `acknowledge_and_escalate` becomes literally unreachable for routed-to-humans messages because Haiku never sees them.

The assigned-advisor change IS prompt-level — but it's a different kind of fix. Haiku writing ack_text is genuinely a freeform-language problem with no clean schema-level shape. The structural lane here is "give the model a structured field to ground on." If that fails too, the next move is placeholder-token (purely structural). One step at a time.

## What changes — by file

### Modify: `ingestion/slack/realtime_ingest.py`

Find the existing `is_ella_mentioned` detection. It currently uses Ella's bot and human user IDs to scan the message text. Refactor to produce a richer result.

**New helper function** (or extension of the existing one — Builder's call based on what reads cleanly):

```python
def detect_at_mentions(message_text: str, ella_bot_user_id: str, ella_human_user_id: str) -> dict:
    """Parse all <@U…> mentions from message text. Return:
      - mentions: list[str] of all distinct user IDs found
      - is_ella_mentioned: bool — True if Ella's bot or human ID appears
      - is_routed_to_others: bool — True if mentions is non-empty AND is_ella_mentioned is False
    """
    import re
    pattern = re.compile(r"<@(U[A-Z0-9]+)>")
    raw = pattern.findall(message_text or "")
    mentions = list(dict.fromkeys(raw))  # preserve order, dedup
    ella_ids = {ella_bot_user_id, ella_human_user_id} - {None, ""}
    is_ella_mentioned = any(uid in ella_ids for uid in mentions)
    is_routed_to_others = bool(mentions) and not is_ella_mentioned
    return {
        "mentions": mentions,
        "is_ella_mentioned": is_ella_mentioned,
        "is_routed_to_others": is_routed_to_others,
    }
```

**Plumbing:** the existing fork dispatch builds a `PassiveTriggerPayload`. Add `is_routed_to_others: bool` to that dataclass in `passive_monitor.py` (default `False` for back-compat), and pass it through.

**Regex note:** Slack user IDs are `U` followed by uppercase alphanumeric. The pattern `<@(U[A-Z0-9]+)>` matches that. Slack also supports `<@USLACKBOT>` and similar sentinel forms — those will also match (Slackbot user ID is `USLACKBOT`). Treat them the same as any other non-Ella mention (routed-to-others, skip). If the ID format ever changes upstream this regex needs revisiting; flag in the report if any test surfaces a malformed mention shape.

### Modify: `agents/ella/passive_monitor.py`

**Add field to `PassiveTriggerPayload`:**

```python
is_routed_to_others: bool = False
```

**Update `_PASSIVE_DECISIONS` invariant comments** — the new skip path uses the existing `skip` decision value (still in the frozenset). No new enum members.

**Add new Gate 3 in `_evaluate` between Gate 2 (author type) and the structural @-mention branch:**

```python
# Gate 3: routed to humans (NOT Ella). The client (or team_member) @-mentioned
# someone, and Ella isn't in that list. Stay out — they've routed it themselves.
# Pre-LLM skip with an agent_runs row + a pending_digest_items row (written by
# the dispatch layer based on skip_reason='routed_to_humans').
if payload.is_routed_to_others:
    return PassiveEvaluation(
        payload=payload,
        decision=PassiveDecision(
            decision=_SAFER_FALLBACK_DECISION,
            reasoning="routed to humans (non-Ella @-mention detected); pre-LLM skip",
            digest_flag=True,
            digest_category="other",
        ),
        skip_reason="routed_to_humans",
    )
```

**Update `_USER_PROMPT_TEMPLATE`:** add the new section after `# SPEAKER`:

```python
_USER_PROMPT_TEMPLATE = """# TRIGGERING MESSAGE

{message}

# SPEAKER

{speaker_role} ({speaker_name})

# ASSIGNED ADVISOR FOR THIS CLIENT

{primary_advisor_name}

# IS THIS AN @-MENTION OF ELLA?

{is_ella_mentioned}

# RECENT CHANNEL CONTEXT (last 15 turns, oldest first; includes Ella's own posts)

{recent_context}

# TOP KB CHUNKS (retrieved using combined conversation context as query)

{kb_block}

# DECIDE

Return JSON with `decision`, `response_model`, `ack_text`, `digest_flag`, `digest_category`, and `reasoning`."""
```

**Update `decide_passive_response` signature** — add `primary_advisor_name: str = "(no primary advisor assigned)"` kwarg with the documented fallback string. Pass it through to the template via the formatter.

**Update the caller in `_evaluate`** to extract the name from `primary_csm`:

```python
primary_advisor_name = (
    primary_csm.get("full_name") or primary_csm.get("display_name") or "(no primary advisor assigned)"
    if primary_csm else "(no primary advisor assigned)"
)
```

(Builder verifies the actual column name on `team_members` — schema doc is `docs/schema/team_members.md`; the spec assumes `full_name` based on the M5 cleanup work but Builder should confirm.)

**Update `_HAIKU_SYSTEM_PROMPT`** — add the advisor-grounding line in the `acknowledge_and_escalate` section. Find the existing line:

> Do NOT include an @-mention of the advisor — the backend handles notifying.

Add immediately after:

> When naming the advisor in ack_text, use the name from the ASSIGNED ADVISOR FOR THIS CLIENT section above. Do not name a different advisor even if a different advisor's name appears in the recent channel context.

### Modify: `agents/ella/passive_dispatch.py`

**Add a new branch in `persist_passive_evaluation`** for the `routed_to_humans` skip path. The exact function name and shape Builder confirms from reading the file — the pattern is "branch on `evaluation.skip_reason` early; write the agent_runs row + the digest item, no in-channel post, no DM, no escalations row."

The write path for `pending_digest_items`:
- `slack_channel_id`: from payload
- `triggering_message_ts`: from payload (existing unique key — handles Slack-retry dedup at the digest layer)
- `client_id`: from payload
- `digest_category`: `'other'`
- `digest_flag_reason`: store `'routed_to_humans'` in whatever metadata column the existing schema has for this (likely `metadata` jsonb or `reasoning` text — Builder reads the schema doc)
- `triggering_message_text`: from payload
- `triggering_message_author_name`: resolved via the existing speaker resolution

**Agent_runs row:** `trigger_type='passive_monitor'`, `status='success'`, `output_summary='skipped (routed to humans)'`, `trigger_metadata` carries the standard payload fields plus `skip_reason='routed_to_humans'` and `is_routed_to_others=true` so `/ella/runs` can filter on it.

**Existing branches unchanged.** Builder verifies by reading the full file before editing.

### Modify: `lib/db/ella-runs.ts`

Audit dashboard at `/ella/runs` reads `agent_runs.trigger_metadata`. The shape-agnostic adapters (`extractChannelId`, `extractAuthorRole`, `extractAuthorName`) added 2026-05-11 should already handle the new path because we're using the same shape as the existing passive runs. **But the skip-reason filtering — if the dashboard surfaces "skip reasons" anywhere — needs to include `routed_to_humans` as a recognized value.** Builder reads `lib/db/ella-runs.ts` to verify. If the dashboard derives a label from `skip_reason`, add `routed_to_humans` → `"Routed to humans"` (or similar) to the label map.

### Tests

**`tests/ingestion/slack/test_at_mention_detection.py` (NEW):** the new helper function gets dedicated coverage.
- Empty message → mentions=[], is_ella_mentioned=False, is_routed_to_others=False.
- Message with only Ella @-mention (bot ID) → mentions=[ella_bot], is_ella_mentioned=True, is_routed_to_others=False.
- Message with only Ella @-mention (human ID) → mentions=[ella_human], is_ella_mentioned=True, is_routed_to_others=False.
- Message with one non-Ella mention → is_routed_to_others=True.
- Message with multiple non-Ella mentions → all captured, is_routed_to_others=True.
- Message with Ella + others → is_ella_mentioned=True, is_routed_to_others=False (Ella wins; existing classifier path).
- Message with `<@USLACKBOT>` → treated as non-Ella, is_routed_to_others=True.
- Message with malformed `<@xyz>` (lowercase, no leading U) → not matched, ignored.
- Message with duplicate same-ID mentions → deduped in `mentions` list.
- ella_bot_user_id or ella_human_user_id null/empty → no crash, treated as "Ella not configured" (everything routes through is_routed_to_others=True if any mention present — acceptable conservative behavior).

**`tests/agents/ella/test_passive_monitor.py` (EXTEND):**
- New test: payload with `is_routed_to_others=True` → returns PassiveEvaluation with `skip_reason='routed_to_humans'`, no Haiku call (mock asserts complete() not called).
- New test: payload with `is_routed_to_others=True` AND `is_ella_mentioned=True` → Gate 3 doesn't fire (the `is_routed_to_others` field should be False in this case per detection logic, but defensive test confirms Gate 3 only triggers when `is_routed_to_others` is True; if both are True somehow, classifier path takes precedence — Builder confirms the precedence ordering in code matches this test).
- New test: existing decision Haiku flow still works for `is_routed_to_others=False` AND `is_ella_mentioned=False` (the main path).
- New tests for the new `# ASSIGNED ADVISOR` block in user prompt: assert the rendered prompt contains the section with the resolved name when primary_csm is set, and the fallback string when it's None.
- New test: `decide_passive_response` accepts `primary_advisor_name` kwarg and threads it into the prompt.

**`tests/agents/ella/test_passive_dispatch.py` (EXTEND):**
- New test: dispatching a `routed_to_humans` skip writes a `pending_digest_items` row + an `agent_runs` row, does NOT call the Slack post layer (mock asserts `post_message` not called), does NOT write an escalations row.
- New test: existing dispatch branches (skip, respond_haiku, respond_sonnet, acknowledge_and_escalate, classifier paths) unchanged.

**`tests/ingestion/slack/test_realtime_ingest_passive_fork.py` (EXTEND):**
- New test: message with non-Ella @-mention reaches the fork with `is_routed_to_others=True` in the payload.
- New test: existing `is_ella_mentioned=True` and unmentioned paths still pass the correct field shape.

**Total target:** +20 to +25 new tests minimum. Existing 653 passing must stay green. New total ~673-678.

### Documentation updates

- **`docs/state.md`** — new entry for today (2026-05-20) covering the spec. Migration count unchanged (no schema change). Python serverless function count unchanged. Test count updated.
- **`docs/agents/ella/ella.md`** — extend the "@-Mention Handling (Structural)" section to cover the new "routed-to-humans" pre-LLM skip path. Update the Trigger section. Add to changelog.
- **`docs/runbooks/ella_passive_monitoring.md`** — document the new Gate 3 in the gate enumeration. Add a troubleshooting entry for "client message with non-Ella @-mentions was skipped silently — is that right?" (answer: yes, by design as of 2026-05-20).
- **`docs/known-issues.md`** — strike through the firm-after-first entry (`~~text~~`) with a note: "Resolved-by-removal via `ella-at-mention-routing-gate-and-advisor-context` (2026-05-20). The routing gate kills the message class that would have re-triggered the gate; no replacement needed." Strike through the "Decision Haiku has no rule for client @-mentioned specific humans" entry with a similar note. Leave the idempotency entry (Problem A) untouched — separate spec coming.

### Hard stops

1. **Pre-edit verification of `_HAIKU_SYSTEM_PROMPT` line being added to.** Builder reads the current prompt from `agents/ella/passive_monitor.py`, finds the literal line `Do NOT include an @-mention of the advisor — the backend handles notifying.`, confirms it exists verbatim before inserting the new line after it. If the line has drifted, surface to Drake before editing.

2. **Schema verification for `team_members.full_name`.** The spec assumes the column name. Builder runs `SELECT column_name FROM information_schema.columns WHERE table_name='team_members'` against cloud OR reads `docs/schema/team_members.md` to confirm. If the column is named differently (e.g., `display_name`, `name`), use the actual name and note the discrepancy in the report.

3. **Verify `is_routed_to_others` field plumbs end-to-end.** After Builder's first commit landing the detection + the payload field, run a quick assertion that the field arrives at `passive_monitor._evaluate` with the expected value for at least one test case. If it doesn't (typo in field name, plumbing miss), STOP and re-investigate before continuing.

4. **Test suite regression.** `pytest tests/` must pass at ≥653 tests after all edits. If lower, STOP.

5. **`tsc --noEmit` + `next lint` regression.** Must stay clean. The only TS touched is `lib/db/ella-runs.ts` and only conditionally — if no edit is needed, leave it alone.

6. **No migration in this spec.** If Builder finds itself drafting a migration, STOP — the design is explicitly schema-unchanged. The `routed_to_humans` skip reason lives in `agent_runs.trigger_metadata` (jsonb, no schema change), not in a new column. If a schema change feels needed, surface to Drake first.

## Smoke test gate (post-deploy)

Drake's gate (c). Pre-resume validation happens in `#ella-test-drakeonly` exclusively — the 136 production channels stay disabled until Problem A also lands.

Five test cases in `#ella-test-drakeonly`:

1. **Client posts no @-mentions, no Ella interest signal.** Should reach decision Haiku, Haiku decides per existing logic. Verify `/ella/runs` shows the run, `is_routed_to_others=false` in trigger_metadata, normal decision path.

2. **Client posts `<@Ella> what's the discovery section about?`** (or whatever Ella's bot ID renders as in the test channel). Should reach the @-mention classifier path (existing behavior). Verify `/ella/runs` shows `mention_classifier_shape` populated, NOT `routed_to_humans` skip.

3. **Client posts `<@Drake> can you help with the offer framework?`** (or any non-Ella @-mention; Drake's user ID works since Drake's a team_member). Should hit Gate 3, skip pre-LLM, NO in-channel ack. `/ella/runs` shows the run with `skip_reason='routed_to_humans'`, `is_routed_to_others=true`, no Haiku cost. `pending_digest_items` row written.

4. **Client posts `<@Drake> <@Ella> can you both help?`** Should reach the @-mention classifier path (Ella is in the mention list, so `is_ella_mentioned=true` wins). Verify Gate 3 doesn't fire.

5. **Decision Haiku ack_text grounds on assigned advisor.** Post a message that Haiku will likely classify as `acknowledge_and_escalate` (e.g., "I'm really frustrated with the program"). The ack text should name the actual assigned advisor for the test channel, not a random coach. Verify by reading the post in-channel + checking `/ella/runs` shows the rendered prompt contained the `# ASSIGNED ADVISOR` section with the correct name. (Drake notes: the test channel's primary CSM might be Drake himself or whoever's set up for `#ella-test-drakeonly` — the test is "Haiku names that person," not "Haiku names a specific name.")

All five must pass before Builder declares the spec complete and flips to `shipped`. If any fail, Builder writes a PARTIAL report explaining which case failed and what was observed, and the spec stays `in-flight`.

## What could go wrong

1. **Regex false positives on `<@U…>` parsing.** Slack sometimes embeds user references in URL-like contexts or escapes. If a legitimate message includes literal `<@U12345>` as text (e.g., a client pasting Slack markup in a question), the gate fires when it shouldn't. Mitigation: this is an edge case — the cost is "Ella stays silent on a message that wanted her" which is recoverable (client can rephrase). The opposite cost (Ella speaks when she shouldn't) is worse. Accept the false-positive risk for the safer side.

2. **Detection misses an exotic mention format.** Slack has evolved its mention formats over time; some old or unusual forms (like channel-wide `<!here>`, `<!channel>`, `<!subteam^XXX>`) won't match the `<@U…>` regex. Mitigation: these aren't user @-mentions per se — they're channel/group notifications. Not in scope for "routed to humans." If a client says `<!here>` they're not routing to a specific human; Ella's existing skip-on-uncertainty default is fine.

3. **Ella's bot ID or human user ID changes (e.g., Slack app reinstall).** The detection helper relies on the configured IDs being current. If they drift, `is_ella_mentioned` returns false on legitimate Ella @-mentions, which routes them to Gate 3 (routed-to-humans skip) — Ella stays silent when she shouldn't. Mitigation: existing env vars and bot identity resolution (`shared/slack_identity.py`) handle this; the new helper reads from the same source. If the bot identity drifts, the existing @-mention classifier path also breaks, so this isn't a new fragility — same fragility.

4. **`primary_csm` lookup returns the wrong person.** `_fetch_primary_csm` queries `client_team_assignments` for `role='primary_csm' AND unassigned_at IS NULL`. If a client has multiple active primary_csm rows (data hygiene bug), the first row wins. Mitigation: that's a data issue, not this spec's problem. Builder logs a warning if `_fetch_primary_csm` returns more than one row (defensive). The spec ships with the existing single-row assumption.

5. **`full_name` field is null on a team_member.** Defensive fallback in the formatter renders `(no primary advisor assigned)`. Haiku then has no name to anchor on and falls back to whatever the prompt's existing guidance says. Same-or-better than today's behavior.

6. **The prompt rule "use the name from ASSIGNED ADVISOR" doesn't stick.** Haiku continues to occasionally name the wrong advisor anyway. Mitigation: if smoke test case 5 fails, escalate to the placeholder-token approach (future spec). Don't iterate on the prompt within this spec — that's the failure mode the structural-fix working norm explicitly warns against.

7. **Gate ordering matters.** Gate 3 must run BEFORE the structural @-mention branch (which fires on `is_ella_mentioned=true`). The detection helper ensures `is_routed_to_others=False` when `is_ella_mentioned=True`, so in practice the two are mutually exclusive — but Builder must place Gate 3 in code such that the precedence is unambiguous. Recommended: Gate 3 sits between Gate 2 (author type) and the existing `if payload.is_ella_mentioned:` branch. Verify with a defensive test (case 4 from the smoke gate).

8. **`pending_digest_items` schema constraints.** The table has a unique index on `(slack_channel_id, triggering_message_ts)`. If Slack delivers the same message twice (Problem A territory), the second write hits the unique-key collision. Mitigation: catch the IntegrityError on the second write and treat it as a successful no-op — the digest item from the first write is sufficient. This is partial coverage of Problem A on the digest layer; full coverage at the ack/DM dispatch layer is the separate Problem A spec.

## Mandatory doc updates

- `docs/state.md` (today's entry, 2026-05-20)
- `docs/agents/ella/ella.md` (@-Mention Handling Structural section extension + changelog)
- `docs/runbooks/ella_passive_monitoring.md` (Gate 3 documentation + troubleshooting entry)
- `docs/known-issues.md` (strike-through Problem B + Problem C entries with resolution pointer)

## Done means

- All file edits pushed to `main` per the one-logical-change-per-commit rule (suggested split: commit 1 = detection helper + payload field + plumbing; commit 2 = Gate 3 + dispatch branch; commit 3 = assigned advisor prompt + template; commit 4 = tests; commit 5 = docs). Builder's call on the exact split as long as each commit is one logical change.
- `pytest tests/` passes at ≥653 tests (target: ~673-678 after new tests added). No regression.
- `tsc --noEmit` + `next lint` clean.
- Five smoke test cases in `#ella-test-drakeonly` all pass per the gate (c) section.
- Spec status flipped to `shipped` in same Builder commit-sequence as the report.
- Report at `docs/reports/ella-at-mention-routing-gate-and-advisor-context.md` follows 6-section structure.

Drake's gates:
- (a) None — no migrations, no irreversible actions.
- (b) Any genuinely context-confusing decision Builder hits — surface immediately. Specifically: if the regex needs to handle a mention shape not enumerated above, surface before coding.
- (c) Five smoke test cases in `#ella-test-drakeonly` — Drake runs each, confirms outcomes match the spec's expected behavior. Spec stays `in-flight` until Drake signals all five passed.
- (d) None — no env var changes, no credential touches.
