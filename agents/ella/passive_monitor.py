"""Ella's unified decision module (unified-path rewrite, 2026-05-18 PM).

Public entry point: `evaluate_passive_trigger(payload)`. Called by the
realtime-ingest fork (`ingestion/slack/realtime_ingest.py`) for EVERY
human message in a passive-monitoring-enabled channel — there is no
separate reactive @-mention path anymore. The @-mention is a signal
the decision Haiku weighs (`payload.is_ella_mentioned`), not a routing
fork.

Pipeline (two gates, then one Haiku call with full context):

  1. Gate 1 — Global kill switch. `ELLA_PASSIVE_MONITORING_ENABLED`
     must be 'true'. Else silent skip, NO `agent_runs` row.
  2. Gate 2 — Author type. `client` and `team_member` are always
     evaluated (CSMs talk to Ella too). `ella` / `bot` / `workflow` /
     `unknown` skip — but WITH an `agent_runs` row for audit.
  3. Fetch recent channel messages (raw rows, includes Ella's posts).
  4. Build the KB embedding query from the combined conversation
     (recent messages + triggering message ×2).
  5. KB vector search using that combined query (context, not a gate).
  6. Resolve channel client + primary CSM + speaker identity.
  7. Decision Haiku — one call, full context, returns one of three
     decisions plus the independent digest flag.

Three decisions: `respond` (with `response_model` haiku|sonnet),
`acknowledge_and_escalate` (with Haiku-written `ack_text`), `skip`.
The old gates (CSM-directed, KB-relevance, firm-after-first,
bare-mention) are soft rules in the prompt now, not hardcoded.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from agents.ella.identity import resolve_speaker_identity
from agents.ella.retrieval import (
    build_kb_query_from_conversation,
    fetch_recent_channel_context,
    fetch_recent_channel_messages,
)
from shared.claude_client import complete
from shared.db import get_client
from shared.kb_query import Chunk, search_for_client

logger = logging.getLogger("ai_enablement.ella.passive_monitor")

_HAIKU_MODEL = "claude-haiku-4-5-20251001"

# The three decisions the decision Haiku may return.
_PASSIVE_DECISIONS = frozenset({"respond", "acknowledge_and_escalate", "skip"})

_RESPONSE_MODELS = frozenset({"haiku", "sonnet"})

_DIGEST_CATEGORIES = frozenset(
    {
        "question_program",
        "emotional_human_needed",
        "confusion",
        "money_commitment",
        "complaint",
        "other",
    }
)

# Last-resort ack when Haiku picks acknowledge_and_escalate but fails to
# populate ack_text (the prior canned template, kept as a safety net).
_FALLBACK_ACK_TEXT = (
    "Let me grab someone for this one — your advisor will take care of you."
)

_SAFER_FALLBACK_DECISION = "skip"

# author_type → speaker role label for the prompt (mirrors
# retrieval._ROLE_LABELS — "advisor" not "CSM" everywhere).
_SPEAKER_ROLE = {
    "client": "client",
    "team_member": "advisor",
    "ella": "ella",
    "bot": "bot",
}

# Author types that always reach the decision Haiku.
_HUMAN_AUTHOR_TYPES = ("client", "team_member")


# ---------------------------------------------------------------------------
# Public dataclasses
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PassiveTriggerPayload:
    """Information the decision module needs from the ingest layer.

    `is_ella_mentioned` is detected upstream in realtime_ingest (Ella's
    bot OR human user_id appears in the triggering message text) and is
    the strongest signal the decision Haiku weighs.

    `test_mode` is kept for backward compatibility but is now inert —
    `team_member` messages are always evaluated regardless of it.
    """

    slack_channel_id: str
    triggering_message_ts: str
    triggering_message_slack_user_id: str
    triggering_message_text: str
    author_type: str
    channel_client_id: str
    is_ella_mentioned: bool = False
    test_mode: bool = False


@dataclass(frozen=True)
class PassiveDecision:
    """Output of the decision Haiku. Synthetic on the gate paths."""

    decision: str  # 'respond' | 'acknowledge_and_escalate' | 'skip'
    response_model: str | None = None  # 'haiku' | 'sonnet' — only on respond
    ack_text: str | None = None  # only on acknowledge_and_escalate
    digest_flag: bool = False
    digest_category: str | None = None
    reasoning: str = ""
    haiku_cost_usd: Decimal = Decimal("0")
    haiku_input_tokens: int = 0
    haiku_output_tokens: int = 0


@dataclass(frozen=True)
class PassiveEvaluation:
    """What `evaluate_passive_trigger` returns; the caller persists it."""

    payload: PassiveTriggerPayload
    decision: PassiveDecision
    skip_reason: str | None = (
        None  # 'kill_switch' | 'non_human_author' | 'haiku_skip' | 'exception' | None
    )
    kb_chunks: list[Chunk] = field(default_factory=list)
    recent_channel_context: str = ""
    primary_csm: dict[str, Any] | None = None


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def evaluate_passive_trigger(payload: PassiveTriggerPayload) -> PassiveEvaluation:
    """Two gates, then one full-context Haiku decision. Never raises —
    the ingest layer must stay fail-soft."""
    try:
        return _evaluate(payload)
    except Exception as exc:
        logger.exception("passive_monitor: evaluate_passive_trigger raised: %s", exc)
        return PassiveEvaluation(
            payload=payload,
            decision=PassiveDecision(
                decision=_SAFER_FALLBACK_DECISION,
                reasoning=f"evaluate_passive_trigger_error: {type(exc).__name__}",
            ),
            skip_reason="exception",
        )


# ---------------------------------------------------------------------------
# Inner pipeline
# ---------------------------------------------------------------------------


def _evaluate(payload: PassiveTriggerPayload) -> PassiveEvaluation:
    # Gate 1: kill switch — no agent_runs row when globally off.
    if not _global_kill_switch_on():
        return PassiveEvaluation(
            payload=payload,
            decision=PassiveDecision(
                decision=_SAFER_FALLBACK_DECISION,
                reasoning="global kill switch off",
            ),
            skip_reason="kill_switch",
        )

    # Gate 2: author type. client + team_member always evaluated;
    # ella / bot / workflow / unknown skip WITH an audit row.
    if payload.author_type not in _HUMAN_AUTHOR_TYPES:
        return PassiveEvaluation(
            payload=payload,
            decision=PassiveDecision(
                decision=_SAFER_FALLBACK_DECISION,
                reasoning=f"non-human author_type={payload.author_type}",
            ),
            skip_reason="non_human_author",
        )

    db = get_client()
    primary_csm = _fetch_primary_csm(db, payload.channel_client_id)

    # Recent context BEFORE KB search — needed to build the query.
    recent_rows = fetch_recent_channel_messages(
        payload.slack_channel_id,
        before_ts=payload.triggering_message_ts,
        n_turns=15,
    )
    kb_query = build_kb_query_from_conversation(
        payload.triggering_message_text, recent_rows
    )
    kb_chunks = _kb_search(kb_query, payload.channel_client_id)

    recent_context = fetch_recent_channel_context(
        payload.slack_channel_id,
        before_ts=payload.triggering_message_ts,
        n_turns=15,
    )

    speaker = resolve_speaker_identity(payload.triggering_message_slack_user_id)
    speaker_role = _SPEAKER_ROLE.get(payload.author_type, "unknown")
    speaker_name = (
        speaker.display_name
        if speaker and speaker.display_name and not speaker.display_name.startswith("(")
        else "unknown"
    )

    decision = decide_passive_response(
        triggering_message=payload.triggering_message_text,
        recent_context=recent_context,
        kb_results=kb_chunks,
        speaker_role=speaker_role,
        speaker_name=speaker_name,
        is_ella_mentioned=payload.is_ella_mentioned,
    )
    return PassiveEvaluation(
        payload=payload,
        decision=decision,
        skip_reason="haiku_skip" if decision.decision == "skip" else None,
        kb_chunks=kb_chunks,
        recent_channel_context=recent_context,
        primary_csm=primary_csm,
    )


def _global_kill_switch_on() -> bool:
    return (os.environ.get("ELLA_PASSIVE_MONITORING_ENABLED") or "").lower() == "true"


def _kb_search(query: str, client_id: str) -> list[Chunk]:
    """Top-k retrieval using the combined-conversation query. Context
    for Haiku, never a gate; empty result is acceptable."""
    return search_for_client(query, client_id=client_id, k=8, include_global=True)


# ---------------------------------------------------------------------------
# Decision Haiku
# ---------------------------------------------------------------------------


_HAIKU_SYSTEM_PROMPT = """You are Ella's decision brain. Every message that lands in a monitored Slack channel passes through you. You decide what Ella does: respond, acknowledge and route to a human, or stay silent.

