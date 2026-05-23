"""Daily Ella-flags digest cron.

Vercel Cron POSTs here at 20:30 UTC every day (= 16:30 EDT during DST;
the EST mapping after DST falls back is `30 21 * * *` UTC = 16:30 EST
— documented in docs/runbooks/cron_schedule.md per ADR 0003).

Drains every unsent `pending_digest_items` row in the last 24h (a row
is inserted whenever the decision Haiku set `digest_flag=true` on a
passive- or reactive-path message), groups by client, formats a
digest body, and DMs it to Scott (head of fulfillment) + an optional
CC (Drake). Each row is marked `sent_in_digest_at` so it never
re-sends.

Direction: this is a curated daily skim of "things worth Scott's
eyes" — not every message, not just CSM-action escalations. False
positives are explicitly fine; the digest is for skimming.

Pipeline:

  1. Auth via `CRON_SECRET` bearer token (shared across crons).
  2. Compute window: now() - 24h, OR `?since=<iso_timestamp>` override.
  3. Query unsent `pending_digest_items` in the window; join clients
     for the group label.
  4. Group by client (alphabetical), chronological within client.
  5. Resolve recipients: head_csm from `team_members`
     (`access_tier='head_csm' AND archived_at IS NULL`) + optional CC
     env var `ELLA_DAILY_DIGEST_CC_SLACK_USER_ID`.
  6. Fan out one DM + one `webhook_deliveries` audit row per recipient
     (`source='ella_daily_digest'`). One failure doesn't block others.
  7. Mark all drained rows `sent_in_digest_at=now()` in a single
     UPDATE keyed by the id list.
  8. Empty day still fires with a "No flags today." body — silent
     failure (cron didn't run) is worse than empty success.

Env vars required:

  CRON_SECRET                          — Vercel Cron Bearer auth.
  ELLA_DAILY_DIGEST_CC_SLACK_USER_ID   — optional CC (Drake). Unset =
                                         primary recipient only.
  SLACK_BOT_TOKEN                      — shared.slack_post
  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — shared.db

Manual trigger (also supports the ?since override for backfill):
  curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \\
       "https://ai-enablement-sigma.vercel.app/api/ella_daily_digest_cron?since=2026-05-17T00:00:00Z"
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import re
import sys
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from shared.db import get_client  # noqa: E402
from shared.slack_post import post_message  # noqa: E402

logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.ella_daily_digest_cron")
logger.setLevel(logging.INFO)

# Audit-row source label. Searchable from SQL; do not change without
# updating audit dashboards / recovery queries.
_DELIVERY_SOURCE = "ella_daily_digest"

# Default look-back window. Cron fires daily so 24h matches cadence.
_WINDOW_HOURS = 24

# Optional CC recipient (Drake during the validation period). Resolved
# from the env var rather than hardcoded.
_CC_ENV_VAR = "ELLA_DAILY_DIGEST_CC_SLACK_USER_ID"
_SLACK_USER_ID_RE = re.compile(r"^U[A-Z0-9]+$")

# Slack 40k char body limit. Truncate well under it with a pointer
# footer so a high-volume day still delivers something.
_BODY_TRUNCATE_AT = 35000

_SNIPPET_MAX = 100
_REASONING_MAX = 150


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------


class handler(BaseHTTPRequestHandler):
    """Vercel's Python runtime instantiates this per request."""

    def do_POST(self) -> None:
        try:
            self._handle()
        except Exception as exc:
            logger.exception(
                "ella_daily_digest_cron: unhandled top-level error: %s", exc
            )
            self._respond(500, {"error": "internal_error"})

    def do_GET(self) -> None:
        self.do_POST()

    def _handle(self) -> None:
        if not _verify_auth(self.headers):
            self._respond(401, {"error": "unauthorized"})
            return
        since = _parse_since(self.path)
        result = run_ella_daily_digest_cron(since=since)
        self._respond(200, result)

    def _respond(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)


def _parse_since(path: str) -> datetime | None:
    """Parse `?since=<iso_timestamp>` from the request path. Returns
    None if absent or unparseable (falls back to the 24h window)."""
    try:
        qs = parse_qs(urlparse(path).query)
        raw = (qs.get("since") or [None])[0]
        if not raw:
            return None
        cleaned = raw.replace("Z", "+00:00")
        dt = datetime.fromisoformat(cleaned)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception as exc:
        logger.warning(
            "ella_daily_digest_cron: unparseable ?since=%r (%s); "
            "using default 24h window",
            path,
            exc,
        )
        return None


# ---------------------------------------------------------------------------
# Main flow (testable independently of the HTTP wrapper)
# ---------------------------------------------------------------------------


