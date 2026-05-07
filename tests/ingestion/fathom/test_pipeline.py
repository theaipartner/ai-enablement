"""Unit tests for ingestion.fathom.pipeline.

Mocked — no DB, no OpenAI. The tests exercise each branch of the
orchestrator:

  - dry-run emits an IngestOutcome with action='dry-run' and no writes
  - first ingest of a client call: insert calls, participants, document,
    chunks; retrievable wired to the classifier's floor
  - re-ingest client → client with existing chunks: skip chunking, sync
    denormalized metadata, no retrievability change
  - re-ingest client → internal: demote retrievability, soft-archive
    existing document, no new chunks
  - re-ingest internal → client: no auto-promote even though classifier
    would pass the floor
  - auto-create client: email-new path inserts, email-exists path reuses
  - validator failure on document: logs, skips document write, no chunks
  - validator failure on chunk: logs, skips that chunk, others continue
"""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from ingestion.fathom import pipeline
from ingestion.fathom.classifier import (
    AutoCreateRequest,
    ClassificationResult,
    ClientResolver,
    CONFIDENCE_HIGH,
    CONFIDENCE_MEDIUM,
)
from ingestion.fathom.parser import FathomCallRecord, Participant, Utterance


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _record(
    *,
    external_id: str = "rec-001",
    title: str = "30mins with Scott (The AI Partner) (Test Client)",
    participants: list[Participant] | None = None,
    utterances: list[Utterance] | None = None,
    duration_seconds: int = 600,
) -> FathomCallRecord:
    if participants is None:
        participants = [
            Participant(display_name="Scott Wilson", email="scott@theaipartner.io"),
            Participant(display_name="Test Client", email="client@example.com"),
        ]
    if utterances is None:
        utterances = [
            Utterance(
                timestamp="00:00:00",
                speaker=pt.display_name,
                text=f"Something substantive that {pt.display_name} said about building the site.",
            )
            for pt in participants
        ] * 30  # plenty of words to produce at least one chunk
    return FathomCallRecord(
        external_id=external_id,
        title=title,
        started_at=datetime(2026, 3, 15, tzinfo=timezone.utc),
        scheduled_start=None,
        scheduled_end=None,
        recording_start=None,
        recording_end=None,
        duration_seconds=duration_seconds,
        language="en",
        recording_url="https://fathom.video/calls/123",
        share_link=None,
        participants=participants,
        recorded_by=Participant(
            display_name="Scott Wilson", email="scott@theaipartner.io"
        ),
        utterances=utterances,
        transcript="transcript text",
        raw_text="raw text",
    )


class _FakeDB:
    """Captures supabase-py calls as a list of (op, table, payload) tuples
    and returns canned responses from a scripted dict.

    Responses are keyed by (op, table) — e.g. ("select", "calls") — and
    consumed in order. Tests set scripts per case.
    """

    def __init__(self):
        self.ops: list[tuple[str, str, dict]] = []
        self.responses: dict[tuple[str, str], list] = {}
        self.insert_returns: dict[str, list] = {}

    def respond(self, op: str, table: str, data):
        self.responses.setdefault((op, table), []).append(data)

    def insert_returning(self, table: str, id_sequence: list[str]):
        self.insert_returns[table] = list(id_sequence)

    def table(self, name: str):
        return _FakeTable(self, name)


class _FakeTable:
    def __init__(self, db: _FakeDB, name: str):
        self.db = db
        self.name = name
        self._current_op: str | None = None
        self._filters: list[tuple] = []
        self._payload = None

    def select(self, _cols, *, count=None):
        self._current_op = "select"
        self._count_mode = count
        return self

    def insert(self, payload):
        self._current_op = "insert"
        self._payload = payload
        return self

    def update(self, payload):
        self._current_op = "update"
        self._payload = payload
        return self

    def upsert(self, payload, *, on_conflict=None, ignore_duplicates=False):
        self._current_op = "upsert"
        self._payload = payload
        self._upsert_on_conflict = on_conflict
        self._upsert_ignore_duplicates = ignore_duplicates
        return self

    def eq(self, col, val):
        self._filters.append(("eq", col, val))
        return self

    def is_(self, col, val):
        self._filters.append(("is_", col, val))
        return self

    def in_(self, col, vals):
        self._filters.append(("in_", col, vals))
        return self

    def limit(self, n):
        self._filters.append(("limit", n))
        return self

    def order(self, *args, **kwargs):
        # Pipeline uses order(...) on some lookups (e.g. timestamp-sorted
        # summary lookup). FakeDB ignores order — the canned response is
        # whatever the test scripted.
        return self

    def execute(self):
        op = self._current_op
        self.db.ops.append((op, self.name, {
            "payload": self._payload,
            "filters": list(self._filters),
            "on_conflict": getattr(self, "_upsert_on_conflict", None),
            "ignore_duplicates": getattr(self, "_upsert_ignore_duplicates", None),
        }))
        if op == "insert" and self.name in self.db.insert_returns:
            ids = self.db.insert_returns[self.name]
            payloads = (
                self._payload if isinstance(self._payload, list) else [self._payload]
            )
            return_rows = [{"id": ids.pop(0), **p} for p in payloads]
            if not isinstance(self._payload, list):
                return_rows = return_rows[:1]
            return SimpleNamespace(data=return_rows, count=None)

        scripted = self.db.responses.get((op, self.name))
        if scripted:
            data = scripted.pop(0)
            count = len(data) if isinstance(data, list) else None
            return SimpleNamespace(data=data, count=count)
        return SimpleNamespace(data=[], count=0)


