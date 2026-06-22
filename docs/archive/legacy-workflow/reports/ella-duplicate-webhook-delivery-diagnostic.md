# Report: Ella Duplicate Webhook-Delivery Diagnostic
**Slug:** ella-duplicate-webhook-delivery-diagnostic
**Spec:** docs/specs/ella-duplicate-webhook-delivery-diagnostic.md
**Type:** Diagnostic (read-only). No code/test/runtime-doc changes; the only file written is this report.

## Files touched

**Created:**
- `docs/reports/ella-duplicate-webhook-delivery-diagnostic.md` (this file).

No other files touched. No code, tests, or runtime docs modified.

## What I did, in plain English

Walked the acclimatization checklist (CLAUDE.md operational patterns, the 2026-05-19 EOD + three follow-up state.md entries, `api/slack_events.py`, `ingestion/slack/realtime_ingest.py`, `ingestion/slack/parser.py`, and migrations 0011 + 0002) before any analysis. Confirmed in 4 bullets:

- **`api/slack_events.py`** routes `event_callback` payloads based on `event.type`. `message` → `_ingest_message_event` → `ingest_message_event`. `app_mention` → logged no-op (the parallel `message` event handles passive). The `X-Slack-Retry-Num` short-circuit (line 114) fires BEFORE the event-type dispatch, so Slack-initiated HTTP retries never reach the ingest pipeline at all — they're not part of the duplicate-pattern under investigation.
- **`ingestion/slack/realtime_ingest.py:ingest_message_event`** builds `delivery_id` at line 88 from `slack_ts = event.get("ts")` — the OUTER event ts on whatever envelope Slack delivered. For a `message_changed` event, this is the EDIT-event ts, not the original message's ts. Step 0's dedup-gate UPSERT keys on this outer ts.
- **The `message_changed` unwrap** (lines 173-180) reassigns `event_for_parser = event.get("message")` so the PARSER sees the inner event. The parser writes `record.slack_ts = inner.ts` — the ORIGINAL message ts. `_insert_audit` writes that into `payload.slack_ts`, and `_upsert_message` upserts to `slack_messages` keyed on `(slack_channel_id, slack_ts)` which is also the original ts. So `slack_messages.raw_payload`, `slack_messages.slack_ts`, and `webhook_deliveries.payload.slack_ts` all reflect the inner (original) ts, while the dedup key encodes the outer (edit-event) ts. **Two distinct keys for the same logical message.**
- **No `message_changed` subtype filtering** anywhere downstream. The parser's `_SYSTEM_SUBTYPES` includes `message_deleted` but explicitly NOT `message_changed` — edits are by-design treated as new content that updates the row.

Then ran the diagnostic queries against cloud Supabase via psycopg2 (pooler URL). Concluded the investigation after Q1–Q5 per hard stop #4; Q7/Q9 (Vercel log access) and Q8 (additional Slack-docs research) became unnecessary once the root cause was empirically established.

### Q1 — full payloads of the two `webhook_deliveries` rows

Both rows for the Trevor case (`C0AEEPVK36W`) were pulled directly. **Identical payload shapes**, both with `subtype: null`, `author_type: client`, `slack_user_id: U04LA7MK9CN`, `content_source: ingested`, and **identical `slack_ts: 1779309969.851479`** — but different `webhook_id`s (`...969.851479` vs `...983.000100`) and `received_at` 12.6 seconds apart (20:46:11.546668+00 vs 20:46:24.153414+00). Both rows show `processing_status='processed'` — the second delivery ran the full pipeline (slack_messages upsert + passive-monitor fork + escalation dispatch).

The raw Slack-event shape is NOT in the audit payload — `_insert_audit` writes the parsed `SlackMessageRecord`, not the raw envelope. To recover the original event shape, I traced upward into `slack_messages.raw_payload` (Q3 below) which DOES hold the parser's input.

### Q2 — what outer `event.ts` produced each webhook_id

