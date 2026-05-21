# Ella Realtime-Ingest Idempotency Gate

**Slug:** ella-realtime-ingest-idempotency
**Status:** in-flight

> **UPDATED 2026-05-21:** The dedup gate this spec ships uses `event.get('ts')` as the key, which is the OUTER event ts. Slack `message_changed` events have a different outer ts than the original `message` event for the same logical message, so the gate did not prevent edit-driven duplicate dispatches in production (11 documented over 36 hours of post-resume traffic; zero forensic-duplicate rows ever written by the original gate). The corrective ship moves the dedup-key construction post-parse so it uses the inner/stable message ts.
> See: `docs/specs/ella-realtime-ingest-dedup-message-changed.md` (the fix) and `docs/specs/ella-duplicate-webhook-delivery-diagnostic.md` (the diagnostic that surfaced the bug).

## Context

The third structural gap from yesterday's 2026-05-19 EOD production misfire. The `docs/known-issues.md` entry titled "Passive dispatch has no idempotency check against duplicate Slack message delivery" is the source-of-truth issue this spec closes. Problems B and C from that same EOD shipped today via `ella-at-mention-routing-gate-and-advisor-context`; this is the last of the three before production passive monitoring can be re-enabled on the 136 channels currently gated off.

**The misfire shape.** Slack delivered Dhamen's first message at 16:58:14 ET twice (retry semantics or `message_changed` redelivery). The realtime-ingest fork in `ingestion/slack/realtime_ingest.py:ingest_message_event` fired the full pipeline twice — two `agent_runs` rows with byte-identical `input_summary`, two ack posts in-channel, two `escalations` rows, and four DMs (Scott + Lou ×2). The third ack came from a structurally-different second message and is addressed by today's earlier ship.

**Current state of dedup, by table:**

- `slack_messages` — UPSERT on `(slack_channel_id, slack_ts)`. **Already idempotent** at the storage layer (`_upsert_message` uses `on_conflict="slack_channel_id,slack_ts"`). Same (channel, ts) re-delivered overwrites the row; no second row appears.
- `pending_digest_items` — unique index on `(slack_channel_id, triggering_message_ts)`. **Already idempotent** at the digest layer. Second write hits the unique-key collision and either no-ops or errors depending on the calling code.
- `webhook_deliveries` — PK on `webhook_id`. **Race-safe by PK but the key being used doesn't represent the logical message.** `ingest_message_event` writes `webhook_id = f"slack_msg_ingest_{uuid.uuid4()}"` per delivery — every redelivery gets a fresh UUID and a fresh row. The PK guarantees no two audit rows collide; it does NOT guarantee no two ingest pipelines fire for the same logical message.
- `agent_runs` / `escalations` / Slack post fan-out / DM fan-out — **no dedup at all.** Yesterday's two-ack fan-out lives here.

**The fix shape.** Change the `webhook_id` from a per-delivery UUID to a deterministic-per-logical-message key: `slack_msg_ingest_{slack_channel_id}_{slack_ts}`. Use the existing Fathom-handler pattern — atomic INSERT against the PK unique constraint, catch the PK collision, return early as "duplicate" before any downstream work fires (`_upsert_message`, `_maybe_dispatch_passive_monitor`). The PK itself becomes the dedup primitive. Race-proof by construction.

**Why this position is right.** Drake's call after this morning's design conversation: "upstream, dedup at the earliest moment." The PK collision check at `_insert_audit` is the earliest behavioral side-effect-bearing step in the ingest pipeline. Earlier than that is just Slack's webhook arrival at `api/slack_events.py`, which has no DB state yet. Cheaper than later positions: a duplicate costs one INSERT attempt (fails fast on PK constraint), zero LLM calls, zero downstream work.

