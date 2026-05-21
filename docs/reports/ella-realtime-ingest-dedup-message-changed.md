# Report: Ella Realtime-Ingest Dedup — `message_changed` Fix
**Slug:** ella-realtime-ingest-dedup-message-changed
**Spec:** docs/specs/ella-realtime-ingest-dedup-message-changed.md

## Files touched

**Modified:**
- `ingestion/slack/realtime_ingest.py` — added `_insert_audit_terminal` helper and `_PRE_DEDUP_PREFIX` constant alongside the existing `_insert_audit`; moved step 0 (dedup gate) from BEFORE the channel-allowlist gate to AFTER `parse_message`; rebuilt the dedup-key construction to use `record.slack_channel_id` + `record.slack_ts` instead of `event.get("ts")` (outer); rewired the three early-exit branches (non-client channel, ignorable subtype, parser-returned-None) to call `_insert_audit_terminal` instead of `_insert_audit`; exception handler now branches on `step_0_succeeded` to UPDATE the existing row when step 0 fired or INSERT a terminal row when it didn't; result-dict `delivery_id` + `slack_ts` get overwritten with the canonical inner-ts shape post-parse.
- `tests/ingestion/slack/test_realtime_ingest_dedup.py` — deleted the previous spec's `test_message_changed_uses_outer_ts_for_dedup_key` (pinned the broken behavior); rewrote `test_result_dict_carries_delivery_id_for_non_client_channel_path` for the new terminal-INSERT audit-row shape; added 4 new tests covering the new behavior (`test_message_changed_dedups_against_original_message_ts`, `test_message_changed_with_different_inner_ts_processed_separately`, `test_pre_dedup_early_exit_audit_rows_use_pre_dedup_prefix`, `test_happy_path_delivery_id_uses_record_slack_ts`).
- `tests/api/test_slack_events_message_ingest.py` — updated `test_skip_non_client_channel`, `test_skip_ignorable_subtype`, `test_message_deleted_is_skipped_as_ignorable` assertions to reflect that early-exit branches now write a terminal INSERT under `slack_msg_ingest_pre_dedup_` rather than the prior step-0-UPSERT + lifecycle-UPDATE pattern.
- `docs/state.md` — 2026-05-21 entry for this fix + a paired entry for the diagnostic that ran earlier in the day.
- `docs/runbooks/slack_message_ingest.md` — rewrote § Dedup gate to describe the post-parse key construction; added a three-prefix table distinguishing happy-path / forensic-duplicate / pre-dedup audit-row shapes; replaced the single observability query with three (one per prefix).
- `docs/known-issues.md` — corrected the Problem A resolution pointer (the 2026-05-20 ship didn't fully fix it; the 2026-05-21 fix does) and added a NEW entry logging the `author_type='bot'` finding from the diagnostic.
- `docs/agents/ella/ella.md` — trigger pipeline description mentions parse-then-step-0 ordering; changelog entry added.

No new files created. No migrations. No env-var changes. No TS files touched.

## What I did, in plain English

Walked the acclimatization checklist (CLAUDE.md operational patterns, state.md, both predecessor specs + reports, the three core code files, the two test files that pin ingest behavior) and confirmed in 4 bullets:

- **Current pipeline ordering** before this fix: step 0 → channel gate → subtype gate → message_changed unwrap → parse → upsert → audit UPDATE → passive fork. The dedup-key construction at line 88 used `event.get("ts")` (outer ts), which is the EDIT-event ts for `message_changed` deliveries — different from the original message's ts, so edits never deduped.
- **The four `_insert_audit` call sites in `ingest_message_event`**: non-client channel skip, ignorable subtype skip, parser-returned-None skip, happy-path processed. After the refactor, the first three fire BEFORE step 0 so they need a fresh INSERT pattern (the helper `_insert_audit_terminal`); the fourth still UPDATEs the row written by step 0.
- **Test surface to update**: 3 existing tests in `test_slack_events_message_ingest.py` assert the old `webhook_deliveries_upserts` + `webhook_deliveries_updates` shapes for pre-step-0 early exits; 2 tests in `test_realtime_ingest_dedup.py` either pin the broken behavior (delete) or assert the old early-exit shape (update). One new file was not needed — extended the existing dedup test file.
- **Spec's Approach 1** (post-parse dedup + new `_insert_audit_terminal` helper) is the chosen path. New audit-row prefix: `slack_msg_ingest_pre_dedup_{uuid}` so ledger queries can filter by intent.

Four-commit execution per the spec's suggested split:

**Commit 1** added `_insert_audit_terminal` and the `_PRE_DEDUP_PREFIX` / `_HAPPY_PATH_PREFIX` constants without wiring anything in — zero behavioral change, all 694 existing tests stayed green.

**Commit 2** was the structural reorder: moved step 0 from before the channel-allowlist gate to after `parse_message`, rebuilt the dedup-key construction post-parse using `record.slack_channel_id` + `record.slack_ts`, rewired the three early-exit branches to use `_insert_audit_terminal`, added a `step_0_succeeded` flag so the exception handler can pick UPDATE vs terminal INSERT based on whether step 0 fired. Because moving step 0 broke the existing tests' fake-DB-mode assertions for early-exit branches, the test updates needed to keep the suite green were bundled into this commit (same pattern as the previous spec's commit 2). 5 tests failed → 4 updated + 1 deleted (the broken-behavior test that pinned the bug as expected). Full suite went from 694 to 693 (one test deleted, no replacements yet).

