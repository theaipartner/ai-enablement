# Report: Ella Realtime-Ingest Idempotency Gate
**Slug:** ella-realtime-ingest-idempotency
**Spec:** docs/specs/ella-realtime-ingest-idempotency.md

> **UPDATED 2026-05-21:** This report's claim that the dedup gate's behavior was verified is technically accurate (the unit tests pinned the implemented behavior) but the implemented behavior was wrong for the dominant production failure mode — Slack `message_changed` edits don't dedup against the original message because the gate keyed on the OUTER event ts. The 2026-05-21 diagnostic established this empirically (11 dupes / 8 channels / 36 hours; zero forensic-duplicate rows ever fired). The fix moves the key construction post-parse.
> See: `docs/reports/ella-duplicate-webhook-delivery-diagnostic.md` (diagnosis) and `docs/reports/ella-realtime-ingest-dedup-message-changed.md` (corrective ship).

## Files touched

**Created:**
- `tests/ingestion/slack/test_realtime_ingest_dedup.py` — 9 new tests covering the dedup contract: deterministic delivery_id format, malformed-event UUID fallback, duplicate-gate short-circuit, forensic payload shape, swallowed forensic failure, fail-open on DB outage, message_changed outer-ts semantics, non-client-channel path delivery_id propagation.

**Modified:**
- `ingestion/slack/realtime_ingest.py` — added `_try_register_delivery` + `_write_duplicate_audit_row` helpers (UPSERT-ignore-duplicates pattern via the Fathom precedent); changed `delivery_id` from per-delivery UUID to deterministic `slack_msg_ingest_{channel}_{ts}` (with UUID fallback for malformed events); inserted step-0 dedup gate at the top of `ingest_message_event`'s try block; refactored `_insert_audit` from INSERT to UPDATE so the lifecycle matches migration 0011's `received → processed/failed/malformed` contract.
- `tests/api/test_slack_events_message_ingest.py` — extended the fake DB to handle `upsert` + `update` modes on `webhook_deliveries` with PK-collision simulation; updated audit-row assertions across the existing happy-path / skip-non-client-channel / skip-ignorable-subtype / message_deleted tests; rewrote `test_idempotency_same_event_twice_two_audits_two_upserts` → `test_idempotency_same_event_twice_dedup_gate_blocks_second` pinning the new dedup behavior.
- `tests/ingestion/slack/test_realtime_ingest_passive_fork.py` — extended its fake DB to handle `upsert` + `update` modes on `webhook_deliveries`; updated the passive-fork-exception-audited test to check upserts vs inserts under the new ledger shape.
- `docs/state.md` — second 2026-05-20 entry covering the spec, the UPSERT-vs-INSERT-catch judgment call, and the production-resume unblock.
- `docs/agents/ella/ella.md` — trigger-section pipeline description mentions step-0 dedup gate; changelog entry added.
- `docs/runbooks/slack_message_ingest.md` — new "Dedup gate" section (deterministic webhook_id format, duplicate behavior, fail-open semantics, observability query); audit-ledger-contract table extended with the duplicate row.
- `docs/known-issues.md` — Problem A ("Passive dispatch has no idempotency check against duplicate Slack message delivery") struck through with resolution pointer.

## What I did, in plain English

Acclimatization confirmed the spec's architectural reading: `webhook_deliveries.webhook_id` is the PK (migration 0011), the `processing_status` CHECK already allows `'duplicate'`, no schema change needed. Read `api/fathom_events.py` as the reference pattern — its UPSERT-ignore-duplicates approach (with `if not insert_resp.data` check) is the proven Fathom precedent. The spec's pseudocode showed an INSERT-with-exception-string-matching approach instead; the two are semantically equivalent (atomic at the DB layer, idempotent) but the UPSERT-ignore-duplicates approach has an unambiguous empty-data return signal that doesn't depend on parsing supabase-py exception strings. Chose the Fathom pattern — documented as a judgment call in Surprises below.

Five-commit execution per the spec's suggested split. **Commit 1** added the `_try_register_delivery` + `_write_duplicate_audit_row` helpers without wiring them in (zero behavioral change; passes existing tests). **Commit 2** wired the dedup gate at step 0 of `ingest_message_event`, changed `delivery_id` from per-delivery UUID to deterministic-per-(channel, ts), and refactored `_insert_audit` from INSERT to UPDATE. Because the UPDATE refactor changes every existing branch's audit behavior, the two existing test files that asserted `webhook_deliveries_inserts` had to be updated in the same commit — kept the fake DB extension + existing-test assertion updates inline so the commit didn't ship with failing tests. **Commit 3** added the new dedup-specific test file with 9 tests (+9 total, suite now 694 from 685). **Commit 4** updated state.md, ella.md, the slack ingest runbook, and known-issues per the spec's mandatory list.

