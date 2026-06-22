# Report: Ella @-mention path archaeology — recover the proven pre-classifier behavior (read-only)
**Slug:** ella-at-mention-archaeology
**Spec:** docs/specs/ella-at-mention-archaeology.md

## Files touched

Created:
- `docs/reports/ella-at-mention-archaeology.md` — this report.

Modified:
- `docs/specs/ella-at-mention-archaeology.md` — `Status:` flipped from `in-flight` to `shipped`.

No code changes. Old code read via `git show <sha>:<path>` into `/tmp/old_*.py` for grep convenience; nothing materialized into the working tree.

## What I did, in plain English

Walked the git history of `agents/ella/agent.py`, `agents/ella/prompts.py`, `api/slack_events.py` from today back through the 2026-05-18/19 churn to find and read the last commit where the reactive @-mention path was intact as a dedicated reactive handler. The recovery target turned out to be a stable era spanning **2026-05-14 (`0c3d88a`) through 2026-05-18 17:52 EDT (`23a9867`)** — the @ path was effectively unchanged across that window. The first collapse commit `0347f51` landed at 14:23 EDT on 2026-05-18 and the recovery target is the state of those files at `0347f51^`.

The old path's design is **fundamentally different from today's** in a single load-bearing way: **the respond-vs-escalate decision was made by Sonnet inline, AFTER retrieval, with the retrieved chunks visible to the deciding model.** The new classifier (2026-05-19 `1fd5994`) decides BEFORE retrieval matters, using prescriptive Haiku-rules over an enumerated outcome set that includes a "navigation" trigger. That structural difference — retrieve-then-decide vs decide-then-maybe-retrieve, single-Sonnet-inline-judgment vs enumerated-Haiku-classifier — is what made the old path answer curriculum-content questions the new path now escalates.

Concretely: the old prompt's escalation rules were four narrow categories (judgment-call / emotional / money / no-good-context). It had **NO "navigation" rule**. Curriculum content questions including "what a module covers" were explicitly listed under WHAT YOU CAN HELP WITH and were answerable. The new classifier prompt's `acknowledge_and_escalate` rule includes "platform navigation ('where do I find X' / 'what module is Y in')" — that's the rule that fires today on "what's covered in module 3" and routes the question to Scott instead of answering it.

The old plumbing (`[ESCALATE]` token + `_detect_and_strip_escalation` regex split, `_should_dual_trigger` / `_build_app_mention_from_message` reshape, thread-vs-channel-only choice) is mostly leave-behind: the current `escalation_routing.fire_escalation_dms`, current `escalation.escalate`, current `shared.slack_post.post_message`, and the current dedup gate (post-2026-05-20 `webhook_deliveries.webhook_id` PK) are all the right modern replacements. The lift-forward is the prompt logic, the retrieve-then-decide order, and the dedicated reactive dispatch lane.

## Verification

**Boundary commit SHAs + dates** (confirmed via `git show --pretty="%h %ai %s%n%n%b" --no-patch`):

| Phase | Commit | UTC | Message |
|-------|--------|-----|---------|
| **Last stable good-era touch** on @ path code | `0c3d88a` | 2026-05-14 | `feat(ella): reactive escalation fan-out + drop in-channel mention` |
| Recovery target = file state at `0347f51^` | `d80b89c` (parent) | 2026-05-18 ~18:23 (pre-AM-collapse) | `feat: add pending_digest_items table + schema doc` (does NOT touch @ code; @-path files were stable from 0c3d88a) |
| Spec for collapse phase 1 | `23a9867` | 2026-05-18 17:52 EDT (21:52 UTC) | `spec: ella architecture refactor + daily digest` |
| **Collapse phase 1 — reactive joins decision Haiku** | `0347f51` | 2026-05-18 14:23 EDT (18:23 UTC) | `refactor: unified-decision Ella passive + reactive pipeline` |
| Spec for collapse phase 2 | `5f05b5c` | 2026-05-18 16:33 EDT (20:33 UTC) | `spec: ella unified-path intelligence refactor` |
| **Collapse phase 2 — `app_mention` becomes no-op** | `a811240` | 2026-05-18 17:06 EDT (21:06 UTC) | `refactor: collapse Ella to one unified-path pipeline` |
| **Classifier introduction (the confirmed regression)** | `1fd5994` | 2026-05-19 | `fix(ella): @-mention structural override — bypass decision Haiku for mentions` |

