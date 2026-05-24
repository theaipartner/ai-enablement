"""Airtable ingestion orchestrator — backfill + cron + webhook paths.

Three entry-point families converge on the same per-record upsert:

  * `sync_table(client, db, table_id, *, since=None)` — pull (paginate)
    + parse + upsert for one Airtable table. Optional `since` ISO-8601
    string builds an `IS_AFTER(CREATED_TIME(), ...)` filterByFormula.
    Used by both backfill (`since` = 24h ago) and cron (`since` =
    ~6h ago).

  * `sync_all(client, db, *, since=None)` — call sync_table for every
    target table in TARGET_TABLES (Setter Triage + Full Closer US + AUS).

  * `upsert_changed_records(client, db, changes)` — webhook path. The
    receiver hands us a dict of `{table_id: set(record_ids)}` extracted
    from the webhook payload; we fetch each record's current state via
    `get_record` and upsert. Same parser, same upsert.

Idempotent throughout: PK is `record_id` (globally unique within the
base across all three sources). `ON CONFLICT (record_id) DO UPDATE`.

Per CLAUDE.md § Operational patterns: the per-record loop is OK here
because Airtable's volume is low (~hundreds/day at peak across all
three tables). If volume grows, batch the upsert like the Clarity
pipeline does.

No notification ping on upsert in this spec — the spec's "Future seam"
defines a `_notify_*` no-op stub at the webhook upsert path; wiring
Slack pings is a follow-up spec.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from ingestion.airtable import TARGET_TABLES
from ingestion.airtable.client import AirtableAPIError, AirtableClient
from ingestion.airtable.parser import (
    parse_full_closer,
    parse_setter_triage,
)

logger = logging.getLogger("ai_enablement.airtable.pipeline")


@dataclass
class SyncOutcome:
    """Summary of one sync run for the audit row + report."""

    tables_walked: int = 0
    records_parsed: int = 0
    records_upserted: int = 0
    records_failed: int = 0
    parse_failures: int = 0
    setter_name_fill_count: int = 0
    full_closer_records_seen: int = 0
    errors: list[str] = field(default_factory=list)

    def record_error(self, where: str, err: Exception | str) -> None:
        self.errors.append(f"{where}: {err}")


def _parse_for_table(
    record: dict[str, Any],
    table_id: str,
    region: str | None,
) -> dict[str, Any] | None:
    """Dispatch to the right per-table parser."""
    if table_id == "tblaoMsiE3FSkHjQt":
        return parse_setter_triage(record)
    if table_id in ("tblYsh3fxTpXuPdIW", "tblcC25y6lMrtgcty"):
        # Region is supplied by caller via TARGET_TABLES — None would
        # be a config bug, not a runtime case.
        assert region is not None, (
            f"Full Closer table {table_id} requires region; got None"
        )
        return parse_full_closer(record, region=region)
    raise ValueError(f"Unknown target table id: {table_id!r}")


def _upsert_one(
    db,
    row: dict[str, Any],
    target_table: str,
    outcome: SyncOutcome,
    where: str,
) -> None:
    """Single-row upsert wrapped in fail-soft error capture.

    Kept for the webhook-payload path where records come in one at a
    time (typically 1-2 per ping). For bulk syncs use _upsert_batch.
    """
    try:
        db.table(target_table).upsert(row, on_conflict="record_id").execute()
        outcome.records_upserted += 1
    except Exception as e:
        outcome.records_failed += 1
        outcome.record_error(where, e)


def _upsert_batch(
    db,
    rows: list[dict[str, Any]],
    target_table: str,
    outcome: SyncOutcome,
    where: str,
) -> None:
    """Batch upsert per Clarity precedent — the supabase-py client over
    httpx HTTP/2 drops streams against the pooler after a small number
    of sequential calls (`ConnectionTerminated, last_stream_id:3`).
    Batching reduces the number of calls (one PostgREST array body per
    table), but it doesn't fully fix the issue when multiple tables
    fire in one script run — the SECOND table's upsert still hits the
    stream-terminated state on the shared client.

    Mitigation: on ConnectionTerminated (or any failure), retry ONCE
    with a fresh supabase client. The lazy import avoids tightening
    the test fakes' dependency surface — tests pass their fake `db`
    and never trigger the retry path.

    On both attempts failing, the whole batch counts as failed (not
    per-row). Acceptable here — Airtable volume is small and the
    cron's overlap window heals on the next tick.
    """
    if not rows:
        return
    try:
        db.table(target_table).upsert(rows, on_conflict="record_id").execute()
        outcome.records_upserted += len(rows)
        return
    except Exception as first_err:
        # First attempt failed. Retry once with a fresh supabase client
        # — sidesteps the stale HTTP/2 stream state on the shared one.
        try:
            from shared.db import get_client  # local import to keep tests' fake db isolated
            fresh = get_client()
            fresh.table(target_table).upsert(rows, on_conflict="record_id").execute()
            outcome.records_upserted += len(rows)
            logger.warning(
                "airtable.upsert_batch_retried_with_fresh_client "
                "target=%s n=%d first_err=%s",
                target_table, len(rows), str(first_err)[:120],
            )
            return
        except Exception as retry_err:
            outcome.records_failed += len(rows)
            outcome.record_error(
                f"{where} (batch of {len(rows)}, retried fresh)",
                f"first={first_err}; retry={retry_err}",
            )


def _count_attribution_signal(
    row: dict[str, Any],
    target_table: str,
    outcome: SyncOutcome,
) -> None:
    """For Full Closer Report rows, increment counters so the
    --smoke run can report the Setter Name fill rate observation that
    Drake wants for the attribution-hypothesis check (spec § discovery
    ambiguities)."""
    if target_table != "airtable_full_closer_report":
        return
    outcome.full_closer_records_seen += 1
    setter_ids = row.get("setter_record_ids")
    if setter_ids:  # non-empty list
        outcome.setter_name_fill_count += 1


def sync_table(
    client: AirtableClient,
    db,
    table_id: str,
    *,
    since: str | None = None,
    limit: int | None = None,
    outcome: SyncOutcome | None = None,
) -> SyncOutcome:
    """Pull every record from `table_id` (optionally filtered to
    records created at-or-after `since`), parse, upsert. Idempotent
    re-run.

    `since` is an ISO-8601 string (e.g. `'2026-05-23T00:00:00.000Z'`).
    Used by both the cron (~6h window) and the backfill (~24h window).
    """
    outcome = outcome or SyncOutcome()
    outcome.tables_walked += 1

    if table_id not in TARGET_TABLES:
        outcome.record_error(
            f"sync_table:{table_id}",
            ValueError(f"not in TARGET_TABLES"),
        )
        return outcome
    _label, region, target_table = TARGET_TABLES[table_id]

    filter_formula: str | None = None
    if since:
        # IS_AFTER(CREATED_TIME(), DATETIME_PARSE('...')) — Airtable
        # formula. CREATED_TIME() returns the record-level metadata
        # regardless of whether a stored createdTime field exists.
        filter_formula = (
            f"IS_AFTER(CREATED_TIME(), DATETIME_PARSE('{since}'))"
        )

    # Collect parsed rows in memory, then batch-upsert at the end.
    # Per Clarity precedent — per-row hits HTTP/2 ConnectionTerminated
    # at low call counts against the pooler.
    parsed_rows: list[dict[str, Any]] = []
    processed = 0
    try:
        for raw in client.iter_records(
            table_id, filter_by_formula=filter_formula,
        ):
            if limit is not None and processed >= limit:
                break
            processed += 1
            row = _parse_for_table(raw, table_id, region)
            if row is None:
                outcome.parse_failures += 1
                outcome.record_error(
                    f"parse:{table_id}:idx={processed}",
                    ValueError("missing record id"),
                )
                continue
            outcome.records_parsed += 1
            _count_attribution_signal(row, target_table, outcome)
            parsed_rows.append(row)
    except AirtableAPIError as e:
        # Mid-walk failure — surface; the cron's next tick re-attempts
        # the window (idempotent). Still try to batch-upsert what we
        # successfully fetched before the error.
        outcome.record_error(f"iter_records:{table_id}", e)

    _upsert_batch(
        db, parsed_rows, target_table, outcome,
        where=f"batch_upsert:{table_id}",
    )
    return outcome


def sync_all(
    client: AirtableClient,
    db,
    *,
    since: str | None = None,
    outcome: SyncOutcome | None = None,
) -> SyncOutcome:
    """Walk all three target sources (Setter Triage + Full Closer US +
    Full Closer AUS). Used by both backfill and cron."""
    outcome = outcome or SyncOutcome()
    for table_id in TARGET_TABLES:
        sync_table(client, db, table_id, since=since, outcome=outcome)
    return outcome


# ---------------------------------------------------------------------------
# Webhook path
# ---------------------------------------------------------------------------


def upsert_changed_records(
    client: AirtableClient,
    db,
    changes: dict[str, set[str]],
    *,
    outcome: SyncOutcome | None = None,
) -> SyncOutcome:
    """Fetch + parse + upsert the changed records the webhook payload
    surfaced.

    `changes` is `{table_id: {record_id, ...}}` extracted from the
    payload's `changedTablesById` / `changedRecordsById`. The receiver
    is responsible for extracting + deduplicating.

    Same parser + upsert as sync_table — the webhook → cron → backfill
    paths converge on `ON CONFLICT (record_id) DO UPDATE`.
    """
    outcome = outcome or SyncOutcome()
    # Collect per-target-table batches; upsert at the end for HTTP/2 safety.
    batches: dict[str, list[dict[str, Any]]] = {}
    rows_to_notify: list[tuple[dict[str, Any], str]] = []

    for table_id, record_ids in changes.items():
        if table_id not in TARGET_TABLES:
            # Skip changes to non-target tables (other 7 tables in the
            # base). Note in audit so an unexpected table fire surfaces.
            outcome.record_error(
                f"webhook:{table_id}",
                ValueError("changed table not in TARGET_TABLES — skipping"),
            )
            continue
        _label, region, target_table = TARGET_TABLES[table_id]
        for rid in record_ids:
            try:
                raw = client.get_record(table_id, rid)
            except AirtableAPIError as e:
                outcome.records_failed += 1
                outcome.record_error(f"get_record:{table_id}:{rid}", e)
                continue
            row = _parse_for_table(raw, table_id, region)
            if row is None:
                outcome.parse_failures += 1
                outcome.record_error(
                    f"parse:{table_id}:{rid}",
                    ValueError("missing record id"),
                )
                continue
            outcome.records_parsed += 1
            _count_attribution_signal(row, target_table, outcome)
            batches.setdefault(target_table, []).append(row)
            rows_to_notify.append((row, target_table))

    # One batch upsert per target table.
    for target_table, rows in batches.items():
        _upsert_batch(
            db, rows, target_table, outcome,
            where=f"webhook_batch_upsert:{target_table}",
        )

    # Notify-seam fan-out (no-op stub today) AFTER successful upserts.
    for row, target_table in rows_to_notify:
        _notify_upserted_record(row, target_table)

    return outcome


def _notify_upserted_record(row: dict[str, Any], target_table: str) -> None:
    """No-op notify seam. A future spec wires this to Slack / email
    (e.g. "ping the team when a new closed deal lands"), gated on a
    notify-enabled env flag. Stub present so the future spec is a
    function-body change, not a refactor. See spec § Future seam."""
    return None
