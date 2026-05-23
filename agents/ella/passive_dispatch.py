"""Persist a `PassiveEvaluation` and fire side effects.

Split-path rewrite (2026-05-23): passive monitoring is now
**observation-only**. The decision Haiku still runs and tags messages
with a decision + digest signal, but this dispatch layer NO LONGER
posts in client channels and NO LONGER fires escalation DMs from the
passive path. All passive outcomes collapse to the same shape:

  - Write the `agent_runs` row.
  - If `digest_flag=True`, write a `pending_digest_items` row.
  - That's it.

@-mention messages are handled by `agents.ella.agent.handle_at_mention`
upstream (routed by `realtime_ingest._maybe_dispatch_passive_monitor`)
and never reach this module. The `_dispatch_mention` /
`_post_haiku_response` / `_insert_pending` paths from the prior
unified-path design are gone.

The `pending_ella_responses` queue is no longer written by this layer.
Stale rows that may exist from before the split drain silently via
`agent.respond_to_passive_trigger`, which is now a no-op.
"""

from __future__ import annotations

import logging
from typing import Any

from agents.ella.passive_monitor import PassiveEvaluation
from shared.db import get_client
from shared.logging import end_agent_run, start_agent_run

logger = logging.getLogger("ai_enablement.ella.passive_dispatch")

_HAIKU_MODEL = "claude-haiku-4-5-20251001"