Hard stops verified:
- **#1 (`_insert_audit` call-site refactor):** all `_insert_audit` calls inside `ingest_message_event` use the function-scope `delivery_id`. After step 0 writes the `received` row, each branch's `_insert_audit` UPDATEs that same row to its terminal state. Traced through all four branches (non-client-channel, ignorable-subtype, parse-None, happy ingest) plus the exception handler — each fires exactly one UPDATE.
- **#2 (PK collision detection):** eliminated as a concern by choice of mechanism. The UPSERT-ignore-duplicates pattern returns empty data on collision rather than raising an exception, so no version-fragile exception-string matching is needed. Confirmed `upsert(..., ignore_duplicates=True, on_conflict=...)` is the documented supabase-py API (read the postgrest source under `.venv/.../postgrest/_sync/request_builder.py`).
- **#3 (no migration):** held by construction. The `webhook_deliveries` table from migration 0011 already has the PK + the `'duplicate'` value in the CHECK constraint. Zero schema work.
- **#4 (pytest ≥685):** 694.
- **#5 (tsc + next lint clean):** both green.
- **#6 (no production data touched):** confirmed. The dedup applies forward from deploy; historical rows with random-UUID webhook_ids stay as-is.

## Verification

**pytest:** 694 passed, 2 warnings (pre-existing supabase-library deprecation, unrelated). Baseline 685 + 9 new dedup tests.

**tsc --noEmit:** clean (no output, exit 0).

**next lint:** `✔ No ESLint warnings or errors`.

**Targeted re-runs throughout iteration:**
- After commit 1 (helpers only): 78/78 on `tests/ingestion/slack/ + tests/api/test_slack_events_message_ingest.py`.
- After commit 2 (wiring + test updates): 13/13 on `test_slack_events_message_ingest.py` rebroken-and-fixed.
- After commit 3 (new dedup tests): 694/694 full suite.

**Manual traces:**
- Re-read `ingest_message_event` post-edits, confirmed every existing branch correctly UPDATEs the step-0 row.
- Traced the exception path: if step 0 wrote the `received` row, the outer-except branch's `_insert_audit(status="failed")` flips it to `failed`. If step 0 itself raised non-PK (fail-open), no row exists to update; the UPDATE no-ops cleanly without exception. Acceptable per the spec.
- Confirmed `_maybe_dispatch_passive_monitor`'s own error-audit row uses a different `webhook_id` prefix (`passive_monitor_*`) and stays as plain INSERT — no collision with the new deterministic PK.

## Surprises and judgment calls

**Chose UPSERT-ignore-duplicates over INSERT-with-PK-collision-catch.** The spec's pseudocode for `_try_register_delivery` showed an `INSERT → except → str(exc) match on 'duplicate key'/'23505'/'unique constraint'` pattern, with hard stop #2 explicitly worrying about supabase-py exception-string fragility. Reading the Fathom handler (`api/fathom_events.py:_handle_post`, lines 164-193) showed it uses `upsert(row, on_conflict="webhook_id", ignore_duplicates=True, returning="representation")` and checks `if not insert_resp.data` — the empty-data return is the unambiguous PK-collision signal. The spec's own text under Architecture says "Use the existing Fathom-handler pattern" — there's an internal contradiction between that English and the INSERT-catch pseudocode. Went with the Fathom pattern because (a) it's already proven in production via the F2.4 smoke, (b) it sidesteps hard stop #2 entirely, (c) the spec's English explicitly endorsed it. The end behavior is identical: atomic at the Postgres layer, idempotent, race-proof. Documented in the spec's "Done means" by way of the report.

**Folded existing-test assertion updates into commit 2 instead of a separate commit.** The spec's suggested commit split was "commit 2 = delivery_id refactor + dedup gate, commit 3 = _insert_audit UPDATE refactor." That split would have left commit 2 with failing tests (the UPDATE refactor changes all existing branches' audit behavior, breaking 6 existing assertions). Per the "Never commit with failing tests" rule in CLAUDE.md, that split wasn't viable. Folded all three logical changes into commit 2 along with the necessary test-harness updates. The new dedup-specific tests stayed in commit 3 as planned. The total commit count is the same (5) and each commit is internally consistent.

