"""Ella unanswered-message flagger cron.

Real-time safety net layered on top of the daily digest. Vercel Cron
POSTs here every 15 minutes (`*/15 * * * *`, all hours / all days — no
timezone considerations, it runs 24/7 by design so weekend + after-
hours flags still get a second wave).

The daily digest (`api/ella_daily_digest_cron.py`) is Scott's once-a-
day skim. It can't catch a Saturday booking-link question that needed
a Saturday answer. This cron does: every flagged `pending_digest_items`
row that ages past 2h with no `team_member` message in the source
channel gets posted to `#unanswered-channels` with @-mentions of the
primary advisor + Scott. One post per row (`unanswered_posted_at`
dedup). The digest still fires independently — this is additive, not a
replacement.

"Human intervention" = ANY `team_member` message in the channel after
the flagged message landed (topic-agnostic — an active advisor means
the situation is handled). Ella's own posts do NOT count. This applies
to `acknowledge_and_escalate` rows too (DMs get missed; the channel
post is the second wave).

Pipeline (one audit row per posted item; one for disabled / config
gap):

  1. Auth via `CRON_SECRET` bearer token (shared across crons).
  2. Kill switch: `ELLA_UNANSWERED_FLAGGER_ENABLED` (defaults 'true').
     `!= 'true'` -> audit row {disabled:true}, 200 OK, no work.
  3. Resolve `#unanswered-channels` id from
     `ELLA_UNANSWERED_CHANNEL_SLACK_ID`. Unset -> 500 + audit row
     noting the config gap (gate (d) — Drake sets it in Vercel).
  4. SELECT candidate rows: `unanswered_posted_at IS NULL`,
     2h <= age <= 7d (the 7d backstop bounds a cron-paused-for-days
     scenario), oldest first, capped at 50/tick.
  5. Per candidate: if a `team_member` posted in the channel after
     `created_at`, mark resolved-before-post (unanswered_posted_at set,
     channel/ts NULL) and skip. Else build the body, resolve recipients
     (Scott from `team_members` head_csm + the client's primary advisor
     via `client_team_assignments`, deduped), post to the channel,
     stamp the row, write an audit row.
  6. Per-item Slack failure is isolated — audit + continue; one bad
     post doesn't break the drain.
  7. Return 200 with a checked / resolved / posted summary.

Env vars required:

  CRON_SECRET                       — Vercel Cron Bearer auth (shared).
  ELLA_UNANSWERED_FLAGGER_ENABLED   — kill switch; defaults 'true'.
  ELLA_UNANSWERED_CHANNEL_SLACK_ID  — destination channel id (required
                                      in production; gate (d)).
  SLACK_BOT_TOKEN                   — shared.slack_post.
  SLACK_WORKSPACE                   — optional; permalink subdomain.
  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — shared.db.

Manual trigger (Phase 1 smoke):
  curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \\
       https://ai-enablement-sigma.vercel.app/api/ella_unanswered_flagger_cron
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

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from shared.db import get_client  # noqa: E402
from shared.slack_post import post_message  # noqa: E402

logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.ella_unanswered_flagger_cron")
logger.setLevel(logging.INFO)

# Audit-row source label. Searchable from SQL; do not change without
# updating audit dashboards / recovery queries.
_DELIVERY_SOURCE = "ella_unanswered_flagger"

# A flagged message is "going stale" after 2h with no human in-channel.
_STALE_AFTER = timedelta(hours=2)

# Don't post about messages older than this — backstop against a
# cron-paused-for-days scenario re-surfacing ancient flags.
_BACKSTOP = timedelta(days=7)

# Cap rows handled per tick so a backlog drains over several ticks
# rather than wedging one invocation.
_MAX_PER_TICK = 50

_ENABLED_ENV_VAR = "ELLA_UNANSWERED_FLAGGER_ENABLED"
_CHANNEL_ENV_VAR = "ELLA_UNANSWERED_CHANNEL_SLACK_ID"

_SNIPPET_MAX = 200
_REASONING_MAX = 200


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
                "ella_unanswered_flagger_cron: unhandled top-level error: %s", exc
            )
            self._respond(500, {"error": "internal_error"})

    def do_GET(self) -> None:
        self.do_POST()

    def _handle(self) -> None:
        if not _verify_auth(self.headers):
            self._respond(401, {"error": "unauthorized"})
            return
        result = run_ella_unanswered_flagger_cron()
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


# ---------------------------------------------------------------------------
# Main flow (testable independently of the HTTP wrapper)
# ---------------------------------------------------------------------------


def run_ella_unanswered_flagger_cron() -> dict[str, Any]:
    """Run one tick. Returns a structured result dict. NEVER raises —
    per-item Slack failures land in audit rows but don't fail the
    cron."""
    cron_run_id = f"ella_unanswered_{uuid.uuid4()}"
    now_utc = datetime.now(timezone.utc)
    db = get_client()

    # 1. Kill switch.
    enabled = (os.environ.get(_ENABLED_ENV_VAR) or "true").strip().lower()
    if enabled != "true":
        _insert_delivery(
            db,
            f"{cron_run_id}_disabled",
            payload={"disabled": True, "enabled_value": enabled},
            status="processed",
        )
        logger.info("ella_unanswered_flagger_cron: disabled via kill switch")
        return {
            "status": "ok",
            "disabled": True,
            "cron_run_id": cron_run_id,
            "checked": 0,
            "resolved_before_post": 0,
            "posted": 0,
        }

    # 2. Destination channel (gate (d) env var).
    channel_id = (os.environ.get(_CHANNEL_ENV_VAR) or "").strip()
    if not channel_id:
        error_message = f"{_CHANNEL_ENV_VAR} not set"
        logger.error("ella_unanswered_flagger_cron: %s", error_message)
        _insert_delivery(
            db,
            f"{cron_run_id}_config",
            payload={"config_gap": _CHANNEL_ENV_VAR},
            status="failed",
            error=error_message,
        )
        return {
            "status": "failed",
            "cron_run_id": cron_run_id,
            "error": error_message,
        }

    # 3. Candidate rows.
    try:
        candidates = _fetch_candidates(db, now_utc)
    except Exception as exc:
        error_message = f"candidate_fetch_failed: {type(exc).__name__}: {exc}"
        logger.exception("ella_unanswered_flagger_cron: %s", error_message)
        _insert_delivery(
            db,
            f"{cron_run_id}_fetch",
            payload={"stage": "candidate_fetch"},
            status="failed",
            error=error_message,
        )
        return {
            "status": "failed",
            "cron_run_id": cron_run_id,
            "error": error_message,
        }

    if not candidates:
        logger.info("ella_unanswered_flagger_cron: no candidates this tick")
        return {
            "status": "ok",
            "cron_run_id": cron_run_id,
            "checked": 0,
            "resolved_before_post": 0,
            "posted": 0,
        }

    client_map = _resolve_clients(db, candidates)
    scott_ids = _resolve_head_csm_ids(db)

    resolved_before_post = 0
    posted = 0
    post_failures = 0

    for row in candidates:
        if _has_human_intervention(db, row):
            _mark_resolved_before_post(db, row["id"], now_utc)
            resolved_before_post += 1
            continue

        info = client_map.get(row.get("client_id") or "", {})
        mention_ids = _dedup_mentions(scott_ids, info.get("advisor_slack_user_id"))
        body = _format_channel_post(row, info.get("client_name"), mention_ids)

        slack_result = post_message(channel_id, body)
        if not slack_result["ok"]:
            post_failures += 1
            _insert_delivery(
                db,
                f"ella_unanswered_{uuid.uuid4()}",
                payload={
                    "pending_digest_item_id": row["id"],
                    "client_id": row.get("client_id"),
                    "recipient_slack_user_ids": mention_ids,
                    "slack_error": slack_result.get("slack_error"),
                    "message_text_snippet": _truncate(
                        (row.get("message_text") or "").strip(), _SNIPPET_MAX
                    ),
                },
                status="failed",
                error=f"slack_post_failed: {slack_result.get('slack_error')}",
            )
            logger.warning(
                "ella_unanswered_flagger_cron: post failed item=%s err=%s",
                row["id"],
                slack_result.get("slack_error"),
            )
            continue

        post_ts = slack_result.get("ts")
        _mark_posted(db, row["id"], now_utc, channel_id, post_ts)
        _insert_delivery(
            db,
            f"ella_unanswered_{uuid.uuid4()}",
            payload={
                "pending_digest_item_id": row["id"],
                "client_id": row.get("client_id"),
                "recipient_slack_user_ids": mention_ids,
                "channel_post_ts": post_ts,
                "message_text_snippet": _truncate(
                    (row.get("message_text") or "").strip(), _SNIPPET_MAX
                ),
            },
            status="processed",
        )
        posted += 1

    logger.info(
        "ella_unanswered_flagger_cron: complete checked=%d resolved=%d "
        "posted=%d post_failures=%d",
        len(candidates),
        resolved_before_post,
        posted,
        post_failures,
    )
    return {
        "status": "ok",
        "cron_run_id": cron_run_id,
        "checked": len(candidates),
        "resolved_before_post": resolved_before_post,
        "posted": posted,
        "post_failures": post_failures,
    }


# ---------------------------------------------------------------------------
# Candidate fetch + human-intervention check
# ---------------------------------------------------------------------------


def _fetch_candidates(db, now_utc: datetime) -> list[dict[str, Any]]:
    """Unposted rows aged into the [2h, 7d] window, oldest first,
    capped at _MAX_PER_TICK."""
    stale_before = (now_utc - _STALE_AFTER).isoformat()
    backstop_after = (now_utc - _BACKSTOP).isoformat()
    resp = (
        db.table("pending_digest_items")
        .select("*")
        .is_("unanswered_posted_at", "null")
        .lte("created_at", stale_before)
        .gte("created_at", backstop_after)
        .order("created_at", desc=False)
        .limit(_MAX_PER_TICK)
        .execute()
    )
    return list(resp.data or [])


def _has_human_intervention(db, row: dict[str, Any]) -> bool:
    """True if any `team_member` message landed in the source channel
    AFTER the flagged message's created_at. Topic-agnostic by design —
    an active advisor means the situation is being handled. Ella's own
    posts are author_type='ella', so they don't match."""
    resp = (
        db.table("slack_messages")
        .select("id")
        .eq("slack_channel_id", row.get("slack_channel_id"))
        .eq("author_type", "team_member")
        .gt("sent_at", row.get("created_at"))
        .limit(1)
        .execute()
    )
    return bool(resp.data)