Note: the spec's "AM" / "PM" labels for the two 2026-05-18 collapses are inverted relative to the actual commit clock — `0347f51` (the first step) landed at 14:23 EDT (afternoon, but earlier than `a811240` at 17:06 EDT). Both landed the same day; the sequencing the spec described (phase 1 before phase 2) is correct, just both in PM EDT. Doesn't affect the recovery target; flagging for the split spec's reference.

**Plain-English reconstruction of the OLD reactive @ path** (read from `git show 0347f51^:` for each file):

1. **Slack-side detection (`api/slack_events.py`):** Two dispatch paths converged on `_process_mention(payload)`:
   - Native `app_mention` events fired by Slack when Ella's bot user is @-mentioned.
   - `message` events that contain `<@<human_ella_user_id>>` — these went through `_should_dual_trigger(event)` which checked the text for the human user_id, ruled out bot-token mentions (those fire `app_mention` separately), excluded Ella's own posts, then reshaped via `_build_app_mention_from_message(payload)` (flipped `event.type` to `app_mention`) and re-dispatched.
   - `_process_mention` called `handle_slack_event(payload)` which routed to `agents.ella.agent.respond_to_mention(event_data)`.
   - The returned `EllaResponse.response_text` was posted to the MAIN CHANNEL (not thread) via `_post_to_slack(channel, text)` — user token first (clean APP-tag-free render), bot token as fallback.

2. **Agent dispatch (`agents/ella/agent.py:respond_to_mention`):**
   - Resolved real speaker identity via `agents.ella.identity.resolve_speaker_identity(user_id)` — distinct from channel-mapped client (separate retrieval scope vs speaker addressing).
   - **Bare-mention short circuit:** if `len(stripped_text) < 5`, called `_handle_bare_mention` which picked a random canned warm opener (4 with-name variants, 4 no-name variants) and returned without an LLM call. Logged as `trigger_type='bare_mention'`. Reason: V1 had crashed on empty user messages (`messages.0: user messages must have non-empty content`).
   - Otherwise started `agent_runs` with `trigger_type='slack_mention'` and called `_run(event_data, speaker, run_id)`.

3. **`_run(...)` — the substantive handler:**
   - Resolved `channel_client` via `_resolve_channel_client(channel_id)` (active `slack_channels` row → `clients` join).
   - **Called `_retrieve_context(client_id, query_text)` → `retrieve_context_for_client(...)` — the SAME retrieval entry point still in use today.** Returned `ContextBundle(chunks, client, primary_csm)`.
   - Fetched last-15-turn channel context via `_fetch_recent_context_for_event(event_data)` → `fetch_recent_channel_context(channel, before_ts=trigger_ts)` — also unchanged today.
   - Built the full system prompt via `build_system_prompt(client_for_prompt, context.chunks, speaker=speaker, recent_channel_context=...)`.
   - **Called Claude exactly once via `_call_claude(system_prompt, query_text, context, run_id=...)` — single Sonnet call (`shared.claude_client.complete` with `DEFAULT_MODEL='claude-sonnet-4-6'`).** The model produced one response. There was no separate classifier step.
   - **Detected `[ESCALATE]` token via `_detect_and_strip_escalation(response_text)` → `(client_text, handoff_context)`.** If marker present, `client_text` was everything before it (the warm ack the client sees); `handoff_context` was everything after (the advisor-facing handoff paragraph the model wrote, persisted to `escalations.context.handoff_reasoning`). If marker absent, the whole response was the client-facing answer.
   - On escalation: wrote `escalations` row via `escalate(reason="ella_escalated", context={...handoff_reasoning..., client_id, speaker, event})`, then fired DM fan-out via `fire_escalation_dms(recipients, slack_channel_id, triggering_message_ts, reasoning=handoff_context, path="reactive", channel_client_id=...)`. Ended run as `status='escalated'`. Posted `client_text` in-channel as the ack.
   - On success: posted `response_text` in-channel, ended run as `status='success'`.

