"""Thin Anthropic API wrapper.

One entry point — `complete()` — that takes a system prompt and messages,
calls Claude, and returns the response text plus token / cost accounting.
When a `run_id` is provided, the llm_* fields are written to the matching
`agent_runs` row so cost lands on the right run without the caller having
to remember to pipe them through.

Example:

    from shared.claude_client import complete
    from shared.logging import start_agent_run, end_agent_run

    run_id = start_agent_run("ella", "slack_mention")
    result = complete(
        system="You are Ella, ...",
        messages=[{"role": "user", "content": "how do I ...?"}],
        run_id=run_id,
    )
    end_agent_run(run_id, status="success", output_summary=result.text[:200])
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from functools import lru_cache
from typing import Any

from anthropic import Anthropic
from anthropic.types import Message

from shared.db import get_client

DEFAULT_MODEL = "claude-sonnet-4-6"

# USD per million tokens. Update when Anthropic publishes new pricing.
_PRICING_PER_MILLION: dict[str, dict[str, Decimal]] = {
    "claude-opus-4-7":            {"input": Decimal("15.00"), "output": Decimal("75.00")},
    "claude-sonnet-4-6":          {"input": Decimal("3.00"),  "output": Decimal("15.00")},
    "claude-haiku-4-5":           {"input": Decimal("1.00"),  "output": Decimal("5.00")},
    # Date-suffixed Haiku alias used by Ella V2 Batch 2.3 passive
    # monitoring. Same per-token rates as the unsuffixed alias; both
    # entries kept so callers using either model string get accurate
    # cost attribution.
    "claude-haiku-4-5-20251001":  {"input": Decimal("1.00"),  "output": Decimal("5.00")},
}


@dataclass(frozen=True)
class CompletionResult:
    """What a call to `complete()` returns."""

    text: str
    model: str
    input_tokens: int
    output_tokens: int
    cost_usd: Decimal
    raw: Message


@lru_cache(maxsize=1)
def _anthropic_client() -> Anthropic:
    return Anthropic()


def estimate_cost_usd(model: str, input_tokens: int, output_tokens: int) -> Decimal:
    """Return the USD cost of a call given the token counts.

    Returns Decimal('0') and does not raise for unknown models — cost
    tracking should never break an agent run. Unknown-model rows show
    up as zero-cost in reports and can be corrected after the pricing
    table is updated.
    """
    rates = _PRICING_PER_MILLION.get(model)
    if rates is None:
        return Decimal("0")
    million = Decimal("1000000")
    return (
        rates["input"] * Decimal(input_tokens) / million
        + rates["output"] * Decimal(output_tokens) / million
    )


def complete(
    system: str,
    messages: list[dict[str, Any]],
    model: str = DEFAULT_MODEL,
    max_tokens: int = 1024,
    run_id: str | None = None,
) -> CompletionResult:
    """Call Claude with `system` + `messages`; return text + token counts + cost.

    If `run_id` is provided, the llm_model / llm_input_tokens /
    llm_output_tokens / llm_cost_usd columns on that agent_runs row are
    updated immediately. The row's `status` is left untouched — the
    caller still owns closing the run via `end_agent_run`.
    """
    message = _anthropic_client().messages.create(
        model=model,
        system=system,
        messages=messages,
        max_tokens=max_tokens,
    )

    text = "".join(
        block.text for block in message.content if getattr(block, "type", None) == "text"
    )
    input_tokens = message.usage.input_tokens
    output_tokens = message.usage.output_tokens
    cost = estimate_cost_usd(model, input_tokens, output_tokens)

    if run_id is not None:
        (
            get_client()
            .table("agent_runs")
            .update(
                {
                    "llm_model": model,
                    "llm_input_tokens": input_tokens,
                    "llm_output_tokens": output_tokens,
                    "llm_cost_usd": str(cost),
                }
            )
            .eq("id", run_id)
            .execute()
        )

    return CompletionResult(
        text=text,
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_usd=cost,
        raw=message,
    )
