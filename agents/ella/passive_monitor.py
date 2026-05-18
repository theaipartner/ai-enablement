"""Ella passive-monitoring decision module (unified-decision rewrite).

Public entry point: `evaluate_passive_trigger(payload)`. Called by the
realtime-ingest passive branch (`ingestion/slack/realtime_ingest.py`)
for every client-authored message in a passive-monitoring-enabled
channel after the ingest itself succeeds.

Returns a `PassiveEvaluation` describing the chosen action plus all
metadata the caller (`agents.ella.passive_dispatch`) needs to persist.

Pipeline (collapsed from the old 5-gate shape to 2 pre-LLM gates +
Haiku — see docs/agents/ella/ella.md and docs/runbooks/
ella_passive_monitoring.md):

  1. Gate 1 — Global kill switch. `ELLA_PASSIVE_MONITORING_ENABLED`
     must be 'true' (case-insensitive). Anything else: skip silently
     with `skip_reason='kill_switch'`. The dispatch layer writes NO
     agent_runs row for this case (saves DB writes + audit noise when
     Ella is globally off).
  2. Gate 2 — Author type. Must be 'client' (or 'client'/'team_member'
     under channel `test_mode`). Anything else: skip with
     `skip_reason='non_client_author'`.
  3. KB vector search (top-k=8). Context for Haiku, NOT a gate. Empty
     result is allowed.
  4. Recent channel context fetch (last 5 turns).
  5. Decision Haiku call. Returns the full structured decision.

The four decisions (Haiku picks one):
  - skip               — directed at someone else / chitchat / not a
                          program question.
  - respond_haiku_self — KB has clean anchors; the response Haiku can
                          paraphrase a short answer.
  - respond_via_sonnet — answerable but needs nuance / threading.
  - digest_only         — message warrants a human's eyes; Ella does
                          not take the lead on the passive path.

Independently of the decision, Haiku returns `digest_flag` (whether
the message is surfaced in the daily digest) and `digest_category`.
The flagging criteria are deliberately permissive — Scott is fine
with false positives. `digest_only` always implies `digest_flag=true`.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from agents.ella.retrieval import fetch_recent_channel_context
from shared.claude_client import complete
from shared.db import get_client
from shared.kb_query import Chunk, search_for_client

logger = logging.getLogger("ai_enablement.ella.passive_monitor")

# Haiku model identifier. Matches the entry in
# shared.claude_client._PRICING_PER_MILLION so cost tracking attributes
# the spend correctly.
_HAIKU_MODEL = "claude-haiku-4-5-20251001"

# The four decisions the decision Haiku may return.
_PASSIVE_DECISIONS = frozenset(
    {
        "skip",
        "respond_haiku_self",
        "respond_via_sonnet",
        "digest_only",
    }
)

# The digest categories the decision Haiku may return. Free-text on the
# DB side (no enum CHECK) so iteration doesn't need a migration; this
# frozenset is the parse-time validation only.
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

# Decision returned when any uncertain path short-circuits. Matches the
# spec's default-stance ("skip if uncertain about whether to respond").
_SAFER_FALLBACK_DECISION = "skip"


# ---------------------------------------------------------------------------
# Public dataclasses
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PassiveTriggerPayload:
    """The information the passive monitor needs from the ingest layer.

    `test_mode` (default False) is the channel-level smoke-test flag from
    `slack_channels.test_mode`. When True, Gate 2 (author-type) accepts
    `team_member` messages in addition to `client` messages so Drake can
    smoke-test Ella as himself before flipping passive monitoring on for
    production channels. Other author types (ella / bot / workflow /
    unknown) still skip regardless of test_mode.
    """

    slack_channel_id: str
    triggering_message_ts: str
    triggering_message_slack_user_id: str
    triggering_message_text: str
    author_type: str
    channel_client_id: str
    test_mode: bool = False


@dataclass(frozen=True)
class PassiveDecision:
    """Output of the decision Haiku call. Always set; the pre-LLM gate
    paths skip the call and build a synthetic decision with reasoning
    explaining the gate."""

    decision: (
        str  # 'skip' | 'respond_haiku_self' | 'respond_via_sonnet' | 'digest_only'
    )
    digest_flag: bool = False
    digest_category: str | None = None  # see _DIGEST_CATEGORIES or None
    reasoning: str = ""
    haiku_cost_usd: Decimal = Decimal("0")
    haiku_input_tokens: int = 0
    haiku_output_tokens: int = 0


@dataclass(frozen=True)
class PassiveEvaluation:
    """What `evaluate_passive_trigger` returns. The caller persists this.

    `skip_reason` vocabulary is trimmed to the two pre-Haiku skips
    (`kill_switch`, `non_client_author`), the Haiku skip (`haiku_skip`),
    and `exception` (the outer fail-soft fallback). The old
    `csm_directed` / `no_kb_match` / `firm_after_first` reasons are gone
    with the gates that produced them.
    """

    payload: PassiveTriggerPayload
    decision: PassiveDecision
    skip_reason: str | None = (
        None  # 'kill_switch' | 'non_client_author' | 'haiku_skip' | 'exception' | None
    )
    kb_chunks: list[Chunk] = field(default_factory=list)
    recent_channel_context: str = ""
    primary_csm: dict[str, Any] | None = None


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def evaluate_passive_trigger(
    payload: PassiveTriggerPayload,
) -> PassiveEvaluation:
    """Walk the two pre-Haiku gates and call the decision Haiku if both
    pass.

    Never raises — the caller is the ingest layer which must stay
    fail-soft. Any exception bubbling out of here would taint the
    ingest's audit row.
    """
    try:
        return _evaluate(payload)
    except Exception as exc:
        # Unrecoverable — log and return a safer-fallback skip. The
        # dispatch layer still writes the agent_runs row so the path
        # is visible in /ella/runs (exception is NOT kill_switch, so
        # the no-row optimization does not apply here).
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
    # Gate 1: Global kill switch. No agent_runs row when killed — the
    # dispatch layer special-cases skip_reason='kill_switch'.
    if not _global_kill_switch_on():
        return PassiveEvaluation(
            payload=payload,
            decision=PassiveDecision(
                decision=_SAFER_FALLBACK_DECISION,
                reasoning="global kill switch off",
            ),
            skip_reason="kill_switch",
        )

    # Gate 2: Author-type gate. Production design is clients-only.
    # `slack_channels.test_mode=True` opens a controlled exception so
    # Drake can smoke-test as himself in #ella-test-drakeonly.
    allowed_types = ("client", "team_member") if payload.test_mode else ("client",)
    if payload.author_type not in allowed_types:
        return PassiveEvaluation(
            payload=payload,
            decision=PassiveDecision(
                decision=_SAFER_FALLBACK_DECISION,
                reasoning=f"non-allowed author_type={payload.author_type} (test_mode={payload.test_mode})",
            ),
            skip_reason="non_client_author",
        )

    db = get_client()
    primary_csm = _fetch_primary_csm(db, payload.channel_client_id)

    # KB vector search — context for Haiku, not a gate. Empty is fine.
    kb_chunks = _kb_search(payload.triggering_message_text, payload.channel_client_id)

    # Recent channel context — last 5 turns.
    recent_context = fetch_recent_channel_context(
        payload.slack_channel_id,
        before_ts=payload.triggering_message_ts,
        n_turns=5,
        max_chars=2000,
    )

    decision = decide_passive_response(
        triggering_message=payload.triggering_message_text,
        recent_context=recent_context,
        kb_results=kb_chunks,
    )
    return PassiveEvaluation(
        payload=payload,
        decision=decision,
        skip_reason="haiku_skip" if decision.decision == "skip" else None,
        kb_chunks=kb_chunks,
        recent_channel_context=recent_context,
        primary_csm=primary_csm,
    )


# ---------------------------------------------------------------------------
# Gate 1 — global kill switch
# ---------------------------------------------------------------------------


def _global_kill_switch_on() -> bool:
    return (os.environ.get("ELLA_PASSIVE_MONITORING_ENABLED") or "").lower() == "true"


# ---------------------------------------------------------------------------
# KB retrieval (context, no longer a gate)
# ---------------------------------------------------------------------------


def _kb_search(query: str, client_id: str) -> list[Chunk]:
    """Top-k retrieval for the channel's client. Same shape as the
    reactive path uses — keeps the safety invariants intact. Result is
    passed to Haiku as context; an empty list is acceptable (Haiku
    leans on the message text alone)."""
    return search_for_client(query, client_id=client_id, k=8, include_global=True)


# ---------------------------------------------------------------------------
# Decision Haiku
# ---------------------------------------------------------------------------


_HAIKU_SYSTEM_PROMPT = """You are Ella's passive-monitoring decision gate. You decide what Ella does when a client message lands in a Slack channel — without anyone asking her directly. Your output is structured JSON, NOT a response to the client.