def _fake_embed(text: str) -> list[float]:
    return [0.0] * 1536


# ---------------------------------------------------------------------------
# Dry-run path
# ---------------------------------------------------------------------------


def test_dry_run_does_not_touch_db():
    db = _FakeDB()
    resolver = ClientResolver({"client@example.com": "c-1"})
    team_resolver = pipeline.TeamMemberResolver({"scott@theaipartner.io": "tm-scott"})

    outcome = pipeline.ingest_call(
        _record(),
        db,
        client_resolver=resolver,
        team_resolver=team_resolver,
        dry_run=True,
    )

    assert db.ops == []
    assert outcome.action == "dry-run"
    assert outcome.category == "client"
    assert outcome.primary_client_id == "c-1"
    assert outcome.participants_linked_to_clients == 1


# ---------------------------------------------------------------------------
# First ingest — client call, inserts everywhere
# ---------------------------------------------------------------------------


def test_first_ingest_client_call_inserts_rows_and_chunks():
    db = _FakeDB()
    # calls: existing lookup returns empty (first ingest)
    db.respond("select", "calls", [])
    # documents: no existing transcript doc
    db.respond("select", "documents", [])
    # document_chunks count after insert: empty initially
    db.respond("select", "document_chunks", [])
    # inserts return synthetic ids
    db.insert_returning("calls", ["call-1"])
    db.insert_returning("documents", ["doc-1"])

    resolver = ClientResolver({"client@example.com": "c-1"})
    team_resolver = pipeline.TeamMemberResolver({"scott@theaipartner.io": "tm-scott"})

    outcome = pipeline.ingest_call(
        _record(),
        db,
        client_resolver=resolver,
        team_resolver=team_resolver,
        embed_fn=_fake_embed,
        dry_run=False,
    )

    # Outcome shape
    assert outcome.action == "inserted"
    assert outcome.call_id == "call-1"
    assert outcome.document_id == "doc-1"
    assert outcome.chunks_written >= 1
    assert outcome.chunks_reused == 0
    assert outcome.retrievable is True       # high confidence + primary
    assert outcome.retrievable_before is None

    # Wrote to calls, call_participants, documents, document_chunks
    tables_written = {table for op, table, _ in db.ops if op in ("insert", "upsert")}
    assert tables_written >= {"calls", "call_participants", "documents", "document_chunks"}


# ---------------------------------------------------------------------------
# Re-ingest client → client — chunks reused, no re-embedding
# ---------------------------------------------------------------------------


def test_reingest_same_category_reuses_chunks():
    db = _FakeDB()
    # calls: existing row found
    db.respond("select", "calls", [{
        "id": "call-1",
        "is_retrievable_by_client_agents": True,
    }])
    # documents: existing transcript doc (call_id in metadata is the
    # calls.id UUID per conventions §2)
    db.respond("select", "documents", [{
        "id": "doc-1",
        "is_active": True,
        "metadata": {"call_id": "call-1", "call_category": "client"},
    }])
    # document_chunks count: has 5 chunks already
    db.respond("select", "document_chunks", [{"id": f"ch-{i}"} for i in range(5)])

    resolver = ClientResolver({"client@example.com": "c-1"})
    team_resolver = pipeline.TeamMemberResolver({})

    outcome = pipeline.ingest_call(
        _record(),
        db,
        client_resolver=resolver,
        team_resolver=team_resolver,
        embed_fn=_fake_embed,
        dry_run=False,
    )

    assert outcome.action == "updated"
    assert outcome.call_id == "call-1"
    assert outcome.document_id == "doc-1"
    assert outcome.chunks_written == 0
    assert outcome.chunks_reused == 5
    # No inserts into document_chunks
    chunk_inserts = [
        op for op in db.ops if op[0] == "insert" and op[1] == "document_chunks"
    ]
    assert chunk_inserts == []


