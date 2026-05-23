"""Ella agent module (split-path architecture, 2026-05-23).

The @-mention path and the passive-monitoring path are SEPARATE again,
restoring the proven pre-2026-05-18 reactive @ behavior. See
`docs/reports/ella-at-mention-archaeology.md` for the recovery target
and `docs/specs/ella-at-mention-passive-split.md` for the split design.

Two entry points:

- `handle_at_mention(payload)` — the restored synchronous @-mention
  handler. Called from `ingestion.slack.realtime_ingest._maybe_dispatch_passive_monitor`
  when `is_ella_mentioned=True`. Retrieves KB chunks + recent context,
  calls Sonnet ONCE with chunks visible, parses the structured-JSON
  output `{response_text, escalate, handoff_reasoning}`, posts the
  answer or the ack+escalation. NO classifier; NO Haiku enum; NO
  `acknowledge_and_escalate` navigation rule. The four escalation
  categories (judgment-call / emotional / money / no-good-context) are
  inline in the system prompt; Sonnet decides with chunks in hand.

- `respond_to_passive_trigger(pending_row)` — what the per-minute Sonnet
  cron (`api/passive_ella_cron.py`) calls when draining
  `pending_ella_responses`. After the 2026-05-23 split, passive
  monitoring no longer posts in-channel, so nothing new lands in the
  queue going forward; this function stays as a belt-and-suspenders
  no-op so any stale queued rows drain silently without violating the
  no-passive-voice rule.

Legacy adapter `respond_to_mention(event_data)` is preserved for
`slack_handler.handle_slack_event` (the test seam) and now routes
through `handle_at_mention` so callers get the new behavior.
"""

from __future__ import annotations

import json
import random
import re
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from agents.ella.escalation import escalate as ella_escalate
from agents.ella.escalation_routing import (
    fire_escalation_dms,
    resolve_escalation_recipients,
)
from agents.ella.identity import SpeakerIdentity, resolve_speaker_identity
from agents.ella.passive_dispatch import insert_digest_item
from agents.ella.passive_monitor import PassiveTriggerPayload
from agents.ella.prompts import build_system_prompt
from agents.ella.retrieval import (
    ContextBundle,
    fetch_recent_channel_context,
    retrieve_context_for_client,
)
from shared.claude_client import complete
from shared.db import get_client
from shared.logging import end_agent_run, logger, start_agent_run
from shared.slack_post import post_message

# Sonnet 4.6 — default model for the @ response, matching the proven
# pre-2026-05-18 behavior.
_AT_MENTION_MODEL = "claude-sonnet-4-6"
_AT_MENTION_MAX_TOKENS = 1024

# Bare-mention threshold (chars). After stripping the @-mention syntax,
# anything shorter goes to a canned warm opener — no LLM call.
_BARE_MENTION_MAX_CHARS = 5

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

# The four-category escalation logic + JSON output contract appended to
# the base prompt for the @ handler. Recovered from the pre-2026-05-18
# `_BASE_PROMPT` (see `docs/reports/ella-at-mention-archaeology.md`)
# and modernized: instead of an inline `[ESCALATE]` token, Sonnet
# returns structured JSON the parser routes on.
_AT_MENTION_EXTENSION = """# WHAT YOU ESCALATE

You escalate — meaning you respond with a short warm ack and route the question to the client's advisor — when:

- The client is asking for a personal judgment call about their specific business situation (which offer to launch, whether to fire a client, how to price). Surface the relevant frameworks if you have them, but the call is the advisor's.
- The client seems frustrated, stuck, or upset. Don't try to defuse it yourself. Get their advisor looped in.
- The client is asking about billing, refunds, contracts, account changes, or anything money- or commitment-related.
- The client is asking something where you don't have good context and a wrong answer would matter.

NONE of the following are escalation triggers on their own:
- The word "module" appearing in the question. "What's covered in module 3" / "what does the sales module cover" are CURRICULUM CONTENT questions, not navigation questions — answer them from the KB chunks.
- A long question, a multi-part question, or a question phrased in many ways.
- A clean factual program/curriculum/process question, even when the KB chunks only partially match — paraphrase what you have, name the gap honestly, do NOT bail to the advisor by default.

# FIRM AFTER FIRST

Check the recent channel context (provided below in the RECENT CHANNEL CONTEXT section, when available) for any prior message from you (Ella) on the same topic that ended in an escalation. If you find one, do NOT re-engage substantively on the same topic. Route harder ("worth picking this up with the advisor directly") rather than restating the same answer. One pass; then you step back.

# OUTPUT FORMAT

Return STRICT JSON. No prose around it. No code fences. No commentary.

{
  "response_text": "<the Slack-formatted message text the client will see — your answer OR the warm ack>",
  "escalate": true | false,
  "handoff_reasoning": "<when escalate=true: one-paragraph handoff note for the advisor explaining the question and what you saw. when escalate=false: null>"
}

Field rules:

- `response_text` is ALWAYS set and is what gets posted to Slack. When `escalate=false` it's the answer; when `escalate=true` it's the short warm ack (1-2 sentences, no @-mentions of the advisor — the backend handles notifying).
- `escalate` is a boolean. `true` ONLY when one of the four categories above genuinely fires.
- `handoff_reasoning` is required when `escalate=true`; null when `escalate=false`. It is NEVER shown to the client — it's the advisor-facing context.

Address the client by first name when natural. Use Slack mrkdwn (single asterisks for bold, never double). No headings."""


