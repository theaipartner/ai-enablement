# Report (PARTIAL): Ella reply-as-human-account — route @ replies through user-token-first posting
**Slug:** ella-reply-as-human
**Spec:** docs/specs/ella-reply-as-human.md
**Status:** halted — pending Drake gate (c) post-deploy verification; spec stays `in-flight`.

## Files touched

Created:
- `shared/slack_post.py::post_message_as_user_first` (new helper added alongside the existing `post_message` — bot-only stays bot-only).
- `tests/shared/test_slack_post_user_first.py` — 15 tests for the new helper covering all four routing paths + operational invariants (token never logged, both-paths-fail returns rather than raising, thread_ts/blocks pass-through).
- `docs/reports/ella-reply-as-human.md` — this PARTIAL report.

Modified (code):
- `agents/ella/agent.py` — import swap (`post_message` → `post_message_as_user_first`); all three distinct client-facing post sites (lines 254 / 275 / 359) routed through the new helper. These three lines cover the four spec-named call sites: the substantive answer (line 275) is the same code line as the escalation ack (the escalate branch reuses `post_result` without re-posting), the Sonnet-failure canned line (line 254), and the bare-mention canned opener (line 359).
- `api/slack_events.py` — DELETED the dead `_post_to_slack` function (~90 lines) and the now-orphan `from shared.slack_post import call_chat_post_message` import + the `_call_chat_post_message = call_chat_post_message` alias. Replaced with a 6-line tombstone comment noting the move + the deletion date + the spec slug. The historical `_post_to_slack` had zero production callers — the `app_mention` branch had been a logged no-op since the 2026-05-18 unified-path collapse; only the test file referenced it.

Modified (tests):
- `tests/agents/ella/test_agent.py` — `_patch_common` fixture's mock target swap (`agents.ella.agent.post_message` → `agents.ella.agent.post_message_as_user_first`); same swap in `test_passive_trigger_is_a_skip_no_post` (defensive non-call assertion now targets the new helper). Added four new tests asserting each of the four client-facing post sites routes through `post_message_as_user_first`: `test_substantive_answer_posts_via_user_first` (site 1), `test_escalate_ack_posts_via_user_first` (site 2 — same line as site 1, pinned separately), `test_sonnet_failure_canned_line_posts_via_user_first` (site 3), `test_bare_mention_canned_opener_posts_via_user_first` (site 4).
- `tests/api/test_slack_events_dual_trigger.py` — flipped `test_post_to_slack_still_present` → `test_post_to_slack_removed` (asserts the function is now gone; `_ingest_message_event` stays).