# ---------------------------------------------------------------------------
# Re-ingest client → internal — retrievability demotes, doc soft-archives
# ---------------------------------------------------------------------------


def test_reingest_demote_to_internal_archives_document():
    db = _FakeDB()
    db.respond("select", "calls", [{
        "id": "call-1",
        "is_retrievable_by_client_agents": True,
    }])
    # First find-transcript-doc (for the "indexable_categories" branch;
    # in this test the new classification is internal so we hit
    # _soft_archive_transcript_document_if_exists instead). call_id in
    # metadata is the calls.id UUID.
    db.respond("select", "documents", [{
        "id": "doc-1",
        "is_active": True,
        "metadata": {"call_id": "call-1"},
    }])

    # Build a record whose title forces internal (CSM Sync)
    internal_record = _record(
        title="CSM Sync",
        participants=[
            Participant(display_name="Lou Perez", email="lou@theaipartner.io"),
            Participant(display_name="Scott Wilson", email="scott@theaipartner.io"),
            # extra so there's no external match
        ],
    )

    resolver = ClientResolver({})
    team_resolver = pipeline.TeamMemberResolver({
        "lou@theaipartner.io": "tm-lou",
        "scott@theaipartner.io": "tm-scott",
    })

    outcome = pipeline.ingest_call(
        internal_record, db,
        client_resolver=resolver,
        team_resolver=team_resolver,
        embed_fn=_fake_embed,
        dry_run=False,
    )

    assert outcome.category == "internal"
    assert outcome.retrievable is False
    assert outcome.retrievable_before is True

    doc_updates = [
        op for op in db.ops
        if op[0] == "update" and op[1] == "documents"
    ]
    # The one update on documents is the soft-archive flip is_active=false
    assert any(
        op[2]["payload"] == {"is_active": False} for op in doc_updates
    ), "expected document to be soft-archived to is_active=false"


# ---------------------------------------------------------------------------
# Re-ingest internal → client — retrievability does NOT auto-promote
# ---------------------------------------------------------------------------


def test_reingest_promote_does_not_auto_promote_retrievability():
    db = _FakeDB()
    db.respond("select", "calls", [{
        "id": "call-1",
        "is_retrievable_by_client_agents": False,
    }])
    db.respond("select", "documents", [])
    db.respond("select", "document_chunks", [])
    db.insert_returning("documents", ["doc-new"])

    # Record that classifies as client high
    resolver = ClientResolver({"client@example.com": "c-1"})
    team_resolver = pipeline.TeamMemberResolver({})
    outcome = pipeline.ingest_call(
        _record(),  # client, high, primary_client_id=c-1
        db,
        client_resolver=resolver,
        team_resolver=team_resolver,
        embed_fn=_fake_embed,
        dry_run=False,
    )

    assert outcome.category == "client"
    # classifier.should_be_retrievable would be True (high + primary)
    # but because prior was False, final stays False (no auto-promote).
    assert outcome.retrievable is False
    assert outcome.retrievable_before is False


# ---------------------------------------------------------------------------
# Auto-create client — email new vs email exists
# ---------------------------------------------------------------------------


def test_auto_create_client_inserts_when_email_new():
    db = _FakeDB()
    # lookup_or_create: email not found
    db.respond("select", "clients", [])
    db.insert_returning("clients", ["c-new"])
    # calls: first ingest
    db.respond("select", "calls", [])
    db.respond("select", "documents", [])
    db.respond("select", "document_chunks", [])
    db.insert_returning("calls", ["call-1"])
    db.insert_returning("documents", ["doc-1"])

    record = _record(
        title="30mins with Scott (The AI Partner) (Random Prospect)",
        participants=[
            Participant(display_name="Scott Wilson", email="scott@theaipartner.io"),
            Participant(display_name="Random Prospect", email="prospect@example.com"),
        ],
    )
    resolver = ClientResolver({})   # prospect@example.com NOT in resolver
    team_resolver = pipeline.TeamMemberResolver({"scott@theaipartner.io": "tm-s"})

    outcome = pipeline.ingest_call(
        record, db,
        client_resolver=resolver,
        team_resolver=team_resolver,
        embed_fn=_fake_embed,
        dry_run=False,
    )

    assert outcome.auto_created_client_id == "c-new"
    assert outcome.auto_created_client_email == "prospect@example.com"
    assert outcome.primary_client_id == "c-new"
    # Resolver was updated so future calls reuse the id
    assert resolver.lookup("prospect@example.com") == "c-new"


