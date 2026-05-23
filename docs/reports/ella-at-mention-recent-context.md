# Report: Ella @-mention conversational context — last 3 mention exchanges + use-it-to-answer
**Slug:** ella-at-mention-recent-context
**Spec:** docs/specs/ella-at-mention-recent-context.md

## Files touched

Created:
- `agents/ella/retrieval.py::fetch_recent_at_mention_exchanges` (+ private helpers `_resolve_ella_user_ids`, `_is_ella_mention`, `_render_mention_exchange_line`, + module-level `_SLACK_MENTION_RE`).
- `tests/agents/ella/test_retrieval_at_mention_exchanges.py` — 9 tests covering the new helper.
- `docs/reports/ella-at-mention-recent-context.md` — this report.

Modified:
- `agents/ella/agent.py` — `handle_at_mention` replaces `fetch_recent_channel_context` call with the new `fetch_recent_at_mention_exchanges` fetch (24-line block, no behavior shape change). `_build_at_mention_system_prompt` signature changes (`recent_channel_context` → `recent_at_mention_exchanges`); doesn't pass anything to `build_system_prompt`'s recent-context arg now, appends the new block with its own `# RECENT @-MENTION EXCHANGES IN THIS CHANNEL` header. `_AT_MENTION_EXTENSION` rewritten: adds a CONVERSATIONAL CONTINUITY section, sharpens FIRM AFTER FIRST to fire on prior ESCALATIONS only (not on prior substantive answers).
- `tests/agents/ella/test_agent.py` — updated the `_patch_common` fixture's stale mock target (`fetch_recent_channel_context` → `fetch_recent_at_mention_exchanges`). Added 2 new tests: handler passes the block into the prompt with the labeled header; handler omits the block (but keeps the static instruction text) when no prior exchanges exist.
- `docs/agents/ella/ella.md` — § @-Mention Handling gets a new Conversational Context subsection + sharpened FIRM AFTER FIRST narrative; § Response Location updated to point at the new fetch; Changelog entry added at top.
- `docs/agents/ella/followups.md` — note on the FIRM AFTER FIRST sharpening being pending real-world signal (the rule change is structural-ish but not unit-pinnable for Sonnet's adherence; flag for Drake's spot-check over the next few days).
- `docs/specs/ella-at-mention-recent-context.md` — `Status:` flipped from `in-flight` to `shipped`.

Deleted: none.

## What I did, in plain English

Built `fetch_recent_at_mention_exchanges` in `retrieval.py` and wired it into the @ handler in place of the existing broad 15-turn `fetch_recent_channel_context` call. The new helper does what the spec specified: fetches a 30-message lookback of channel rows before the trigger ts, identifies which messages @-mention Ella (using the same regex + both-user-ids resolution `realtime_ingest.detect_at_mentions` uses, so prior exchanges are defined consistently with what triggers the live @ handler), pairs each mention with Ella's next-user-id-authored message (NOT by `author_type` — Ella's posts are tagged `bot` per the known issue), returns the last 3 such pairs formatted with the existing ET-stamp + time-ago style + `----` dividers between blocks.

The pairing rule is the load-bearing thing the spec called out specifically: `pairing is by user_id, not author_type` is what makes the helper work given the `author_type='bot'` bug. I added an explicit test for this (`test_pairs_mention_with_ella_reply_by_user_id`) — the test data has Ella's reply tagged `author_type='bot'` and asserts pairing still happens.

Updated the @-handler prompt (`_AT_MENTION_EXTENSION`):
- New `# CONVERSATIONAL CONTINUITY` section instructs Sonnet to use the appended exchanges block for threading follow-ups, with explicit guidance about not fabricating continuity that isn't there.
- `# FIRM AFTER FIRST` rewritten: now references the `RECENT @-MENTION EXCHANGES` block by name and is sharpened to fire on a prior **escalation** (your reply was a warm ack handing off), NOT on a prior substantive answer to a similar question. The new prose explicitly says: "If the user is asking the same thing again because they didn't see / didn't grok your previous answer, answer it again." This addresses the smoke-1 over-firing.