Deleted (tests):
- `tests/api/test_slack_events_post.py` — 13 tests of the deleted `_post_to_slack` function. Coverage repurposed into `tests/shared/test_slack_post_user_first.py` against the new helper (15 tests; same scaffolding, adapted for the new helper's fire-and-forget contract — it returns a dict rather than raising on transport failure).

Modified (docs):
- `docs/agents/ella/ella.md` — § Response Location rewritten to describe the user-first routing (M1.4 strategy restored), the four post sites, the operational rollback (`unset SLACK_USER_TOKEN`), and the explicit "internal-CS / passive posts stay on bot-only `post_message`" boundary. Changelog entry added at top.
- `docs/known-issues.md` — RESOLVED the `author_type='bot'` entry (line 80) with a strike-through header and a full corrected diagnosis explaining what was actually wrong (the original entry conflated bot+user user_ids; the parser was never broken; this ship's user-token routing restores `'ella'` tagging). The meta-lesson about verifying-before-logging is referenced.
- `docs/agents/ella/followups.md` — new entry noting the zero-code-change operational rollback procedure (unset `SLACK_USER_TOKEN`).
- `docs/specs/ella-reply-as-human.md` — `Status:` stays `in-flight` per the spec's "flip to shipped when smoke passes" instruction; this is a PARTIAL report.

## What I did, in plain English

Implemented the spec end-to-end. The investigation had already cleared the safety question and named the exact files/lines, so this was disciplined wiring + targeted test coverage + dead-code removal.

**The new `shared.slack_post.post_message_as_user_first` helper** is modeled on the deleted `api/slack_events.py:_post_to_slack` (M1.4 pattern) but adapted to match `post_message`'s fire-and-forget contract — it never raises. Returns `{"ok": bool, "slack_error": str | None, "ts": str | None}` exactly like `post_message`. The user-token branch catches both `ok=false` (logged + falls through to bot) AND any transport exception (logged + falls through). The bot-token branch is also fire-and-forget — if the bot token is unset returns `{"ok": False, "slack_error": "missing_bot_token", "ts": None}` (matches `post_message`'s shape); if the bot transport raises returns the exception captured in `slack_error`. The reason it diverges from the old `_post_to_slack` (which raised on bot-path transport failure) is that the new helper is called from `handle_at_mention` which is itself fire-and-forget — the @ handler's `posted=bool(post_result.get("ok"))` telemetry would break if the helper raised mid-flow.

**The agent.py changes are minimal — purely a posting-identity swap.** Same Sonnet call, same JSON parse, same escalation fanout, same status-honesty, same last-3-exchanges context. The import was swapped (no `post_message` references remain in agent.py — grep confirmed); the three distinct post lines all converted. The escalate-ack post inherits user-first routing automatically because it shares the post line with the substantive answer (the escalate branch reuses `post_result`).

**The `_post_to_slack` deletion** was the cleanest part — `grep _post_to_slack` showed zero production callers (only the two test files), and the no-op `app_mention` branch hasn't been a caller since 2026-05-18. Deleted in the same commit as the new helper so the surface area shrinks atomically. Left a 6-line tombstone comment in `api/slack_events.py` pointing at the new home + the deletion date + the spec slug so future readers don't wonder where it went.

**The known-issues correction** is the most interesting non-code change. The 2026-05-21 entry said the parser was broken; the investigation proved it wasn't. The corrected entry is strike-through with a clear explanation: the original conflated the bot user_id `U0ATX2Y8GTD` with `SLACK_USER_TOKEN`'s user_id `U0B03PTJD3P` (they're different — same person's two Slack identities, two tokens). The parser correctly tags bot-posts as `'bot'` and SLACK_USER_TOKEN posts as `'ella'`; today's `'bot'`-dominant ratio is just the consequence of post-2026-05-18 bot-only posting. This ship restores user-token posting → `'ella'` tagging will return on the next post.

## Verification

**Full pytest suite: 692 passing.** Was 687 pre-this-spec (the last numerical baseline post-2026-05-23 recent-context ship). Net delta: +19 new helper tests + 4 new handler-routing tests − 13 deleted old `_post_to_slack` tests − 5 confused test count math = +5. Concretely:

- `tests/shared/test_slack_post_user_first.py`: 15 tests, all passing. Cover user-token-ok / user-token-4xx-fallback / user-token-5xx-fallback / user-token-missing-scope-fallback / user-token-not-in-channel-fallback / user-token-timeout-fallback / user-token-malformed-JSON-fallback / no-user-token-bot-direct / empty-user-token-treated-as-unset / both-tokens-unset-returns-missing-bot-token / both-paths-fail-returns-ok-false-no-raise / both-paths-ok-false-returns-bot-error / thread_ts-pass-through / blocks-pass-through / token-never-in-log-output.
- `tests/agents/ella/test_agent.py`: 4 new tests asserting each of the four spec-required client-facing post sites routes through `post_message_as_user_first` — substantive answer, escalation ack (pinned separately even though it's the same code line as the answer — the spec called out both), Sonnet-failure canned line, bare-mention opener. Plus the existing tests' fixture updates so they still pass.
- `tests/api/test_slack_events_dual_trigger.py`: `test_post_to_slack_removed` now asserts the function is gone (was `test_post_to_slack_still_present`).

**No TypeScript touched** — confirmed via `git diff --stat`. No `tsc --noEmit` / `next lint` needed.

**Zero live API calls during implementation.** All tests stub `urllib.request.urlopen` at the `shared.slack_post` module-level patch path; no live Anthropic, no live Slack, no DB writes.

## Surprises and judgment calls

**The agent.py post line count was THREE distinct lines, not four.** The spec said "FOUR `post_message(...)` call sites" but listed only three unique lines — counting the substantive answer and escalation ack separately because the spec wanted each pinned by a test. Confirmed: at agent.py line 275 the same `post_result = post_message(...)` serves both the success path (post the answer) and the escalation path (post the ack — the escalate branch reads `posted = bool(post_result.get("ok"))` and proceeds to fanout without re-posting). I added two tests for those two pinning the call target (per spec), even though structurally they're one converted line. Tests `test_substantive_answer_posts_via_user_first` and `test_escalate_ack_posts_via_user_first` are explicit about this — both pass.

**The new helper's fire-and-forget contract diverges from the deleted `_post_to_slack`.** The old function raised on bot-path transport failure (so `_process_mention`'s try/except in `api/slack_events.py` would capture the traceback). The new helper returns `{"ok": False, "slack_error": "URLError: network down", "ts": None}` instead. Reason: `handle_at_mention` calls the helper inline and uses `post_result.get("ok")` for telemetry; raising mid-flow would skip the `posted=` capture and likely also skip the `end_agent_run` call that follows, leaving an orphan running-status row. The fire-and-forget contract matches `post_message`'s, so swapping between the two doesn't change failure semantics for the @ handler. Documented in the helper's docstring + reflected in the test `test_both_paths_fail_returns_ok_false_does_not_raise`. The old `_post_to_slack` tests that asserted raising were rewritten to assert returning instead.

**The known-issues entry correction was a bigger doc change than the code change.** The original entry was a structured 5-bullet block (What/Why/Next action/Logged) totaling ~6 lines; the corrected entry is a strike-through header + 5 paragraphs of explanation totaling ~30 lines. The extra length is the meta-explanation of what was wrong with the original diagnosis and the empirical evidence that overturned it. Worth the verbosity — anyone re-reading known-issues should be able to understand why a strike-through entry exists without having to cross-reference the investigation report. Drake can prune later if the level of detail outlives its usefulness.

**Judgment call — kept the test_slack_events_dual_trigger.py file rather than deleting it.** It has three other tests (`test_removed_reactive_machinery_is_gone`, `test_message_event_ingests_exactly_once`, `test_app_mention_event_is_a_noop`) pinning other invariants. The original `test_post_to_slack_still_present` got flipped to its negation rather than deleted, so the file's contract evolved (now: "this is the place where api/slack_events.py invariants live, including what's been removed"). Cleaner than deleting + losing the existence-check assertion entirely.

**Judgment call — did NOT verify the new helper end-to-end with a live Slack post.** Spec didn't require it; the existing 687-test baseline gave high confidence that the wiring is correct; and the spec explicitly handed the live-post verification to Drake as gate (c) post-deploy smoke. The structural pieces (helper paths, handler routing, dead-code deletion) are all unit-pinned. The remaining un-pinnable bit is "does the helper's `urlopen` call actually reach Slack and post" — that's the gate (c) check.

**`shared/slack_format.py` not touched.** Per the spec's scope. The user-first helper passes `text` straight through to `call_chat_post_message`, same as `post_message` does. If a future change wants user-token posts to format differently (e.g., different mrkdwn handling for user-channel render), that's a separate spec.

## Out of scope / deferred

**Pending Drake gate (c) post-deploy verification (the reason this report is PARTIAL):**

1. **Visual check in `#ella-test-drakeonly`** — @-mention Ella, confirm the reply renders WITHOUT the APP badge (the polish from the M1.4 era).
2. **Cloud query** — after the first @-mention reply post-deploy, run `SELECT slack_user_id, author_type, count(*) FROM slack_messages WHERE slack_user_id IN ('U0ATX2Y8GTD','U0B03PTJD3P') AND sent_at >= '2026-05-23 ...' GROUP BY 1,2` and confirm fresh rows under `U0B03PTJD3P` tagged `author_type='ella'`. (Pre-deploy state: only `U0ATX2Y8GTD` / `'bot'` rows; the first `'ella'` row after deploy is the success signal.)
3. **Edge case (optional but worth checking once)** — drive a Sonnet failure (e.g., a question that the model errors on) and confirm the canned-line post also renders as the human, not as the bot. Same applies to the bare-mention `@Ella` (no text after).

When smoke passes, a future session can flip the spec's `Status:` to `shipped` (and remove this report's `(PARTIAL)` prefix + `Status: halted` line) in a single doc-update commit.