def test_auto_create_client_reuses_when_email_exists():
    db = _FakeDB()
    # email lookup finds an existing active row
    db.respond("select", "clients", [
        {"id": "c-prior", "archived_at": None},
    ])
    db.respond("select", "calls", [])
    db.respond("select", "documents", [])
    db.respond("select", "document_chunks", [])
    db.insert_returning("calls", ["call-1"])
    db.insert_returning("documents", ["doc-1"])

    record = _record(
        title="30mins with Scott (The AI Partner) (Random Prospect)",
        participants=[
            Participant(display_name="Scott Wilson", email="scott@theaipartner.io"),
            Participant(display_name="Random Prospect", email="prospect@example.com"),
        ],
    )
    resolver = ClientResolver({})
    team_resolver = pipeline.TeamMemberResolver({})

    outcome = pipeline.ingest_call(
        record, db,
        client_resolver=resolver,
        team_resolver=team_resolver,
        embed_fn=_fake_embed,
        dry_run=False,
    )

    assert outcome.auto_created_client_id == "c-prior"
    # No new clients insert happened
    client_inserts = [
        op for op in db.ops if op[0] == "insert" and op[1] == "clients"
    ]
    assert client_inserts == []


# ---------------------------------------------------------------------------
# documents.is_active gating via retrievability
# ---------------------------------------------------------------------------


def test_high_confidence_client_call_inserts_document_is_active_true():
    """Regression guard for the safety gap:
    transcript_chunk documents must land with `is_active = true` only
    when the calls row is retrievable (client + high + primary)."""
    db = _FakeDB()
    db.respond("select", "calls", [])                   # first ingest
    db.respond("select", "documents", [])               # no prior transcript doc
    db.respond("select", "document_chunks", [])         # no chunks yet
    db.insert_returning("calls", ["call-1"])
    db.insert_returning("documents", ["doc-1"])

    resolver = ClientResolver({"client@example.com": "c-1"})
    team_resolver = pipeline.TeamMemberResolver({})

    outcome = pipeline.ingest_call(
        _record(),  # high-confidence client
        db,
        client_resolver=resolver,
        team_resolver=team_resolver,
        embed_fn=_fake_embed,
        dry_run=False,
    )

    assert outcome.retrievable is True
    doc_inserts = [op for op in db.ops if op[0] == "insert" and op[1] == "documents"]
    assert len(doc_inserts) == 1
    assert doc_inserts[0][2]["payload"]["is_active"] is True


def test_medium_confidence_client_call_lands_with_is_active_false():
    """Auto-create path: 30mins_with_Scott + unknown participant →
    client medium confidence, auto-created client. Document lands
    with `is_active = false` so chunks exist but don't surface until
    a human reviewer promotes the call."""
    db = _FakeDB()
    db.respond("select", "clients", [])   # auto-create insert path
    db.insert_returning("clients", ["c-new"])
    db.respond("select", "calls", [])
    db.respond("select", "documents", [])
    db.respond("select", "document_chunks", [])
    db.insert_returning("calls", ["call-1"])
    db.insert_returning("documents", ["doc-1"])

    record = _record(
        title="30mins with Scott (The AI Partner) (Random Prospect)",
        participants=[
            Participant(display_name="Scott Wilson", email="scott@theaipartner.io"),
            Participant(display_name="Random Prospect", email="prospect@example.com"),
        ],
    )
    resolver = ClientResolver({})
    team_resolver = pipeline.TeamMemberResolver({"scott@theaipartner.io": "tm-s"})

    outcome = pipeline.ingest_call(
        record, db,
        client_resolver=resolver,
        team_resolver=team_resolver,
        embed_fn=_fake_embed,
        dry_run=False,
    )

    assert outcome.category == "client"
    assert outcome.confidence == CONFIDENCE_MEDIUM
    assert outcome.retrievable is False       # medium — doesn't pass floor
    assert outcome.auto_created_client_id == "c-new"

    doc_inserts = [op for op in db.ops if op[0] == "insert" and op[1] == "documents"]
    assert len(doc_inserts) == 1
    assert doc_inserts[0][2]["payload"]["is_active"] is False


