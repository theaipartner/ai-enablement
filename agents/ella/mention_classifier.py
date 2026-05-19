"""Classifier Haiku for @-mention messages.

When a message has `is_ella_mentioned=true`, the passive_dispatch layer
bypasses the full decision Haiku and calls this classifier instead. The
question "should Ella respond" is already answered by the @-mention
itself — the classifier only picks the response shape.

Public entry: `classify_mention_response(payload, kb_chunks, recent_context,
primary_csm, channel_client)`.

Returns a `MentionClassification` carrying the response shape + digest
flag + token counts + cost. The output enum **deliberately omits skip**
— that's the structural fix the spec
(`docs/specs/ella-at-mention-structural-override.md`) introduces.
Three iterations of prompt-engineering "skip is FORBIDDEN" failed in
production; the structural answer is "skip can't appear in the schema
the model fills."

Safer-fallback on any parse failure or out-of-enum shape: `warm_opener`
with empty ack_text. Never silent, never substantive misfire.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from shared.claude_client import complete
from shared.kb_query import Chunk

logger = logging.getLogger("ai_enablement.ella.mention_classifier")

_HAIKU_MODEL = "claude-haiku-4-5-20251001"
_MAX_TOKENS = 600

_SHAPES = frozenset(
    {"respond_haiku", "respond_sonnet", "acknowledge_and_escalate", "warm_opener"}
)

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

# Safer-fallback shape: any parse failure / unknown shape → a friendly
# opener (the smallest appropriate response). Never silent.
_SAFER_FALLBACK_SHAPE = "warm_opener"


_SYSTEM_PROMPT = """You are Ella's mention-response classifier. A user has explicitly @-mentioned Ella in a Slack channel. Your job is ONLY to decide what SHAPE of response Ella should give — never whether to respond. Responding is already decided by the @-mention itself.

# YOUR ONLY DECISION

Pick exactly one response shape:

- **respond_haiku** — A second small model will write the response. Use when:
  - The triggering message contains a clear, factual program/curriculum/process question.
  - The retrieved KB chunks below directly address what's being asked.
  - A short paraphrase-the-KB answer would land cleanly.
  - No emotional charge, no money/commitment topic, no personal judgment call.

- **respond_sonnet** — A larger model will write the response. Use when:
  - The message is a question Ella can answer but needs nuance, multi-turn threading, or careful framing.
  - The retrieved KB chunks help but the answer needs texture a small model would flatten.
  - When uncertain between haiku and sonnet, pick sonnet.

- **acknowledge_and_escalate** — Ella will post a warm ack in-channel and the backend will DM the client's advisor + Scott. Use when:
  - The message involves emotional content (frustration, overwhelm, fear, anger, defeat).
  - The message involves money or commitments (refunds, billing, cancellations, contracts).
  - The message is a complaint or expresses dissatisfaction.
  - The message asks for a personal judgment call about the client's specific situation.
  - The message asks about platform navigation ("where do I find X" / "what module is Y in") — the KB has lesson content but not navigation metadata, the advisor handles those.
  - The message indicates the user is confused and stuck in a way that needs a human.

  When picking this shape, you ALSO write the ack_text — short (1-2 sentences), warm, in Ella's voice. Acknowledge the user, mention the advisor will follow up. Do NOT @-mention the advisor in the text (the backend handles notification). Address by first name when natural.

  Examples:
  - "Hey Catrina, totally hear that — I'll have Scott jump in on this one shortly."
  - "Let me get your advisor's eyes on this. They'll follow up directly."
  - "I see you, this needs a human. Nico will be in touch."

- **warm_opener** — Ella will post a brief friendly opener inviting the user to ask. Use when:
  - The @-mention is bare (no text after the mention) AND no clear question exists in recent context.
  - The @-mention text is too short or vague to classify ("hey", "thanks", "yo").
  - The @-mention seems casual or social rather than substantive.

# WHAT YOU DO NOT DO

You never output `skip`. You never decide "this doesn't need a response." The user @-mentioned Ella — that decision is made. You only pick the SHAPE.

If you find yourself reasoning "this doesn't really warrant a response because..." — STOP. The user explicitly invited Ella. Pick the smallest appropriate shape (often warm_opener) but never skip.

# DIGEST FLAG (INDEPENDENT)

Independently, return digest_flag and digest_category. The flag controls whether the message surfaces in Scott + Drake's daily digest. Set digest_flag=true when the message involves any of:
- Emotional content
- Money / commitments
- Complaints or dissatisfaction
- Confusion that needs human handling
- A recurring topic from prior days
- Anything Scott would want to see

When in doubt, flag. False positives are explicitly fine.

`acknowledge_and_escalate` always implies `digest_flag=true`.

When digest_flag=true, also pick digest_category:
- "question_program" | "emotional_human_needed" | "confusion" | "money_commitment" | "complaint" | "other"

When digest_flag=false, digest_category is null.

# OUTPUT FORMAT

Return strict JSON. No prose, no code fences, no commentary.

