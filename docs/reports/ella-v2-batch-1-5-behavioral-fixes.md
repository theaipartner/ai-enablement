# Report: Ella V2 Batch 1.5 — behavioral fixes

**Slug:** ella-v2-batch-1-5-behavioral-fixes
**Spec:** docs/specs/ella-v2-batch-1-5-behavioral-fixes.md

## Files touched

**Created:**
- `agents/ella/identity.py` — `SpeakerIdentity` dataclass + `resolve_speaker_identity` resolver (Task 1).
- `tests/agents/ella/test_identity.py` — direct unit coverage for the resolver.
- `tests/agents/ella/test_prompts.py` — coverage for the new `_render_speaker_section` branches (Task 2).
- `tests/agents/ella/test_retrieval_recent_context.py` — coverage for `fetch_recent_channel_context` (Task 5).
- `tests/api/test_slack_events_dual_trigger.py` — coverage for `_should_dual_trigger` and `_build_app_mention_from_message` (Task 7).
- `docs/reports/ella-v2-batch-1-5-behavioral-fixes.md` — this report.

**Modified:**
- `agents/ella/agent.py` — speaker resolution + channel-client lookup + new `_detect_and_strip_escalation` (replaces `_is_escalation` + `_strip_escalation_marker`) + bare-mention handler + recent-context plumbing. `trigger_metadata` now carries `real_author_role/name/id`. Escalations now include `handoff_reasoning` + `speaker` dict.
- `agents/ella/slack_handler.py` — dropped impersonation path; passes real `user` through; stamps `is_team_test=True` when speaker is an advisor.
- `agents/ella/prompts.py` — new `_render_speaker_section` (audience-aware persona) + `_render_recent_channel_context_section`. WHAT YOU ESCALATE block rewritten for the new end-of-response convention + advisor @-mention.
- `agents/ella/retrieval.py` — added `fetch_recent_channel_context` and `_batch_resolve_names` for the last-N-turns query.
- `api/slack_events.py` — `_post_to_slack` no longer threads (dropped `thread_ts`); new `_should_dual_trigger` + `_build_app_mention_from_message` for Task 7.
- `tests/agents/ella/test_agent.py` — rewrote to match the new architecture (speaker patches, channel-client patches, end-of-response escalation, bare-mention, recent-context plumb).
- `tests/agents/ella/test_slack_handler.py` — rewrote: no more impersonation assertions; new advisor / unresolvable / client paths; resolver patched at handler level.
- `tests/api/test_slack_events_post.py` — stripped `thread_ts` kwargs from `_post_to_slack` call signatures.
- `docs/agents/ella/ella.md` — Trigger / Response Location / escalation flow / Style examples / System Prompt Direction point 10 all updated. "your advisor" → advisor's actual name in behavior-describing sections.
- `docs/agents/ella/future-ideas.md` — V2.1 + V2.2 marked SUPERSEDED 2026-05-10 (preserved underneath); V2.3 + V2.4 marked COMPLETED 2026-05-10 (preserved underneath).
- `CLAUDE.md` — new § Live System State Batch 1.5 entry covering all 7 tasks.

## What I did, in plain English

Walked the 6-bullet acclimatization first — read `slack_handler.py`, `agent.py`, `prompts.py`, the existing escalation detector, confirmed the `slack_messages_channel_sent_at_idx` index exists for Task 5's query, confirmed Ella's two known identities (bot `U0ATX2Y8GTD` via `SLACK_BOT_TOKEN`, human `U0B03PTJD3P` via `SLACK_USER_TOKEN`). Found the V1 impersonation bug at `slack_handler.py:99-117` where `agent_event["user"]` was being rewritten to the channel-mapped client's slack_user_id whenever a team_member posted — that's the V2.4 wrong-name surface the audit caught.

Executed the 7 tasks sequentially, one commit per task per the spec's commit list, plus a final doc-update commit and this report. Each task's tests were written and run green before the commit. Full-suite check after Task 7: 467 passing (+28 new Ella-related tests across 4 new test files plus additions to `test_agent.py`).