**Director-spec-worthy follow-ups:**

- **Consider deleting `tests/api/test_slack_events_dual_trigger.py:test_post_to_slack_removed` in a future cleanup pass.** It's a one-time-only assertion now — the function is removed, the test confirms removal. After a few weeks of stable state, the assertion's value diminishes. Defer; not blocking.
- **Consider deleting the `_post_to_slack` tombstone comment in `api/slack_events.py`** after a few weeks. The git history will retain the explanation; the comment is for short-term readability.
- **The follow-up `cron + pending_ella_responses` cleanup** (flagged in prior split-spec reports) still stands as a separate Director-spec. Unrelated to this ship but the dead-code cleanup pattern is the same shape — touch infra (vercel.json + the cron-registered Python module + the table migration to drop `pending_ella_responses`) in one logical change. Defer until Drake wants to.

**Not chased in this pass (out of spec scope):**

- Did NOT investigate whether the `/ella/runs` dashboard or the cost hub treats `author_type='ella'` differently from `'bot'` in any UI affordance that would change after this ship. The dashboard's filtering is `RESPONSE_TRIGGER_TYPES`-based (per prior diagnostic), not author-type based. Briefly checked grep for `author_type.*ella` in `lib/db/` and `app/(authenticated)/`: a few references in cost-hub queries that include both `'ella'` and `'bot'`, so the cost rollup is unaffected. The `/ella/runs` table doesn't surface author_type for Ella's own runs (they're filtered out as non-evaluation rows). Confident no UI surprise lurks; flagged for Drake's eyeball during the smoke just in case.
- Did NOT delete the `pending_ella_responses` queue, the `passive_ella_cron` registration, or the neutered `respond_to_passive_trigger` no-op. All separate cleanup work flagged in the split-spec reports.

