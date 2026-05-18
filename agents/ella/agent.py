"""Ella agent module (unified-path rewrite, 2026-05-18 PM).

There is no longer a separate reactive @-mention path. Every message
— @-mention or passive observation — flows through the realtime
ingest fork → `passive_monitor.evaluate_passive_trigger` →
`passive_dispatch.persist_passive_evaluation`. The @-mention is a
signal the decision Haiku weighs, not a routing fork.

What remains here:

- `respond_to_mention(event_data)` — kept so legacy callers (e.g.
  `slack_handler.handle_slack_event`) still resolve, but it is no
  longer wired to the Slack webhook (`api/slack_events.py` no longer
  dispatches to it). It is now a thin adapter over the SAME one path:
  build a `PassiveTriggerPayload` (with `is_ella_mentioned=True`),
  evaluate + persist, return an `EllaResponse` summary. This guarantees
  no second evaluation / no double-fire even if something still calls
  it.
- `respond_to_passive_trigger(pending_row)` — what the per-minute
  Sonnet cron (`api/passive_ella_cron.py`) calls when draining
  `pending_ella_responses`. Pure Sonnet generation + post; no
  escalation decisioning (the decision Haiku already decided).

The bare-mention short-circuit, the canned general-inquiry openers,
and `handle_passive_general_inquiry` are removed — bare mentions now
flow through the decision Haiku in full context.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from agents.ella.identity import SpeakerIdentity, resolve_speaker_identity
from agents.ella.passive_dispatch import persist_passive_evaluation
from agents.ella.passive_monitor import (
    PassiveTriggerPayload,
    evaluate_passive_trigger,
)
from agents.ella.prompts import build_system_prompt
from agents.ella.retrieval import (
    ContextBundle,
    fetch_recent_channel_context,
    retrieve_context_for_client,
)
from shared.claude_client import complete
from shared.db import get_client
from shared.logging import end_agent_run, logger, start_agent_run


@dataclass(frozen=True)
class EllaResponse:
    """What `respond_to_mention` returns for legacy callers to render."""

    response_text: str
    confidence: float
    escalated: bool
    escalation_reason: str | None = None
    escalation_id: str | None = None
    agent_run_id: str | None = None


# ---------------------------------------------------------------------------
# Legacy @-mention entry — now a thin adapter over the ONE path
# ---------------------------------------------------------------------------


def respond_to_mention(event_data: dict[str, Any]) -> EllaResponse:
    """Adapter kept for legacy callers. Routes the @-mention through the
    unified passive pipeline so there is exactly one evaluation per
    message. `api/slack_events.py` no longer calls this — all messages
    arrive via the realtime ingest fork instead.
    """
    speaker = resolve_speaker_identity(event_data.get("user"))
    channel_id = event_data.get("channel")
    channel_client = _resolve_channel_client(channel_id)
    if channel_client is None:
        reason = f"no_client_for_channel:{channel_id}"
        logger.warning("Ella: %s", reason)
        return EllaResponse(
            response_text="",
            confidence=0.0,
            escalated=False,
            agent_run_id=None,
        )

    # Author type from resolved speaker role (advisor → team_member,
    # everything else treated as client so the @-mention is evaluated).
    author_type = "team_member" if speaker and speaker.role == "advisor" else "client"

    payload = PassiveTriggerPayload(
        slack_channel_id=channel_client.get("slack_channel_id")
        or event_data.get("channel"),
        triggering_message_ts=event_data.get("ts") or event_data.get("event_ts") or "",
        triggering_message_slack_user_id=event_data.get("user") or "",
        triggering_message_text=event_data.get("text") or "",
        author_type=author_type,
        channel_client_id=channel_client["id"],
        is_ella_mentioned=True,  # this entry point is, by definition, a mention
    )
    evaluation = evaluate_passive_trigger(payload)
    result = persist_passive_evaluation(evaluation)

    decision = evaluation.decision
    escalated = decision.decision == "acknowledge_and_escalate"
    response_text = decision.ack_text if escalated else ""
    return EllaResponse(
        response_text=response_text or "",
        confidence=0.0 if escalated else 1.0,
        escalated=escalated,
        escalation_reason="ella_acknowledged_and_escalated" if escalated else None,
        escalation_id=result.get("escalation_id"),
        agent_run_id=result.get("agent_run_id"),
    )


# ---------------------------------------------------------------------------
# Sonnet drain — called by the per-minute cron
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PassiveResponseResult:
    """What `respond_to_passive_trigger` returns for the cron to log and
    write back to pending_ella_responses."""

    response_text: str
    agent_run_id: str
    posted: bool
    slack_error: str | None = None


def respond_to_passive_trigger(
    pending_row: dict[str, Any],
) -> PassiveResponseResult:
    """Substantive Sonnet response. The decision Haiku already decided
    this message warrants a Sonnet answer (`respond` / `sonnet`,
    written into the pending row as `respond_substantive` for the
    unchanged cron). Pure generation + post — no escalation.
    """
    from shared.slack_post import post_message

    synthetic_event = {
        "channel": pending_row["slack_channel_id"],
        "ts": pending_row["triggering_message_ts"],
        "user": pending_row["triggering_message_slack_user_id"],
        "text": "",
    }
    speaker = resolve_speaker_identity(synthetic_event["user"])
    channel_client = _resolve_channel_client(synthetic_event["channel"])
    if channel_client is None:
        run_id = start_agent_run(
            agent_name="ella",
            trigger_type="passive_substantive",
            trigger_metadata={
                "pending_id": pending_row.get("id"),
                "slack_channel_id": synthetic_event["channel"],
                "skip_reason": "no_client_for_channel",
            },
        )
        end_agent_run(run_id, status="skipped", output_summary="no_client_for_channel")
        return PassiveResponseResult(
            response_text="",
            agent_run_id=run_id,
            posted=False,
            slack_error="no_client_for_channel",
        )

    triggering_text = _fetch_message_text(
        synthetic_event["channel"], synthetic_event["ts"]
    )
    query_text = triggering_text or ""

    run_id = start_agent_run(
        agent_name="ella",
        trigger_type="passive_substantive",
        trigger_metadata={
            "pending_id": pending_row.get("id"),
            "slack_channel_id": synthetic_event["channel"],
            "triggering_message_ts": synthetic_event["ts"],
            "triggering_message_slack_user_id": synthetic_event["user"],
            "real_author_role": speaker.role,
            "real_author_name": speaker.display_name,
            "real_author_id": speaker.client_id or speaker.team_member_id,
        },
        input_summary=query_text[:200],
    )

    try:
        context = _retrieve_context(channel_client["id"], query_text)
        client_for_prompt = dict(channel_client)
        client_for_prompt["primary_csm"] = context.primary_csm
        recent_channel_context = fetch_recent_channel_context(
            synthetic_event["channel"],
            before_ts=synthetic_event["ts"],
        )
        system_prompt = build_system_prompt(
            client_for_prompt,
            context.chunks,
            speaker=speaker,
            recent_channel_context=recent_channel_context,
        )
        response_text, confidence = _call_claude(
            system_prompt, query_text, context, run_id=run_id
        )
        post_result = post_message(synthetic_event["channel"], response_text)
        end_agent_run(
            run_id,
            status="success",
            output_summary=response_text[:200],
            confidence_score=confidence,
        )
        return PassiveResponseResult(
            response_text=response_text,
            agent_run_id=run_id,
            posted=bool(post_result["ok"]),
            slack_error=post_result.get("slack_error"),
        )
    except Exception as exc:
        logger.exception("respond_to_passive_trigger failed: %s", exc)
        end_agent_run(run_id, status="error", error_message=str(exc))
        raise


# ---------------------------------------------------------------------------
# Shared helpers (used by respond_to_passive_trigger + the adapter)
# ---------------------------------------------------------------------------


def _retrieve_context(client_id: str, query_text: str) -> ContextBundle:
    return retrieve_context_for_client(client_id, query_text)


def _call_claude(
    system_prompt: str,
    user_text: str,
    context: ContextBundle,
    *,
    run_id: str | None = None,
) -> tuple[str, float]:
    """Call Sonnet — pure response generation. No `[ESCALATE]` token
    (removed yesterday) and no `[FALLBACK_TO_SONNET]` (removed today);
    the decision Haiku is the single decider. Confidence is a coarse
    telemetry signal (1.0 for a generated answer)."""
    result = complete(
        system=system_prompt,
        messages=[{"role": "user", "content": user_text}],
        run_id=run_id,
    )
    return result.text.strip(), 1.0


def _resolve_channel_client(slack_channel_id: str | None) -> dict[str, Any] | None:
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


def _fetch_message_text(slack_channel_id: str, slack_ts: str) -> str:
    db = get_client()
    resp = (
        db.table("slack_messages")
        .select("text")
        .eq("slack_channel_id", slack_channel_id)
        .eq("slack_ts", slack_ts)
        .limit(1)
        .execute()
    )
    rows = resp.data or []
    if not rows:
        return ""
    return rows[0].get("text") or ""


def _speaker_to_dict(speaker: SpeakerIdentity) -> dict[str, Any]:
    return {
        "slack_user_id": speaker.slack_user_id,
        "display_name": speaker.display_name,
        "role": speaker.role,
        "client_id": speaker.client_id,
        "team_member_id": speaker.team_member_id,
    }