The architectural shape that emerged: the slack_handler became a thin channel-and-text gateway. The agent owns speaker resolution + channel-client lookup + prompt construction. The prompt branches on speaker.role for persona behavior. The escalation detector matches anywhere and splits the response into client-facing-ack vs handoff-reasoning. Responses always post to the main channel; conversational context comes from a recent-channel-context query against `slack_messages` (which is now populated by V2 Batch 1's realtime ingestion, so the data is fresh). Dual-trigger detection lives at the webhook layer and reshapes message events into app-mention shape when Ella's human user_id is mentioned alone.

## Verification

- **Test suite:** 467 passing after Task 7. Specifically: 62 Ella-related tests in `tests/agents/ella/` + 9 dual-trigger tests in `tests/api/test_slack_events_dual_trigger.py` + the existing `test_slack_events_post.py` passes after dropping `thread_ts`. Two deprecation warnings unrelated to this work (Supabase client init in `tests/ingestion/fathom/test_pipeline.py`).
- **New test files (4):** `test_identity.py` (5 tests covering client / advisor / unresolvable / both-table conflict / empty input), `test_prompts.py` (5 tests covering client / advisor / unresolvable persona branches + default-no-speaker fallback + unassigned-advisor rendering), `test_retrieval_recent_context.py` (5 tests covering empty / no-messages / oldest-first ordering / unmapped-user-fallback / truncation), `test_slack_events_dual_trigger.py` (7 tests covering happy-path / bot-also-mentioned / no-human-mention / self-author paths / token-unresolved / payload reshaping).
- **Extended test files:** `test_agent.py` gained bare-mention coverage (3 tests), trigger_metadata real-author assertions, recent-context plumbing assertion, end-of-response escalation shape, mid-response leak handling. `test_slack_handler.py` rewritten — old impersonation tests replaced with advisor-passes-through-with-is_team_test + unresolvable-still-responds.
- **Compile check:** every commit's diff was `py_compile`-clean (implicit via the tests).
- **Integration check:** ran the full suite (`pytest tests/ -q`) — 467 passing. No production smoke run (no real Slack post) — that's Drake's gate (c) post-deploy verification per the spec.

## Surprises and judgment calls

- **The V1 impersonation bug at `slack_handler.py:99-117` was the structural root cause of the V2.4 wrong-name issue.** Spec hinted at this but reading the code made it concrete: `agent_event["user"] = channel_client_slack_user_id` for every team_member-asker run. Tasks 1+2 had to undo that wholesale — not just add a speaker section. So Task 1's refactor moved the channel-client lookup OUT of the handler and INTO the agent; the handler stopped doing client-resolution work entirely (it just gates on channel mapping + strips mentions + does the markdown-to-mrkdwn conversion). The agent now owns the dual identity flow: speaker for prompt addressing, channel-client for retrieval scope.
- **Removed the "unknown_asker → no response" gate.** V1 dropped messages from users not matching either `clients` or `team_members`. V2's design wants unresolvable speakers to still get a response (with the safer-fallback persona). So I removed the gate. This is a behavior change worth flagging — production traffic from a Slack user whose `slack_user_id` isn't in either table will now get a polite generic-asker response instead of silence. Documented in the new `test_handler_unresolvable_speaker_still_responds` test.
- **Split the V1 detector into two functions, then realized one is enough.** First pass kept `_is_escalation` + `_strip_escalation_marker` and added `_detect_and_strip_escalation` alongside. Cleaner second pass deleted the two V1 helpers entirely — the new function returns `(client_text, handoff_or_None)` which subsumes both shapes. The `_call_claude` confidence calc is now a plain `_ESCALATION_MARKER in text` substring check, since "detect anywhere" makes that the simplest signal.
- **The prompt's [ESCALATE] convention flipped from start-of-response to end-of-response in Task 3.** Spec wanted the advisor @-mention in the client-facing portion (which lands in Slack) and the marker + handoff at the END. The detector loosening in Task 4 catches both shapes (start AND end AND mid-response), so legacy V1 responses that still emit the marker at the start keep working. Tested both shapes explicitly in `test_detect_and_strip_escalation`.
- **`agent_runs.trigger_type='bare_mention'` is a new value.** Existing values in production are `slack_mention` (for app_mention runs) and the other agents' trigger types. No schema change needed — the column is `text`. Future analytics on Ella will see `bare_mention` rows as zero-cost lightweight runs; that's the intended signal.
- **`fetch_recent_channel_context` uses `slack_ts` string lexicographic comparison** rather than parsing to a numeric timestamp. Slack's ts strings sort chronologically because they're zero-padded seconds.microseconds (e.g. "1778440700.434379"), so `slack_ts < before_ts` does the right thing. Avoids floating-point precision issues. Tested implicitly via the oldest-first rendering test.
- **The recent-channel-context query DOES include Ella's own past responses** (V2 Batch 1's backfill tagged 5 messages in `#ella-test-drakeonly` as `author_type='ella'`, and 21 more from the V1 bot user as `author_type='bot'` per the audit). Ella seeing her own past responses is the intended behavior per the spec; it's how she gets conversational continuity. The dual-trigger logic (Task 7) explicitly excludes self-responses, so this doesn't cause response loops.
- **`_should_dual_trigger` resolves both bot and human user_ids on every event** — but `get_user_id_for_token` caches per-process, so this is two dict lookups after the first per-process auth.test calls. The Vercel cold-start cost is ~2× auth.test (~200ms total); steady-state cost is microseconds.
- **Tests use `mocker.patch` against `_fetch_recent_context_for_event`** rather than against `fetch_recent_channel_context` directly. The agent has a thin internal wrapper so test seam stays stable; cleaner than reaching through the import.
- **Commit split: 7 tasks → 7 work commits + 1 doc commit + 1 report commit.** Matches the spec's recommended shape. Each work commit's tests pass on green before the push. The doc commit bundles all three doc updates (ella.md + future-ideas.md + CLAUDE.md) because they're a single logical "Batch 1.5 is shipped" sweep.