**Commit 3** added 4 new tests pinning the new behavior — most critically `test_message_changed_dedups_against_original_message_ts` which simulates the exact production failure mode (original message → edit event with same inner ts but different outer ts → second delivery should dedup). Full suite went 693 → 697.

**Commit 4** updated state.md, the slack ingest runbook, ella.md, and known-issues. The known-issues update was non-trivial because the previous spec's resolution pointer (`docs/known-issues.md` Problem A struck through with resolved-2026-05-20 note) was now misleading — the 2026-05-20 ship didn't fully fix the issue; the 2026-05-21 ship does. I added a resolution note explaining the correction in front of the existing struck-through entry rather than rewriting history. Separately added the new `author_type='bot'` entry per spec § Doc updates.

Hard stops verified:
- **#1 (`_insert_audit` call-site triage)**: all four call sites in `ingest_message_event` sorted explicitly. Three pre-step-0 (channel skip, subtype skip, parser-None) → `_insert_audit_terminal`. One post-step-0 (happy path + exception when step 0 succeeded) → `_insert_audit` UPDATE. Exception path when step 0 didn't fire → `_insert_audit_terminal`. The `_maybe_dispatch_passive_monitor` helper's own error-audit row uses a `passive_monitor_*` prefix and is plain INSERT — unaffected.
- **#2 (UPSERT semantics still work)**: confirmed via the new `test_message_changed_dedups_against_original_message_ts` test — the fake DB's `_seen_upsert_ids` tracking correctly simulates PostgREST's empty-data-on-PK-collision shape, and `_try_register_delivery` returns False on the second call as expected.
- **#3 (malformed-fallback unreachable)**: traced. `slack_channel_id` null → `_lookup_channel(db, None)` returns None at line 304 → non-client-channel branch fires → never reaches step 0. `slack_ts` null → parser line 120 returns None → parser-None branch fires → never reaches step 0. The malformed-fallback `delivery_id = f"slack_msg_ingest_malformed_{uuid.uuid4()}"` is now only used cosmetically for the early result-dict population; the actual step-0 key construction always uses `record.slack_ts` and only runs when `record` exists. Left the cosmetic fallback in place for the result-dict logging — removing it would require a separate refactor of the result-dict-init path and adds no behavioral value.
- **#4 (no migration)**: held — schema unchanged, no SQL written.
- **#5 (pytest ≥694)**: 697 passed.
- **#6 (tsc + next lint clean)**: both green.
- **#7 (no production traffic)**: confirmed. No Slack posts, no cron triggers. The kill switch on the 136 channels stays as Drake set it.
- **#8 (no fix for author_type='bot')**: held — logged in known-issues, no code change in this spec.

## Verification

**pytest:** 697 passed, 2 warnings (pre-existing supabase library deprecation, unrelated). Baseline 694; net +3 from this spec (+4 new dedup tests, -1 deleted broken-behavior test). In the spec's stated target range of 696-698.

**tsc --noEmit:** clean.

**next lint:** `✔ No ESLint warnings or errors`.

**Targeted re-runs:**
- After commit 1 (helper-only): 694/694.
- After commit 2 (gate-move + test updates): 693/693 (one less than baseline because the broken-behavior test was deleted).
- After commit 3 (new dedup tests): 697/697.

**Test that pins the production fix:** `test_message_changed_dedups_against_original_message_ts` simulates the exact shape of the 2026-05-21 production misfire — original message at ts `1745500300.111000`, then a `message_changed` event at outer ts `1745500313.000100` with inner ts `1745500300.111000`. Asserts the second delivery short-circuits with `skipped_reason='duplicate'` and a forensic-duplicate row is written. This test would have caught the production bug had it been written when the previous spec shipped.

## Surprises and judgment calls

**The previous spec's report claimed "this gate is structurally race-proof" and "duplicates short-circuit before any side effect."** Both claims were true in the abstract (the UPSERT semantics work; PK collisions are atomic) but didn't catch that the KEY shape was wrong for the most common duplicate pattern in production (edits). Today's fix doesn't change the gate's atomicity claim — it changes what the gate dedups against. The structural shape is sound; the key was wrong. The judgment failure was treating "Slack edits are rare in client channels" as a self-evident assumption rather than verifying it against production traffic before declaring the gate done.

