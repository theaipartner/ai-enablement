# Architecture: Fathom Webhook + Daily Backfill Cron

Live-path companion to the existing Fathom backlog pipeline. The backlog pipeline
(`ingestion/fathom/pipeline.py` + `cli.py`) stays as-is for batch re-ingest. This
doc specifies the live path that lands every new coaching call into cloud
Supabase within seconds of Fathom finishing its post-processing, plus a daily
backfill that catches any webhook delivery that failed to stick.

**Status.** Spec — committed 2026-04-24 as F2.2. F2.3 implements it. Two live-test
unknowns from F2.1 (retry schedule, `webhook-id` stability across retries) are
still open; the design is robust to worst-case assumptions on both.

**Related docs.**
- `docs/fulfillment/known-issues.md` § "Fathom webhook — delivery semantics live-test (3 of 4 still open, plan-tier resolved)" — the unknowns still to resolve empirically
- `docs/runbooks/fathom_backlog_ingest.md` — batch path that this complements
- `docs/runbooks/slack_webhook.md` — sync-on-Vercel precedent (same pattern here)
- `docs/agents/ella/ella.md` — downstream consumer of the data this lands

## Doc-vs-reality deltas surfaced at deploy (M1.2.5, 2026-04-27)

Two F2.1 doc-read assumptions turned out to differ from Fathom's
deployed API. Both fixed; pinned by unit tests; flagged here so this
doc is the source of truth on what actually ships:

1. **Outbound auth: `X-Api-Key`, not `Authorization: Bearer`.** The
   OpenAPI spec describes `securitySchemes: bearerAuth`, but Fathom's
   deployed `/external/v1/*` endpoints accept `X-Api-Key: <key>` and
   reject `Bearer` with 401. `api/fathom_backfill.py:_fetch_meetings_window`
   sends `X-Api-Key`. Cited in inline comments at the request site.
2. **Summary key: `markdown_formatted`, not `markdown`.** Fathom
   delivers `default_summary` as `{"markdown_formatted": "...",
   "template_name": "..."}`. The spec didn't enumerate `MeetingSummary`'s
   fields, so F2.1's defensive fallback list (`markdown`/`text`/
   /`content`/`body`/`summary`) missed the actual key. Adapter at
   `ingestion/fathom/webhook_adapter.py:_extract_summary_text` now
   checks `markdown_formatted` first, with the legacy fallbacks
   retained. Pinned by `test_summary_with_markdown_formatted_field_accepted`.

The shared lesson: read OpenAPI carefully, but probe with one real
curl before declaring discovery done. Captured in `docs/fulfillment/known-issues.md`
§ "API integration discovery — verify auth scheme empirically before
declaring done" and in saved memory.

## Non-goals

- Streaming webhooks into agents in real time. Agents consume via retrieval; a call landing at 2:04pm doesn't need to be in Ella's next reply at 2:04pm.
- Reconciling Fathom's CRM matches. Out of scope; `crm_matches` field is ignored today (see followups entry).
- Manual replay of failed deliveries through a UI. If cron backfill doesn't catch a missed call, Drake reruns the backlog ingest against a one-off TXT export. Replay tooling is deferred until we see frequency.

## Component overview

```
         Fathom ────(new-meeting-content-ready)──┐
                                                  ▼
  POST /api/fathom_events   ──────► api/fathom_events.py
                                     │  1. verify_signature
                                     │  2. insert webhook_deliveries (PK=webhook-id)
                                     │  3. adapter: payload → FathomCallRecord
                                     │  4. pipeline.ingest_call(record, …)
                                     │  5. update webhook_deliveries.status
                                     ▼
                                  cloud Supabase
                                     ▲
   Vercel Cron (daily 08:00 UTC) ───►│
                                     │
  GET  /api/fathom_backfill  ──────► api/fathom_backfill.py
                                        1. GET /meetings?created_after=<t>
                                        2. filter to unseen recording_ids
                                        3. ingest via same pipeline
                                        4. log to webhook_deliveries
                                           (source='fathom_cron')
```