{
  "shape": "respond_haiku | respond_sonnet | acknowledge_and_escalate | warm_opener",
  "ack_text": "<warm 1-2 sentence ack in Ella's voice, only when shape=acknowledge_and_escalate, otherwise null>",
  "digest_flag": true | false,
  "digest_category": "question_program | emotional_human_needed | confusion | money_commitment | complaint | other | null",
  "reasoning": "<1-2 sentences explaining your choice, max 300 chars>"
}

Field rules:
- `ack_text` is required when shape='acknowledge_and_escalate', null otherwise.
- `digest_category` is null when digest_flag=false, required when digest_flag=true."""


_USER_PROMPT_TEMPLATE = """# TRIGGERING MESSAGE

{message}

# SPEAKER

{speaker_role} ({speaker_name})

# RECENT CHANNEL CONTEXT (last 15 turns)

{recent_context}

# KB CHUNKS

{kb_block}

# CLASSIFY

Pick the response shape. The @-mention is already explicit — you do NOT decide whether to respond."""


@dataclass(frozen=True)
class MentionClassification:
    shape: str  # 'respond_haiku' | 'respond_sonnet' | 'acknowledge_and_escalate' | 'warm_opener'
    ack_text: str | None
    digest_flag: bool
    digest_category: str | None
    reasoning: str
    haiku_cost_usd: Decimal = Decimal("0")
    haiku_input_tokens: int = 0
    haiku_output_tokens: int = 0


def classify_mention_response(
    *,
    payload,
    kb_chunks: list[Chunk],
    recent_context: str,
    primary_csm: dict | None = None,
    channel_client: dict | None = None,
    speaker_role: str = "client",
    speaker_name: str = "unknown",
) -> MentionClassification:
    """Call the classifier Haiku and parse its structured output.

    Any failure (call exception, malformed JSON, out-of-enum shape) →
    `warm_opener` safer-fallback. The output enum has NO `skip`; this
    function never returns a "don't respond" outcome.
    """
    user_prompt = _USER_PROMPT_TEMPLATE.format(
        message=getattr(payload, "triggering_message_text", "") or "(empty)",
        speaker_role=speaker_role,
        speaker_name=speaker_name,
        recent_context=recent_context or "(no recent context)",
        kb_block=_render_kb_block(kb_chunks),
    )

    try:
        result = complete(
            system=_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_prompt}],
            model=_HAIKU_MODEL,
            max_tokens=_MAX_TOKENS,
        )
    except Exception as exc:
        logger.warning(
            "mention_classifier: classifier Haiku call failed (%s); "
            "falling back to warm_opener",
            exc,
        )
        return MentionClassification(
            shape=_SAFER_FALLBACK_SHAPE,
            ack_text=None,
            digest_flag=False,
            digest_category=None,
            reasoning=f"classifier_call_failed: {type(exc).__name__}",
        )

    parsed = _parse_classifier_output(result.text)
    return MentionClassification(
        shape=parsed["shape"],
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


def _parse_classifier_output(raw: str) -> dict[str, Any]:
    """Parse + validate. Any failure → warm_opener fallback (never skip
    — the classifier's output enum has no skip)."""
    safe = {
        "shape": _SAFER_FALLBACK_SHAPE,
        "ack_text": None,
        "digest_flag": False,
        "digest_category": None,
        "reasoning": "",
    }
    if not raw or not raw.strip():
        safe["reasoning"] = "unparseable classifier response (empty)"
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
            safe["reasoning"] = f"unparseable classifier response: {stripped[:200]}"
            return safe
        try:
            parsed = json.loads(m.group(0))
        except json.JSONDecodeError:
            safe["reasoning"] = f"unparseable classifier response: {stripped[:200]}"
            return safe
    if not isinstance(parsed, dict):
        safe["reasoning"] = f"classifier_returned_non_object: {stripped[:200]}"
        return safe

    shape = parsed.get("shape")
    reasoning = str(parsed.get("reasoning") or "")[:600]
    if shape not in _SHAPES:
        # Includes the case where a model tries to output "skip" — it's
        # not in _SHAPES, falls through to warm_opener. Structural fix.
        safe["reasoning"] = (
            f"classifier_returned_unknown_shape={shape!r}; {reasoning[:200]}"
        )
        return safe

    digest_flag = bool(parsed.get("digest_flag"))
    raw_cat = parsed.get("digest_category")
    digest_category = raw_cat if raw_cat in _DIGEST_CATEGORIES else None

    ack_text = None
    if shape == "acknowledge_and_escalate":
        at = parsed.get("ack_text")
        ack_text = (
            at.strip()
            if isinstance(at, str) and at.strip()
            else "Let me get your advisor on this one — they'll follow up shortly."
        )
        digest_flag = True
        if digest_category is None:
            digest_category = "other"

    if digest_flag and digest_category is None:
        digest_category = "other"
    if not digest_flag:
        digest_category = None

    return {
        "shape": shape,
        "ack_text": ack_text,
        "digest_flag": digest_flag,
        "digest_category": digest_category,
        "reasoning": reasoning,
    }
