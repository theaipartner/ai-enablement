"""Daily Ella-flags digest cron.

Vercel Cron POSTs here at 20:30 UTC every day (= 16:30 EDT during DST;
the EST mapping after DST falls back is `30 21 * * *` UTC = 16:30 EST
— documented in docs/runbooks/cron_schedule.md per ADR 0003).

Drains every unsent `pending_digest_items` row in the last 24h (a row
is inserted whenever the decision Haiku set `digest_flag=true` on a
passive- or reactive-path message), runs a Haiku ranker that picks the
top 25 most-important by priority (money / complaints → negative
emotion → questions → everything else), and posts a numbered link-only
list to the `#daily-digest` channel. Each drained row is marked
`sent_in_digest_at` so it never re-sends.

Channels-only redesign (2026-05-28): the digest used to DM Scott + an
optional CC (Drake). All Ella DMs were retired — the digest now posts
to a channel. The body is `Hey Scott, here's today's digest:` followed
by `1. <permalink>` … (link only; Slack unfurls the previews).

Direction: this is a curated daily skim of "things worth Scott's
eyes" — not every message, not just CSM-action escalations. False
positives are explicitly fine; the digest is for skimming. The top-25
cap is a display cap, not a queue — overflow beyond 25 is dropped from
the post (and still marked sent), not carried to tomorrow.

Pipeline:

  1. Auth via `CRON_SECRET` bearer token (shared across crons).
  2. Resolve `#daily-digest` id from `ELLA_DAILY_DIGEST_CHANNEL_SLACK_ID`.
     Unset -> 500 + audit row noting the config gap (gate (d) — Drake
     sets it in Vercel).
  3. Compute window: now() - 24h, OR `?since=<iso_timestamp>` override.
  4. Query unsent `pending_digest_items` in the window; resolve client
     names for the ranker input.
  5. Haiku-rank → top 25 ordered items (deterministic category-priority
     fallback if the Haiku call fails).
  6. Format the numbered link-only body; post once to the channel +
     write one `webhook_deliveries` audit row (`source='ella_daily_digest'`).
  7. Mark all drained rows `sent_in_digest_at=now()` in a single UPDATE
     keyed by the id list — only after a successful post.
  8. Empty day still fires with a "no flags today" body — silent
     failure (cron didn't run) is worse than empty success.

Env vars required:

  CRON_SECRET                          — Vercel Cron Bearer auth.
  ELLA_DAILY_DIGEST_CHANNEL_SLACK_ID   — destination channel id
                                         (required in production; gate (d)).
  SLACK_BOT_TOKEN                      — shared.slack_post
  ANTHROPIC_API_KEY                    — shared.claude_client (ranker Haiku)
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

from shared.claude_client import complete  # noqa: E402
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

# Destination channel (gate (d) env var).
_CHANNEL_ENV_VAR = "ELLA_DAILY_DIGEST_CHANNEL_SLACK_ID"

# Display cap — the Haiku returns at most this many, ordered.
_MAX_DIGEST_ITEMS = 25

# Ranker model + the snippet length the ranker sees per item.
_HAIKU_MODEL = "claude-haiku-4-5-20251001"
_RANKER_SNIPPET_MAX = 160

# Deterministic fallback priority when the ranker Haiku is unavailable.
# Lower = more important. Matches the prompt's stated priority order.
_CATEGORY_PRIORITY = {
    "money_commitment": 0,
    "complaint": 1,
    "emotional_human_needed": 2,
    "confusion": 3,
    "question_program": 4,
    "other": 5,
}

_RANKER_SYSTEM = """You rank flagged client messages for a daily digest sent to Scott, the head of fulfillment. Each item is a client message Ella flagged today as worth Scott's attention.

Rank them MOST IMPORTANT FIRST, using this priority:
1. Money / commitment concerns (refunds, billing, contracts, cancellations).
2. Complaints or dissatisfaction.
3. Negative emotional reactions (frustration, fear, feeling stuck/overwhelmed).
4. Help requests and questions.
5. Everything else.