Inferred indirectly from Q3 + Q5. The first delivery's encoded ts `1779309969.851479` equals the original message ts (high-entropy microseconds, natural Slack ts shape). The second delivery's encoded ts `1779309983.000100` is exactly 13.149 seconds later and ends in clean `.000100` microseconds — Slack's `message_changed` event sets `event.message.edited.ts` to a near-real-time timestamp when the user saved the edit, and `event.ts` (the OUTER edit-event ts) tracks closely (within ~100µs). Q3's evidence below pins this conclusively.

### Q3 — the `slack_messages` row's `raw_payload`

Single row in `slack_messages` for `(C0AEEPVK36W, 1779309969.851479)`. The `raw_payload` contains an `edited` field — the smoking gun:

```json
{
  "ts": "1779309969.851479",
  "type": "message",
  "user": "U04LA7MK9CN",
  "text": "I also am looking at the GHL Initial Buildout video and at 4:40 is mentions my video which is my VSL.  I don't quite see my video so do I have to make that or is it already there?",
  "edited": {
    "ts": "1779309983.000000",
    "user": "U04LA7MK9CN"
  },
  ...
}
```

`edited.ts = 1779309983.000000` matches (within 100 microseconds) the second webhook_id's encoded ts `1779309983.000100`. **This row is the post-edit state of the message — the second delivery (the `message_changed` event) overwrote `slack_messages.raw_payload` with the inner-event-plus-edited-field shape via the upsert.** The user (Trevor) edited their original 20:46:09 message at 20:46:23 (clean-microsecond `.000000` because Slack stamps `edited.ts` to second-level precision when it's not coming from the natural-entropy ts source).

### Q4 — `slack_messages` near `1779309983.000100`