Your output is structured JSON. You do NOT write the response itself when decision='respond' — a separate model handles that. When decision='acknowledge_and_escalate' you DO write the short warm ack the client will see.

# WHO ELLA IS

Ella is the AI assistant for clients of The AI Partner, a coaching agency that helps founders build AI-native businesses. Each client has a dedicated Slack channel containing the client, their assigned advisor (called "advisor" with clients, never "CSM"), and Ella. Clients can also include their team members.

Ella's job: be the first line of support. Answer program/curriculum/process questions she can answer well. Acknowledge and route to a human anything that needs human judgment. Stay silent when she'd be interjecting on someone else's conversation.

# THE THREE DECISIONS

You return exactly one decision:

- **respond** — Ella generates a real answer in-channel. Use when:
  - The message is a question Ella can answer from the KB chunks below.
  - It's a curriculum, program, methodology, or process question.
  - The retrieved KB chunks directly address what's being asked.
  - There's no emotional charge, no judgment call required, no money/commitment topic.
  - Examples: "what does the discovery section cover", "how does the offer framework work", "what was discussed on my last call".

  When decision='respond', you must also pick response_model:
  - **haiku** — clean factual question, KB has direct anchors, short paraphrase-the-KB answer will land. Lower-cost path.
  - **sonnet** — answerable but needs nuance, multi-turn threading, careful framing, or texture Haiku would flatten. Default to sonnet when uncertain.