def test_reingest_promote_to_high_syncs_document_is_active_up():
    """A human previously promoted `calls.is_retrievable_by_client_agents`
    to true (retrievable_before=True), classifier still passes the floor,
    and the prior document was is_active=false (maybe from first-ingest
    medium-confidence) — re-ingest syncs is_active up to true."""
    db = _FakeDB()
    db.respond("select", "calls", [{
        "id": "call-1",
        "is_retrievable_by_client_agents": True,   # human promoted
    }])
    db.respond("select", "documents", [{
        "id": "doc-1",
        "is_active": False,   # previously medium / not yet promoted
        "metadata": {"call_id": "call-1"},
    }])
    db.respond("select", "document_chunks", [{"id": f"ch-{i}"} for i in range(3)])

    resolver = ClientResolver({"client@example.com": "c-1"})
    team_resolver = pipeline.TeamMemberResolver({})

    outcome = pipeline.ingest_call(
        _record(),
        db,
        client_resolver=resolver,
        team_resolver=team_resolver,
        embed_fn=_fake_embed,
        dry_run=False,
    )

    assert outcome.retrievable is True
    # Look for the update that flips documents.is_active = true
    doc_updates = [
        op for op in db.ops if op[0] == "update" and op[1] == "documents"
    ]
    assert any(
        op[2]["payload"].get("is_active") is True for op in doc_updates
    ), "expected documents.is_active to sync up to True"


# ---------------------------------------------------------------------------
# Auto-create breadcrumb metadata
# ---------------------------------------------------------------------------


def test_auto_create_metadata_carries_triggering_call_reference():
    """The reviewer workflow needs a breadcrumb back to the call that
    triggered the auto-create. Auto-created clients must carry
    `auto_created_from_call_external_id` and
    `auto_created_from_call_title` alongside the existing
    `auto_created_from_call_ingestion` flag and `auto_created_at`
    timestamp."""
    db = _FakeDB()
    db.respond("select", "clients", [])   # no existing match by email
    db.insert_returning("clients", ["c-new"])
    db.respond("select", "calls", [])
    db.respond("select", "documents", [])
    db.respond("select", "document_chunks", [])
    db.insert_returning("calls", ["call-1"])
    db.insert_returning("documents", ["doc-1"])

    record = _record(
        external_id="fathom-rec-999",
        title="30mins with Scott (The AI Partner) (Random Prospect)",
        participants=[
            Participant(display_name="Scott Wilson", email="scott@theaipartner.io"),
            Participant(display_name="Random Prospect", email="prospect@example.com"),
        ],
    )
    resolver = ClientResolver({})
    team_resolver = pipeline.TeamMemberResolver({"scott@theaipartner.io": "tm-s"})

    pipeline.ingest_call(
        record, db,
        client_resolver=resolver,
        team_resolver=team_resolver,
        embed_fn=_fake_embed,
        dry_run=False,
    )

    client_inserts = [op for op in db.ops if op[0] == "insert" and op[1] == "clients"]
    assert len(client_inserts) == 1
    metadata = client_inserts[0][2]["payload"]["metadata"]
    assert metadata["auto_created_from_call_ingestion"] is True
    assert metadata["auto_created_from_call_external_id"] == "fathom-rec-999"
    assert "30mins with Scott" in metadata["auto_created_from_call_title"]
    assert "auto_created_at" in metadata


def test_auto_create_reactivate_archived_row_also_carries_breadcrumb():
    """If the email matches an archived row, reactivate rather than
    insert — and still stamp the breadcrumb so the reviewer sees which
    call brought the client back."""
    db = _FakeDB()
    db.respond("select", "clients", [{
        "id": "c-archived",
        "archived_at": "2026-04-01T00:00:00+00:00",
    }])
    db.respond("select", "calls", [])
    db.respond("select", "documents", [])
    db.respond("select", "document_chunks", [])
    db.insert_returning("calls", ["call-1"])
    db.insert_returning("documents", ["doc-1"])

    record = _record(
        external_id="fathom-rec-1000",
        title="30mins with Scott (The AI Partner) (Returning Client)",
        participants=[
            Participant(display_name="Scott Wilson", email="scott@theaipartner.io"),
            Participant(display_name="Returning Client", email="returning@example.com"),
        ],
    )
    resolver = ClientResolver({})
    team_resolver = pipeline.TeamMemberResolver({})

    outcome = pipeline.ingest_call(
        record, db,
        client_resolver=resolver,
        team_resolver=team_resolver,
        embed_fn=_fake_embed,
        dry_run=False,
    )

    assert outcome.auto_created_client_id == "c-archived"
    client_updates = [op for op in db.ops if op[0] == "update" and op[1] == "clients"]
    assert len(client_updates) >= 1
    metadata = client_updates[0][2]["payload"]["metadata"]
    assert metadata["auto_created_from_call_external_id"] == "fathom-rec-1000"


