"""Persist a `PassiveEvaluation` and fire side effects.

Split from `agents/ella/passive_monitor.py` so the decision module
stays pure (Haiku call only) and this module owns the database +
Slack side effects. Two call sites:

  1. `ingestion/slack/realtime_ingest.py` — calls `persist_passive_evaluation`
     after `evaluate_passive_trigger`.
  2. Test code that wants to exercise the persistence path with a
     mocked `PassiveEvaluation`.

Side effects per decision:

  - skip  -> agent_runs row (status='success', output_summary mentions
             the skip reason / Haiku reasoning).
  - escalate -> agent_runs row + escalations row (via
             `agents.ella.escalation.escalate`) + backend DMs to Scott
             (`ESCALATION_RECIPIENT_SLACK_USER_ID`) AND the channel's
             primary CSM via the shared fan-out helper
             `agents.ella.escalation_routing.fire_escalation_dms`. NO
             client-facing post. Audit ledger: per-recipient
             `webhook_deliveries.source='ella_escalation_dm'`.
  - respond_substantive -> agent_runs row + pending_ella_responses
             row queued for the per-minute cron to drain.
  - respond_general_inquiry -> same shape as respond_substantive.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from agents.ella.escalation import escalate as ella_escalate
from agents.ella.escalation_routing import (
    fire_escalation_dms,
    resolve_escalation_recipients,
)
from agents.ella.passive_monitor import PassiveEvaluation
from shared.db import get_client
from shared.logging import end_agent_run, start_agent_run

logger = logging.getLogger("ai_enablement.ella.passive_dispatch")

# Delay before the cron may generate the response. Per Drake's 2026-05-11
# call (post-spec): CSMs structurally don't respond inside any realistic
# window because they're in meetings, so the CSM-interjection rationale
# the 4-min midpoint was buying us is mostly theoretical. Dropped to 1 min
# for snappier client UX. Real-world perceived latency is 1-2 min because
# the per-minute cron tick is the floor above this delay. The full queue +
# cron + intervention-check machinery stays in place pending production
# data on how often `cancelled_csm_intervened` actually fires; if the
# count is ~0 after meaningful traffic, Batch 2.4 rips out the queue and
# moves to synchronous response from the ingest fork.
_RESPOND_AFTER_DELAY = timedelta(minutes=1)


def persist_passive_evaluation(evaluation: PassiveEvaluation) -> dict[str, Any]:
    """Write the agent_runs row, then dispatch decision-specific side
    effects. Returns a structured dict for the caller / tests."""
    payload = evaluation.payload
    decision = evaluation.decision

    trigger_metadata = {
        "triggering_slack_channel_id": payload.slack_channel_id,
        "triggering_message_ts": payload.triggering_message_ts,
        "triggering_message_slack_user_id": payload.triggering_message_slack_user_id,
        "channel_client_id": payload.channel_client_id,
        "author_type": payload.author_type,
        "haiku_decision": decision.decision,
        "haiku_reasoning": decision.reasoning,
        "skip_reason": evaluation.skip_reason,
    }
    # Tag test-mode runs so audit queries can filter test traffic out of
    # production metrics:
    #   AND (trigger_metadata->>'test_mode_run' IS NULL
    #     OR trigger_metadata->>'test_mode_run' != 'true')
    # Only stamped when the channel's `slack_channels.test_mode=True` —
    # production passive runs never carry this flag.
    if payload.test_mode:
        trigger_metadata["test_mode_run"] = True
    # Stamp the escalation-keyword bypass when it fired on Gate 4
    # (see `agents.ella.passive_monitor._ESCALATION_BYPASS_KEYWORDS`).
    # /ella/runs reads this field to surface which trigger reached
    # Haiku via the bypass path; production iteration on the keyword
    # list reads aggregates from here.
    if evaluation.bypass_keyword:
        trigger_metadata["kb_relevance_bypass_keyword"] = evaluation.bypass_keyword
    input_summary = (payload.triggering_message_text or "")[:200]

    run_id = start_agent_run(
        agent_name="ella",
        trigger_type="passive_monitor",
        trigger_metadata=trigger_metadata,
        input_summary=input_summary,
    )

    if decision.haiku_input_tokens or decision.haiku_output_tokens:
        # Cost wasn't written through `complete(run_id=...)` because we
        # didn't have the run_id at decision time (pure decision module
        # can't know the run_id without a callback). Write now so cost
        # rollups stay accurate.
        try:
            (
                get_client()
                .table("agent_runs")
                .update(
                    {
                        "llm_model": "claude-haiku-4-5-20251001",
                        "llm_input_tokens": decision.haiku_input_tokens,
                        "llm_output_tokens": decision.haiku_output_tokens,
                        "llm_cost_usd": str(decision.haiku_cost_usd),
                    }
                )
                .eq("id", run_id)
                .execute()
            )
        except Exception as exc:
            logger.warning(
                "passive_dispatch: cost write failed run_id=%s: %s",
                run_id,
                exc,
            )

    if decision.decision in ("respond_substantive", "respond_general_inquiry"):
        pending_id = _insert_pending(
            run_id=run_id,
            payload=payload,
            decision=decision,
        )
        end_agent_run(
            run_id,
            status="success",
            output_summary=f"queued ({decision.decision}); pending_id={pending_id}",
        )
        return {
            "agent_run_id": run_id,
            "pending_id": pending_id,
            "decision": decision.decision,
        }

    if decision.decision == "escalate":
        escalation_id = _write_passive_escalations_row(
            run_id=run_id,
            payload=payload,
            decision=decision,
            evaluation=evaluation,
        )
        recipients = resolve_escalation_recipients(evaluation.primary_csm)
        dm_results = fire_escalation_dms(
            recipients=recipients,
            slack_channel_id=payload.slack_channel_id,
            triggering_message_ts=payload.triggering_message_ts,
            reasoning=decision.reasoning,
            path="passive",
            channel_client_id=payload.channel_client_id,
        )
        end_agent_run(
            run_id,
            status="escalated" if escalation_id else "success",
            output_summary=_format_escalation_summary(dm_results, escalation_id),
        )
        return {
            "agent_run_id": run_id,
            "decision": "escalate",
            "escalation_id": escalation_id,
            "dm_results": dm_results,
        }

    # decision.decision == 'skip'
    skip_label = evaluation.skip_reason or "haiku_skip"
    end_agent_run(
        run_id,
        status="success",
        output_summary=f"skipped ({skip_label}): {decision.reasoning[:160]}",
    )
    return {
        "agent_run_id": run_id,
        "decision": "skip",
        "skip_reason": skip_label,
    }


# ---------------------------------------------------------------------------
# Pending-queue insert
# ---------------------------------------------------------------------------


def _insert_pending(
    *,
    run_id: str,
    payload,
    decision,
) -> str | None:
    """Insert one pending_ella_responses row. Returns the new id, or
    None if the unique constraint fires (duplicate same-message
    re-fire — defense in depth)."""
    respond_after = (
        datetime.now(timezone.utc) + _RESPOND_AFTER_DELAY
    ).isoformat()
    row = {
        "agent_run_id": run_id,
        "slack_channel_id": payload.slack_channel_id,
        "triggering_message_ts": payload.triggering_message_ts,
        "triggering_message_slack_user_id": payload.triggering_message_slack_user_id,
        "haiku_decision": decision.decision,
        "haiku_reasoning": decision.reasoning,
        "respond_after_ts": respond_after,
    }
    try:
        result = (
            get_client()
            .table("pending_ella_responses")
            .insert(row)
            .execute()
        )
        rows = result.data or []
        return rows[0]["id"] if rows else None
    except Exception as exc:
        # Unique constraint on (slack_channel_id, triggering_message_ts)
        # protects against re-fires. Log and continue — the original
        # row will drain on schedule.
        logger.warning(
            "passive_dispatch: pending insert failed (likely duplicate) "
            "channel=%s ts=%s: %s",
            payload.slack_channel_id,
            payload.triggering_message_ts,
            exc,
        )
        return None


# ---------------------------------------------------------------------------
# Escalation persistence + DM fan-out
# ---------------------------------------------------------------------------
#
# Pre-2026-05-14 the passive escalation branch fired ONE DM to the
# channel's primary CSM and never wrote an `escalations` row. The
# unified-escalation spec moved the DM fan-out into the shared
# `agents.ella.escalation_routing` module and added an `escalations`
# row write so both reactive and passive paths persist identically.
# Audit rows under `webhook_deliveries.source='ella_escalation_dm'`
# (renamed from `ella_passive_escalation_dm`; the dashboard's
# `fetchEscalationBodies` accepts both).


def _write_passive_escalations_row(
    *,
    run_id: str,
    payload,
    decision,
    evaluation: PassiveEvaluation,
) -> str | None:
    """Write the `escalations` row for a passive escalation.

    Mirrors the reactive-path `context` shape closely — `query_text` is
    the triggering message text, `ella_response` is empty (passive
    never posts), `handoff_reasoning` is the Haiku reasoning. Returns
    the new escalation id, or `None` on failure (logged; the DM fan-out
    proceeds either way so a single DB blip doesn't suppress the
    escalation surface).
    """
    if not payload.channel_client_id:
        return None
    try:
        return ella_escalate(
            reason="ella_passive_escalated",
            context={
                "query_text": payload.triggering_message_text,
                "ella_response": "",
                "handoff_reasoning": decision.reasoning,
                "client_id": payload.channel_client_id,
                "haiku_decision": "escalate",
                "kb_chunks_count": len(evaluation.kb_chunks),
            },
            client_id=payload.channel_client_id,
            agent_run_id=run_id,
        )
    except Exception as exc:
        logger.warning(
            "passive_dispatch: escalations row write failed run_id=%s: %s",
            run_id,
            exc,
        )
        return None


def _format_escalation_summary(
    dm_results: list[dict[str, Any]], escalation_id: str | None
) -> str:
    """Build the `agent_runs.output_summary` line for the escalate branch.

    Format kept short for the audit dashboard's Output column. Includes
    every recipient label + dm_ok so partial failures stay visible
    without a separate join.
    """
    if not dm_results:
        return (
            f"escalated; no_recipients; escalation_id={escalation_id or 'none'}"
        )
    parts = [
        f"{r['label']}={'ok' if r['dm_ok'] else 'fail'}" for r in dm_results
    ]
    return (
        f"escalated via DM; {', '.join(parts)}; "
        f"escalation_id={escalation_id or 'none'}"
    )