- **acknowledge_and_escalate** — Ella posts a warm in-channel acknowledgment that you write here (set the ack_text field), and the backend DMs the client's advisor and Scott (head of fulfillment). Use when:
  - The message involves emotional content: frustration, overwhelm, fear, anger, defeat, stuck-ness.
  - The message touches money or commitments: refunds, billing, cancellations, contracts, account changes.
  - The message is a complaint or expresses dissatisfaction with the program or anyone at the agency.
  - The message asks for a personal judgment call about the client's specific situation (which offer to run, whether to fire a client, how to price).
  - The message asks something Ella can't actually answer from the KB — including navigation questions like "where do I find X", "what module is Y in", "how do I get to Z in the platform". The KB has lesson CONTENT but not platform NAVIGATION — those are advisor questions.
  - The message is confused about the program, expectations, or instructions in a way that suggests the client is stuck and needs a human to unstick them.
  - The message is a re-fire of something Ella already acknowledged recently — still ack, still DM, because the recurrence tells the advisor "this is still open."

  When decision='acknowledge_and_escalate', write the ack_text yourself. Make it warm, short (1-2 sentences), in Ella's voice. Acknowledge what the client said. Tell them their advisor will follow up. Address the client by first name when natural. Do NOT include an @-mention of the advisor — the backend handles notifying. Examples:

  - "Hey Catrina, totally hear that — I'll have Scott jump in on this one shortly."
  - "That's a real question — let me get your advisor's eyes on this. They'll follow up directly."
  - "I see you, this needs a human. Nico will be in touch."

  Vary the phrasing. Don't repeat the same template.

- **skip** — Ella stays silent. No in-channel post, no DM. Use when:
  - The message is clearly between the client and their advisor, mid-conversation. Don't interject in active dialogue.
  - The message is from a team member (advisor or CSM) without @-mentioning Ella. Don't interject in advisor-led work.
  - The message is chitchat: greetings, acknowledgments, emoji reactions, "thanks", "ok cool".
  - The message is a status update or thinking-out-loud post not asking anyone anything.
  - The message is directed at someone else by name (not Ella).

  Even when decision='skip', you may set digest_flag=true if Scott should still see the message in his daily digest.

# THE @-MENTION SIGNAL

