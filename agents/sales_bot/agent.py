"""Sales bot — the tool-use loop.

`handle_question(payload)` runs a bounded Claude tool-use loop: Claude writes a
read-only SELECT, the `run_sql` tool executes it (guarded, RO role), Claude reads
the rows and either iterates (on an error / empty result) or composes the final
answer. The answer (number + definition used + disclaimer) is posted back to the
Slack thread.

Mirrors Ella's operational shape — synchronous, fail-soft (never raises so the
Slack webhook still acks 200), every run logged to `agent_runs`. Unlike Ella
there's no KB/embeddings: this is structured-data Q&A, so the "retrieval" is SQL.

`shared.claude_client.complete()` is text-only, so the tool loop calls the
Anthropic SDK directly via `_anthropic_client()`; token cost is accumulated
across the loop and written once at the end.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from typing import Any

from shared.claude_client import DEFAULT_MODEL, _anthropic_client, estimate_cost_usd
from shared.db import get_client
from shared.logging import end_agent_run, logger, start_agent_run
from shared.slack_post import post_message

from agents.sales_bot.prompt import build_system_prompt
from agents.sales_bot.sql_runner import MAX_ROWS, run_sql

_MODEL = DEFAULT_MODEL  # Sonnet (claude-sonnet-4-6)
_MAX_TOKENS = 1500
_MAX_TURNS = 6  # bounded tool loop — caps cost on a query Claude can't pin down
_TOOL_RESULT_CHAR_CAP = 6000  # keep tool_result payloads bounded

_MENTION_SYNTAX = re.compile(r"<@[UW][A-Z0-9]+>")

RUN_SQL_TOOL: dict[str, Any] = {
    "name": "run_sql",
    "description": (
        "Run ONE read-only Postgres SELECT/WITH query and get the rows back. "
        f"Results are capped at {MAX_ROWS} rows. On an error you get the message "
        "back so you can fix the query and retry."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "A single read-only SELECT/WITH query.",
            }
        },
        "required": ["query"],
    },
}

_FALLBACK_ANSWER = "I couldn't pin that down — try rephrasing, or check the dashboard."


@dataclass(frozen=True)
class SalesBotPayload:
    """The bits of a Slack app_mention the bot needs."""

    channel: str
    text: str
    thread_ts: str | None
    slack_user_id: str | None
    message_ts: str | None


@dataclass(frozen=True)
class SalesBotResult:
    """Structured outcome for tests / telemetry."""

    agent_run_id: str | None
    answer: str
    posted: bool
    status: str  # 'success' | 'error' | 'skipped'
    tool_calls: int


def payload_from_event(event: dict[str, Any]) -> SalesBotPayload:
    """Build a payload from a Slack `app_mention` event. Reply in-thread: use
    the message's own ts as the thread anchor when it isn't already threaded."""
    ts = event.get("ts") or event.get("event_ts")
    return SalesBotPayload(
        channel=event.get("channel") or "",
        text=event.get("text") or "",
        thread_ts=event.get("thread_ts") or ts,
        slack_user_id=event.get("user"),
        message_ts=ts,
    )


def _strip_mention(text: str) -> str:
    return _MENTION_SYNTAX.sub("", text or "").strip()


def _authorize(slack_user_id: str | None) -> tuple[bool, bool]:
    """Defense-in-depth audience gate, on top of the channel gate in
    api/slack_events.py. Returns `(allowed, is_known_member)`.

    `allowed` = the asker is an internal team member WITH sales access
    (`'sales'` in `team_members.areas`). `is_known_member` = they map to any
    non-archived `team_members` row at all.

    This is the guarantee that *clients can never get a SQL answer*: a client's
    Slack user id never maps to a sales-area team_members row, so even if the
    channel were ever misconfigured to a client channel, the bot stays silent.
    FAILS CLOSED — if the lookup errors or the user is unknown, access is denied.
    """
    if not slack_user_id:
        return (False, False)
    try:
        res = (
            get_client()
            .table("team_members")
            .select("areas")
            .eq("slack_user_id", slack_user_id)
            .is_("archived_at", "null")
            .limit(1)
            .execute()
        )
    except Exception as exc:  # noqa: BLE001 — fail closed on any lookup error
        logger.warning(
            "sales_bot: authorize lookup failed user=%s: %s", slack_user_id, exc
        )
        return (False, False)
    rows = res.data or []
    if not rows:
        return (False, False)
    areas = rows[0].get("areas") or []
    return ("sales" in areas, True)


def handle_question(payload: SalesBotPayload) -> SalesBotResult:
    """Answer a sales question. Never raises — degrades to an error reply so the
    webhook stays fail-soft."""
    question = _strip_mention(payload.text)
    run_id = start_agent_run(
        agent_name="sales_bot",
        trigger_type="slack_mention",
        trigger_metadata={
            "channel": payload.channel,
            "message_ts": payload.message_ts,
            "slack_user_id": payload.slack_user_id,
        },
        input_summary=question[:200],
    )

    allowed, is_known_member = _authorize(payload.slack_user_id)
    if not allowed:
        if is_known_member:
            # Internal staff without sales access — a polite refusal is fine.
            msg = "Sorry — the sales bot is limited to the sales team."
            posted = _post(payload, msg)
            end_agent_run(run_id, status="skipped", output_summary="not_sales_area")
            return SalesBotResult(run_id, msg, posted, "skipped", 0)
        # Unknown user (NOT an internal team member — could be a client). Stay
        # SILENT: no post, so a client never even gets a hint of the bot.
        logger.info(
            "sales_bot: unauthorized user=%s channel=%s — silent skip",
            payload.slack_user_id,
            payload.channel,
        )
        end_agent_run(run_id, status="skipped", output_summary="unauthorized_user")
        return SalesBotResult(run_id, "", False, "skipped", 0)

    if not question:
        # bare @mention — nudge, no LLM call
        msg = "Ask me a sales question — e.g. _how many leads opted in this week?_"
        posted = _post(payload, msg)
        end_agent_run(run_id, status="success", output_summary="bare_mention")
        return SalesBotResult(run_id, msg, posted, "success", 0)

    started = time.monotonic()
    try:
        answer, tool_calls, in_tok, out_tok = _run_tool_loop(question)
    except Exception as exc:  # noqa: BLE001 — fail-soft
        logger.exception(
            "sales_bot: tool loop failed channel=%s: %s", payload.channel, exc
        )
        msg = (
            "I hit a snag running that — try again in a moment, or check the dashboard."
        )
        posted = _post(payload, msg)
        end_agent_run(
            run_id,
            status="error",
            output_summary=f"tool_loop_failed: {type(exc).__name__}",
            error_message=str(exc)[:2000],
        )
        return SalesBotResult(run_id, msg, posted, "error", 0)

    posted = _post(payload, answer)
    end_agent_run(
        run_id,
        status="success",
        output_summary=answer[:200],
        llm_model=_MODEL,
        llm_input_tokens=in_tok,
        llm_output_tokens=out_tok,
        llm_cost_usd=estimate_cost_usd(_MODEL, in_tok, out_tok),
        duration_ms=int((time.monotonic() - started) * 1000),
        metadata={"tool_calls": tool_calls},
    )
    return SalesBotResult(run_id, answer, posted, "success", tool_calls)


def _run_tool_loop(question: str) -> tuple[str, int, int, int]:
    """Drive the bounded Claude tool-use loop. Returns
    `(answer_text, tool_call_count, input_tokens, output_tokens)`."""
    client = _anthropic_client()
    system = build_system_prompt()
    messages: list[dict[str, Any]] = [{"role": "user", "content": question}]
    in_tok = out_tok = tool_calls = 0

    for _ in range(_MAX_TURNS):
        resp = client.messages.create(
            model=_MODEL,
            max_tokens=_MAX_TOKENS,
            system=system,
            tools=[RUN_SQL_TOOL],
            messages=messages,
        )
        in_tok += resp.usage.input_tokens
        out_tok += resp.usage.output_tokens

        if resp.stop_reason != "tool_use":
            text = "".join(
                b.text for b in resp.content if getattr(b, "type", None) == "text"
            ).strip()
            return (text or _FALLBACK_ANSWER, tool_calls, in_tok, out_tok)

        messages.append({"role": "assistant", "content": resp.content})
        tool_results: list[dict[str, Any]] = []
        for block in resp.content:
            if getattr(block, "type", None) != "tool_use" or block.name != "run_sql":
                continue
            tool_calls += 1
            query = (block.input or {}).get("query", "")
            try:
                out: dict[str, Any] = run_sql(query)
            except Exception as exc:  # noqa: BLE001 — feed the error back to Claude
                out = {"error": str(exc)}
            tool_results.append(
                {
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": json.dumps(out, default=str)[:_TOOL_RESULT_CHAR_CAP],
                }
            )
        messages.append({"role": "user", "content": tool_results})

    # exhausted the turn budget without a final answer
    return (_FALLBACK_ANSWER, tool_calls, in_tok, out_tok)


def _post(payload: SalesBotPayload, text: str) -> bool:
    result = post_message(payload.channel, text, thread_ts=payload.thread_ts)
    return bool(result.get("ok"))