# ---------------------------------------------------------------------------
# Client + recipient resolution
# ---------------------------------------------------------------------------


def _resolve_clients(db, candidates: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Map client_id -> {client_name, advisor_slack_user_id}. Mirrors
    the accountability cron's embedded-assignment shape."""
    client_ids = sorted({c["client_id"] for c in candidates if c.get("client_id")})
    if not client_ids:
        return {}
    try:
        resp = (
            db.table("clients")
            .select(
                "id,"
                "full_name,"
                "client_team_assignments("
                "role,unassigned_at,team_members(slack_user_id)"
                ")"
            )
            .in_("id", client_ids)
            .execute()
        )
    except Exception as exc:
        logger.warning(
            "ella_unanswered_flagger_cron: client resolution failed: %s", exc
        )
        return {}

    out: dict[str, dict[str, Any]] = {}
    for r in resp.data or []:
        out[r["id"]] = {
            "client_name": r.get("full_name") or "(unknown client)",
            "advisor_slack_user_id": _select_primary_csm_slack_id(
                r.get("client_team_assignments")
            ),
        }
    return out


def _select_primary_csm_slack_id(assignments: Any) -> str | None:
    """slack_user_id of the active primary_csm from the embedded
    client_team_assignments list (role='primary_csm',
    unassigned_at IS NULL)."""
    if not assignments or not isinstance(assignments, list):
        return None
    for a in assignments:
        if not isinstance(a, dict):
            continue
        if a.get("role") != "primary_csm" or a.get("unassigned_at") is not None:
            continue
        tm = a.get("team_members")
        if isinstance(tm, dict):
            sid = tm.get("slack_user_id")
            if isinstance(sid, str) and sid.strip():
                return sid.strip()
    return None


def _resolve_head_csm_ids(db) -> list[str]:
    """Every `team_members` slack_user_id with access_tier='head_csm'
    and archived_at IS NULL (Scott today). Zero -> post without Scott
    @-mention + log. Multiple -> @-mention all (correct behavior)."""
    try:
        resp = (
            db.table("team_members")
            .select("slack_user_id, access_tier, archived_at")
            .eq("access_tier", "head_csm")
            .is_("archived_at", "null")
            .execute()
        )
        ids = [r["slack_user_id"] for r in (resp.data or []) if r.get("slack_user_id")]
    except Exception as exc:
        logger.warning(
            "ella_unanswered_flagger_cron: head_csm resolution failed: %s", exc
        )
        return []
    if not ids:
        logger.warning(
            "ella_unanswered_flagger_cron: zero head_csm resolved — "
            "posting without Scott @-mention"
        )
    return ids


def _dedup_mentions(scott_ids: list[str], advisor_id: str | None) -> list[str]:
    """Scott(s) + primary advisor, order-preserving, de-duplicated (a
    client whose primary advisor IS Scott shouldn't get pinged twice)."""
    ordered: list[str] = []
    for sid in list(scott_ids) + ([advisor_id] if advisor_id else []):
        if sid and sid not in ordered:
            ordered.append(sid)
    return ordered


# ---------------------------------------------------------------------------
# Slack message formatting
# ---------------------------------------------------------------------------


def _format_channel_post(
    row: dict[str, Any],
    client_name: str | None,
    mention_ids: list[str],
) -> str:
    name = client_name or "(unknown client)"
    mentions = " ".join(f"<@{m}>" for m in mention_ids)
    snippet = _truncate((row.get("message_text") or "").strip(), _SNIPPET_MAX)
    category = row.get("digest_category") or "other"
    reasoning = _truncate((row.get("haiku_reasoning") or "").strip(), _REASONING_MAX)
    time_ago = _format_time_ago(row.get("created_at"))
    permalink = _build_message_permalink(
        row.get("slack_channel_id") or "",
        row.get("triggering_message_ts") or "",
    )
    mention_line = (
        f"{mentions} — this message has been sitting without an advisor response."
        if mentions
        else "This message has been sitting without an advisor response."
    )
    return (
        f":bell: Unanswered for 2h — {name}\n"
        f"{mention_line}\n\n"
        f"> {snippet}\n\n"
        f"Ella's read: {category} — {reasoning}\n"
        f"Posted: {time_ago} by {name}\n"
        f"{permalink}"
    )


def _truncate(text: str, n: int) -> str:
    if len(text) <= n:
        return text
    return text[: n - 1].rstrip() + "…"


def _build_message_permalink(slack_channel_id: str, slack_ts: str) -> str:
    """Slack permalink. Mirrors ella_daily_digest_cron's builder so the
    channel post and the digest link render identically. Workspace
    subdomain optional (SLACK_WORKSPACE)."""
    workspace = os.environ.get("SLACK_WORKSPACE") or ""
    ts_compact = slack_ts.replace(".", "")
    subdomain = f"{workspace}." if workspace else ""
    return f"https://{subdomain}slack.com/archives/{slack_channel_id}/p{ts_compact}"


def _format_time_ago(created_at: Any) -> str:
    """Coarse human age ("2h ago", "3d ago"). Best-effort; an
    unparseable timestamp degrades to a literal."""
    if not created_at:
        return "an unknown time ago"
    try:
        dt = datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
    except Exception:
        return str(created_at)
    delta = datetime.now(timezone.utc) - dt
    secs = int(delta.total_seconds())
    if secs < 3600:
        return f"{max(1, secs // 60)}m ago"
    if secs < 86400:
        return f"{secs // 3600}h ago"
    return f"{secs // 86400}d ago"


# ---------------------------------------------------------------------------
# pending_digest_items state transitions
# ---------------------------------------------------------------------------


def _mark_resolved_before_post(db, item_id: str, now_utc: datetime) -> None:
    """A human responded within the window. Stamp unanswered_posted_at
    (so it's never re-checked) with NULL channel/ts to signal
    "resolved before post" rather than "posted"."""
    try:
        (
            db.table("pending_digest_items")
            .update(
                {
                    "unanswered_posted_at": now_utc.isoformat(),
                    "unanswered_post_slack_channel_id": None,
                    "unanswered_post_slack_ts": None,
                }
            )
            .eq("id", item_id)
            .execute()
        )
    except Exception as exc:
        logger.warning(
            "ella_unanswered_flagger_cron: mark-resolved failed item=%s: %s",
            item_id,
            exc,
        )


def _mark_posted(
    db, item_id: str, now_utc: datetime, channel_id: str, post_ts: str | None
) -> None:
    try:
        (
            db.table("pending_digest_items")
            .update(
                {
                    "unanswered_posted_at": now_utc.isoformat(),
                    "unanswered_post_slack_channel_id": channel_id,
                    "unanswered_post_slack_ts": post_ts,
                }
            )
            .eq("id", item_id)
            .execute()
        )
    except Exception as exc:
        logger.warning(
            "ella_unanswered_flagger_cron: mark-posted failed item=%s: %s",
            item_id,
            exc,
        )


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
            "ella_unanswered_flagger_cron: audit insert failed id=%s: %s",
            delivery_id,
            exc,
        )


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def _verify_auth(headers: Any) -> bool:
    expected = os.environ.get("CRON_SECRET") or ""
    if not expected:
        logger.error("ella_unanswered_flagger_cron: CRON_SECRET not configured")
        return False
    auth_header = headers.get("Authorization") or headers.get("authorization") or ""
    if not auth_header.startswith("Bearer "):
        return False
    presented = auth_header[len("Bearer ") :]
    return hmac.compare_digest(presented, expected)