Within a tier, put the more urgent / higher-signal message first.

Return STRICT JSON, no prose, no code fences:

{"ranked_ids": ["<id>", "<id>", ...]}

Include EVERY id you were given, ordered. Do not invent ids. Do not drop any."""


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
        status_code = 500 if result["status"] == "failed" else 200
        self._respond(status_code, result)

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

    # Destination channel (gate (d) env var).
    channel_id = (os.environ.get(_CHANNEL_ENV_VAR) or "").strip()
    if not channel_id:
        error_message = f"{_CHANNEL_ENV_VAR} not set"
        logger.error("ella_daily_digest_cron: %s", error_message)
        _insert_delivery(
            db,
            f"{cron_run_id}_config",
            payload={"config_gap": _CHANNEL_ENV_VAR},
            status="failed",
            error=error_message,
        )
        return {"status": "failed", "cron_run_id": cron_run_id, "error": error_message}

    try:
        items = _fetch_unsent_items(db, window_start)
    except Exception as exc:
        logger.exception("ella_daily_digest_cron: item fetch failed: %s", exc)
        return {
            "status": "failed",
            "error": f"item_fetch_failed: {type(exc).__name__}: {exc}",
        }

    client_names = _resolve_client_names(db, items)
    ranked = _select_and_rank(items, client_names)
    message_text = _format_digest_message(ranked)

    delivery_id = f"ella_daily_digest_{uuid.uuid4()}"
    base_payload: dict[str, Any] = {
        "cron_run_id": cron_run_id,
        "window_start": window_start.isoformat(),
        "window_end": now_utc.isoformat(),
        "message_count": len(items),
        "posted_count": len(ranked),
        "channel_id": channel_id,
    }
    _insert_delivery(db, delivery_id, payload=base_payload, status="received")

    slack_result = post_message(channel_id, message_text)
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
            **base_payload,
            "slack_ok": slack_result["ok"],
            "slack_error": slack_result.get("slack_error"),
        },
    )

    # Mark all drained rows sent only after a successful post — a failed
    # post leaves them unsent for the next tick to retry. Overflow beyond
    # the top-25 display cap is still marked sent (the digest is a daily
    # snapshot, not a backlog queue).
    marked = 0
    if items and slack_result["ok"]:
        marked = _mark_items_sent(db, [i["id"] for i in items], now_utc)

    logger.info(
        "ella_daily_digest_cron: complete items=%d posted=%d marked_sent=%d slack_ok=%s",
        len(items),
        len(ranked),
        marked,
        slack_result["ok"],
    )
    return {
        "status": "ok" if slack_result["ok"] else "slack_post_failed",
        "cron_run_id": cron_run_id,
        "window_start": window_start.isoformat(),
        "window_end": now_utc.isoformat(),
        "message_count": len(items),
        "posted_count": len(ranked),
        "marked_sent": marked,
        "slack_ok": bool(slack_result["ok"]),
        "slack_error": slack_result.get("slack_error"),
    }


# ---------------------------------------------------------------------------
# Item fetch + client-name resolution
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


def _resolve_client_names(db, items: list[dict[str, Any]]) -> dict[str, str]:
    """Map client_id -> display name for the ranker input. Best-effort:
    a failed lookup degrades to "(unknown client)" labels."""
    client_ids = sorted({i["client_id"] for i in items if i.get("client_id")})
    if not client_ids:
        return {}
    try:
        resp = (
            db.table("clients").select("id, full_name").in_("id", client_ids).execute()
        )
        return {
            row["id"]: (row.get("full_name") or "(unknown client)")
            for row in resp.data or []
        }
    except Exception as exc:
        logger.warning("ella_daily_digest_cron: client name resolution failed: %s", exc)
        return {}


# ---------------------------------------------------------------------------
# Ranking
# ---------------------------------------------------------------------------


def _select_and_rank(
    items: list[dict[str, Any]], client_names: dict[str, str]
) -> list[dict[str, Any]]:
    """Order items most-important-first and cap at _MAX_DIGEST_ITEMS.

    Uses the Haiku ranker; on any failure falls back to a deterministic
    category-priority sort. Items the ranker omits are appended in
    fallback order before the cap, so nothing is silently dropped while
    under the cap."""
    if not items:
        return []

    ordered = _haiku_rank(items, client_names)
    if ordered is None:
        ordered = _fallback_rank(items)
    return ordered[:_MAX_DIGEST_ITEMS]


def _haiku_rank(
    items: list[dict[str, Any]], client_names: dict[str, str]
) -> list[dict[str, Any]] | None:
    """Call the ranker Haiku; return items ordered by its ranked_ids, or
    None on any failure (caller falls back). Items omitted by the Haiku
    are appended in fallback order so the under-cap "list them all" rule
    holds."""
    by_id = {i["id"]: i for i in items}
    lines = []
    for it in items:
        name = client_names.get(it.get("client_id") or "", "(unknown client)")
        snippet = _truncate((it.get("message_text") or "").strip(), _RANKER_SNIPPET_MAX)
        cat = it.get("digest_category") or "other"
        lines.append(
            json.dumps(
                {"id": it["id"], "client": name, "category": cat, "message": snippet}
            )
        )
    user_prompt = "\n".join(lines)

    try:
        result = complete(
            system=_RANKER_SYSTEM,
            messages=[{"role": "user", "content": user_prompt}],
            model=_HAIKU_MODEL,
            max_tokens=2000,
        )
        parsed = json.loads(_strip_fences(result.text))
        ranked_ids = parsed.get("ranked_ids")
        if not isinstance(ranked_ids, list):
            raise ValueError("ranked_ids not a list")
    except Exception as exc:
        logger.warning(
            "ella_daily_digest_cron: ranker Haiku failed (%s); using fallback sort",
            exc,
        )
        return None

    ordered: list[dict[str, Any]] = []
    seen: set[str] = set()
    for rid in ranked_ids:
        item = by_id.get(rid)
        if item is not None and rid not in seen:
            ordered.append(item)
            seen.add(rid)
    # Append any items the ranker omitted (defensive — keeps under-cap
    # completeness), in fallback order.
    for item in _fallback_rank(items):
        if item["id"] not in seen:
            ordered.append(item)
            seen.add(item["id"])
    return ordered


def _fallback_rank(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Deterministic sort: category priority, then chronological."""
    return sorted(
        items,
        key=lambda i: (
            _CATEGORY_PRIORITY.get(i.get("digest_category") or "other", 5),
            i.get("created_at") or "",
        ),
    )