# ---------------------------------------------------------------------------
# Idempotent chunk inserts — partial-failure recovery
# ---------------------------------------------------------------------------


def test_chunk_inserts_use_ignore_duplicates_upsert():
    """Regression guard for the partial-failure recovery path.

    If a prior run crashed mid-chunk-insert, a re-run must not blow
    up on the `(document_id, chunk_index)` unique index. Chunks are
    written via upsert with `ignore_duplicates=True` so duplicates
    silently no-op.
    """
    db = _FakeDB()
    db.respond("select", "calls", [])
    db.respond("select", "documents", [])
    db.respond("select", "document_chunks", [])
    db.insert_returning("calls", ["call-1"])
    db.insert_returning("documents", ["doc-1"])

    pipeline.ingest_call(
        _record(),
        db,
        client_resolver=ClientResolver({"client@example.com": "c-1"}),
        team_resolver=pipeline.TeamMemberResolver({}),
        embed_fn=_fake_embed,
        dry_run=False,
    )

    chunk_ops = [op for op in db.ops if op[1] == "document_chunks" and op[0] == "upsert"]
    assert chunk_ops, "expected at least one document_chunks upsert"
    for op in chunk_ops:
        assert op[2]["on_conflict"] == "document_id,chunk_index"
        assert op[2]["ignore_duplicates"] is True


# ---------------------------------------------------------------------------
# Validator failures — document vs chunk
# ---------------------------------------------------------------------------


def test_document_validation_failure_skips_doc_and_chunks(mocker):
    mocker.patch(
        "ingestion.fathom.pipeline.validate_document_metadata",
        side_effect=ValueError("fake missing required"),
    )
    db = _FakeDB()
    db.respond("select", "calls", [])
    db.insert_returning("calls", ["call-1"])

    outcome = pipeline.ingest_call(
        _record(), db,
        client_resolver=ClientResolver({"client@example.com": "c-1"}),
        team_resolver=pipeline.TeamMemberResolver({}),
        embed_fn=_fake_embed,
        dry_run=False,
    )

    assert outcome.validation_failures
    assert "fake missing required" in outcome.validation_failures[0]
    # No document write happened
    doc_inserts = [op for op in db.ops if op[0] == "insert" and op[1] == "documents"]
    assert doc_inserts == []


def test_chunk_validation_failure_skips_that_chunk_others_continue(mocker):
    # Let document validation pass, fail on every OTHER chunk.
    call_count = {"n": 0}
    def flaky_chunk_validator(metadata, source, document_type):
        call_count["n"] += 1
        if call_count["n"] == 2:
            raise ValueError("fake chunk #2 bad")
    mocker.patch(
        "ingestion.fathom.pipeline.validate_chunk_metadata",
        side_effect=flaky_chunk_validator,
    )

    db = _FakeDB()
    db.respond("select", "calls", [])
    db.respond("select", "documents", [])
    db.respond("select", "document_chunks", [])
    db.insert_returning("calls", ["call-1"])
    db.insert_returning("documents", ["doc-1"])

    # Record long enough to produce multiple chunks
    utterances = [
        Utterance(timestamp=f"00:00:{i:02d}", speaker="A" if i % 2 else "B",
                  text=" ".join(["word"] * 40))
        for i in range(60)
    ]
    record = _record(utterances=utterances)

    outcome = pipeline.ingest_call(
        record, db,
        client_resolver=ClientResolver({"client@example.com": "c-1"}),
        team_resolver=pipeline.TeamMemberResolver({}),
        embed_fn=_fake_embed,
        dry_run=False,
    )

    assert any("chunk #2 bad" in vf for vf in outcome.validation_failures)
    # Other chunks still wrote. Chunks go through upsert (not insert)
    # so the partial-failure recovery path stays idempotent.
    chunk_writes = [op for op in db.ops if op[1] == "document_chunks" and op[0] == "upsert"]
    assert len(chunk_writes) >= 1


# ---------------------------------------------------------------------------
# Cost estimate helper
# ---------------------------------------------------------------------------


