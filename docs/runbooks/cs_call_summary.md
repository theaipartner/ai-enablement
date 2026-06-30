# Runbook — Per-call CS Slack summary auto-post

Operational guide for `agents/gregory/cs_call_summary_post.py` — the
ingestion-pipeline hook that posts a one-message Fathom call summary
to the cross-CSM Slack channel whenever a Fathom webhook delivery
lands a `call_category='client'` call.

**Trigger:** every successful `ingest_call` invocation in `ingestion/fathom/pipeline.py` (post-classification, post-summary write).
**Destination:** `SLACK_CS_CALL_SUMMARIES_CHANNEL_ID` (Slack channel ID, set in Vercel).
**Posts as:** the bot user (`SLACK_BOT_TOKEN`). No user-token fallback (this is an internal CS channel — no APP-tag suppression needed).
**Architecture:** see `docs/agents/gregory.md` § "CS visibility surfaces (M6.1)".

---

## Trigger conditions

The hook fires inside `ingest_call` for every call regardless of category, but only POSTS to Slack when:

1. `classification.call_category == 'client'` (other categories silently skip — no Slack call, no audit row).
2. `record.summary_text` is non-empty (Fathom webhook payloads carry this; TXT backlog records do not — skipped silently with a `malformed` audit row tagging `no_summary_text`).
3. `SLACK_CS_CALL_SUMMARIES_CHANNEL_ID` env var is set (missing → audit row `failed`, no Slack call).

If any of those fail, the Fathom webhook delivery still succeeds — the call row, summary doc, chunks, and action items all land. The Slack post is fire-and-forget by design.

---

## Message format

Plain text mrkdwn (no rich blocks). Only one shape is posted today — the review-shaped message. When no usable review exists for a call, the hook **skips the Slack post entirely** and records the gap in `webhook_deliveries`. (The pre-2026-05-09 Fathom-`default_summary` fallback was retired; see § "Skip-on-no-review" below.)

The review-shape passes through `markdown_to_mrkdwn` (`shared/slack_format.py`) before posting so any rogue Markdown the LLM emitted — `###` headers (line-anchored only), `**bold**`, `[text](url)` links — is normalized to Slack mrkdwn. The cleanup pass is the safety net; review content rarely contains raw Markdown but the LLM isn't deterministic.

### Review-shaped

```
*[CSM Name] / [Client Name]*

*Sentiment*
[sentiment_arc]

*Pain points*
• [description] — _[evidence]_

*Wins*
• [description] — _[evidence]_

*Conversation pivots*
• [description] (who: [who]) — _[evidence]_

<https://ai-enablement-sigma.vercel.app/calls/[call_id]|View in Gregory>
```

Section rules:

- Empty sections are omitted entirely. No "None" filler.
- Sentiment is included whenever `sentiment_arc` is a non-empty string (per the reviewer prompt it's always populated).
- Evidence quotes are wrapped in `_..._` mrkdwn italic.
- The `Conversation pivots` subsection is the user-facing rename of the review's underlying `dodged_questions` field. The `(who: [who])` suffix marks who did the dodging.
- If the parsed review yields zero usable sections (all four fields empty / missing / wrong shape), the post falls through to the **skip path** (no Slack call; audit row records the gap).

### Skip-on-no-review

When the call has no `call_review` document, the document JSON is malformed, or `_format_review_message` returns `None` (degenerate render), the hook does NOT post to Slack. Instead it inserts an audit row with:

| Field | Value |
|---|---|
| `processing_status` | `'malformed'` |
| `processing_error` | `'no_review_available'` |
| `payload.content_source` | `'skipped_no_review'` |
| `payload.review_fetch_error` | populated only when a DB exception caused the miss (rare) |

Why `'malformed'` and not `'skipped'`: migration 0011's CHECK constraint on `webhook_deliveries.processing_status` only allows `{'received','processed','failed','duplicate','malformed'}` — adding `'skipped'` would require a migration. The dual discriminator (`processing_error='no_review_available'` plus `payload.content_source='skipped_no_review'`) keeps the audit row queryable without one. The same `'malformed'` value is reused by the `no_summary_text` skip path; debuggers disambiguate the two via `processing_error`.

### Sentinel labels

| Field | Sentinel | When |
|---|---|---|
| CSM Name | `[unassigned]` | client has no active primary_csm assignment |
| Client Name | `[unknown client]` | `primary_client_id` doesn't resolve to a clients row |

Surfacing the sentinel makes the gap visible in Slack rather than silently dropping the post (revisit if the sentinels become a problem).

### Audit row: `content_source` field

Every audit row's `payload` JSON includes a `content_source` field tagging which path the post took. Values:

| Value | Meaning |
|---|---|
| `'call_review'` | Review-shaped message was posted. |
| `'skipped_no_review'` | No usable review existed; no Slack post was attempted. |
| ~~`'fathom_summary_fallback'`~~ | **Retired 2026-05-09.** Old rows preserve this value; no new rows carry it. |

Useful for splitting review-vs-skip rate in audit dashboards. Query example:

```sql
SELECT payload->>'content_source' AS content_source,
       COUNT(*) AS rows,
       SUM((processing_status = 'processed')::int) AS posts_succeeded
FROM webhook_deliveries
WHERE source = 'cs_call_summary_slack_post'
  AND received_at > now() - interval '7 days'
GROUP BY 1;
```

When the review fetch itself raises a DB exception (rare; not "row simply absent"), the path still falls through to skip AND the payload carries a `review_fetch_error` string for triage. `content_source` stays the binary `'call_review'`/`'skipped_no_review'` value either way.

---

## Quick health check

Verify a recent call posted:

```sql
SELECT webhook_id, processing_status, processed_at, payload->>'csm_name', payload->>'client_name'
FROM webhook_deliveries
WHERE source = 'cs_call_summary_slack_post'
ORDER BY received_at DESC
LIMIT 10;
```

Expected: most-recent rows are `processing_status='processed'` with both `csm_name` and `client_name` populated.

To confirm a specific call posted, search by Fathom external_id:

```sql
SELECT webhook_id, processing_status, processing_error, payload
FROM webhook_deliveries
WHERE source = 'cs_call_summary_slack_post'
  AND call_external_id = '<fathom_recording_id>';
```

---

## Debug a missing post

If a CSM expected a call summary in the channel but didn't see one:

1. **Confirm the call was ingested by Fathom.** Check `calls.external_id` for the recording id from Fathom's UI:

   ```sql
   SELECT id, call_category, primary_client_id, started_at
   FROM calls WHERE external_id = '<fathom_recording_id>' AND source = 'fathom';
   ```

   - No row → Fathom webhook never delivered or failed. Check `webhook_deliveries WHERE source='fathom_webhook' ORDER BY received_at DESC` for the delivery status.
   - `call_category != 'client'` → the post was skipped silently by design (no audit row). The classifier categorized this as internal/external/unclassified. Check `call_classification_history` for the reason; reclassify via the Gregory dashboard if wrong.

2. **Check the cs_call_summary_slack_post audit trail:**

   ```sql
   SELECT processing_status, processing_error, payload
   FROM webhook_deliveries
   WHERE source = 'cs_call_summary_slack_post'
     AND call_external_id = '<fathom_recording_id>';
   ```

   - **No row** → the hook didn't fire for this call. Either the call wasn't a client call (skipped silently — see step 1), or the hook itself raised before reaching the audit insert. Check Vercel function logs for `cs_call_summary_post hook raised`.
   - **`processing_status='malformed'`, `processing_error='no_review_available'`** (with `payload.content_source='skipped_no_review'`) → the call has no usable `call_review` document. Either the auto-review hook hasn't run yet (check `documents` for a row with `source='fathom'`, `external_id=<recording_id>`, `document_type='call_review'`), or the review JSON is malformed / degenerate. The pipeline auto-generates reviews after the summary doc is written, so a missing review usually means the review-gen failed; check `agent_runs` for the most recent `call_reviewer` invocation on this call.
   - **`processing_status='malformed'`, `processing_error='no_summary_text'`** → the Fathom payload didn't include a `default_summary`. Possible causes: Fathom hasn't generated the summary yet (re-summary is delivered as a second webhook fire — check `webhook_deliveries` for a later fathom_webhook delivery on the same external_id), or the call was a TXT-backlog re-ingest (which doesn't carry summaries). Disambiguate from the `no_review_available` skip via `processing_error` (both share `processing_status='malformed'` because of the migration-0011 CHECK constraint — see § Skip-on-no-review above).
   - **`processing_status='failed'`, `processing_error='SLACK_CS_CALL_SUMMARIES_CHANNEL_ID not set'`** → env var missing in Vercel. Set it and redeploy.
   - **`processing_status='failed'`, `processing_error=<slack-error-code>`** → Slack returned `ok=false`. Common errors:
     - `channel_not_found` → channel ID wrong or bot not invited.
     - `not_in_channel` → bot needs invitation: `/invite @ella` (or whichever bot the workspace uses) inside the destination channel.
     - `missing_scope` → bot doesn't have `chat:write` on the workspace.
     - `rate_limited` → Slack rate limit hit. At our volume (~5–15 client calls/day) this should be impossible; investigate whether something is mass-replaying old calls.

3. **Re-fire the post manually** (if the Fathom delivery succeeded but the Slack post didn't): no first-class re-fire surface today. Easiest path is to delete the failed audit row and re-deliver the Fathom webhook from Fathom's UI (Settings → API Access → Deliveries → Re-deliver). The pipeline is idempotent — call row + summary doc are upserted; the second hook fire produces a fresh CS-summary post.

---

## Bot installation

The bot must be a member of `SLACK_CS_CALL_SUMMARIES_CHANNEL_ID`. Steps:

1. From any channel: `/invite @<bot_name>` — same bot that powers Ella (`SLACK_BOT_TOKEN` workspace).
2. Verify with a probe POST: see the Vercel function logs for the next inbound Fathom client call, or smoke-test by directly invoking the helper from a Python REPL:

   ```bash
   .venv/bin/python -c "
   from shared.slack_post import post_message
   import os
   r = post_message(os.environ['SLACK_CS_CALL_SUMMARIES_CHANNEL_ID'], 'health check from runbook')
   print(r)
   "
   ```

   Expected: `{'ok': True, 'slack_error': None}`. Any other result → see "Debug a missing post" above for the slack_error mapping.

---

## Re-running the local harness

```bash
.venv/bin/python scripts/test_cs_call_summary_locally.py
```

Expected: `65/65 checks passed`. Read-only against cloud DB except for one self-seeded test client + CSM (and a handful of synthetic `call_review` documents seeded for the review-path tests) that get hard-deleted in cleanup. No real Slack posts (the harness mocks `shared.slack_post.post_message` per-test; pytest tests use the `tests/conftest.py` autouse fixture instead — see § Test hermeticity below).

---

## Test hermeticity

Pytest tests under `tests/` are protected from accidentally hitting real Slack by `tests/conftest.py`, which registers an autouse fixture that monkeypatches `shared.slack_post.post_message` (and the import-time-bound re-export at `agents.gregory.cs_call_summary_post.post_message`) to a no-op for every test in the suite. This is belt-and-suspenders alongside the skip-on-no-review path — even if a future test seeds a `call_review` document and engages the post path, the autouse fixture intercepts the call before it reaches `chat.postMessage`.

The conftest's docstring documents the import-time-binding gotcha that made the dual-patch necessary: `from shared.slack_post import post_message` binds `post_message` as a *local* name inside the importing module at import time, so patching only the source module wouldn't intercept the live caller. When a new pytest test imports a module that re-exports `post_message`, add the dotted path to the conftest's monkeypatch list.

The local harness (`scripts/test_cs_call_summary_locally.py`) lives outside `tests/` so the conftest doesn't apply — its existing in-scope `unittest.mock.patch` calls handle Slack mocking instead.

---

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| No Slack post for a client call | Bot not invited to channel | `/invite @<bot>` in channel |
| `webhook_deliveries` audit row marked `failed` with `channel_not_found` | Wrong channel ID in Vercel env | Update `SLACK_CS_CALL_SUMMARIES_CHANNEL_ID` |
| `webhook_deliveries` audit row marked `malformed` with `no_summary_text` | Fathom webhook payload had no `default_summary` (rare; Fathom re-fires when summary lands) | Wait for the re-fire OR re-deliver from Fathom UI |
| `webhook_deliveries` audit row marked `malformed` with `no_review_available` (and `payload.content_source='skipped_no_review'`) | The `call_review` document for this call is missing or malformed — the hook deliberately skipped the post | Check `agent_runs` for the most recent `call_reviewer` invocation; if it failed, re-run via `scripts/backfill_call_reviews.py --apply --limit 1` filtered to that call |
| Fathom webhook 500s after the M6.1 hook is added | Hook raised an unhandled exception | Should be impossible — the hook is wrapped in try/except in `pipeline.py` and never propagates. If it happens, check Vercel logs for the traceback and file a bug |
| CSM name shows `[unassigned]` | Client has no active primary_csm assignment | Assign via the Gregory dashboard (Section 1 → Primary CSM dropdown) |
| Client name shows `[unknown client]` | `primary_client_id` doesn't resolve to a clients row | Investigate — likely a stale primary_client_id from a since-archived merge source |

---

## Schema + audit references

- Hook implementation: `agents/gregory/cs_call_summary_post.py`
- Pipeline integration: `ingestion/fathom/pipeline.py:ingest_call` (after `_ensure_summary_document` and `_ensure_call_review_document`, before `IngestOutcome` return)
- Review reader: `agents.call_reviewer.persistence.find_review_by_call_external_id`
- Cleanup pass: `shared/slack_format.py:markdown_to_mrkdwn`
- Slack-post helper: `shared/slack_post.py:post_message`
- Harness: `scripts/test_cs_call_summary_locally.py`
- Test-hermeticity autouse mock: `tests/conftest.py`
- webhook_deliveries source label: `cs_call_summary_slack_post`
- webhook_deliveries audit `payload.content_source`: `'call_review'` (post fired) or `'skipped_no_review'` (post skipped). `'fathom_summary_fallback'` retired 2026-05-09; old rows preserved.
- Build log entry: `docs/agents/gregory.md` § "CS visibility surfaces (M6.1)"

The audit trail is queryable end-to-end: every Fathom client-call delivery produces one fathom_webhook row + one cs_call_summary_slack_post row, both keyed on the same Fathom `external_id` via `call_external_id`. Joinable in SQL:

```sql
SELECT
  fw.received_at AS fathom_received,
  fw.processing_status AS fathom_status,
  cs.received_at AS cs_post_received,
  cs.processing_status AS cs_post_status,
  cs.payload->>'csm_name' AS csm,
  cs.payload->>'client_name' AS client
FROM webhook_deliveries fw
LEFT JOIN webhook_deliveries cs ON cs.call_external_id = fw.call_external_id
  AND cs.source = 'cs_call_summary_slack_post'
WHERE fw.source = 'fathom_webhook'
  AND fw.received_at > now() - interval '7 days'
ORDER BY fw.received_at DESC;
```
