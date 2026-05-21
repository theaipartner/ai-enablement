# Ella Realtime-Ingest Dedup — `message_changed` Fix

**Slug:** ella-realtime-ingest-dedup-message-changed
**Status:** in-flight

## Context

Follow-up to the 2026-05-21 diagnostic (`docs/specs/ella-duplicate-webhook-delivery-diagnostic.md` + the report at `docs/reports/ella-duplicate-webhook-delivery-diagnostic.md`). The diagnostic confirmed empirically that Slack `message_changed` events have a different OUTER `event.ts` than the original `message` event for the same logical message. The dedup gate shipped 2026-05-20 (`ella-realtime-ingest-idempotency.md`) builds its key from `event.get("ts")` (outer event ts), so the two deliveries land with non-equal webhook_ids and the PK collision the gate relies on never fires. The full pipeline runs twice: two `slack_messages` upserts, two passive-monitor evaluations, two `acknowledge_and_escalate` decisions, two in-channel acks, two `escalations` rows, four DMs (Scott + primary CSM × 2).

**Production scope as of the diagnostic:** 11 documented duplicate dispatches across 8 channels in ~36 hours of post-2026-05-20 traffic. Zero `slack_msg_ingest_dup_*` audit rows have been written since the gate landed — the gate has never caught a true duplicate in production. The duplicate-shape signature is unambiguous: one webhook_id encodes the natural high-entropy original ts (e.g. `...969.851479`), the other encodes a clean-microsecond edit-event ts (e.g. `...983.000100`) within seconds. The `slack_messages.raw_payload.edited.ts` field empirically ties the second webhook_id's encoded ts to the user's edit event.

**The previous spec acknowledged this failure mode in advance and classified it "acceptable for v1."** From `ella-realtime-ingest-idempotency.md` § What could go wrong #6: *"This is acceptable for v1 — Slack edits are rare in client channels, and the misfire cost from processing edits as new messages is higher than the cost of missing the occasional edit."* That judgment under-estimated edit frequency in coaching channels. Production reality is 11 dupes / 36 hours.

**Current production posture:** Kill switch flipped 2026-05-21 (`UPDATE slack_channels SET passive_monitoring_enabled = false WHERE test_mode = false`). 136 channels paused. `#ella-test-drakeonly` (test_mode=true) remains enabled for smoke validation. Production resume is gated on this spec landing + gate (c) smoke passing.

## The fix

**Move the dedup-key construction post-parse so it keys on the inner/stable message ts.** Today's code (lines 86-91 of `ingestion/slack/realtime_ingest.py`):

```python
slack_channel_id = event.get("channel")
slack_ts = event.get("ts")
...
if slack_channel_id and slack_ts:
    delivery_id = f"slack_msg_ingest_{slack_channel_id}_{slack_ts}"
else:
    delivery_id = f"slack_msg_ingest_malformed_{uuid.uuid4()}"
```

For a `message_changed` event, `event.get("ts")` is the EDIT-event ts (e.g., `1779309983.000100`), not the original message's ts. The parser later unwraps `event.message` for `message_changed` and pulls the inner ts — which is what we actually want as the dedup key. The fix is to defer the dedup-key construction until after the parser has resolved the canonical message ts, then use THAT for the key.

**The structural shape:** Step 0's dedup gate moves from "before any parsing" to "after parsing, before any side effect." The gate's job hasn't changed — it still does an atomic UPSERT against `webhook_deliveries.webhook_id` and short-circuits on PK collision. Only the key construction changes.

**What still works the same:**
- Channel-allowlist gate stays before the dedup gate (cheap pre-filter; no need to parse non-client channel messages).
- Subtype gate stays before the dedup gate (system messages get filtered without parsing).
- Parser invocation stays the same — including the existing `message_changed` unwrap that pulls `event.message` into `event_for_parser`.
- `_upsert_message`, `_maybe_dispatch_passive_monitor`, all downstream side effects: unchanged.
- The audit-row UPDATE lifecycle from the 2026-05-20 ship (received → processed/failed/malformed) stays as-is.

