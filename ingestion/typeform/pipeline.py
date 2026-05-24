"""Typeform ingestion orchestrator — backfill + incremental + live webhook.

Idempotent upserts keyed on Typeform's stable IDs (`form_id` for forms,
`response_id` for responses). Re-running never duplicates rows.

Three entry-point families, same underlying upsert path:

  - **Form definitions** — `sync_form_definition()` / `sync_all_form_definitions()`
    Pull `GET /forms/{id}` for one form or every form; upsert into
    `typeform_forms`. Cheap (~31 rows in this account).

  - **Responses (backfill / incremental)** — `sync_responses(form_id, since=...)`
    / `sync_all_responses(since=...)`. Cursor-paginates the Responses API
    (using the client's `iter_responses` which omits the buggy `sort`
    param). Upserts into `typeform_responses`. Used by:
      - `scripts/backfill_typeform.py` (full history, `since=None`)
      - `api/typeform_sync_cron.py` (last-N-hours safety window)

  - **Responses (live webhook)** — `upsert_response_from_webhook(payload)`.
    Same parser, same upsert. The webhook envelope's `form_response`
    object IS the same shape as a Responses API item, so the path
    converges. Lazy-syncs the form definition if it isn't mirrored yet.

Pattern mirrors `ingestion/close/pipeline.py`. No KB writes — Typeform
data isn't embedded for retrieval; lead-stream mirror tables only.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from ingestion.typeform.client import TypeformAPIError, TypeformClient
from ingestion.typeform.parser import parse_form_definition, parse_response
from shared.logging import logger


@dataclass
class SyncOutcome:
    """Summary of one sync run for reporting."""

    forms_synced: int = 0
    forms_failed: int = 0
    responses_synced: int = 0
    responses_failed: int = 0
    forms_walked: int = 0
    errors: list[str] = field(default_factory=list)

    def record_error(self, where: str, err: Exception | str) -> None:
        self.errors.append(f"{where}: {err}")


# ---------------------------------------------------------------------------
# Form definitions
# ---------------------------------------------------------------------------


def sync_form_definition(
    client: TypeformClient,
    db,
    form_id: str,
    outcome: SyncOutcome | None = None,
) -> SyncOutcome:
    """Pull one form definition + upsert into typeform_forms.

    Idempotent. Used by the webhook receiver's lazy-sync path and by
    the cron / backfill orchestrators.
    """
    outcome = outcome or SyncOutcome()
    try:
        raw = client.get_form(form_id)
    except TypeformAPIError as e:
        outcome.record_error(f"get_form:{form_id}", e)
        outcome.forms_failed += 1
        return outcome

    row = parse_form_definition(raw)
    if not row.get("form_id"):
        outcome.record_error(
            f"parse_form_definition:{form_id}",
            ValueError("missing form_id"),
        )
        outcome.forms_failed += 1
        return outcome

    row["definition_synced_at"] = datetime.now(timezone.utc).isoformat()
    try:
        db.table("typeform_forms").upsert(row, on_conflict="form_id").execute()
        outcome.forms_synced += 1
    except Exception as e:
        outcome.record_error(f"upsert_form:{form_id}", e)
        outcome.forms_failed += 1
    return outcome


def sync_all_form_definitions(
    client: TypeformClient,
    db,
    outcome: SyncOutcome | None = None,
) -> SyncOutcome:
    """Pull every form's definition. Cheap — list_forms paginates."""
    outcome = outcome or SyncOutcome()
    try:
        forms = list(client.list_forms())
    except TypeformAPIError as e:
        outcome.record_error("list_forms", e)
        return outcome

    for form in forms:
        form_id = form.get("id")
        if not form_id:
            continue
        sync_form_definition(client, db, form_id, outcome)
    return outcome


# ---------------------------------------------------------------------------
# Responses — backfill / incremental
# ---------------------------------------------------------------------------


