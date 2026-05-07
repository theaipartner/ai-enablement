"""Unit tests for agents.call_reviewer.persistence.

Mocks the supabase db with a captured-payload stub that lets us
assert exactly what gets written. Covers:

  - INSERT path on first write
  - UPDATE path when an existing row is found (idempotent re-run)
  - is_active=False enforcement (defensive flip on update path)
  - validator gate (metadata shape passes the real validator)
  - assertion gate when primary_client_id is None
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agents.call_reviewer import persistence as p


_VALID_REVIEW = {
    "pain_points": [{"description": "x", "evidence": "y"}],
    "wins": [],
    "dodged_questions": [],
    "sentiment_arc": "Flat call.",
}


# ---------------------------------------------------------------------------
# Fake DB
# ---------------------------------------------------------------------------


class _FakeDocumentsTable:
    """Stub the documents table chain. Records every operation so tests
    can assert which path the function took (INSERT vs UPDATE) and what
    payload landed."""

    def __init__(self, *, existing: dict | None = None):
        self._existing = existing
        # Captured operations
        self.insert_payload: dict[str, Any] | None = None
        self.update_payload: dict[str, Any] | None = None
        self.update_filter_id: str | None = None
        # Internal state for the chain
        self._mode: str | None = None
        self._pending_update: dict[str, Any] | None = None

    # SELECT chain ------------------------------------------------------
    def select(self, *_args, **_kwargs):
        self._mode = "select"
        return self

    def eq(self, key, value):
        if self._mode == "update":
            if key == "id":
                self.update_filter_id = value
        return self

    def limit(self, *_args, **_kwargs):
        return self

    def execute(self):
        if self._mode == "select":
            data = [self._existing] if self._existing else []
            return SimpleNamespace(data=data)
        if self._mode == "insert":
            return SimpleNamespace(data=[{"id": "doc-new"}])
        if self._mode == "update":
            self.update_payload = self._pending_update
            return SimpleNamespace(data=None)
        raise AssertionError(f"unexpected execute() in mode {self._mode!r}")

    # INSERT ------------------------------------------------------------
    def insert(self, payload):
        self._mode = "insert"
        self.insert_payload = payload
        return self

    # UPDATE ------------------------------------------------------------
    def update(self, payload):
        self._mode = "update"
        self._pending_update = payload
        return self


class _FakeDb:
    def __init__(self, *, existing: dict | None = None):
        self.documents = _FakeDocumentsTable(existing=existing)

    def table(self, name):
        if name == "documents":
            return self.documents
        raise AssertionError(f"unexpected table {name!r}")


def _kwargs(**overrides):
    base = {
        "call_external_id": "ext-123",
        "primary_client_id": "client-1",
        "call_category": "client",
        "started_at": "2026-05-01T12:00:00+00:00",
        "model": "claude-sonnet-4-6",
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# INSERT path
# ---------------------------------------------------------------------------


def test_upsert_call_review_inserts_new_row_when_none_exists():
    db = _FakeDb(existing=None)
    doc_id = p.upsert_call_review(db, "call-1", _VALID_REVIEW, **_kwargs())
    assert doc_id == "doc-new"

    payload = db.documents.insert_payload
    assert payload is not None
    assert payload["source"] == "fathom"
    assert payload["external_id"] == "ext-123"
    assert payload["document_type"] == "call_review"
    # is_active is the V1 retrieval-side safety net — must be false.
    assert payload["is_active"] is False
    # content is the JSON-serialized review (pretty-printed).
    assert '"sentiment_arc": "Flat call."' in payload["content"]
    # Metadata has all required + optional keys.
    md = payload["metadata"]
    assert md["client_id"] == "client-1"
    assert md["call_id"] == "call-1"
    assert md["call_category"] == "client"
    assert md["started_at"] == "2026-05-01T12:00:00+00:00"
    assert md["model"] == "claude-sonnet-4-6"
    assert "prompt_version" in md


def test_upsert_call_review_metadata_passes_real_validator():
    """The persistence call must pass shared.ingestion.validate end-to-end.
    Catches drift between the validator's required-set and what we write."""
    db = _FakeDb(existing=None)
    p.upsert_call_review(db, "call-1", _VALID_REVIEW, **_kwargs())
    # No raise == validator passed. Belt-and-suspenders: re-run the
    # validator against the captured payload.
    from shared.ingestion.validate import validate_document_metadata
    validate_document_metadata(
        db.documents.insert_payload["metadata"],
        source="fathom",
        document_type="call_review",
    )