**What changes:**
- The dedup-key construction moves from line 88 to AFTER the `parse_message` call (around line 198 in the current file).
- The key is built from `record.slack_channel_id` + `record.slack_ts` — both stable across message edits because `record` is the parsed inner-event shape.
- The pre-parse path (channel gate + subtype gate + parser invocation) executes BEFORE step 0 — so a duplicate edit-event now sees its dedup key collide with the original delivery's, and the gate short-circuits before the second `_upsert_message` and second passive-monitor fork fire.

**Why option (a) over (b).** The diagnostic surfaced two implementation options: (a) move the key construction post-parse, or (b) treat `message_changed` as a separate code path that updates `slack_messages.text` but skips the passive-monitor fork entirely. (a) preserves the ability for Ella to respond when a client edits to add critical content (e.g., pasting an error message into a question); (b) loses that capability entirely. (a) is also the minimal-surface change. Lean (a). The fix spec is option (a).

## Acclimatization checklist

Builder reads these first and confirms understanding in 3-4 bullets:

- `CLAUDE.md` § Working Norms § Operational patterns — particularly the "structural fixes beat prompt iteration" norm and the "never commit with failing tests" rule.
- `docs/state.md` — the 2026-05-20 idempotency entry (the prior spec this fix supersedes the assumption-of) + the 2026-05-21 diagnostic findings will need a new entry today.
- `docs/known-issues.md` — there's a separately-flagged Ella author-type misclassification finding to log alongside this spec's main work; see § "Doc updates" below for the exact entry.
- `docs/specs/ella-duplicate-webhook-delivery-diagnostic.md` and `docs/reports/ella-duplicate-webhook-delivery-diagnostic.md` — the diagnostic that produced this fix.
- `docs/specs/ella-realtime-ingest-idempotency.md` and `docs/reports/ella-realtime-ingest-idempotency.md` — the prior spec, particularly § "What could go wrong #6" (the failure-mode acknowledgment) and the existing `test_message_changed_uses_outer_ts_for_dedup_key` test that pins the broken behavior.
- `ingestion/slack/realtime_ingest.py` — full file. Pay attention to: where `delivery_id` is built today (line 88), how `event_for_parser` is unwrapped for `message_changed` (lines 173-180), where `parse_message` is called (line 196), where `_upsert_message` is called (line 226), where `_maybe_dispatch_passive_monitor` fires (line 254).
- `ingestion/slack/parser.py` — confirms `parse_message` returns `record.slack_ts` from the inner event (which is what we want).
- `tests/ingestion/slack/test_realtime_ingest_dedup.py` — particularly `test_message_changed_uses_outer_ts_for_dedup_key` which currently pins the broken behavior. Will be rewritten in this spec.
- `tests/ingestion/slack/test_realtime_ingest_passive_fork.py` and `tests/api/test_slack_events_message_ingest.py` — these have fake-DB harnesses for `webhook_deliveries`; verify the move-key-construction doesn't break their existing assertions.

## Architecture — what changes

### Modify: `ingestion/slack/realtime_ingest.py`

**The structural change is moving step 0 (dedup gate) from BEFORE the channel-allowlist gate to AFTER the parser call.** The new pipeline order:

1. Channel-allowlist gate (unchanged).
2. Subtype gate (unchanged).
3. `message_changed` unwrap (unchanged).
4. `parse_message` call (unchanged).
5. **NEW position for step 0: build delivery_id from `record.slack_channel_id` + `record.slack_ts`, then atomic UPSERT into webhook_deliveries.** On PK collision → short-circuit return.
6. `_upsert_message` (unchanged).
7. `_insert_audit` to mark the row `processed` (unchanged — still an UPDATE, still keyed on the same delivery_id).
8. `_maybe_dispatch_passive_monitor` (unchanged).

**Why the new order is structurally sound:**