@dataclass(frozen=True)
class EllaResponse:
    """What `respond_to_mention` returns for legacy callers to render."""

    response_text: str
    confidence: float
    escalated: bool
    escalation_reason: str | None = None
    escalation_id: str | None = None
    agent_run_id: str | None = None


@dataclass(frozen=True)
class AtMentionResult:
    """Structured outcome of `handle_at_mention` for tests + telemetry."""

    agent_run_id: str | None
    trigger_type: str  # 'slack_mention' | 'bare_mention'
    response_text: str
    escalated: bool
    escalation_id: str | None
    posted: bool
    status: str  # 'success' | 'escalated' | 'error' | 'skipped'


# ---------------------------------------------------------------------------
# Restored @ handler (synchronous; one Sonnet call; structured-JSON escalation)
# ---------------------------------------------------------------------------


def handle_at_mention(payload: PassiveTriggerPayload) -> AtMentionResult:
    """Synchronous @-mention handler.

    Routed by `realtime_ingest._maybe_dispatch_passive_monitor` when
    `is_ella_mentioned=True`. Builds context, calls Sonnet ONCE with
    KB chunks visible, parses the JSON output, and either posts the
    answer or runs the ack+escalation fan-out. Never raises — degrades
    gracefully on internal failures so the webhook handler stays
    fail-soft.
    """
    speaker = resolve_speaker_identity(payload.triggering_message_slack_user_id)
    stripped_text = _strip_mention_syntax(payload.triggering_message_text or "")

    if len(stripped_text) < _BARE_MENTION_MAX_CHARS:
        return _handle_bare_mention(payload, speaker, stripped_text)

    channel_client = _resolve_channel_client(payload.slack_channel_id)
    if channel_client is None:
        run_id = start_agent_run(
            agent_name="ella",
            trigger_type="slack_mention",
            trigger_metadata=_at_mention_trigger_metadata(payload, speaker),
            input_summary=(payload.triggering_message_text or "")[:200],
        )
        end_agent_run(
            run_id,
            status="skipped",
            output_summary=f"no_client_for_channel:{payload.slack_channel_id}",
        )
        return AtMentionResult(
            agent_run_id=run_id,
            trigger_type="slack_mention",
            response_text="",
            escalated=False,
            escalation_id=None,
            posted=False,
            status="skipped",
        )

    run_id = start_agent_run(
        agent_name="ella",
        trigger_type="slack_mention",
        trigger_metadata=_at_mention_trigger_metadata(payload, speaker),
        input_summary=(payload.triggering_message_text or "")[:200],
    )

    try:
        context = _retrieve_context(channel_client["id"], payload.triggering_message_text or "")
        client_for_prompt = dict(channel_client)
        client_for_prompt["primary_csm"] = context.primary_csm
        recent_channel_context = fetch_recent_channel_context(
            payload.slack_channel_id,
            before_ts=payload.triggering_message_ts,
        )
        system_prompt = _build_at_mention_system_prompt(
            client_for_prompt,
            context.chunks,
            speaker=speaker,
            recent_channel_context=recent_channel_context,
        )
        try:
            parsed = _call_sonnet_for_at_mention(
                system_prompt,
                payload.triggering_message_text or "",
                run_id=run_id,
            )
        except Exception as exc:
            # Status-honesty fix: failed LLM calls land as status=error,
            # not silent success buried in output_summary. User-facing
            # behavior still degrades gracefully (a canned line is
            # posted) but the agent_runs row tells the truth.
            logger.warning(
                "handle_at_mention: Sonnet call failed channel=%s ts=%s: %s",
                payload.slack_channel_id,
                payload.triggering_message_ts,
                exc,
            )
            canned = (
                "I hit a hiccup answering that — let me get your advisor on this one."
            )
            post_message(payload.slack_channel_id, canned)
            end_agent_run(
                run_id,
                status="error",
                output_summary=f"sonnet_call_failed: {type(exc).__name__}",
                error_message=str(exc)[:2000],
            )
            return AtMentionResult(
                agent_run_id=run_id,
                trigger_type="slack_mention",
                response_text=canned,
                escalated=False,
                escalation_id=None,
                posted=True,
                status="error",
            )

        response_text = parsed["response_text"]
        escalate_flag = parsed["escalate"]
        handoff_reasoning = parsed["handoff_reasoning"]

        post_result = post_message(payload.slack_channel_id, response_text)
        posted = bool(post_result.get("ok"))

        if escalate_flag:
            escalation_id = _do_escalation_fanout(
                run_id=run_id,
                payload=payload,
                channel_client=channel_client,
                primary_csm=context.primary_csm,
                speaker=speaker,
                response_text=response_text,
                handoff_reasoning=handoff_reasoning or "",
            )
            end_agent_run(
                run_id,
                status="escalated",
                output_summary=response_text[:200],
                confidence_score=0.0,
            )
            return AtMentionResult(
                agent_run_id=run_id,
                trigger_type="slack_mention",
                response_text=response_text,
                escalated=True,
                escalation_id=escalation_id,
                posted=posted,
                status="escalated",
            )

        end_agent_run(
            run_id,
            status="success",
            output_summary=response_text[:200],
            confidence_score=1.0,
        )
        return AtMentionResult(
            agent_run_id=run_id,
            trigger_type="slack_mention",
            response_text=response_text,
            escalated=False,
            escalation_id=None,
            posted=posted,
            status="success",
        )
    except Exception as exc:
        logger.exception(
            "handle_at_mention: unhandled error channel=%s ts=%s: %s",
            payload.slack_channel_id,
            payload.triggering_message_ts,
            exc,
        )
        end_agent_run(
            run_id,
            status="error",
            output_summary=f"unhandled: {type(exc).__name__}",
            error_message=str(exc)[:2000],
        )
        return AtMentionResult(
            agent_run_id=run_id,
            trigger_type="slack_mention",
            response_text="",
            escalated=False,
            escalation_id=None,
            posted=False,
            status="error",
        )


