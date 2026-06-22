"""Orchestrator for the Fathom backlog ingestion pipeline.

Per-call flow:

  1. Classify the parsed record via `ingestion.fathom.classifier.classify`.
  2. If the classifier emitted an `AutoCreateRequest`, do the
     lookup-by-email-first-insert-second dance so repeated calls with
     the same unmatched participant reuse one auto-created client row.
  3. Upsert the `calls` row keyed on `(source='fathom', external_id)`.
     Retrievability rule is asymmetric per conventions §6:
       - first-ingest → set `is_retrievable_by_client_agents` from the
         classifier's floor check
       - re-ingest demote → flip to false automatically
       - re-ingest promote → NEVER flip to true automatically (a human
         must make that call via manual review)
  4. Upsert `call_participants` linking emails to `clients` /
     `team_members` where resolvable.
  5. `call_action_items` is NEVER populated from TXT backlog ingestion —
     see the deferral note in docs/fulfillment/metadata-conventions.md §5.
  6. Skip `call_summary` document creation — same deferral reason (the
     TXT exports don't carry summaries).
  7. For client-category calls only, create or update a parent document
     with `document_type='call_transcript_chunk'` plus its N child
     `document_chunks`. The parent document's `is_active` is set from
     the same retrievability value that `calls.is_retrievable_by_
     client_agents` carries — medium-confidence (auto-created) calls
     land with `is_active=false` so chunks exist but don't surface in
     `match_document_chunks`. See `docs/fulfillment/future-ideas.md` →
     "match_document_chunks: enforce calls retrievability via SQL
     join" for the eventual function-side upgrade. Re-ingest that
     already has chunks skips re-chunking (conventions §6) but syncs
     denormalized metadata AND is_active.
  8. For non-client re-ingest of a call that previously had chunks:
     soft-archive the parent document (`is_active=false`). Chunks
     become invisible to `match_document_chunks` automatically.

**Non-atomic but idempotent.** supabase-py writes go through
PostgREST one request at a time; cross-request transactions aren't
available. Every write in this module is upsert-shaped and keyed on
stable identifiers, so a partial failure recovers on re-run without
leaving duplicate rows. See the "Atomic per-call ingest via Postgres
RPC" entry in docs/fulfillment/future-ideas.md for the eventual upgrade path.

Validators (`shared.ingestion.validate`) run before every `documents`
or `document_chunks` write. A validation failure is logged to the
`IngestOutcome` and the specific write is skipped; other writes for
the same call continue.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable

from ingestion.fathom.classifier import (
    AMAN_EMAIL,
    AutoCreateRequest,
    ClassificationResult,
    ClientResolver,
    classify,
)
from ingestion.fathom.chunker import Chunk, chunk_transcript
from ingestion.fathom.parser import FathomCallRecord
from shared.ingestion.validate import (
    validate_chunk_metadata,
    validate_document_metadata,
)
from shared.logging import logger

_SOURCE = "fathom"
_TRANSCRIPT_DOC_TYPE = "call_transcript_chunk"
# Classifier categories that are worth indexing to document_chunks for
# retrieval today. Only client calls land in documents/document_chunks
# in V1 — internal and external categories get a `calls` row but no
# chunks. CSM Co-Pilot will extend this in a later session.
_INDEXABLE_CATEGORIES: frozenset[str] = frozenset({"client"})

# For cost-estimate reporting in the CLI. Update if Anthropic/OpenAI
# change prices (OpenAI text-embedding-3-small as of 2026-04).
_EMBEDDING_COST_USD_PER_MILLION_TOKENS = 0.02
_EMBEDDING_TOKENS_PER_CHUNK_ESTIMATE = 500


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class IngestOutcome:
    """What happened for one call."""

    external_id: str
    call_id: str | None
    category: str
    call_type: str | None
    confidence: float
    method: str
    primary_client_id: str | None
    primary_client_name: str | None
    auto_created_client_id: str | None
    auto_created_client_email: str | None
    participants_linked_to_clients: int
    participants_linked_to_team: int
    document_id: str | None
    chunks_written: int
    chunks_reused: int
    retrievable: bool
    retrievable_before: bool | None
    action: str
    validation_failures: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


class TeamMemberResolver:
    """Resolve team member emails to `team_members.id`. Case-insensitive."""

    def __init__(self, id_by_email: dict[str, str]):
        self._map: dict[str, str] = {e.lower(): tmid for e, tmid in id_by_email.items()}

    def lookup(self, email: str) -> str | None:
        if not email:
            return None
        return self._map.get(email.lower())


# ---------------------------------------------------------------------------
# Resolver loading
# ---------------------------------------------------------------------------


def load_resolvers(db) -> tuple[ClientResolver, TeamMemberResolver, dict[str, str]]:
    """Single-SELECT-each prefetch of the lookup tables.

    Returns `(client_resolver, team_member_resolver, client_id_to_name)`.
    The name map is used for dry-run display (matched client names).

    ClientResolver's email map includes `metadata.alternate_emails`
    and the name map includes `metadata.alternate_names` so merged-
    duplicate clients remain matchable by their pre-merge identifiers.
    """
    client_resp = (
        db.table("clients")
        .select("id,email,full_name,metadata")
        .is_("archived_at", "null")
        .execute()
    )
    team_resp = db.table("team_members").select("id,email").is_("archived_at", "null").execute()

    client_id_by_email: dict[str, str] = {}
    client_id_by_name: dict[str, str] = {}
    client_id_to_name: dict[str, str] = {}
    for row in client_resp.data or []:
        cid = row["id"]
        if row.get("email"):
            client_id_by_email[row["email"]] = cid
        if row.get("full_name"):
            client_id_by_name[row["full_name"]] = cid
            client_id_to_name[cid] = row["full_name"]

        metadata = row.get("metadata") or {}
        for alt_email in (metadata.get("alternate_emails") or []):
            if isinstance(alt_email, str) and alt_email:
                client_id_by_email[alt_email] = cid
        for alt_name in (metadata.get("alternate_names") or []):
            if isinstance(alt_name, str) and alt_name:
                client_id_by_name[alt_name] = cid

    team_id_by_email: dict[str, str] = {}
    for row in team_resp.data or []:
        team_id_by_email[row["email"]] = row["id"]

    return (
        ClientResolver(client_id_by_email, client_id_by_name),
        TeamMemberResolver(team_id_by_email),
        client_id_to_name,
    )


# ---------------------------------------------------------------------------
# Per-call entry point
# ---------------------------------------------------------------------------


def ingest_call(
    record: FathomCallRecord,
    db,
    *,
    client_resolver: ClientResolver,
    team_resolver: TeamMemberResolver,
    embed_fn: Callable[[str], list[float]] | None = None,
    file_size_bytes: int | None = None,
    dry_run: bool = True,
) -> IngestOutcome:
    """Run the full per-call flow. See module docstring."""
    validation_failures: list[str] = []
    errors: list[str] = []

    classification = classify(
        record, client_resolver, file_size_bytes=file_size_bytes
    )

    auto_created_id: str | None = None
    auto_created_email: str | None = None
    if classification.should_auto_create_client and not dry_run:
        auto_created_id, auto_created_email = _lookup_or_create_auto_client(
            db,
            classification.should_auto_create_client,
            client_resolver,
            record,
        )
        # Promote classification's primary_client_id to the resolved id
        # so downstream writes carry it. Confidence stays medium —
        # per conventions §5 step 4, only a known-client match promotes.
        classification = _with_primary_client_id(classification, auto_created_id)

    if dry_run:
        return _dry_run_outcome(
            record, classification, client_resolver, auto_created_email
        )

    call_id, was_pre_existing, retrievable_before, final_retrievable = _upsert_call_row(
        db, record, classification
    )

    linked_clients, linked_team = _upsert_participants(
        db, call_id, record, client_resolver, team_resolver
    )

    document_id: str | None = None
    chunks_written = 0
    chunks_reused = 0

    if classification.call_category in _INDEXABLE_CATEGORIES:
        # Index the transcript chunks. Existing doc → sync metadata,
        # reuse chunks unless there are none. No existing doc → create
        # doc + chunks.
        doc_metadata = _build_document_metadata(record, classification, call_id)
        document_id, chunks_written, chunks_reused, doc_validation_failures = (
            _ensure_transcript_chunks(
                db, record, call_id, classification, embed_fn, doc_metadata,
                retrievable=final_retrievable,
            )
        )
        validation_failures.extend(doc_validation_failures)

        # Summary doc — only populated by webhook-sourced records today;
        # backlog TXT records leave summary_text=None and this is a no-op.
        # F2.3 closes the `call_summary` deferral that F1 carried.
        if record.summary_text:
            summary_validation_failures = _ensure_summary_document(
                db, record, call_id, classification, embed_fn,
                retrievable=final_retrievable,
            )
            validation_failures.extend(summary_validation_failures)

            # Auto-review hook. Mirrors the cs_call_summary_post hook
            # below: wrapped in try/except so a review-generation failure
            # NEVER fails the Fathom webhook delivery. The call row +
            # summary doc + chunks are already persisted; review is
            # value-add. Idempotency-by-existence inside the helper
            # means Fathom retries / re-deliveries don't burn LLM
            # tokens. Logged failures land in agent_runs (via
            # review_call's own telemetry) for later diagnosis.
            try:
                _ensure_call_review_document(db, record, call_id, classification)
            except Exception as exc:
                logger.warning(
                    "_ensure_call_review_document hook raised for call %s: %s — "
                    "ingest continues",
                    call_id,
                    exc,
                )
                errors.append(f"call_review: {exc!r}")
    else:
        # Non-client call. If a prior client-classification wrote a
        # document for this call, soft-archive it so chunks stop
        # appearing in client-mode retrieval.
        document_id = _soft_archive_transcript_document_if_exists(db, call_id)

    # Action items — written regardless of category because internal and
    # external calls can also produce trackable commitments. Three-state
    # contract: None = "no info" (TXT backlog), [] = "call has zero",
    # [..] = "replace existing with these". Delete-replace inside the
    # helper keeps idempotency simple since Fathom doesn't give us stable
    # per-item ids. Closes the call_action_items deferral from F1.
    if record.action_items is not None:
        _upsert_action_items(
            db, call_id, record.action_items, client_resolver, team_resolver,
        )

    action = "updated" if was_pre_existing else "inserted"

    # CS visibility hook (M6.1 — Batch A). Posts a per-call summary to
    # the cross-CSM Slack channel for client-category calls. Wrapped in
    # try/except so a Slack-post failure NEVER fails the Fathom webhook
    # delivery — the call row + summary doc + chunks are more important
    # than the Slack message. Audit trail via webhook_deliveries with
    # source='cs_call_summary_slack_post'.
    try:
        from agents.gregory.cs_call_summary_post import (
            maybe_post_cs_call_summary,
        )

        maybe_post_cs_call_summary(
            db,
            call_id=call_id,
            call_category=classification.call_category,
            primary_client_id=classification.primary_client_id,
            summary_text=record.summary_text,
            fathom_external_id=record.external_id,
        )
    except Exception as exc:
        logger.warning(
            "cs_call_summary_post hook raised for call %s: %s — "
            "ingest continues",
            call_id,
            exc,
        )

    return IngestOutcome(
        external_id=record.external_id,
        call_id=call_id,
        category=classification.call_category,
        call_type=classification.call_type,
        confidence=classification.classification_confidence,
        method=classification.classification_method,
        primary_client_id=classification.primary_client_id,
        primary_client_name=None,  # filled by CLI-side enrichment
        auto_created_client_id=auto_created_id,
        auto_created_client_email=auto_created_email,
        participants_linked_to_clients=linked_clients,
        participants_linked_to_team=linked_team,
        document_id=document_id,
        chunks_written=chunks_written,
        chunks_reused=chunks_reused,
        retrievable=final_retrievable,
        retrievable_before=retrievable_before,
        action=action,
        validation_failures=validation_failures,
        errors=errors,
    )


# ---------------------------------------------------------------------------
# Auto-create client
# ---------------------------------------------------------------------------


def _lookup_or_create_auto_client(
    db,
    request: AutoCreateRequest,
    resolver: ClientResolver,
    record: FathomCallRecord,
) -> tuple[str, str]:
    """Lookup by email first; only insert if missing. Update the
    in-memory resolver so subsequent calls in the same batch reuse the
    row rather than double-insert.

    Metadata carries a breadcrumb back to the triggering call — the
    reviewer workflow (see `docs/fulfillment/future-ideas.md` → "Auto-created
    client review workflow") uses these fields to find the recording
    that prompted the auto-create.
    """
    email = request.email.lower()

    # First: check if this email already exists in clients, archived or not.
    resp = (
        db.table("clients").select("id,archived_at").eq("email", email).execute()
    )
    existing_active = next(
        (r for r in (resp.data or []) if r.get("archived_at") is None),
        None,
    )
    if existing_active is not None:
        resolver._map[email] = existing_active["id"]  # noqa: SLF001
        return existing_active["id"], email

    auto_metadata = _build_auto_create_metadata(request, record)

    # Second: if an archived row exists, reactivate it rather than insert
    # a new one. Preserves history under the partial unique index.
    existing_archived = next((r for r in (resp.data or [])), None)
    if existing_archived is not None:
        db.table("clients").update({
            "archived_at": None,
            "tags": ["needs_review"],
            "metadata": auto_metadata,
        }).eq("id", existing_archived["id"]).execute()
        resolver._map[email] = existing_archived["id"]  # noqa: SLF001
        return existing_archived["id"], email

    # Third: actually insert.
    payload = {
        "email": email,
        "full_name": request.display_name or email.split("@", 1)[0],
        "status": "active",
        "tags": ["needs_review"],
        "metadata": auto_metadata,
    }
    insert_resp = db.table("clients").insert(payload).execute()
    new_id = insert_resp.data[0]["id"]
    resolver._map[email] = new_id  # noqa: SLF001
    return new_id, email


def _build_auto_create_metadata(
    request: AutoCreateRequest, record: FathomCallRecord
) -> dict[str, Any]:
    return {
        "auto_created_from_call_ingestion": True,
        "auto_created_from_call_external_id": record.external_id,
        "auto_created_from_call_title": record.title,
        "auto_create_reason": request.reason,
        "auto_created_at": datetime.now(timezone.utc).isoformat(),
    }


def _with_primary_client_id(
    classification: ClassificationResult, new_id: str
) -> ClassificationResult:
    """Return a copy of the classification with primary_client_id set."""
    from dataclasses import replace
    return replace(classification, primary_client_id=new_id)


# ---------------------------------------------------------------------------
# calls row upsert + retrievability floor
# ---------------------------------------------------------------------------


def _upsert_call_row(
    db, record: FathomCallRecord, classification: ClassificationResult
) -> tuple[str, bool, bool | None, bool]:
    """Insert or update the calls row. Returns
    (call_id, was_pre_existing, retrievable_before, final_retrievable)."""
    existing_resp = (
        db.table("calls")
        .select("id,is_retrievable_by_client_agents")
        .eq("source", _SOURCE)
        .eq("external_id", record.external_id)
        .execute()
    )
    existing = (existing_resp.data or [None])[0]

    new_should_retrieve = classification.should_be_retrievable
    retrievable_before: bool | None = None
    if existing is None:
        # First ingest — retrievability follows the classifier's floor.
        final_retrievable = new_should_retrieve
    else:
        retrievable_before = bool(existing["is_retrievable_by_client_agents"])
        if retrievable_before and not new_should_retrieve:
            # Demote — classifier floor no longer passes.
            final_retrievable = False
        else:
            # Never auto-promote. If it was false, it stays false until
            # a human reviews. If it was true and still passes, keep true.
            final_retrievable = retrievable_before and new_should_retrieve

    payload = {
        "source": _SOURCE,
        "external_id": record.external_id,
        "title": record.title,
        "call_category": classification.call_category,
        "call_type": classification.call_type,
        "classification_confidence": classification.classification_confidence,
        "classification_method": classification.classification_method,
        "primary_client_id": classification.primary_client_id,
        "started_at": record.started_at.isoformat(),
        "duration_seconds": record.duration_seconds,
        "recording_url": record.recording_url,
        "transcript": record.transcript,
        "is_retrievable_by_client_agents": final_retrievable,
        "raw_payload": _raw_payload(record),
    }

    if existing is None:
        resp = db.table("calls").insert(payload).execute()
        call_id = resp.data[0]["id"]
        return call_id, False, None, final_retrievable

    call_id = existing["id"]
    db.table("calls").update(payload).eq("id", call_id).execute()
    return call_id, True, retrievable_before, final_retrievable


def _raw_payload(record: FathomCallRecord) -> dict[str, Any]:
    """Capture source context in the jsonb column.

    The TXT export has no structured API response; we preserve the raw
    text verbatim so downstream extractions (future action items,
    summaries) can re-parse without re-fetching from Fathom.
    """
    source_filename = record.source_path.name if record.source_path else None
    return {
        "source_format": record.source_format,
        "source_filename": source_filename,
        "raw_text": record.raw_text,
        "parse_warnings": list(record.parse_warnings),
    }


# ---------------------------------------------------------------------------
# call_participants upsert
# ---------------------------------------------------------------------------


def _upsert_participants(
    db,
    call_id: str,
    record: FathomCallRecord,
    client_resolver: ClientResolver,
    team_resolver: TeamMemberResolver,
) -> tuple[int, int]:
    """Insert or refresh one call_participants row per attendee.

    Returns (matched_to_clients, matched_to_team) for the outcome
    report. Uses `on_conflict=(call_id, email)` so re-ingest doesn't
    duplicate rows.
    """
    recorded_by_email = (
        record.recorded_by.email.lower() if record.recorded_by else None
    )

    linked_clients = 0
    linked_team = 0
    payloads: list[dict[str, Any]] = []
    for pt in record.participants:
        email_lower = pt.email.lower()
        client_id = client_resolver.lookup(email_lower)
        team_id = team_resolver.lookup(email_lower)
        if client_id:
            linked_clients += 1
        if team_id:
            linked_team += 1
        participant_role = "host" if email_lower == recorded_by_email else "attendee"
        payloads.append({
            "call_id": call_id,
            "email": email_lower,
            "display_name": pt.display_name,
            "client_id": client_id,
            "team_member_id": team_id,
            "participant_role": participant_role,
        })

    if payloads:
        db.table("call_participants").upsert(
            payloads, on_conflict="call_id,email"
        ).execute()

    return linked_clients, linked_team


# ---------------------------------------------------------------------------
# Transcript document + chunks
# ---------------------------------------------------------------------------


def _ensure_transcript_chunks(
    db,
    record: FathomCallRecord,
    call_id: str,
    classification: ClassificationResult,
    embed_fn: Callable[[str], list[float]] | None,
    doc_metadata: dict[str, Any],
    *,
    retrievable: bool,
) -> tuple[str | None, int, int, list[str]]:
    """Idempotent chunk-and-embed for a client call.

    `retrievable` is the post-asymmetric-rule retrievability value for
    the parent `calls` row. It maps 1:1 to `documents.is_active` for the
    transcript_chunk document — today's invariant is "a transcript_chunk
    document surfaces via `match_document_chunks` iff its call is
    retrievable." Option (b) in `docs/fulfillment/future-ideas.md` moves the same
    check into the SQL function via a join; until then the pipeline
    enforces it at write time.

    Behavior:
      - No existing parent doc → insert parent (with `is_active =
        retrievable`), chunk, embed, insert all chunks.
      - Existing parent doc with chunks → sync metadata, sync is_active
        to the new retrievability, reuse chunks (conventions §6 forbids
        re-embedding on re-classification).
      - Existing parent doc with 0 chunks (partial-failure recovery) →
        sync metadata, sync is_active, chunk + embed + insert.

    Returns `(document_id, chunks_written, chunks_reused, validation_failures)`.
    """
    validation_failures: list[str] = []

    try:
        validate_document_metadata(
            doc_metadata, source=_SOURCE, document_type=_TRANSCRIPT_DOC_TYPE
        )
    except ValueError as exc:
        validation_failures.append(f"document: {exc}")
        logger.error("Document validation failed for call %s: %s", call_id, exc)
        return None, 0, 0, validation_failures

    existing = _find_transcript_document(db, call_id)

    if existing is None:
        doc_id = _insert_transcript_document(
            db, record, classification, doc_metadata, is_active=retrievable
        )
    else:
        doc_id = existing["id"]
        _sync_document_metadata(db, doc_id, existing, doc_metadata)
        # Sync is_active with the asymmetric retrievability result.
        # `retrievable` already respects the no-auto-promote rule,
        # so it's safe to pass through directly.
        if existing.get("is_active", True) != retrievable:
            db.table("documents").update(
                {"is_active": retrievable}
            ).eq("id", doc_id).execute()

    existing_chunk_count = _count_chunks(db, doc_id)
    if existing_chunk_count > 0:
        return doc_id, 0, existing_chunk_count, validation_failures

    # Produce and insert chunks.
    chunks = chunk_transcript(record.utterances)
    if not chunks:
        return doc_id, 0, 0, validation_failures

    written = _insert_chunks(
        db, doc_id, chunks, embed_fn, validation_failures
    )
    return doc_id, written, 0, validation_failures


def _build_document_metadata(
    record: FathomCallRecord,
    classification: ClassificationResult,
    call_id: str,
) -> dict[str, Any]:
    """Build the `documents.metadata` jsonb per conventions §2.

    `call_id` is the `calls.id` UUID (per the conventions doc: "Links
    back to calls.id"). Required keys per the validator: client_id,
    call_id, call_category, started_at.
    """
    return {
        "client_id": classification.primary_client_id,
        "call_id": call_id,
        "call_category": classification.call_category,
        "call_type": classification.call_type,
        "started_at": record.started_at.isoformat(),
        "duration_seconds": record.duration_seconds,
        "participant_emails": [pt.email for pt in record.participants],
        "speaker_list": _unique_speakers(record),
        "source_url": record.recording_url,
        "classification_confidence": classification.classification_confidence,
        "classification_method": classification.classification_method,
    }


def _unique_speakers(record: FathomCallRecord) -> list[str]:
    seen: set[str] = set()
    speakers: list[str] = []
    for u in record.utterances:
        if u.speaker and u.speaker not in seen:
            seen.add(u.speaker)
            speakers.append(u.speaker)
    return speakers


def _find_transcript_document(db, call_id: str) -> dict[str, Any] | None:
    """Find the parent transcript_chunk document for a given call, if any."""
    resp = (
        db.table("documents")
        .select("id,is_active,metadata")
        .eq("source", _SOURCE)
        .eq("document_type", _TRANSCRIPT_DOC_TYPE)
        .execute()
    )
    for row in resp.data or []:
        if (row.get("metadata") or {}).get("call_id") == call_id:
            return row
    return None


def _insert_transcript_document(
    db,
    record: FathomCallRecord,
    classification: ClassificationResult,
    metadata: dict[str, Any],
    *,
    is_active: bool,
) -> str:
    """Insert the parent call_transcript_chunk document.

    `is_active` is passed in rather than hard-coded True so a
    medium-confidence client call (auto-created participant, awaiting
    human review) lands with `is_active = false` — its chunks exist in
    the DB for future promotion but don't surface through
    `match_document_chunks` yet.
    """
    payload = {
        "source": _SOURCE,
        "external_id": record.external_id,
        "title": record.title,
        "content": record.transcript,
        "document_type": _TRANSCRIPT_DOC_TYPE,
        "metadata": metadata,
        "is_active": is_active,
    }
    resp = db.table("documents").insert(payload).execute()
    return resp.data[0]["id"]


def _sync_document_metadata(
    db, doc_id: str, existing: dict[str, Any], new_metadata: dict[str, Any]
) -> None:
    """Refresh denormalized fields on an existing document's metadata.

    Per conventions §6: re-classification updates the calls row's
    classification fields; the documents.metadata copy must follow so
    retrieval results reflect the current classification.
    """
    existing_metadata = existing.get("metadata") or {}
    merged = existing_metadata | new_metadata
    if merged == existing_metadata:
        return
    db.table("documents").update({"metadata": merged}).eq("id", doc_id).execute()


def _count_chunks(db, document_id: str) -> int:
    """Count chunks under a given document via PostgREST's `count=exact`.

    Using the count header rather than `len(resp.data)` — the row-data
    path can come back empty even when rows exist (observed on a
    partial-failure recovery run against a populated table) which
    would erroneously push the pipeline into a re-chunk + re-insert
    path and crash on the `(document_id, chunk_index)` unique index.
    """
    resp = (
        db.table("document_chunks")
        .select("id", count="exact")
        .eq("document_id", document_id)
        .execute()
    )
    return resp.count or 0


def _insert_chunks(
    db,
    document_id: str,
    chunks: list[Chunk],
    embed_fn: Callable[[str], list[float]] | None,
    validation_failures: list[str],
) -> int:
    """Validate and insert each chunk with its embedding.

    `embed_fn` is injected so the pipeline stays testable without an
    OpenAI key. The CLI plumbs `shared.kb_query.embed` into it.
    """
    if embed_fn is None:
        raise RuntimeError(
            "embed_fn is required for --apply runs; pass shared.kb_query.embed."
        )

    written = 0
    for chunk in chunks:
        try:
            validate_chunk_metadata(
                chunk.metadata, source=_SOURCE, document_type=_TRANSCRIPT_DOC_TYPE
            )
        except ValueError as exc:
            validation_failures.append(f"chunk index {chunk.chunk_index}: {exc}")
            logger.error(
                "Chunk validation failed for document %s chunk %d: %s",
                document_id, chunk.chunk_index, exc,
            )
            continue

        try:
            embedding = embed_fn(chunk.content)
        except Exception as exc:  # pragma: no cover — network path
            logger.error(
                "Embedding failed for document %s chunk %d: %s",
                document_id, chunk.chunk_index, exc,
            )
            continue

        # Idempotent insert: on conflict (document_id, chunk_index) do
        # nothing. Protects the pipeline from re-run after a partial
        # failure where some chunks landed and _count_chunks might
        # not have caught it before we got here.
        db.table("document_chunks").upsert(
            {
                "document_id": document_id,
                "chunk_index": chunk.chunk_index,
                "content": chunk.content,
                "embedding": embedding,
                "metadata": chunk.metadata,
            },
            on_conflict="document_id,chunk_index",
            ignore_duplicates=True,
        ).execute()
        written += 1
    return written


def _soft_archive_transcript_document_if_exists(db, call_id: str) -> str | None:
    """Flip is_active=false on the parent document for this call, if any.

    Called when a re-classification moves the call out of client —
    keeps stale chunks out of client-mode retrieval via the
    is_active filter in match_document_chunks.
    """
    existing = _find_transcript_document(db, call_id)
    if existing is None:
        return None
    if existing.get("is_active") is False:
        return existing["id"]
    db.table("documents").update({"is_active": False}).eq("id", existing["id"]).execute()
    return existing["id"]


# ---------------------------------------------------------------------------
# call_summary document (webhook-sourced only, V1)
# ---------------------------------------------------------------------------

_SUMMARY_DOC_TYPE = "call_summary"


def _ensure_summary_document(
    db,
    record: FathomCallRecord,
    call_id: str,
    classification: ClassificationResult,
    embed_fn: Callable[[str], list[float]] | None,
    *,
    retrievable: bool,
) -> list[str]:
    """Idempotent upsert of a call_summary document + one chunk.

    V1 writes a single chunk per summary. Fathom's default_summary is
    typically 200–500 words — well under the embedding model's input
    limit. If we later encounter summaries large enough to warrant
    splitting, add a paragraph-aware chunker; the contract here
    (document per call, chunks[] under it) already supports N chunks.

    Idempotency: keyed on (source='fathom', external_id=<recording_id>,
    document_type='call_summary') via the migration-0011 unique.
    Re-runs find the existing doc, sync metadata + is_active, reuse the
    existing chunk (skip re-embed — saves cost on backfill sweeps).

    Returns the list of validation failure strings (empty on success).
    """
    validation_failures: list[str] = []
    summary_text = (record.summary_text or "").strip()
    if not summary_text:
        return validation_failures

    # Reuse the same metadata shape as transcript_chunk — validator spec
    # allows it. call_id / client_id / call_category / started_at are all
    # required; retrieval downstream joins doc + chunk metadata so every
    # call_summary chunk inherits this context.
    doc_metadata = _build_document_metadata(record, classification, call_id)

    try:
        validate_document_metadata(
            doc_metadata, source=_SOURCE, document_type=_SUMMARY_DOC_TYPE
        )
    except ValueError as exc:
        validation_failures.append(f"summary document: {exc}")
        logger.error(
            "Summary document validation failed for call %s: %s", call_id, exc
        )
        return validation_failures

    existing = _find_summary_document(db, record.external_id)
    if existing is None:
        doc_id = _insert_summary_document(
            db, record, summary_text, doc_metadata, is_active=retrievable
        )
    else:
        doc_id = existing["id"]
        _sync_document_metadata(db, doc_id, existing, doc_metadata)
        _sync_summary_content(db, doc_id, existing, summary_text)
        if existing.get("is_active", True) != retrievable:
            db.table("documents").update(
                {"is_active": retrievable}
            ).eq("id", doc_id).execute()

    if _count_chunks(db, doc_id) > 0:
        return validation_failures

    # Single-chunk write. Chunk metadata is intentionally empty — the
    # validator spec for (fathom, call_summary) chunks is unpinned (see
    # shared/ingestion/validate.py), which means empty metadata passes
    # silently. Doc-level metadata carries all retrieval context; no need
    # to duplicate it at the chunk level.
    if embed_fn is None:
        raise RuntimeError(
            "embed_fn is required for summary ingest; pass shared.kb_query.embed."
        )
    try:
        embedding = embed_fn(summary_text)
    except Exception as exc:  # pragma: no cover — network path
        logger.error("Summary embedding failed for document %s: %s", doc_id, exc)
        return validation_failures

    db.table("document_chunks").upsert(
        {
            "document_id": doc_id,
            "chunk_index": 0,
            "content": summary_text,
            "embedding": embedding,
            "metadata": {},
        },
        on_conflict="document_id,chunk_index",
        ignore_duplicates=True,
    ).execute()
    return validation_failures


def _find_summary_document(db, external_id: str) -> dict[str, Any] | None:
    """Find the call_summary doc for a given recording_id.

    Keyed on `(source, external_id, document_type)` — the widened unique
    from migration 0011. Direct lookup, O(1), unlike the transcript_chunk
    finder which filters metadata in Python for historical reasons.
    """
    resp = (
        db.table("documents")
        .select("id,is_active,metadata,content")
        .eq("source", _SOURCE)
        .eq("external_id", external_id)
        .eq("document_type", _SUMMARY_DOC_TYPE)
        .limit(1)
        .execute()
    )
    rows = resp.data or []
    return rows[0] if rows else None


def _insert_summary_document(
    db,
    record: FathomCallRecord,
    summary_text: str,
    metadata: dict[str, Any],
    *,
    is_active: bool,
) -> str:
    payload = {
        "source": _SOURCE,
        "external_id": record.external_id,
        "title": record.title,
        "content": summary_text,
        "document_type": _SUMMARY_DOC_TYPE,
        "metadata": metadata,
        "is_active": is_active,
    }
    resp = db.table("documents").insert(payload).execute()
    return resp.data[0]["id"]


def _sync_summary_content(
    db, doc_id: str, existing: dict[str, Any], new_content: str
) -> None:
    """Keep documents.content in sync if Fathom regenerated the summary.

    When Fathom fires `new-meeting-content-ready` twice for the same call
    (docs don't confirm this happens but the F2.2 live-test is open on
    it), the second delivery may carry an updated summary. Refresh the
    text; do NOT re-embed (chunk reused) — the chunk's content column
    stays at the old text but its embedding is still semantically close
    to the new summary. If embedding staleness bites in retrieval, the
    cheap fix is to delete the chunk row so the next re-run re-embeds.
    """
    if existing.get("content") == new_content:
        return
    db.table("documents").update({"content": new_content}).eq("id", doc_id).execute()


# ---------------------------------------------------------------------------
# call_review (auto-review on Fathom webhook ingest)
# ---------------------------------------------------------------------------


_REVIEW_DOC_TYPE = "call_review"


def _ensure_call_review_document(
    db,
    record: FathomCallRecord,
    call_id: str,
    classification: ClassificationResult,
) -> str | None:
    """Generate and persist a call_review document via the call_reviewer
    agent. Mirrors the shape of _ensure_summary_document but without
    embeddings, chunks, or retrievability flags — review docs are
    display-only and persistence.py writes is_active=False.

    Three guards before the LLM call (cheapest-first):

      1. Category guard — only client calls have a primary_client_id;
         the review's metadata.client_id requires it. Caller already
         scopes by category, but defense-in-depth.
      2. Primary-client guard — same. ai_call_signal asserts this too;
         re-asserted here so the failure mode is clear if the
         classifier ever changes.
      3. Existence guard — if a call_review document already exists
         for this external_id, SKIP the LLM call entirely. Saves the
         ~$0.07 Sonnet cost on Fathom retries / dup deliveries / the
         documented F2.2 case where Fathom may re-fire
         new-meeting-content-ready twice. The first review wins; if
         operators want regeneration they delete the row + re-fire.

    Returns the documents.id of the review row (existing or newly
    written), or None when the function short-circuited at a guard.

    Raises on LLM error / parse error — caller wraps in try/except per
    the existing CS Slack post hook idiom.
    """
    if classification.call_category != "client":
        return None
    if classification.primary_client_id is None:
        logger.info(
            "call_review skipped for call %s: no primary_client_id (category=%s)",
            call_id,
            classification.call_category,
        )
        return None

    # Existence guard. Direct (source, external_id, document_type) lookup
    # against the migration-0011 unique. Cheap; no LLM cost on hit.
    existing = (
        db.table("documents")
        .select("id")
        .eq("source", _SOURCE)
        .eq("external_id", record.external_id)
        .eq("document_type", _REVIEW_DOC_TYPE)
        .limit(1)
        .execute()
    )
    if existing.data:
        logger.info(
            "call_review already exists for external_id=%s; skipping regen",
            record.external_id,
        )
        return existing.data[0]["id"]

    # Late imports keep agents.* off the cold-start critical path for
    # non-client ingests + match the cs_call_summary_post pattern below.
    from agents.call_reviewer.persistence import upsert_call_review
    from agents.call_reviewer.reviewer import review_call

    review = review_call(db, call_id, trigger_type="fathom_pipeline")
    started_at_iso = (
        record.started_at.isoformat()
        if hasattr(record.started_at, "isoformat")
        else str(record.started_at)
    )
    return upsert_call_review(
        db,
        call_id,
        review,
        call_external_id=record.external_id,
        primary_client_id=classification.primary_client_id,
        call_category=classification.call_category,
        started_at=started_at_iso,
        model="claude-sonnet-4-6",
        title=record.title,
    )


# ---------------------------------------------------------------------------
# call_action_items (webhook-sourced only, V1)
# ---------------------------------------------------------------------------


def _upsert_action_items(
    db,
    call_id: str,
    items,
    client_resolver: ClientResolver,
    team_resolver: TeamMemberResolver,
) -> int:
    """Delete-and-replace action items for this call.

    Fathom doesn't provide a stable per-item id, so a clean replace is
    the simplest idempotent pattern. On re-ingest of a call whose action
    items changed (item added / removed / marked complete), the final
    state matches whatever the most recent delivery carried.

    Returns the number of rows inserted. When `items` is empty (Fathom
    delivered an empty list for this call), deletes existing and writes
    nothing — the contract the pipeline caller relies on.
    """
    db.table("call_action_items").delete().eq("call_id", call_id).execute()
    if not items:
        return 0

    now_iso = datetime.now(timezone.utc).isoformat()
    rows: list[dict[str, Any]] = []
    for item in items:
        owner_type, owner_client_id, owner_team_member_id = _resolve_action_item_owner(
            item, client_resolver, team_resolver
        )
        rows.append({
            "call_id": call_id,
            "owner_type": owner_type,
            "owner_client_id": owner_client_id,
            "owner_team_member_id": owner_team_member_id,
            "description": item.description,
            "status": "done" if item.completed else "open",
            "completed_at": now_iso if item.completed else None,
        })
    if rows:
        db.table("call_action_items").insert(rows).execute()
    return len(rows)


def _resolve_action_item_owner(
    item,
    client_resolver: ClientResolver,
    team_resolver: TeamMemberResolver,
) -> tuple[str, str | None, str | None]:
    """Map Fathom's assignee to our owner_type + FK.

    Team-member match takes precedence over client match — a team member
    owning an action item is a stronger signal than a client owning one,
    and the schema's CHECK on owner_type (`client`/`team_member`/`unknown`)
    is exclusive. When the email is missing entirely, owner_type lands
    as `unknown` with both FKs null.
    """
    email = (item.assignee_email or "").lower()
    if not email:
        return "unknown", None, None
    team_id = team_resolver.lookup(email)
    if team_id:
        return "team_member", None, team_id
    client_id = client_resolver.lookup(email)
    if client_id:
        return "client", client_id, None
    return "unknown", None, None


# ---------------------------------------------------------------------------
# Dry-run outcome
# ---------------------------------------------------------------------------


def _dry_run_outcome(
    record: FathomCallRecord,
    classification: ClassificationResult,
    client_resolver: ClientResolver,
    auto_created_email: str | None,
) -> IngestOutcome:
    """Build an IngestOutcome for a dry-run — no DB writes performed."""
    linked_clients = sum(
        1 for pt in record.participants if client_resolver.lookup(pt.email) is not None
    )
    return IngestOutcome(
        external_id=record.external_id,
        call_id=None,
        category=classification.call_category,
        call_type=classification.call_type,
        confidence=classification.classification_confidence,
        method=classification.classification_method,
        primary_client_id=classification.primary_client_id,
        primary_client_name=None,
        auto_created_client_id=None,
        auto_created_client_email=(
            classification.should_auto_create_client.email
            if classification.should_auto_create_client
            else None
        ),
        participants_linked_to_clients=linked_clients,
        participants_linked_to_team=0,
        document_id=None,
        chunks_written=0,
        chunks_reused=0,
        retrievable=classification.should_be_retrievable,
        retrievable_before=None,
        action="dry-run",
    )


# ---------------------------------------------------------------------------
# Embedding cost estimate
# ---------------------------------------------------------------------------


def estimate_embedding_cost_usd(chunks_written: int) -> float:
    """Rough estimate: `chunks_written × ~500 tokens × $0.02/1M`."""
    tokens = chunks_written * _EMBEDDING_TOKENS_PER_CHUNK_ESTIMATE
    return tokens * _EMBEDDING_COST_USD_PER_MILLION_TOKENS / 1_000_000
