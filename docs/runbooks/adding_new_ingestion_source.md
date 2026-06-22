# Runbook: Adding a New Ingestion Source

When to use: you're adding a new upstream data source whose shape differs from
anything existing ingestion pipelines consume. Example: Fathom webhook (F2.3),
future CRM integrations (HubSpot, Salesforce), future Drive-sourced content
ingestion, future Calendar integration for proactive scheduling context.

The pattern below is what F2.3 landed on for Fathom webhooks; it's repeatable.
Don't re-invent it — extend it.

---

## 1. Identify the shape delta

Compare your new source's payload to the canonical ingest record dataclass
(today: `FathomCallRecord` in `ingestion/fathom/parser.py`, originally shaped
for TXT backlog). Ask:

- Which existing fields map 1:1?
- Which existing fields need light transformation? (time format, casing, etc.)
- What NEW fields does the source carry that no existing path populates? (for
  Fathom webhooks: `summary_text`, `action_items`)
- What fields does the existing dataclass have that this source doesn't? (OK
  to leave them None / defaulted)

Write this as a field-by-field table in `docs/architecture/<source>.md` before
writing code. The table is the spec for the adapter.

## 2. Extend the canonical dataclass — nullable fields with defaults

Add the new source's unique fields to the existing dataclass as nullable /
defaulted. Do NOT create a parallel dataclass — downstream pipelines should
not branch on source type beyond "is this field present?"

```python
# ingestion/<domain>/parser.py or equivalent
@dataclass(frozen=True)
class FathomCallRecord:
    # ... existing fields ...
    summary_text: str | None = None
    action_items: list[ActionItem] | None = None
    source_format: str = "txt"
```

Three-state semantics matter for optional list fields like `action_items`:
- `None` means "this source doesn't carry info about action items — don't
  touch the DB"
- `[]` means "this call has zero action items — replace any existing with
  nothing"
- `[...]` means "write these, replacing any existing"

Downstream pipeline code reads the None-vs-[] distinction to decide whether
to delete existing rows. Document this contract in the dataclass's docstring.

**Run the full test suite** after the change. Existing tests may have drift
guards that assumed fields didn't exist — update them to check the NEW
invariant ("backlog records leave these None") rather than remove them.

## 3. Write the adapter — single function, source-specific error type

Create `ingestion/<domain>/<source>_adapter.py`:

```python
class <Source>AdapterError(ValueError):
    """Required field missing. Handler converts to HTTP 400; upstream
    shouldn't retry because the payload itself is bad."""

_REQUIRED_TOP_LEVEL: tuple[str, ...] = ("recording_id", "title", ...)

def record_from_<source>(payload: dict) -> FathomCallRecord:
    _require_top_level(payload)
    # ... map fields to dataclass
    return FathomCallRecord(
        # ...
        source_format="<source>",
    )
```

Design rules:
- **Defensive on optional fields.** Use `.get()` everywhere; don't crash on
  a missing optional. Unknown nested keys → ignored but preserved in
  `raw_text` (JSON-serialized payload) for forensic replay.
- **Fail loud on required fields.** Missing required → raise with a list of
  missing keys. Handler returns 4xx so upstream stops retrying a hopeless
  payload.
- **Normalize at the boundary.** Lowercase emails. Coerce naive timestamps
  to UTC. Strip whitespace. Downstream assumes normalized input; the adapter
  is the only place it happens.
- **Preserve the raw payload verbatim.** `raw_text=json.dumps(payload)` or
  similar. Lands in `calls.raw_payload.raw_text`. Enables re-parse if the
  adapter evolves.

## 4. Comprehensive unit tests — happy + edge + required-field

Test coverage for an adapter is cheap and prevents most production surprises.
Minimum set (see `tests/ingestion/fathom/test_webhook_adapter.py` for a
working example):

1. **Happy path** — a fixture payload with every documented field present.
   Assert every field round-trips correctly.
2. **Optional field missing** — for each optional field, assert the adapter
   produces the documented None/empty default.
3. **Optional field empty** — for list/dict fields, assert the three-state
   contract holds (`[]` vs `None` distinction preserved).
4. **Edge values** — whitespace-only strings, null sub-objects, shape
   variations the docs hint at.
5. **Required field missing** — for each required field, assert
   `<Source>AdapterError` is raised with a message naming the missing field.
6. **Malformed values** — bad timestamps, non-email strings in email
   fields, etc. Raise `<Source>AdapterError`, don't crash with a Python
   `ValueError` that the handler can't distinguish from code bugs.

Fixture strategy: build fixtures from the source's published schema (OpenAPI
for Fathom, Swagger for most REST providers). When the first REAL delivery
lands in production, add a sanitized copy of it as a second fixture and
assert round-trip equality — catches docs-vs-reality drift.

## 5. Schema migration — if the new source needs it

If the new source writes to a table that doesn't exist, or requires a
constraint change to coexist with existing data, write a new numbered
migration in `supabase/migrations/`. Apply with:

