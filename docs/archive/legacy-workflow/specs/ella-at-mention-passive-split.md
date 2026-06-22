# Ella @-mention / passive path split — restore proven @ behavior, remove passive in-channel voice
**Slug:** ella-at-mention-passive-split
**Status:** in-flight

**Target branch: ella-worktree**

> Handed to Builder in the worktree (paste-to-Code). Save to docs/specs/ella-at-mention-passive-split.md in the worktree. Execution stays in the ella-worktree worktree at ~/projects/ai-enablement-ella, NOT main. A Close-ingestion backfill is running on main in parallel — Ella-only work; touch nothing Close-related.

## Why this exists

This session diagnosed a chain: an Anthropic usage cap (now resolved) was masking a regression in Ella's @-mention behavior. The regression's root cause (`docs/reports/ella-kb-retrieval-access-diagnostic.md` + `docs/reports/ella-at-mention-archaeology.md`): the 2026-05-18 "unified-path" refactor collapsed Ella's separate @-mention and passive paths into one pipeline, and the 2026-05-19 structural override added a mention *classifier* (`agents/ella/mention_classifier.py`) whose enumerated `acknowledge_and_escalate` rule includes a "navigation" trigger that fires on content questions like "what's covered in module 3" — escalating them to a human BEFORE retrieval is even considered. The archaeology confirmed: pre-2026-05-18, @-mentions ran through a dedicated reactive path where ONE Sonnet call decided-and-answered with the retrieved KB chunks visible, escalating only on four narrow categories (judgment-call / emotional / money / no-good-context), with NO navigation rule. That path answered curriculum questions correctly. Drake wants it back.

This spec does two inseparable things:

1. **Restore the proven @-mention behavior** as its own clean path — retrieve-then-decide, one Sonnet call with chunks visible, the four-category escalation logic, NO navigation rule — modernized onto current wiring.
2. **Remove passive monitoring's in-channel voice** — passive stops posting in client channels and stops DMing acks/escalations from the passive path. Passive KEEPS its observation role: it still writes `pending_digest_items` feeding the daily digest + the unanswered-flagger to internal channels. The product rule Drake set: **in client channels, Ella only ever speaks when @-mentioned.**

Plus a folded-in correctness fix (3) below.

## Drake's confirmed design decisions (do not re-litigate these)

1. **Escalation signal from Sonnet = structured JSON**, not the old `[ESCALATE]` token. Sonnet returns `{"response_text": str, "escalate": bool, "handoff_reasoning": str|null}`. Parser defaults to "no escalation, treat text as response" on malformed JSON (matches old no-token behavior). This is the one deliberate upgrade over the original — the old token was brittle (leaked into client text twice in production).
2. **Always Sonnet for the @ response.** No Haiku-routing on the @ path. Simpler, matches proven behavior, cost is negligible.
3. **Synchronous response.** The @ path runs Sonnet inline in the webhook handler and posts the reply immediately — NOT queued to `pending_ella_responses`. @-mentions are user-initiated and expect an immediate reply.
4. **Delete `mention_classifier.py`** in the same commit. It has no caller after this. Recoverable from git history if ever needed (the archaeology pass proved git-recovery works). Do NOT leave it as dead code.
5. **Both mention targets stay.** `@Ella`-the-app (bot user_id) AND the human-account mention both trigger the @ path. The existing `detect_at_mentions` already checks both `SLACK_BOT_TOKEN` and `SLACK_USER_TOKEN` user_ids — preserve this; it's an acceptance criterion + smoke case below.

## What to KEEP (do not remove or regress)