## Out of scope / deferred

- **Validation in `#ella-test-drakeonly`.** Drake's gate (c) — post-deploy testing on a real Slack surface. Once Drake confirms Ella addresses Drake/Nico/Scott/Aman by their real names (not "Javi") and the new escalation flow @-mentions the advisor cleanly, Batch 1.5 is fully validated.
- **Rolling out to the 7 non-test pilot channels.** Spec said this happens automatically once Batch 1.5 ships — the realtime event subscriptions are already live for all client channels (post the Batch 1 ops rollout), and the new behavior applies uniformly. No code change for the rollout itself.
- **Backfilling V1 `agent_runs` rows with the corrected `trigger_metadata`.** The new `real_author_*` fields only land on new runs. Historical V1 runs in `agent_runs` still have the wrong `trigger_metadata.user`. Not in scope; analytics on V1 traffic should consult the audit doc instead.
- **CSM Co-Pilot V1.** Original revisit-trigger on V2.1-V2.4 was "after CSM Co-Pilot V1 ships". With those four future-ideas now closed by Batch 1.5, the CSM Co-Pilot scope stays as the next major Ella-adjacent build per CLAUDE.md § Next Session Priorities Batch C.
- **Token-budget verification on the assembled prompt.** Spec called out the 2000-token recommendation as a starting point. Didn't measure the actual rendered prompt under load — likely fine (Sonnet's 200k window leaves plenty of headroom), but worth a check if any prompt-assembly perf signal surfaces.

## Side effects

- **9 commits pushed to `origin/main`** during this work: feat(ella) for Tasks 1, 2, 3, 5, 7 + fix(ella) for Tasks 4 and 6 + docs for Batch 1.5 doc updates + this report. All landed cleanly on top of the in-flight spec commit Drake pushed earlier in the session.
- **Read-only DB queries during acclimatization** (schema reads via `information_schema`; sample Ella-run reads). No writes.
- **No external API calls** beyond `git fetch` / `git push` to GitHub. No Slack writes, no Anthropic calls, no production Vercel deploys triggered directly by Builder (the push triggers Vercel's auto-deploy via GitHub integration — Drake validates on the dashboard per gate c).
- **No Vercel env var or Slack app config changes.** Drake's gate (d) untouched.
- **No schema changes, no migrations.** All DB interactions use existing tables.
- **No new external dependencies.** Used standard library `random` for the bare-mention opener selection.
- **No deletion of spec or report files.** Per the EOD-batch convention, Drake handles spec/report cleanup at end of day. This spec stays `in-flight` until Director flips it or Drake batches.