def test_estimate_embedding_cost_is_small_and_nonzero():
    cost = pipeline.estimate_embedding_cost_usd(100)
    assert cost > 0
    assert cost < 1.0  # 100 chunks should be pennies


# ---------------------------------------------------------------------------
# Auto-review hook (M6.x — Fathom pipeline auto-review)
# ---------------------------------------------------------------------------
#
# Five paths covered:
#   1. happy_path: summary_text set + client + primary_client_id →
#      review_call + upsert_call_review fired exactly once
#   2. no_summary_text: summary_text empty → review skipped at the
#      gate, review_call NOT called (same gate that skips summary doc)
#   3. non_client_category: would never reach the review block since
#      it's nested in the client-category branch — verified via the
#      _ensure_call_review_document direct unit test
#   4. idempotency: existing call_review documents row → review_call
#      NOT called, helper short-circuits at the existence guard
#   5. failure_isolation: review_call raises → ingest_call still
#      returns success, errors[] populated, summary doc still landed


def _record_with_summary(**overrides):
    """Same as _record() but with summary_text set so the auto-review
    hook fires."""
    r = _record(**overrides)
    # FathomCallRecord is a dataclass; we re-construct because the type
    # may be frozen. Falls back to dict-merge if not.
    try:
        from dataclasses import replace
        return replace(r, summary_text="A short Fathom-generated summary.")
    except TypeError:
        r.summary_text = "A short Fathom-generated summary."
        return r


def _stage_pipeline_db_for_first_client_ingest(db):
    """Common DB scripting for first-ingest of a client call: empty
    calls + documents lookups, synthetic ids on insert."""
    db.respond("select", "calls", [])
    db.respond("select", "documents", [])  # transcript-doc lookup
    db.respond("select", "document_chunks", [])
    db.respond("select", "documents", [])  # summary-doc lookup
    db.respond("select", "document_chunks", [])  # summary chunk count
    db.respond("select", "documents", [])  # call_review existence guard
    db.insert_returning("calls", ["call-1"])
    db.insert_returning("documents", ["doc-transcript", "doc-summary"])


def test_auto_review_happy_path_fires_after_summary_write(mocker):
    db = _FakeDB()
    _stage_pipeline_db_for_first_client_ingest(db)

    review_mock = mocker.patch(
        "agents.call_reviewer.reviewer.review_call",
        return_value={
            "pain_points": [],
            "wins": [],
            "dodged_questions": [],
            "sentiment_arc": "Steady call.",
        },
    )
    upsert_mock = mocker.patch(
        "agents.call_reviewer.persistence.upsert_call_review",
        return_value="doc-review",
    )

    resolver = ClientResolver({"client@example.com": "c-1"})
    team_resolver = pipeline.TeamMemberResolver(
        {"scott@theaipartner.io": "tm-scott"}
    )

    outcome = pipeline.ingest_call(
        _record_with_summary(),
        db,
        client_resolver=resolver,
        team_resolver=team_resolver,
        embed_fn=_fake_embed,
        dry_run=False,
    )

    # review_call called once with the persisted call_id + fathom_pipeline trigger
    review_mock.assert_called_once()
    args, kwargs = review_mock.call_args
    # call_id is positional; trigger_type is kwarg per the new signature.
    assert args[1] == "call-1"
    assert kwargs.get("trigger_type") == "fathom_pipeline"

    # upsert_call_review called once with the right metadata
    upsert_mock.assert_called_once()
    upsert_kwargs = upsert_mock.call_args.kwargs
    assert upsert_kwargs["call_external_id"] == "rec-001"
    assert upsert_kwargs["primary_client_id"] == "c-1"
    assert upsert_kwargs["call_category"] == "client"

    assert outcome.action == "inserted"
    assert outcome.errors == []


def test_auto_review_skipped_when_no_summary_text(mocker):
    """TXT-backlog shape (summary_text=None) skips both summary doc
    and review at the same gate."""
    db = _FakeDB()
    db.respond("select", "calls", [])
    db.respond("select", "documents", [])
    db.respond("select", "document_chunks", [])
    db.insert_returning("calls", ["call-1"])
    db.insert_returning("documents", ["doc-transcript"])

    review_mock = mocker.patch("agents.call_reviewer.reviewer.review_call")
    upsert_mock = mocker.patch(
        "agents.call_reviewer.persistence.upsert_call_review"
    )

    resolver = ClientResolver({"client@example.com": "c-1"})
    team_resolver = pipeline.TeamMemberResolver({})

    pipeline.ingest_call(
        _record(),  # no summary_text
        db,
        client_resolver=resolver,
        team_resolver=team_resolver,
        embed_fn=_fake_embed,
        dry_run=False,
    )

    review_mock.assert_not_called()
    upsert_mock.assert_not_called()