def persist_passive_evaluation(evaluation: PassiveEvaluation) -> dict[str, Any]:
    """Write the `agent_runs` row and (if flagged) one
    `pending_digest_items` row. No in-channel posts, no DMs, no
    escalations — passive is observation-only after the 2026-05-23
    split.

    Returns a structured dict for the caller / tests.
    """
    payload = evaluation.payload
    decision = evaluation.decision

    # Kill switch: no agent_runs row at all (audit-noise optimization).
    if evaluation.skip_reason == "kill_switch":
        return {"decision": "skip", "skip_reason": "kill_switch", "agent_run_id": None}

    trigger_metadata: dict[str, Any] = {
        "triggering_slack_channel_id": payload.slack_channel_id,
        "triggering_message_ts": payload.triggering_message_ts,
        "triggering_message_slack_user_id": payload.triggering_message_slack_user_id,
        "channel_client_id": payload.channel_client_id,
        "author_type": payload.author_type,
        "is_ella_mentioned": payload.is_ella_mentioned,
        "is_routed_to_others": payload.is_routed_to_others,
        "haiku_decision": decision.decision,
        "response_model": decision.response_model,
        "ack_text": decision.ack_text,
        "haiku_reasoning": decision.reasoning,
        "digest_flag": decision.digest_flag,
        "digest_category": decision.digest_category,
        "skip_reason": evaluation.skip_reason,
    }

    run_id = start_agent_run(
        agent_name="ella",
        trigger_type="passive_monitor",
        trigger_metadata=trigger_metadata,
        input_summary=(payload.triggering_message_text or "")[:200],
    )

    decision_cost = {
        "input_tokens": decision.haiku_input_tokens,
        "output_tokens": decision.haiku_output_tokens,
        "cost_usd": decision.haiku_cost_usd,
    }
    _write_cost(run_id, decision_cost)

    digest_id: str | None = None
    if decision.digest_flag:
        digest_id = _insert_pending_digest_item(
            run_id=run_id,
            payload=payload,
            evaluation=evaluation,
            ella_responded=False,  # passive never responds in-channel post-split
        )

    # Status-honesty fix (spec § Folded-in fix 3): an exception inside
    # the decision Haiku that fell through to `_SAFER_FALLBACK_DECISION`
    # carries a `haiku_call_failed:` reasoning prefix. Surface those as
    # `status='error'` so a future "Ella's gone quiet" incident shows
    # up on `/ella/runs WHERE status='error'`. Keep user-facing
    # behavior unchanged (passive doesn't post anyway).
    if (decision.reasoning or "").startswith("haiku_call_failed:") or (
        evaluation.skip_reason == "exception"
    ):
        end_agent_run(
            run_id,
            status="error",
            output_summary=f"{evaluation.skip_reason or 'haiku_skip'}: {decision.reasoning[:160]}",
            error_message=decision.reasoning[:2000],
        )
        return {
            "agent_run_id": run_id,
            "decision": decision.decision,
            "skip_reason": evaluation.skip_reason or "haiku_call_failed",
            "digest_item_id": digest_id,
            "status": "error",
        }

    # Every successful passive outcome lands as status='success' with the
    # decision summarized in output_summary. The decision the Haiku
    # picked (respond / acknowledge_and_escalate / skip) is preserved in
    # trigger_metadata.haiku_decision for audit, but the dispatch layer
    # no longer acts on it differently — observation-only.
    summary_label = evaluation.skip_reason or decision.decision
    end_agent_run(
        run_id,
        status="success",
        output_summary=f"observe ({summary_label}): {decision.reasoning[:160]}",
    )
    return {
        "agent_run_id": run_id,
        "decision": decision.decision,
        "skip_reason": evaluation.skip_reason,
        "digest_item_id": digest_id,
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_cost(run_id: str, cost: dict[str, Any]) -> None:
    if not (cost["input_tokens"] or cost["output_tokens"]):
        return
    try:
        (
            get_client()
            .table("agent_runs")
            .update(
                {
                    "llm_model": _HAIKU_MODEL,
                    "llm_input_tokens": cost["input_tokens"],
                    "llm_output_tokens": cost["output_tokens"],
                    "llm_cost_usd": str(cost["cost_usd"]),
                }
            )
            .eq("id", run_id)
            .execute()
        )
    except Exception as exc:
        logger.warning("passive_dispatch: cost write failed run_id=%s: %s", run_id, exc)


def _insert_pending_digest_item(
    *, run_id: str, payload, evaluation: PassiveEvaluation, ella_responded: bool
) -> str | None:
    decision = evaluation.decision
    return insert_digest_item(
        run_id=run_id,
        slack_channel_id=payload.slack_channel_id,
        triggering_message_ts=payload.triggering_message_ts,
        triggering_message_slack_user_id=payload.triggering_message_slack_user_id,
        client_id=payload.channel_client_id or None,
        message_text=payload.triggering_message_text,
        haiku_decision=decision.decision,
        haiku_reasoning=decision.reasoning,
        digest_category=decision.digest_category,
        ella_responded=ella_responded,
    )


def insert_digest_item(
    *,
    run_id: str,
    slack_channel_id: str,
    triggering_message_ts: str,
    triggering_message_slack_user_id: str | None,
    client_id: str | None,
    message_text: str | None,
    haiku_decision: str,
    haiku_reasoning: str | None,
    digest_category: str | None,
    ella_responded: bool,
) -> str | None:
    """Insert one pending_digest_items row. Returns the new id, or None
    if the unique index `(slack_channel_id, triggering_message_ts)`
    fires (re-processed message — the digest entry stays as-is).

    Also called by `agents.ella.agent.handle_at_mention` for the @
    path's escalate case so @-path escalations surface in the daily
    digest too.
    """
    row = {
        "agent_run_id": run_id,
        "slack_channel_id": slack_channel_id,
        "triggering_message_ts": triggering_message_ts,
        "triggering_message_slack_user_id": triggering_message_slack_user_id,
        "client_id": client_id or None,
        "message_text": message_text,
        "haiku_decision": haiku_decision,
        "haiku_reasoning": haiku_reasoning,
        "digest_category": digest_category,
        "ella_responded": ella_responded,
    }
    try:
        result = get_client().table("pending_digest_items").insert(row).execute()
        rows = result.data or []
        return rows[0]["id"] if rows else None
    except Exception as exc:
        logger.warning(
            "passive_dispatch: pending_digest_items insert failed "
            "(likely duplicate) channel=%s ts=%s: %s",
            slack_channel_id,
            triggering_message_ts,
            exc,
        )
        return None