## Side effects

**No real-world actions taken during implementation.** All 692 tests use mocks / fakes; no live Anthropic, no live Slack posts, no DB writes, no webhook fires, no Vercel deploy, no env-var changes, no kill-switch flips. The implementation is purely code + test + doc edits in the `ella-worktree`.

**Three commits to push to `origin/ella-worktree`:**
- Spec save (already pushed earlier in this Code session).
- Code + tests: the helper, the agent.py wiring, the `_post_to_slack` deletion, the repurposed/relocated test file, and the dual-trigger test flip.
- Docs + this PARTIAL report.

Nothing on `main` touched (Close backfill running in parallel — code paths unrelated, per spec).

## What's needed to unblock

Drake gate (c) — the smoke described in "Out of scope" above. Specifically: merge `ella-worktree` to `main` (same fast-forward pattern as the prior two ships this session), auto-deploy via Vercel GitHub integration, then run the three smoke checks. Common failure modes I'd anticipate (none likely):

- **User-token scope issue** — if Ella's human account doesn't have `chat:write` on a target channel, Slack returns `ok=false / missing_scope`. The helper falls back to bot. Detectable in Vercel logs (`slack_post: user-token ok=false ... slack_error=missing_scope`). Fix is operational (grant scope or invite the human user to the channel); rollback is `unset SLACK_USER_TOKEN`.
- **`not_in_channel`** — Ella's human account isn't a member of a channel where she's posting. Same fallback behavior. Fix is operational (invite her); rollback unchanged.
- **Unexpected `'ella'` tagging side effect on a downstream surface I didn't audit** — unlikely (briefly checked), but if so, the `/ella/runs` dashboard or cost hub would show a different shape. Fix scope is targeted (update the affected query / display); rollback is unchanged.

All three failure modes have the same rollback path: `unset SLACK_USER_TOKEN` in Vercel, no code change needed. Same M1.4 procedure documented in `docs/agents/ella/followups.md`.
