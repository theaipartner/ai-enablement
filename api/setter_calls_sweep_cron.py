"""Setter-call transcription sweep cron.

Vercel Cron POSTs here every 15 minutes. Walks every eligible Close
call recording (duration >= 90s, since 2026-05-24, has recording_url)
that doesn't yet have a row in `setter_call_transcripts`, and runs
the transcription pipeline against each one.

Why a cron (not a webhook trigger): the Close webhook fires multiple
events per call (created → answered → completed → updated), and the
recording is uploaded to Close's S3 some seconds AFTER the
`activity.call.completed` event. Pinning the transcription off a
specific event would race with the upload. A 15-min sweep is the
simpler invariant: "any eligible call gets a transcript within the
next 15 minutes." The latency is irrelevant for sales review.

Per-run cap: 20 calls. Each Deepgram URL-ingest round trip averages
~2 seconds for a 2-minute call; long calls (15+ min) can take 4-6
seconds. 20 × 6s = 120s, comfortably under Vercel's 300s function
budget. If volume ever exceeds the cap, the next cron picks up the
remainder — no work is lost.

Auth: shared `CRON_SECRET` (same env var every cron in this project
uses).

Side effects:
  - Calls Deepgram with audio URL (billable).
  - Writes to setter_call_transcripts.
  - Writes a `webhook_deliveries` audit row per invocation.

Manual trigger for testing:
  curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \
       https://ai-enablement-sigma.vercel.app/api/setter_calls_sweep_cron
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import sys
import traceback
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any

# Make sibling packages importable when Vercel instantiates this handler.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from ingestion.setter_calls import (  # noqa: E402
    EligibilityError,
    RecordingFetchError,
    find_pending_calls,
    transcribe_call,
)
from ingestion.setter_calls.deepgram import DeepgramError  # noqa: E402
from shared.db import get_client  # noqa: E402

logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.setter_calls_sweep_cron")
logger.setLevel(logging.INFO)

_DELIVERY_SOURCE = "setter_calls_sweep_cron"

# Per-invocation cap. See module docstring.
_MAX_CALLS_PER_RUN = 20

_MAX_ERROR_CHARS = 2000


class handler(BaseHTTPRequestHandler):
    """Vercel's Python runtime instantiates this per request."""

    def do_POST(self) -> None:
        try:
            self._handle()
        except Exception as exc:
            logger.exception(
                "setter_calls_sweep_cron: unhandled top-level error: %s", exc
            )
            self._respond(500, {"error": "internal_error"})

    def do_GET(self) -> None:
        # Manual curl debug path — same auth, same behavior as the POST
        # Vercel Cron makes.
        self.do_POST()

    def _handle(self) -> None:
        if not _verify_auth(self.headers):
            self._respond(401, {"error": "unauthorized"})
            return

        result = run_sweep()
        self._respond(200, result)

    def _respond(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)


# ---------------------------------------------------------------------------
# Main flow (testable independently of the HTTP wrapper)
# ---------------------------------------------------------------------------