# WHO ELLA IS

Ella is the AI assistant for clients of The AI Partner, a coaching agency that helps founders build AI-native businesses. Clients have a dedicated Slack channel, a curriculum, and a 1:1 advisor (referred to internally as their CSM, but always called "advisor" with clients).

Ella's job is to be the first line of support — answering program/curriculum questions Ella can answer well, and flagging anything else to a human.

# THE FOUR DECISIONS

You return exactly one decision. Pick the most fitting:

- "skip" — Don't respond. Use this for:
  - Messages directed at the advisor or another team member (by @-mention or by name).
  - Casual chitchat, acknowledgments, emoji reactions.
  - Status updates, screenshot shares, thinking-out-loud posts.
  - Anything where responding would be intrusive or unhelpful.

- "respond_haiku_self" — A different model (also you, but in a separate response-generation call) will answer this. Use ONLY when:
  - The message is a clean, direct, factual question about the program / curriculum / process.
  - The retrieved KB chunks below directly address the question.
  - A short paraphrase-the-KB answer would land well.
  - There's no emotional charge, no judgment call, no money/commitment topic.

- "respond_via_sonnet" — A larger model will generate a thoughtful response. Use when:
  - The message is a program/curriculum question but needs nuance, context, or careful framing.
  - The message references prior conversation that needs threading in.
  - The question is answerable but the right answer has texture Haiku might flatten.