**What this spec deliberately doesn't try to do.** Doesn't replace `_upsert_message`'s existing idempotency — it stays. Doesn't add new dedup tables — the existing `webhook_deliveries` PK is the dedup primitive. Doesn't try to dedup at the `agent_runs` or `escalations` layer — once the upstream gate fires correctly, those layers can't see a duplicate. Doesn't change Slack's retry behavior or webhook acknowledgment (we still return 200 to Slack on duplicate so they don't keep retrying).

**Drake-confirmed design decisions from this morning:**
1. **Position A** — upstream in ingestion. Block the whole pipeline on duplicate.
2. **Key (i)** — `(slack_channel_id, message_ts)`. Matches Slack's logical-message identity.
3. **Window** — 1 hour. Documented as the effective behavioral window, though the PK approach is technically infinite (the audit row persists). The 1-hour framing is for human-mental-model purposes; the underlying mechanism doesn't care about time.
4. **Storage (b)** — existing `webhook_deliveries` table, PK-based atomic INSERT.
5. **Duplicate-path behavior** — audit-only. Write a row marking the duplicate with `processing_status='duplicate'` + a payload entry explaining the skip. No behavioral side effects.

**Production resume gate.** This is the last spec blocking production resume. Once shipped + smoke-tested + green, the 136 paused channels can flip `passive_monitoring_enabled` back to true via the same one-line UPDATE pattern the kill switch used (in reverse). The resume itself is a separate operational step, not in this spec.

## Acclimatization checklist

Builder reads these first and confirms understanding in 3-4 bullets in the report's "What I did" section. Call out any contradictions with what's actually shipped.

- `CLAUDE.md` § Working Norms § Operational patterns — the structural-fixes-beat-prompt-iteration norm. This spec is a clean structural fix at the right architectural layer; if any part of execution starts to feel like prompt iteration or content-based dedup logic, STOP.
- `docs/state.md` — current state, especially the 2026-05-19 EOD entry covering the misfire and today's earlier @-mention routing gate ship.
- `docs/known-issues.md` — the "Passive dispatch has no idempotency check" entry. This spec closes that entry (strike-through with resolution pointer).
- `ingestion/slack/realtime_ingest.py` — full file. Specifically: `ingest_message_event` (the entry point), `_insert_audit` (the function that writes the `webhook_id`), `_DELIVERY_SOURCE` constant, the passive-monitor dispatch helper `_maybe_dispatch_passive_monitor`.
- `supabase/migrations/0011_webhook_deliveries_and_doc_type_unique.sql` — the migration that created `webhook_deliveries`. Confirms PK on `webhook_id`, CHECK constraint on `processing_status` allowing `'duplicate'`, no other unique constraints needed.
- `api/fathom_events.py` — reference pattern for the atomic-INSERT-with-PK-collision approach. The Fathom handler uses `webhook_id` from Standard Webhooks spec, this spec's Slack handler synthesizes the equivalent deterministic ID.
- `tests/ingestion/slack/` — existing test files, especially anything covering `_insert_audit` or the audit-row contract. New tests slot in here.

## Architecture — overview

### The change in one paragraph

Replace `webhook_id = f"slack_msg_ingest_{uuid.uuid4()}"` with `webhook_id = f"slack_msg_ingest_{slack_channel_id}_{slack_ts}"`. Wrap the FIRST `_insert_audit` call in `ingest_message_event` (the one for the channel-allowlist gate path) such that a PK collision returns "duplicate" early without firing downstream work. All other `_insert_audit` call sites in the function continue to write with the same deterministic webhook_id — but since the function exits on the first collision detection, they only fire on the first delivery. On a retry, the function returns "duplicate" before reaching them.

Wait — that's wrong. Re-read the code. The `_insert_audit` calls happen at different points in the function based on which branch fires (non-client channel skip, ignorable subtype skip, parse-None skip, happy ingest). The first audit row is INSIDE one of those branches, not at the function entry. The fix has to be earlier — a dedicated dedup check at function entry that fires BEFORE any of the existing branches.

### The corrected architecture

Add a new step 0 at the very top of the try block in `ingest_message_event`, before the channel-allowlist gate:

```python
# Step 0: Dedup gate.
# Slack can deliver the same logical message twice (retry semantics,
# message_changed redelivery, manual replay). Use webhook_deliveries.webhook_id
# (PK) as the dedup primitive: deterministic-per-(channel, ts), atomic INSERT,
# PK collision → return "duplicate" before any side effect fires.
delivery_id = f"slack_msg_ingest_{slack_channel_id}_{slack_ts}"
result["delivery_id"] = delivery_id
if _try_register_delivery(db, delivery_id=delivery_id, slack_channel_id=slack_channel_id, slack_ts=slack_ts):
    # First-time delivery. Continue to the existing pipeline below.
    pass
else:
    # Duplicate. Audit-only behavior already handled by the helper.
    logger.info(
        "slack_message_ingest: duplicate delivery_id=%s channel=%s ts=%s",
        delivery_id, slack_channel_id, slack_ts,
    )
    result["skipped_reason"] = "duplicate"
    return result
```

The helper `_try_register_delivery` does the atomic INSERT with conflict-resolution:

```python
def _try_register_delivery(
    db,
    *,
    delivery_id: str,
    slack_channel_id: str | None,
    slack_ts: str | None,
) -> bool:
    """Atomically register this delivery in webhook_deliveries. Returns
    True if this is the first time we've seen this (channel, ts);
    False if a duplicate. The PK collision is the dedup primitive.

    Duplicate-path side effect: write a second audit row with
    `processing_status='duplicate'` and `webhook_id` distinguished by a
    uuid suffix so it doesn't itself PK-conflict — gives us operational
    visibility into how often Slack actually redelivers. Audit-only, no
    behavioral side effects.

    On unexpected exceptions (DB unavailable, etc.), default to True
    (fail-open) and log a warning — better to process a possible
    duplicate than to drop a real message on a transient DB blip.
    """
    row: dict[str, Any] = {
        "webhook_id": delivery_id,
        "source": _DELIVERY_SOURCE,
        "processing_status": "received",
        "payload": {
            "slack_channel_id": slack_channel_id,
            "slack_ts": slack_ts,
        },
        "headers": {},
    }
    try:
        db.table("webhook_deliveries").insert(row).execute()
        return True
    except Exception as exc:
        # supabase-py raises on PK conflict; the error message contains
        # 'duplicate key' or the PG error code 23505. Treat any insert
        # failure here as a possible duplicate AND log defensively.
        exc_str = str(exc).lower()
        is_pk_collision = (
            "duplicate key" in exc_str
            or "23505" in exc_str
            or "unique constraint" in exc_str
        )
        if is_pk_collision:
            _write_duplicate_audit_row(
                db,
                original_delivery_id=delivery_id,
                slack_channel_id=slack_channel_id,
                slack_ts=slack_ts,
            )
            return False
        logger.warning(
            "slack_message_ingest: _try_register_delivery insert failed "
            "(not PK collision) delivery_id=%s: %s",
            delivery_id, exc,
        )
        # Fail-open: assume not a duplicate. The downstream code may
        # produce another error on the actual audit-row insert, which
        # the existing exception path captures.
        return True
```

The duplicate-audit helper writes a SECOND row (because the PK is taken — we need a different `webhook_id`):

```python
def _write_duplicate_audit_row(
    db,
    *,
    original_delivery_id: str,
    slack_channel_id: str | None,
    slack_ts: str | None,
) -> None:
    """Write an audit row recording that a duplicate was caught. Uses
    a uuid-suffixed webhook_id so it doesn't PK-collide with the
    original. Payload references the original delivery_id for
    forensics.

    Best-effort: if this insert ALSO fails, swallow + log. The dedup
    decision already happened; the audit row is for observability.
    """
    row: dict[str, Any] = {
        "webhook_id": f"slack_msg_ingest_dup_{uuid.uuid4()}",
        "source": _DELIVERY_SOURCE,
        "processing_status": "duplicate",
        "processed_at": datetime.now(timezone.utc).isoformat(),
        "payload": {
            "slack_channel_id": slack_channel_id,
            "slack_ts": slack_ts,
            "skip_reason": "duplicate_delivery",
            "original_delivery_id": original_delivery_id,
        },
        "headers": {},
    }
    try:
        db.table("webhook_deliveries").insert(row).execute()
    except Exception as exc:
        logger.warning(
            "slack_message_ingest: duplicate-audit row insert failed "
            "original=%s: %s",
            original_delivery_id, exc,
        )
```

### The implication for existing `_insert_audit` calls

The existing `_insert_audit` calls in `ingest_message_event` ALL use the same `delivery_id` (the function-scope variable). With the change above, that variable is now `f"slack_msg_ingest_{slack_channel_id}_{slack_ts}"` — the same value across all branches. Step 0 already INSERTed a row with that exact webhook_id (status `'received'`). When a later branch calls `_insert_audit`, it tries to insert ANOTHER row with the same PK → PK collision → audit failure.

This is the trap. Two approaches to fix:

- **(α) Switch the existing `_insert_audit` calls from INSERT to UPDATE.** They no longer create rows; they update the existing `'received'` row with the final status + error + payload. Cleaner conceptually — one row per delivery, lifecycle is `received → processed/failed`. Matches the lifecycle the migration 0011 comments document (*"received → processed (happy path), failed (ingest raised, ...), duplicate (PK conflict on retry, early return)"*).

- **(β) Keep `_insert_audit` as INSERT, but change its `webhook_id` to be the original plus a status suffix.** E.g., `f"slack_msg_ingest_{channel_id}_{ts}_processed"`. More rows per delivery; messier audit ledger; precedent confusion.

**Lean: (α).** Migration 0011's PK design implies the row's lifecycle, not multiple rows. Builder refactors `_insert_audit` to do an UPDATE on the existing PK, keyed on the `delivery_id` (== `webhook_id`). The UPDATE sets `processing_status`, `processing_error`, `payload`, `processed_at`. The `received → processed` transition matches the migration's documented lifecycle.

### One subtle thing: the `_maybe_dispatch_passive_monitor` error-audit path

That path writes its own audit row with `webhook_id = f"passive_monitor_{delivery_id}"` (different prefix). No collision with the ingest's audit row. Stays as INSERT, unchanged. Note: that row's webhook_id will now be deterministic too (`passive_monitor_slack_msg_ingest_{channel}_{ts}`) — fine, the only callers are this specific error path and a duplicate there would mean we're failing in passive-monitor for the SAME message twice, which is exactly what we want surfaced as a single row.

Actually wait — that creates a problem. If Slack delivers the same message twice and the first delivery fires `_maybe_dispatch_passive_monitor` which raises an exception, the passive-monitor error-audit row gets written with the deterministic ID. On the second delivery, the dedup gate at step 0 catches it FIRST and exits before `_maybe_dispatch_passive_monitor` runs, so no second passive-monitor error audit row attempted. No collision. Fine.

If for some reason both deliveries reach the passive-monitor fork (which shouldn't happen with the dedup gate in place, but defense-in-depth), the second would PK-collide on the passive-monitor error-audit row. The existing `except Exception as audit_exc` in `_maybe_dispatch_passive_monitor` already catches and swallows that — would just log a warning. Acceptable.

### Why this is structurally race-proof

The atomic INSERT against a PK constraint is one of Postgres's strongest guarantees. Two concurrent INSERTs with the same PK serialize at the storage layer — exactly one succeeds, exactly one fails. There's no time-of-check-to-time-of-use race. Yesterday's misfire had the two deliveries arriving 45 seconds apart (Slack's retry typically waits a few seconds), but the gate would work identically if they arrived microseconds apart.

The fail-open behavior on non-PK-collision exceptions is a deliberate tradeoff: we'd rather risk processing one possible-duplicate during a DB outage than drop a legitimate message. The fan-out cost of a single duplicate is bounded (one extra ack, one extra DM); the cost of dropping a legitimate client message is unbounded (we never respond to a real issue).

## What changes — by file

### Modify: `ingestion/slack/realtime_ingest.py`

Five logical edits, suggested as separate commits per the one-logical-change rule but Builder's call:

1. **Add `_try_register_delivery` + `_write_duplicate_audit_row` helpers.** New functions, no behavioral change yet — they exist but aren't called.

2. **Change `delivery_id` construction in `ingest_message_event`.** Replace `f"slack_msg_ingest_{uuid.uuid4()}"` with `f"slack_msg_ingest_{slack_channel_id}_{slack_ts}"`. Handle the edge case where `slack_channel_id` or `slack_ts` is None at function entry (rare but possible — defensive code should default to `unknown_channel` / `unknown_ts` so the audit ledger still gets a row, and the dedup is effectively a no-op for malformed events).

3. **Refactor `_insert_audit` to do an UPDATE.** Function signature unchanged. Body changes from `.insert(row)` to `.update(row).eq("webhook_id", delivery_id)`. Row construction drops the `webhook_id` field (now in the WHERE clause). Add a defensive `.execute()` result check — if no row was updated, log a warning (means step 0 didn't fire correctly).

4. **Add the dedup gate (step 0) at the top of the try block.** The if/else structure from the architecture section. Position: immediately inside `try:`, before the `from shared.db import get_client` import (the import gets pulled earlier in the function — Builder's call on the cleanest re-ordering).

5. **Audit failure path** (the `except Exception as exc` at the bottom of `ingest_message_event`). The current code does `_insert_audit(...status="failed"...)` which is now an UPDATE. If step 0 wrote the `'received'` row successfully, the UPDATE flips it to `'failed'`. If step 0 failed (rare — DB outage during dedup), the UPDATE won't find a row to update; the warning gets logged. Acceptable degradation.

**Hard stop:** Builder reads the current `ingest_message_event` carefully before editing. The function has multiple early-return branches (non-client channel, ignorable subtype, parse-None) each with its own `_insert_audit` call. After this refactor, each of those branches updates the existing row instead of inserting a new one. Verify by tracing through every code path that the row gets exactly one INSERT (step 0) and exactly one UPDATE (the eventual branch's _insert_audit call), with the exception path being the UPDATE-to-failed shape.

### No migration

The `webhook_deliveries` table already has the PK on `webhook_id`. The CHECK constraint on `processing_status` already allows `'duplicate'` (per migration 0011). No schema change.

### Modify: `tests/ingestion/slack/test_realtime_ingest.py` (or wherever the existing realtime-ingest tests live; Builder verifies path)

New tests covering the dedup behavior. At minimum:

1. **First delivery: happy path.** Mock the Slack event, mock the DB so step 0's INSERT succeeds. Assert `_upsert_message` was called, passive-monitor dispatch fired, audit row updated to `'processed'`.

2. **Duplicate delivery: dedup gate fires.** Mock the DB so step 0's INSERT raises a PK collision (simulate the message of `duplicate key value violates unique constraint`). Assert `_upsert_message` was NOT called, passive-monitor dispatch did NOT fire, a duplicate-audit row was inserted with `processing_status='duplicate'`.

3. **Duplicate-audit row contains forensic payload.** Same as test 2 but assert the inserted duplicate-audit row's payload includes `original_delivery_id`, `slack_channel_id`, `slack_ts`, `skip_reason='duplicate_delivery'`.

4. **Step 0 fail-open: non-PK-collision exception treats as not-duplicate.** Mock the DB so step 0's INSERT raises a generic exception (not PK collision). Assert pipeline continues, the rest of the function runs normally. The downstream code's exception handling captures any further issues.

5. **Deterministic delivery_id format.** Pass a known (channel, ts) to `ingest_message_event` and assert the resulting audit row's webhook_id matches `slack_msg_ingest_{channel}_{ts}` exactly.

6. **None handling on missing fields.** Pass an event with `channel=None` or `ts=None`. Assert the function doesn't crash and produces a fallback delivery_id (e.g., `slack_msg_ingest_unknown_channel_unknown_ts`).

7. **Edge case: `message_changed` event re-delivers the same logical message.** Pass an event with `subtype='message_changed'` where `event.message.ts` matches a previously-seen ts. Assert dedup fires (the inner-message ts is what we use, not the outer event's ts — verify which one the existing code uses; if there's ambiguity, surface to Drake).

8. **Existing test coverage preserved.** All existing tests in `tests/ingestion/slack/test_realtime_ingest_passive_fork.py`, `tests/ingestion/slack/test_at_mention_detection.py`, etc. continue to pass. The refactor of `_insert_audit` from INSERT to UPDATE must not break their assertions; if any assertion was tied to INSERT-specific semantics, Builder updates the test to assert UPDATE semantics with a comment explaining why.

**Target:** +8 to +12 new tests minimum. Existing 685 passing must stay green (with possible adjustments to existing tests as noted above).

### Documentation updates

- **`docs/state.md`** — new entry for today (2026-05-20, second ship). Migration count unchanged. Python serverless function count unchanged. Test count updated.
- **`docs/runbooks/slack_message_ingest.md`** — add a "Dedup gate" section describing the step 0 behavior, the deterministic webhook_id format, and the failure modes (fail-open on non-PK exceptions).
- **`docs/known-issues.md`** — strike through the "Passive dispatch has no idempotency check against duplicate Slack message delivery" entry with: "Resolved via `ella-realtime-ingest-idempotency` (2026-05-20). Dedup gate at step 0 of `ingest_message_event` catches Slack redeliveries via atomic INSERT against `webhook_deliveries.webhook_id` PK; downstream side effects only fire on first delivery."
- **`docs/agents/ella/ella.md`** — minor update to the realtime-ingest pipeline description noting the dedup gate. One paragraph extension at most.

## Hard stops

1. **Pre-edit verification of `_insert_audit` call sites.** Builder traces every call to `_insert_audit` in `ingest_message_event` and confirms the refactor to UPDATE-semantics covers all paths correctly. List the call sites in the report's "What I did" section so Drake can verify.

2. **PK collision exception detection.** The `supabase-py` exception message for PK collisions has historically varied across library versions. Builder verifies empirically (by reading the supabase-py source or testing against a real PK conflict in a test DB) what the exception type and message look like, and writes the `is_pk_collision` detection to match. If the detection isn't robust, surface to Drake before shipping — fail-open on a misdetected collision means we'd process duplicates as non-duplicates.

3. **No migration.** This spec explicitly does not change the schema. If Builder finds the existing `webhook_deliveries` schema doesn't support the design (e.g., the CHECK constraint rejects `'duplicate'` despite migration 0011's text), STOP and surface — that's a design assumption gone wrong, not an implementation detail.

4. **Test suite regression.** `pytest tests/` must pass at ≥685 tests after all edits. If lower, STOP.

5. **`tsc --noEmit` + `next lint` regression.** Must stay clean. No TS touched in this spec.

6. **Production data not touched.** This spec is code-only. No backfill, no data UPDATE, no SQL run against production. The dedup behavior applies forward from deploy; historical `webhook_deliveries` rows with random-UUID webhook_ids stay as-is. They're audit ledger; they don't break the new flow.

## Smoke test gate (post-deploy)

Drake's gate (c). Three test cases in `#ella-test-drakeonly`:

1. **Normal message, first delivery.** Post a plain message. Verify in `/ella/runs` (and via SQL on `webhook_deliveries`) that one row exists with `webhook_id = slack_msg_ingest_C0AUWL20U8J_{ts}` and `processing_status='processed'`.

2. **Manual duplicate simulation via curl.** Capture the raw Slack event JSON from the first message's audit row payload. Re-POST it to `/api/slack_events` directly via curl with a valid signature (Drake or Builder generates the signature using `SLACK_SIGNING_SECRET`). Verify:
   - Endpoint returns 200 (Slack-acknowledged).
   - `webhook_deliveries` has a SECOND row with `webhook_id` prefixed `slack_msg_ingest_dup_` and `processing_status='duplicate'`.
   - The `payload.original_delivery_id` field on the duplicate row matches the first message's webhook_id.
   - NO new row in `agent_runs` (the passive-monitor pipeline did not fire).
   - NO new in-channel ack (Ella stayed silent).

3. **Real `message_changed` redelivery (organic test).** Post a message, then EDIT the message in Slack to add a few characters. Slack fires a `message_changed` event with the same `ts` as the original. Verify:
   - `webhook_deliveries` shows the dedup row landing.
   - `slack_messages.text` is updated to the new text (existing upsert behavior; verify this is the desired behavior — if not, surface).
   - NO duplicate `agent_runs` entry (passive-monitor pipeline did not re-fire on the edit).

All three must pass before Builder flips the spec to `shipped`. If any fail, Builder writes a PARTIAL report explaining what was observed and the spec stays `in-flight`.

**After this gate passes, Drake can re-enable passive monitoring on the 136 paused channels.** That's a separate operational step — a single SQL `UPDATE slack_channels SET passive_monitoring_enabled = true WHERE test_mode = false` — not in this spec's scope. The resume is Drake's call to execute when ready.

## What could go wrong

> **UPDATED 2026-05-21:** Subsection #6 below ("`message_changed` events with edited content shouldn't necessarily dedup") was framed as "acceptable for v1" with the reasoning that "Slack edits are rare in client channels." Production observation contradicted that — 11 documented duplicate dispatches across 8 channels in 36 hours of post-resume traffic. The corrective spec re-keys the dedup gate on the inner/stable message ts so edits collide correctly with their originals.
> See: `docs/specs/ella-realtime-ingest-dedup-message-changed.md`.

1. **PK collision exception detection misses an unusual variant.** Mitigation: hard stop #2 forces empirical verification. If the supabase-py library updates and changes the exception format, this code breaks silently (every duplicate becomes a "non-PK exception" fail-open → processes the duplicate). Detection: post-deploy, monitor `webhook_deliveries` for rows with `processing_status='duplicate'` over the first week. Zero rows over a week of production traffic = probably broken (Slack does retry occasionally). A handful of rows = working.

2. **The `_insert_audit` refactor from INSERT to UPDATE introduces a subtle behavior change.** The existing code inserts a row even on the exception path (a `'failed'` row gets inserted with `error=str(exc)[:2000]`). After the refactor, the exception path UPDATEs the existing `'received'` row to `'failed'`. If for some reason the `'received'` row was never written (step 0 fail-open + a subsequent crash), the UPDATE won't find a row to update and the failure goes un-audited. Mitigation: the failure-path code logs to the application logger regardless of audit success. Vercel logs catch it. Acceptable degradation.

3. **Slack delivers an event with a `ts` that doesn't exist in `slack_messages` yet but exists in `webhook_deliveries`** (e.g., the first delivery's `_upsert_message` failed but the audit row was written). Second delivery sees the PK match, treats as duplicate, never tries to upsert. Mitigation: this is actually correct behavior — if the first delivery failed mid-pipeline, the audit row's `processing_status` reflects that, and re-trying the same failed work isn't useful. If the failure was transient, the next *different* Slack delivery would land normally. Edge case acceptable.

4. **The deterministic ID format has length limits.** Slack `ts` values are ~17 chars (`1700000000.123456`); channel IDs are ~11 chars (`C0AUWL20U8J`). The full webhook_id is `slack_msg_ingest_C0AUWL20U8J_1700000000.123456` — ~47 chars. `webhook_id` is a `text` column with no length limit. No issue.

5. **Race between Slack retry and the original delivery completing.** Slack's retry semantics typically wait at least 1 second between retries. The original delivery's step 0 INSERT completes in <100ms typically. By the time a retry arrives, the row is committed. If somehow the original is still in-flight (DB pool exhaustion, network delay), the retry's INSERT will block on the PK lock briefly and then either succeed (if the original failed and was rolled back) or fail with PK collision (if the original succeeded). Either way, exactly one delivery's downstream code fires. Postgres handles this correctly.

6. **`message_changed` events with edited content shouldn't necessarily dedup.** A client might edit their message to add CRITICAL new information ("oh and by the way, I'm also frustrated about X"). Currently the existing upsert overwrites the text in `slack_messages` but the passive-monitor fork would have already fired on the original text. After dedup is added, the second fork dispatch (for the edited version) is suppressed entirely. Net effect: Ella sees the original text only, not the edit. **This is acceptable for v1** — Slack edits are rare in client channels, and the misfire cost from processing edits as new messages is higher than the cost of missing the occasional edit. If this becomes a real friction, future spec adds a separate "treat `message_changed` as a new logical message" path with its own dedup key (e.g., `slack_msg_ingest_{channel}_{ts}_edit_{edit_ts}`).

7. **Multiple workers running concurrently** (e.g., if Vercel ever runs more than one instance of the function). The PK constraint serializes them correctly at the DB layer. No issue.

## Mandatory doc updates

- `docs/state.md` (today's entry, 2026-05-20 — second ship)
- `docs/runbooks/slack_message_ingest.md` (Dedup gate section)
- `docs/known-issues.md` (strike-through the idempotency entry with resolution pointer)
- `docs/agents/ella/ella.md` (minor pipeline description update)

## Done means

- All file edits pushed to `main` per the one-logical-change-per-commit rule (suggested split: commit 1 = new helpers, commit 2 = delivery_id refactor + dedup gate, commit 3 = _insert_audit UPDATE refactor, commit 4 = tests, commit 5 = docs). Builder's call on the exact split.
- `pytest tests/` passes at ≥685 tests (target: ~693-697 after new tests added). No regression.
- `tsc --noEmit` + `next lint` clean.
- Three smoke test cases in `#ella-test-drakeonly` all pass per the gate (c) section.
- Spec status flipped to `shipped` in same Builder commit-sequence as the report.
- Report at `docs/reports/ella-realtime-ingest-idempotency.md` follows 6-section structure.

Drake's gates:
- (a) None — no migrations, no irreversible actions.
- (b) Any genuinely context-confusing decision Builder hits — surface immediately. Specifically: if the PK collision detection in supabase-py isn't unambiguous, surface before shipping the detection logic.
- (c) Three smoke test cases in `#ella-test-drakeonly` — Drake runs each, confirms outcomes. Spec stays `in-flight` until Drake signals all three passed.
- (d) None — no env var changes, no credential touches.

**Production resume gate post-spec.** Once this spec's smoke passes and the spec is `shipped`, production resume becomes available. The resume itself is operational (single SQL UPDATE flipping 136 rows), not Builder's responsibility. Drake decides the resume timing — could be same-session, next-session, or held for a window of monitoring on the test channel first.