def run_ella_daily_digest_cron(*, since: datetime | None = None) -> dict[str, Any]:
    """Run one digest tick. Returns a structured result dict. NEVER
    raises — Slack failures land in audit rows but don't fail the
    cron (no retry desired)."""
    now_utc = datetime.now(timezone.utc)
    window_start = since or (now_utc - timedelta(hours=_WINDOW_HOURS))

    db = get_client()
    cron_run_id = f"ella_digest_{uuid.uuid4()}"

    try:
        items = _fetch_unsent_items(db, window_start)
    except Exception as exc:
        logger.exception("ella_daily_digest_cron: item fetch failed: %s", exc)
        return {
            "status": "failed",
            "error": f"item_fetch_failed: {type(exc).__name__}: {exc}",
        }

    grouped = _group_by_client(db, items)
    message_text = _format_digest_message(now_utc, grouped, len(items))

    recipients, recipient_warnings = _resolve_recipients(db)

    base_payload: dict[str, Any] = {
        "cron_run_id": cron_run_id,
        "window_start": window_start.isoformat(),
        "window_end": now_utc.isoformat(),
        "message_count": len(items),
        "client_groups": len(grouped),
        "recipient_warnings": recipient_warnings,
    }

    # Recipient-resolution warnings (zero / multiple head_csm) get an
    # error audit row but the cron continues — empty recipients only
    # happens if there's also no CC, in which case nothing sends.
    if recipient_warnings:
        _insert_delivery(
            db,
            f"{cron_run_id}_warn",
            payload={**base_payload, "stage": "recipient_warning"},
            status="failed",
            error="; ".join(recipient_warnings),
        )

    recipient_results: list[dict[str, Any]] = []
    for recipient in recipients:
        recipient_results.append(
            _fire_recipient_dm(db, recipient, message_text, base_payload)
        )

    # Mark all drained rows sent in a single UPDATE keyed by id list —
    # only after the send fan-out so a total send failure leaves rows
    # unsent for the next tick to retry.
    marked = 0
    if items and any(r["slack_ok"] for r in recipient_results):
        marked = _mark_items_sent(db, [i["id"] for i in items], now_utc)

    logger.info(
        "ella_daily_digest_cron: complete items=%d groups=%d recipients=%d "
        "marked_sent=%d",
        len(items),
        len(grouped),
        len(recipient_results),
        marked,
    )
    return {
        "status": (
            "ok"
            if (not recipients or any(r["slack_ok"] for r in recipient_results))
            else "slack_post_failed"
        ),
        "cron_run_id": cron_run_id,
        "window_start": window_start.isoformat(),
        "window_end": now_utc.isoformat(),
        "message_count": len(items),
        "client_groups": len(grouped),
        "marked_sent": marked,
        "recipients": recipient_results,
        "recipient_warnings": recipient_warnings,
    }


# ---------------------------------------------------------------------------
# Item fetch + grouping
# ---------------------------------------------------------------------------


def _fetch_unsent_items(db, window_start: datetime) -> list[dict[str, Any]]:
    """Every unsent pending_digest_items row created at/after
    `window_start`, oldest first."""
    resp = (
        db.table("pending_digest_items")
        .select("*")
        .is_("sent_in_digest_at", "null")
        .gte("created_at", window_start.isoformat())
        .order("created_at", desc=False)
        .execute()
    )
    return list(resp.data or [])


