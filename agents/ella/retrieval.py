"""Retrieval layer for Ella.

Wraps `shared.kb_query.search_for_client` with a client-specific
context bundle — the chunks plus the client profile + primary CSM
metadata the prompt construction layer needs to address the client
by name and route escalations correctly.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from shared.db import get_client
from shared.kb_query import Chunk, search_for_client
from shared.slack_identity import get_user_id_for_token

logger = logging.getLogger("ai_enablement.ella.retrieval")

# Mirror of `ingestion.slack.realtime_ingest._SLACK_MENTION_RE`. The
# new @-mention exchanges helper needs to identify PRIOR mention
# messages with the same definition the live realtime ingest uses to
# trigger Ella, but importing from ingestion.slack would create an
# undesirable cross-layer dependency (agents.* imports ingestion.*).
# Inline the one-line regex instead.
_SLACK_MENTION_RE = re.compile(r"<@(U[A-Z0-9]+)>")

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


def fetch_recent_at_mention_exchanges(
    slack_channel_id: str,
    *,
    before_ts: str,
    n_exchanges: int = 3,
    lookback_messages: int = 30,
    max_chars: int = 4000,
    relative_to: datetime | None = None,
) -> str:
    """Last `n_exchanges` @-mention exchanges in `slack_channel_id`
    before `before_ts`, formatted for the @ handler's system prompt.

    An "exchange" = one message that @-mentions Ella (per the same
    bot-OR-human-user-id definition `realtime_ingest.detect_at_mentions`
    uses to trigger the live @ handler) PLUS Ella's reply to that
    mention. Pairing is by Ella's resolved `slack_user_id`, NOT by
    `author_type`, because of the open issue where Ella's posts are
    sometimes tagged `author_type='bot'` instead of `'ella'`
    (`docs/agents/ella/followups.md`). If Ella hasn't replied to the
    mention yet (or the reply isn't in the lookback window), the
    mention is included alone. Tolerates missing replies.

    `before_ts` STRICTLY excludes the current triggering message — the
    fetch uses `slack_ts < before_ts` so a same-microsecond mention is
    never miscounted as prior.

    Channel-scoped only. Cross-channel messages are NEVER returned (the
    `slack_channels.slack_channel_id` filter is on the parent query and
    the lookback is bounded by `lookback_messages`). Empty channel /
    no prior mentions → empty string.

    Render format (per line):
      `[YYYY-MM-DD HH:MM ET — <time-ago>] <role> (<name>): <text>`
    Each exchange separates with a blank line + a `----` divider so
    Sonnet sees discrete pairs (not one continuous run).

    `max_chars` (default 4000 ≈ 1000 tokens — generous for 3 small
    exchanges, tight enough that a runaway long-message reply gets
    per-message-truncated). Per-message text truncated at ~800 chars to
    keep one fat message from monopolizing the budget.

    `relative_to` is the instant the time-ago deltas are measured
    against (typically the live triggering message's UTC time so deltas
    are stable). Defaults to `now(UTC)`.

    `lookback_messages` is the raw-row fetch budget — needs to be deep
    enough to contain `n_exchanges` @-mention messages in a chatty
    channel. Default 30 is roughly "10 turns per exchange," fine for
    typical client channels. If a channel mentions Ella rarely this
    fetch may return fewer than `n_exchanges` — that's intended.
    """
    if not slack_channel_id or not before_ts:
        return ""

    rows = fetch_recent_channel_messages(
        slack_channel_id, before_ts=before_ts, n_turns=lookback_messages
    )
    if not rows:
        return ""

    if relative_to is None:
        relative_to = datetime.now(timezone.utc)

    ella_ids = _resolve_ella_user_ids()

    # Walk forward (rows already chronological), pairing each mention
    # with Ella's NEXT user-id-authored message. Ella's self-posts that
    # aren't replies to a mention are not standalone exchanges — they're
    # only included as the reply half of a pair.
    exchanges: list[tuple[dict, dict | None]] = []
    i = 0
    while i < len(rows):
        msg = rows[i]
        text = msg.get("text") or ""
        if _is_ella_mention(text, ella_ids):
            reply = None
            j = i + 1
            while j < len(rows):
                cand = rows[j]
                if (cand.get("slack_user_id") or "") in ella_ids:
                    reply = cand
                    break
                j += 1
            exchanges.append((msg, reply))
            # Skip past the reply we just paired so a chain of replies
            # doesn't get double-counted as a reply to a later mention.
            i = (j + 1) if reply is not None else (i + 1)
        else:
            i += 1

    if not exchanges:
        return ""

    # Take the LAST n exchanges (most recent first chronologically).
    exchanges = exchanges[-n_exchanges:]

    # Collect display-name resolution targets across both halves of each
    # pair in one batched DB call.
    user_ids: set[str] = set()
    for mention, reply in exchanges:
        if mention.get("slack_user_id"):
            user_ids.add(mention["slack_user_id"])
        if reply and reply.get("slack_user_id"):
            user_ids.add(reply["slack_user_id"])
    db = get_client()
    name_map = _batch_resolve_names(db, sorted(user_ids))
    # Resolve Ella's display name too — _batch_resolve_names doesn't
    # know about Ella (her identity comes from SLACK_USER_TOKEN, not
    # from clients/team_members), so the reply lines would render her
    # raw user_id without this.
    for eid in ella_ids:
        if eid not in name_map:
            name_map[eid] = "Ella"

    blocks: list[str] = []
    for mention, reply in exchanges:
        block_lines = [
            _render_mention_exchange_line(mention, name_map, relative_to, "user"),
        ]
        if reply is not None:
            block_lines.append(
                _render_mention_exchange_line(reply, name_map, relative_to, "ella")
            )
        else:
            block_lines.append("ella: (no reply yet)")
        blocks.append("\n".join(block_lines))

    rendered = "\n----\n".join(blocks)

    # Soft cap. If the rendered text exceeds max_chars (e.g. one mention
    # message was huge), drop the oldest block(s) and prepend a marker
    # so Sonnet knows there was more.
    if len(rendered) <= max_chars:
        return rendered
    truncated_blocks: list[str] = []
    running = 0
    for block in reversed(blocks):
        # +6 for the "\n----\n" separator on subsequent blocks.
        added = len(block) + (6 if truncated_blocks else 0)
        if running + added > max_chars:
            break
        truncated_blocks.append(block)
        running += added
    truncated_blocks.reverse()
    return (
        "[...earlier exchanges truncated...]\n----\n"
        + "\n----\n".join(truncated_blocks)
    )


def _resolve_ella_user_ids() -> set[str]:
    """Return the set of Ella's resolved Slack user_ids (bot + human
    when configured). Same env-var-driven resolution
    `realtime_ingest.detect_at_mentions` uses, fail-soft on errors so
    the @ handler never crashes when Slack auth.test is briefly
    unavailable."""
    ids: set[str] = set()
    for env_var in ("SLACK_BOT_TOKEN", "SLACK_USER_TOKEN"):
        token = os.environ.get(env_var)
        if not token:
            continue
        try:
            uid = get_user_id_for_token(token)
        except Exception as exc:
            logger.warning(
                "fetch_recent_at_mention_exchanges: failed to resolve %s: %s",
                env_var,
                exc,
            )
            continue
        if uid:
            ids.add(uid)
    return ids


def _is_ella_mention(text: str, ella_ids: set[str]) -> bool:
    if not text or not ella_ids:
        return False
    mentions = _SLACK_MENTION_RE.findall(text)
    return any(uid in ella_ids for uid in mentions)


def _render_mention_exchange_line(
    msg: dict[str, Any],
    name_map: dict[str, str],
    relative_to: datetime,
    label: str,
) -> str:
    """Format one message of an exchange. Caps per-message text at 800
    chars so a single huge message can't blow the per-exchange budget."""
    stamp = _et_stamp(msg.get("sent_at"))
    sent_dt = _parse_utc(msg.get("sent_at"))
    if sent_dt is not None:
        delta = _format_time_ago(int((relative_to - sent_dt).total_seconds()))
        stamp = f"{stamp} — {delta}"
    uid = msg.get("slack_user_id") or "?"
    display = name_map.get(uid, uid)
    text = (msg.get("text") or "").replace("\n", " ").strip()
    if len(text) > 800:
        text = text[:800] + "..."
    return f"[{stamp}] {label} ({display}): {text}"


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
