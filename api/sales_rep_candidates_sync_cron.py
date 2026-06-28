"""Sales-rep candidates sync cron — mirror Airtable "Sales Team Member" rows.

Feeds the admin verify page (/sales-dashboard/reps). The Airtable "Sales Team
Member" table (base appCWa6TV6p7EBarC, tbl tblpSaR3Iq4vBBbpO) is where a new
sales rep first appears. This cron mirrors each record into `sales_rep_candidates`
so the dashboard (which only reads Supabase) can surface new reps awaiting
verification. Each record's id is a `team_members.airtable_user_id`.

Forward-only: we only mirror records created on/after VERIFY_CUTOFF — the
company has many historical reps in Airtable that never need verifying. The
cutoff is enforced both here (Airtable `IS_AFTER(CREATED_TIME(), ...)`) and on
the read side (lib/db/sales-rep-verify.ts) so the two stay aligned.

Per-tick behavior:
  1. Auth: validate `Authorization: Bearer ${CRON_SECRET}`.
  2. Build `AirtableClient` from env (AIRTABLE_SALES_PAT).
  3. Iterate the table (created-after-cutoff) and upsert each parsed row.
  4. Write a summary audit row to `webhook_deliveries` (source=sales_rep_candidates_sync).

Manual trigger:
  curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \\
       https://ai-enablement-sigma.vercel.app/api/sales_rep_candidates_sync_cron
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import sys
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from shared.db import get_client  # noqa: E402
from ingestion.airtable import SALES_TEAM_MEMBER_TABLE_ID  # noqa: E402
from ingestion.airtable.client import AirtableClient  # noqa: E402
from ingestion.airtable.parser import parse_sales_team_member  # noqa: E402

logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.sales_rep_candidates_sync_cron")
logger.setLevel(logging.INFO)

_AUDIT_SOURCE = "sales_rep_candidates_sync"

# Forward-only cutoff — keep in lockstep with SALES_REP_VERIFY_CUTOFF in
# lib/db/sales-rep-verify.ts. Reps created in Airtable before this never surface.
VERIFY_CUTOFF = "2026-06-27T00:00:00.000Z"


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        try:
            self._handle()
        except Exception as exc:
            logger.exception(
                "sales_rep_candidates_sync_cron: unhandled top-level error: %s", exc
            )
            self._respond(500, {"error": "internal_error"})

    def do_GET(self) -> None:
        self.do_POST()

    def _handle(self) -> None:
        if not _verify_auth(self.headers):
            self._respond(401, {"error": "unauthorized"})
            return
        result = run_sales_rep_candidates_sync_cron()
        self._respond(200, result)

    def _respond(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)


def run_sales_rep_candidates_sync_cron() -> dict[str, Any]:
    """One cron tick. Returns the audit-payload dict."""
    db = get_client()

    try:
        client = AirtableClient.from_env()
    except RuntimeError as exc:
        _insert_audit(
            db,
            status="failed",
            payload={"error": "airtable_pat_unavailable", "detail": str(exc)},
            error=f"airtable_pat_unavailable: {exc}",
        )
        logger.warning("sales_rep_candidates_sync_cron: %s", exc)
        return {"error": "airtable_pat_unavailable", "detail": str(exc)}

    seen = 0
    upserted = 0
    errors: list[str] = []

    formula = f"IS_AFTER(CREATED_TIME(), DATETIME_PARSE('{VERIFY_CUTOFF}'))"

    try:
        for record in client.iter_records(
            SALES_TEAM_MEMBER_TABLE_ID, filter_by_formula=formula
        ):
            seen += 1
            row = parse_sales_team_member(record)
            if not row:
                continue
            row["synced_at"] = datetime.now(timezone.utc).isoformat()
            try:
                db.table("sales_rep_candidates").upsert(
                    row, on_conflict="airtable_record_id"
                ).execute()
                upserted += 1
            except Exception as exc:
                errors.append(f"upsert_failed:{row.get('airtable_record_id')}:{exc}")
    except Exception as exc:
        errors.append(f"iter_failed:{exc}")
        logger.exception("sales_rep_candidates_sync_cron: iter failed: %s", exc)

    audit_payload: dict[str, Any] = {
        "records_seen": seen,
        "candidates_upserted": upserted,
        "cutoff": VERIFY_CUTOFF,
        "errors": errors,
    }
    _insert_audit(
        db,
        status="processed",
        payload=audit_payload,
        error="; ".join(errors)[:2000] if errors else None,
    )

    logger.info(
        "sales_rep_candidates_sync_cron: seen=%d upserted=%d errors=%d",
        seen,
        upserted,
        len(errors),
    )
    return audit_payload


def _insert_audit(
    db,
    *,
    status: str,
    payload: dict[str, Any],
    error: str | None,
) -> None:
    delivery_id = f"{_AUDIT_SOURCE}_{uuid.uuid4()}"
    row: dict[str, Any] = {
        "webhook_id": delivery_id,
        "source": _AUDIT_SOURCE,
        "processing_status": status,
        "payload": payload,
        "headers": {},
        "received_at": datetime.now(timezone.utc).isoformat(),
    }
    if error:
        row["error_message"] = error
    try:
        db.table("webhook_deliveries").insert(row).execute()
    except Exception as exc:
        logger.warning("sales_rep_candidates_sync_cron: audit insert failed: %s", exc)


def _verify_auth(headers: Any) -> bool:
    expected = os.environ.get("CRON_SECRET") or ""
    if not expected:
        logger.error("sales_rep_candidates_sync_cron: CRON_SECRET not configured")
        return False
    auth_header = headers.get("Authorization") or headers.get("authorization") or ""
    if not auth_header.startswith("Bearer "):
        return False
    presented = auth_header[len("Bearer ") :]
    return hmac.compare_digest(presented, expected)
