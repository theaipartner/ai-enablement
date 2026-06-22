"""Ingestion-time validators for `documents.metadata` and
`document_chunks.metadata`.

Every ingestion pipeline calls these **before** inserting rows. The
goal is to catch missing required keys at write time rather than at
retrieval time, and to make it obvious when a pipeline drifts away
from the metadata conventions pinned in
`docs/fulfillment/metadata-conventions.md`.

Two behaviors:
  - Missing required keys — raise `ValueError` with the missing list.
  - Unknown keys (not required, not optional) — log a warning via
    `shared.logging.logger`, do not raise. Extensibility is the whole
    point of jsonb metadata; we just want visibility when new keys
    appear.

Drive ingestion isn't built yet and its metadata shape isn't pinned.
Attempting to validate drive-sourced metadata raises
`NotImplementedError` pointing at the conventions doc.

Example:

    from shared.ingestion.validate import (
        validate_document_metadata, validate_chunk_metadata,
    )

    validate_document_metadata(
        metadata={"client_id": ..., "call_id": ..., "call_category": "client",
                  "started_at": "2026-04-20T12:00:00Z"},
        source="fathom",
        document_type="call_summary",
    )
    validate_chunk_metadata(
        metadata={"chunk_start_ts": "00:00:00", "chunk_end_ts": "00:05:00",
                  "speaker_list": ["Drake"], "speaker_turn_count": 4},
        source="fathom",
        document_type="call_transcript_chunk",
    )
"""

from __future__ import annotations

from dataclasses import dataclass

from shared.logging import logger

_CONVENTIONS_REF = "docs/fulfillment/metadata-conventions.md"


@dataclass(frozen=True)
class _Spec:
    required: frozenset[str]
    optional: frozenset[str]

    @property
    def known(self) -> frozenset[str]:
        return self.required | self.optional


# Document metadata conventions keyed by (source, document_type). Mirrors
# docs/fulfillment/metadata-conventions.md §2 exactly. If this table and the
# doc disagree, the doc is the spec — update the table.
_DOCUMENT_SPECS: dict[tuple[str, str], _Spec] = {
    ("fathom", "call_summary"): _Spec(
        required=frozenset({"client_id", "call_id", "call_category", "started_at"}),
        optional=frozenset({
            "call_type", "duration_seconds", "participant_emails",
            "speaker_list", "source_url",
            "classification_confidence", "classification_method",
        }),
    ),
    ("fathom", "call_transcript_chunk"): _Spec(
        required=frozenset({"client_id", "call_id", "call_category", "started_at"}),
        optional=frozenset({
            "call_type", "duration_seconds", "participant_emails",
            "speaker_list", "source_url",
            "classification_confidence", "classification_method",
        }),
    ),
    # call_reviewer agent output. Stored as a documents row for
    # dashboard surfacing only — is_active=False at write time so the
    # row never lands in match_document_chunks results. See
    # docs/fulfillment/metadata-conventions.md §2 "Fathom call reviews"
    # and the followup in docs/archive/historical/known-issues.md about promoting the
    # exclusion into the SQL function when V2 generates these inline.
    ("fathom", "call_review"): _Spec(
        required=frozenset({"client_id", "call_id", "call_category", "started_at"}),
        optional=frozenset({"prompt_version", "model", "sentiment_tier"}),
    ),
}

# Source-level fallbacks: applied when no (source, document_type) entry
# matches. For source='manual' the document_type doesn't affect the shape.
_DOCUMENT_SOURCE_FALLBACKS: dict[str, _Spec] = {
    "manual": _Spec(
        required=frozenset(),
        optional=frozenset({"author", "last_reviewed_by", "last_reviewed_at"}),
    ),
}

_CHUNK_SPECS: dict[tuple[str, str], _Spec] = {
    ("fathom", "call_transcript_chunk"): _Spec(
        required=frozenset({
            "chunk_start_ts", "chunk_end_ts", "speaker_list", "speaker_turn_count",
        }),
        optional=frozenset(),
    ),
}


def _resolve_document_spec(source: str, document_type: str) -> _Spec | None:
    """Return the applicable doc-metadata Spec or None when no rule pins one.

    `drive` is special-cased at the caller — it raises rather than returning.
    """
    spec = _DOCUMENT_SPECS.get((source, document_type))
    if spec is not None:
        return spec
    return _DOCUMENT_SOURCE_FALLBACKS.get(source)


def validate_document_metadata(
    metadata: dict,
    source: str,
    document_type: str,
) -> None:
    """Validate `documents.metadata` against the pinned conventions.

    Raises:
        ValueError: when required keys are absent.
        NotImplementedError: for sources whose conventions aren't pinned
            yet (`drive`).
    """
    if source == "drive":
        raise NotImplementedError(
            "Drive metadata conventions not yet pinned; "
            f"see {_CONVENTIONS_REF} §2 'Drive documents (TBD)'."
        )

    spec = _resolve_document_spec(source, document_type)
    if spec is None:
        logger.warning(
            "No document metadata spec for source=%r document_type=%r; "
            "no validation performed. Add an entry to %s and %s to pin it.",
            source, document_type, _CONVENTIONS_REF, __name__,
        )
        return

    _check_required(
        metadata, spec, context=f"documents.metadata source={source} document_type={document_type}"
    )
    _warn_on_unknown(
        metadata, spec, context=f"documents.metadata source={source} document_type={document_type}"
    )


def validate_chunk_metadata(
    metadata: dict,
    source: str,
    document_type: str,
) -> None:
    """Validate `document_chunks.metadata` against the pinned conventions.

    For (source, document_type) combinations without a defined chunk shape,
    silently passes but logs a warning if `metadata` is non-empty so drift
    is visible.

    Raises:
        ValueError: when required chunk keys are absent.
    """
    spec = _CHUNK_SPECS.get((source, document_type))
    if spec is None:
        if metadata:
            logger.warning(
                "document_chunks.metadata received for source=%r document_type=%r "
                "but no chunk-metadata spec is pinned. Keys present: %s. "
                "Add an entry to %s if these keys are intentional.",
                source, document_type, sorted(metadata.keys()), _CONVENTIONS_REF,
            )
        return

    _check_required(
        metadata, spec, context=f"document_chunks.metadata source={source} document_type={document_type}"
    )
    _warn_on_unknown(
        metadata, spec, context=f"document_chunks.metadata source={source} document_type={document_type}"
    )


def _check_required(metadata: dict, spec: _Spec, *, context: str) -> None:
    missing = sorted(k for k in spec.required if k not in metadata)
    if missing:
        raise ValueError(
            f"{context}: missing required keys {missing}. "
            f"See {_CONVENTIONS_REF}."
        )


def _warn_on_unknown(metadata: dict, spec: _Spec, *, context: str) -> None:
    unknown = sorted(k for k in metadata if k not in spec.known)
    if unknown:
        logger.warning(
            "%s: unknown metadata keys %s. Extending metadata is allowed — "
            "but if these should be documented, update %s.",
            context, unknown, _CONVENTIONS_REF,
        )