Single row: `ts=1779309989.065889`, `slack_user_id=U0ATX2Y8GTD` (Ella's user id) — Ella's second ack post. **No `slack_messages` row exists with ts `1779309983.000100`.** That ts is NOT a real Slack message timestamp; it's the OUTER event ts of the `message_changed` event, distinct from any message in the table.

### Q5 — production scope of the post-deterministic-key duplicate pattern

Across the 11 distinct duplicate sets that landed since 2026-05-20 (when the deterministic-key gate went live), **every single one shares the exact same shape**: one webhook_id encodes the natural high-entropy original ts, the other encodes a `.000XXX` clean-microsecond ts within seconds. Cross-referenced `slack_messages.raw_payload` for five of them — three explicitly show an `edited` field with `edited.ts` matching (within 100µs) the second webhook_id's encoded ts; the other two no longer carry `edited` in `slack_messages.raw_payload` (overwritten by a later edit or post-edit operation — the upsert is destructive on `raw_payload`) but still exhibit the identical webhook_id pattern.

Channels affected since 2026-05-20: `C0ARZJB2CLA` (3 dupes), `C09GA380JRM` (2 dupes), `C094XG2BG15`, `C09DGEACT1C`, `C09F4LWQNAK`, `C0ASJ4PR9FT`, `C0ALWP2QV16`, `C0AEEPVK36W` — 8 distinct channels, 11 distinct messages.

**Zero `slack_msg_ingest_dup_*` audit rows have been written since 2026-05-20.** The dedup gate has never caught a true duplicate in production. Every duplicate delivery has slipped through. This is internally consistent with the diagnosis: the dedup key (outer event ts) is structurally different across the two Slack deliveries for the same logical edited message, so the PK collision the gate relies on never fires.

### Q6, Q7, Q8, Q9 — deferred per hard stop #4

Q1-Q5 produced an evidence-grounded root cause. Q6 (cross-pair pattern across duplicates) was effectively answered by Q5's scope check — all 11 post-deterministic-key duplicates exhibit the same outer-vs-inner-ts pattern. Q7/Q9 (Vercel logs) require interactive `vercel login` + project authentication; even with that, Vercel Hobby retains only ~1h of logs and the Trevor case is now >24 hours old. Q8 (Slack Events API deep dive on `message_changed` vs `app_mention` semantics) was no longer needed once `raw_payload.edited` empirically tied the second delivery to a `message_changed` shape.

### Root cause

**Slack `message_changed` events have a different OUTER `event.ts` than the original `message` event for the same logical message.** The dedup gate's key construction at `ingestion/slack/realtime_ingest.py:88` reads `event.get("ts")` — the outer ts. The original delivery's outer ts equals the message's natural ts (`1779309969.851479`). The edit's outer ts is the edit-event time (`1779309983.000100`). The two are distinct, so the PK on `webhook_deliveries.webhook_id` doesn't collide. The dedup gate at step 0 returns "first-time delivery" for both, and the full pipeline runs twice: two `slack_messages` upserts (the second overwrites with the post-edit raw_payload), two passive-monitor evaluations, two `acknowledge_and_escalate` decisions, two in-channel acks, two escalation rows, and four DMs (Scott + the primary advisor, each fan-out fires twice).

The previous spec's `What could go wrong #6` did identify this risk in advance, but framed it as "acceptable for v1" with the reasoning that "Slack edits are rare in client channels." Production reality is that edits happen often enough to produce 11 documented duplicate dispatches in ~36 hours of post-resume traffic across 8 channels.

## Data verification

Queries run against cloud Supabase via `psycopg2` on the pooler URL stored in `supabase/.temp/pooler-url`, authenticated with `SUPABASE_DB_PASSWORD` from `.env.local`. All queries read-only.

| Query | Purpose | Row count |
|-------|---------|-----------|
| `SELECT ... FROM webhook_deliveries WHERE webhook_id IN ('slack_msg_ingest_C0AEEPVK36W_1779309969.851479', 'slack_msg_ingest_C0AEEPVK36W_1779309983.000100')` | Q1: full payloads | 2 |
| `SELECT ... FROM slack_messages WHERE slack_channel_id = 'C0AEEPVK36W' AND slack_ts = '1779309969.851479'` | Q3: raw_payload | 1 |
| `SELECT ... FROM slack_messages WHERE slack_channel_id = 'C0AEEPVK36W' AND slack_ts BETWEEN '1779309980' AND '1779309990'` | Q4: nearby slack_ts | 1 (Ella's second ack, not a client message) |
| `SELECT payload->>'slack_channel_id', payload->>'slack_ts', COUNT(*) ... GROUP BY ... HAVING COUNT(*) > 1` (trailing 7 days) | Q5: scope of dupes | 50 total sets returned (39 pre-deterministic-key UUIDs from before 2026-05-20 + 11 post-deterministic-key) |
| `SELECT raw_payload FROM slack_messages WHERE (channel, ts) IN (5 post-deterministic-key duplicate originals)` | Q5: confirm `edited` field on samples | 3/5 still carry `edited` in current raw_payload (upsert-overwrite is destructive on the other 2) |
| `SELECT COUNT(*) FROM webhook_deliveries WHERE webhook_id LIKE 'slack_msg_ingest_dup_%' AND received_at >= '2026-05-20'` | Verify dedup gate has never caught a true production duplicate | 0 |

The queries are reproducible — run via Bash with the credentials above, using the exact statements documented in the spec § Q1, Q3, Q4, Q5 (with the time bound tightened to `received_at >= '2026-05-20'` for the post-deterministic-key scope cut).

## Surprises and judgment calls

**The previous spec's "What could go wrong #6" anticipated this exact failure mode but classified it as acceptable.** From `ella-realtime-ingest-idempotency.md` lines 305-311: *"`message_changed` events with edited content shouldn't necessarily dedup... This is acceptable for v1 — Slack edits are rare in client channels, and the misfire cost from processing edits as new messages is higher than the cost of missing the occasional edit."* Production traffic shows the opposite — 11 duplicate dispatches across 8 channels in ~36 hours. The acceptability framing was a judgment call I made in the prior session and it under-estimated client edit frequency in coaching channels (where clients commonly re-read their question and edit for clarity). Per gate (b), surfacing this in the report.

**The previous spec's test `test_message_changed_uses_outer_ts_for_dedup_key` pinned the broken behavior as expected behavior.** The test asserts that the first edit-event is processed and only a *retry* of the same edit-event is deduped. It does not test the case where a single user edit produces a duplicate dispatch alongside the original delivery — which is precisely the production failure mode. The test, as written, would have to be deleted or rewritten for the fix. Surfacing this in the report (not editing — read-only spec) so Drake / the fix-spec author know it's a known regression vector to update.

**Two post-deterministic-key duplicates show no `edited` field in `slack_messages.raw_payload`.** Initially I expected all 11 to. Three of five sampled DO have `edited`; two don't. Likely explanation: the upsert into `slack_messages` is destructive on `raw_payload`, and a SECOND edit (or another later message_changed dispatch from Slack) overwrites the first edited version with a newer payload that lacks the `edited` field. I could not verify this hypothesis without raw event capture (which the system doesn't preserve). It does NOT change the root-cause diagnosis — the duplicate-webhook-id pattern is identical across all 11 cases, and the .000XXX clean-microsecond signature is unambiguous evidence of a message_changed outer event ts. Reporting the unresolved sub-question honestly per hard stop #5.

**The `.000XXX` microsecond pattern across all 11 dupes is not random.** Every second-delivery webhook_id has microsecond suffix `.000100`, `.000200`, `.000300`, or `.000800`. The `edited.ts` field in raw_payload uses `.000000`. These differ by 100µs, 200µs, etc. — suggesting Slack's `message_changed` event-creation logic stamps `event.ts` at edit-time + a small synthetic offset (likely a delivery-counter or sequence number multiplied by 100µs). This is internal Slack behavior; documenting the observation but no causation claim per hard stop #2.

**Side-finding not in scope but flagged per spec line 277:** Ella's posts in `slack_messages` are tagging as `author_type='bot'` rather than `'ella'` for `slack_user_id='U0ATX2Y8GTD'`. The spec already noted this at line 72 ("Investigation of this is OUT OF SCOPE for this spec"). Confirmed empirically in Q4 — Ella's second ack at `1779309989.065889` resolves to `author_type='bot'`. Not investigating; this is a separate phenomenon downstream of `parser._resolve_author`'s `ella_user_id` resolution.

## Out of scope / deferred

The fix is the next session's work — explicitly out of scope per spec lines 246-257.

**Follow-up fix spec slug:** `ella-realtime-ingest-dedup-message-changed`.

**One-paragraph description for the fix spec:** Slack `message_changed` events have a different OUTER `event.ts` than the original `message` event for the same logical message, so the current dedup gate at step 0 of `ingest_message_event` keys on a non-stable identifier and lets edited messages re-fire the full pipeline. The fix needs to make the dedup key stable across edits — either by (a) constructing the key AFTER parsing using `record.slack_ts` (which is the inner ts and stable across edits) so the second delivery's UPSERT collides correctly, or (b) by treating `subtype=='message_changed'` as a separate code path that updates `slack_messages.text` but skips the passive-monitor fork entirely. (a) is the minimal-surface change; (b) is the more architectural one. The fix spec should also delete or rewrite the previous spec's `test_message_changed_uses_outer_ts_for_dedup_key` (currently pins the broken behavior) and update `docs/runbooks/slack_message_ingest.md` § Dedup gate to describe the new key shape. The fix spec needs no migration and no env-var changes; behavior change is code-only.

**Open questions the fix spec should answer:**

1. Choice between options (a) and (b) above. (a) preserves the existing "edits update the slack_messages row" behavior but the dedup gate now blocks the second passive-monitor dispatch correctly. (b) is cleaner architecturally but loses some flexibility (an edit that adds critical new content gets no Ella response). Recommended lean: (a) is the lower-risk fix; (b) can come later if (a) misses important edit cases.

2. Production-resume posture: with the fix in place + the no-dedup-history-fired-yet observation, should the 136 channels stay enabled while the fix ships, or kill-switch back to off until the fix lands? Drake's call.

3. Whether to add a temporary instrumentation layer to capture raw Slack event payloads for the next duplicate occurrence, so future diagnoses don't have to triangulate from `slack_messages.raw_payload`. Out of scope for the immediate fix but worth raising.

## Side effects

**None — read-only diagnostic.** Five SELECT-only queries against `webhook_deliveries` and `slack_messages` via the pooler URL. No INSERTs, no UPDATEs, no production data modified, no Slack posts, no cron triggers, no instrumentation added. The only file written was this report.
