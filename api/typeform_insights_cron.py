"""Typeform Insights snapshot cron — append-only lifetime totals into
typeform_form_insights_snapshots.

Vercel Cron tick every 15 minutes (offset by 7 from the top of the
hour to spread load against the parallel `typeform_sync_cron`).
Calls Typeform's `/insights/{form_id}/summary` endpoint (which
returns LIFETIME totals only — no date filtering supported, verified
during discovery) and inserts one snapshot row per configured form.
Daily starts are derived downstream by taking the delta between
bracketing snapshots.

Per-tick behavior:
  1. Auth: validate `Authorization: Bearer ${CRON_SECRET}`.
  2. For each form_id in FORM_IDS, pull /insights/{form_id}/summary.
  3. Insert one row into typeform_form_insights_snapshots.
  4. Audit row to webhook_deliveries with `source='typeform_insights'`.

Discovery: docs/reports/funnel-lp-typeform.md § "Typeform's API is lifetime-only".
Migration: supabase/migrations/0051_typeform_form_insights_snapshots.sql.

Env vars required (set in Vercel):
  CRON_SECRET                 — shared Bearer auth across all crons
  TYPEFORM_API_KEY            — Typeform Personal Access Token
                                (gate (d); Drake adds to Vercel env)
  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — shared.db

Manual trigger:
  curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \\
       https://ai-enablement-sigma.vercel.app/api/typeform_insights_cron
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import sys
import urllib.request
import urllib.error
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from shared.db import get_client  # noqa: E402

logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.typeform_insights_cron")
logger.setLevel(logging.INFO)

_AUDIT_SOURCE = "typeform_insights"

# Forms to snapshot — one per high-ticket landing page, so each LP's "starts"
# (and completion rate) populate. Keep in sync with funnel-assets.ts
# HIGH_TICKET_TYPEFORM_FORM_IDS + lead_tagging.py OPT_IN_FORMS.
#   SFedWelr  — Main LP
#   Os4c0q6V  — Training LP (/training)
# Adding a form here makes its snapshots flow automatically.
FORM_IDS: list[str] = ["SFedWelr", "Os4c0q6V"]

_INSIGHTS_URL = "https://api.typeform.com/insights/{form_id}/summary"
_REQUEST_TIMEOUT_SECONDS = 20


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        try:
            self._handle()
        except Exception as exc:
            logger.exception(
                "typeform_insights_cron: unhandled top-level error: %s", exc
            )
            self._respond(500, {"error": "internal_error"})

    def do_GET(self) -> None:
        self.do_POST()

    def _handle(self) -> None:
        if not _verify_auth(self.headers):
            self._respond(401, {"error": "unauthorized"})
            return
        result = run_typeform_insights_cron()
        self._respond(200, result)

    def _respond(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)


def run_typeform_insights_cron() -> dict[str, Any]:
    """Entry point for one cron tick. Returns the audit payload."""
    db = get_client()
    api_key = os.environ.get("TYPEFORM_API_KEY", "")
    if not api_key:
        _insert_audit(
            db,
            status="failed",
            payload={"error": "typeform_token_unavailable"},
            error="TYPEFORM_API_KEY env var missing",
        )
        logger.warning("typeform_insights_cron: TYPEFORM_API_KEY not configured")
        return {"error": "typeform_token_unavailable"}

    snapshots_written = 0
    errors: list[str] = []
    per_form: list[dict[str, Any]] = []

    for form_id in FORM_IDS:
        try:
            payload = _fetch_insights(form_id, api_key)
        except Exception as exc:
            errors.append(f"fetch {form_id}: {exc}")
            per_form.append({"form_id": form_id, "ok": False, "error": str(exc)})
            logger.exception("typeform_insights_cron: fetch failed for %s", form_id)
            continue

        summary = (payload or {}).get("form", {}).get("summary") or {}
        if not summary:
            errors.append(f"parse {form_id}: missing form.summary")
            per_form.append({"form_id": form_id, "ok": False, "error": "missing summary"})
            continue

        row = {
            "form_id": form_id,
            "snapshot_at": datetime.now(timezone.utc).isoformat(),
            "total_visits": summary.get("total_visits"),
            "unique_visits": summary.get("unique_visits"),
            "responses_count": summary.get("responses_count"),
            "completion_rate": summary.get("completion_rate"),
            "average_time_seconds": summary.get("average_time"),
            "raw": payload,
        }
        try:
            db.table("typeform_form_insights_snapshots").insert(row).execute()
            snapshots_written += 1
            per_form.append({
                "form_id": form_id,
                "ok": True,
                "total_visits": row["total_visits"],
                "responses_count": row["responses_count"],
            })
        except Exception as exc:
            errors.append(f"insert {form_id}: {exc}")
            per_form.append({"form_id": form_id, "ok": False, "error": str(exc)})
            logger.exception(
                "typeform_insights_cron: insert failed for %s", form_id
            )

    audit_payload: dict[str, Any] = {
        "forms_count": len(FORM_IDS),
        "snapshots_written": snapshots_written,
        "per_form": per_form,
        "errors": errors[:50],
        "errors_truncated": len(errors) > 50,
    }
    _insert_audit(
        db,
        status="processed",
        payload=audit_payload,
        error="; ".join(errors)[:2000] if errors else None,
    )
    logger.info(
        "typeform_insights_cron: forms=%d snapshots=%d errors=%d",
        len(FORM_IDS),
        snapshots_written,
        len(errors),
    )
    return audit_payload


def _fetch_insights(form_id: str, api_key: str) -> dict[str, Any]:
    url = _INSIGHTS_URL.format(form_id=form_id)
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
            "User-Agent": "ai-enablement-typeform-insights/1",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=_REQUEST_TIMEOUT_SECONDS) as resp:
            body = resp.read()
    except urllib.error.HTTPError as e:
        body_text = ""
        try:
            body_text = e.read().decode("utf-8", "replace")[:500]
        except Exception:
            pass
        raise RuntimeError(
            f"Typeform Insights HTTP {e.code} on {form_id}: {body_text}"
        ) from e
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"Typeform Insights network error on {form_id}: {e.reason}"
        ) from e
    return json.loads(body.decode("utf-8"))


def _insert_audit(
    db, *, status: str, payload: dict[str, Any], error: str | None,
) -> None:
    """Mirrors api/wistia_sync_cron.py:_insert_audit."""
    delivery_id = f"{_AUDIT_SOURCE}_{uuid.uuid4()}"
    row: dict[str, Any] = {
        "webhook_id": delivery_id,
        "source": _AUDIT_SOURCE,
        "processing_status": status,
        "payload": payload,
        "headers": {},
        "processed_at": datetime.now(timezone.utc).isoformat(),
    }
    if error is not None:
        row["processing_error"] = error[:2000]
    try:
        db.table("webhook_deliveries").insert(row).execute()
    except Exception as exc:
        logger.warning("typeform_insights_cron: audit insert failed: %s", exc)


def _verify_auth(headers: Any) -> bool:
    expected = os.environ.get("CRON_SECRET") or ""
    if not expected:
        logger.error("typeform_insights_cron: CRON_SECRET not configured")
        return False
    auth_header = (
        headers.get("Authorization") or headers.get("authorization") or ""
    )
    if not auth_header.startswith("Bearer "):
        return False
    presented = auth_header[len("Bearer "):]
    return hmac.compare_digest(presented, expected)
