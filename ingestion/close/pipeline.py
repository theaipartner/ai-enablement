"""Close ingestion orchestrator — backfill + incremental + live webhook.

One function per object type: idempotent upsert keyed on Close's
stable IDs. Re-running never duplicates rows. Fail-soft per record —
one bad lead doesn't kill the run.

Pattern mirrors `ingestion/fathom/pipeline.py`. No write to KB (Close
data isn't indexed for retrieval today — it lives in mirror tables for
the Gregory aggregation layer to query).

Backfill / incremental entry points (used by `scripts/backfill_close.py`):
  - `sync_custom_field_definitions(client, db)` — cf reference table
  - `sync_lead(client, db, lead_id, cf_id_to_name)` — one lead end-to-end
  - `sync_all_leads(...)` — paginate /lead/ and call sync_lead per row
  - `sync_all_opportunities(...)` — paginate /opportunity/ and upsert

Webhook entry points (used by `api/close_events.py`):
  - `load_lead_cf_id_to_name(db)` — read cf-name map from our mirror
  - `upsert_lead_from_payload(db, lead_json, cf_id_to_name)`
  - `upsert_call_from_payload(db, call_json)`
  - `upsert_sms_from_payload(db, sms_json)`
  - `upsert_opportunity_from_payload(db, opp_json)`
  - `upsert_lead_status_change_from_payload(db, activity_json)`

Webhook helpers operate on payloads (the full object) rather than the
Close API client — Close webhook events include the full new object in
`event.data`, so no refetch round-trip is needed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ingestion.close.client import CloseAPIError, CloseClient
from ingestion.close.parser import (
    parse_call,
    parse_custom_field_definition,
    parse_lead,
    parse_lead_status_change,
    parse_opportunity,
    parse_sms,
    project_cf_columns,
)
from shared.logging import logger

_OBJECT_TYPES_FOR_CF_SCHEMAS = ("lead", "opportunity", "contact")
# 'activity' schema 404s on orgs without Custom Activity Types — AI
# Partner today has none, confirmed in discovery. We try 'activity'
# anyway and swallow the 404, so this list stays canonical when the
# org eventually defines custom activities.
_OBJECT_TYPES_FOR_CF_SCHEMAS_BEST_EFFORT = ("activity",)


@dataclass
class SyncOutcome:
    """Summary of one sync run for reporting."""

    cf_definitions_synced: int = 0
    leads_synced: int = 0
    leads_failed: int = 0
    status_changes_synced: int = 0
    calls_synced: int = 0
    sms_synced: int = 0
    opportunities_synced: int = 0
    errors: list[str] = field(default_factory=list)

    def record_error(self, where: str, err: Exception) -> None:
        self.errors.append(f"{where}: {err}")


# ---------------------------------------------------------------------------
# Custom-field definitions
# ---------------------------------------------------------------------------


def sync_custom_field_definitions(
    client: CloseClient,
    db,
    outcome: SyncOutcome | None = None,
) -> dict[str, str]:
    """Populate `close_custom_field_definitions` for lead+opp+contact (+activity if present).

    Returns the cf_id → name map (lead-scoped) the caller passes into
    `sync_lead` for cf-column projection.
    """
    outcome = outcome or SyncOutcome()
    cf_id_to_name: dict[str, str] = {}

    for obj_type in _OBJECT_TYPES_FOR_CF_SCHEMAS:
        try:
            schema = client.custom_field_schema(obj_type)
        except CloseAPIError as e:
            outcome.record_error(f"cf_schema:{obj_type}", e)
            continue
        for field_def in schema.get("fields", []):
            row = parse_custom_field_definition(field_def, obj_type)
            if not row.get("close_id"):
                continue
            try:
                db.table("close_custom_field_definitions").upsert(
                    row, on_conflict="close_id"
                ).execute()
                outcome.cf_definitions_synced += 1
                if obj_type == "lead":
                    cf_id_to_name[row["close_id"]] = row.get("name") or ""
            except Exception as e:
                outcome.record_error(f"cf_upsert:{row.get('close_id')}", e)

    for obj_type in _OBJECT_TYPES_FOR_CF_SCHEMAS_BEST_EFFORT:
        try:
            schema = client.custom_field_schema(obj_type)
        except CloseAPIError as e:
            # 404 expected when org has no Custom Activity Types.
            if "404" in str(e):
                logger.info(
                    "close.cf_schema_skipped object_type=%s reason=no_custom_activity_types",
                    obj_type,
                )
                continue
            outcome.record_error(f"cf_schema:{obj_type}", e)
            continue
        for field_def in schema.get("fields", []):
            row = parse_custom_field_definition(field_def, obj_type)
            if not row.get("close_id"):
                continue
            try:
                db.table("close_custom_field_definitions").upsert(
                    row, on_conflict="close_id"
                ).execute()
                outcome.cf_definitions_synced += 1
            except Exception as e:
                outcome.record_error(f"cf_upsert:{row.get('close_id')}", e)

    return cf_id_to_name


# ---------------------------------------------------------------------------
# Single-lead end-to-end
# ---------------------------------------------------------------------------


def sync_lead(
    client: CloseClient,
    db,
    lead_id: str,
    cf_id_to_name: dict[str, str],
    outcome: SyncOutcome | None = None,
) -> SyncOutcome:
    """Pull one lead's full data + every activity type we mirror, then upsert all.

    Idempotent: re-running on the same lead is a no-op-equivalent — upserts
    on stable close_ids, no duplicate inserts.
    """
    outcome = outcome or SyncOutcome()

    # 1. Full lead → close_leads
    try:
        lead_json = client.get_lead(lead_id)
    except CloseAPIError as e:
        outcome.record_error(f"get_lead:{lead_id}", e)
        outcome.leads_failed += 1
        return outcome

    row = parse_lead(lead_json)
    project_cf_columns(row, cf_id_to_name)
    if not row.get("close_id"):
        outcome.record_error(f"parse_lead:{lead_id}", ValueError("missing close_id"))
        outcome.leads_failed += 1
        return outcome
    try:
        db.table("close_leads").upsert(row, on_conflict="close_id").execute()
        outcome.leads_synced += 1
    except Exception as e:
        outcome.record_error(f"upsert_lead:{lead_id}", e)
        outcome.leads_failed += 1
        return outcome

    # 2. Activities — pull Call + SMS + LeadStatusChange in one paginated
    # call (cheaper than three separate calls), then dispatch by _type.
    try:
        for activity in client.iter_activities_for_lead(
            lead_id,
            types=["Call", "SMS", "LeadStatusChange"],
        ):
            atype = activity.get("_type")
            if atype == "Call":
                row = parse_call(activity)
                if row.get("close_id") and row.get("lead_id"):
                    db.table("close_calls").upsert(row, on_conflict="close_id").execute()
                    outcome.calls_synced += 1
            elif atype == "SMS":
                row = parse_sms(activity)
                if row.get("close_id") and row.get("lead_id"):
                    db.table("close_sms").upsert(row, on_conflict="close_id").execute()
                    outcome.sms_synced += 1
            elif atype == "LeadStatusChange":
                row = parse_lead_status_change(activity)
                if row.get("close_id") and row.get("lead_id"):
                    db.table("close_lead_status_changes").upsert(
                        row, on_conflict="close_id"
                    ).execute()
                    outcome.status_changes_synced += 1
            # else: ignore (Note, Created, TaskCompleted, Meeting,
            # OpportunityStatusChange — not mirrored in V1)
    except CloseAPIError as e:
        outcome.record_error(f"activities:{lead_id}", e)
    except Exception as e:
        outcome.record_error(f"activity_upsert:{lead_id}", e)

    return outcome


# ---------------------------------------------------------------------------
# Bulk paginators
# ---------------------------------------------------------------------------


def sync_all_leads(
    client: CloseClient,
    db,
    cf_id_to_name: dict[str, str],
    *,
    max_leads: int | None = None,
    progress_callback=None,
) -> SyncOutcome:
    """Walk every lead and call sync_lead for each.

    `max_leads` caps the count (for --limit). `progress_callback(n, lead_id)`
    is invoked after each lead for CLI reporting.
    """
    outcome = SyncOutcome()
    count = 0
    for lead_summary in client.iter_leads(page_size=100):
        lead_id = lead_summary.get("id")
        if not lead_id:
            continue
        sync_lead(client, db, lead_id, cf_id_to_name, outcome=outcome)
        count += 1
        if progress_callback:
            try:
                progress_callback(count, lead_id)
            except Exception:
                pass
        if max_leads is not None and count >= max_leads:
            break
    return outcome


def sync_all_opportunities(
    client: CloseClient,
    db,
    *,
    max_opps: int | None = None,
    outcome: SyncOutcome | None = None,
) -> SyncOutcome:
    outcome = outcome or SyncOutcome()
    count = 0
    for opp_json in client.iter_opportunities(page_size=100):
        row = parse_opportunity(opp_json)
        if not row.get("close_id"):
            continue
        try:
            db.table("close_opportunities").upsert(
                row, on_conflict="close_id"
            ).execute()
            outcome.opportunities_synced += 1
        except Exception as e:
            outcome.record_error(f"opp_upsert:{row.get('close_id')}", e)
        count += 1
        if max_opps is not None and count >= max_opps:
            break
    return outcome


def sync_recently_updated_leads(
    client: CloseClient,
    db,
    cf_id_to_name: dict[str, str],
    *,
    since_iso: str,
    max_leads: int | None = None,
) -> SyncOutcome:
    """Incremental: pull leads with `date_updated > since_iso`.

    Polling-cron entry point. Retained for ops/backstop use even now that
    `api/close_events.py` carries the live path — useful for catching up
    after a webhook outage / disabled subscription.
    `since_iso` should be slightly before the prior run's high-water mark
    to tolerate clock skew.
    """
    outcome = SyncOutcome()
    count = 0
    query = f'date_updated > "{since_iso}"'
    for lead_summary in client.iter_leads(page_size=100, query=query):
        lead_id = lead_summary.get("id")
        if not lead_id:
            continue
        sync_lead(client, db, lead_id, cf_id_to_name, outcome=outcome)
        count += 1
        if max_leads is not None and count >= max_leads:
            break
    return outcome


# ---------------------------------------------------------------------------
# Webhook entry points — operate on payloads (no API client / no fetch)
# ---------------------------------------------------------------------------
#
# Close webhook events include the FULL new object in `event.data`, so the
# receiver (`api/close_events.py`) can upsert directly without an extra
# round-trip to Close. Helpers below are thin wrappers around the existing
# parse_* functions — same parsing path as the backfill, same idempotency
# contract via `ON CONFLICT (close_id)`.
#
# `load_lead_cf_id_to_name(db)` reads the cf-name map from our own
# `close_custom_field_definitions` mirror table — populated by the backfill
# and refreshed via `scripts/sync_close_cf_definitions.py` whenever a Close
# admin adds/edits a custom field. Webhook lead-projection degrades
# gracefully when an unknown cf appears in a payload: the value still lands
# in `custom_fields_raw` jsonb, only the typed-column projection is skipped.


def load_lead_cf_id_to_name(db) -> dict[str, str]:
    """Build cf_id → name map for lead custom fields from our mirror table.

    Used by webhook lead-upserts to project denormalized typed columns.
    Cheap (~88 rows). Re-run per webhook invocation — Vercel cold-starts
    re-import the module anyway, and the table is small enough that the
    select is negligible.
    """
    resp = (
        db.table("close_custom_field_definitions")
        .select("close_id,name")
        .eq("object_type", "lead")
        .execute()
    )
    return {row["close_id"]: row.get("name") or "" for row in (resp.data or [])}


def upsert_lead_from_payload(
    db,
    lead_json: dict[str, Any],
    cf_id_to_name: dict[str, str],
) -> str | None:
    """Upsert one lead from a webhook `event.data` payload.

    Returns the close_id on success, None if the payload was unusable.
    Raises on DB error so the receiver can mark the delivery `failed`.
    """
    row = parse_lead(lead_json)
    project_cf_columns(row, cf_id_to_name)
    if not row.get("close_id"):
        return None
    db.table("close_leads").upsert(row, on_conflict="close_id").execute()
    return row["close_id"]


def upsert_call_from_payload(db, call_json: dict[str, Any]) -> str | None:
    row = parse_call(call_json)
    if not row.get("close_id") or not row.get("lead_id"):
        return None
    db.table("close_calls").upsert(row, on_conflict="close_id").execute()
    return row["close_id"]


def upsert_sms_from_payload(db, sms_json: dict[str, Any]) -> str | None:
    row = parse_sms(sms_json)
    if not row.get("close_id") or not row.get("lead_id"):
        return None
    db.table("close_sms").upsert(row, on_conflict="close_id").execute()
    return row["close_id"]


def upsert_opportunity_from_payload(db, opp_json: dict[str, Any]) -> str | None:
    """Upsert one opportunity from a webhook payload.

    Drake-override 2026-05-23: opportunities are IN scope for the live
    webhook (mirror everything Close emits per Core Principle #1). The
    `value` field stays a $1 placeholder in this org — see
    docs/schema/close_opportunities.md; never treat as money.
    """
    row = parse_opportunity(opp_json)
    if not row.get("close_id") or not row.get("lead_id"):
        return None
    db.table("close_opportunities").upsert(row, on_conflict="close_id").execute()
    return row["close_id"]


def upsert_lead_status_change_from_payload(
    db,
    activity_json: dict[str, Any],
) -> str | None:
    """Upsert one LeadStatusChange activity from a webhook payload.

    Close webhook event type: `activity.lead_status_change.created`.
    """
    row = parse_lead_status_change(activity_json)
    if not row.get("close_id") or not row.get("lead_id"):
        return None
    db.table("close_lead_status_changes").upsert(
        row, on_conflict="close_id"
    ).execute()
    return row["close_id"]