```bash
.venv/bin/python -c "
import os, psycopg2
from urllib.parse import quote
from dotenv import load_dotenv
load_dotenv('.env.local')
with open('supabase/.temp/pooler-url') as f: pooler = f.read().strip()
pw = os.environ['SUPABASE_DB_PASSWORD']
at = pooler.index('@')
dsn = f\"{pooler[:at]}:{quote(pw, safe='')}{pooler[at:]}\"
sql = open('supabase/migrations/<NUMBER>_<slug>.sql').read()
conn = psycopg2.connect(dsn, connect_timeout=15)
conn.autocommit = False
cur = conn.cursor()
cur.execute(sql)
conn.commit()
conn.close()
print('applied')
"
```

Then immediately introspect the cloud schema to confirm the migration landed
as intended (not just "no error" — actually check columns, constraints,
indexes exist).

## 6. Pipeline extensions — key on field presence, not source type

Extend the existing `pipeline.ingest_call` (or the equivalent for your
domain) with new write paths gated on the nullable fields. Do NOT add an
`if source == 'new_source'` branch — that fragments the pipeline and
creates new bugs. Instead:

```python
# ingestion/<domain>/pipeline.py
if record.summary_text:
    _ensure_summary_document(db, record, call_id, ...)
if record.action_items is not None:
    _upsert_action_items(db, call_id, record.action_items, ...)
```

New helper functions should mirror existing patterns. F2.3's
`_ensure_summary_document` mirrors `_ensure_transcript_chunks` almost
line-for-line (check existing → upsert doc → check chunks → embed + write).
`_upsert_action_items` uses the delete-and-replace idempotency pattern
because Fathom doesn't provide stable per-item ids — the simplest
idempotent pattern given the constraint.

## 7. End-to-end integration test against cloud

Unit tests prove the adapter works in isolation; integration proves the full
chain works against the real DB. Write a script (doesn't need to be in the
test suite — it's a one-shot pre-flight):

```python
# Structure:
FAKE_EXTERNAL_ID = "F<SESSION>_TEST_<UNIQUE>"   # prefix makes cleanup trivial
try:
    # Pre-emptive cleanup (in case a prior aborted run left state)
    cleanup(db, FAKE_EXTERNAL_ID, ...)
    # Pass 1: fresh ingest
    payload = synthetic_payload()
    record = adapter.record_from_<source>(payload)
    outcome = pipeline.ingest_call(record, db, ...)
    verify(db, FAKE_EXTERNAL_ID, ...)  # every table touched
    # Pass 2: idempotency re-run
    outcome2 = pipeline.ingest_call(record, db, ...)
    assert outcome2.action == "updated"
    assert outcome2.chunks_written == 0    # existing chunks reused
    verify(db, FAKE_EXTERNAL_ID, ...)
finally:
    cleanup(db, FAKE_EXTERNAL_ID, ...)
```

Verify every table the pipeline could write to — not just the obvious ones.
For Fathom webhooks, F2.3's verify hit: calls, call_participants, documents
(both types), document_chunks (under both docs), call_action_items,
webhook_deliveries. Missing any of these leaves blind spots.

**Use an existing canonical email** for any required participant so the
pipeline's auto-create path doesn't fire during the test. If auto-create
does fire, your cleanup script also has to delete the auto-created client
row — messy. Pick an email that already resolves cleanly.

Cleanup semantics:
- Delete child rows before parent rows (chunks before documents, documents
  before calls).
- Use `in_(<fake_id_list>)` scoped deletes, not broad DELETEs.
- Exercise the FK cascades where they exist — `call_action_items` and
  `call_participants` both cascade on `calls.id` deletion, so deleting
  the call handles them automatically.
- Run a post-cleanup count query to confirm totals match the pre-test
  state. This is the only way to catch a failure mode where one table
  didn't get cleaned up.

## 8. Architecture doc + runbooks + followups

- **Architecture doc.** Every new ingestion source gets a companion doc in
  `docs/architecture/<source>.md` that future-you will read before evolving
  the source. Include: field mapping table, failure modes, observability
  queries.
- **Runbook updates.** If your new source is recurring (e.g., weekly cron,
  live webhook), add a runbook for the ops concerns: monitoring,
  replay, common failures.
- **Followups.** Log anything you chose not to do now: validator pins,
  edge cases below your bar for V1, future integrations that might
  piggyback on this source. Future-you wastes less time re-discovering the
  same unknowns.

---

## Anti-patterns to avoid

- **Don't create parallel dataclasses per source.** Extends the canonical
  one with nullable fields instead. Downstream code stays source-agnostic.
- **Don't branch the pipeline on source type.** Key on field presence.
- **Don't skip the integration test.** Unit tests won't catch schema
  mismatches, permission issues, or cascade surprises.
- **Don't leave test rows in cloud.** Use try/finally cleanup. Run a post-
  test count query to confirm.
- **Don't normalize downstream.** The adapter is the normalization boundary;
  every line of downstream code should assume normalized input.
- **Don't hardcode the source's schema in Python.** Cite the source's
  canonical schema URL in the adapter's docstring — when Fathom updates its
  API, future-you has the pointer to diff against.

## Case studies

- **F2.3 Fathom webhook** — the template this runbook is built from. See
  `docs/archive/historical/fathom_webhook.md`, `ingestion/fathom/webhook_adapter.py`,
  `tests/ingestion/fathom/test_webhook_adapter.py`,
  `supabase/migrations/0011_webhook_deliveries_and_doc_type_unique.sql`.
- Future: CRM, Drive, Calendar — apply the same pattern, log the deltas
  here.
