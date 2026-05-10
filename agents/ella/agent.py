"""Ella (Slack Bot V1) — entry point.

`respond_to_mention(event_data)` is the function the Slack interface
layer calls when Ella is @mentioned. The flow:

  1. Start an `agent_runs` row via `shared.logging.start_agent_run`
     with the real speaker's identity stamped into `trigger_metadata`
     (Task 1 of Batch 1.5 — V1 collapsed the speaker into the
     channel-mapped client; V2 keeps them distinct).
  2. Resolve the speaker (real @-mention author) via
     `agents.ella.identity` and the channel-mapped client (for
     retrieval scoping) separately.
  3. Retrieve context via `agents.ella.retrieval` using the channel-
     mapped client's id.
  4. Build the system prompt via `agents.ella.prompts` with both the
     speaker and the channel-mapped client passed in.
  5. Call Claude via `_call_claude`.
  6. Detect the [ESCALATE] marker and route accordingly.
  7. End the agent_run with terminal status and return `EllaResponse`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from agents.ella.escalation import escalate
from agents.ella.identity import SpeakerIdentity, resolve_speaker_identity
from agents.ella.prompts import build_system_prompt
from agents.ella.retrieval import (
    ContextBundle,
    fetch_recent_channel_context,
    retrieve_context_for_client,
)
from shared.claude_client import complete
from shared.db import get_client
from shared.logging import end_agent_run, logger, start_agent_run

# Literal token Ella is instructed (in the system prompt) to prefix
# every escalation response with. Detection is start-of-response,
# case-sensitive, exact bracket form — see prompts.py § WHAT YOU
# ESCALATE. The marker is stripped before the response text is stored
# on the agent_runs row, written to escalations.context, or returned
# to the handler.
_ESCALATION_MARKER = "[ESCALATE]"


@dataclass(frozen=True)
class EllaResponse:
    """What `respond_to_mention` returns for the Slack interface to render."""

    response_text: str
    confidence: float
    escalated: bool
    escalation_reason: str | None = None
    escalation_id: str | None = None
    agent_run_id: str | None = None


def respond_to_mention(event_data: dict[str, Any]) -> EllaResponse:
    """Handle one Slack @mention. See module docstring."""
    speaker = resolve_speaker_identity(event_data.get("user"))
    run_id = start_agent_run(
        agent_name="ella",
        trigger_type="slack_mention",
        trigger_metadata=_redact_event(event_data, speaker),
        input_summary=(event_data.get("text") or "")[:200],
    )
    try:
        return _run(event_data, speaker, run_id)
    except Exception as exc:
        logger.exception("ella.respond_to_mention failed: %s", exc)
        end_agent_run(run_id, status="error", error_message=str(exc))
        raise


def _run(event_data: dict[str, Any], speaker: SpeakerIdentity, run_id: str) -> EllaResponse:
    channel_id = event_data.get("channel")
    channel_client = _resolve_channel_client(channel_id)
    if channel_client is None:
        # Pilot channels should always have a resolvable client —
        # `slack_channels.client_id` is set per channel. If we see
        # one anyway, log and skip rather than crash.
        reason = f"no_client_for_channel:{channel_id}"
        logger.warning("Ella: %s", reason)
        end_agent_run(run_id, status="skipped", output_summary=reason)
        return EllaResponse(
            response_text="",
            confidence=0.0,
            escalated=False,
            agent_run_id=run_id,
        )

    query_text = event_data.get("text") or ""
    context = _retrieve_context(channel_client["id"], query_text)

    # Stitch the primary CSM dict onto the client dict so prompts.py
    # has a single bag of profile data to render from. ContextBundle
    # stays the canonical retrieval shape; the prompt just needs the
    # flat view.
    client_for_prompt = dict(channel_client)
    client_for_prompt["primary_csm"] = context.primary_csm

    recent_channel_context = _fetch_recent_context_for_event(event_data)
    system_prompt = build_system_prompt(
        client_for_prompt,
        context.chunks,
        speaker=speaker,
        recent_channel_context=recent_channel_context,
    )
    response_text, confidence = _call_claude(
        system_prompt, query_text, context, run_id=run_id
    )

    client_text, handoff_context = _detect_and_strip_escalation(response_text)
    if handoff_context is not None:
        # Marker found anywhere in the response. `client_text` is what
        # the client sees; `handoff_context` is the advisor-facing
        # paragraph Ella wrote after [ESCALATE]. Stored on
        # escalations.context.handoff_reasoning so a reviewing CSM
        # sees Ella's framing of the handoff (V1 lost this).
        escalation_id = escalate(
            reason="ella_escalated",
            context={
                "query_text": query_text,
                "ella_response": client_text,
                "handoff_reasoning": handoff_context,
                "client_id": channel_client["id"],
                "speaker": _speaker_to_dict(speaker),
                "event": _redact_event(event_data, speaker),
            },
            client_id=channel_client["id"],
            agent_run_id=run_id,
        )
        end_agent_run(
            run_id,
            status="escalated",
            output_summary=f"escalated to advisor (escalation_id={escalation_id})",
            confidence_score=confidence,
        )
        return EllaResponse(
            response_text=client_text,
            confidence=confidence,
            escalated=True,
            escalation_reason="ella_escalated",
            escalation_id=escalation_id,
            agent_run_id=run_id,
        )

    end_agent_run(
        run_id,
        status="success",
        output_summary=response_text[:200],
        confidence_score=confidence,
    )
    return EllaResponse(
        response_text=response_text,
        confidence=confidence,
        escalated=False,
        agent_run_id=run_id,
    )


# ---------------------------------------------------------------------------
# Claude + retrieval seams
# ---------------------------------------------------------------------------


def _retrieve_context(client_id: str, query_text: str) -> ContextBundle:
    """Thin wrapper over `retrieve_context_for_client`. Kept as an
    internal helper so the agent's test seam is stable when we tune
    retrieval parameters (k, include_global, filters)."""
    return retrieve_context_for_client(client_id, query_text)


def _call_claude(
    system_prompt: str,
    user_text: str,
    context: ContextBundle,
    *,
    run_id: str | None = None,
) -> tuple[str, float]:
    """Call Claude with Ella's system prompt and the user's question.

    Returns `(response_text, confidence)`. The response text is
    returned raw — including the [ESCALATE] marker if Ella emitted
    one — so `_run` can route on the marker and strip it before the
    text flows further. Confidence is a coarse telemetry signal, not
    the gate: 1.0 for direct answers, 0.0 when the marker is present.

    `run_id` is passed through so token counts and cost land on the
    correct `agent_runs` row.
    """
    result = complete(
        system=system_prompt,
        messages=[{"role": "user", "content": user_text}],
        run_id=run_id,
    )
    text = result.text.strip()
    confidence = 0.0 if _ESCALATION_MARKER in text else 1.0
    return text, confidence


def _detect_and_strip_escalation(response_text: str) -> tuple[str, str | None]:
    """Find the first `[ESCALATE]` anywhere in the response and split.

    Returns `(client_text, handoff_context)`. If the marker is found,
    `client_text` is everything before the marker (rstripped of
    trailing whitespace) and `handoff_context` is everything after
    (lstripped). If the marker is absent, returns `(response_text, None)`.

    Batch 1.5 change: V1 only matched the marker at the start of the
    response (after `.lstrip()`). The audit surfaced 2 production
    runs where Ella generated client-facing text + `\\n[ESCALATE]\\n` +
    handoff text, and the leaked handoff text reached the client.
    The looser detector catches both shapes — start-of-response and
    mid-response — at the cost of also stripping conversational
    references to the literal token in Ella's own text. That's an
    accepted trade-off; the marker is a control token and the prompt
    instructs Ella not to use it in prose anyway.
    """
    idx = response_text.find(_ESCALATION_MARKER)
    if idx < 0:
        return response_text, None
    before = response_text[:idx].rstrip()
    after = response_text[idx + len(_ESCALATION_MARKER):].lstrip()
    return before, after


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fetch_recent_context_for_event(event_data: dict[str, Any]) -> str:
    """Thin wrapper around `fetch_recent_channel_context` so the agent's
    test seam is stable when we tune N or the budget."""
    channel = event_data.get("channel")
    trigger_ts = event_data.get("ts") or event_data.get("event_ts")
    if not channel or not trigger_ts:
        return ""
    return fetch_recent_channel_context(channel, before_ts=trigger_ts)


def _resolve_channel_client(slack_channel_id: str | None) -> dict[str, Any] | None:
    """Look up the active client mapped to this Slack channel.

    Retrieval scope is the channel's client regardless of who's
    speaking — Ella answers questions about THIS client's curriculum
    + calls, even when a team_member is the one asking. The speaker
    identity is resolved separately (see `agents.ella.identity`) for
    prompt addressing.
    """
    if not slack_channel_id:
        return None
    db = get_client()
    chan = (
        db.table("slack_channels")
        .select("client_id")
        .eq("slack_channel_id", slack_channel_id)
        .execute()
    )
    rows = chan.data or []
    if not rows or not rows[0].get("client_id"):
        return None
    client_id = rows[0]["client_id"]
    client = (
        db.table("clients")
        .select("*")
        .eq("id", client_id)
        .is_("archived_at", "null")
        .execute()
    )
    return client.data[0] if client.data else None


def _speaker_to_dict(speaker: SpeakerIdentity) -> dict[str, Any]:
    return {
        "slack_user_id": speaker.slack_user_id,
        "display_name": speaker.display_name,
        "role": speaker.role,
        "client_id": speaker.client_id,
        "team_member_id": speaker.team_member_id,
    }


def _redact_event(
    event_data: dict[str, Any], speaker: SpeakerIdentity | None = None
) -> dict[str, Any]:
    """Keep only fields useful for logging; drop Slack payload bulk.

    `is_team_test` is included when the Slack handler stamps it onto
    the event so we can later filter team-test runs out of client
    interaction metrics.

    Batch 1.5: also adds `real_author_role`, `real_author_name`,
    `real_author_id` so future analytics on `agent_runs.trigger_metadata`
    can see the real @-mention author rather than the V1 impersonated
    channel-client.
    """
    keys = ("user", "channel", "ts", "thread_ts", "event_ts", "is_team_test")
    out: dict[str, Any] = {k: event_data.get(k) for k in keys if event_data.get(k) is not None}
    if speaker is not None and speaker.slack_user_id:
        out["real_author_role"] = speaker.role
        out["real_author_name"] = speaker.display_name
        out["real_author_id"] = speaker.client_id or speaker.team_member_id
    return out