def sync_responses(
    client: TypeformClient,
    db,
    form_id: str,
    *,
    since: str | None = None,
    limit: int | None = None,
    outcome: SyncOutcome | None = None,
) -> SyncOutcome:
    """Pull responses for one form, upsert each.

    `since` filters to submissions at-or-after the ISO-8601 timestamp
    (used by incremental sync; `None` walks full history).
    `limit` caps the total responses processed (used by --smoke runs).

    Per-record fail-soft: one bad row doesn't abort the form.
    """
    outcome = outcome or SyncOutcome()
    outcome.forms_walked += 1

    processed = 0
    try:
        for raw in client.iter_responses(form_id, since=since):
            if limit is not None and processed >= limit:
                break
            processed += 1
            row = parse_response(raw, form_id=form_id)
            if not row.get("response_id"):
                outcome.record_error(
                    f"parse_response:{form_id}:idx={processed}",
                    ValueError("missing response_id / token"),
                )
                outcome.responses_failed += 1
                continue
            try:
                db.table("typeform_responses").upsert(
                    row, on_conflict="response_id"
                ).execute()
                outcome.responses_synced += 1
            except Exception as e:
                outcome.record_error(
                    f"upsert_response:{form_id}:{row['response_id']}", e
                )
                outcome.responses_failed += 1
    except TypeformAPIError as e:
        # Page-level failure mid-walk. Surface; the cron backstop will
        # re-attempt on the next tick.
        outcome.record_error(f"iter_responses:{form_id}", e)
    return outcome


def sync_all_responses(
    client: TypeformClient,
    db,
    *,
    since: str | None = None,
    limit_per_form: int | None = None,
    outcome: SyncOutcome | None = None,
) -> SyncOutcome:
    """Walk every form's responses. Used by both the full backfill and
    the cron backstop (with a `since` window in the latter)."""
    outcome = outcome or SyncOutcome()
    try:
        forms = list(client.list_forms())
    except TypeformAPIError as e:
        outcome.record_error("list_forms", e)
        return outcome

    for form in forms:
        form_id = form.get("id")
        if not form_id:
            continue
        sync_responses(
            client,
            db,
            form_id,
            since=since,
            limit=limit_per_form,
            outcome=outcome,
        )
    return outcome


# ---------------------------------------------------------------------------
# Responses — live webhook
# ---------------------------------------------------------------------------


def upsert_response_from_webhook(
    db,
    payload: dict[str, Any],
    *,
    client: TypeformClient | None = None,
) -> str | None:
    """Receiver entry point. `payload` is the Typeform `form_response`
    object (the value of the webhook envelope's `form_response` key).

    Same parser the backfill uses. Same upsert path. Idempotent on
    response_id — webhook → cron-backstop → backfill all converge.

    If the form definition isn't yet mirrored and a `client` is passed,
    lazy-sync the definition so the FK has a target row (loose FK so
    this is best-effort, not strictly required).

    Returns the response_id on success, None on bad payload.
    """
    row = parse_response(payload)
    response_id = row.get("response_id")
    form_id = row.get("form_id")
    if not response_id:
        logger.warning(
            "typeform.webhook.missing_response_id form_id=%s", form_id,
        )
        return None
    if not form_id:
        logger.warning(
            "typeform.webhook.missing_form_id response_id=%s", response_id,
        )
        # We can still upsert with empty form_id (FK is loose) — but
        # log loudly because this means the envelope shape changed.
        return None

    db.table("typeform_responses").upsert(
        row, on_conflict="response_id",
    ).execute()

    # Lazy-sync the form definition if not present and the caller gave
    # us a client. Best-effort — don't fail the receiver if the form
    # sync errors; the cron backstop will heal it.
    if client is not None:
        try:
            existing = (
                db.table("typeform_forms")
                .select("form_id")
                .eq("form_id", form_id)
                .limit(1)
                .execute()
            )
            if not existing.data:
                sync_form_definition(client, db, form_id)
        except Exception as e:
            logger.warning(
                "typeform.webhook.lazy_form_sync_failed form_id=%s err=%s",
                form_id, e,
            )

    # Future seam: a notify hook lands here. Intentionally a no-op
    # stub — adding the Slack-ping-on-new-opt-in is a follow-up spec,
    # not this one. See spec § Future seam.
    _notify_new_response(row)

    return response_id


def _notify_new_response(response_row: dict[str, Any]) -> None:
    """No-op notify seam. A future spec wires this to Slack / email,
    gated on a TYPEFORM_NOTIFY_* env flag. Leaving the call site present
    so the future spec is a function-body change, not a refactor."""
    return None