- A duplicate edit-event now lands on the same delivery_id as the original `message` event because both produce a `record` with the same inner ts.
- The pre-parse path (channel + subtype gates) is cheap — no DB write, no LLM call, just dict lookups. Running it twice for an edit-event before the second one short-circuits at step 0 is fine.
- The parser is pure and idempotent — running it twice produces the same `SlackMessageRecord`.
- Step 0's UPSERT still serializes at the Postgres PK layer; the atomicity guarantee is unchanged.

**Handling the early-exit branches:** Today's code has three early-return branches that fire BEFORE step 0 (non-client channel skip, ignorable subtype skip, parser returns None). All three need audit rows. After the refactor, those early-exit branches still need to write audit rows — but they no longer have a step-0 row to UPDATE because step 0 hasn't fired yet. Two approaches:

**Approach 1: Early-exit branches do a fresh INSERT.** The `_insert_audit` helper today is UPDATE-only. Add a sibling helper `_insert_audit_terminal` that INSERTs a row in a single terminal state (received → processed, no intermediate). Use this for the three early-exit branches. The happy-path step 0 + later UPDATE pattern stays for the ingest path.

**Approach 2: Step 0 moves to AFTER the channel/subtype gates but BEFORE the parser.** Channel-allowlist + subtype gate stay as pre-parse filters. Step 0 runs immediately after, building delivery_id from `event.get("ts")` (outer) for non-`message_changed` events and from `event.get("message", {}).get("ts")` (inner) for `message_changed` events. The parser then runs after step 0.

**Lean: Approach 1.** It's the minimal-surface change to the dedup-key logic — step 0 lives in one place (post-parse, using `record.slack_ts`) and the key construction has zero branching. Approach 2 is a partial refactor that still has branching on event subtype at the key-construction layer, which is fragile if Slack adds new event types in the future.

**Concrete code shape under Approach 1:**

```python
# Inside ingest_message_event, AFTER parse_message returns a non-None record:

_upsert_message_pre_dedup = None  # placeholder for the moved sequence

# (existing channel-allowlist gate stays, calling _insert_audit_terminal on skip)
# (existing subtype gate stays, calling _insert_audit_terminal on skip)
# (existing message_changed unwrap stays)
# (existing parse_message call stays)

# If parse_message returned None: existing branch calls _insert_audit_terminal,
# returns early.

# Step 0 (NEW POSITION): atomic register against webhook_deliveries.webhook_id
delivery_id = f"slack_msg_ingest_{record.slack_channel_id}_{record.slack_ts}"
result["delivery_id"] = delivery_id

if not _try_register_delivery(
    db,
    delivery_id=delivery_id,
    slack_channel_id=record.slack_channel_id,
    slack_ts=record.slack_ts,
):
    logger.info(
        "slack_message_ingest: duplicate delivery_id=%s channel=%s ts=%s",
        delivery_id,
        record.slack_channel_id,
        record.slack_ts,
    )
    result["skipped_reason"] = "duplicate"
    return result

# Existing _upsert_message, _insert_audit (UPDATE to 'processed'),
# _maybe_dispatch_passive_monitor stay unchanged.
```

