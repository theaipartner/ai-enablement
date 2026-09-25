"""Structured agent-run logging.

Every agent execution gets one row in `agent_runs`. The caller opens the
row at entry (`start_agent_run`) and closes it at exit (`end_agent_run`),
including terminal status, token counts, and cost.

Per AGENTS.md: no `print()` for anything that should persist. This is
how agents record what they did, why, and what it cost.

Example:

    from shared.logging import start_agent_run, end_agent_run

    run_id = start_agent_run(
        agent_name="ella",
        trigger_type="slack_mention",
        trigger_metadata={"channel": "C123", "ts": "1.2"},
        input_summary="how do I set up my first sales call?",
    )
    try:
        ...  # do work, call Claude, etc.
        end_agent_run(
            run_id,
            status="success",
            output_summary="pointed client to module 3",
            llm_model="claude-sonnet-4-6",
            llm_input_tokens=1800,
            llm_output_tokens=120,
            llm_cost_usd=0.0123,
            duration_ms=2400,
        )
    except Exception as exc:
        end_agent_run(run_id, status="error", error_message=str(exc))
        raise
"""

from __future__ import annotations

import logging as _stdlib_logging
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from shared.db import get_client

# Canonical project logger. Other shared modules import this rather than
# creating their own so log output routes through a single namespace.
# Apps (Slack bot entry points, CLIs, etc.) configure handlers on
# "ai_enablement" at startup.
logger = _stdlib_logging.getLogger("ai_enablement")

RUNNING_STATUS = "running"
TERMINAL_STATUSES = {"success", "escalated", "error", "skipped"}


def start_agent_run(
    agent_name: str,
    trigger_type: str,
    trigger_metadata: dict[str, Any] | None = None,
    input_summary: str | None = None,
) -> str:
    """Insert a new agent_runs row and return its id.

    The row lands with `status='running'`. Call `end_agent_run` when the
    agent finishes (success, escalated, error, or skipped) to flip status
    and attach token / cost / duration data.
    """
    payload: dict[str, Any] = {
        "agent_name": agent_name,
        "trigger_type": trigger_type,
        "status": RUNNING_STATUS,
    }
    if trigger_metadata is not None:
        payload["trigger_metadata"] = trigger_metadata
    if input_summary is not None:
        payload["input_summary"] = input_summary

    result = (
        get_client()
        .table("agent_runs")
        .insert(payload)
        .execute()
    )
    return result.data[0]["id"]


def end_agent_run(
    run_id: str,
    status: str,
    output_summary: str | None = None,
    confidence_score: float | None = None,
    llm_model: str | None = None,
    llm_input_tokens: int | None = None,
    llm_output_tokens: int | None = None,
    llm_cost_usd: Decimal | float | None = None,
    duration_ms: int | None = None,
    error_message: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Update an agent_runs row with terminal fields.

    `status` must be one of `success`, `escalated`, `error`, or `skipped`.
    Sets `ended_at` to now() via database default-less explicit write so
    both success and error paths are dated consistently.

    Note: if `shared.claude_client.complete()` was called with this
    run_id, the llm_* fields are already written — omit them here.
    """
    if status not in TERMINAL_STATUSES:
        raise ValueError(
            f"status must be one of {sorted(TERMINAL_STATUSES)}; got {status!r}"
        )

    payload: dict[str, Any] = {
        "status": status,
        "ended_at": datetime.now(timezone.utc).isoformat(),
    }
    for key, value in (
        ("output_summary", output_summary),
        ("confidence_score", confidence_score),
        ("llm_model", llm_model),
        ("llm_input_tokens", llm_input_tokens),
        ("llm_output_tokens", llm_output_tokens),
        ("llm_cost_usd", None if llm_cost_usd is None else str(llm_cost_usd)),
        ("duration_ms", duration_ms),
        ("error_message", error_message),
        ("metadata", metadata),
    ):
        if value is not None:
            payload[key] = value

    get_client().table("agent_runs").update(payload).eq("id", run_id).execute()