Every new coaching call arrives via the webhook. Every ~24h a cron sweep checks
Fathom's `/meetings` API for anything we didn't ingest via webhook and fills
those in. Both paths converge on the same `pipeline.ingest_call` that the
backlog uses — one code path, many upstreams.

## a) Endpoint shape — `api/fathom_events.py`

Mirrors `api/slack_events.py` structurally: Python `BaseHTTPRequestHandler`
subclass exported as `handler`, Vercel's Python runtime wraps it. Single `POST`
handler. No `GET` (Fathom never verifies via GET like Slack's `url_verification`
challenge).

Request flow (all synchronous):

1. **Read raw body once.** The signature algorithm hashes the raw bytes, so we
   cannot let `json.load(self.rfile)` consume them. `rfile.read(content_length)`
   → `body_bytes`, then `json.loads(body_bytes)`.
2. **Verify signature.** See §b. On fail: return `401` with empty body, log to
   stderr only (don't persist malicious content).
3. **Insert `webhook_deliveries`** keyed on `webhook-id` header. On unique
   violation → this is a retry or concurrent invocation; return `200`
   immediately (the other invocation handles it). No further work.
4. **Adapt payload** to `FathomCallRecord` via
   `ingestion/fathom/webhook_adapter.record_from_webhook(payload)`. On parse
   error (missing required field): update `webhook_deliveries.status='malformed'`,
   persist traceback + payload snippet into `error` jsonb, return `400`. Return
   400 (not 500) because retries won't help — the payload itself is bad, Drake
   investigates manually.
5. **Build resolvers.** `pipeline.load_resolvers(db)` — two SELECTs, cheap (<100ms).
6. **Call `pipeline.ingest_call(record, db, client_resolver=…, team_resolver=…,
   embed_fn=shared.kb_query.embed, dry_run=False)`.** Existing path. Writes
   `calls`, `call_participants`, and (for client calls) `documents` +
   `document_chunks`. New code in §d populates `call_summary` doc and
   `call_action_items` rows when those fields are present on the record.
7. **Update `webhook_deliveries`:** `status='done'`, `processed_at=now()`,
   `call_external_id=<recording_id>`.
8. **Return `200`** with small JSON body for observability: `{"delivered":
   webhook_id, "external_id": recording_id, "action": "inserted"|"updated"}`.

Total typical wall time: ~5s (most of it in chunk embedding). Worst case
(2-hour call, 40 chunks): ~15s. Well under Vercel's 60s cap.

On any unhandled exception: `webhook_deliveries.status='failed'`, `error`
populated, return `500`. Fathom's retry mechanism catches transient outages
(OpenAI flake, Supabase pool saturation) without us writing queue logic.

## b) Authentication

Fathom signs deliveries per the Standard Webhooks spec. Headers:
- `webhook-id` — unique per message (stable across retries per spec; unconfirmed for Fathom — live test pending)
- `webhook-timestamp` — Unix seconds
- `webhook-signature` — space-delimited `v1,<base64>` signatures

Secret format: `whsec_<base64>`, stored in Vercel env var
**`FATHOM_WEBHOOK_SECRET`**. Set in F2.4 from the `secret` field returned by
Fathom's `POST /webhooks` response. Not committed to the repo.

Verification (pure Python, ~15 lines, no SDK dep):

```python
import base64, hmac, hashlib, time, os

def verify_fathom_signature(body: bytes, headers: dict[str, str]) -> bool:
    wh_id = headers.get("webhook-id", "")
    wh_ts = headers.get("webhook-timestamp", "")
    wh_sig = headers.get("webhook-signature", "")
    secret = os.environ["FATHOM_WEBHOOK_SECRET"]
    if not (wh_id and wh_ts and wh_sig and secret.startswith("whsec_")):
        return False
    # Replay window: reject >5min old
    try:
        ts = int(wh_ts)
    except ValueError:
        return False
    if abs(time.time() - ts) > 300:
        return False
    # Decode secret, compute expected signature
    secret_bytes = base64.b64decode(secret[len("whsec_"):])
    signed = f"{wh_id}.{wh_ts}.".encode() + body
    expected = base64.b64encode(
        hmac.new(secret_bytes, signed, hashlib.sha256).digest()
    ).decode()
    # Constant-time compare against each provided signature
    for candidate in wh_sig.split():
        _, _, sig_b64 = candidate.partition(",")
        if sig_b64 and hmac.compare_digest(sig_b64, expected):
            return True
    return False
```

No SDK dependency — keeps the serverless cold-start fast. If this grows
(multi-version signatures, rotation-in-flight) we adopt the `standardwebhooks`
PyPI package.

**On mismatch:** `self.send_response(401)`; `self.end_headers()`. No body. Log
"signature_fail" + masked `webhook-id` prefix only. Never persist the payload
(could be malicious).

## c) Idempotency — new table `webhook_deliveries`

Dedup state lives in Postgres. Vercel serverless has no persistent memory
between invocations; an in-process LRU won't catch retries. This is the
reason for a dedicated table.

**Migration applied 2026-04-24 (0011)**, with two column-name tweaks from
the initial spec for clarity:

- `status` → `processing_status` (the unqualified `status` name collides
  conceptually with other enum-like columns elsewhere)
- enum values `processing`/`done` → `received`/`processed` (more accurate:
  the initial state is "received but not yet processed," not "currently
  processing which sounds like a per-row lock")
- `error jsonb` → `processing_error text` (the error we log is a Python
  traceback string; jsonb added no value)
- `source` default: `fathom_webhook` (not `fathom`) so `fathom_cron`
  rows created by the backfill path are distinguishable by this column
  alone

Actual migration-0011 DDL:

```sql
alter table documents drop constraint documents_source_external_id_key;
alter table documents
  add constraint documents_source_external_id_type_key
  unique (source, external_id, document_type);

create table webhook_deliveries (
  webhook_id         text primary key,
  source             text not null default 'fathom_webhook',
  received_at        timestamptz not null default now(),
  processed_at       timestamptz,
  processing_status  text not null default 'received'
                     check (processing_status in
                            ('received','processed','failed','duplicate','malformed')),
  processing_error   text,
  call_external_id   text,
  payload            jsonb,
  headers            jsonb
);
create index webhook_deliveries_received_at_idx on webhook_deliveries (received_at desc);
create index webhook_deliveries_status_idx on webhook_deliveries (processing_status)
  where processing_status <> 'processed';
create index webhook_deliveries_external_id_idx on webhook_deliveries (source, call_external_id)
  where call_external_id is not null;
alter table webhook_deliveries enable row level security;
```

**The `documents` unique constraint was also widened in the same migration.** The old `UNIQUE(source, external_id)` prevented a `call_transcript_chunk` and a `call_summary` from coexisting for the same Fathom recording (both want `(source='fathom', external_id=<recording_id>)`). The widening to `(source, external_id, document_type)` is strictly more permissive — no existing rows could violate it, since the old constraint was stricter. Safe migration direction.

Dedup key: `webhook_id` (primary key). F2.4 implementation uses
`db.table("webhook_deliveries").upsert(..., on_conflict="webhook_id",
ignore_duplicates=True, returning="representation")`. **Empirically verified
2026-04-24:** first insert returns `data_len=1` (the row), duplicate returns
`data_len=0` (empty list, no exception). Handler checks `if not
insert_resp.data` and returns `200 {"deduplicated": True, "webhook_id": wh_id}`
without invoking the ingest chain. Live test path 2 (duplicate replay)
confirmed: same webhook-id posted twice against the locally running handler,
second call returned `{"deduplicated": true}` and cloud `calls` count stayed
at 1.

**Fallback if live test reveals `webhook_id` is NOT stable across retries:**
the handler falls back to soft-dedupe on `(source='fathom', call_external_id)`.
First delivery writes the call; second delivery hits `calls_source_external_id_key`
unique constraint on INSERT → caught in pipeline, converted to UPDATE → rows
end up identical, chunks reused (0-cost). So idempotency is defended in two
layers: `webhook_deliveries` at the handler boundary, `calls_source_external_id_key`
at the DB boundary. Either alone suffices; together they're robust.

## d) Adapter layer — `ingestion/fathom/webhook_adapter.py`

New module. Single exported function:

```python
def record_from_webhook(payload: dict) -> FathomCallRecord: ...
```

Plus support functions to parse summary + action items (these don't fit
`FathomCallRecord`; see §d.2).

### d.1 Field mapping table

| Webhook field | `FathomCallRecord` field | Notes |
|---|---|---|
| `recording_id` (int) | `external_id` (str) | `str(int)` cast |
| `title` | `title` | Direct |
| `recording_start_time` | `started_at` | ISO 8601 → timezone-aware `datetime` |
| `scheduled_start_time` | `scheduled_start` | Same |
| `scheduled_end_time` | `scheduled_end` | Same |
| `recording_start_time` | `recording_start` | Same |
| `recording_end_time` | `recording_end` | Same |
| `recording_end_time - recording_start_time` | `duration_seconds` | Computed |
| `transcript_language` | `language` | Direct |
| `url` | `recording_url` | Direct |
| `share_url` | `share_link` | Direct |
| `calendar_invitees[]` | `participants[]` | See next rows |
| `calendar_invitees[].email` | `Participant.email` | Direct, lowercase |
| `calendar_invitees[].name` or `matched_speaker_display_name` | `Participant.display_name` | Prefer `name`; fall back to `matched_speaker_display_name`; fall back to email local-part |
| `recorded_by` | `recorded_by` | `Participant(email=…, display_name=…)` |
| `transcript[]` | `utterances[]` | Structured → our `Utterance(speaker=display_name, text, timestamp)` |
| `transcript[]` joined | `transcript` (str) | Reconstruct the text representation for `calls.transcript` (backwards compat with backlog's column-fill pattern) |
| full JSON payload | `raw_payload` (jsonb) | Preserve for re-parsing if adapter evolves; stored by pipeline into `calls.raw_payload` |
| (no filename) | `source_path` | `None` — this field is meaningful only for TXT ingest |

### d.2 Summary + action items — extension to the existing pipeline

These don't fit `FathomCallRecord`. Two clean options:

**Recommended: option A — add nullable fields to `FathomCallRecord`.**

```python
@dataclass(frozen=True)
class FathomCallRecord:
    # … existing fields …
    summary_text: str | None = None          # nullable; backlog passes None
    action_items: list[ActionItem] = field(default_factory=list)

@dataclass(frozen=True)
class ActionItem:
    description: str
    assignee_email: str | None
    assignee_display_name: str | None
    recording_timestamp: str                 # "HH:MM:SS"
    recording_playback_url: str | None
    user_generated: bool
    completed: bool
```

Then `pipeline.ingest_call` gets two new branches:

```python
# After the call_transcript_chunk block:
if classification.call_category == "client" and record.summary_text:
    _ensure_summary_document(db, record, call_id, classification, embed_fn)

if record.action_items and classification.call_category in {"client", "external"}:
    _upsert_action_items(db, call_id, record.action_items, client_resolver,
                         team_resolver)
```

`_ensure_summary_document` creates a `documents` row with
`document_type='call_summary'` + metadata matching the existing convention
(`client_id`, `call_id`, `call_category`, `started_at`) + chunks the summary
text via the existing chunker, writes to `document_chunks`, embeds per chunk.
**This unblocks the long-deferred `call_summary` feature** with ~40 new lines
of code reusing everything the existing transcript path already has.

`_upsert_action_items` writes to `call_action_items` table (migration 0003
already defines the schema; zero new columns needed). On conflict on
`(call_id, description)` or some natural key — TBD in F2.3 by inspecting the
existing schema. Validation via `shared/ingestion/validate.py` — the table
predates strict validation there, so F2.3 adds validator coverage first.

Option B (wrapper dataclass) was considered and rejected: it fragments the
pipeline for no structural gain. TXT ingest passes `summary_text=None,
action_items=[]`; every downstream check is an `if`. Cleaner than adding a
wrapper type.

### d.3 Defensive parsing

- **Unknown fields in payload:** preserved in `raw_payload` verbatim; adapter
  ignores them. Fathom adding a field (e.g., `transcript_v2`) won't break us.
- **Missing optional field (e.g., `transcript=null`):** adapter produces an empty
  `utterances=[]`. Pipeline already handles the no-utterances case (writes call
  row, skips chunks).
- **Missing required field (e.g., no `recording_id`):** adapter raises
  `AdapterError`; handler catches → `webhook_deliveries.status='malformed'`,
  `400` response.
- **Type drift (e.g., `recording_id` is string in next Fathom version):** adapter
  tolerates `int | str` on that field; logs warning if it's not int as expected;
  continues.

## e) Sync vs async — sync, same pattern as Slack

Vercel's Python runtime kills background threads on `do_POST` return. Confirmed
in production 2026-04-23 via the Slack deployment — the original ack-then-thread
pattern produced zero outbound Slack messages despite 200 acks. Documented in
`docs/runbooks/slack_webhook.md`.

Same constraint applies here. Handler does all the work before returning.

**Budget:**

| Step | Typical | Worst-case |
|---|---|---|
| Signature verify | <10ms | <10ms |
| Dedupe INSERT | 50ms | 200ms |
| Adapter parse | 20ms | 100ms |
| `load_resolvers` (2 SELECTs, ~200 rows each) | 150ms | 500ms |
| Upsert `calls` + `call_participants` | 200ms | 500ms |
| Embed + write transcript chunks | 4s (11 chunks × ~350ms) | 15s (40 chunks) |
| Embed + write summary chunks | 1s (2 chunks) | 3s (8 chunks) |
| Upsert `call_action_items` | 100ms | 500ms |
| Update `webhook_deliveries` | 50ms | 200ms |
| **Total** | **~6s** | **~20s** |

Well inside Vercel's 60s cap (set in `vercel.json` for `api/slack_events.py`;
F2.3 adds same cap for `api/fathom_events.py`). No async path needed.

If embed latency grows (OpenAI tier change, model swap), we revisit — but the
cheap check is: at 60s cap, budget headroom is 40s past worst-case, which
covers 100+ chunk monster calls. Not worried.

## f) Cron backfill — `api/fathom_backfill.py` + Vercel Cron

**Schedule:** daily 08:00 UTC. Chosen because (a) Fathom's own processing
finishes for US-hours coaching calls by ~04:00 UTC next day (Scott's calls end
~22:00 UTC, summaries ready ~15 min later), (b) 08:00 is before US business
hours so any gap surfaces before pilot clients are active in Slack, (c) daily is
conservative — we can tighten to hourly if empirical miss-rate demands.

**Vercel config (additions to `vercel.json`):**

```json
{
  "functions": {
    "api/slack_events.py":     { "runtime": "@vercel/python@4.3.1", "maxDuration": 60 },
    "api/fathom_events.py":    { "runtime": "@vercel/python@4.3.1", "maxDuration": 60 },
    "api/fathom_backfill.py":  { "runtime": "@vercel/python@4.3.1", "maxDuration": 300 }
  },
  "crons": [
    { "path": "/api/fathom_backfill", "schedule": "0 8 * * *" }
  ]
}
```

Backfill has `maxDuration: 300` (5 min) because it may process dozens of
missed calls. Vercel Cron on the Hobby/Pro tier supports daily crons; hourly is
Pro-plus.

**Auth:** Vercel Cron calls with `Authorization: Bearer <CRON_SECRET>` where
`CRON_SECRET` is a Vercel env var. Handler validates and rejects any request
without it (so the endpoint is not open to the internet).

**Logic:**

1. `last_ts = SELECT max(received_at) FROM webhook_deliveries WHERE source = 'fathom' AND status = 'done'` (or fall back to `now() - interval '48 hours'` on first run).
2. `since = last_ts - interval '6 hours'` — 6h overlap to catch late-arriving content on meetings that the webhook delivered but we recorded `received_at` just before the summary finalized (unlikely but cheap insurance).
3. Page through `GET https://api.fathom.ai/external/v1/meetings?created_after=<since>&include_transcript=true&include_summary=true&include_action_items=true` with `cursor` pagination until `next_cursor` is null.
4. For each returned `Meeting`: compute `external_id = str(meeting["recording_id"])`. If `SELECT 1 FROM calls WHERE source='fathom' AND external_id = %s` returns a row, skip. Else run through `record_from_webhook(meeting)` + `pipeline.ingest_call`. Log a `webhook_deliveries` row with `source='fathom_cron'`, synthetic `webhook_id = f"cron-{run_ts}-{external_id}"`.
5. Return a summary JSON: `{"swept_since": ts, "meetings_checked": N, "meetings_ingested": M, "errors": [...]}`.

**Filter scope matches the webhook's `triggered_for`:** `recorded_by[]` query-param limited to known team emails (pulled from `team_members.email WHERE archived_at IS NULL`). Keeps the backfill scoped to the same universe of calls the webhook sees.

**Observability:** cron invocations visible in Vercel logs. For daily health,
Drake queries `select count(*), status from webhook_deliveries where received_at > now() - interval '24 hours' group by status`. If `failed` > 0, investigate via `error` jsonb.

## g) Failure modes

| Scenario | Handler behavior |
|---|---|
| Duplicate webhook (retry, concurrent) | `webhook_deliveries` unique-violation → 200 immediate |
| Call already in DB from backlog | Pipeline upsert path — `calls` row updated, chunks reused, no re-embed. 200. |
| Call already in DB from prior webhook | Same. 200. Summary may get newer text → metadata sync updates `documents.metadata`, `is_active` re-synced to current retrievability. |
| Participant matches no client | Auto-create as `needs_review` (same as backlog). Call lands with `primary_client_id=<auto>`, `is_active=false`. 200. |
| OpenAI embedding API down | Chunk insert fails individually, pipeline continues for other chunks. If >50% of chunks fail OR signature verify succeeded but ingest_call raises uncaught → 500, Fathom retries. Cron is backstop. |
| Cloud Supabase down | Connection fails → 500. Fathom retries per its policy. |
| Malformed payload (missing required field) | `webhook_deliveries.status='malformed'`, full payload + traceback in `error`. 400. Cron won't re-ingest (GET /meetings would return same broken data); Drake investigates manually. |
| Auth signature mismatch | 401, no body, no DB write, minimal log line. |
| Fathom fires before our function cold-starts | Fathom times out after its (undocumented) receiver timeout; retries. Cold-start on second invocation is warm. 200 lands. |
| Fathom never delivers a webhook (our endpoint unreachable for hours) | Cron picks up the gap in its 24h sweep. Window of missed retrieval: up to ~32h (24h cron schedule + 8h processing lag). Acceptable for V1 pilot. Tighten to hourly cron if miss-rate demands. |

## h) Observability

Primary surface: **`webhook_deliveries` table.** Drake's standing queries:

```sql
-- Daily health
select status, count(*) from webhook_deliveries
where received_at > now() - interval '24 hours' group by status;

-- Recent failures
select webhook_id, received_at, call_external_id, error->>'traceback'
from webhook_deliveries
where status in ('failed','malformed') and received_at > now() - interval '7 days'
order by received_at desc;

-- Coverage check: how many calls in the last 7 days arrived via webhook vs cron vs both?
select source, count(*) from webhook_deliveries
where received_at > now() - interval '7 days' group by source;

-- Slowest deliveries (for latency regression detection)
select webhook_id, extract(epoch from processed_at - received_at) as s
from webhook_deliveries where status='done' and processed_at > now() - interval '24 hours'
order by s desc limit 20;
```

Secondary: **Vercel function logs** for Python stderr/stdout — used for acute
debugging when a `webhook_deliveries` row has `status='failed'` and we want to
trace through the raw request.

Deferred: alerting on failed rows (Slack DM to Drake, email, PagerDuty-ish). V1
is "Drake runs the query every few days." If miss-rate climbs, wire up a daily
`select` to post into `#ella-ops` or similar.

## Test plan the build must pass

F2.3 is "done" when:

1. **Unit:** `record_from_webhook` round-trips every documented field of the
   `Meeting` schema to `FathomCallRecord` with a fixture payload in `tests/`.
2. **Unit:** signature verification — valid → True; bad signature → False; stale
   timestamp → False; missing headers → False; malformed secret → False.
3. **Integration:** POST a fixture webhook body to the handler (via a test
   WSGI/HTTP harness) with a hand-computed valid signature against a test
   secret; assert `webhook_deliveries` row + `calls` row land correctly.
4. **Integration:** duplicate-POST (same `webhook-id`) returns 200 immediately
   and doesn't double-process.
5. **Integration:** malformed payload returns 400, `status='malformed'`.
6. **Integration:** bad signature returns 401, no DB write.
7. **Integration:** adapter on a summary-and-action-items payload creates a
   `call_summary` document with chunks + ≥1 `call_action_items` row.
8. **End-to-end (staging):** point the Vercel preview deployment at a Fathom
   test webhook, trigger a real test meeting, observe it land cleanly within
   60s. Then delete the preview webhook registration.

## Open questions before F2.3 can start

Two are unblocked by the architecture's defensive design (worst-case safe); two
are still decision gates for Drake:

1. **`webhook_id` stability across retries** — spec says yes; unconfirmed for Fathom. *Impact on build:* minimal. Handler uses `webhook_id` as primary dedup; falls through to `(source, external_id)` secondary dedup if it turns out to be per-attempt. F2.3 can proceed; live-test result only affects which dedup layer does most of the work.
2. **Retry schedule** — unconfirmed. *Impact on build:* minimal. Handler returns 500 on failure regardless; Fathom's retry policy determines the empirical recovery window. The cron sweep is the safety net beyond it.
3. **Plan tier** — Drake to confirm by attempting `POST /webhooks` via Fathom's API or Settings UI. If webhook registration returns 402/403 "upgrade required," architecture shifts to cron-only (hourly or 30-min cadence). *Decision gate.*
4. **Production Fathom API key ownership** — whose Fathom account does the key belong to? Options: (a) Scott's (founder, has every meeting in his scope), (b) a shared service account (if Fathom allows it at this tier), (c) per-recorder keys (overkill). Recommendation: Scott's, with rotation documented. *Decision gate — affects env-var ownership and what happens if Scott ever churns out.*

## Open follow-ups (not blocking F2.3)

Tracked in `docs/fulfillment/known-issues.md`:

- **Webhook secret rotation runbook.** Fathom has no `PATCH /webhooks` to rotate a secret — rotation = delete + recreate, which means a coordinated env-var update + downtime window. Runbook needed before the first rotation.
- **Cron-driven reconciliation observability.** Daily query for `status` distribution in `webhook_deliveries` is manual. A weekly Slack DM to Drake with the 7-day summary would turn this into push instead of pull. Nice-to-have.
- **Backpressure.** Current design assumes Fathom doesn't deliver a burst that overwhelms Vercel's concurrency limit. We have ~20 calls/day peak, so irrelevant at V1 scale. Flag if per-day volume grows past ~500.