def _handle_bare_mention(
    payload: PassiveTriggerPayload,
    speaker: SpeakerIdentity | None,
    stripped_text: str,
) -> AtMentionResult:
    """Bare @-mention (<5 chars after stripping mention syntax). Canned
    warm opener; no LLM call. Logged as `trigger_type='bare_mention'`."""
    run_id = start_agent_run(
        agent_name="ella",
        trigger_type="bare_mention",
        trigger_metadata=_at_mention_trigger_metadata(payload, speaker),
        input_summary=stripped_text[:200],
    )
    response = _pick_bare_response(speaker)
    post_result = post_message(payload.slack_channel_id, response)
    end_agent_run(
        run_id,
        status="success",
        output_summary=response[:200],
        confidence_score=1.0,
    )
    return AtMentionResult(
        agent_run_id=run_id,
        trigger_type="bare_mention",
        response_text=response,
        escalated=False,
        escalation_id=None,
        posted=bool(post_result.get("ok")),
        status="success",
    )


def _pick_bare_response(speaker: SpeakerIdentity | None) -> str:
    if (
        speaker
        and speaker.role in ("client", "advisor")
        and speaker.display_name
        and not speaker.display_name.startswith("(")
    ):
        first_name = speaker.display_name.split()[0]
        return random.choice(_BARE_OPENERS_WITH_NAME).format(name=first_name)
    return random.choice(_BARE_OPENERS_NO_NAME)


