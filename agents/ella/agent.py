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

import random
from dataclasses import dataclass
from typing import Any

from agents.ella.escalation import escalate
from agents.ella.escalation_routing import (
    fire_escalation_dms,
    resolve_escalation_recipients,
)
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

# Bare-mention threshold. After mention-stripping, anything shorter
# than this (in trimmed chars) is treated as a bare @-mention — we
# skip the LLM call and return a canned warm opener. The threshold
# is liberal: "@Ella hi" (2 chars after strip) and "@Ella" (0 chars)
# both go through this path; "@Ella how" (3 chars) does too;
# "@Ella what's up" (8 chars) doesn't and gets a full response.
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

# Passive general-inquiry openers (Batch 2.3). Used when the Haiku
# decision is `respond_general_inquiry` — the client looks like
# they're asking for help in a general way but no KB chunks address
# their specific question. Warm + short, no answer attempt.
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

    # Task 6 of Batch 1.5: bare @-mentions skip the LLM and return a
    # canned warm opener. Passing an empty user message to the LLM was
    # an error path in V1 (audit run 88556dea raised
    # `messages.0: user messages must have non-empty content`).
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
    """Return a canned warm response without an LLM call.

    Logged as `agent_runs` with `trigger_type='bare_mention'` and
    minimal token usage so the per-run telemetry stays clean and the
    cost reporter sees these for free.
    """
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
    display name is a placeholder (e.g., '(unverified)').
    """
    if (
        speaker.role in ("client", "advisor")
        and speaker.display_name
        and not speaker.display_name.startswith("(")
    ):
        first_name = speaker.display_name.split()[0]
        return random.choice(_BARE_OPENERS_WITH_NAME).format(name=first_name)
    return random.choice(_BARE_OPENERS_NO_NAME)


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
        # Fan DMs out to Scott + primary CSM. Reactive path keeps its
        # in-channel client-facing ack (without the <@advisor> mention
        # per the 2026-05-14 prompt edit) — the backend DMs are the
        # reliable notification channel and the in-channel mention
        # would double-ping.
        recipients = resolve_escalation_recipients(context.primary_csm)
        dm_results = fire_escalation_dms(
            recipients=recipients,
            slack_channel_id=channel_client.get("slack_channel_id")
            or event_data.get("channel"),
            triggering_message_ts=event_data.get("ts")
            or event_data.get("event_ts")
            or "",
            reasoning=handoff_context,
            path="reactive",
            channel_client_id=channel_client["id"],
        )
        end_agent_run(
            run_id,
            status="escalated",
            output_summary=_format_reactive_escalation_summary(
                escalation_id, dm_results
            ),
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


@dataclass(frozen=True)
class PassiveResponseResult:
    """What `respond_to_passive_trigger` / `_handle_passive_general_inquiry`
    return for the cron to log and write back to pending_ella_responses."""

    response_text: str
    agent_run_id: str
    posted: bool
    slack_error: str | None = None


def respond_to_passive_trigger(
    pending_row: dict[str, Any],
) -> PassiveResponseResult:
    """Substantive passive response. Reuses speaker resolution + KB
    retrieval + Sonnet generation from the reactive path so behavior
    stays consistent across @-mention and passive-trigger paths.

    `pending_row` is the row from `pending_ella_responses` (from the
    cron). We reconstruct the synthetic event the reactive path
    expects: channel + ts + user.

    Posts via `shared.slack_post.post_message` (main-channel-only,
    no thread). Returns a result dataclass for the cron to write back.
    """
    from shared.slack_post import post_message  # local import to keep top tight

    synthetic_event = {
        "channel": pending_row["slack_channel_id"],
        "ts": pending_row["triggering_message_ts"],
        "user": pending_row["triggering_message_slack_user_id"],
        "text": "",  # not used by the prompt path; KB retrieval reads
                    # context instead. See note below.
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

    # The triggering message itself is what we want Ella to respond to.
    # Pull the text from slack_messages (the ingest layer wrote it
    # there before the queue insert).
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
        client_text, handoff_context = _detect_and_strip_escalation(response_text)
        if handoff_context is not None:
            # Sonnet decided to escalate inside its generation even
            # though the Haiku gate already routed substantive. Honor
            # the escalation: write the escalations row, do NOT post
            # client-facing on the passive path (the spec is explicit
            # — passive escalations are backend-only). Fan DMs out to
            # Scott + primary CSM via the shared helper so this branch
            # routes identically to the Haiku-side escalate decision.
            escalation_id = escalate(
                reason="ella_escalated_from_passive_substantive",
                context={
                    "query_text": query_text,
                    "ella_response": client_text,
                    "handoff_reasoning": handoff_context,
                    "client_id": channel_client["id"],
                    "speaker": _speaker_to_dict(speaker),
                    "pending_id": pending_row.get("id"),
                },
                client_id=channel_client["id"],
                agent_run_id=run_id,
            )
            recipients = resolve_escalation_recipients(context.primary_csm)
            dm_results = fire_escalation_dms(
                recipients=recipients,
                slack_channel_id=synthetic_event["channel"],
                triggering_message_ts=synthetic_event["ts"],
                reasoning=handoff_context,
                path="passive",
                channel_client_id=channel_client["id"],
            )
            end_agent_run(
                run_id,
                status="escalated",
                output_summary=_format_reactive_escalation_summary(
                    escalation_id, dm_results
                ),
                confidence_score=confidence,
            )
            return PassiveResponseResult(
                response_text="",
                agent_run_id=run_id,
                posted=False,
                slack_error="sonnet_side_escalation",
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
        logger.exception(
            "respond_to_passive_trigger failed: %s", exc
        )
        end_agent_run(run_id, status="error", error_message=str(exc))
        raise


def handle_passive_general_inquiry(
    pending_row: dict[str, Any],
) -> PassiveResponseResult:
    """Canned warm response for the `respond_general_inquiry` decision.
    Zero LLM cost. Posts a randomized opener to the channel and writes
    an agent_runs row with trigger_type='passive_general_inquiry'.
    """
    from shared.slack_post import post_message  # local import

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
    """First-name'd warm opener for resolved speakers, generic fallback
    for unresolvable / placeholder display names. Mirrors the
    `_pick_bare_response` decision shape from the @-mention path."""
    if (
        speaker.role in ("client", "advisor")
        and speaker.display_name
        and not speaker.display_name.startswith("(")
    ):
        first_name = speaker.display_name.split()[0]
        return random.choice(_PASSIVE_GENERAL_OPENERS_WITH_NAME).format(
            name=first_name
        )
    return random.choice(_PASSIVE_GENERAL_OPENERS_NO_NAME)


def _fetch_message_text(slack_channel_id: str, slack_ts: str) -> str:
    """Resolve the triggering message's text from `slack_messages`.

    The cron is the only caller. The realtime ingest layer wrote the
    row before the queue insert, so the row exists by the time the
    cron drains. Returns empty string on miss (network blip, ingest
    failure, etc.) — the substantive path tolerates empty queries
    via KB retrieval over an empty embedding.
    """
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
    """Build the `agent_runs.output_summary` line for a reactive (or
    Sonnet-side passive) escalation. Format mirrors the passive
    Haiku-decided branch so the audit dashboard's Output column
    renders the same way across all three escalation entry points.
    """
    if not dm_results:
        return (
            f"escalated via DM; no_recipients; escalation_id={escalation_id}"
        )
    parts = [
        f"{r['label']}={'ok' if r['dm_ok'] else 'fail'}" for r in dm_results
    ]
    return (
        f"escalated via DM; {', '.join(parts)}; "
        f"escalation_id={escalation_id}"
    )


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
