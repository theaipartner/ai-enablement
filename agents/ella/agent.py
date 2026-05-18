"""Ella (Slack Bot V1) — entry point.

`respond_to_mention(event_data)` is the function the Slack interface
layer calls when Ella is @mentioned. The flow (unified-decision
architecture — the reactive path now runs through the same decision
Haiku as the passive path; Sonnet no longer self-escalates mid-
generation):

  1. Start an `agent_runs` row with the real speaker's identity.
  2. Resolve the speaker and the channel-mapped client separately.
  3. Retrieve KB context + recent channel context.
  4. Call the decision Haiku (`passive_monitor.decide_passive_response`).
  5. Route on the decision:
       skip               -> generic "this one's for your advisor" ack
       respond_haiku_self -> response Haiku (fallback -> Sonnet)
       respond_via_sonnet -> Sonnet generation
       digest_only        -> polite ack + escalations row + CSM DMs
                             (the ONLY real-time CSM-DM path in the new
                             architecture — @-mentions create a client
                             expectation passive observation does not)
  6. Independent of the decision: if digest_flag, write a
     pending_digest_items row so Scott + Drake's daily digest sees it.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

from agents.ella.escalation import escalate
from agents.ella.escalation_routing import (
    fire_escalation_dms,
    resolve_escalation_recipients,
)
from agents.ella.identity import SpeakerIdentity, resolve_speaker_identity
from agents.ella.passive_dispatch import insert_digest_item
from agents.ella.passive_monitor import decide_passive_response
from agents.ella.prompts import build_system_prompt
from agents.ella.retrieval import (
    ContextBundle,
    fetch_recent_channel_context,
    retrieve_context_for_client,
)
from shared.claude_client import complete
from shared.db import get_client
from shared.logging import end_agent_run, logger, start_agent_run

# Bare-mention threshold. After mention-stripping, anything shorter
# than this (in trimmed chars) is treated as a bare @-mention — we
# skip the LLM call and return a canned warm opener.
_BARE_MENTION_MAX_CHARS = 5

# Warm openers used when Ella is @-mentioned with no substantive
# follow-up. Kept varied so the response doesn't feel scripted.
_BARE_OPENERS_WITH_NAME = (
    "Hey {name} — what's up?",
    "Hi {name}, what can I help with?",
    "Hey {name}, what do you need?",
    "Hi {name} — fire away.",
)
_BARE_OPENERS_NO_NAME = (
    "Hey — what's up?",
    "Hi, what can I help with?",
    "What do you need?",
    "Fire away.",
)

# Passive general-inquiry openers — retained for the unchanged
# per-minute cron's `respond_general_inquiry` dispatch path (the new
# decision tree never emits this decision, but the cron + handler
# stay in place per spec § What's NOT in this spec).
_PASSIVE_GENERAL_OPENERS_WITH_NAME = (
    "Hey {name} — I'm around. What's going on?",
    "Hi {name}, here if you need me. What do you need?",
    "Hey {name} — what can I help with?",
    "Hi {name}, fire away when you're ready.",
)
_PASSIVE_GENERAL_OPENERS_NO_NAME = (
    "Hey — I'm around. What's going on?",
    "Here if you need me — what do you need?",
    "What can I help with?",
    "Fire away when you're ready.",
)


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
    stripped_text = (event_data.get("text") or "").strip()

    # Bare @-mentions skip the LLM and return a canned warm opener.
    if len(stripped_text) < _BARE_MENTION_MAX_CHARS:
        return _handle_bare_mention(event_data, speaker, stripped_text)

    run_id = start_agent_run(
        agent_name="ella",
        trigger_type="slack_mention",
        trigger_metadata=_redact_event(event_data, speaker),
        input_summary=stripped_text[:200],
    )
    try:
        return _run(event_data, speaker, run_id)
    except Exception as exc:
        logger.exception("ella.respond_to_mention failed: %s", exc)
        end_agent_run(run_id, status="error", error_message=str(exc))
        raise


def _handle_bare_mention(
    event_data: dict[str, Any],
    speaker: SpeakerIdentity,
    stripped_text: str,
) -> EllaResponse:
    """Return a canned warm response without an LLM call."""
    run_id = start_agent_run(
        agent_name="ella",
        trigger_type="bare_mention",
        trigger_metadata=_redact_event(event_data, speaker),
        input_summary=stripped_text[:200],
    )
    response = _pick_bare_response(speaker)
    end_agent_run(
        run_id,
        status="success",
        output_summary=response[:200],
        confidence_score=1.0,
    )
    return EllaResponse(
        response_text=response,
        confidence=1.0,
        escalated=False,
        agent_run_id=run_id,
    )


def _pick_bare_response(speaker: SpeakerIdentity) -> str:
    """Random warm opener — uses the speaker's first name when known,
    falls back to no-name variants when role is unresolvable or the
    display name is a placeholder."""
    if (
        speaker.role in ("client", "advisor")
        and speaker.display_name
        and not speaker.display_name.startswith("(")
    ):
        first_name = speaker.display_name.split()[0]
        return random.choice(_BARE_OPENERS_WITH_NAME).format(name=first_name)
    return random.choice(_BARE_OPENERS_NO_NAME)


def _run(
    event_data: dict[str, Any], speaker: SpeakerIdentity, run_id: str
) -> EllaResponse:
    channel_id = event_data.get("channel")
    channel_client = _resolve_channel_client(channel_id)
    if channel_client is None:
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
    recent_channel_context = _fetch_recent_context_for_event(event_data)

    # Decision Haiku — the single escalation/answer decider for both
    # the reactive and passive paths.
    decision = decide_passive_response(
        triggering_message=query_text,
        recent_context=recent_channel_context,
        kb_results=context.chunks,
    )

    first_name = _speaker_first_name(speaker, channel_client)
    advisor_first = _advisor_first_name(context.primary_csm)

    # Decision-independent digest flagging (digest_only always flags;
    # the others flag when Haiku set digest_flag).
    def _flag_digest(ella_responded: bool) -> None:
        if not decision.digest_flag:
            return
        insert_digest_item(
            run_id=run_id,
            slack_channel_id=channel_client.get("slack_channel_id")
            or event_data.get("channel"),
            triggering_message_ts=event_data.get("ts")
            or event_data.get("event_ts")
            or "",
            triggering_message_slack_user_id=event_data.get("user"),
            client_id=channel_client["id"],
            message_text=query_text,
            haiku_decision=decision.decision,
            haiku_reasoning=decision.reasoning,
            digest_category=decision.digest_category,
            ella_responded=ella_responded,
        )

    if decision.decision == "skip":
        ack = (
            f"Hey {first_name}, I think this one's for {advisor_first} — "
            f"they'll pick it up."
        )
        _post(channel_client, event_data, ack)
        _flag_digest(ella_responded=False)
        end_agent_run(
            run_id,
            status="success",
            output_summary=f"reactive skip: {decision.reasoning[:160]}",
            confidence_score=1.0,
        )
        return EllaResponse(
            response_text=ack,
            confidence=1.0,
            escalated=False,
            agent_run_id=run_id,
        )

    if decision.decision == "respond_haiku_self":
        from agents.ella.digest_response import generate_response

        resp = generate_response(
            payload=SimpleNamespace(triggering_message_text=query_text),
            kb_chunks=context.chunks,
            recent_context=recent_channel_context,
            primary_csm=context.primary_csm,
            channel_client=channel_client,
        )
        if not resp.fallback_to_sonnet:
            _post(channel_client, event_data, resp.response_text)
            _flag_digest(ella_responded=True)
            end_agent_run(
                run_id,
                status="success",
                output_summary=resp.response_text[:200],
                confidence_score=1.0,
            )
            return EllaResponse(
                response_text=resp.response_text,
                confidence=1.0,
                escalated=False,
                agent_run_id=run_id,
            )
        # fallthrough to Sonnet generation below

    if decision.decision in ("respond_via_sonnet", "respond_haiku_self"):
        # respond_haiku_self only reaches here when the response Haiku
        # asked to fall back. Either way: Sonnet generates the reply.
        client_for_prompt = dict(channel_client)
        client_for_prompt["primary_csm"] = context.primary_csm
        system_prompt = build_system_prompt(
            client_for_prompt,
            context.chunks,
            speaker=speaker,
            recent_channel_context=recent_channel_context,
        )
        response_text, confidence = _call_claude(
            system_prompt, query_text, context, run_id=run_id
        )
        _post(channel_client, event_data, response_text)
        _flag_digest(ella_responded=True)
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

    # decision.decision == 'digest_only' — the only reactive path that
    # fires a real-time CSM DM. @-mention creates a client expectation
    # of response that passive observation does not.
    ack = "Let me grab someone for this one — your advisor will take care " "of you."
    _post(channel_client, event_data, ack)
    escalation_id = escalate(
        reason="ella_escalated",
        context={
            "query_text": query_text,
            "ella_response": ack,
            "handoff_reasoning": decision.reasoning,
            "client_id": channel_client["id"],
            "speaker": _speaker_to_dict(speaker),
            "event": _redact_event(event_data, speaker),
            "haiku_decision": "digest_only",
        },
        client_id=channel_client["id"],
        agent_run_id=run_id,
    )
    recipients = resolve_escalation_recipients(context.primary_csm)
    dm_results = fire_escalation_dms(
        recipients=recipients,
        slack_channel_id=channel_client.get("slack_channel_id")
        or event_data.get("channel"),
        triggering_message_ts=event_data.get("ts") or event_data.get("event_ts") or "",
        reasoning=decision.reasoning,
        path="reactive",
        channel_client_id=channel_client["id"],
    )
    # digest_only always flags — Scott + Drake's digest also sees
    # @-mention escalations.
    insert_digest_item(
        run_id=run_id,
        slack_channel_id=channel_client.get("slack_channel_id")
        or event_data.get("channel"),
        triggering_message_ts=event_data.get("ts") or event_data.get("event_ts") or "",
        triggering_message_slack_user_id=event_data.get("user"),
        client_id=channel_client["id"],
        message_text=query_text,
        haiku_decision="digest_only",
        haiku_reasoning=decision.reasoning,
        digest_category=decision.digest_category or "other",
        ella_responded=False,
    )
    end_agent_run(
        run_id,
        status="escalated",
        output_summary=_format_reactive_escalation_summary(escalation_id, dm_results),
        confidence_score=0.0,
    )
    return EllaResponse(
        response_text=ack,
        confidence=0.0,
        escalated=True,
        escalation_reason="ella_escalated",
        escalation_id=escalation_id,
        agent_run_id=run_id,
    )


# ---------------------------------------------------------------------------
# Claude + retrieval seams
# ---------------------------------------------------------------------------


def _retrieve_context(client_id: str, query_text: str) -> ContextBundle:
    """Thin wrapper over `retrieve_context_for_client`. Kept as an
    internal helper so the agent's test seam is stable."""
    return retrieve_context_for_client(client_id, query_text)