def test_auto_review_idempotent_when_existing_doc(mocker):
    """Pre-existing call_review documents row → no LLM call. Saves
    the ~$0.07 Sonnet cost on Fathom retries / dup deliveries."""
    db = _FakeDB()
    db.respond("select", "calls", [])
    db.respond("select", "documents", [])  # transcript doc lookup
    db.respond("select", "document_chunks", [])
    db.respond("select", "documents", [])  # summary doc lookup
    db.respond("select", "document_chunks", [])
    # Existence guard hit — return an existing review doc id.
    db.respond("select", "documents", [{"id": "doc-review-existing"}])
    db.insert_returning("calls", ["call-1"])
    db.insert_returning("documents", ["doc-transcript", "doc-summary"])

    review_mock = mocker.patch("agents.call_reviewer.reviewer.review_call")
    upsert_mock = mocker.patch(
        "agents.call_reviewer.persistence.upsert_call_review"
    )

    resolver = ClientResolver({"client@example.com": "c-1"})
    team_resolver = pipeline.TeamMemberResolver({})

    outcome = pipeline.ingest_call(
        _record_with_summary(),
        db,
        client_resolver=resolver,
        team_resolver=team_resolver,
        embed_fn=_fake_embed,
        dry_run=False,
    )

    review_mock.assert_not_called()
    upsert_mock.assert_not_called()
    assert outcome.errors == []


def test_auto_review_failure_does_not_break_ingest(mocker):
    """review_call raises → ingest_call still returns success, errors
    list captures the failure, summary doc was already written."""
    db = _FakeDB()
    _stage_pipeline_db_for_first_client_ingest(db)

    mocker.patch(
        "agents.call_reviewer.reviewer.review_call",
        side_effect=ValueError("simulated parse failure"),
    )
    upsert_mock = mocker.patch(
        "agents.call_reviewer.persistence.upsert_call_review"
    )

    resolver = ClientResolver({"client@example.com": "c-1"})
    team_resolver = pipeline.TeamMemberResolver(
        {"scott@theaipartner.io": "tm-scott"}
    )

    outcome = pipeline.ingest_call(
        _record_with_summary(),
        db,
        client_resolver=resolver,
        team_resolver=team_resolver,
        embed_fn=_fake_embed,
        dry_run=False,
    )

    # Pipeline still succeeded (summary doc was written before the
    # review hook fired).
    assert outcome.action == "inserted"
    # upsert never reached (review_call raised first)
    upsert_mock.assert_not_called()
    # Error captured in IngestOutcome for diagnostic visibility.
    assert any("call_review" in e for e in outcome.errors)
    # Summary doc was written — the tables_written set still includes
    # documents (transcript + summary).
    tables_written = {table for op, table, _ in db.ops if op == "insert"}
    assert "documents" in tables_written


def test_ensure_call_review_document_skips_non_client_category(mocker):
    """Direct unit test for the helper: non-client classification
    short-circuits at the category guard before any DB query."""
    from ingestion.fathom.classifier import ClassificationResult

    db = _FakeDB()
    review_mock = mocker.patch("agents.call_reviewer.reviewer.review_call")

    classification = ClassificationResult(
        call_category="internal",
        call_type=None,
        classification_confidence=0.95,
        classification_method="participant_match",
        primary_client_id=None,
        should_auto_create_client=None,
    )
    result = pipeline._ensure_call_review_document(
        db, _record_with_summary(), "call-1", classification
    )

    assert result is None
    review_mock.assert_not_called()
    # Category guard short-circuits BEFORE the existence query, so no
    # DB ops fire either.
    assert db.ops == []


def test_ensure_call_review_document_skips_when_no_primary_client_id(mocker):
    """Direct unit test: client category but null primary_client_id
    (orphan) skips at the second guard."""
    from ingestion.fathom.classifier import ClassificationResult

    db = _FakeDB()
    review_mock = mocker.patch("agents.call_reviewer.reviewer.review_call")

    classification = ClassificationResult(
        call_category="client",
        call_type=None,
        classification_confidence=0.6,
        classification_method="title_pattern",
        primary_client_id=None,  # orphan
        should_auto_create_client=None,
    )
    result = pipeline._ensure_call_review_document(
        db, _record_with_summary(), "call-1", classification
    )

    assert result is None
    review_mock.assert_not_called()
    assert db.ops == []