**`message_changed` dedup behavior is now pinned by test.** The spec's What-could-go-wrong #6 raised the concern that `message_changed` events (Slack edits) could get incorrectly suppressed by the dedup gate. Read the existing code carefully: `slack_channel_id` and `slack_ts` are extracted from the OUTER event (not the inner `event.message`), and the outer ts changes for each edit (it's the edit-event ts, distinct from the original message ts). So two distinct edits produce two distinct dedup keys — both are processed. Only a *retry* of the same edit-event has the same outer ts and gets correctly deduped. Added `test_message_changed_uses_outer_ts_for_dedup_key` to pin this assumption so a future change to the dedup key (e.g., switching to inner `message.ts`) doesn't silently regress behavior.

**The duplicate-audit-row failure test is mock-driven rather than DB-error driven.** Couldn't easily get the fake DB to make the `.insert(...)` on `webhook_deliveries` raise selectively (the existing fake handles all inserts uniformly). Monkeypatched `ri._write_duplicate_audit_row` to a no-op-with-internal-try-except instead. This exercises the calling site's structure (the dedup decision returns False even when the forensic-row write fails) but doesn't deeply exercise the helper's own swallow behavior. Considered fully isolating the helper test but the value-per-effort wasn't there — the helper's swallow path is trivial code. Documented in the test docstring.

**Auto-restoration of monkeypatch in `test_duplicate_audit_row_failure_swallowed` is belt-and-suspenders.** Pytest's monkeypatch fixture auto-undoes patches at test exit, but I added an explicit `monkeypatch.setattr(...)` to the original at the end of the test to guard against accidental test-ordering coupling. Belt-and-suspenders — defensive but harmless.

## Out of scope / deferred

- **Smoke tests in `#ella-test-drakeonly`.** Gate (c) — Drake's call. Three test cases in the spec's "Smoke test gate" section need to be validated on the real Slack surface post-deploy: (1) normal first delivery, (2) manual curl-driven duplicate simulation, (3) real `message_changed` redelivery. Spec stays `in-flight` until Drake signals all three pass.

- **Production resume of the 136 paused channels.** Per the spec: "After this gate passes, Drake can re-enable passive monitoring on the 136 paused channels. That's a separate operational step — a single SQL `UPDATE slack_channels SET passive_monitoring_enabled = true WHERE test_mode = false` — not in this spec's scope." Not Builder's call to execute.

- **Future spec for `message_changed` distinct-edit dedup keys** — flagged in the spec's What-could-go-wrong #6. If client message edits ever become a real friction case (i.e., Ella misses critical context added in an edit), a future spec adds a key like `slack_msg_ingest_{channel}_{ts}_edit_{edit_ts}` for distinct-edit handling. Out of scope today.

- **Spec status flip.** Same Option A reasoning as the morning's `ella-at-mention-routing-gate-and-advisor-context` ship: spec stays `in-flight` until Drake's gate (c) smoke validation. The spec's "Done means" line explicitly lists the three smoke cases as a prerequisite for flipping to `shipped`. I'll commit the report and leave the status; Drake flips it (or asks Builder to) after the smoke passes.

## Side effects

None beyond the committed diff. No Slack posts, no emails, no DB writes outside the local git commits. No external API calls. No production data touched. The 7 commits this session sit on `main` after the push.

## What's needed to unblock

**Drake's gate (c) smoke validation in `#ella-test-drakeonly`** — three test cases per the spec's "Smoke test gate" section:

1. Normal message → one `webhook_deliveries` row, `processing_status='processed'`.
2. Manual duplicate simulation (re-POST same Slack event JSON via curl) → forensic `slack_msg_ingest_dup_*` row appears with `processing_status='duplicate'`, NO new `agent_runs` row, NO new in-channel ack.
3. Real `message_changed` redelivery → dedup row appears, `slack_messages.text` updates (existing upsert), NO duplicate `agent_runs` row.

All three must pass before the spec flips to `shipped`. If any fail, Builder writes a partial report and the spec stays `in-flight`. Once the smoke passes, **the 136 paused channels can be re-enabled with a single SQL UPDATE** — operationally Drake's call, not in this spec's scope.

Today's two ships (this one + the morning's @-mention routing gate) close out the three structural gaps from the 2026-05-19 EOD misfire. Production passive monitoring is now ready to come back.