def _strip_fences(text: str) -> str:
    s = (text or "").strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[1] if "\n" in s else s
        if s.endswith("```"):
            s = s[:-3]
    return s.strip()


# ---------------------------------------------------------------------------
# Slack message formatting
# ---------------------------------------------------------------------------


def _format_digest_message(ranked: list[dict[str, Any]]) -> str:
    if not ranked:
        return "Hey Scott — no flags today."
    lines = ["Hey Scott, here's today's digest:", ""]
    for idx, item in enumerate(ranked, start=1):
        permalink = _build_message_permalink(
            item.get("slack_channel_id") or "",
            item.get("triggering_message_ts") or "",
        )
        lines.append(f"{idx}. {permalink}")
    return "\n".join(lines)


def _truncate(text: str, n: int) -> str:
    if len(text) <= n:
        return text
    return text[: n - 1].rstrip() + "…"


def _build_message_permalink(slack_channel_id: str, slack_ts: str) -> str:
    """Slack permalink. Mirrors
    `agents.ella.escalation_routing._build_message_permalink` so links
    render identically across surfaces. Workspace subdomain optional."""
    workspace = os.environ.get("SLACK_WORKSPACE") or ""
    ts_compact = slack_ts.replace(".", "")
    subdomain = f"{workspace}." if workspace else ""
    return f"https://{subdomain}slack.com/archives/{slack_channel_id}/p{ts_compact}"


# ---------------------------------------------------------------------------
# pending_digest_items state transition
# ---------------------------------------------------------------------------


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