def _call_claude(
    system_prompt: str,
    user_text: str,
    context: ContextBundle,
    *,
    run_id: str | None = None,
) -> tuple[str, float]:
    """Call Sonnet with Ella's system prompt and the user's question.

    Returns `(response_text, confidence)`. Sonnet is now pure response
    generation — the decision Haiku already made the escalate / answer
    call upstream, so there is no `[ESCALATE]` token to detect or
    strip. Confidence is a coarse telemetry signal (1.0 for a
    generated answer).
    """
    result = complete(
        system=system_prompt,
        messages=[{"role": "user", "content": user_text}],
        run_id=run_id,
    )
    return result.text.strip(), 1.0


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _post(
    channel_client: dict[str, Any],
    event_data: dict[str, Any],
    text: str,
) -> dict[str, Any]:
    """Post a client-facing message to the channel (main channel, no
    thread). Fire-and-forget per shared.slack_post contract."""
    from shared.slack_post import post_message

    channel = channel_client.get("slack_channel_id") or event_data.get("channel")
    return post_message(channel, text)


def _speaker_first_name(
    speaker: SpeakerIdentity, channel_client: dict[str, Any]
) -> str:
    if speaker.display_name and not speaker.display_name.startswith("("):
        return speaker.display_name.split()[0]
    full = channel_client.get("full_name") or ""
    return full.split()[0] if full else "there"


