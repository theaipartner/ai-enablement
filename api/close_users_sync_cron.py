"""Close users sync cron — fill `team_members.close_user_id` from Close /user/.

Vercel Cron tick once per day: paginate Close's `/user/` endpoint and
upsert each user's `id` into the matching `team_members` row by email
(active rows only). Unmatched Close users (someone exists in Close
but hasn't been manually added to team_members) are logged for
manual triage — we deliberately do NOT auto-create team_members rows.

Why daily polling and not webhooks: user-create / user-update events
in Close happen 1-2 times/month at this team's volume. A daily
polling cron is idempotent, simpler to maintain, and recovers from
missed deliveries automatically. Re-evaluate if onboarding cadence
goes up sharply or real-time user attribution becomes load-bearing.

Per-tick behavior:
  1. Auth: validate `Authorization: Bearer ${CRON_SECRET}`.
  2. Build `CloseClient` from env (CLOSE_API_KEY).
  3. Paginate `/user/`; for each user with an `email`:
       - Find active team_members row by email match.
       - If `close_user_id` is null, UPDATE with the Close user `id`.
       - If `close_user_id` is set + matches, skip.
       - If `close_user_id` is set + mismatches, log a WARNING (rare
         drift case — likely a re-paired Close user; surface for
         manual review).
       - If no team_members row matches, append to `unmatched_users`
         in the audit payload.
  4. Write summary audit row to `webhook_deliveries` with
     `source='close_users_sync'`.

Spec: docs/specs/team-members-sales-identity.md (the parent workstream).
Runbook: docs/runbooks/close_ingestion.md (added below).

Env vars (set in Vercel):
  CRON_SECRET                              — shared Bearer auth across all crons
  CLOSE_API_KEY                            — Close personal API key (gate d)
  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — shared.db

Manual trigger:
  curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \\
       https://ai-enablement-sigma.vercel.app/api/close_users_sync_cron
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
from ingestion.close.client import CloseClient  # noqa: E402

logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.close_users_sync_cron")
logger.setLevel(logging.INFO)

_AUDIT_SOURCE = "close_users_sync"


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        try:
            self._handle()
        except Exception as exc:
            logger.exception(
                "close_users_sync_cron: unhandled top-level error: %s", exc
            )
            self._respond(500, {"error": "internal_error"})

    def do_GET(self) -> None:
        self.do_POST()

    def _handle(self) -> None:
        if not _verify_auth(self.headers):
            self._respond(401, {"error": "unauthorized"})
            return
        result = run_close_users_sync_cron()
        self._respond(200, result)

    def _respond(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)


def run_close_users_sync_cron() -> dict[str, Any]:
    """One cron tick. Returns the audit-payload dict."""
    db = get_client()

    try:
        client = CloseClient.from_env()
    except RuntimeError as exc:
        _insert_audit(
            db,
            status="failed",
            payload={"error": "close_api_key_unavailable", "detail": str(exc)},
            error=f"close_api_key_unavailable: {exc}",
        )
        logger.warning("close_users_sync_cron: %s", exc)
        return {"error": "close_api_key_unavailable", "detail": str(exc)}

    seen = 0
    matched = 0
    populated = 0
    already_set = 0
    drift_warnings: list[dict[str, str]] = []
    unmatched_users: list[dict[str, str]] = []
    errors: list[str] = []

    for user in client.iter_users():
        seen += 1
        close_id = user.get("id")
        email = user.get("email")
        if not close_id or not email:
            continue
        try:
            resp = (
                db.table("team_members")
                .select("id, email, full_name, close_user_id, archived_at")
                .eq("email", email)
                .is_("archived_at", "null")
                .execute()
            )
        except Exception as exc:
            errors.append(f"lookup_failed:{email}:{exc}")
            continue
        rows = resp.data or []
        if not rows:
            unmatched_users.append({
                "close_user_id": close_id,
                "email": email,
                "name": " ".join(filter(None, [user.get("first_name"), user.get("last_name")])).strip() or None,
            })
            continue
        row = rows[0]
        matched += 1
        existing = row.get("close_user_id")
        if existing == close_id:
            already_set += 1
            continue
        if existing and existing != close_id:
            drift_warnings.append({
                "team_member_id": row["id"],
                "email": email,
                "existing_close_user_id": existing,
                "close_returned_id": close_id,
            })
            logger.warning(
                "close_users_sync_cron: drift email=%s existing=%s close=%s",
                email, existing, close_id,
            )
            continue
        # close_user_id is null — populate it
        try:
            db.table("team_members").update({"close_user_id": close_id}).eq("id", row["id"]).execute()
            populated += 1
            logger.info(
                "close_users_sync_cron: populated email=%s close_user_id=%s",
                email, close_id,
            )
        except Exception as exc:
            errors.append(f"update_failed:{email}:{exc}")

    audit_payload: dict[str, Any] = {
        "users_seen": seen,
        "team_members_matched": matched,
        "close_user_id_populated": populated,
        "already_set_skipped": already_set,
        "drift_warnings": drift_warnings,
        "unmatched_close_users": unmatched_users,
        "errors": errors,
    }
    status = "processed"
    _insert_audit(
        db,
        status=status,
        payload=audit_payload,
        error="; ".join(errors)[:2000] if errors else None,
    )

    logger.info(
        "close_users_sync_cron: seen=%d matched=%d populated=%d unmatched=%d drift=%d errors=%d",
        seen, matched, populated, len(unmatched_users), len(drift_warnings), len(errors),
    )
    return audit_payload


def _insert_audit(
    db, *, status: str, payload: dict[str, Any], error: str | None,
) -> None:
    """Per-cron-invocation summary row. Same shape as clarity_sync_cron."""
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
        logger.warning("close_users_sync_cron: audit insert failed: %s", exc)


def _verify_auth(headers: Any) -> bool:
    expected = os.environ.get("CRON_SECRET") or ""
    if not expected:
        logger.error("close_users_sync_cron: CRON_SECRET not configured")
        return False
    auth_header = (
        headers.get("Authorization") or headers.get("authorization") or ""
    )
    if not auth_header.startswith("Bearer "):
        return False
    presented = auth_header[len("Bearer ") :]
    return hmac.compare_digest(presented, expected)