def run_sweep() -> dict[str, Any]:
    """One cron iteration. Returns a structured result. NEVER raises.

    The result schema is stable — used both by the Vercel cron viewer
    and by any future ops tooling that wants to observe runs.
    """
    started_at = datetime.now(timezone.utc)
    db = get_client()

    # Audit row up front so we can attribute every Deepgram call to a
    # cron invocation if a billing surprise hits.
    audit_id = _write_audit_row(db, started_at)

    try:
        pending = find_pending_calls(db, limit=_MAX_CALLS_PER_RUN)
    except Exception as exc:
        err = f"find_pending_failed: {type(exc).__name__}: {exc}"
        logger.exception("setter_calls_sweep_cron: %s", err)
        _mark_audit_failed(db, audit_id, err)
        return {"status": "failed", "stage": "discovery", "error": err}

    logger.info(
        "setter_calls_sweep_cron.discovered count=%d cap=%d",
        len(pending), _MAX_CALLS_PER_RUN,
    )

    succeeded: list[str] = []
    skipped: list[dict[str, str]] = []
    failed: list[dict[str, str]] = []
    total_cost_usd = 0.0

    for close_id in pending:
        try:
            row = transcribe_call(close_id, db=db)
            succeeded.append(close_id)
            cost = row.get("deepgram_cost_usd") or 0
            try:
                total_cost_usd += float(cost)
            except (TypeError, ValueError):
                pass
            logger.info(
                "setter_calls_sweep_cron.ok close_id=%s duration_s=%s cost=$%s",
                close_id, row.get("duration_s"), cost,
            )
        except EligibilityError as e:
            # The discovery query and the per-call eligibility check
            # disagree. Log so the divergence is visible; don't fail the
            # whole sweep.
            skipped.append({"close_id": close_id, "reason": str(e)[:200]})
            logger.warning(
                "setter_calls_sweep_cron.skip close_id=%s reason=%s",
                close_id, e,
            )
        except (RecordingFetchError, DeepgramError) as e:
            failed.append({"close_id": close_id, "error": str(e)[:200]})
            logger.error(
                "setter_calls_sweep_cron.fail close_id=%s err=%s",
                close_id, e,
            )
        except Exception as exc:
            # Shouldn't happen — defensive catch keeps the sweep alive.
            tb = traceback.format_exc()[:500]
            failed.append({"close_id": close_id, "error": f"unexpected: {tb}"})
            logger.exception(
                "setter_calls_sweep_cron.unexpected close_id=%s",
                close_id,
            )

    elapsed_s = (datetime.now(timezone.utc) - started_at).total_seconds()
    result = {
        "status": "ok",
        "discovered": len(pending),
        "succeeded": len(succeeded),
        "skipped": len(skipped),
        "failed": len(failed),
        "total_cost_usd": round(total_cost_usd, 6),
        "elapsed_s": round(elapsed_s, 1),
        "succeeded_ids": succeeded,
        "skipped_detail": skipped,
        "failed_detail": failed,
    }
    _mark_audit_processed(db, audit_id, result)
    return result


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def _verify_auth(headers: Any) -> bool:
    """Bearer-token auth. Validates against shared `CRON_SECRET`."""
    expected = os.environ.get("CRON_SECRET") or ""
    if not expected:
        logger.error("setter_calls_sweep_cron: CRON_SECRET not configured")
        return False
    auth_header = (
        headers.get("Authorization") or headers.get("authorization") or ""
    )
    if not auth_header.startswith("Bearer "):
        return False
    presented = auth_header[len("Bearer ") :]
    return hmac.compare_digest(presented, expected)


# ---------------------------------------------------------------------------
# Audit row lifecycle (matches the convention used by other cron handlers)
# ---------------------------------------------------------------------------


def _write_audit_row(db: Any, started_at: datetime) -> str:
    """Insert a `webhook_deliveries` audit row at the start of the sweep.

    Returns the synthesized webhook_id so the caller can mark it
    processed / failed at the end.
    """
    # Synthesize a stable-ish id — timestamp + sha. Each cron fire has
    # its own row so we can audit deepgram billing back to a cron.
    raw_id = f"{_DELIVERY_SOURCE}:{started_at.isoformat()}"
    webhook_id = (
        f"{_DELIVERY_SOURCE}:{started_at.timestamp():.0f}"
        f":{hashlib.sha256(raw_id.encode()).hexdigest()[:12]}"
    )
    try:
        db.table("webhook_deliveries").insert(
            {
                "webhook_id": webhook_id,
                "source": _DELIVERY_SOURCE,
                "processing_status": "received",
                "payload": {"started_at": started_at.isoformat()},
            }
        ).execute()
    except Exception as exc:
        # Audit row failure is not fatal — the cron should still run.
        logger.warning(
            "setter_calls_sweep_cron: audit insert failed: %s", exc,
        )
    return webhook_id


def _mark_audit_processed(db: Any, webhook_id: str, result: dict[str, Any]) -> None:
    try:
        db.table("webhook_deliveries").update(
            {
                "processing_status": "processed",
                "processed_at": datetime.now(timezone.utc).isoformat(),
                "payload": result,
            }
        ).eq("webhook_id", webhook_id).execute()
    except Exception as exc:
        logger.warning(
            "setter_calls_sweep_cron: audit update failed: %s", exc,
        )


def _mark_audit_failed(db: Any, webhook_id: str, err: str) -> None:
    try:
        db.table("webhook_deliveries").update(
            {
                "processing_status": "failed",
                "processing_error": err[:_MAX_ERROR_CHARS],
                "processed_at": datetime.now(timezone.utc).isoformat(),
            }
        ).eq("webhook_id", webhook_id).execute()
    except Exception as exc:
        logger.warning(
            "setter_calls_sweep_cron: audit failure-update failed: %s", exc,
        )
