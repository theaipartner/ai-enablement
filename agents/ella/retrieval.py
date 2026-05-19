"""Retrieval layer for Ella.

Wraps `shared.kb_query.search_for_client` with a client-specific
context bundle — the chunks plus the client profile + primary CSM
metadata the prompt construction layer needs to address the client
by name and route escalations correctly.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from shared.db import get_client
from shared.kb_query import Chunk, search_for_client

# All human-facing timestamps render in ET per ADR 0003 (store UTC,
# render ET). DST-safe via zoneinfo.
_ET = ZoneInfo("America/New_York")

# author_type → speaker role label for the recent-context block. The
# decision Haiku's mental model uses "advisor" everywhere (never
# "CSM"), so team_member collapses to advisor here too.
_ROLE_LABELS = {
    "client": "client",
    "team_member": "advisor",
    "ella": "ella",
    "bot": "bot",
}


@dataclass(frozen=True)
class ContextBundle:
    """Everything the agent needs to answer one client question."""

    chunks: list[Chunk]
    client: dict[str, Any]
    primary_csm: dict[str, Any] | None


def retrieve_context_for_client(
    client_id: str,
    query: str,
    *,
    k: int = 8,
    include_global: bool = True,
) -> ContextBundle:
    """Pull top-k chunks for this client's query plus profile context.

    Delegates retrieval to `shared.kb_query.search_for_client` (which
    handles the safety invariants via `match_document_chunks`).
    Performs two lightweight follow-up SELECTs to fetch the client's
    profile and their primary CSM for prompt construction.
    """
    chunks = search_for_client(
        query,
        client_id=client_id,
        k=k,
        include_global=include_global,
    )

    db = get_client()
    client = _fetch_client(db, client_id)
    primary_csm = _fetch_primary_csm(db, client_id)

    return ContextBundle(chunks=chunks, client=client, primary_csm=primary_csm)


def _fetch_client(db, client_id: str) -> dict[str, Any]:
    resp = db.table("clients").select("*").eq("id", client_id).execute()
    rows = resp.data or []
    return rows[0] if rows else {}


def fetch_recent_channel_messages(
    slack_channel_id: str,
    *,
    before_ts: str,
    n_turns: int = 15,
) -> list[dict[str, Any]]:
    """Raw `slack_messages` rows for the last `n_turns` messages in
    `slack_channel_id` before `before_ts`, oldest → newest.

    Ella's own posts are INCLUDED (no author_type filter) so follow-up
    threading works. `before_ts` compares against `slack_messages.slack_ts`
    lexicographically (Slack ts strings sort chronologically — zero-padded
    seconds.microseconds). Returns `[]` when the window is empty.

    This is the row-level primitive. `fetch_recent_channel_context`
    formats these for the prompt; `build_kb_query_from_conversation`
    builds the embedding query from them.
    """
    if not slack_channel_id or not before_ts:
        return []
    db = get_client()
    msgs_resp = (
        db.table("slack_messages")
        .select("slack_ts,slack_user_id,author_type,text,sent_at")
        .eq("slack_channel_id", slack_channel_id)
        .lt("slack_ts", before_ts)
        .order("sent_at", desc=True)
        .limit(n_turns)
        .execute()
    )
    rows = list(msgs_resp.data or [])
    rows.reverse()  # desc fetch → chronological
    return rows


def _parse_utc(sent_at: Any) -> datetime | None:
    """Parse a UTC `sent_at` string into an aware datetime, or None on
    any failure (never raises)."""
    if not isinstance(sent_at, str) or not sent_at:
        return None
    try:
        dt = datetime.fromisoformat(sent_at.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def _et_stamp(sent_at: Any) -> str:
    """`YYYY-MM-DD HH:MM ET` from a UTC `sent_at` string. Falls back to
    a literal `?` stamp on any parse failure (never raises)."""
    dt = _parse_utc(sent_at)
    if dt is None:
        return "????-??-?? ??:?? ET"
    return dt.astimezone(_ET).strftime("%Y-%m-%d %H:%M ET")


def _format_time_ago(seconds: int) -> str:
    """Render an elapsed-seconds delta into the decision Haiku's
    "time ago" vocabulary. Bands per the prompt-sharpening spec:

      <60s            → "<1 minute ago"
      1-59 min        → "<N> minutes ago"
      1-23 h, mins>0  → "<N>h <M>m ago"
      1-23 h, mins=0  → "<N>h ago"
      24 h+           → "<N>d ago"

    Negative deltas (a context row newer than the trigger — shouldn't
    happen since rows are pre-trigger, but defensive) clamp to 0.
    """
    if seconds < 0:
        seconds = 0
    if seconds < 60:
        return "<1 minute ago"
    if seconds < 3600:
        return f"{seconds // 60} minutes ago"
    if seconds < 86400:
        hours = seconds // 3600
        mins = (seconds % 3600) // 60
        return f"{hours}h ago" if mins == 0 else f"{hours}h {mins}m ago"
    return f"{seconds // 86400}d ago"


def fetch_recent_channel_context(
    slack_channel_id: str,
    *,
    before_ts: str,
    n_turns: int = 15,
    max_chars: int = 8000,
    relative_to: datetime | None = None,
) -> str:
    """Last N messages before `before_ts`, formatted for the prompt's
    recent-channel-context section.

    Per line: `[YYYY-MM-DD HH:MM ET — <delta>] <role> (<name>): <text>`
    where role is `client` / `advisor` / `ella` / `bot` / `unknown`
    (author_type `team_member` renders as `advisor` for mental-model
    consistency with the decision Haiku) and `<delta>` is a pre-computed
    "time ago" string (see `_format_time_ago`) so the decision Haiku
    judges conversation continuity without doing timestamp math. Ella's
    own posts are included.

    `relative_to` is the instant the deltas are measured against —
    pass the triggering message's send time so the deltas are stable
    regardless of when the decision Haiku actually runs (the cron-drain
    path can fire minutes after the message landed). Defaults to
    `now(UTC)` when not supplied (test paths / edge cases — deltas just
    become slightly stale, never broken).

    `max_chars` (default 8000 ≈ 2000 tokens) caps the block; the oldest
    lines are dropped and a `[...earlier messages truncated...]` marker
    is prepended. Returns empty string when the window is empty.
    """
    rows = fetch_recent_channel_messages(
        slack_channel_id, before_ts=before_ts, n_turns=n_turns
    )
    if not rows:
        return ""

    if relative_to is None:
        relative_to = datetime.now(timezone.utc)

    db = get_client()
    user_ids = sorted({r["slack_user_id"] for r in rows if r.get("slack_user_id")})
    name_map = _batch_resolve_names(db, user_ids)

    lines: list[str] = []
    for r in rows:
        stamp = _et_stamp(r.get("sent_at"))
        sent_dt = _parse_utc(r.get("sent_at"))
        if sent_dt is not None:
            delta = _format_time_ago(int((relative_to - sent_dt).total_seconds()))
            stamp = f"{stamp} — {delta}"
        author_type = r.get("author_type") or "unknown"
        role = _ROLE_LABELS.get(author_type, "unknown")
        uid = r.get("slack_user_id") or "?"
        display = name_map.get(uid, uid)
        text = (r.get("text") or "").replace("\n", " ").strip()
        lines.append(f"[{stamp}] {role} ({display}): {text}")

    rendered = "\n".join(lines)
    if len(rendered) <= max_chars:
        return rendered
    truncated_lines: list[str] = []
    running = 0
    for line in reversed(lines):
        if running + len(line) + 1 > max_chars:
            break
        truncated_lines.append(line)
        running += len(line) + 1
    truncated_lines.reverse()
    return "[...earlier messages truncated...]\n" + "\n".join(truncated_lines)


def build_kb_query_from_conversation(
    triggering_message: str,
    recent_messages: list[dict[str, Any]],
    *,
    triggering_weight: int = 2,
) -> str:
    """Construct an embedding query from the triggering message plus
    the last N messages. Triggering message weighted `triggering_weight`x
    by repetition so a fresh-topic trigger isn't drowned by stale
    context, while a bare/short trigger still pulls the conversation's
    anchors.

    `recent_messages` is the raw rows from
    `fetch_recent_channel_messages` (or compatible dicts with a `text`
    key), oldest → newest. Returns a single concatenated string ready
    to embed. Empty recent context → just the triggering message ×weight.
    """
    parts: list[str] = []
    for m in recent_messages or []:
        t = (m.get("text") or "").replace("\n", " ").strip()
        if t:
            parts.append(t)
    trig = (triggering_message or "").replace("\n", " ").strip()
    if trig:
        parts.extend([trig] * max(1, triggering_weight))
    return "\n".join(parts)


def _batch_resolve_names(db, slack_user_ids: list[str]) -> dict[str, str]:
    """Resolve a batch of slack_user_ids to display names via two
    `IN (...)` queries (clients + team_members). Unknown user_ids
    drop through with their raw id used as the display name.
    """
    if not slack_user_ids:
        return {}
    out: dict[str, str] = {}
    cl = (
        db.table("clients")
        .select("slack_user_id,full_name")
        .in_("slack_user_id", slack_user_ids)
        .is_("archived_at", "null")
        .execute()
    )
    for r in cl.data or []:
        if r.get("slack_user_id"):
            out[r["slack_user_id"]] = r.get("full_name") or r["slack_user_id"]
    tm = (
        db.table("team_members")
        .select("slack_user_id,full_name")
        .in_("slack_user_id", slack_user_ids)
        .is_("archived_at", "null")
        .execute()
    )
    for r in tm.data or []:
        if r.get("slack_user_id") and r["slack_user_id"] not in out:
            out[r["slack_user_id"]] = r.get("full_name") or r["slack_user_id"]
    return out


def _fetch_primary_csm(db, client_id: str) -> dict[str, Any] | None:
    """Walk `client_team_assignments` → `team_members` for the client's
    current primary_csm, if any. Returns None when no active primary
    is assigned (rare today; `scripts/seed_clients.py` sets the
    majority)."""
    assignments = (
        db.table("client_team_assignments")
        .select("team_member_id")
        .eq("client_id", client_id)
        .eq("role", "primary_csm")
        .is_("unassigned_at", "null")
        .execute()
    )
    if not assignments.data:
        return None
    tm_id = assignments.data[0]["team_member_id"]
    tm_resp = db.table("team_members").select("*").eq("id", tm_id).execute()
    tm_rows = tm_resp.data or []
    return tm_rows[0] if tm_rows else None
