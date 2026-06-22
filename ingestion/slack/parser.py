"""Parse raw Slack message events into structured `SlackMessageRecord`s.

Slack's conversations.history / conversations.replies payloads are
mostly consistent but carry subtype variation we need to normalize:

  - Top-level user message: `{type: 'message', user, text, ts, ...}`
  - Thread reply: same shape plus `thread_ts` pointing at the parent.
  - Bot message: `subtype: 'bot_message'`, no `user`, has `bot_id`.
  - Workflow submission: `subtype: 'file_share'` / `'workflow_step'` /
    similar, sometimes attached to a Workflow Builder app.

Domain subtype tagging (`message_subtype` column):

  - `accountability_submission` — heuristic match on workflow messages
    mentioning accountability.
  - `nps_submission` — workflow messages containing an NPS-style
    numeric rating + free text.

Author-type vocabulary (`author_type` column):
  - `client`, `team_member`, `bot`, `workflow`, `unknown` (legacy)
  - `ella` (Ella V2 Batch 1) — Ella's user-token-backed account when
    `ella_user_id` is passed and the message's `user` matches it.
    Tagged distinctly so future logic can both retrieve her past
    messages for context AND skip them as response triggers.

Delete events (`subtype='message_deleted'`) are intentionally ignored
to preserve audit trail: the delete event payload has the previous
text in `previous_message`, not in `text`, and overwriting the existing
row would erase the original ingestion. We treat delete as a system
event that doesn't change the historical record.

The ingestion spec (`docs/fulfillment/metadata-conventions.md`) pins the
behavior; parser is the single place that decodes a raw Slack event.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from shared.logging import logger

# Tight, evidence-driven tag heuristics. We keep the substring set
# small — false positives downstream (a call_summary accidentally
# labeled `nps_submission`) are worse than missing some on first pass.
_ACCOUNTABILITY_MARKERS: tuple[str, ...] = (
    "accountability submission",
    "weekly accountability",
    "did you complete your accountability",
    "accountability form",
)
_NPS_MARKERS: tuple[str, ...] = (
    "nps survey",
    "net promoter",
    "how likely are you to recommend",
)
_NPS_SCORE_RE = re.compile(r"\b(?:10|[0-9])\s*/\s*10\b", re.IGNORECASE)


@dataclass(frozen=True)
class SlackMessageRecord:
    """Structured view of one Slack message ready to upsert into
    `slack_messages`."""

    slack_channel_id: str
    slack_ts: str
    slack_thread_ts: str | None
    slack_user_id: str
    author_type: str
    text: str
    message_type: str
    message_subtype: str | None
    raw_payload: dict[str, Any]
    sent_at: datetime

    # Not stored directly — used by the pipeline to decide whether to
    # follow this message into its thread via conversations.replies.
    is_thread_parent: bool = field(default=False)


def parse_message(
    event: dict[str, Any],
    *,
    channel_id: str,
    client_user_ids: set[str] | None = None,
    team_user_ids: set[str] | None = None,
    ella_user_id: str | None = None,
) -> SlackMessageRecord | None:
    """Return a `SlackMessageRecord` for one Slack event, or None if
    the event isn't a message we want to store.

    `client_user_ids` and `team_user_ids` are the pre-fetched sets of
    known Slack user ids for client and team authors; passed in by
    the pipeline so author-type resolution is O(1) per message.

    `ella_user_id` (Ella V2 Batch 1) is the Slack user_id behind
    `SLACK_USER_TOKEN` — when set, messages from that user resolve
    to `author_type='ella'` ahead of any other resolution branch.
    Defaulted to None for backwards compatibility with the local
    backfill (which doesn't pass it today; it does once the pipeline
    threads it through, but None remains a safe input).

    Events we skip (return None):
      - `type != 'message'` (reactions, channel_join notices that
        ever actually arrive via history — rare)
      - `subtype == 'channel_join'` / `'channel_leave'` and other
        system messages (including `'message_deleted'`, see module
        docstring)
    """
    if event.get("type") != "message":
        return None

    subtype = event.get("subtype")
    if subtype in _SYSTEM_SUBTYPES:
        return None

    slack_ts = event.get("ts")
    if not slack_ts:
        logger.warning("skipping Slack event with no ts: %s", event)
        return None

    thread_ts = event.get("thread_ts")
    # A top-level message that has replies sets `thread_ts == ts` and
    # exposes `reply_count`. For pipeline purposes: a "thread parent"
    # is any message with reply_count > 0, regardless of thread_ts.
    reply_count = int(event.get("reply_count") or 0)
    is_thread_parent = reply_count > 0

    # If thread_ts equals ts, that's a parent, not a reply. Treat
    # slack_thread_ts as null on the parent row so queries for
    # `slack_thread_ts IS NULL` return top-level messages without
    # double-counting parents.
    if thread_ts == slack_ts:
        thread_ts = None

    user_id, author_type = _resolve_author(
        event,
        client_user_ids=client_user_ids or set(),
        team_user_ids=team_user_ids or set(),
        ella_user_id=ella_user_id,
    )

    text = event.get("text") or ""
    message_type = _pick_message_type(event, thread_ts)
    message_subtype = _pick_message_subtype(event, text)
    sent_at = _ts_to_datetime(slack_ts)

    return SlackMessageRecord(
        slack_channel_id=channel_id,
        slack_ts=slack_ts,
        slack_thread_ts=thread_ts,
        slack_user_id=user_id,
        author_type=author_type,
        text=text,
        message_type=message_type,
        message_subtype=message_subtype,
        raw_payload=event,
        sent_at=sent_at,
        is_thread_parent=is_thread_parent,
    )


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


# System-generated messages that shouldn't land in slack_messages —
# ingestion cares about human and workflow messages, not Slack's own
# channel-management chatter. `message_deleted` is included to preserve
# the audit trail: the delete event would otherwise overwrite the
# existing row's text with `previous_message` data, erasing the original.
_SYSTEM_SUBTYPES: frozenset[str] = frozenset({
    "channel_join",
    "channel_leave",
    "channel_topic",
    "channel_purpose",
    "channel_name",
    "channel_archive",
    "channel_unarchive",
    "pinned_item",
    "unpinned_item",
    "reminder_add",
    "bot_add",
    "bot_remove",
    "message_deleted",
})


def _resolve_author(
    event: dict[str, Any],
    *,
    client_user_ids: set[str],
    team_user_ids: set[str],
    ella_user_id: str | None = None,
) -> tuple[str, str]:
    """Return `(slack_user_id, author_type)` for a message event.

    Resolution order:
      1. Explicit user field:
         a. Matches `ella_user_id` → `ella` (checked FIRST so that
            even if Ella's user account is also in `team_members`,
            she gets her own author_type)
         b. In client_user_ids → `client`
         c. In team_user_ids → `team_member`
         d. Workflow-sourced → `workflow`
         e. Bot indicators (subtype/bot_id) → `bot`
         f. Otherwise → `unknown`
      2. bot_id (no user field) → `bot` (or `workflow`)
      3. Fallback → `unknown` with synthetic id
    """
    subtype = event.get("subtype")
    user_id = event.get("user")
    bot_id = event.get("bot_id")
    app_id = event.get("app_id")

    # Workflow Builder messages sometimes have a user (the submitter)
    # and sometimes don't. If the message came from a Workflow app,
    # classify as 'workflow' regardless of the user field.
    is_workflow = (
        subtype in {"workflow_step", "workflow_bot"}
        or (app_id and "workflow" in str(event.get("bot_profile", {}).get("name", "")).lower())
    )

    if user_id:
        # Ella check first: she's also reachable as `team_member` if
        # her Slack account is in team_members.slack_user_id, but the
        # downstream logic needs to distinguish her posts from a
        # human team member's. Ella always wins.
        if ella_user_id and user_id == ella_user_id:
            return user_id, "ella"
        if user_id in client_user_ids:
            return user_id, "client"
        if user_id in team_user_ids:
            return user_id, "team_member"
        if is_workflow:
            return user_id, "workflow"
        # Unknown human — subtype might tell us it's a bot that
        # happens to carry a user_id (shouldn't happen but handle)
        if subtype == "bot_message" or bot_id:
            return user_id, "bot"
        return user_id, "unknown"

    if bot_id:
        # Many bot messages lack a `user` field.
        if is_workflow:
            return bot_id, "workflow"
        return bot_id, "bot"

    # Last-resort fallback — use message `ts` as a per-message unique
    # id so we can still insert and satisfy NOT NULL.
    return "__no_author__", "unknown"


def _pick_message_type(event: dict[str, Any], thread_ts: str | None) -> str:
    """Map a Slack event to our `message_type` vocabulary.

    Vocabulary from `docs/schema/slack_messages.md`:
      - `message` (default, top-level)
      - `thread_reply`
      - `bot_message`
      - `workflow_submission`
    """
    subtype = event.get("subtype")
    if subtype == "bot_message":
        return "bot_message"
    if subtype in {"workflow_step", "workflow_bot"}:
        return "workflow_submission"
    if thread_ts is not None:
        return "thread_reply"
    return "message"


def _pick_message_subtype(event: dict[str, Any], text: str) -> str | None:
    """Domain subtype: accountability_submission, nps_submission, or None.

    The ingestion convention (`docs/fulfillment/metadata-conventions.md`)
    is that downstream CSM Co-Pilot queries filter on these, so we
    apply the heuristic once at ingest time. Keep the pattern set
    tight — false positives are worse than misses.
    """
    text_lower = text.lower()
    for marker in _ACCOUNTABILITY_MARKERS:
        if marker in text_lower:
            return "accountability_submission"
    for marker in _NPS_MARKERS:
        if marker in text_lower:
            return "nps_submission"
    if _NPS_SCORE_RE.search(text) and any(
        m in text_lower for m in ("recommend", "survey", "nps")
    ):
        return "nps_submission"
    return None


def _ts_to_datetime(ts: str) -> datetime:
    """Slack timestamps are `seconds.microseconds` strings."""
    return datetime.fromtimestamp(float(ts), tz=timezone.utc)