def _do_escalation_fanout(
    *,
    run_id: str,
    payload: PassiveTriggerPayload,
    channel_client: dict[str, Any],
    primary_csm: dict[str, Any] | None,
    speaker: SpeakerIdentity | None,
    response_text: str,
    handoff_reasoning: str,
) -> str | None:
    """Write the escalations row and fan DMs to Scott + primary advisor.
    Mirrors the pre-2026-05-18 reactive behavior but uses the modern
    `escalation_routing` helpers."""
    escalation_id = None
    try:
        escalation_id = ella_escalate(
            reason="ella_escalated",
            context={
                "query_text": payload.triggering_message_text,
                "ella_response": response_text,
                "handoff_reasoning": handoff_reasoning,
                "client_id": channel_client["id"],
                "speaker": _speaker_to_dict(speaker) if speaker else None,
                "is_ella_mentioned": True,
            },
            client_id=channel_client["id"],
            agent_run_id=run_id,
        )
    except Exception as exc:
        logger.warning(
            "handle_at_mention: escalations row write failed run_id=%s: %s",
            run_id,
            exc,
        )

    try:
        recipients = resolve_escalation_recipients(primary_csm)
        fire_escalation_dms(
            recipients=recipients,
            slack_channel_id=payload.slack_channel_id,
            triggering_message_ts=payload.triggering_message_ts,
            reasoning=handoff_reasoning,
            path="reactive",
            channel_client_id=channel_client["id"],
        )
    except Exception as exc:
        logger.warning(
            "handle_at_mention: escalation DM fan-out failed run_id=%s: %s",
            run_id,
            exc,
        )

    # Mirror the digest item so the daily digest sees escalations from
    # @-mention path too (matches the prior behavior where mention-path
    # escalations carried a digest entry).
    try:
        insert_digest_item(
            run_id=run_id,
            slack_channel_id=payload.slack_channel_id,
            triggering_message_ts=payload.triggering_message_ts,
            triggering_message_slack_user_id=payload.triggering_message_slack_user_id,
            client_id=channel_client["id"],
            message_text=payload.triggering_message_text,
            haiku_decision="at_mention/escalate",
            haiku_reasoning=handoff_reasoning,
            digest_category="other",
            ella_responded=False,
        )
    except Exception as exc:
        logger.warning(
            "handle_at_mention: digest item insert failed run_id=%s: %s",
            run_id,
            exc,
        )

    return escalation_id


# ---------------------------------------------------------------------------
# Prompt assembly + Sonnet call + JSON parse
# ---------------------------------------------------------------------------


def _build_at_mention_system_prompt(
    client_for_prompt: dict[str, Any],
    chunks: list,
    *,
    speaker: SpeakerIdentity | None,
    recent_channel_context: str,
) -> str:
    """@-handler system prompt: base prompt + restored four-category
    escalation logic + structured-JSON output contract."""
    base = build_system_prompt(
        client_for_prompt,
        chunks,
        speaker=speaker,
        recent_channel_context=recent_channel_context,
    )
    return base + "\n\n" + _AT_MENTION_EXTENSION


def _call_sonnet_for_at_mention(
    system_prompt: str,
    user_text: str,
    *,
    run_id: str | None,
) -> dict[str, Any]:
    """Call Sonnet and parse the structured-JSON output. Raises on API
    failure (caller handles status-honesty). The parser itself never
    raises: on malformed JSON it defaults to a safe "no escalation,
    treat raw text as response" shape — matching the old no-token
    behavior."""
    result = complete(
        system=system_prompt,
        messages=[{"role": "user", "content": user_text}],
        model=_AT_MENTION_MODEL,
        max_tokens=_AT_MENTION_MAX_TOKENS,
        run_id=run_id,
    )
    return _parse_at_mention_output(result.text)