def _group_by_client(db, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Group items by client_id, resolving a display name for each.
    Returns a list of {client_name, client_id, items[]} sorted
    alphabetically by client name; items chronological within group."""
    if not items:
        return []

    client_ids = sorted({i["client_id"] for i in items if i.get("client_id")})
    names: dict[str, str] = {}
    if client_ids:
        try:
            resp = (
                db.table("clients")
                .select("id, full_name")
                .in_("id", client_ids)
                .execute()
            )
            for row in resp.data or []:
                names[row["id"]] = row.get("full_name") or "(unknown client)"
        except Exception as exc:
            logger.warning(
                "ella_daily_digest_cron: client name resolution failed: %s",
                exc,
            )

    buckets: dict[str, dict[str, Any]] = {}
    for item in items:
        cid = item.get("client_id") or "__no_client__"
        label = (
            names.get(cid, "(unknown client)")
            if cid != "__no_client__"
            else "(no client mapping)"
        )
        bucket = buckets.setdefault(
            cid, {"client_id": cid, "client_name": label, "items": []}
        )
        bucket["items"].append(item)

    groups = list(buckets.values())
    groups.sort(key=lambda g: g["client_name"].lower())
    for g in groups:
        g["items"].sort(key=lambda i: i.get("created_at") or "")
    return groups


# ---------------------------------------------------------------------------
# Slack message formatting
# ---------------------------------------------------------------------------


def _format_digest_message(
    now_utc: datetime,
    groups: list[dict[str, Any]],
    total_items: int,
) -> str:
    date_label = _est_date_label(now_utc)
    header = f":mag: *Ella's daily flags — {date_label}*"
    if not groups:
        return f"{header}\n\nNo flags today."

    lines: list[str] = [
        header,
        "",
        f"{total_items} flagged message"
        f"{'' if total_items == 1 else 's'} across "
        f"{len(groups)} client{'' if len(groups) == 1 else 's'}.",
        "",
    ]
    for g in groups:
        lines.append(f"*{g['client_name']}*")
        for item in g["items"]:
            lines.append(_format_item_line(item))
        lines.append("")

    body = "\n".join(lines).rstrip()
    if len(body) > _BODY_TRUNCATE_AT:
        body = (
            body[:_BODY_TRUNCATE_AT].rstrip()
            + "\n\n_(… more flagged messages truncated)_"
        )
    return body


def _format_item_line(item: dict[str, Any]) -> str:
    ts_label = _est_time_label(item.get("created_at"))
    snippet = _truncate((item.get("message_text") or "").strip(), _SNIPPET_MAX)
    category = item.get("digest_category") or "other"
    reasoning = _truncate((item.get("haiku_reasoning") or "").strip(), _REASONING_MAX)
    permalink = _build_message_permalink(
        item.get("slack_channel_id") or "",
        item.get("triggering_message_ts") or "",
    )
    responded = " [→ Ella responded]" if item.get("ella_responded") else ""
    return (
        f"• {ts_label} — {snippet}\n"
        f"    Ella's read: {category} — {reasoning}\n"
        f"    <{permalink}>{responded}"
    )


def _truncate(text: str, n: int) -> str:
    if len(text) <= n:
        return text
    return text[: n - 1].rstrip() + "…"


def _build_message_permalink(slack_channel_id: str, slack_ts: str) -> str:
    """Slack permalink. Mirrors
    `agents.ella.escalation_routing._build_message_permalink` so DMs and
    digest links render identically. Workspace subdomain optional."""
    workspace = os.environ.get("SLACK_WORKSPACE") or ""
    ts_compact = slack_ts.replace(".", "")
    subdomain = f"{workspace}." if workspace else ""
    return f"https://{subdomain}slack.com/archives/{slack_channel_id}/p{ts_compact}"


# ---------------------------------------------------------------------------
# ET time formatting (ADR 0003 — store UTC, render ET)
# ---------------------------------------------------------------------------


def _et_zone():
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo("America/New_York")
    except Exception:  # pragma: no cover — zoneinfo always present on 3.11
        return timezone.utc


def _parse_dt(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _est_time_label(value: Any) -> str:
    dt = _parse_dt(value)
    if dt is None:
        return "??:??"
    return dt.astimezone(_et_zone()).strftime("%H:%M ET")


def _est_date_label(dt: datetime) -> str:
    return dt.astimezone(_et_zone()).strftime("%b %d, %Y")


# ---------------------------------------------------------------------------
# Recipient resolution
# ---------------------------------------------------------------------------


def _resolve_recipients(db) -> tuple[list[dict[str, str]], list[str]]:
    """Resolve the digest recipients.

    Primary: every `team_members` row with `access_tier='head_csm'` and
    `archived_at IS NULL`. Exactly one expected today (Scott). Zero or
    multiple is allowed but warned: zero → CC-only (no primary);
    multiple → send to all (a future second head_csm correctly joins
    the list).

    CC: `ELLA_DAILY_DIGEST_CC_SLACK_USER_ID` when set to a valid
    `^U[A-Z0-9]+$` and not a duplicate of a primary recipient.

    Returns `(recipients, warnings)`.
    """
    recipients: list[dict[str, str]] = []
    warnings: list[str] = []

    try:
        resp = (
            db.table("team_members")
            .select("id, full_name, slack_user_id, access_tier, archived_at")
            .eq("access_tier", "head_csm")
            .is_("archived_at", "null")
            .execute()
        )
        head_rows = [r for r in (resp.data or []) if r.get("slack_user_id")]
    except Exception as exc:
        logger.exception("ella_daily_digest_cron: head_csm resolution failed: %s", exc)
        head_rows = []
        warnings.append(f"head_csm_query_failed: {type(exc).__name__}")

    if len(head_rows) == 0:
        warnings.append("zero_head_csm_resolved")
    elif len(head_rows) > 1:
        warnings.append(f"multiple_head_csm_resolved:{len(head_rows)}")

    for row in head_rows:
        recipients.append(
            {
                "slack_user_id": row["slack_user_id"],
                "label": row.get("full_name") or "head CSM",
                "source": "head_csm",
            }
        )

    cc_raw = (os.environ.get(_CC_ENV_VAR) or "").strip()
    if cc_raw:
        if not _SLACK_USER_ID_RE.match(cc_raw):
            logger.warning(
                "ella_daily_digest_cron: %s=%r malformed; ignoring CC",
                _CC_ENV_VAR,
                cc_raw,
            )
            warnings.append("cc_env_malformed")
        elif any(r["slack_user_id"] == cc_raw for r in recipients):
            pass  # CC duplicates a primary recipient — don't double-DM.
        else:
            recipients.append({"slack_user_id": cc_raw, "label": "CC", "source": "cc"})

    return recipients, warnings


def _fire_recipient_dm(
    db,
    recipient: dict[str, str],
    message_text: str,
    base_payload: dict[str, Any],
) -> dict[str, Any]:
    """Send one DM + write one webhook_deliveries audit row. Never
    raises (FAQ-digest pattern — one failure doesn't block others)."""
    delivery_id = f"ella_daily_digest_{uuid.uuid4()}"
    payload: dict[str, Any] = {
        **base_payload,
        "recipient_slack_user_id": recipient["slack_user_id"],
        "recipient_label": recipient["label"],
        "recipient_source": recipient["source"],
        "stage": "starting",
    }
    _insert_delivery(db, delivery_id, payload=payload, status="received")

    slack_result = post_message(recipient["slack_user_id"], message_text)

    _mark_delivery(
        db,
        delivery_id,
        status="processed" if slack_result["ok"] else "failed",
        error=(
            None
            if slack_result["ok"]
            else f"slack_post_failed: {slack_result.get('slack_error')}"
        ),
        payload_update={
            **payload,
            "slack_ok": slack_result["ok"],
            "slack_error": slack_result.get("slack_error"),
            "stage": "complete",
        },
    )
    return {
        "slack_user_id": recipient["slack_user_id"],
        "label": recipient["label"],
        "source": recipient["source"],
        "delivery_id": delivery_id,
        "slack_ok": bool(slack_result["ok"]),
        "slack_error": slack_result.get("slack_error"),
    }


def _mark_items_sent(db, item_ids: list[str], now_utc: datetime) -> int:
    """Single UPDATE keyed by the id list — efficiency + atomicity over
    per-row updates."""
    if not item_ids:
        return 0
    try:
        (
            db.table("pending_digest_items")
            .update({"sent_in_digest_at": now_utc.isoformat()})
            .in_("id", item_ids)
            .execute()
        )
        return len(item_ids)
    except Exception as exc:
        logger.exception(
            "ella_daily_digest_cron: mark-sent UPDATE failed (%d rows): %s",
            len(item_ids),
            exc,
        )
        return 0


# ---------------------------------------------------------------------------
# webhook_deliveries audit
# ---------------------------------------------------------------------------


def _insert_delivery(
    db, delivery_id: str, *, payload: Any, status: str, error: str | None = None
) -> None:
    try:
        row: dict[str, Any] = {
            "webhook_id": delivery_id,
            "source": _DELIVERY_SOURCE,
            "processing_status": status,
            "payload": payload,
            "headers": {},
        }
        if error is not None:
            row["processing_error"] = error[:2000]
        if status != "received":
            row["processed_at"] = datetime.now(timezone.utc).isoformat()
        db.table("webhook_deliveries").insert(row).execute()
    except Exception as exc:
        logger.warning(
            "ella_daily_digest_cron: audit insert failed delivery_id=%s: %s",
            delivery_id,
            exc,
        )


def _mark_delivery(
    db,
    delivery_id: str,
    *,
    status: str,
    error: str | None,
    payload_update: dict[str, Any] | None = None,
) -> None:
    try:
        update: dict[str, Any] = {
            "processing_status": status,
            "processed_at": datetime.now(timezone.utc).isoformat(),
        }
        if error is not None:
            update["processing_error"] = error[:2000]
        if payload_update is not None:
            update["payload"] = payload_update
        db.table("webhook_deliveries").update(update).eq(
            "webhook_id", delivery_id
        ).execute()
    except Exception as exc:
        logger.warning(
            "ella_daily_digest_cron: audit update failed delivery_id=%s: %s",
            delivery_id,
            exc,
        )


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def _verify_auth(headers: Any) -> bool:
    expected = os.environ.get("CRON_SECRET") or ""
    if not expected:
        logger.error("ella_daily_digest_cron: CRON_SECRET not configured")
        return False
    auth_header = headers.get("Authorization") or headers.get("authorization") or ""
    if not auth_header.startswith("Bearer "):
        return False
    presented = auth_header[len("Bearer ") :]
    return hmac.compare_digest(presented, expected)
