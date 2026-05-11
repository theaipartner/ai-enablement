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
  - escalate -> agent_runs row + backend DM to the channel's primary
             CSM via `shared.slack_post.post_message`. NO client-facing
             post. Audit ledger: `webhook_deliveries.source=
             'ella_passive_escalation_dm'`.
  - respond_substantive -> agent_runs row + pending_ella_responses
             row queued for the per-minute cron to drain.
  - respond_general_inquiry -> same shape as respond_substantive.
"""

from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from agents.ella.passive_monitor import PassiveEvaluation
from shared.db import get_client
from shared.logging import end_agent_run, start_agent_run
from shared.slack_post import post_message

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

# Audit-ledger source label for the escalation DM. Separate from the
# realtime-ingest source so analytics can split escalation traffic from
# message ingest traffic.
_ESCALATION_DM_SOURCE = "ella_passive_escalation_dm"

# Truncation cap for the haiku_reasoning section of the escalation DM
# body. Spec § Trigger pipeline.9: "~200 chars".
_DM_REASONING_TRUNC = 200


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
        dm_result = _fire_escalation_dm(payload, decision, evaluation.primary_csm)
        end_agent_run(
            run_id,
            status="success",
            output_summary=(
                f"escalated via DM; csm={dm_result.get('csm_name')}; "
                f"dm_ok={dm_result.get('dm_ok')}"
            ),
        )
        return {
            "agent_run_id": run_id,
            "decision": "escalate",
            "dm_result": dm_result,
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
# Escalation DM
# ---------------------------------------------------------------------------


def _fire_escalation_dm(
    payload, decision, primary_csm: dict[str, Any] | None
) -> dict[str, Any]:
    """Post a backend DM to the channel's primary CSM. NO client-facing
    post. The DM body carries a Slack deep-link to the triggering
    message + the Haiku reasoning (truncated, no quoted client text).

    Audited under `_ESCALATION_DM_SOURCE` so a future operations probe
    can count escalation volume independently from response volume.
    """
    delivery_id = f"passive_escalation_{uuid.uuid4()}"
    db = get_client()

    # Insert the audit row up front; we'll update terminal status at
    # exit so failure paths still leave a row.
    audit_payload = {
        "slack_channel_id": payload.slack_channel_id,
        "triggering_message_ts": payload.triggering_message_ts,
        "channel_client_id": payload.channel_client_id,
        "haiku_reasoning": decision.reasoning,
    }
    _insert_dm_audit(db, delivery_id, audit_payload, status="received")

    if not primary_csm or not primary_csm.get("slack_user_id"):
        _mark_dm_audit(
            db,
            delivery_id,
            status="failed",
            error="no_primary_csm_slack_user_id",
        )
        logger.warning(
            "passive_dispatch: escalate decision but no primary_csm "
            "slack_user_id for channel=%s",
            payload.slack_channel_id,
        )
        return {"csm_name": None, "dm_ok": False, "delivery_id": delivery_id}

    csm_slack_id = primary_csm["slack_user_id"]
    csm_name = primary_csm.get("full_name")

    link = _build_message_permalink(
        payload.slack_channel_id, payload.triggering_message_ts
    )
    reasoning = (decision.reasoning or "")[:_DM_REASONING_TRUNC]
    body = (
        f":eyes: Worth a look — <{link}>\n"
        f"_Ella decided to escalate rather than respond. "
        f"Reasoning: {reasoning}_"
    )

    result = post_message(csm_slack_id, body)

    _mark_dm_audit(
        db,
        delivery_id,
        status="processed" if result["ok"] else "failed",
        error=None if result["ok"] else f"slack_post_failed: {result.get('slack_error')}",
    )

    return {
        "csm_name": csm_name,
        "csm_slack_id": csm_slack_id,
        "dm_ok": bool(result["ok"]),
        "delivery_id": delivery_id,
        "slack_error": result.get("slack_error"),
    }


def _build_message_permalink(slack_channel_id: str, slack_ts: str) -> str:
    """Construct an `archives/{channel}/p{ts_compact}` URL for the
    workspace. Optional env var `SLACK_WORKSPACE` lets us emit
    workspace-scoped permalinks; fallback omits the subdomain and
    Slack still routes correctly when clicked from a logged-in
    workspace.

    Slack permalink format: `https://<workspace>.slack.com/archives/<channel>/p<ts*1e6>`
    where `<ts*1e6>` is the slack_ts string with the dot removed.
    """
    workspace = os.environ.get("SLACK_WORKSPACE") or ""
    ts_compact = slack_ts.replace(".", "")
    subdomain = f"{workspace}." if workspace else ""
    return f"https://{subdomain}slack.com/archives/{slack_channel_id}/p{ts_compact}"


# ---------------------------------------------------------------------------
# Audit ledger
# ---------------------------------------------------------------------------


def _insert_dm_audit(
    db, delivery_id: str, payload: dict[str, Any], *, status: str
) -> None:
    try:
        row: dict[str, Any] = {
            "webhook_id": delivery_id,
            "source": _ESCALATION_DM_SOURCE,
            "processing_status": status,
            "payload": payload,
            "headers": {},
        }
        if status != "received":
            row["processed_at"] = datetime.now(timezone.utc).isoformat()
        db.table("webhook_deliveries").insert(row).execute()
    except Exception as exc:
        logger.warning(
            "passive_dispatch: dm audit insert failed delivery_id=%s: %s",
            delivery_id,
            exc,
        )


def _mark_dm_audit(
    db,
    delivery_id: str,
    *,
    status: str,
    error: str | None,
) -> None:
    try:
        update: dict[str, Any] = {
            "processing_status": status,
            "processed_at": datetime.now(timezone.utc).isoformat(),
        }
        if error is not None:
            update["processing_error"] = error[:2000]
        db.table("webhook_deliveries").update(update).eq(
            "webhook_id", delivery_id
        ).execute()
    except Exception as exc:
        logger.warning(
            "passive_dispatch: dm audit update failed delivery_id=%s: %s",
            delivery_id,
            exc,
        )
