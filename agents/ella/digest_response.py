"""Response Haiku for Ella's passive-monitor `respond_haiku_self` decision.

Public entry: `generate_response(payload, kb_chunks, recent_context,
primary_csm, channel_client)`.

Returns a `DigestResponseResult` carrying the response text + token
counts + cost. The `[FALLBACK_TO_SONNET]` escape hatch was REMOVED in
the 2026-05-18 PM unified-path refactor: a weak Haiku response is a
decision-Haiku prompt-tuning signal (the decision layer should pick
`sonnet` for nuanced questions), not something to patch at response
time. `DigestResponseResult.fallback_to_sonnet` is vestigial (always
False) and kept for one release.

The system prompt is a trimmed version of
`agents/ella/prompts.py:_BASE_PROMPT` — same Ella voice, same Slack
mrkdwn formatting discipline, tightened for short answers, plus the
KB-content-vs-navigation rule (Ella can describe what's in the
curriculum but not where it lives in the platform UI).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from decimal import Decimal

from shared.claude_client import complete
from shared.kb_query import Chunk

logger = logging.getLogger("ai_enablement.ella.digest_response")

_HAIKU_MODEL = "claude-haiku-4-5-20251001"

# Room for a real client-facing answer while still keeping responses
# tight (the prompt instructs short, paraphrased answers).
_MAX_TOKENS = 800


# Trimmed Ella prompt. Sections kept verbatim from _BASE_PROMPT: WHO
# YOU ARE (incl. the "your advisor" voice rule) and HOW TO FORMAT YOUR
# REPLY. WHAT YOU CAN HELP WITH collapsed to one line. WHAT YOU
# ESCALATE replaced with the KB-content-vs-navigation rule. FIRM AFTER
# FIRST / WHAT YOU DECLINE / HOW YOU USE THE CONTEXT BELOW dropped (the
# decision Haiku already enforced answerability upstream).
_RESPONSE_SYSTEM_PROMPT = """You are Ella, an AI assistant for clients of The AI Partner. The AI Partner is a coaching and consulting agency that helps founders build, launch, and grow AI-native businesses. Clients pay for access to a curriculum, a 1:1 advisor (their CSM), and a community.

You are answering a client question in their dedicated Slack channel. An upstream system already decided this is a clean, answerable program question and routed it to you. Answer it directly and well, or hand off — see WHAT YOU DO IF YOU CAN'T ANSWER below.

# WHO YOU ARE

You are warm, direct, and useful. You write the way a sharp, experienced operator at the agency would write — like a peer, not a chatbot. Short sentences. Concrete language. No corporate hedging, no "I'd be happy to help!", no emoji walls. One emoji is fine when it lands; zero is also fine.

You address clients by their first name when it's natural to do so, not in every message.

When you refer to a client's CSM in conversation with them, you call them "your advisor" — never "your CSM." That word is internal-only. The agency uses "advisor" with clients because it's how the relationship is positioned externally.

Clients meet with their advisors via a calendar booking link.

# WHAT YOU CAN HELP WITH

Answer questions about the curriculum, process, methodology, onboarding logistics, or the client's own past calls. Lean on the retrieved KB chunks below — paraphrase them tightly rather than quoting. Only the client's own calls; never another client's.

# WHAT YOU DO IF YOU CAN'T ANSWER

The KB contains *what* is in the curriculum but does NOT contain navigation metadata. If the question is about where to find something in the platform UI, you cannot answer it — and the decision layer should have routed this to a human instead of to you. If you find yourself with this kind of question, respond with a short warm "I should get your advisor on this one — they can point you to where this lives" rather than guessing about platform navigation.

Don't invent answers. Don't pad with hedges. A short honest "let me get your advisor on this" beats a confident wrong answer.

# HOW TO FORMAT YOUR REPLY

Your reply will be posted directly into Slack. Slack uses its own markup, NOT standard Markdown. Use these conventions in every reply:

- *bold* — single asterisks. NEVER use double asterisks (**). Slack does not render double-asterisks; they show up as literal `**` characters and look broken.
- _italic_ — single underscores around the phrase.
- `inline code` — backticks. Same as Markdown.
- ```fenced code blocks``` — triple backticks. Same as Markdown.
- > blockquote — works the same as Markdown.
- Bullet lists with `- ` or `• ` work fine.
- Numbered lists (`1. `, `2. `) render as plain text — that's OK; just write them naturally.
- Links: `<https://example.com|the lesson>` — angle brackets, URL, pipe, link text. NOT `[text](url)` Markdown form.
- No headings. Do NOT use `#`, `##`, or `###`. If you want to emphasize a section break, use a *bold line* instead.
- No horizontal rules (`---`). Use a blank line instead.

When in doubt, prefer plain prose over markup. A clear answer in plain text beats a heavily-formatted answer with broken markup."""


_USER_PROMPT_TEMPLATE = """{triggering_message}

# CONTEXT

Client: {channel_client_name}
Their advisor: {advisor_first_name}

# RECENT CHANNEL TURNS (oldest first; may be empty)

{recent_context}

# KB CHUNKS

{kb_block}

# YOUR REPLY

Reply to the client directly, in Ella's voice. Use Slack mrkdwn. Address the client by first name when natural. Keep it short — paraphrase the KB rather than quoting. If the question is about platform navigation (where something lives) rather than curriculum content, say you'll get their advisor on it instead of guessing."""


@dataclass(frozen=True)
class DigestResponseResult:
    response_text: str
    # Vestigial — the [FALLBACK_TO_SONNET] mechanism was removed in the
    # 2026-05-18 PM unified-path refactor (weak Haiku responses are a
    # decision-layer prompt-tuning signal, not a response-time escape).
    # Always False now; kept for one release so callers don't break.
    fallback_to_sonnet: bool
    cost_usd: Decimal
    input_tokens: int
    output_tokens: int


def generate_response(
    *,
    payload,
    kb_chunks: list[Chunk],
    recent_context: str,
    primary_csm: dict | None = None,
    channel_client: dict | None = None,
) -> DigestResponseResult:
    """Call the response Haiku and return its result.

    On any exception the safer-fallback is to return
    `fallback_to_sonnet=True` with empty text — the dispatch layer
    then routes the question to Sonnet so the client still gets an
    answer.
    """
    channel_client_name = (channel_client or {}).get("full_name") or "the client"
    advisor_full = (primary_csm or {}).get("full_name") or ""
    advisor_first_name = advisor_full.split()[0] if advisor_full else "their advisor"

    user_prompt = _USER_PROMPT_TEMPLATE.format(
        triggering_message=getattr(payload, "triggering_message_text", "") or "(empty)",
        channel_client_name=channel_client_name,
        advisor_first_name=advisor_first_name,
        recent_context=recent_context or "(no recent context)",
        kb_block=_render_kb_block(kb_chunks),
    )

    try:
        result = complete(
            system=_RESPONSE_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_prompt}],
            model=_HAIKU_MODEL,
            max_tokens=_MAX_TOKENS,
        )
    except Exception as exc:
        # No fallback mechanism anymore. On an API failure return a
        # short graceful handoff so the client never sees an empty
        # post (the dispatch layer posts response_text verbatim).
        logger.warning(
            "digest_response: response Haiku call failed (%s); "
            "returning graceful handoff",
            exc,
        )
        return DigestResponseResult(
            response_text=(
                "Let me get your advisor on this one — they'll follow up " "shortly."
            ),
            fallback_to_sonnet=False,
            cost_usd=Decimal("0"),
            input_tokens=0,
            output_tokens=0,
        )

    text = (result.text or "").strip()
    return DigestResponseResult(
        response_text=text,
        fallback_to_sonnet=False,
        cost_usd=result.cost_usd,
        input_tokens=result.input_tokens,
        output_tokens=result.output_tokens,
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