def _advisor_first_name(primary_csm: dict[str, Any] | None) -> str:
    full = (primary_csm or {}).get("full_name") or ""
    return full.split()[0] if full else "your advisor"


def _fetch_recent_context_for_event(event_data: dict[str, Any]) -> str:
    """Thin wrapper around `fetch_recent_channel_context` so the agent's
    test seam is stable when we tune N or the budget."""
    channel = event_data.get("channel")
    trigger_ts = event_data.get("ts") or event_data.get("event_ts")
    if not channel or not trigger_ts:
        return ""
    return fetch_recent_channel_context(channel, before_ts=trigger_ts)


def _resolve_channel_client(slack_channel_id: str | None) -> dict[str, Any] | None:
    """Look up the active client mapped to this Slack channel."""
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


@dataclass(frozen=True)
class PassiveResponseResult:
    """What `respond_to_passive_trigger` / `handle_passive_general_inquiry`
    return for the cron to log and write back to pending_ella_responses."""

    response_text: str
    agent_run_id: str
    posted: bool
    slack_error: str | None = None


def respond_to_passive_trigger(
    pending_row: dict[str, Any],
) -> PassiveResponseResult:
    """Substantive passive response (Sonnet). Reuses speaker resolution
    + KB retrieval + Sonnet generation from the reactive path.

    The decision Haiku already decided this message warrants a Sonnet
    answer (decision `respond_via_sonnet`, written into the pending
    row as `respond_substantive` for the unchanged cron). Sonnet is
    now pure generation — no mid-generation escalation.

    Posts via `shared.slack_post.post_message` (main-channel-only,
    no thread). Returns a result dataclass for the cron to write back.
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


def handle_passive_general_inquiry(
    pending_row: dict[str, Any],
) -> PassiveResponseResult:
    """Canned warm response for the legacy `respond_general_inquiry`
    decision. Retained for the unchanged per-minute cron's dispatch
    table; the new decision tree never emits this decision."""
    from shared.slack_post import post_message

    channel_id = pending_row["slack_channel_id"]
    user_id = pending_row["triggering_message_slack_user_id"]
    speaker = resolve_speaker_identity(user_id)

    run_id = start_agent_run(
        agent_name="ella",
        trigger_type="passive_general_inquiry",
        trigger_metadata={
            "pending_id": pending_row.get("id"),
            "slack_channel_id": channel_id,
            "triggering_message_ts": pending_row["triggering_message_ts"],
            "triggering_message_slack_user_id": user_id,
            "real_author_role": speaker.role,
            "real_author_name": speaker.display_name,
            "real_author_id": speaker.client_id or speaker.team_member_id,
        },
        input_summary="(passive general inquiry — no input text)",
    )
    response = _pick_passive_general_opener(speaker)
    post_result = post_message(channel_id, response)
    end_agent_run(
        run_id,
        status="success",
        output_summary=response[:200],
        confidence_score=1.0,
    )
    return PassiveResponseResult(
        response_text=response,
        agent_run_id=run_id,
        posted=bool(post_result["ok"]),
        slack_error=post_result.get("slack_error"),
    )


def _pick_passive_general_opener(speaker: SpeakerIdentity) -> str:
    if (
        speaker.role in ("client", "advisor")
        and speaker.display_name
        and not speaker.display_name.startswith("(")
    ):
        first_name = speaker.display_name.split()[0]
        return random.choice(_PASSIVE_GENERAL_OPENERS_WITH_NAME).format(name=first_name)
    return random.choice(_PASSIVE_GENERAL_OPENERS_NO_NAME)


def _fetch_message_text(slack_channel_id: str, slack_ts: str) -> str:
    """Resolve the triggering message's text from `slack_messages`."""
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


def _format_reactive_escalation_summary(
    escalation_id: str, dm_results: list[dict[str, Any]]
) -> str:
    """Build the `agent_runs.output_summary` line for a reactive
    digest_only escalation."""
    if not dm_results:
        return f"escalated via DM; no_recipients; escalation_id={escalation_id}"
    parts = [f"{r['label']}={'ok' if r['dm_ok'] else 'fail'}" for r in dm_results]
    return f"escalated via DM; {', '.join(parts)}; " f"escalation_id={escalation_id}"


def _redact_event(
    event_data: dict[str, Any], speaker: SpeakerIdentity | None = None
) -> dict[str, Any]:
    """Keep only fields useful for logging; drop Slack payload bulk."""
    keys = ("user", "channel", "ts", "thread_ts", "event_ts", "is_team_test")
    out: dict[str, Any] = {
        k: event_data.get(k) for k in keys if event_data.get(k) is not None
    }
    if speaker is not None and speaker.slack_user_id:
        out["real_author_role"] = speaker.role
        out["real_author_name"] = speaker.display_name
        out["real_author_id"] = speaker.client_id or speaker.team_member_id
    return out