4. **The respond-vs-escalate prompt (verbatim from `agents/ella/prompts.py:_BASE_PROMPT` at `0347f51^`):**

   The relevant sections, quoted exactly:

   > **WHAT YOU CAN HELP WITH**
   >
   > Answer questions in these domains using the knowledge base context the system gives you:
   >
   > - Curriculum content — lessons, frameworks, exercises, what a module covers, where to find something in the course.
   > - Process and methodology — how the agency teaches clients to think about offers, sales, delivery, AI-native operations.
   > - Onboarding logistics — what to expect, where to find things, how the program is structured.
   > - Recap of the client's own past calls — when the client asks what they discussed, what was decided, what action items came out of a call. Only the client's own calls; never another client's.
   >
   > If you have solid context for the answer, give it directly. Cite the source when it helps — name the lesson title or the call date — but don't dump raw quotes unless the client explicitly asks. Paraphrase tightly.
   >
   > If the context is thin or ambiguous, say what you can confidently say, then loop in your advisor for the rest. Don't pad an answer to look complete.

   > **WHAT YOU ESCALATE**
   >
   > You escalate — meaning you respond with a short ack and route the question to the client's advisor — when:
   >
   > - The client is asking for a personal judgment call about their specific business situation (which offer to launch, whether to fire a client, how to price). Surface the relevant frameworks if you have them, but the call is the advisor's.
   > - The client seems frustrated, stuck, or upset. Don't try to defuse it yourself. Get their advisor looped in.
   > - The client is asking about billing, refunds, contracts, account changes, or anything money- or commitment-related.
   > - The client is asking something where you don't have good context and a wrong answer would matter.
   >
   > When you escalate, write a short warm ack first (this is what the client sees), then on its own line at the END of your response include the literal token [ESCALATE] followed by a one-paragraph handoff note for the advisor. The handoff note explains the question and any context you have. The backend strips everything from [ESCALATE] to the end before posting to Slack — the client sees only the ack; the advisor reads the handoff note via the escalations record. The client never sees the token or the handoff note.

   Note also the **FIRM AFTER FIRST** rule (still in `_BASE_PROMPT` at `0347f51^`): if the recent channel context shows a prior escalation on the same topic, do NOT re-engage substantively — route harder instead, "worth picking this up with <@advisor_id> directly". This was the old path's loop-prevention; with the current classifier path, this rule never gets read because the response model is bypassed when the classifier escalates.

**The concrete behavioral difference that explains "she used to answer these":**

The old prompt explicitly listed *"what a module covers"* under WHAT YOU CAN HELP WITH — curriculum content is the FIRST listed domain. The escalation rule had four narrow categories and **NO "navigation" trigger.** Sonnet read the chunks (e.g. 8 active sales course_lesson chunks for "what's covered in the sales module"), saw they covered the question, and answered. The structural order was:

  `@-mention → retrieve → Sonnet ONE call (chunks visible) → model emits answer OR ack + [ESCALATE] inline → router strips token + dispatches`

The new path inverts this:

  `@-mention → Haiku classifier ONE call (chunks technically passed but rules-driven decision dominates) → enum pick {respond_haiku, respond_sonnet, acknowledge_and_escalate, warm_opener} → if escalate, classifier writes ack_text + escalates; if respond, hand to response Haiku/Sonnet`

The classifier's prompt at `agents/ella/mention_classifier.py:60-101` enumerates triggers prescriptively. The `acknowledge_and_escalate` trigger explicitly says (paraphrased): "platform navigation ('where do I find X' / 'what module is Y in') — the KB has lesson content but not navigation metadata, the advisor handles those." Haiku reads "what's covered in module 3" → matches the literal pattern "module is Y in" closely enough → picks `acknowledge_and_escalate`. The retrieved chunks are visible to the classifier but the rule's pattern-match wins over the chunks' obvious relevance because Haiku is asked to pick from an enum, not to reason about whether the chunks answer the question.

**Faithful-vs-modernized recoverability map** (the heart of what the split spec needs):

**LIFT FORWARD (pure behavior; restore as-is into the new dedicated @ handler):**

