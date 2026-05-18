# Report (PARTIAL): Ella Unified-Path Intelligence Refactor
**Slug:** ella-unified-path-intelligence-refactor
**Spec:** docs/specs/ella-unified-path-intelligence-refactor.md
**Status:** halted — code shipped + pushed + deploy auto-triggered; awaiting Drake's gate (c) post-deploy smoke in `#ella-test-drakeonly` (incl. the double-fire hard stop, which Builder cannot run — no Slack access). Spec stays `in-flight` until smoke passes.

> Read order: **§ What's needed to unblock** (the 8-case smoke set + curl) → **§ Review surface** (ranked) → **§ Surprises** → rest.

## Acclimatization (spec-required 4-5 bullets + reality-checks)

- `passive_monitor` / `passive_dispatch` / `agent` / `prompts` / `digest_response` matched the morning spec's shipped shape exactly (4-decision, `[FALLBACK_TO_SONNET]`, `_run` reactive routing). Confirmed before refactoring.
- `api/slack_events.py` is the double-fire root cause: `message` event → `_ingest_message_event` (→ passive monitor) **and** `_should_dual_trigger` → `_process_mention`, **and** the parallel `app_mention` event → `_process_mention`. Three potential fires for one @-mention. Confirmed.
- `retrieval.fetch_recent_channel_context` returned a formatted string only — no row primitive — so the spec's `build_kb_query_from_conversation(triggering, recent_messages)` needed a new raw-row fetch. Added `fetch_recent_channel_messages`.
- **Reality-check vs spec:** the spec says keep `respond_to_mention` "because its Sonnet logic is reused by `respond_to_passive_trigger`." Reality: `respond_to_passive_trigger` is self-contained (uses shared helpers `_call_claude` / `_resolve_channel_client` / `_fetch_message_text`, not `respond_to_mention`). I kept `respond_to_mention` anyway (spec is source of truth) but made it a thin **adapter over the one path** rather than dead code — see Surprise 1.
- **Reality-check vs prior report:** the morning spec's report is still `(PARTIAL)`. Its gate-(c) smoke never produced a clean pass in-session (the CLI curl 401'd; Drake's Slack testing is what surfaced *this* spec's three findings). This spec supersedes that design; I did not retro-fix the morning report or flip its spec — out of scope, flagged so it isn't lost.

## 1. Files touched

**Modified — source (8):**
- `agents/ella/retrieval.py` — new `fetch_recent_channel_messages` (raw rows); `fetch_recent_channel_context` reformatted to `[YYYY-MM-DD HH:MM ET] <role> (<name>): <text>` (team_member→advisor, zoneinfo ET, Ella posts included); new `build_kb_query_from_conversation` (recent + triggering×2).
- `agents/ella/passive_monitor.py` — `PassiveDecision` → `decision`/`response_model`/`ack_text`/`digest_flag`/`digest_category`; `_PASSIVE_DECISIONS={respond,acknowledge_and_escalate,skip}`; 2-gate pipeline (kill switch + author-type, team_member always evaluated, non-human skip-with-row); combined-conversation KB query; speaker resolve; verbatim new `_HAIKU_SYSTEM_PROMPT` + new user template; rewritten `_parse_haiku_output` (response_model→sonnet default, ack_text→canned fallback).
- `agents/ella/passive_dispatch.py` — 3-routing; new `_dispatch_respond` + `_dispatch_acknowledge_and_escalate`; removed the fallback branch + `digest_only`; re-added `escalate`/`fire_escalation_dms`/`resolve_escalation_recipients` imports; new `trigger_metadata` (is_ella_mentioned/response_model/ack_text).
- `agents/ella/agent.py` — `respond_to_mention` rewritten as a thin one-path adapter; removed `_handle_bare_mention`/`_pick_bare_response`/`_BARE_OPENERS_*`/`_PASSIVE_GENERAL_*`/`_pick_passive_general_opener`/`handle_passive_general_inquiry`/`_run`/`_flag_digest`/`_post`/`_speaker_first_name`/`_advisor_first_name`/`_format_reactive_escalation_summary`; kept `respond_to_passive_trigger` + shared helpers.
- `agents/ella/digest_response.py` — removed `_FALLBACK_TOKEN` + detection; `fallback_to_sonnet` vestigial-False; exception path returns a graceful non-empty handoff (Surprise 3); KB-navigation rule in prompt.
- `agents/ella/prompts.py` — KB-content-vs-navigation added to WHAT YOU CAN HELP WITH; `[FALLBACK_TO_SONNET]` instruction + `_FALLBACK_LITERAL_FOR_PROMPT` constant + the two speaker-variant token lines removed.
- `api/slack_events.py` — `app_mention` → logged no-op; dual-trigger block removed; `_should_dual_trigger`/`_build_app_mention_from_message`/`_process_mention` deleted; unused imports removed. `_post_to_slack`/`_call_chat_post_message` kept (independently tested).
- `ingestion/slack/realtime_ingest.py` — `_detect_ella_mention` (bot OR human uid, fail-soft) + `is_ella_mentioned` threaded into `PassiveTriggerPayload`.