- "digest_only" — Don't respond at all. The message goes to a daily digest for human review. Use when:
  - The message involves emotional content (frustration, overwhelm, fear, anger).
  - The message touches money or commitments (refunds, billing, cancellations, contracts).
  - The message is a complaint or expresses dissatisfaction.
  - The message asks for a personal judgment call about the client's specific situation.
  - The message expresses confusion about the program, process, expectations, or anything that suggests the client is stuck.
  - The KB has nothing useful and the question isn't a simple chitchat — let a human handle it.

# THE DIGEST FLAG (INDEPENDENT)

In addition to the decision, you return a digest_flag boolean. This flag controls whether the message is surfaced in the daily digest to Scott (head of fulfillment) and Drake. The decision and the flag are independent — Haiku can answer a message AND flag it for digest visibility.

ALWAYS set digest_flag=true when the message involves ANY of:
- Emotional content (frustration, confusion, fear, overwhelm)
- Money / commitments (refunds, billing, contracts, cancellations)
- Complaints or dissatisfaction
- Confusion about anything (program, instructions, expectations, terminology)
- Anything that reads like a human needs to handle it
- A previously-flagged topic recurring — flag every time

When in doubt, flag. False positives are explicitly fine.

Set digest_flag=false ONLY for:
- Casual chitchat, greetings, acknowledgments.
- Clean program questions that Haiku or Sonnet will answer confidently.
- Pure non-signal.

Note: digest_only ALWAYS implies digest_flag=true. The flag can also be true on respond_haiku_self / respond_via_sonnet / skip decisions when the message involves any of the above categories.

# THE DIGEST CATEGORY

When digest_flag=true, also return a digest_category string. One of:
- "question_program" — program-related question the human should know was asked
- "emotional_human_needed" — emotional content or a situation needing human handling
- "confusion" — client is confused about something
- "money_commitment" — refund / billing / contract / cancellation topic
- "complaint" — explicit complaint or dissatisfaction
- "other" — flagged but doesn't fit the above

When digest_flag=false, return null.

# DEFAULT STANCE

Skip if uncertain about whether to respond. Flag if uncertain about whether Scott would care.

These two stances are independent because they're answering different questions. "Should Ella speak?" defaults to no. "Should Scott see this?" defaults to yes.

# OUTPUT FORMAT

Return a strict JSON object. No prose around it, no code fences, no commentary.

{
  "decision": "<skip | respond_haiku_self | respond_via_sonnet | digest_only>",
  "digest_flag": <true | false>,
  "digest_category": "<question_program | emotional_human_needed | confusion | money_commitment | complaint | other | null>",
  "reasoning": "<1-2 sentence string explaining the decision, max 300 chars>"
}"""


_USER_PROMPT_TEMPLATE = """# TRIGGERING MESSAGE

{message}

# LAST FEW TURNS OF CHANNEL CONTEXT (oldest first; may be empty)

{recent_context}

# TOP KB CHUNKS RETRIEVED FOR THIS MESSAGE

{kb_block}

# DECIDE