- The **§ WHAT YOU CAN HELP WITH** prompt section — including the verbatim "what a module covers" answerability claim. This is largely already in `_BASE_PROMPT` at `agents/ella/prompts.py:65-78` today (the file wasn't gutted; the unified-decision refactor used `_BASE_PROMPT` as a trimmed source for `digest_response.py:_RESPONSE_SYSTEM_PROMPT` but kept `_BASE_PROMPT` itself intact). The restoration just needs to route @-mentions back to `build_system_prompt` instead of through the classifier.
- The **§ WHAT YOU ESCALATE** four-category logic (judgment-call / emotional / money / no-good-context). Reproduce verbatim; do NOT add a "navigation" category.
- The **§ FIRM AFTER FIRST** loop-prevention rule. Useful re-engagement-throttling that depends on the model SEEING the recent context, which only happens on the single-Sonnet-inline-judgment path.
- The **retrieve-then-decide ORDER.** Always retrieve before invoking the deciding LLM; pass chunks to the deciding LLM; let the deciding LLM use chunks as the answerability signal.
- **One Sonnet call** as the decision-and-response combined. Sonnet (not Haiku) was the proven model; Haiku is faster/cheaper but the structural-fix-beats-prompt-iteration discipline (CLAUDE.md § Operational patterns) argues for not re-introducing the Haiku-enum classifier even with softer rules.
- **Bare-mention short circuit** (< 5 chars → canned warm opener, no LLM, `trigger_type='bare_mention'`). Cheap, prevents the empty-user-message API error, still useful.
- **`trigger_type='slack_mention'` for substantive @-mentions** — the dashboard's `/ella/runs` `RESPONSE_TRIGGER_TYPES` set already includes `slack_mention`, so restoring this trigger type makes new @ runs visible on the dashboard (working around the pending dashboard-filter fix).

**LEAVE BEHIND (old plumbing; current equivalents are cleaner):**

- `[ESCALATE]` token + `_detect_and_strip_escalation` regex split. Fragile (the 2026-05-14 fix had to loosen detection because Sonnet occasionally leaked the token mid-prose). Modern replacement options under "open forks" below.
- `_should_dual_trigger` + `_build_app_mention_from_message` reshape. The original purpose — catching user-token @-mentions that Slack delivers as `message` events when bot-token mentions also fire `app_mention` — was a workaround for the two-parallel-events problem. Today's `webhook_deliveries.webhook_id` PK dedup gate (post-2026-05-20) and the `is_ella_mentioned` flag already computed in passive_monitor's payload (`agents/ella/payload.py` / similar) handle this better. The split spec just needs ONE entry point that reads `is_ella_mentioned=true` and dispatches to the new @ handler.
- `app_mention` webhook as a separate source of truth. Currently `app_mention` is a no-op (per 2026-05-18 PM collapse commit `a811240`). The split spec should restore @-mention as a first-class dispatch lane but route via the existing `message`-event ingest path that's already wired and deduped, NOT by re-enabling `app_mention` as a parallel source.
- Posting via raw `_post_to_slack(channel, text)` in `api/slack_events.py`. Current `shared.slack_post.post_message(channel_id, text, *, thread_ts=None, blocks=None)` is cleaner, returns the posted ts (per the 2026-05-19 commit `76282e6`), and handles user-token/bot-token fallback identically.
- The `EllaResponse` dataclass with `escalated`/`escalation_id`/`escalation_reason` fields returned to the Slack handler. The current dispatch layer (`passive_dispatch.py`) uses dict-returns for the same telemetry; either shape works but `EllaResponse` doesn't earn its keep over the dict.

**MAPS ONTO CURRENT WIRING (no change needed; just call them from the restored @ handler):**

- Retrieval: `agents.ella.retrieval.retrieve_context_for_client(client_id, query, k=8, include_global=True)` — identical contract to old. The `ContextBundle` it returns (chunks + client + primary_csm) is the same shape.
- Recent context: `agents.ella.retrieval.fetch_recent_channel_context(channel, before_ts=trigger_ts)` — identical. Already used by both old and current paths.
- System prompt assembly: `agents.ella.prompts.build_system_prompt(client_for_prompt, chunks, speaker=speaker, recent_channel_context=...)` — current, signature unchanged, `_BASE_PROMPT` body intact.
- Claude call: `shared.claude_client.complete(system, messages, model='claude-sonnet-4-6', max_tokens=...)` — current; `DEFAULT_MODEL` is still Sonnet 4.6.
- Escalation row: `agents.ella.escalation.escalate(reason, context, client_id, agent_run_id)` — current at `escalation.py:18`. Signature unchanged.
- Escalation DM fan-out: `agents.ella.escalation_routing.resolve_escalation_recipients(primary_csm)` and `fire_escalation_dms(recipients, slack_channel_id, triggering_message_ts, reasoning, path="reactive", channel_client_id)` — current at `escalation_routing.py:56` and `:114`. `path="reactive"` is still the right tag for @-mention escalations.
- Identity: `agents.ella.identity.resolve_speaker_identity(slack_user_id)` — current, unchanged.
- Slack posting: `shared.slack_post.post_message(channel_id, text)` — current, replaces the old `_post_to_slack`.
- Agent-run telemetry: `shared.logging.start_agent_run` / `end_agent_run` — current; the trigger_type strings `slack_mention` and `bare_mention` are already in the dashboard's RESPONSE_TRIGGER_TYPES filter so restored runs show up on `/ella/runs` immediately (unlike today's classifier-routed `passive_monitor` rows which are filtered out per the prior dashboard diagnostic).