# ---------------------------------------------------------------------------
# UPDATE path (idempotent re-run)
# ---------------------------------------------------------------------------


def test_upsert_call_review_updates_existing_row_in_place():
    existing = {
        "id": "doc-existing",
        "content": "{stale content}",
        "metadata": {"old": "shape"},
        "is_active": False,
    }
    db = _FakeDb(existing=existing)
    doc_id = p.upsert_call_review(db, "call-1", _VALID_REVIEW, **_kwargs())

    assert doc_id == "doc-existing"
    assert db.documents.insert_payload is None  # didn't INSERT
    assert db.documents.update_filter_id == "doc-existing"
    update = db.documents.update_payload
    assert update is not None
    assert "content" in update  # content changed
    assert "metadata" in update  # metadata changed


def test_upsert_call_review_no_op_when_existing_matches():
    """When existing content + metadata + is_active all already match
    what we'd write, no UPDATE is issued."""
    import json
    review_json = json.dumps(_VALID_REVIEW, indent=2)
    matching_metadata = {
        "client_id": "client-1",
        "call_id": "call-1",
        "call_category": "client",
        "started_at": "2026-05-01T12:00:00+00:00",
        "prompt_version": p.PROMPT_VERSION,
        "model": "claude-sonnet-4-6",
    }
    existing = {
        "id": "doc-existing",
        "content": review_json,
        "metadata": matching_metadata,
        "is_active": False,
    }
    db = _FakeDb(existing=existing)
    p.upsert_call_review(db, "call-1", _VALID_REVIEW, **_kwargs())
    # Update payload should be None — nothing changed.
    assert db.documents.update_payload is None


def test_upsert_call_review_flips_is_active_back_to_false():
    """If a prior write somehow set is_active=true on a review row, the
    upsert must flip it back. Defense-in-depth against future bugs that
    might accidentally set the retrieval flag."""
    import json
    review_json = json.dumps(_VALID_REVIEW, indent=2)
    matching_metadata = {
        "client_id": "client-1",
        "call_id": "call-1",
        "call_category": "client",
        "started_at": "2026-05-01T12:00:00+00:00",
        "prompt_version": p.PROMPT_VERSION,
        "model": "claude-sonnet-4-6",
    }
    existing = {
        "id": "doc-existing",
        "content": review_json,
        "metadata": matching_metadata,
        "is_active": True,  # ← bad state
    }
    db = _FakeDb(existing=existing)
    p.upsert_call_review(db, "call-1", _VALID_REVIEW, **_kwargs())

    update = db.documents.update_payload
    assert update is not None
    assert update["is_active"] is False
    # content + metadata didn't change — only is_active is in the payload.
    assert "content" not in update
    assert "metadata" not in update


# ---------------------------------------------------------------------------
# Assertion gate
# ---------------------------------------------------------------------------


def test_upsert_call_review_asserts_on_none_primary_client_id():
    db = _FakeDb(existing=None)
    with pytest.raises(AssertionError, match=r"primary_client_id"):
        p.upsert_call_review(
            db, "call-1", _VALID_REVIEW, **_kwargs(primary_client_id=None)
        )
    # Nothing written.
    assert db.documents.insert_payload is None
    assert db.documents.update_payload is None
