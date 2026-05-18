"""Slack event handler for Ella.

`handle_slack_event(event_payload)` is the bridge between the Slack
Events API webhook and the agent core. It parses the inbound event,
gates on channel-mapping, resolves the *real* speaker (Task 1), and
hands the enriched event to `agent.respond_to_mention`.

V2-Batch-1.5 routing rules (post wrong-name fix):

  - `app_mention` events from the bot user_id, OR `message` events
    where the human Ella user_id (`SLACK_USER_TOKEN`'s account) is
    @-mentioned, both flow through this handler. The webhook layer
    in `api/slack_events.py` shapes message-event payloads into the
    `app_mention` event format so this handler only has one shape
    to deal with. Dual-trigger detection itself lives in
    `ingestion/slack/realtime_ingest.py` (Task 7).
  - The channel must have a row in `slack_channels` whose `client_id`
    is set. Otherwise no-op (not a client channel).
  - The asker can be a client (responds normally with that client's
    KB context), an advisor / team_member (responds using the
    CHANNEL's client KB context — retrieval scope is the channel,
    not the asker — with `is_team_test=True` stamped for filtering),
    or unresolvable (still responds, but with a generic warm-fallback
    prompt path).

The handler does NOT rewrite `event["user"]` to the channel-mapped
client anymore. That was the V1 impersonation bug per the audit; the
real user_id flows through to the agent, which resolves speaker
identity for the prompt while retrieval stays scoped to the channel's
client.
"""

from __future__ import annotations

import re
from typing import Any

from agents.ella.agent import respond_to_mention
from agents.ella.identity import resolve_speaker_identity
from shared.db import get_client
from shared.logging import logger
from shared.slack_format import markdown_to_mrkdwn

# Slack mention tokens look like `<@U12345>` or `<@U12345|name>`. We
# strip them out before passing the text to the agent so the model
# isn't distracted by the bot id.
_MENTION_RE = re.compile(r"<@[UW][A-Z0-9]+(?:\|[^>]+)?>")


def handle_slack_event(event_payload: dict[str, Any]) -> dict[str, Any]:
    """Process one inbound Slack event. See module docstring.

    Accepts either the full Events API outer payload (with
    `{"type": "event_callback", "event": {...}}`) or the inner
    event dict directly. The handler unwraps as needed.
    """
    event = _unwrap_event(event_payload)

    if event.get("type") != "app_mention":
        return _no_response(reason="not_app_mention")

    channel_id = event.get("channel")
    user_id = event.get("user")
    thread_ts = event.get("thread_ts") or event.get("ts")
    raw_text = event.get("text") or ""
    text = _strip_mentions(raw_text)

    if not channel_id or not user_id:
        return _no_response(reason="missing_channel_or_user")

    db = get_client()

    channel_row = _lookup_channel(db, channel_id)
    if channel_row is None or channel_row.get("client_id") is None:
        # Either the channel isn't in our mirror yet, or it isn't
        # mapped to a client (internal channel). Either way, Ella
        # has nothing to say.
        logger.info("ella.slack_handler: channel %s not mapped to a client", channel_id)
        return _no_response(reason="channel_not_client_mapped")

    speaker = resolve_speaker_identity(user_id)
    is_team_test = speaker.role == "advisor"

    # Build the event the agent core will see. Real user_id flows
    # through verbatim — no impersonation. The agent resolves the
    # channel-client itself for retrieval scoping, so we don't need
    # to thread it here, but stamping `is_team_test` saves a duplicate
    # role lookup downstream.
    agent_event = dict(event)
    agent_event["text"] = text
    agent_event["thread_ts"] = thread_ts
    if is_team_test:
        agent_event["is_team_test"] = True

    response = respond_to_mention(agent_event)

    # Convert any standard Markdown in Claude's reply into Slack mrkdwn
    # before handing off to the post path. The system prompt asks for
    # mrkdwn natively; the converter is the safety net for cases where
    # Claude reverts to **Markdown** anyway. agent_runs.output_summary
    # stores the raw response (set in agent.py) so this transformation
    # only affects what the user sees in Slack — historical raw output
    # stays available for debugging and future non-Slack consumers.
    slack_text = markdown_to_mrkdwn(response.response_text)

    return {
        "responded": True,
        "text": slack_text,
        "thread_ts": thread_ts,
        "channel_id": channel_id,
        "escalated": response.escalated,
        "escalation_id": response.escalation_id,
        "agent_run_id": response.agent_run_id,
        "is_team_test": is_team_test,
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _unwrap_event(payload: dict[str, Any]) -> dict[str, Any]:
    """Return the inner event dict.

    Slack's Events API wraps app events as
    `{"type": "event_callback", "event": {...}}`. Some upstream
    layers (n8n nodes, test fixtures) hand us the inner dict
    directly. Accept both."""
    if payload.get("type") == "event_callback" and isinstance(
        payload.get("event"), dict
    ):
        return payload["event"]
    return payload


def _strip_mentions(text: str) -> str:
    """Remove all `<@U...>` mention tokens and collapse whitespace."""
    cleaned = _MENTION_RE.sub("", text or "")
    return re.sub(r"\s+", " ", cleaned).strip()


def _lookup_channel(db, slack_channel_id: str) -> dict[str, Any] | None:
    resp = (
        db.table("slack_channels")
        .select("slack_channel_id,client_id")
        .eq("slack_channel_id", slack_channel_id)
        .execute()
    )
    rows = resp.data or []
    return rows[0] if rows else None


def _no_response(*, reason: str) -> dict[str, Any]:
    """Shape returned when Ella stays silent."""
    return {
        "responded": False,
        "reason": reason,
        "text": "",
        "thread_ts": None,
        "channel_id": None,
        "escalated": False,
        "escalation_id": None,
        "agent_run_id": None,
        "is_team_test": False,
    }