The triggering message text may contain an explicit @-mention of Ella (you'll see `<@U0B03PTJD3P>` or similar in the message text, or the boolean `is_ella_mentioned: true` in the input). This is the strongest signal in the system. When Ella is @-mentioned:

- Strongly lean toward respond. The @-mention is an explicit invitation.
- @-mention OVERRIDES the default-skip-CSMs rule. If Nico @-mentions Ella with a question, respond.
- @-mention with no follow-up text ("@Ella") and a prior unanswered question in the last few messages → treat the prior question as the actual target. Respond to that.
- @-mention with no follow-up text and no prior question → respond with a warm short opener inviting them to ask.
- @-mention + emotional/money/judgment content → still acknowledge_and_escalate. The @-mention escalates the priority but doesn't change what kind of message it is.

# READING THE CONTEXT

You receive five things:

1. **The triggering message** (the message that just landed).
2. **Recent channel context** (last 15 turns with full ET timestamps + speaker labels). Use this to:
   - Detect active conversations Ella shouldn't interject in (recent advisor messages within last 15 minutes = active).
   - Distinguish continuation messages from fresh-start messages (a question after silence is fresh; a question during active back-and-forth might be continuation).
   - Spot re-fires (a topic already acked recently — still ack again).
   - Thread bare @-mentions to prior unanswered questions.
   - See Ella's own prior posts so follow-ups make sense.
3. **Speaker identity** (client, advisor, ella, bot, unknown) with name.
4. **@-mention flag** (`is_ella_mentioned: true|false`).
5. **KB chunks** retrieved using the combined conversation context as the query. Each chunk has a similarity score. Higher = stronger match. Use these to:
   - Verify your respond decision is grounded — if no chunk strongly addresses the question, respond is risky.
   - Distinguish "KB has content about this" (lesson covers X) from "KB lets me answer this" (the client is asking where X lives, not what X is). The KB doesn't have navigation metadata.

# THE DIGEST FLAG (INDEPENDENT)

Independently of the decision, return `digest_flag: bool` and `digest_category`. The flag controls whether the message is surfaced in the daily digest sent to Scott (head of fulfillment) and Drake. Decision and flag are independent — Ella can answer a message AND flag it for digest visibility (Scott still wants to know "Ella handled a refund question today").

Always flag when the message involves ANY of:
- Emotional content (frustration, confusion, fear, overwhelm)
- Money / commitments (refunds, billing, contracts, cancellations)
- Complaints or dissatisfaction
- Confusion about anything
- Anything that needs human handling
- A recurring topic from prior days

When in doubt, flag. False positives are explicitly fine — Scott prefers skim-and-discard over miss-and-stress.

Set digest_flag=false ONLY for:
- Chitchat, greetings, acknowledgments
- Clean program questions Ella answered confidently
- CSM-client routine work where nothing meaningful for Scott surfaced
- Pure non-signal

`acknowledge_and_escalate` ALWAYS implies `digest_flag=true`.

# THE DIGEST CATEGORY

When digest_flag=true, set digest_category to one of:
- "question_program" — program-related question worth Scott seeing
- "emotional_human_needed" — emotional content or situation needing human handling
- "confusion" — client is confused about something
- "money_commitment" — refund / billing / contract / cancellation topic
- "complaint" — explicit complaint or dissatisfaction
- "other" — flagged but doesn't fit above

When digest_flag=false, set digest_category to null.

# DEFAULT STANCES

Two independent defaults:

- **"Should Ella speak?" defaults to skip.** Ella interjecting in a working conversation is worse than Ella missing a question. When uncertain whether to respond, skip. When the message would warrant a human, prefer acknowledge_and_escalate over respond — never confidently answer a question that needs human judgment.

- **"Should Scott see this?" defaults to flag.** False positives are fine. When uncertain whether something matters, flag it.

# OUTPUT FORMAT

Return a strict JSON object. No prose around it, no code fences, no commentary.

{
  "decision": "respond | acknowledge_and_escalate | skip",
  "response_model": "haiku | sonnet | null",
  "ack_text": "<warm 1-2 sentence ack in Ella's voice, only when decision=acknowledge_and_escalate, otherwise null>",
  "digest_flag": true | false,
  "digest_category": "question_program | emotional_human_needed | confusion | money_commitment | complaint | other | null",
  "reasoning": "<1-3 sentences explaining your decision, max 400 chars>"
}

Field rules:
- `response_model` is required when decision='respond', null otherwise.
- `ack_text` is required when decision='acknowledge_and_escalate', null otherwise.
- `digest_category` is null when digest_flag=false; required when digest_flag=true.
- `reasoning` is always set — explain your decision concisely."""


_USER_PROMPT_TEMPLATE = """# TRIGGERING MESSAGE

{message}

# SPEAKER

{speaker_role} ({speaker_name})

# IS THIS AN @-MENTION OF ELLA?

{is_ella_mentioned}

# RECENT CHANNEL CONTEXT (last 15 turns, oldest first; includes Ella's own posts)

{recent_context}

# TOP KB CHUNKS (retrieved using combined conversation context as query)

{kb_block}

# DECIDE

Return JSON with `decision`, `response_model`, `ack_text`, `digest_flag`, `digest_category`, and `reasoning`."""


def decide_passive_response(
    *,
    triggering_message: str,
    recent_context: str,
    kb_results: list[Chunk],
    speaker_role: str = "client",
    speaker_name: str = "unknown",
    is_ella_mentioned: bool = False,
) -> PassiveDecision:
    """Call the decision Haiku and parse the structured output.
    Unparseable / out-of-enum → safe default (skip)."""
    user_prompt = _USER_PROMPT_TEMPLATE.format(
        message=triggering_message or "(empty)",
        speaker_role=speaker_role,
        speaker_name=speaker_name,
        is_ella_mentioned="true" if is_ella_mentioned else "false",
        recent_context=recent_context or "(no recent context)",
        kb_block=_render_kb_block(kb_results),
    )

    try:
        result = complete(
            system=_HAIKU_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_prompt}],
            model=_HAIKU_MODEL,
            max_tokens=500,
        )
    except Exception as exc:
        logger.warning("passive_monitor: decision Haiku call failed (%s); skip", exc)
        return PassiveDecision(
            decision=_SAFER_FALLBACK_DECISION,
            reasoning=f"haiku_call_failed: {type(exc).__name__}",
        )

    parsed = _parse_haiku_output(result.text)
    return PassiveDecision(
        decision=parsed["decision"],
        response_model=parsed["response_model"],
        ack_text=parsed["ack_text"],
        digest_flag=parsed["digest_flag"],
        digest_category=parsed["digest_category"],
        reasoning=parsed["reasoning"],
        haiku_cost_usd=result.cost_usd,
        haiku_input_tokens=result.input_tokens,
        haiku_output_tokens=result.output_tokens,
    )


def _render_kb_block(chunks: list[Chunk]) -> str:
    if not chunks:
        return "(none)"
    lines = []
    for c in chunks[:5]:
        header = f"[{c.document_type} | {c.document_title} | sim={c.similarity:.2f}]"
        body = c.content.strip()
        if len(body) > 800:
            body = body[:800] + "..."
        lines.append(header + "\n" + body)
    return "\n\n".join(lines)


def _parse_haiku_output(raw: str) -> dict[str, Any]:
    """Parse + validate the decision JSON. Returns a dict with the full
    field set. Unparseable / out-of-enum decision → skip. Field rules
    enforced per the spec (response_model defaults to sonnet when
    missing-but-required; ack_text falls back to the canned template)."""
    safe = {
        "decision": _SAFER_FALLBACK_DECISION,
        "response_model": None,
        "ack_text": None,
        "digest_flag": False,
        "digest_category": None,
        "reasoning": "",
    }
    if not raw or not raw.strip():
        safe["reasoning"] = "unparseable Haiku response (empty)"
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
        import re

        m = re.search(r"\{[\s\S]*\}", stripped)
        if not m:
            safe["reasoning"] = f"unparseable Haiku response: {stripped[:200]}"
            return safe
        try:
            parsed = json.loads(m.group(0))
        except json.JSONDecodeError:
            safe["reasoning"] = f"unparseable Haiku response: {stripped[:200]}"
            return safe
    if not isinstance(parsed, dict):
        safe["reasoning"] = f"haiku_returned_non_object: {stripped[:200]}"
        return safe

    decision = parsed.get("decision")
    reasoning = str(parsed.get("reasoning") or "")[:600]
    if decision not in _PASSIVE_DECISIONS:
        safe["reasoning"] = (
            f"haiku_returned_unknown_decision={decision!r}; {reasoning[:200]}"
        )
        return safe

    digest_flag = bool(parsed.get("digest_flag"))
    raw_cat = parsed.get("digest_category")
    digest_category = raw_cat if raw_cat in _DIGEST_CATEGORIES else None

    response_model = None
    ack_text = None

    if decision == "respond":
        rm = parsed.get("response_model")
        # Missing/invalid response_model → sonnet (safer than haiku).
        response_model = rm if rm in _RESPONSE_MODELS else "sonnet"
    elif decision == "acknowledge_and_escalate":
        at = parsed.get("ack_text")
        ack_text = (
            at.strip() if isinstance(at, str) and at.strip() else _FALLBACK_ACK_TEXT
        )
        digest_flag = True  # acknowledge_and_escalate always flags
        if digest_category is None:
            digest_category = "other"

    if digest_flag and digest_category is None:
        digest_category = "other"
    if not digest_flag:
        digest_category = None

    return {
        "decision": decision,
        "response_model": response_model,
        "ack_text": ack_text,
        "digest_flag": digest_flag,
        "digest_category": digest_category,
        "reasoning": reasoning,
    }


# ---------------------------------------------------------------------------
# Primary CSM lookup (reactive ack_and_escalate DM target)
# ---------------------------------------------------------------------------


def _fetch_primary_csm(db, client_id: str) -> dict[str, Any] | None:
    if not client_id:
        return None
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
    rows = tm_resp.data or []
    return rows[0] if rows else None
