"""Retrieval layer for Ella.

Wraps `shared.kb_query.search_for_client` with a client-specific
context bundle — the chunks plus the client profile + primary CSM
metadata the prompt construction layer needs to address the client
by name and route escalations correctly.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from shared.db import get_client
from shared.kb_query import Chunk, search_for_client


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


def fetch_recent_channel_context(
    slack_channel_id: str,
    *,
    before_ts: str,
    n_turns: int = 15,
    max_chars: int = 8000,
) -> str:
    """Last N messages in `slack_channel_id` before `before_ts`,
    formatted as a single string for the prompt's recent-channel-context
    section (Task 5 of Batch 1.5).

    Per line: `[HH:MM] <author_type> <resolved_name>: <text>`.

    `before_ts` is a Slack ts string (e.g. "1745000000.000100"). We
    compare against `slack_messages.slack_ts` lexicographically (Slack
    ts strings sort chronologically because they're zero-padded
    seconds.microseconds).

    `max_chars` (default 8000 ≈ 2000 tokens at ~4 chars/token) is the
    cap. If the assembled context exceeds it, the oldest messages are
    truncated and a `[...earlier messages truncated...]` line is
    prepended.

    Returns empty string when there are no messages in the window.
    """
    if not slack_channel_id or not before_ts:
        return ""

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
    if not rows:
        return ""

    # Resolve user_ids to display names in batch — single round-trip
    # to clients + team_members rather than per-message lookups.
    user_ids = sorted({r["slack_user_id"] for r in rows if r.get("slack_user_id")})
    name_map = _batch_resolve_names(db, user_ids)

    # Build oldest → newest by reversing the desc fetch.
    rows.reverse()
    lines: list[str] = []
    for r in rows:
        try:
            ts = r["sent_at"]
            hhmm = ts[11:16] if isinstance(ts, str) and len(ts) >= 16 else "??:??"
        except (KeyError, TypeError):
            hhmm = "??:??"
        author_type = r.get("author_type") or "unknown"
        uid = r.get("slack_user_id") or "?"
        display = name_map.get(uid, uid)
        text = (r.get("text") or "").replace("\n", " ").strip()
        lines.append(f"[{hhmm}] {author_type} {display}: {text}")

    # Char-budget trim from the oldest end.
    rendered = "\n".join(lines)
    if len(rendered) <= max_chars:
        return rendered
    truncated_lines: list[str] = []
    running = 0
    # Walk newest → oldest, accumulating until we hit the cap, then
    # reverse back to chronological.
    for line in reversed(lines):
        if running + len(line) + 1 > max_chars:
            break
        truncated_lines.append(line)
        running += len(line) + 1
    truncated_lines.reverse()
    return "[...earlier messages truncated...]\n" + "\n".join(truncated_lines)


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