Return JSON with `decision`, `digest_flag`, `digest_category`, and `reasoning`."""


def decide_passive_response(
    *,
    triggering_message: str,
    recent_context: str,
    kb_results: list[Chunk],
) -> PassiveDecision:
    """Call the decision Haiku and parse the structured output.

    Unparseable / out-of-enum response -> default to skip with
    reasoning preserving the raw response head for debugging.
    """
    user_prompt = _USER_PROMPT_TEMPLATE.format(
        message=triggering_message or "(empty)",
        recent_context=recent_context or "(no recent context)",
        kb_block=_render_kb_block(kb_results),
    )

    try:
        result = complete(
            system=_HAIKU_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_prompt}],
            model=_HAIKU_MODEL,
            max_tokens=400,
        )
    except Exception as exc:
        logger.warning(
            "passive_monitor: decision Haiku call failed (%s); defaulting to skip",
            exc,
        )
        return PassiveDecision(
            decision=_SAFER_FALLBACK_DECISION,
            reasoning=f"haiku_call_failed: {type(exc).__name__}",
        )

    decision, digest_flag, digest_category, reasoning = _parse_haiku_output(result.text)
    return PassiveDecision(
        decision=decision,
        digest_flag=digest_flag,
        digest_category=digest_category,
        reasoning=reasoning,
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


def _parse_haiku_output(raw: str) -> tuple[str, bool, str | None, str]:
    """Parse the JSON object out of Haiku's response.

    Returns `(decision, digest_flag, digest_category, reasoning)`.

    Tolerates whitespace + optional ```json fences + JSON-with-prose
    prefix. Validates the decision against the enum. Unparseable /
    out-of-enum decision -> skip with raw-response-preserving reasoning.
    `digest_only` forces digest_flag=true regardless of what Haiku
    returned (defensive — the decision implies the flag).
    """
    if not raw or not raw.strip():
        return (
            _SAFER_FALLBACK_DECISION,
            False,
            None,
            "unparseable Haiku response (empty)",
        )
    stripped = raw.strip()
    # Strip a leading ```json or ``` fence and the trailing ```.
    if stripped.startswith("```"):
        stripped = stripped.split("\n", 1)[1] if "\n" in stripped else stripped[3:]
        if stripped.endswith("```"):
            stripped = stripped[:-3]
        stripped = stripped.strip()
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        import re

        match = re.search(r"\{[\s\S]*\}", stripped)
        if not match:
            return (
                _SAFER_FALLBACK_DECISION,
                False,
                None,
                f"unparseable Haiku response: {stripped[:200]}",
            )
        try:
            parsed = json.loads(match.group(0))
        except json.JSONDecodeError:
            return (
                _SAFER_FALLBACK_DECISION,
                False,
                None,
                f"unparseable Haiku response: {stripped[:200]}",
            )
    if not isinstance(parsed, dict):
        return (
            _SAFER_FALLBACK_DECISION,
            False,
            None,
            f"haiku_returned_non_object: {stripped[:200]}",
        )

    decision = parsed.get("decision")
    reasoning = str(parsed.get("reasoning") or "")[:600]
    if decision not in _PASSIVE_DECISIONS:
        return (
            _SAFER_FALLBACK_DECISION,
            False,
            None,
            f"haiku_returned_unknown_decision={decision!r}; reasoning={reasoning[:200]}",
        )

    digest_flag = bool(parsed.get("digest_flag"))
    raw_category = parsed.get("digest_category")
    digest_category = raw_category if raw_category in _DIGEST_CATEGORIES else None

    # digest_only always implies the flag — defensive against a Haiku
    # response that picked digest_only but forgot to set digest_flag.
    if decision == "digest_only":
        digest_flag = True
        if digest_category is None:
            digest_category = "other"

    # If the flag is set but no valid category came through, default to
    # 'other' so the digest can still group the row.
    if digest_flag and digest_category is None:
        digest_category = "other"
    # If the flag is false, the category is meaningless — null it.
    if not digest_flag:
        digest_category = None

    return decision, digest_flag, digest_category, reasoning


# ---------------------------------------------------------------------------
# Primary CSM lookup (used by the reactive digest_only DM path; passive
# path no longer fires DMs but still surfaces primary_csm for audit)
# ---------------------------------------------------------------------------


def _fetch_primary_csm(db, client_id: str) -> dict[str, Any] | None:
    """Walk client_team_assignments -> team_members for the active
    primary_csm. Mirrors retrieval._fetch_primary_csm."""
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