## Surprises and judgment calls

**The old prompt explicitly anticipated today's failure mode.** Old `_BASE_PROMPT` line 69: "Curriculum content — lessons, frameworks, exercises, **what a module covers**, where to find something in the course." That phrase "what a module covers" matches Drake's exact today-failing query "what's covered in module 3" verbatim. The old prompt's author knew this question shape would come and explicitly classified it as answerable. The new classifier prompt's author wrote a navigation rule that exactly contradicts that intent without realising — the two prompts were edited independently after the path collapsed, and the contradiction wasn't visible until production traffic exposed it. Worth a doc-hygiene note: when two prompts answer different parts of the same decision (classifier deciding shape, response model writing reply), they need to be co-edited or the contradiction will recur.

**The old prompt wasn't flawless — it had its own known issues.** I'm reading the prompt at `0347f51^`; the spec asked me to be honest about flaws rather than rose-tinted. Two real issues with the old path:
- The `[ESCALATE]` token was brittle. The 2026-05-14 commit `0c3d88a` includes loosening `_detect_and_strip_escalation` from "marker at start of response" to "marker anywhere in response" because production runs showed Sonnet writing client-facing text + `\n[ESCALATE]\n` + handoff text and the original strict-prefix detector let the handoff text leak to clients. The loosened detector then had the trade-off that any conversational use of `[ESCALATE]` literal in prose got stripped. The structural fragility of in-band markers is real; the split spec should pick a structured replacement (see open forks).
- The FIRM AFTER FIRST rule relied on the model recognising its own prior escalation in recent context. Model-side recognition is imperfect; the rule mitigated re-engagement spirals but didn't eliminate them. Modern alternative: a structural check (look at recent `agent_runs` for prior escalations on similar topics) that the dispatch layer enforces, not the response model.

