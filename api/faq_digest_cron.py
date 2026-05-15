"""Weekly Friday FAQ digest cron.

Vercel Cron POSTs here at 19:00 UTC every Friday (= 15:00 EDT during
DST). Pulls the last 7 days of `documents.document_type='call_review'`
rows, extracts every `questions_asked` item where `asker='client'`,
cluster-light dedups via token-Jaccard (no LLM), sorts by call-count
descending, and sends Scott a Slack DM with the top questions.

Direction: favor lots of questions over accurate-and-deduped questions.
Scott will scan and pick from the list for his client-facing FAQ. No
LLM dedup pass — keep cost down. The cluster representative is the
longest question in the cluster (typically most specific).

Pipeline (single transaction):

  1. Auth via `CRON_SECRET` bearer token (shared across crons per M6.2).
  2. Insert `webhook_deliveries` audit row up front.
  3. Compute window: now() - 7 days inclusive.
  4. Query `documents` for fathom call_review docs whose
     `metadata->>'started_at'` falls in the window. Parse `content`
     JSON, extract every `questions_asked` item with `asker='client'`.
  5. Cluster via token-Jaccard >= 0.5 against the longest item in
     each cluster. Greedy single-pass.
  6. Sort clusters by call_count desc, then by representative alpha
     for stability. Cap at top 50; surface "+N more" footer if over.
  7. Resolve Scott's `slack_user_id` from `team_members` (NOT
     hardcoded). Send via `shared.slack_post.post_message`.
  8. Mark audit row processed (or failed-with-error). Always return
     200 — cron should not retry on Slack failures.

Env vars required:

  CRON_SECRET                                 — Vercel Cron Bearer auth.
                                                Shared across all cron
                                                endpoints in this project
                                                (Vercel only supports one
                                                CRON_SECRET per project).
  SLACK_BOT_TOKEN                             — used by shared.slack_post
  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY    — shared.db client

Manual trigger for testing:
  curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \\
       https://ai-enablement-sigma.vercel.app/api/faq_digest_cron
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

# Optional CC recipient. When `FAQ_DIGEST_CC_SLACK_USER_ID` is set to a
# syntactically valid Slack user_id (^U[A-Z0-9]+$), the cron fans out
# the same DM to both Scott and the CC. Drake uses this during the
# validation period to see the same DM Scott sees. Drake's slack_user_id
# is the expected value (`U0AMC23G1SM`), but the cron resolves it from
# the env var rather than hardcoding — keeps the cron robust against
# future re-targeting. Unset = current behavior (Scott-only).
_CC_ENV_VAR = "FAQ_DIGEST_CC_SLACK_USER_ID"
_SLACK_USER_ID_RE = re.compile(r"^U[A-Z0-9]+$")

# Make sibling packages importable when Vercel instantiates this handler.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from shared.db import get_client  # noqa: E402
from shared.slack_post import post_message  # noqa: E402

# Vercel's Python runtime defaults the root logger to WARNING; bump to
# INFO so operational lines surface in the Vercel log stream.
logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.faq_digest_cron")
logger.setLevel(logging.INFO)

# Audit-row source label. Searchable from SQL; do not change without
# updating any audit dashboards.
_DELIVERY_SOURCE = "faq_digest_cron"

# Look-back window in days. 7 == one week of calls. Cron fires weekly
# so this matches the cadence.
_WINDOW_DAYS = 7

# Token-Jaccard similarity threshold for clustering questions.
# Tuned for "Scott would consider these the same question." Lower =
# more aggressive clustering (fewer top-level entries, more conflation);
# higher = less clustering (more entries, more near-duplicates).
# 0.5 picked as the midpoint — Builder's call per spec. Iterate from
# production data once Scott has seen a few digests.
_CLUSTER_JACCARD_THRESHOLD = 0.5

# Cap the number of clusters surfaced in the Slack message.
# Slack messages have a 40k character limit but Scott shouldn't be
# scrolling through 200 entries. Cap is per spec.
_MAX_CLUSTERS_IN_MESSAGE = 50

# Stop-word set for cluster-key tokenization. Cheap, deliberately
# small; the goal is to drop the most-frequent function words so
# "the/is/to/and" overlap doesn't trip the clusterer.
_STOP_WORDS = frozenset({
    "the", "a", "an", "and", "or", "but", "is", "are", "was", "were",
    "be", "been", "being", "have", "has", "had", "do", "does", "did",
    "will", "would", "could", "should", "may", "might", "can", "to",
    "of", "in", "on", "at", "for", "with", "by", "from", "as", "that",
    "this", "these", "those", "it", "its", "i", "you", "he", "she",
    "we", "they", "me", "him", "her", "us", "them", "my", "your",
    "our", "their", "what", "when", "where", "who", "why", "how",
    "so", "if", "then", "than", "just", "about", "into", "out", "up",
    "down", "over", "under", "again", "also", "into", "between",
    "through", "during", "before", "after", "above", "below",
})


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
                "faq_digest_cron: unhandled top-level error: %s", exc
            )
            self._respond(500, {"error": "internal_error"})

    def do_GET(self) -> None:
        # Same auth + behavior as POST so a manual curl works the same
        # way Vercel Cron's POST does.
        self.do_POST()

    def _handle(self) -> None:
        if not _verify_auth(self.headers):
            self._respond(401, {"error": "unauthorized"})
            return

        result = run_faq_digest_cron()
        # Always 200 unless something catastrophic happened. Slack send
        # failures are logged in the audit row but don't fail the cron
        # (no retry desired).
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


def run_faq_digest_cron() -> dict[str, Any]:
    """Run one cron iteration. Returns a structured result dict for the
    HTTP layer to serialize. NEVER raises.

    Slack delivery fans out one DM + one webhook_deliveries audit row
    per recipient — Scott is always primary; an optional CC recipient
    is appended when `FAQ_DIGEST_CC_SLACK_USER_ID` is set to a
    syntactically valid Slack user_id. Mirrors the `ella_escalation_dm`
    fan-out shape. Pre-fanout failures (Scott lookup, document fetch)
    return failed status without writing audit rows — those surface in
    Vercel logs; only the per-recipient send rows hit
    `webhook_deliveries`."""
    now_utc = datetime.now(timezone.utc)
    window_start = now_utc - timedelta(days=_WINDOW_DAYS)

    db = get_client()

    # 1. Extract client-asked questions from the past 7 days of
    # call_review documents.
    try:
        questions = _fetch_client_questions(db, window_start, now_utc)
    except Exception as exc:
        error_message = f"document_fetch_failed: {type(exc).__name__}: {exc}"
        logger.exception("faq_digest_cron: document fetch failed: %s", exc)
        return {
            "status": "failed",
            "error": error_message,
        }

    # 2. Cluster + sort.
    clusters = _cluster_questions(questions)
    clusters.sort(key=lambda c: (-c["call_count"], c["representative"].lower()))
    total_clusters = len(clusters)
    truncated = total_clusters > _MAX_CLUSTERS_IN_MESSAGE
    display_clusters = clusters[:_MAX_CLUSTERS_IN_MESSAGE]

    # 3. Resolve recipients (Scott primary + optional CC). Pre-fanout
    # failure path returns failed without writing audit rows.
    try:
        recipients = _resolve_recipients(db)
    except Exception as exc:
        error_message = f"recipient_resolution_failed: {type(exc).__name__}: {exc}"
        logger.exception("faq_digest_cron: recipient resolution failed: %s", exc)
        return {
            "status": "failed",
            "error": error_message,
        }
    if not recipients:
        error_message = "scott_slack_user_id_not_resolved"
        logger.error("faq_digest_cron: %s", error_message)
        return {
            "status": "failed",
            "error": error_message,
        }

    # 4. Format the Slack DM body. Always send something — even if zero
    # questions surfaced, the explicit "no questions" message lets
    # recipients know the cron ran.
    message_text = _format_digest_message(
        window_start=window_start,
        window_end=now_utc,
        clusters=display_clusters,
        total_clusters=total_clusters,
        truncated=truncated,
        total_questions=len(questions),
    )

    base_payload: dict[str, Any] = {
        "window_start": window_start.isoformat(),
        "window_end": now_utc.isoformat(),
        "total_questions": len(questions),
        "total_clusters": total_clusters,
        "displayed_clusters": len(display_clusters),
        "truncated": truncated,
    }

    # 5. Fan out — one Slack post + one audit row per recipient.
    recipient_results: list[dict[str, Any]] = []
    for recipient in recipients:
        recipient_results.append(
            _fire_recipient_dm(db, recipient, message_text, base_payload)
        )

    # 6. Aggregate. Scott is the source-of-truth recipient; CC is
    # best-effort. Status flips to slack_post_failed only when Scott's
    # send fails. CC failures land in the recipients list but don't
    # change the cron's top-level status.
    scott_result = next(
        (r for r in recipient_results if r["source"] == "scott"), None
    )
    cc_result = next(
        (r for r in recipient_results if r["source"] == "cc"), None
    )
    scott_ok = bool(scott_result and scott_result["slack_ok"])

    logger.info(
        "faq_digest_cron: complete questions=%d clusters=%d scott_ok=%s "
        "cc_present=%s cc_ok=%s",
        len(questions),
        total_clusters,
        scott_ok,
        cc_result is not None,
        cc_result["slack_ok"] if cc_result else None,
    )
    return {
        "status": "ok" if scott_ok else "slack_post_failed",
        # Backwards-compat: top-level delivery_id / slack_ok / slack_error
        # reflect Scott's send. Per-recipient detail is in `recipients`.
        "delivery_id": scott_result["delivery_id"] if scott_result else None,
        "window_start": window_start.isoformat(),
        "window_end": now_utc.isoformat(),
        "total_questions": len(questions),
        "total_clusters": total_clusters,
        "displayed_clusters": len(display_clusters),
        "truncated": truncated,
        "slack_ok": scott_ok,
        "slack_error": scott_result["slack_error"] if scott_result else None,
        "recipients": recipient_results,
        "cc_present": cc_result is not None,
        "cc_slack_ok": cc_result["slack_ok"] if cc_result else None,
        "cc_slack_error": cc_result["slack_error"] if cc_result else None,
    }


def _resolve_recipients(db) -> list[dict[str, str]]:
    """Build the recipient list for one tick.

    Returns `[Scott]` when only Scott is resolvable, or
    `[Scott, CC]` when `FAQ_DIGEST_CC_SLACK_USER_ID` is set to a
    syntactically valid Slack user_id (and isn't a duplicate of Scott).

    Each entry shape:
        {"slack_user_id": str, "label": str, "source": "scott" | "cc"}

    Edge cases:
      - Scott row missing or `slack_user_id` null → returns `[]`
        (the cron caller treats empty as failure and short-circuits).
      - CC env unset → Scott-only list.
      - CC env set to malformed value (doesn't match ^U[A-Z0-9]+$) →
        log a warning, return Scott-only list (do NOT raise).
      - CC env set to Scott's own slack_user_id → deduplicated to one
        entry (Scott wins; CC dropped).
    """
    recipients: list[dict[str, str]] = []

    scott = _fetch_scott(db)
    if scott is None or not scott.get("slack_user_id"):
        return recipients
    recipients.append(
        {
            "slack_user_id": scott["slack_user_id"],
            "label": scott.get("full_name") or "Scott",
            "source": "scott",
        }
    )

    cc_raw = (os.environ.get(_CC_ENV_VAR) or "").strip()
    if not cc_raw:
        return recipients
    if not _SLACK_USER_ID_RE.match(cc_raw):
        logger.warning(
            "faq_digest_cron: %s=%r is malformed (must match ^U[A-Z0-9]+$); "
            "proceeding with Scott-only",
            _CC_ENV_VAR,
            cc_raw,
        )
        return recipients
    if any(r["slack_user_id"] == cc_raw for r in recipients):
        # CC is the same Slack user as Scott — don't double-DM.
        return recipients
    recipients.append(
        {
            "slack_user_id": cc_raw,
            "label": "CC",
            "source": "cc",
        }
    )
    return recipients


def _fire_recipient_dm(
    db,
    recipient: dict[str, str],
    message_text: str,
    base_payload: dict[str, Any],
) -> dict[str, Any]:
    """Send one DM to one recipient and write one webhook_deliveries
    audit row. Returns the per-recipient result dict. Never raises."""
    delivery_id = f"faq_digest_{uuid.uuid4()}"
    payload: dict[str, Any] = {
        **base_payload,
        "recipient_slack_user_id": recipient["slack_user_id"],
        "recipient_label": recipient["label"],
        "recipient_source": recipient["source"],
        "stage": "starting",
    }
    _insert_delivery(db, delivery_id, payload=payload, status="received")

    slack_result = post_message(recipient["slack_user_id"], message_text)

    final_payload = {
        **payload,
        "slack_ok": slack_result["ok"],
        "slack_error": slack_result.get("slack_error"),
        "stage": "complete",
    }
    _mark_delivery(
        db,
        delivery_id,
        status="processed" if slack_result["ok"] else "failed",
        error=(
            None
            if slack_result["ok"]
            else f"slack_post_failed: {slack_result.get('slack_error')}"
        ),
        payload_update=final_payload,
    )
    return {
        "slack_user_id": recipient["slack_user_id"],
        "label": recipient["label"],
        "source": recipient["source"],
        "delivery_id": delivery_id,
        "slack_ok": bool(slack_result["ok"]),
        "slack_error": slack_result.get("slack_error"),
    }


# ---------------------------------------------------------------------------
# Document fetch + question extraction
# ---------------------------------------------------------------------------


def _fetch_client_questions(
    db, window_start: datetime, window_end: datetime
) -> list[dict[str, Any]]:
    """Return every well-formed client-asked question from call_review
    documents in the window.

    Each returned dict carries `question` and `document_id` so a future
    debugging surface can trace a clustered representative back to its
    source review.
    """
    window_start_iso = window_start.isoformat()
    window_end_iso = window_end.isoformat()

    resp = (
        db.table("documents")
        .select("id, content, metadata")
        .eq("source", "fathom")
        .eq("document_type", "call_review")
        .gte("metadata->>started_at", window_start_iso)
        .lt("metadata->>started_at", window_end_iso)
        .execute()
    )
    rows = resp.data or []

    questions: list[dict[str, Any]] = []
    for row in rows:
        content = row.get("content")
        if not isinstance(content, str):
            continue
        try:
            parsed = json.loads(content)
        except (ValueError, TypeError):
            continue
        if not isinstance(parsed, dict):
            continue
        raw_questions = parsed.get("questions_asked")
        if not isinstance(raw_questions, list):
            continue
        for item in raw_questions:
            if not isinstance(item, dict):
                continue
            if item.get("asker") != "client":
                continue
            q = item.get("question")
            if not isinstance(q, str) or not q.strip():
                continue
            questions.append(
                {"question": q.strip(), "document_id": row.get("id")}
            )

    return questions


# ---------------------------------------------------------------------------
# Clustering
# ---------------------------------------------------------------------------


def _tokenize(text: str) -> set[str]:
    """Lowercased content-word set. Drops stop words and very short
    tokens — these are the units the Jaccard similarity operates on."""
    if not text:
        return set()
    tokens = re.findall(r"\b[a-z][a-z']{2,}\b", text.lower())
    return {t for t in tokens if t not in _STOP_WORDS}


def _cluster_questions(questions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Greedy single-pass clustering on token-Jaccard similarity.

    Each cluster holds:
      - representative: the longest question in the cluster (most
        specific is typically most useful for an FAQ).
      - call_count: how many source-question instances cluster here.
      - members: the verbatim questions clustered.

    A question joins an existing cluster when its token set has
    Jaccard >= _CLUSTER_JACCARD_THRESHOLD against the cluster's
    representative token set. Empty-token questions go into their own
    singleton cluster.
    """
    clusters: list[dict[str, Any]] = []
    for q in questions:
        text = q["question"]
        tokens = _tokenize(text)
        chosen: dict[str, Any] | None = None
        for cluster in clusters:
            rep_tokens = cluster["representative_tokens"]
            if not tokens and not rep_tokens:
                chosen = cluster
                break
            if not tokens or not rep_tokens:
                continue
            intersection = tokens & rep_tokens
            union = tokens | rep_tokens
            if not union:
                continue
            jaccard = len(intersection) / len(union)
            if jaccard >= _CLUSTER_JACCARD_THRESHOLD:
                chosen = cluster
                break
        if chosen is None:
            clusters.append({
                "representative": text,
                "representative_tokens": tokens,
                "call_count": 1,
                "members": [text],
            })
            continue
        chosen["call_count"] += 1
        chosen["members"].append(text)
        # Promote a longer member to representative — typically more
        # specific phrasing makes a more useful FAQ entry.
        if len(text) > len(chosen["representative"]):
            chosen["representative"] = text
            chosen["representative_tokens"] = tokens
    return clusters


# ---------------------------------------------------------------------------
# Slack message formatting
# ---------------------------------------------------------------------------


def _format_digest_message(
    *,
    window_start: datetime,
    window_end: datetime,
    clusters: list[dict[str, Any]],
    total_clusters: int,
    truncated: bool,
    total_questions: int,
) -> str:
    """Build the Slack DM body. Scott receives this verbatim."""
    range_label = (
        f"{window_start.strftime('%b %d')}–{window_end.strftime('%b %d')}"
    )
    if not clusters:
        return (
            f":question: *FAQ digest — week of {range_label}*\n"
            f"\n"
            f"No client questions surfaced this week."
        )

    lines: list[str] = [
        f":question: *FAQ digest — week of {range_label}*",
        "",
        f"{total_clusters} unique client question"
        f"{'' if total_clusters == 1 else 's'} across {total_questions} raised "
        f"this week.",
        "",
    ]
    for idx, cluster in enumerate(clusters, start=1):
        rep = cluster["representative"].strip()
        cnt = cluster["call_count"]
        suffix = (
            f" (asked in {cnt} call{'' if cnt == 1 else 's'})"
            if cnt > 1
            else ""
        )
        lines.append(f"{idx}. \"{rep}\"{suffix}")

    if truncated:
        more = total_clusters - _MAX_CLUSTERS_IN_MESSAGE
        lines.append("")
        lines.append(f"...and {more} more less-frequent questions.")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Team-member lookup (Scott)
# ---------------------------------------------------------------------------


def _fetch_scott(db) -> dict[str, Any] | None:
    """Resolve Scott's team_members row dynamically. Filter on a Wilson
    surname rather than hardcoding a UUID or slack_user_id — keeps the
    cron robust against any future re-onboarding."""
    resp = (
        db.table("team_members")
        .select("id, full_name, slack_user_id, is_csm, archived_at")
        .ilike("full_name", "Scott Wilson%")
        .is_("archived_at", "null")
        .execute()
    )
    rows = resp.data or []
    for row in rows:
        if row.get("slack_user_id"):
            return row
    return None


# ---------------------------------------------------------------------------
# webhook_deliveries audit
# ---------------------------------------------------------------------------


def _insert_delivery(
    db,
    delivery_id: str,
    *,
    payload: Any,
    status: str,
) -> None:
    """Insert the initial audit row. Caught broadly — an audit insert
    failure must not propagate into the main flow."""
    try:
        row: dict[str, Any] = {
            "webhook_id": delivery_id,
            "source": _DELIVERY_SOURCE,
            "processing_status": status,
            "payload": payload,
            "headers": {},
        }
        db.table("webhook_deliveries").insert(row).execute()
    except Exception as exc:
        logger.warning(
            "faq_digest_cron: audit insert failed delivery_id=%s: %s",
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
    """UPDATE the audit row to a terminal status."""
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
            "faq_digest_cron: audit update failed delivery_id=%s: %s",
            delivery_id,
            exc,
        )


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def _verify_auth(headers: Any) -> bool:
    """Bearer-token auth. Validates against `CRON_SECRET` — the single
    project-level env var Vercel Cron sends as the Bearer token. All
    cron endpoints in this codebase share this validation."""
    expected = os.environ.get("CRON_SECRET") or ""
    if not expected:
        logger.error("faq_digest_cron: CRON_SECRET not configured")
        return False
    auth_header = (
        headers.get("Authorization") or headers.get("authorization") or ""
    )
    if not auth_header.startswith("Bearer "):
        return False
    presented = auth_header[len("Bearer ") :]
    return hmac.compare_digest(presented, expected)