**The fallback delivery_id for malformed events.** Today's code uses `slack_msg_ingest_malformed_{uuid.uuid4()}` when channel or ts is missing. Under the new ordering, malformed events get caught by the channel-allowlist gate (no channel → not in slack_channels → skip non-client). They never reach the new step-0 position. The malformed-fallback path in step 0 is unreachable and can be removed. Verify this by reading the code carefully — if there's any path where parser returns a record with null `slack_channel_id` or `slack_ts`, the fallback is still needed. (Spoiler from reading the parser: it requires `slack_ts` to be non-empty or returns None; `channel_id` is passed by caller, so the channel-allowlist gate's null check covers it.)

### New helper: `_insert_audit_terminal`

For the three pre-dedup-gate early-exit branches that need to write an audit row but don't have a step-0 row to UPDATE.

```python
def _insert_audit_terminal(
    db,
    *,
    delivery_id: str,
    status: str,
    error: str | None,
    payload: dict[str, Any],
) -> None:
    """Insert a single-state audit row for an early-exit branch that
    didn't go through step 0 (channel-skip, subtype-skip, parser-None).

    The webhook_id is a UUID-suffixed identifier — these rows aren't
    meant to participate in dedup (the message was never going to
    reach the pipeline anyway), they're audit observability only.

    Best-effort: a failure here is logged + swallowed."""
    row: dict[str, Any] = {
        "webhook_id": f"{delivery_id}_{uuid.uuid4()}",
        "source": _DELIVERY_SOURCE,
        "processing_status": status,
        "payload": payload,
        "headers": {},
        "processed_at": datetime.now(timezone.utc).isoformat(),
    }
    if error is not None:
        row["processing_error"] = error[:2000]
    try:
        db.table("webhook_deliveries").insert(row).execute()
    except Exception as exc:
        logger.warning(
            "slack_message_ingest: terminal audit insert failed delivery_id=%s: %s",
            delivery_id,
            exc,
        )
```

The early-exit branches (channel-skip, subtype-skip, parser-None) get rewired to call `_insert_audit_terminal` instead of `_insert_audit`. The happy path still calls `_insert_audit` (UPDATE) after `_upsert_message` because step 0 has already written the `received` row.

**For the early-exit branches, what's the delivery_id prefix?** Use `slack_msg_ingest_pre_dedup` to make audit-ledger queries distinguishable:

- `slack_msg_ingest_C0AEEPVK36W_1779309969.851479` → went through step 0 → represents a logical message.
- `slack_msg_ingest_pre_dedup_{uuid}` → early-exit before step 0 → audit-only.
- `slack_msg_ingest_dup_{uuid}` → second-delivery dedup forensic row → audit-only.

This makes operational queries cleaner. Builder picks the prefix that fits cleanest with the existing audit-ledger naming convention.

### Modify: `tests/ingestion/slack/test_realtime_ingest_dedup.py`

**Delete or rewrite `test_message_changed_uses_outer_ts_for_dedup_key`** — it currently pins the broken behavior. The correct test is: a `message_changed` event with `event.message.ts` matching a previously-seen message's ts should dedup at step 0.

New test (replaces the old one):

```python
def test_message_changed_dedups_against_original_message_ts(fake_db):
    """A user edits their message. Slack delivers a message_changed event
    with event.ts != original message.ts but event.message.ts == original
    message.ts. The dedup gate uses the INNER ts (record.slack_ts), so the
    second delivery dedups correctly and the passive-monitor fork does
    NOT fire twice."""
    # First delivery: original message event
    original_event_envelope = {
        "type": "event_callback",
        "event": {
            "type": "message",
            "channel": "C0TEST",
            "ts": "1779309969.851479",
            "user": "U_CLIENT",
            "text": "Original message",
        },
    }
    result1 = ingest_message_event(original_event_envelope)
    assert result1["ingested"] is True
    assert result1["skipped_reason"] is None

    # Second delivery: edit event for the same message
    edit_event_envelope = {
        "type": "event_callback",
        "event": {
            "type": "message",
            "subtype": "message_changed",
            "channel": "C0TEST",
            "ts": "1779309983.000100",  # DIFFERENT outer ts
            "message": {
                "type": "message",
                "ts": "1779309969.851479",  # SAME inner ts
                "user": "U_CLIENT",
                "text": "Edited message text",
                "edited": {
                    "ts": "1779309983.000000",
                    "user": "U_CLIENT",
                },
            },
        },
    }
    result2 = ingest_message_event(edit_event_envelope)
    assert result2["skipped_reason"] == "duplicate"
    assert result2["ingested"] is False
```

**Add complementary tests:**

- `test_message_changed_with_different_inner_ts_processed_separately` — a `message_changed` event whose inner ts is genuinely different from any prior message (rare but possible if Slack ever re-keys an edit; verify the pipeline doesn't mistakenly dedup unrelated messages).
- `test_pre_dedup_early_exit_audit_rows_use_pre_dedup_prefix` — channel-skip and subtype-skip audit rows have the `slack_msg_ingest_pre_dedup_` webhook_id prefix and never collide with happy-path rows.
- `test_happy_path_delivery_id_uses_inner_ts_from_record` — for a regular (non-edit) message, the delivery_id encodes `record.slack_ts` (which equals `event.ts` in this case, so the visible key is unchanged from the prior shape). Documents the invariant.

### Migration: none

Schema is unchanged. `webhook_deliveries.webhook_id` is already `text` (no length limit, no format constraint). Both the new happy-path key shape (unchanged) and the new pre-dedup prefix are text strings.

### Doc updates

**`docs/state.md`** — new entry today (2026-05-21 EOD or 2026-05-22 depending on when this ships) covering this fix. Migration count unchanged. Python serverless function count unchanged. Test count updated (likely +3 to +5 new tests, possibly -1 for the deleted broken test).

**`docs/runbooks/slack_message_ingest.md`** — update the "Dedup gate" section: key construction now happens post-parse using `record.slack_ts` (the inner/canonical message ts), not the outer event ts. Note explicitly that `message_changed` events dedup correctly against the original message delivery because both produce the same inner ts.

**`docs/known-issues.md`** — TWO updates:

1. Strike through the "Passive dispatch has no idempotency check against duplicate Slack message delivery" entry (if it's still struck-but-the-strike-resolved-by-prior-spec-points-to-the-now-incorrect-fix; verify what's there currently). Replace with a fresh entry noting the prior spec only partial-fixed the issue and pointing to this spec as the actual resolution.

2. **NEW entry to log a separate side-finding from today's diagnostic:** Ella's Slack posts are being classified as `author_type='bot'` instead of `'ella'` in `slack_messages`. Verified via cloud SQL — `slack_user_id='U0ATX2Y8GTD'` (Ella's user account behind `SLACK_USER_TOKEN`) has 6+ posts over the trailing 7 days, all tagged `author_type='bot'`. Root cause likely in `parser._resolve_author` — the `ella_user_id` resolution from `shared.slack_identity.get_user_id_for_token(os.environ.get("SLACK_USER_TOKEN"))` is either resolving to a different user_id than what Slack actually posts under, OR the user_id is null/missing at parse time. Impact: downstream queries filtering on `author_type='ella'` (e.g., the CSM-intervention check in `passive_ella_cron.py:_csm_intervened`) silently fail to match Ella's own posts. This is independent of the dedup bug and not blocking this spec, but flagging here so it doesn't get lost. Separate spec needed once production is stable.

The exact known-issues entry text Builder writes for #2 (verbatim into `docs/known-issues.md` under whatever the existing format pattern is — match the precedent):

> **Ella posts classified as `author_type='bot'` instead of `'ella'` in `slack_messages`** (open as of 2026-05-21)
>
> `parser._resolve_author` is not recognizing Ella's user account (`slack_user_id='U0ATX2Y8GTD'` behind `SLACK_USER_TOKEN`) — her posts ingest with `author_type='bot'`. Verified empirically: SQL on cloud `slack_messages` shows 6+ Ella posts over the trailing 7 days under this user_id, all bot-tagged. Surfaced during the 2026-05-21 duplicate-webhook diagnostic (`docs/reports/ella-duplicate-webhook-delivery-diagnostic.md` § Surprises). Likely root cause: `shared.slack_identity.get_user_id_for_token(os.environ.get("SLACK_USER_TOKEN"))` is returning a different user_id than what Ella actually posts under, OR returning None. Impact: downstream queries filtering on `author_type='ella'` silently fail to match Ella's own posts — including the CSM-intervention check in `api/passive_ella_cron.py:_csm_intervened`. Independent of the message_changed dedup bug. Separate fix spec needed once production is stable.

## Hard stops

1. **Pre-edit verification of every `_insert_audit` call site.** Builder lists every call site in `ingest_message_event` before editing — they all need to be sorted into "early-exit before step 0 → use `_insert_audit_terminal`" vs "happy path after step 0 → still use `_insert_audit`." Get this wrong and either rows double-write (PK collision after step 0) or audit rows go missing.

2. **Verify `_try_register_delivery`'s UPSERT semantics still work after the move.** The Fathom-handler precedent (cited by the prior spec) returned `data=[]` on PK collision in production. The empirical observation from today's diagnostic is that the gate has caught zero true duplicates — but the diagnostic confirms that's because the KEY was wrong, not because the UPSERT semantics were wrong. The new key should collide correctly. Builder verifies this with the new test cases.

3. **The malformed-fallback delivery_id may be unreachable.** Per the analysis above, after the move, malformed events get caught by the channel-allowlist gate before reaching step 0. Builder verifies this by tracing every code path. If the fallback IS reachable, keep it; if not, remove it as dead code.

4. **No migration.** This spec is code-only. If Builder finds itself writing a migration, STOP — the design is explicitly schema-unchanged.

5. **Test suite regression.** `pytest tests/` must pass at ≥694 tests (the post-2026-05-20-spec baseline). The existing broken-behavior test gets deleted; replaced with the correct-behavior test plus complementary coverage. Net test count likely 694 → 696-698.

6. **`tsc --noEmit` + `next lint` regression.** Must stay clean. No TS touched.

7. **No production traffic generation.** No Slack posts, no curl-replays, no cron triggers. The production kill switch is currently flipped; nothing in this spec touches production state.

8. **No fix for the side-finding (author_type='bot' for Ella's posts).** Spec doc updates LOG the finding in known-issues. Spec does NOT fix it. That's a separate spec for a future session.

## Smoke test gate (post-deploy)

Drake's gate (c). Three test cases in `#ella-test-drakeonly`, all run with `passive_monitoring_enabled=true` on the test channel only (production channels stay off until smoke passes).

1. **First-delivery happy path.** Post any plain message. Verify in `/ella/runs` (or via SQL on `webhook_deliveries`) that one row exists with `webhook_id = slack_msg_ingest_C0AUWL20U8J_{ts}` and `processing_status='processed'`. No duplicate row. The visible key shape is unchanged from the 2026-05-20 ship for non-edit messages.

2. **Edit-event dedup.** Post a message, wait ~5 seconds, edit it in Slack to add a few characters. Slack fires a `message_changed` event. Verify:
   - `slack_messages.text` updates to the new text (existing upsert behavior, unchanged).
   - **NO duplicate `agent_runs` entry** appears for the edit. Only one passive-monitor evaluation fires (the original delivery's).
   - **No new in-channel ack from Ella for the edit.** If Ella's decision on the original message was `acknowledge_and_escalate`, she only acks once.
   - A `slack_msg_ingest_dup_*` audit row appears in `webhook_deliveries` with `processing_status='duplicate'` and `payload.original_delivery_id` referencing the first delivery.

3. **Two distinct messages don't false-dedup.** Post two genuinely different messages in close succession (5-10 seconds apart, different text). Both should process normally — two `agent_runs` rows, two passive-monitor evaluations. The dedup gate should NOT collapse them. Verify `webhook_deliveries` has two rows with two distinct `webhook_id`s, both `processing_status='processed'`.

All three must pass before flipping the spec status to `shipped`. If case 2 fails (the critical test — this is the bug we're fixing), Builder writes a PARTIAL report and the spec stays `in-flight`.

**After smoke passes, production resume is one operational step:** `UPDATE slack_channels SET passive_monitoring_enabled = true WHERE test_mode = false`. Drake's call when to execute.

## What could go wrong

1. **Edit-events that change content materially get suppressed.** A client edits their question to add critical context ("oh and I'm seeing this error: {full stack trace}"). Under the new dedup behavior, Ella sees only the pre-edit text in her passive-monitor evaluation. This is the same trade-off the prior spec acknowledged in its What could go wrong #6 — accepted because: (a) the alternative (current behavior) generates 11 duplicate dispatches / 36 hours which is far worse client-trust damage; (b) the client can still post a follow-up message to add the new context and that follow-up will trigger Ella normally; (c) in coaching channels, the team_member is reading the channel anyway and will see the edit. If this trade ever becomes a real friction case (a client edits-with-critical-content and Ella doesn't respond), future spec adds a distinct-edit detection that allows reprocessing under specific conditions.

2. **The new step-0 position doubles the cost of malformed events.** Today's code runs step 0 before the parser — a malformed event can be deduped without parse cost. Under the new ordering, malformed events run through the parser first. Parser cost is negligible (no LLM, no DB — pure dict manipulation), so this is acceptable.

3. **Audit-ledger query patterns change.** Today's audit rows all start with `slack_msg_ingest_{channel}_{ts}` or `slack_msg_ingest_dup_{uuid}`. After this fix, there's a third shape: `slack_msg_ingest_pre_dedup_{uuid}` for early-exit branches. Operational queries that scan by prefix will need updating. Builder updates the runbook's example queries.

4. **Race between concurrent edit + retry.** Slack delivers the original message, processes successfully. User edits in real time AND Slack happens to retry the original delivery at the same moment. Three deliveries arrive: original, retry-of-original, edit-event. The original and retry-of-original have the same outer ts; their inner ts is also the same; they collide correctly at step 0. The edit-event has the same inner ts as both; it also collides correctly. All three are deduped to a single dispatch. Postgres serializes the three concurrent UPSERTs at the PK layer. No issue.

5. **A message_changed event whose inner ts is genuinely new** (e.g., Slack ever re-keys an edit, or some exotic event shape we haven't seen). The dedup gate processes it as a fresh delivery — correct behavior because the inner ts doesn't match anything in the dedup history. The test `test_message_changed_with_different_inner_ts_processed_separately` pins this.

6. **The prior spec's report (`docs/reports/ella-realtime-ingest-idempotency.md`) and state.md entry now contain text that overstates how much the gate fixed.** This spec's state.md entry should reference the prior spec and note that the dedup gate's behavior in production didn't match the test suite's behavior — and explicitly tie that to the move from outer-ts to inner-ts as the structural fix. No retroactive editing of the prior documents; the new entry is the corrective.

## Done means

- All file edits pushed to `main` per the one-logical-change-per-commit rule (suggested split: commit 1 = `_insert_audit_terminal` helper + early-exit branches rewired to call it; commit 2 = step-0 dedup gate moved post-parse + delivery_id reconstruction; commit 3 = tests rewritten + new coverage; commit 4 = docs).
- `pytest tests/` passes at ≥694 (target: ~696-698 after the changes). No regression.
- `tsc --noEmit` + `next lint` clean.
- Three smoke test cases in `#ella-test-drakeonly` all pass per the gate (c) section.
- Spec status flipped to `shipped` in the same Builder commit-sequence as the report.
- Report at `docs/reports/ella-realtime-ingest-dedup-message-changed.md` follows the 6-section structure.
- `docs/known-issues.md` updated with both the resolved-by entry for this fix AND the new entry logging the `author_type='bot'` finding.

Drake's gates:
- (a) None — no migrations, no irreversible actions.
- (b) Any genuinely context-confusing decision Builder hits — surface immediately. Specifically: if the `_insert_audit` → `_insert_audit_terminal` refactor turns up a code path that doesn't fit cleanly into either pre-dedup or post-dedup, surface before guessing.
- (c) Three smoke test cases in `#ella-test-drakeonly` — Drake runs each, confirms outcomes. Spec stays `in-flight` until Drake signals all three passed.
- (d) None — no env var changes, no credential touches.

**Production resume gate post-spec.** Once this spec's smoke passes and the spec is `shipped`, production resume becomes available via a single SQL UPDATE flipping 136 rows. Drake's call when to execute.
