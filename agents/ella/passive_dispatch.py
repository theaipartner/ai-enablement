"""Persist a `PassiveEvaluation` and fire side effects.

Unified-path rewrite (2026-05-18 PM): three decision routings, down
from yesterday's four. There is no separate reactive path — every
message (including @-mentions) flows through here.

Side effects per decision:

  - skip                      -> agent_runs row (status='success').
                                 `kill_switch` writes NO row at all.
                                 `digest_flag=true` also writes a
                                 pending_digest_items row. The
                                 `routed_to_humans` pre-LLM skip rides
                                 this path: `skip_reason` carries the
                                 routing signal, `digest_flag=True` +
                                 `digest_category='other'` ensure the
                                 message surfaces in Scott's daily
                                 digest, and no Haiku cost is recorded
                                 because no Haiku call was made.
  - respond / haiku           -> response Haiku posts directly; cost =
                                 decision + response Haiku. No fallback.
  - respond / sonnet          -> pending_ella_responses row written as
                                 `respond_substantive` for the unchanged
                                 per-minute cron's Sonnet path.
  - acknowledge_and_escalate  -> post Haiku-written ack_text in-channel,
                                 write escalations row, fan DMs to Scott
                                 + primary advisor, write digest item
                                 (always). status='escalated'.
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

_RESPOND_AFTER_DELAY = timedelta(minutes=1)

# Value written to pending_ella_responses.haiku_decision so the
# unchanged per-minute cron drains the Sonnet path (compat shim from
# yesterday's spec — the cron dispatches on 'respond_substantive').
_PENDING_SONNET_DECISION = "respond_substantive"

_HAIKU_MODEL = "claude-haiku-4-5-20251001"


def persist_passive_evaluation(evaluation: PassiveEvaluation) -> dict[str, Any]:
    """Write the agent_runs row, then dispatch decision-specific side
    effects. Returns a structured dict for the caller / tests."""
    payload = evaluation.payload
    decision = evaluation.decision

    # Kill switch: no agent_runs row at all (audit-noise optimization).
    if evaluation.skip_reason == "kill_switch":
        return {"decision": "skip", "skip_reason": "kill_switch", "agent_run_id": None}

    # @-mention structural override: when the classifier handled this
    # message (decision Haiku bypassed), branch to _dispatch_mention.
    # The classifier's output enum has no `skip`, so this path always
    # produces a response of some shape.
    if evaluation.mention_classification is not None:
        return _dispatch_mention(evaluation)

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

    if decision.decision == "respond":
        return _dispatch_respond(run_id, evaluation, decision_cost)

    if decision.decision == "acknowledge_and_escalate":
        return _dispatch_acknowledge_and_escalate(run_id, evaluation, decision_cost)

    # decision.decision == 'skip'
    _write_cost(run_id, decision_cost)
    skip_label = evaluation.skip_reason or "haiku_skip"
    digest_id = None
    if decision.digest_flag:
        digest_id = _insert_pending_digest_item(
            run_id=run_id, payload=payload, evaluation=evaluation, ella_responded=False
        )
    end_agent_run(
        run_id,
        status="success",
        output_summary=f"skip ({skip_label}): {decision.reasoning[:160]}",
    )
    return {
        "agent_run_id": run_id,
        "decision": "skip",
        "skip_reason": skip_label,
        "digest_item_id": digest_id,
    }


# ---------------------------------------------------------------------------
# respond
# ---------------------------------------------------------------------------


def _dispatch_respond(
    run_id: str, evaluation: PassiveEvaluation, decision_cost: dict[str, Any]
) -> dict[str, Any]:
    payload = evaluation.payload
    decision = evaluation.decision

    if decision.response_model == "haiku":
        from agents.ella.digest_response import generate_response

        resp = generate_response(
            payload=payload,
            kb_chunks=evaluation.kb_chunks,
            recent_context=evaluation.recent_channel_context,
            primary_csm=evaluation.primary_csm,
            channel_client=None,
        )
        combined = {
            "input_tokens": decision_cost["input_tokens"] + resp.input_tokens,
            "output_tokens": decision_cost["output_tokens"] + resp.output_tokens,
            "cost_usd": decision_cost["cost_usd"] + resp.cost_usd,
        }
        post_result = _post_haiku_response(payload, resp.response_text)
        _write_cost(run_id, combined)
        if decision.digest_flag:
            _insert_pending_digest_item(
                run_id=run_id,
                payload=payload,
                evaluation=evaluation,
                ella_responded=True,
            )
        end_agent_run(
            run_id,
            status="success",
            output_summary=resp.response_text[:200],
            confidence_score=1.0,
        )
        return {
            "agent_run_id": run_id,
            "decision": "respond",
            "response_model": "haiku",
            "posted": bool(post_result["ok"]),
            "slack_error": post_result.get("slack_error"),
        }

    # response_model == 'sonnet' (also the safe default for missing)
    _write_cost(run_id, decision_cost)
    pending_id = _insert_pending(run_id=run_id, payload=payload, decision=decision)
    if decision.digest_flag:
        _insert_pending_digest_item(
            run_id=run_id,
            payload=payload,
            evaluation=evaluation,
            ella_responded=True,
        )
    end_agent_run(
        run_id,
        status="success",
        output_summary=f"queued (sonnet); pending_id={pending_id}",
    )
    return {
        "agent_run_id": run_id,
        "decision": "respond",
        "response_model": "sonnet",
        "pending_id": pending_id,
    }


# ---------------------------------------------------------------------------
# acknowledge_and_escalate
# ---------------------------------------------------------------------------


def _dispatch_acknowledge_and_escalate(
    run_id: str, evaluation: PassiveEvaluation, decision_cost: dict[str, Any]
) -> dict[str, Any]:
    """Post the warm ack in-channel, write the escalations row, fan DMs
    to Scott + primary advisor, write the digest item (always)."""
    payload = evaluation.payload
    decision = evaluation.decision
    ack_text = decision.ack_text or (
        "Let me grab someone for this one — your advisor will take care of you."
    )

    post_result = _post_haiku_response(payload, ack_text)

    escalation_id = None
    if payload.channel_client_id:
        try:
            escalation_id = ella_escalate(
                reason="ella_acknowledged_and_escalated",
                context={
                    "query_text": payload.triggering_message_text,
                    "ella_response": ack_text,
                    "handoff_reasoning": decision.reasoning,
                    "client_id": payload.channel_client_id,
                    "haiku_decision": "acknowledge_and_escalate",
                    "is_ella_mentioned": payload.is_ella_mentioned,
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

    recipients = resolve_escalation_recipients(evaluation.primary_csm)
    dm_results = fire_escalation_dms(
        recipients=recipients,
        slack_channel_id=payload.slack_channel_id,
        triggering_message_ts=payload.triggering_message_ts,
        reasoning=decision.reasoning,
        path="reactive" if payload.is_ella_mentioned else "passive",
        channel_client_id=payload.channel_client_id,
    )

    _write_cost(run_id, decision_cost)
    digest_id = _insert_pending_digest_item(
        run_id=run_id, payload=payload, evaluation=evaluation, ella_responded=False
    )
    end_agent_run(
        run_id,
        status="escalated",
        output_summary=_format_ack_escalate_summary(
            escalation_id, dm_results, post_result
        ),
        confidence_score=0.0,
    )
    return {
        "agent_run_id": run_id,
        "decision": "acknowledge_and_escalate",
        "escalation_id": escalation_id,
        "posted": bool(post_result["ok"]),
        "dm_results": dm_results,
        "digest_item_id": digest_id,
    }


def _format_ack_escalate_summary(
    escalation_id: str | None,
    dm_results: list[dict[str, Any]],
    post_result: dict[str, Any],
) -> str:
    posted = "ok" if post_result.get("ok") else "fail"
    if not dm_results:
        return (
            f"ack_and_escalate; ack_post={posted}; no_recipients; "
            f"escalation_id={escalation_id or 'none'}"
        )
    parts = [f"{r['label']}={'ok' if r['dm_ok'] else 'fail'}" for r in dm_results]
    return (
        f"ack_and_escalate; ack_post={posted}; {', '.join(parts)}; "
        f"escalation_id={escalation_id or 'none'}"
    )


# ---------------------------------------------------------------------------
# @-mention structural path (classifier-handled — never skip)
# ---------------------------------------------------------------------------


def _dispatch_mention(evaluation: PassiveEvaluation) -> dict[str, Any]:
    """Dispatch a classifier-handled @-mention message. Bypasses the
    decision Haiku entirely; the classifier's enum has no `skip`, so
    this function never returns silence. Four shapes routed:

      - respond_haiku → response Haiku writes + posts.
      - respond_sonnet → queue pending_ella_responses (shim:
        haiku_decision='respond_substantive' for the unchanged cron).
      - acknowledge_and_escalate → post ack_text, write escalations row,
        fan DMs to Scott + primary advisor.
      - warm_opener → response Haiku writes a 1-sentence friendly
        opener + posts.

    Independently: if classification.digest_flag, write a
    pending_digest_items row.
    """
    payload = evaluation.payload
    classification = evaluation.mention_classification

    trigger_metadata: dict[str, Any] = {
        "triggering_slack_channel_id": payload.slack_channel_id,
        "triggering_message_ts": payload.triggering_message_ts,
        "triggering_message_slack_user_id": payload.triggering_message_slack_user_id,
        "channel_client_id": payload.channel_client_id,
        "author_type": payload.author_type,
        "is_ella_mentioned": True,
        "is_routed_to_others": False,
        # Mention-path-specific fields (distinguish from haiku_decision
        # on the non-mention path — /ella/runs reads either):
        "mention_classifier_shape": classification.shape,
        "mention_classifier_reasoning": classification.reasoning,
        "ack_text": classification.ack_text,
        "digest_flag": classification.digest_flag,
        "digest_category": classification.digest_category,
        "skip_reason": None,  # never skipped on the mention path
    }

    run_id = start_agent_run(
        agent_name="ella",
        trigger_type="passive_monitor",
        trigger_metadata=trigger_metadata,
        input_summary=(payload.triggering_message_text or "")[:200],
    )

    classifier_cost = {
        "input_tokens": classification.haiku_input_tokens,
        "output_tokens": classification.haiku_output_tokens,
        "cost_usd": classification.haiku_cost_usd,
    }

    shape = classification.shape

    if shape == "respond_haiku":
        from agents.ella.digest_response import generate_response

        resp = generate_response(
            payload=payload,
            kb_chunks=evaluation.kb_chunks,
            recent_context=evaluation.recent_channel_context,
            primary_csm=evaluation.primary_csm,
            channel_client=None,
        )
        combined = {
            "input_tokens": classifier_cost["input_tokens"] + resp.input_tokens,
            "output_tokens": classifier_cost["output_tokens"] + resp.output_tokens,
            "cost_usd": classifier_cost["cost_usd"] + resp.cost_usd,
        }
        post_result = _post_haiku_response(payload, resp.response_text)
        _write_cost(run_id, combined)
        if classification.digest_flag:
            _insert_mention_digest_item(
                run_id=run_id, evaluation=evaluation, ella_responded=True
            )
        end_agent_run(
            run_id,
            status="success",
            output_summary=f"mention/respond_haiku: {resp.response_text[:160]}",
            confidence_score=1.0,
        )
        return {
            "agent_run_id": run_id,
            "decision": "mention/respond_haiku",
            "posted": bool(post_result["ok"]),
            "slack_error": post_result.get("slack_error"),
        }

    if shape == "respond_sonnet":
        _write_cost(run_id, classifier_cost)
        # Sonnet drain goes through the unchanged per-minute cron's
        # `respond_substantive` branch (same compat shim as the
        # non-mention path).
        pending_id = _insert_pending_for_mention_sonnet(
            run_id=run_id, payload=payload, classification=classification
        )
        if classification.digest_flag:
            _insert_mention_digest_item(
                run_id=run_id, evaluation=evaluation, ella_responded=True
            )
        end_agent_run(
            run_id,
            status="success",
            output_summary=f"mention/respond_sonnet; pending_id={pending_id}",
        )
        return {
            "agent_run_id": run_id,
            "decision": "mention/respond_sonnet",
            "pending_id": pending_id,
        }

    if shape == "acknowledge_and_escalate":
        ack_text = classification.ack_text or (
            "Let me get your advisor on this one — they'll follow up shortly."
        )
        post_result = _post_haiku_response(payload, ack_text)

        escalation_id = None
        if payload.channel_client_id:
            try:
                escalation_id = ella_escalate(
                    reason="ella_acknowledged_and_escalated",
                    context={
                        "query_text": payload.triggering_message_text,
                        "ella_response": ack_text,
                        "handoff_reasoning": classification.reasoning,
                        "client_id": payload.channel_client_id,
                        "haiku_decision": "acknowledge_and_escalate",
                        "is_ella_mentioned": True,
                        "mention_classifier_shape": shape,
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

        recipients = resolve_escalation_recipients(evaluation.primary_csm)
        dm_results = fire_escalation_dms(
            recipients=recipients,
            slack_channel_id=payload.slack_channel_id,
            triggering_message_ts=payload.triggering_message_ts,
            reasoning=classification.reasoning,
            path="reactive",  # mention path = reactive in audit terms
            channel_client_id=payload.channel_client_id,
        )

        _write_cost(run_id, classifier_cost)
        digest_id = _insert_mention_digest_item(
            run_id=run_id, evaluation=evaluation, ella_responded=False
        )
        end_agent_run(
            run_id,
            status="escalated",
            output_summary=_format_ack_escalate_summary(
                escalation_id, dm_results, post_result
            ),
            confidence_score=0.0,
        )
        return {
            "agent_run_id": run_id,
            "decision": "mention/acknowledge_and_escalate",
            "escalation_id": escalation_id,
            "posted": bool(post_result["ok"]),
            "dm_results": dm_results,
            "digest_item_id": digest_id,
        }

    # shape == "warm_opener" (or any unexpected value — the parser
    # guarantees `shape in _SHAPES`, but be defensive)
    from agents.ella.digest_response import generate_response

    resp = generate_response(
        payload=payload,
        kb_chunks=evaluation.kb_chunks,
        recent_context=evaluation.recent_channel_context,
        primary_csm=evaluation.primary_csm,
        channel_client=None,
        mode="warm_opener",
    )
    combined = {
        "input_tokens": classifier_cost["input_tokens"] + resp.input_tokens,
        "output_tokens": classifier_cost["output_tokens"] + resp.output_tokens,
        "cost_usd": classifier_cost["cost_usd"] + resp.cost_usd,
    }
    post_result = _post_haiku_response(payload, resp.response_text)
    _write_cost(run_id, combined)
    if classification.digest_flag:
        _insert_mention_digest_item(
            run_id=run_id, evaluation=evaluation, ella_responded=True
        )
    end_agent_run(
        run_id,
        status="success",
        output_summary=f"mention/warm_opener: {resp.response_text[:160]}",
        confidence_score=1.0,
    )
    return {
        "agent_run_id": run_id,
        "decision": "mention/warm_opener",
        "posted": bool(post_result["ok"]),
        "slack_error": post_result.get("slack_error"),
    }


def _insert_pending_for_mention_sonnet(
    *, run_id: str, payload, classification
) -> str | None:
    """Insert one pending_ella_responses row for the mention/sonnet
    shape. Writes `haiku_decision='respond_substantive'` so the
    unchanged per-minute cron drains it via the Sonnet path."""
    respond_after = (datetime.now(timezone.utc) + _RESPOND_AFTER_DELAY).isoformat()
    row = {
        "agent_run_id": run_id,
        "slack_channel_id": payload.slack_channel_id,
        "triggering_message_ts": payload.triggering_message_ts,
        "triggering_message_slack_user_id": payload.triggering_message_slack_user_id,
        "haiku_decision": _PENDING_SONNET_DECISION,
        "haiku_reasoning": classification.reasoning,
        "respond_after_ts": respond_after,
    }
    try:
        result = get_client().table("pending_ella_responses").insert(row).execute()
        rows = result.data or []
        return rows[0]["id"] if rows else None
    except Exception as exc:
        logger.warning(
            "passive_dispatch: mention pending insert failed channel=%s ts=%s: %s",
            payload.slack_channel_id,
            payload.triggering_message_ts,
            exc,
        )
        return None


def _insert_mention_digest_item(
    *, run_id: str, evaluation: PassiveEvaluation, ella_responded: bool
) -> str | None:
    """Mention-path adapter over `insert_digest_item`. The
    `haiku_decision` column carries the classifier shape so the digest
    can attribute the entry."""
    payload = evaluation.payload
    classification = evaluation.mention_classification
    return insert_digest_item(
        run_id=run_id,
        slack_channel_id=payload.slack_channel_id,
        triggering_message_ts=payload.triggering_message_ts,
        triggering_message_slack_user_id=payload.triggering_message_slack_user_id,
        client_id=payload.channel_client_id or None,
        message_text=payload.triggering_message_text,
        haiku_decision=f"mention/{classification.shape}",
        haiku_reasoning=classification.reasoning,
        digest_category=classification.digest_category,
        ella_responded=ella_responded,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _post_haiku_response(payload, text: str) -> dict[str, Any]:
    from shared.slack_post import post_message

    return post_message(payload.slack_channel_id, text)


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


def _insert_pending(*, run_id: str, payload, decision) -> str | None:
    """Insert one pending_ella_responses row for the Sonnet path
    (written as `respond_substantive` for the unchanged cron)."""
    respond_after = (datetime.now(timezone.utc) + _RESPOND_AFTER_DELAY).isoformat()
    row = {
        "agent_run_id": run_id,
        "slack_channel_id": payload.slack_channel_id,
        "triggering_message_ts": payload.triggering_message_ts,
        "triggering_message_slack_user_id": payload.triggering_message_slack_user_id,
        "haiku_decision": _PENDING_SONNET_DECISION,
        "haiku_reasoning": decision.reasoning,
        "respond_after_ts": respond_after,
    }
    try:
        result = get_client().table("pending_ella_responses").insert(row).execute()
        rows = result.data or []
        return rows[0]["id"] if rows else None
    except Exception as exc:
        logger.warning(
            "passive_dispatch: pending insert failed (likely duplicate) "
            "channel=%s ts=%s: %s",
            payload.slack_channel_id,
            payload.triggering_message_ts,
            exc,
        )
        return None


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
    fires (re-processed message — the digest entry stays as-is)."""
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