def _parse_at_mention_output(raw: str) -> dict[str, Any]:
    """Parse the JSON output. On any failure return the raw text as the
    response with no escalation (matches the pre-2026-05-18 no-token
    behavior). Defensive: strips code fences, regex-falls-back to find
    the outermost {...} block."""
    safe = {
        "response_text": (raw or "").strip(),
        "escalate": False,
        "handoff_reasoning": None,
    }
    if not raw or not raw.strip():
        safe["response_text"] = (
            "I hit a hiccup answering that — let me get your advisor on this one."
        )
        return safe
    stripped = raw.strip()
    if stripped.startswith("```"):
        stripped = stripped.split("\n", 1)[1] if "\n" in stripped else stripped[3:]
        if stripped.endswith("```"):
            stripped = stripped[:-3]
        stripped = stripped.strip()
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", stripped)
        if not m:
            return safe
        try:
            parsed = json.loads(m.group(0))
        except json.JSONDecodeError:
            return safe
    if not isinstance(parsed, dict):
        return safe

    response_text = parsed.get("response_text")
    escalate_flag = bool(parsed.get("escalate"))
    handoff_reasoning = parsed.get("handoff_reasoning")

    if not isinstance(response_text, str) or not response_text.strip():
        # Malformed: keep raw as response; do NOT escalate (safer default).
        return safe

    if not isinstance(handoff_reasoning, str):
        handoff_reasoning = None
    if escalate_flag and (not handoff_reasoning or not handoff_reasoning.strip()):
        # Escalation requested without a reason — accept the escalation
        # but synthesize a minimal reasoning so the advisor gets context.
        handoff_reasoning = "(no reasoning provided)"

    return {
        "response_text": response_text.strip(),
        "escalate": escalate_flag,
        "handoff_reasoning": handoff_reasoning,
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


_MENTION_SYNTAX_PATTERN = re.compile(r"<@[UW][A-Z0-9]+>")


def _strip_mention_syntax(text: str) -> str:
    """Remove all `<@U...>` mention tokens from `text` and trim. Used to
    decide bare-mention vs substantive (so `<@Ella>` alone counts as
    bare, not substantive)."""
    return _MENTION_SYNTAX_PATTERN.sub("", text).strip()


def _at_mention_trigger_metadata(
    payload: PassiveTriggerPayload, speaker: SpeakerIdentity | None
) -> dict[str, Any]:
    return {
        "triggering_slack_channel_id": payload.slack_channel_id,
        "triggering_message_ts": payload.triggering_message_ts,
        "triggering_message_slack_user_id": payload.triggering_message_slack_user_id,
        "channel_client_id": payload.channel_client_id,
        "author_type": payload.author_type,
        "is_ella_mentioned": True,
        "real_author_role": speaker.role if speaker else None,
        "real_author_name": speaker.display_name if speaker else None,
        "real_author_id": (
            (speaker.client_id or speaker.team_member_id) if speaker else None
        ),
    }


# ---------------------------------------------------------------------------
# Legacy adapter — routes through the new @ handler
# ---------------------------------------------------------------------------


def respond_to_mention(event_data: dict[str, Any]) -> EllaResponse:
    """Legacy adapter kept for `slack_handler.handle_slack_event` (a test
    seam; the production webhook handler in `api/slack_events.py` no
    longer calls this). Routes through the new `handle_at_mention` so
    callers get the restored behavior."""
    channel_id = event_data.get("channel")
    channel_client = _resolve_channel_client(channel_id)
    channel_client_id = (
        channel_client["id"] if channel_client else (event_data.get("channel") or "")
    )

    speaker = resolve_speaker_identity(event_data.get("user"))
    author_type = "team_member" if speaker and speaker.role == "advisor" else "client"

    payload = PassiveTriggerPayload(
        slack_channel_id=channel_id or "",
        triggering_message_ts=event_data.get("ts") or event_data.get("event_ts") or "",
        triggering_message_slack_user_id=event_data.get("user") or "",
        triggering_message_text=event_data.get("text") or "",
        author_type=author_type,
        channel_client_id=channel_client_id,
        is_ella_mentioned=True,
    )
    result = handle_at_mention(payload)
    return EllaResponse(
        response_text=result.response_text,
        confidence=0.0 if result.escalated else 1.0,
        escalated=result.escalated,
        escalation_reason="ella_escalated" if result.escalated else None,
        escalation_id=result.escalation_id,
        agent_run_id=result.agent_run_id,
    )


# ---------------------------------------------------------------------------
# Passive Sonnet drain — neutered post-split (no in-channel voice)
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
    """Belt-and-suspenders no-op after the 2026-05-23 split. Passive
    monitoring no longer posts in client channels — the dispatch path
    stopped enqueueing rows here, but any stale rows already in
    `pending_ella_responses` would have been posted by the cron, which
    would violate the no-passive-voice rule. This function now logs a
    row as `status='skipped'` with `skip_reason='passive_voice_removed'`
    and returns without posting. Keep the function (the cron imports
    it) so the cron drains the queue silently."""
    run_id = start_agent_run(
        agent_name="ella",
        trigger_type="passive_substantive",
        trigger_metadata={
            "pending_id": pending_row.get("id"),
            "slack_channel_id": pending_row.get("slack_channel_id"),
            "triggering_message_ts": pending_row.get("triggering_message_ts"),
            "skip_reason": "passive_voice_removed",
        },
    )
    end_agent_run(
        run_id,
        status="skipped",
        output_summary="passive_voice_removed: post-split passive does not respond in-channel",
    )
    return PassiveResponseResult(
        response_text="",
        agent_run_id=run_id,
        posted=False,
        slack_error="passive_voice_removed",
    )


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _retrieve_context(client_id: str, query_text: str) -> ContextBundle:
    return retrieve_context_for_client(client_id, query_text)


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


def _speaker_to_dict(speaker: SpeakerIdentity) -> dict[str, Any]:
    return {
        "slack_user_id": speaker.slack_user_id,
        "display_name": speaker.display_name,
        "role": speaker.role,
        "client_id": speaker.client_id,
        "team_member_id": speaker.team_member_id,
    }