- **Passive observation → digest/flagger.** The passive path must still write `pending_digest_items` rows (via `insert_digest_item` / `_insert_pending_digest_item`) so the daily digest (`api/ella_daily_digest_cron.py`) and the unanswered-flagger (`api/ella_unanswered_flagger_cron.py`) keep working against internal channels. Removing passive's *in-channel voice* must NOT remove its *observation*.
- **The routed-to-humans Gate 3** in `passive_monitor._evaluate` — still useful for the digest signal. (It already produces a skip + digest item, no in-channel action — that's exactly the passive-no-voice shape, so it survives naturally.)
- **The dedup gate (step 0)** in `realtime_ingest.py` — untouched. Both @ and passive flow through it.
- **`detect_at_mentions` checking both bot + human user_ids.**
- **The Sonnet response machinery** in `agent.py` (`_retrieve_context`, `_call_claude`, `build_system_prompt`, `fetch_recent_channel_context`) — this is the spine of the restored @ path; reuse it, don't reinvent.
- **The escalation fan-out** (`escalation_routing.fire_escalation_dms`, `escalation.escalate`) — the restored @ path's escalate case uses these, with `path="reactive"`.

## The architecture after this spec

One ingest → fork on `is_ella_mentioned`:

- **`is_ella_mentioned=True` → the restored @ path** (new dedicated handler, synchronous): resolve speaker + channel client → retrieve KB chunks + recent context → ONE Sonnet call with chunks visible, using the restored `_BASE_PROMPT` (four-category escalation, NO navigation rule) → parse structured-JSON output → if `escalate`: post the warm ack + write `escalations` row + fire DMs (Scott + primary advisor) + write digest item; if not: post the answer. `trigger_type='slack_mention'` (or `bare_mention` for the <5-char short-circuit). Status honest (see fix 3).
- **`is_ella_mentioned=False` → the passive path** (decision Haiku, observation-only): keeps the decision Haiku, but its dispatch NO LONGER posts in-channel or fires ack DMs. The decision Haiku's `respond` / `acknowledge_and_escalate` / `skip` outcomes all collapse, for the passive path, to: write the `agent_runs` row + (if flagged) the `pending_digest_items` row, and nothing in-channel. Passive's only outputs are observation rows. The escalation DM fan-out on the passive path is removed.

The fork already exists at the `if payload.is_ella_mentioned:` branch in `passive_monitor._evaluate`. This spec replaces the classifier branch with a call into the new @ handler's evaluation, and neuters the in-channel side effects on the passive dispatch branches.

## Folded-in fix (3): status honesty on failed LLM calls

Currently when a Haiku/Sonnet call fails, the code falls back (skip, or canned text) and still calls `end_agent_run(run_id, status="success", ...)` — the failure only lives in a `reasoning`/`output_summary` string. This is what made the BadRequestError incident invisible on `/ella/runs` (181 failed calls all showing `status='success'`). Fold in: **when an LLM call inside the dispatch path fails (the `except` branches that currently log + fall back), the `agent_runs` row must end with `status='error'` (or a non-success status) and the error captured in `error_message`**, not `status='success'`. This applies to both the restored @ path's Sonnet call and the passive path's decision Haiku. The goal: a future "Ella's gone quiet" incident is visible by querying `agent_runs WHERE status='error'`, without a Vercel-log dive. Keep the user-facing fail-soft behavior (Ella still degrades gracefully in-channel) — only the *recorded status* changes.

## Acclimatization checklist

Read first, confirm in 5 bullets:

- `docs/reports/ella-at-mention-archaeology.md` — the recovered old @ behavior, the lift-forward/leave-behind map, the five open forks (all now decided above).
- CURRENT `agents/ella/agent.py` (`respond_to_mention` adapter + `respond_to_passive_trigger` — the latter has the Sonnet machinery to reuse), `agents/ella/passive_monitor.py` (the `_evaluate` fork at `if payload.is_ella_mentioned:`), `agents/ella/passive_dispatch.py` (`_dispatch_mention` to delete; `_dispatch_respond` / `_dispatch_acknowledge_and_escalate` / skip path to neuter for passive), `ingestion/slack/realtime_ingest.py` (`detect_at_mentions` + `_maybe_dispatch_passive_monitor` — confirm both user_ids checked).
- CURRENT `agents/ella/prompts.py` `_BASE_PROMPT` — confirm the WHAT YOU CAN HELP WITH ("what a module covers") + WHAT YOU ESCALATE (four categories) sections are intact, and that there's no navigation-escalate rule in it. The restored @ path uses `build_system_prompt` which builds on `_BASE_PROMPT`.
- `agents/ella/mention_classifier.py` — to be deleted; confirm its only caller is the `is_ella_mentioned` branch in `passive_monitor._evaluate`.
- `tests/agents/ella/` — the existing test files (`test_passive_monitor.py`, `test_passive_dispatch.py`, `test_mention_classifier.py`, `test_agent.py`). The mention-classifier tests get deleted with the module; the others get reworked for the split contract.

## What to do

Implement the architecture above. Suggested commit sequence (per one-logical-change-per-commit):

1. **The restored @ handler.** Add the dedicated synchronous @-mention handler (likely in `agent.py`, reusing `_retrieve_context` / `build_system_prompt` / `fetch_recent_channel_context` / a Sonnet `complete` call). Implement the structured-JSON escalation contract (decision 1): Sonnet returns `{response_text, escalate, handoff_reasoning}`; add the parser with the safe "no escalation" fallback. Update `_BASE_PROMPT` (or the @ path's prompt assembly) to instruct Sonnet to emit that JSON instead of the prose+token shape — keep the four-category escalation logic and the WHAT YOU CAN HELP WITH content verbatim; do NOT introduce a navigation rule. The escalate case calls the existing `escalation.escalate` + `escalation_routing.fire_escalation_dms` (path="reactive"); the respond case posts via `shared.slack_post.post_message`. Keep the bare-mention (<5 char) short-circuit → canned warm opener, `trigger_type='bare_mention'`, no LLM. Substantive → `trigger_type='slack_mention'`.

2. **Wire the fork to the new handler.** In `passive_monitor._evaluate`, the `if payload.is_ella_mentioned:` branch routes to the new @ handler instead of `classify_mention_response`. Decide cleanly where the @ handler runs — it can run synchronously from within the realtime-ingest fork (preferred, matches "synchronous" decision) rather than going through `persist_passive_evaluation`. The cleanest shape: realtime_ingest's `_maybe_dispatch_passive_monitor` checks `is_ella_mentioned` and routes to the @ handler directly; only non-mention messages go through `evaluate_passive_trigger` → `persist_passive_evaluation`. Use your judgment on the exact seam, but the @ path must NOT double-fire and must NOT route through the passive dispatch's posting logic.

3. **Neuter passive's in-channel voice.** On the passive (non-mention) dispatch path: `_dispatch_respond` and `_dispatch_acknowledge_and_escalate` must stop posting in-channel and stop firing ack DMs. Passive `respond`/`acknowledge_and_escalate`/`skip` all collapse to: write `agent_runs` + (if `digest_flag`) `pending_digest_items`, nothing else. The simplest correct implementation may be that the passive decision Haiku's output is used ONLY for the digest signal now (decision + digest_flag → digest item), with no in-channel action regardless of decision. Confirm the daily digest + unanswered-flagger still get their rows. Remove the now-dead passive in-channel posting + passive escalation-DM code.

4. **Delete `mention_classifier.py`** and its tests, and remove the import + branch that called it.

5. **Fold in the status-honesty fix (3)** across the touched dispatch paths.

6. **Tests.** Rework `test_passive_monitor.py` / `test_passive_dispatch.py` / `test_agent.py` for the split contract; delete `test_mention_classifier.py`. New coverage MUST include: (a) @-mention of the BOT user_id triggers the @ path; (b) @-mention of the HUMAN user_id triggers the @ path; (c) a curriculum content question ("what's covered in module 3") through the @ path → Sonnet responds (does NOT escalate as navigation); (d) an escalate-worthy @ message (money/emotional) → escalate JSON → ack posted + DM fired; (e) passive non-mention message → NO in-channel post, digest item still written; (f) a failed LLM call → `agent_runs.status='error'`, not success.

## What success looks like

- @-mention with a curriculum content question gets a real answer (the screenshot regression is fixed). Both bot-mention and human-mention trigger it.
- @-mention with a genuinely escalate-worthy message (billing/emotional) acks + DMs the advisor + Scott.
- Passive (non-@) messages produce NO in-channel Ella posts and NO passive ack DMs — but DO still write digest items so the daily digest + unanswered-flagger keep working.
- `mention_classifier.py` is gone.
- Failed LLM calls land as `status='error'` on `agent_runs`.
- Full pytest suite green; `tsc --noEmit` + `next lint` clean (likely no TS touched, confirm).

## Hard stops

- **This touches the dispatch core. Test what you build** — run the relevant pytest files, and if feasible exercise the @ path end-to-end against a controlled input.
- **Do NOT break passive's observation role.** If you find yourself removing `insert_digest_item` calls, stop — that's the part we KEEP.
- **No migration expected.** If you think one is needed, STOP and surface to Drake (gate a) — this should be code-only.
- **No env-var changes expected.** If you think one is needed, STOP (gate d).
- **Do NOT deploy / flip kill switches / change `passive_monitoring_enabled` on any channel.** Production-state changes are Drake's. The kill switches stay as they are.
- Operate in ella-worktree, not main. Touch nothing Close-related.
- If `_BASE_PROMPT` turns out to NOT be intact (gutted by the unified-path refactor more than the archaeology indicated), STOP and surface — the restored prompt is load-bearing and Drake should review the prompt text before it goes live (the archaeology said it's intact; verify).

## Drake's gate (c) — post-merge smoke (NOT blocking this spec's completion)

After this ships and deploys, Drake validates in `#ella-test-drakeonly` + a real channel: (1) @Ella-app curriculum question → real answer; (2) @human-account curriculum question → real answer; (3) @Ella escalate-worthy message → ack + DM; (4) a non-@ message in a passive channel → Ella stays silent in-channel but the digest still picks it up. Until smoke passes, the spec stays in-flight and the report (PARTIAL).

## What could go wrong — think this through yourself

Seeds, surface anything else: the synchronous @ path runs Sonnet inside the Slack webhook handler — watch the latency ceiling (the old path did this fine, but confirm the webhook doesn't time out; `api/slack_events.py` maxDuration is 60s, ample). The fork seam is the riskiest part — make sure an @-mention does NOT also trigger the passive decision Haiku (double-processing), and a non-mention does NOT reach the @ handler. The `respond_to_mention` legacy adapter in `agent.py` currently routes through the passive pipeline — decide whether it's repointed at the new @ handler or removed (check `slack_handler` still resolves). The structured-JSON escalation parser needs the same defensive care the Haiku JSON parser has (code-fence stripping, regex fallback, safe default) — reuse that pattern. And: the passive path's decision Haiku still makes a Haiku call for every non-mention message even though its `respond`/`acknowledge_and_escalate` outcomes no longer act in-channel — consider whether that Haiku call is still worth making purely for the digest signal, or whether the digest classification could be cheaper now; flag it but DON'T redesign the digest in this spec (scope creep) — just note it for a follow-up if the Haiku-for-digest-only feels wasteful.

## Mandatory doc updates

- `docs/agents/ella/ella.md` — rewrite § Trigger + § @-Mention Handling + § Confidence-Based Routing + § Response Location to describe the split (the unified-path framing is now wrong); add a changelog entry. Note passive is observation-only in client channels.
- `docs/runbooks/ella_passive_monitoring.md` — update to reflect passive no longer posts in-channel.
- `docs/state.md` — add a ship entry (post-state migration/function/test counts, what changed).
- `docs/known-issues.md` — add the two entries the archaeology named: (1) "co-edit risk on Ella's prompts" and (2) resolve/close the navigation-escalate regression entry if one was logged. Also note the status-honesty fix closes the "failed calls show as success" gap.
- Flip this spec's Status to shipped only when gate (c) smoke passes (per the gate note above — report is PARTIAL until then).
- Write the report to docs/reports/ella-at-mention-passive-split.md.