The `_build_at_mention_system_prompt` assembly skips passing `recent_channel_context` to `build_system_prompt` entirely (so the `# RECENT CHANNEL CONTEXT (last 15 turns ...)` header from `prompts.py:_render_recent_channel_context_section` doesn't render with the new data), and appends the new block with its own header at the end of the extension. Clean separation; passive's use of `build_system_prompt(... recent_channel_context=...)` (via `respond_to_passive_trigger`, which is itself neutered post-split anyway) is unaffected.

The passive path's `fetch_recent_channel_context` import + use is unchanged.

## Verification

**Targeted tests: 125 passing** across `tests/agents/ella/` + `tests/ingestion/slack/test_realtime_ingest_passive_fork.py`. **Full pytest suite: 687 passing.** (Was 676 pre-this-spec; added 11 net new tests — 9 helper-level + 2 handler-wiring.)

Six spec-required test cases all covered with explicit tests:

- **(a) Last 3 mention exchanges, channel-scoped, paired with replies.** `test_returns_only_last_n_exchanges` builds 5 mention+reply pairs, asserts only the last 3 surface (`q-3`/`q-4`/`q-5` present; `q-1`/`q-2` absent), with `reply-3`/`reply-4`/`reply-5` correctly paired and 2 `----` dividers between 3 blocks.
- **(b) Pairing works when Ella's reply is `author_type='bot'`.** `test_pairs_mention_with_ella_reply_by_user_id` — reply row has `author_type='bot'`; asserts pairing succeeds (no `(no reply yet)` placeholder, both lines render).
- **(c) Mention without reply included alone.** `test_mention_without_reply_included_alone` — single trailing mention with no reply row; asserts mention surfaces + `ella: (no reply yet)` placeholder.
- **(d) Fewer than 3 → returns what exists.** `test_fewer_than_n_returns_what_exists` — only 2 exchanges in window; asserts both surface, 1 divider (not 2), no padding.
- **(e) Handler passes new context into the prompt.** `test_handle_at_mention_passes_recent_exchanges_into_prompt` — stubs the fetch to return a fake block, captures the assembled system prompt by intercepting `complete()`'s `system=` kwarg, asserts the `# RECENT @-MENTION EXCHANGES IN THIS CHANNEL` header + the fake block content + the CONVERSATIONAL CONTINUITY + FIRM AFTER FIRST instructions are all present. Plus a complementary `test_handle_at_mention_omits_block_when_no_prior_exchanges` that asserts the header is NOT in the prompt when the fetch returns empty (clean first-time-conversation prompt).
- **(f) Cross-channel messages NOT included.** `test_cross_channel_messages_not_returned` — fixture has a second channel `C2` with mention exchanges containing secret content; the fetch for `C1` is asserted to return `C1`'s content and **never** any `C2-q` / `C2-secret-reply` / participant names.

Also pinned: both Ella user_ids (bot + human) recognized as prior mentions (`test_human_user_id_mention_recognized_as_ella_mention`), empty-input guards.

**No live API calls, no Slack posts, no DB writes** in the test runs (everything stubbed via `mocker.patch`).

## Surprises and judgment calls

**Inline the regex rather than import from realtime_ingest.** `_SLACK_MENTION_RE = re.compile(r"<@(U[A-Z0-9]+)>")` is duplicated in `retrieval.py` instead of imported from `ingestion.slack.realtime_ingest`. Reason: `agents/ella/*` importing from `ingestion/slack/*` creates a cross-layer dependency (agents importing from ingestion) that I'd rather not introduce just to share one regex line. The pattern is short, named identically, and any future change to the upstream regex shows up as a duplicate that needs both-site updating. Flagged inline in the code comment. If this regex ever evolves beyond `<@U[A-Z0-9]+>` (e.g. Slack adds new user-id prefixes), the co-edit risk is real but the surface is one line.

**Per-message text cap at 800 chars; whole-block cap at 4000 chars.** Both numbers are judgment calls (the spec said "cap/truncate per-message ... like `fetch_recent_channel_context` does"). 800 matches the prior `_render_kb_block` per-chunk cap. 4000 is roughly "1000 tokens for 3 exchanges of ~6 messages averaged at ~200 chars per message" — generous enough that 3 small mentions+replies fit without truncation; tight enough that one runaway 5000-char prior reply gets caught. If a typical channel's mentions are much longer than the average I assumed, the truncation marker (`[...earlier exchanges truncated...]`) will surface — Drake can spot-check post-deploy and tune `max_chars` upward if it's tripping too often. Made the args configurable for that reason.

**Skip past Ella's reply when pairing.** The pairing loop advances `i` past the reply index it just consumed (`i = (j + 1) if reply else (i + 1)`). Reason: if a channel has multiple Ella self-posts in a row (e.g. Ella answered, then posted a follow-up clarification), all of those count as part of ONE reply, not as the reply to a subsequent (non-existent) mention. The spec didn't enumerate this case but it falls out naturally from the "next user-id-authored message" rule — once paired, advance past it.

**`_resolve_ella_user_ids` is fail-soft on token errors.** If `get_user_id_for_token` raises (Slack API hiccup), the resolver returns the IDs it could resolve and logs the failure rather than raising. Worst case: one of the two IDs (bot or human) isn't resolved that call, so mentions of that ID won't be recognized as prior exchanges that call. The @ handler itself still runs (since the trigger that fired it had `is_ella_mentioned=True` via the upstream `realtime_ingest._at_mentions_for_record`); the context is just slightly less rich for that one call. Mirrors `realtime_ingest._at_mentions_for_record`'s fail-soft posture.

**Resolved Ella's display name to literal "Ella" in the rendered block.** `_batch_resolve_names` queries `clients` + `team_members` for name resolution but Ella isn't in either (her identity comes from `SLACK_USER_TOKEN` per `shared.slack_identity`). Without overriding, her reply lines would render with the raw bot/human user_id as the display name. I post-fill the name map with `"Ella"` for any resolved Ella ID. Same pattern as `lib/db/ella-runs.ts:buildUserNameMap` (TypeScript-side) — flagged here so the pattern stays consistent across surfaces.

**Decision: ship now, not leave in-flight.** Spec said flip to shipped IF tests green AND confident. Both conditions met: 687 tests pass; the wiring + privacy invariant + author_type='bot' workaround are all explicitly pinned by tests; the only un-pinnable bit is Sonnet's adherence to the new CONVERSATIONAL CONTINUITY + sharpened FIRM AFTER FIRST instructions, which is a prompt-quality question that needs live observation rather than a unit test. Flagged that in `docs/agents/ella/followups.md`: Drake spot-checks during normal @ usage over the next few days; if the FIRM AFTER FIRST over-firing recurs, the structural fix is to make the rule fire only when the prior reply's `agent_runs.status='escalated'` (threaded into the fetch).

**Did NOT touch the `author_type='bot'` upstream bug.** Per spec hard stop. Working around it via user_id pairing. The bug stays in `docs/agents/ella/followups.md` waiting for its own spec.

**Did NOT touch passive's `fetch_recent_channel_context`.** Per spec hard stop. Passive's decision Haiku still gets the 15-turn raw context (it's the right shape for "should I interject" judgment).

## Out of scope / deferred

**Already flagged in followups.md (this session's additions):**

- FIRM AFTER FIRST sharpening — pending real-world signal. If the over-firing recurs post-deploy, next step is the structural fix (only consider FIRM AFTER FIRST when the prior reply's `agent_runs.status='escalated'`).
- Co-edit risk on Ella's split prompts (from the prior split spec; still applies — the @-handler's `_AT_MENTION_EXTENSION` and the passive decision Haiku's `_HAIKU_SYSTEM_PROMPT` are two prompts that need co-edit discipline on shared rules).

**Director-spec-worthy follow-ups (NOT done here):**

- **Tune `max_chars` / `lookback_messages` / `n_exchanges` if Drake's post-deploy observation shows truncation tripping often or important prior exchanges missing.** All three are constructor args with sensible defaults; tuning is one-line code changes if needed.
- **Consider deleting `fetch_recent_channel_context` and `_render_recent_channel_context_section` if the passive Sonnet drain ever truly goes away.** `respond_to_passive_trigger` is currently a no-op (post-split); the only remaining caller of `fetch_recent_channel_context` is `passive_monitor.evaluate_passive_trigger`'s decision Haiku, which is still alive. If passive evaluation ever moves off the decision Haiku entirely, the older fetch becomes dead code. Not a near-term concern; flagging for the future-cleanup pile.
- **Consider extracting the inline `_SLACK_MENTION_RE` regex to a shared constant.** Currently duplicated between `ingestion/slack/realtime_ingest.py:_SLACK_MENTION_RE` and `agents/ella/retrieval.py:_SLACK_MENTION_RE`. The cleanest shared home would be `shared/slack_mentions.py` or similar, importable by both layers without the agents-imports-ingestion concern. Defer to a refactor pass.

**Not chased in this pass (out of spec scope):**

- I did NOT investigate whether Drake's smoke-1 FIRM-AFTER-FIRST over-firing pattern actually reproduces with the sharpened rule. The pattern (same question 4× in 10 min) is rare and the structural reframing (escalation-only, not answer-similarity) should resolve it. If it recurs, the next spec's fix is structural (per the followups.md entry).
- I did NOT add a `tsc --noEmit` / `next lint` run. No TypeScript was touched (all Python + Markdown). Confirmed via `git diff --stat`.

## Side effects

**None production-facing during implementation.** All tests stub the network / DB / Slack APIs. No live Anthropic or Slack calls, no DB writes, no webhook fires, no Vercel deploy. Three local pytest runs (114 → 125 → 687 cumulative). Zero throwaway files.

**Will be merged + pushed by Drake (gate (a) deploy) post-this-report.** When that lands, the @ handler picks up the new fetch + sharpened prompt on the first @-mention after deploy. No new env vars, no migration, no kill-switch flip — code-only change. Rollback path is `git revert` on this session's commits.