**The exception handler now needs to know whether step 0 fired.** Today's design uses a local `step_0_succeeded` boolean flag. An alternative considered: have the exception handler attempt the UPDATE first, then fall through to a terminal INSERT if zero rows were affected. The flag is simpler, has no extra DB calls, and the cost is one boolean — chose the flag. Documenting this so a future refactor doesn't accidentally drop the flag.

**Removed the malformed-fallback only cosmetically, not from the code.** Per hard stop #3 the malformed-fallback `slack_msg_ingest_malformed_{uuid}` was theoretically unreachable after the reorder. Verified by tracing — null channel falls into non-client gate, null ts falls into parser-None gate. But the fallback is still computed early in the function for the result-dict's `delivery_id` field; removing it would require a separate refactor that returns a different result-dict shape, and that's wider scope than the spec warrants. Left it in place; it's effectively dead but cheap.

**The previous spec's report contradicted the production-evidence findings.** From `docs/reports/ella-realtime-ingest-idempotency.md`: *"`message_changed` dedup behavior is now pinned by test."* and *"Only a *retry* of the same edit-event has the same outer ts and gets correctly deduped."* Both claims were technically accurate descriptions of the implemented behavior but missed that the implemented behavior was wrong. I wrote both that report and this one — flagging the contradiction here per gate (b) so future-me / future-Director reading the documentation chain understands the prior report's framing was based on a flawed assumption.

**The `_insert_audit_terminal` helper's prefix is parameterized but only ever called with `_PRE_DEDUP_PREFIX`.** Considered hard-coding the prefix into the helper, but kept it parameterized in case a future spec needs another terminal-row shape (e.g., a separate "step-0 fail-open with audit" path). Cost is one parameter; flexibility is one less refactor later.

**The audit-row prefix discrimination was an explicit design choice rather than relying on existing fields.** Could have used `webhook_deliveries.source` for this (e.g., adding a new source like `slack_message_ingest_terminal`), but the existing source column already discriminates ingestion-source vs other webhook types and overloading it would muddy that. The prefix approach keeps source semantically clean while making intent-based filtering trivial. Documenting in the runbook so operators can write the right queries.

## Out of scope / deferred

- **The smoke gate (Drake's gate (c))**: three test cases in `#ella-test-drakeonly` need to be validated post-deploy: first-delivery happy path, edit-event dedup (the critical one), two-distinct-messages-don't-false-dedup. Spec stays `in-flight` until Drake signals all three pass. Same Option A pattern as the previous two specs.
- **Production resume** of the 136 paused channels — single SQL UPDATE flipping `passive_monitoring_enabled = true WHERE test_mode = false`. Drake's call when to execute after smoke passes. Not Builder's call.
- **The `author_type='bot'` for Ella's posts finding**: logged in known-issues but NOT fixed in this spec per hard stop #8. Separate spec needed once production is stable post-dedup-fix.
- **Edits that add critical content**: per spec § What could go wrong #1, the new behavior suppresses Ella's second pass on edits. If a client edits to add critical context (e.g., pasting an error message), Ella sees only the pre-edit text. Accepted trade-off matching the prior spec's stated intent; future spec could add distinct-edit detection if this becomes real friction.
- **Spec status flip**: per the spec's "Done means" line — *"Spec status flipped to `shipped` in the same Builder commit-sequence as the report"* — but Drake's gate (c) smoke is also listed. Same Option A reasoning as before: I'll commit the report with the spec status left as `in-flight`. Drake flips after smoke passes.

## Side effects

None beyond the committed diff. No Slack posts, no DB writes outside the local commits, no production data touched. The kill switch on the 136 channels stays as-is. Five commits total: 4 logical + 1 report.

## What's needed to unblock

**Drake's gate (c) smoke validation in `#ella-test-drakeonly`** — three test cases:

1. Normal first-delivery happy path — one `webhook_deliveries` row with `webhook_id = slack_msg_ingest_{channel}_{ts}`, `processing_status='processed'`.
2. **Edit-event dedup (the critical fix)** — post a message, wait, edit it. Verify `slack_messages.text` updates (existing upsert), NO duplicate `agent_runs` entry, NO second in-channel ack from Ella, AND a `slack_msg_ingest_dup_*` row appears with `processing_status='duplicate'` and `payload.original_delivery_id` referencing the first delivery.
3. Two distinct messages in close succession — both process normally, no false dedup, two distinct `slack_msg_ingest_{channel}_{ts}` rows.

If case 2 fails, write a partial report and the spec stays `in-flight`. If all three pass, flip the spec to `shipped` and the production resume is unblocked (single `UPDATE slack_channels SET passive_monitoring_enabled = true WHERE test_mode = false`).

This is the third spec landing today (after the morning's diagnostic and the afternoon's fix) closing out the 2026-05-19 EOD misfire's structural follow-ups. With smoke validation, production passive monitoring is ready to come back fully.