**The 2026-05-18 collapse was driven by a legitimate motivation that the recovery shouldn't lose sight of.** Spec `5f05b5c` says "unified-path intelligence refactor" — the goal was operational simplicity (one decision pipeline for both passive monitoring and @-mentions, easier to test, easier to log, one cost surface). The split spec is undoing that unification for @ specifically — that's the right call (proven by today's regression) but the unification's wins (operational simplicity, single audit lane) should be preserved for passive monitoring. The split is asymmetric: @ gets back its own lane; passive stays unified.

**The "AM" vs "PM" labels in the source spec are swapped.** As noted in Verification, both collapse commits landed 2026-05-18 PM EDT — `0347f51` at 14:23 and `a811240` at 17:06. Sequencing as "phase 1 → phase 2" is correct; the AM/PM tagging is off. Not a substantive issue; just flagging so the split spec doesn't trust the AM/PM labels.

**Judgment call — did NOT trace every intermediate commit.** Between `0c3d88a` (2026-05-14) and `0347f51^` (2026-05-18) there were ~30 commits, but `git log -- agents/ella/agent.py api/slack_events.py` showed none touched the @ path. The @-path code was stable. If a later archaeology session wants commit-by-commit diffs across that window, they're cheaply available via `git log -p`, but the recovery target (file state at `0347f51^`) is what matters and that's what I read.

**Judgment call — did NOT read the deleted shipped specs from git history.** The spec mentioned `ella-unified-path-intelligence-refactor.md` was deleted in EOD cleanup and lives only in git history (recoverable via `git show <sha>:docs/specs/<slug>.md`). I read the commit messages and stat output for the two collapse commits but didn't pull the deleted spec bodies — the commit messages on `0347f51` and `a811240` were self-explanatory enough about what was being collapsed and why. If the split spec wants the intent statements from those deleted specs, here are the recovery commands: `git show 23a9867:docs/specs/ella-architecture-refactor-and-daily-digest.md` and `git show 5f05b5c:docs/specs/ella-unified-path-intelligence-refactor.md`.

## Out of scope / deferred

**Open forks for the split spec to decide:**

1. **How Sonnet emits "I want to escalate" to the router.** Three options:
   - (a) Restore `[ESCALATE]` token verbatim. Proven (worked for weeks), low complexity, but brittle (the 2026-05-14 fix loosened the detector twice).
   - (b) Structured JSON output: prompt Sonnet to return `{response_text: str, escalation: null | {handoff_reasoning: str}}`. Modern equivalent, robust to in-prose token mentions, requires JSON parsing + a safer-fallback when the model returns malformed JSON.
   - (c) Tool-use: define an `escalate` tool Sonnet can call. Most structured, but overkill for a single binary decision and adds Anthropic-tool-use protocol complexity.
   
   Recommendation: **(b) structured JSON.** Modern replacement for the token without the brittleness; the parser fallback can default to "treat the whole text as response, no escalation" which matches old behavior when no `[ESCALATE]` token was present.

2. **Sonnet vs Haiku for the @ response.** Old was always Sonnet. New classifier routes simple questions to Haiku for cost savings. With the cap raised (no longer a budget pressure point in 2026-05-23) and the classifier removed, simplest is always-Sonnet on @ matches old proven behavior. Drake's call on whether to revisit Haiku-routing later for cost reasons — recommend always-Sonnet for the restoration.

3. **Trigger source — `message` event only, or restore `app_mention` too.** Old path consumed both. Current `app_mention` is a no-op. Recommendation: stay with `message`-event-only because the dedup gate (`webhook_deliveries.webhook_id` PK) is now wired around that path, and re-enabling `app_mention` reintroduces the dual-fire problem the old `_should_dual_trigger` was a workaround for. The dispatch entry point can read `is_ella_mentioned=true` (already computed for passive monitor) and route to the new @ handler before passive monitor's decision Haiku is invoked.

4. **What happens to today's `mention_classifier.py`.** After the split, the classifier has no callers for @-mention dispatch. Two options: delete it outright, or leave it as dead code for a release in case rollback is needed. Recommendation: delete in the same commit as the restore so the cleanup is atomic and the code surface shrinks. The fallback safety net is git revert, not retained dead code.

5. **Whether to preserve `pending_ella_responses` for the @ path.** Old path was synchronous — Sonnet ran in the webhook handler. The current classifier's `respond_sonnet` shape queues `pending_ella_responses` and lets the per-minute Sonnet drain cron post the reply later. Drake's call: synchronous (old, low latency, matches user expectation of an immediate response) or asynchronous (current, lower webhook latency, more robust to slow Sonnet). Recommendation: synchronous for the @ restoration — @-mentions are user-initiated and benefit from immediate replies, plus the synchronous shape matches the old proven behavior.

**Known-issues-worthy follow-ups (NAMED here, not edited into known-issues per spec):**

- **`docs/known-issues.md` entry: "co-edit risk on Ella's classifier + response prompts."** The 2026-05-18 collapse split the original `_BASE_PROMPT` into two prompts (classifier in `mention_classifier.py` + response in `digest_response.py` + still-extant `_BASE_PROMPT`), and the three prompts drifted independently — the navigation rule in the classifier directly contradicts "what a module covers" answerability in `_BASE_PROMPT`. Any future split prompt structure needs an explicit co-edit guard (lint, doc-cross-reference, or a single source of truth).
- **`docs/known-issues.md` entry: "old `[ESCALATE]` token detection trade-off."** If the split spec picks option (a) above, document that the loose detector strips any literal `[ESCALATE]` in prose. If it picks (b), this isn't needed.

**Not chased in this pass (out of spec scope):**

- I did NOT examine the passive monitoring path's commit history. The spec's path-split applies to both @ and passive, but this archaeology was explicitly the @ half. The passive side's "remove in-channel voice, keep observation" design is the split spec's call, informed by but not constrained by this report.
- I did NOT verify what test files would need updating in the restoration. `tests/agents/ella/test_agent.py` was substantially rewritten in `a811240` (per its stat output: 416 lines changed). The restoration will need its tests rewritten too; that's split-spec scope, not archaeology scope.

## Side effects

None. Read-only archaeology. `git show` reads into stdout (or `/tmp/old_*.py` for grep convenience); nothing materialized into the working tree, no migrations, no API calls, no Slack posts, no DB queries beyond the spec/report file creation. Throwaway `/tmp/old_agent.py`, `/tmp/old_prompts.py`, `/tmp/old_slack_events.py` left in `/tmp` for natural cleanup; not committed.