**Modified — tests (9):** test_passive_monitor / test_passive_dispatch / test_digest_response / test_agent / test_prompts / test_retrieval_recent_context (rewritten for the new contract); test_slack_events_dual_trigger (repurposed to guard one-evaluation); test_slack_events_message_ingest + test_passive_ella_cron (updated for removed reactive machinery / retired general-inquiry path).

**Modified — docs (4):** state.md (new 2026-05-18 PM entry), ella.md (Trigger/Response Location/escalation/System Prompt/Escalation routing/Changelog), ella_passive_monitoring.md (pipeline + smoke section), pending_digest_items.md (one-line decision-vocab note).

**Deleted:** no files. No migrations, no env-var changes, no new crons (per spec).

## 2. What I did, in plain English

Collapsed reactive and passive into one pipeline. The `app_mention` webhook event is now a logged no-op; Slack's parallel `message` event is the sole evaluation path, so an @-mention fires exactly once (the double-fire is structurally gone). `is_ella_mentioned` is detected at ingest and weighed by the decision Haiku as the strongest signal. The decision set is three (`respond` with a `haiku|sonnet` sub-pick / `acknowledge_and_escalate` with a Haiku-written warm ack / `skip`); `acknowledge_and_escalate` always posts the ack in-channel + fires the Scott/advisor DM + writes the digest item, identically on @-mention and passive (the morning's asymmetry and `digest_only` are gone). The `[FALLBACK_TO_SONNET]` mechanism is fully removed — a weak Haiku answer is a decision-layer model-pick signal. KB retrieval now embeds the combined recent conversation (last 6 incl. Ella's posts + triggering ×2) instead of the bare triggering text, and the recent-context block carries full ET timestamps + role labels so Haiku can judge active-conversation recency. Bare-mention short-circuit and the canned general-inquiry openers are removed — bare mentions go through the decision Haiku in full context. All mandated docs updated.

## 3. Verification

- `pytest tests/` — **610 passed, 0 failed** (baseline 609; hard stop #1 = "≥609" → satisfied). Ran post-rewrite, again after `black`, again post-docs.
- `npx tsc --noEmit` clean; `npm run lint` clean (hard stop #2). `black` + `ruff check` clean.
- Import + structural sanity verified (decisions set, removed helpers absent, KB-query 2x weighting).
- **NOT verified — gate (c), Drake's:** the 8-case smoke in `#ella-test-drakeonly`, the double-fire hard stop (#3), the malformed-JSON-rate (#4) and empty-ack-text-rate (#5) thresholds, and the manual digest curl. All require live Slack + the deployed build; Builder has no Slack access. These are the unblock set.

## 4. Surprises and judgment calls

1. **`respond_to_mention` is a one-path adapter, not dead code.** The spec said keep it (claiming its Sonnet logic is reused by `respond_to_passive_trigger` — not actually true). Rather than leave an incoherent function whose old `_run` routing referenced deleted decision values, I made it construct a `PassiveTriggerPayload` (`is_ella_mentioned=True`) and call `evaluate_passive_trigger` + `persist_passive_evaluation`. Any leftover caller (`slack_handler`, tests) now produces correct one-path behavior with **no double-fire** (production only triggers the realtime path; `slack_events` no longer calls it). This is a stronger guarantee than the spec's "keep it around" — flagging because it's a design call the spec didn't prescribe.
2. **app_mention = logged no-op (not full removal).** Spec offered Builder the choice. Kept the branch logging "deduped — handled via passive path" so a channel that somehow only delivers app_mention is at least visible in logs. Conservative; matches the spec's documented option.
3. **digest_response exception path returns a graceful handoff, not empty.** The fallback mechanism is gone, but an API failure with empty `response_text` would make the dispatch layer post an empty Slack message (Slack rejects empty text). I return a short "Let me get your advisor on this one" instead. `fallback_to_sonnet` stays vestigial-False per spec. Spec didn't prescribe the exception copy — judgment call to preserve "client never sees silence."
4. **`respond_via_sonnet` → pending row written as `respond_substantive`.** Same compat shim as the morning spec (the unchanged per-minute cron dispatches on that literal). Spec § What's NOT forbids cron changes; this is the only reading that keeps the cron untouched. Inferred contract — flagging.
5. **Test count 610, not "roughly flat."** The rewrites consolidated the old per-gate/per-decision suites; I added back spec-requested coverage (response_model picker, ack_text presence, @-mention threading, ET-format, combined-query weighting, one-evaluation guards, dead-path isolation) to clear the ≥609 floor with margin. Hard stop #1 satisfied; the soft-rule behaviors (active-CSM-dialogue → skip, etc.) are Haiku-judgment and only smoke-testable — not unit-asserted (called out in Review R1).
6. **`test_slack_events_dual_trigger.py` repurposed, not deleted.** The dual-trigger concept is gone; I kept the filename and rewrote it to guard the new one-evaluation contract (so the guard survives and the file count is stable). Cosmetic filename mismatch — noted.
7. **`api/passive_ella_cron.py` left untouched (spec § What's NOT).** Its `elif respond_general_inquiry: import handle_passive_general_inquiry` branch is now dead — the handler is removed and the new tree never emits that decision. A stray legacy row hits the lazy import → caught by the cron's per-row try/except → marked errored, never crashing the drain. Covered by a rewritten test. Harmless dead branch; not in scope to remove.
8. **`prompts.py` token-line removal exceeded the literal spec.** Spec said remove the `[FALLBACK_TO_SONNET]` *base-prompt instruction*. Leaving the advisor/unresolvable "Do NOT emit [FALLBACK_TO_SONNET]" lines + the constant when the token no longer exists anywhere would be incoherent, so I removed them too — the coherent completion of "fallback is gone." Test_prompts updated.
9. **Morning report stays `(PARTIAL)` / state.md line 11 still stale.** Both pre-existing; explicitly carried forward in the new state.md entry. Not retro-fixed (out of scope; the morning spec is a separate slug).

## 5. Out of scope / deferred

- Gate (c) smoke + the smoke-time hard stops (#3/#4/#5) — § What's needed to unblock.
- `lib/db/ella-runs.ts` surfacing the new `response_model` / `ack_text` / `is_ella_mentioned` trigger_metadata fields — spec § smoke step 10 marks dashboard adapter gaps a follow-up, not a blocker. The adapters null-coalesce; channel/author keys unchanged so `/ella/runs` doesn't break.
- Morning report finalization + morning spec status flip + state.md line-11 reconciliation — pre-existing, separate slug, EOD hygiene.
- No `docs/known-issues.md` / `docs/future-ideas.md` entry warranted beyond the above.

## 6. Side effects

- **No** Slack posts, DB writes, migrations, external API calls. Tests fully mock DB/Slack/Anthropic.
- Git: 3 commits **pushed to `origin/main`** (`a811240` code+tests, `777ec18` docs, + this report) — Vercel auto-deploy triggered. No gate (a)/(d) this spec, so the push is unblocked (unlike the morning spec). The deploy carries no schema/env dependency.

## Review surface — ranked

- **R1 (highest, judgment): soft-rule behaviors are Haiku-only, smoke-validated.** The biggest risk (spec § What could go wrong #1) is Haiku misjudging active CSM-client dialogue and interjecting. There is no hardcoded gate anymore — the prompt's soft rule + smoke case #7 are the only guards. If smoke shows Ella interrupting, the decision prompt needs tuning before broader rollout. This is the load-bearing uncertainty.
- **R2: `respond_to_mention` adapter (Surprise 1).** `agents/ella/agent.py` — confirm you're OK with it routing through the one path vs. being inert. No double-fire (verified: `slack_events` doesn't call it; production only fires the realtime path).
- **R3: the verbatim decision Haiku prompt.** `passive_monitor._HAIKU_SYSTEM_PROMPT` — copied exactly from the spec; it carries the @-mention-override, KB-content-vs-navigation, recurrence-re-ack, and CSM-dialogue soft rules. Worth your read before/during smoke since it's the load-bearing artifact.
- **R4: ack_text quality (spec § What could go wrong #3).** Haiku writes the ack copy each time; tone consistency is unproven until smoke. Hard stop #5: surface every empty-ack-text fallback; >1/10 → prompt tuning.
- **R5: `is_ella_mentioned` detection (spec #4).** `realtime_ingest._detect_ella_mention` uses the `<@U…>` regex against bot+human uids (same shape as the old working `_should_dual_trigger`), fail-soft. Smoke cases 3/5/8 exercise it.
- **R6: spec "what could go wrong" answered** — #2 (haiku model over-picked) monitor post-deploy; #5 (empty-context KB query) handled by triggering×2 weighting + test; #6 (`respond_to_mention` removal) — greps clean, `slack_handler`/tests still resolve via the adapter; #7 (active rollout) — smoke runs in the test channel before the swap; kill switch is the abort.

## What's needed to unblock — gate (c), Drake

Deploy is auto-triggered by the push. After the build goes green:

1. Confirm the Vercel `777ec18`/`a811240` build is live.
2. Post in `#ella-test-drakeonly` (spec § Smoke test gate, 8 cases) and verify **exactly one** response each (hard stop #3 — double-fire → STOP):
   - "where do I find the sales lessons" → wait → "@Ella" → expect ONE `acknowledge_and_escalate` threading the prior nav question.
   - "@Ella" in a quiet channel → warm short opener.
   - "@Ella what does the discovery section cover?" → `respond`/`haiku`.
   - "@Ella I'm thinking about restructuring my offer — what's the right approach given my setup?" → `respond`/`sonnet`.
   - "@Ella I'm really frustrated, where do I actually find this stuff?" → `acknowledge_and_escalate` + DM.
   - "I'm really frustrated lately" (no @-mention) → `acknowledge_and_escalate` + in-channel ack.
   - advisor-client back-and-forth (you as team_member) → Ella SILENT throughout (case #7 — the R1 risk).
   - "@Ella how does the sales call framework work?" (as team_member) → `respond` (@-mention overrides skip-CSMs).
3. Manual digest curl (use the **production** `CRON_SECRET` value from Vercel — not from `.env.local`, which lacks it; that was the morning 401):
   `curl -s -X POST -H "Authorization: Bearer <PROD_CRON_SECRET>" "https://ai-enablement-sigma.vercel.app/api/ella_daily_digest_cron?since=$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)" | python3 -m json.tool` — expect the emotional + nav-question entries with right categories.
4. `/ella/runs` check — new `is_ella_mentioned`/`response_model`/`ack_text` fields (dashboard adapter gaps are a follow-up, not a blocker).

If any case double-fires or decides wrong, STOP and hand back — the decision prompt is iterative and may need tuning before production rollout. On a clean pass, Builder rewrites this report to complete form and flips the spec `Status:` to `shipped`.
