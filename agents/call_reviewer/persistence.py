"""Idempotent write of a call_review document.

Mirrors `ingestion/fathom/pipeline.py:_ensure_summary_document` but
simpler — no chunks, no embedding, single document row only.

The document is written with `is_active = False` so it never lands
in `match_document_chunks` results. This is V1's retrieval-side
safety net (the existing function exclusion list doesn't cover
`call_review`); when V2 wires generation into the ingestion pipeline,
the function should be extended to exclude `call_review` explicitly
via migration. Followup tracked in `docs/archive/historical/known-issues.md`.

Idempotency: keyed on (source='fathom', external_id=<calls.external_id>,
document_type='call_review') via the migration-0011 widened unique.
On re-run, content + metadata are synced in place.
"""

from __future__ import annotations

import json
from typing import Any

from shared.ingestion.validate import validate_document_metadata

from agents.call_reviewer.prompt import PROMPT_VERSION
from agents.call_reviewer.sentiment_classifier import classify_sentiment_tier

import logging

_logger = logging.getLogger("ai_enablement.call_reviewer.persistence")

_SOURCE = "fathom"
_REVIEW_DOC_TYPE = "call_review"


def upsert_call_review(
    db,
    call_id: str,
    review: dict[str, Any],
    *,
    call_external_id: str,
    primary_client_id: str | None,
    call_category: str,
    started_at: str,
    model: str,
    prompt_version: str = PROMPT_VERSION,
    title: str | None = None,
) -> str:
    """Idempotent upsert of a call_review document.

    Returns the documents.id.

    Args:
        db: Supabase client (from shared.db.get_client()).
        call_id: calls.id UUID — populates metadata.call_id.
        review: parsed dict from agents.call_reviewer.reviewer.review_call.
        call_external_id: calls.external_id — the documents-table key
            for idempotency.
        primary_client_id: calls.primary_client_id. MUST be non-null —
            backfill caller filters on this. Asserted at the top.
        call_category: calls.call_category (denormalized into metadata).
        started_at: calls.started_at as ISO string.
        model: Claude model id used to generate the review.
        prompt_version: defaults to the constant from prompt.py.
        title: documents.title text. Optional — falls back to a
            human-readable identifier when omitted.

    Raises:
        ValueError: when validate_document_metadata rejects the
            metadata shape (programmer error — should never fire if
            the spec and this caller stay in sync).
    """
    if primary_client_id is None:
        raise AssertionError(
            f"upsert_call_review called for call {call_id} with "
            "primary_client_id=None; backfill must filter these out"
        )

    metadata = {
        "client_id": primary_client_id,
        "call_id": call_id,
        "call_category": call_category,
        "started_at": started_at,
        "prompt_version": prompt_version,
        "model": model,
    }
    # Sentiment-tier injection. Haiku-classified, display-only, never
    # load-bearing — so a classifier failure must not block the write.
    # On exception we log and proceed without the field; the doc still
    # lands, the dashboard renders the call without a sentiment pill.
    sentiment_arc = review.get("sentiment_arc")
    if isinstance(sentiment_arc, str) and sentiment_arc:
        try:
            metadata["sentiment_tier"] = classify_sentiment_tier(sentiment_arc)
        except Exception as exc:
            _logger.warning(
                "sentiment classifier failed for call %s — writing review "
                "without sentiment_tier: %s",
                call_id,
                exc,
            )
    validate_document_metadata(
        metadata, source=_SOURCE, document_type=_REVIEW_DOC_TYPE
    )

    content = json.dumps(review, indent=2)
    doc_title = title or f"Call review {call_id}"

    existing = _find_review_document(db, call_external_id)
    if existing is None:
        return _insert_review_document(
            db,
            external_id=call_external_id,
            title=doc_title,
            content=content,
            metadata=metadata,
        )

    doc_id = existing["id"]
    update_payload: dict[str, Any] = {}
    if existing.get("content") != content:
        update_payload["content"] = content
    if existing.get("metadata") != metadata:
        update_payload["metadata"] = metadata
    # Defensive: if a prior write somehow set is_active=true on a review
    # row, flip it back. Keeps the retrieval-side invariant intact even
    # against future bugs.
    if existing.get("is_active", True) is not False:
        update_payload["is_active"] = False
    if update_payload:
        db.table("documents").update(update_payload).eq("id", doc_id).execute()
    return doc_id


def find_review_by_call_external_id(
    db, call_external_id: str
) -> dict[str, Any] | None:
    """Return the parsed review JSON for a given Fathom recording id, or None.

    Public reader paired with `upsert_call_review`. Resolves the
    `documents` row keyed by (source='fathom', external_id=<recording_id>,
    document_type='call_review') and parses `content` as JSON.

    Returns None when:
      - No row exists for the given external_id
      - The row exists but `content` is not valid JSON (defensive — the
        upsert path always writes valid JSON, but a manual edit or future
        corruption shouldn't crash the reader)
      - The row exists but the parsed value isn't a dict

    Does NOT raise on DB errors — caller is the cs_call_summary_post
    fail-soft path; let the exception propagate so the caller's try/except
    can record the fetch failure in its audit trail. (The upsert path
    has the same shape: DB errors propagate.)
    """
    row = _find_review_document(db, call_external_id)
    if row is None:
        return None
    content = row.get("content")
    if not isinstance(content, str):
        return None
    try:
        parsed = json.loads(content)
    except (ValueError, TypeError):
        return None
    if not isinstance(parsed, dict):
        return None
    return parsed


def find_review_sentiment_tier_by_call_external_id(
    db, call_external_id: str
) -> str | None:
    """Return the persisted sentiment tier ('green'|'yellow'|'red') for a
    call_review doc, or None.

    Reads `metadata.sentiment_tier` — the value the Haiku classifier
    wrote at upsert time. Does NOT re-classify (no LLM call). None when
    the row is missing, the metadata lacks the field, or the value is
    out of the known set."""
    row = _find_review_document(db, call_external_id)
    if row is None:
        return None
    meta = row.get("metadata")
    if not isinstance(meta, dict):
        return None
    tier = meta.get("sentiment_tier")
    return tier if tier in ("green", "yellow", "red") else None


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _find_review_document(db, external_id: str) -> dict[str, Any] | None:
    """Find the call_review doc for a given recording_id.

    Direct (source, external_id, document_type) lookup against the
    migration-0011 unique. O(1).
    """
    resp = (
        db.table("documents")
        .select("id, content, metadata, is_active")
        .eq("source", _SOURCE)
        .eq("external_id", external_id)
        .eq("document_type", _REVIEW_DOC_TYPE)
        .limit(1)
        .execute()
    )
    rows = resp.data or []
    return rows[0] if rows else None


def _insert_review_document(
    db,
    *,
    external_id: str,
    title: str,
    content: str,
    metadata: dict[str, Any],
) -> str:
    payload = {
        "source": _SOURCE,
        "external_id": external_id,
        "title": title,
        "content": content,
        "document_type": _REVIEW_DOC_TYPE,
        "metadata": metadata,
        # Display-only document. NEVER set this true — see module
        # docstring for the retrieval-side rationale.
        "is_active": False,
    }
    resp = db.table("documents").insert(payload).execute()
    return resp.data[0]["id"]
