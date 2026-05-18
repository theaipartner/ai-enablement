"""Persist a `PassiveEvaluation` and fire side effects.

Split from `agents/ella/passive_monitor.py` so the decision module
stays pure (Haiku call only) and this module owns the database +
Slack side effects. Two call sites:

  1. `ingestion/slack/realtime_ingest.py` — calls
     `persist_passive_evaluation` after `evaluate_passive_trigger`.
  2. Test code that exercises the persistence path with a mocked
     `PassiveEvaluation`.

Side effects per decision (unified-decision rewrite — no escalation
DMs or `escalations` rows on the passive path anymore; the daily
digest is the surface for human-attention messages):

  - skip                 -> agent_runs row (status='success'). When
                            `skip_reason='kill_switch'` NO agent_runs
                            row is written at all (Gate 1 optimization).
                            If digest_flag: also a pending_digest_items
                            row (e.g. a refund mention buried in
                            chitchat — skipped as a response but
                            flagged for Scott).
  - respond_haiku_self   -> response Haiku generates the reply. On
                            `[FALLBACK_TO_SONNET]`, falls through to the
                            respond_via_sonnet path. Otherwise posts
                            directly via shared.slack_post. agent_runs
                            success with combined decision+response
                            Haiku cost. If digest_flag:
                            pending_digest_items (ella_responded=true).
  - respond_via_sonnet   -> pending_ella_responses row (written with
                            haiku_decision='respond_substantive' so the
                            unchanged per-minute cron drains it via the
                            Sonnet generation path). If digest_flag:
                            pending_digest_items (ella_responded=true).
  - digest_only          -> no client-facing post, no escalations row,
                            no DM. Always a pending_digest_items row.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from agents.ella.passive_monitor import PassiveEvaluation
from shared.db import get_client
from shared.logging import end_agent_run, start_agent_run

logger = logging.getLogger("ai_enablement.ella.passive_dispatch")

# Delay before the per-minute cron may generate the Sonnet response.
# Kept at 1 min per Drake's 2026-05-11 call — perceived latency is
# 1-2 min because the per-minute cron tick is the floor above this.
_RESPOND_AFTER_DELAY = timedelta(minutes=1)

# The value written into `pending_ella_responses.haiku_decision` for a
# respond_via_sonnet decision. The per-minute cron (api/passive_ella_
# cron.py) dispatches `respond_substantive` to the Sonnet generation
# path; we keep that contract so the cron stays unchanged while the
# upstream decision vocabulary moved to `respond_via_sonnet`.
_PENDING_SONNET_DECISION = "respond_substantive"

_HAIKU_MODEL = "claude-haiku-4-5-20251001"


def persist_passive_evaluation(evaluation: PassiveEvaluation) -> dict[str, Any]:
    """Write the agent_runs row, then dispatch decision-specific side
    effects. Returns a structured dict for the caller / tests."""
    payload = evaluation.payload
    decision = evaluation.decision

    # Gate 1 optimization: when Ella is globally killed we write NO
    # agent_runs row at all (saves DB writes + audit noise). Nothing
    # else runs — no digest item either.
    if evaluation.skip_reason == "kill_switch":
        return {"decision": "skip", "skip_reason": "kill_switch", "agent_run_id": None}

    trigger_metadata: dict[str, Any] = {
        "triggering_slack_channel_id": payload.slack_channel_id,
        "triggering_message_ts": payload.triggering_message_ts,
        "triggering_message_slack_user_id": payload.triggering_message_slack_user_id,
        "channel_client_id": payload.channel_client_id,
        "author_type": payload.author_type,
        "haiku_decision": decision.decision,
        "haiku_reasoning": decision.reasoning,
        "digest_flag": decision.digest_flag,
        "digest_category": decision.digest_category,
        "skip_reason": evaluation.skip_reason,
    }
    if payload.test_mode:
        trigger_metadata["test_mode_run"] = True

    input_summary = (payload.triggering_message_text or "")[:200]

    run_id = start_agent_run(
        agent_name="ella",
        trigger_type="passive_monitor",
        trigger_metadata=trigger_metadata,
        input_summary=input_summary,
    )

    # Cost write for the decision Haiku (the response Haiku cost, when
    # respond_haiku_self fires, is folded in below before this single
    # write — see the branch).
    decision_cost = {
        "input_tokens": decision.haiku_input_tokens,
        "output_tokens": decision.haiku_output_tokens,
        "cost_usd": decision.haiku_cost_usd,
    }

    if decision.decision == "respond_haiku_self":
        return _dispatch_respond_haiku_self(
            run_id, evaluation, trigger_metadata, decision_cost
        )

    if decision.decision == "respond_via_sonnet":
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
            output_summary=f"queued (respond_via_sonnet); pending_id={pending_id}",
        )
        return {
            "agent_run_id": run_id,
            "pending_id": pending_id,
            "decision": "respond_via_sonnet",
        }

    if decision.decision == "digest_only":
        _write_cost(run_id, decision_cost)
        digest_id = _insert_pending_digest_item(
            run_id=run_id,
            payload=payload,
            evaluation=evaluation,
            ella_responded=False,
        )
        end_agent_run(
            run_id,
            status="success",
            output_summary=f"digest_only: {decision.reasoning[:160]}",
        )
        return {
            "agent_run_id": run_id,
            "decision": "digest_only",
            "digest_item_id": digest_id,
        }

    # decision.decision == 'skip'
    _write_cost(run_id, decision_cost)
    skip_label = evaluation.skip_reason or "haiku_skip"
    digest_id = None
    if decision.digest_flag:
        digest_id = _insert_pending_digest_item(
            run_id=run_id,
            payload=payload,
            evaluation=evaluation,
            ella_responded=False,
        )
    end_agent_run(
        run_id,
        status="success",
        output_summary=f"skipped ({skip_label}): {decision.reasoning[:160]}",
    )
    return {
        "agent_run_id": run_id,
        "decision": "skip",
        "skip_reason": skip_label,
        "digest_item_id": digest_id,
    }


# ---------------------------------------------------------------------------
# respond_haiku_self branch
# ---------------------------------------------------------------------------


def _dispatch_respond_haiku_self(
    run_id: str,
    evaluation: PassiveEvaluation,
    trigger_metadata: dict[str, Any],
    decision_cost: dict[str, Any],
) -> dict[str, Any]:
    """Run the response Haiku, post or fall back to Sonnet, write the
    run row with combined decision + response Haiku cost accounting."""
    from agents.ella.digest_response import generate_response

    payload = evaluation.payload
    decision = evaluation.decision

    resp = generate_response(
        payload=payload,
        kb_chunks=evaluation.kb_chunks,
        recent_context=evaluation.recent_channel_context,
        primary_csm=evaluation.primary_csm,
        channel_client=None,
    )

    combined_cost = {
        "input_tokens": decision_cost["input_tokens"] + resp.input_tokens,
        "output_tokens": decision_cost["output_tokens"] + resp.output_tokens,
        "cost_usd": decision_cost["cost_usd"] + resp.cost_usd,
    }

    if resp.fallback_to_sonnet:
        # Discard the Haiku response; queue Sonnet via the existing
        # pending path. The fallback fact is stamped onto the run's
        # trigger_metadata for /ella/runs visibility.
        _write_cost(run_id, combined_cost)
        pending_id = _insert_pending(run_id=run_id, payload=payload, decision=decision)
        if decision.digest_flag:
            _insert_pending_digest_item(
                run_id=run_id,
                payload=payload,
                evaluation=evaluation,
                ella_responded=True,
            )
        _stamp_metadata(run_id, trigger_metadata, {"haiku_response_fallback": True})
        end_agent_run(
            run_id,
            status="success",
            output_summary=(
                f"respond_haiku_self -> fallback_to_sonnet; " f"pending_id={pending_id}"
            ),
        )
        return {
            "agent_run_id": run_id,
            "pending_id": pending_id,
            "decision": "respond_haiku_self",
            "fallback_to_sonnet": True,
        }

    post_result = _post_haiku_response(payload, resp.response_text)
    _write_cost(run_id, combined_cost)
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
        "decision": "respond_haiku_self",
        "posted": bool(post_result["ok"]),
        "slack_error": post_result.get("slack_error"),
    }


def _post_haiku_response(payload, response_text: str) -> dict[str, Any]:
    """Post the Haiku-generated response to the channel. Mirrors the
    fire-and-forget contract of shared.slack_post.post_message."""
    from shared.slack_post import post_message

    return post_message(payload.slack_channel_id, response_text)


# ---------------------------------------------------------------------------
# Cost write
# ---------------------------------------------------------------------------


def _write_cost(run_id: str, cost: dict[str, Any]) -> None:
    """Write llm_* fields onto the agent_runs row. The decision module
    is pure (no run_id at decision time) so cost is written here."""
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


def _stamp_metadata(
    run_id: str, base_metadata: dict[str, Any], extra: dict[str, Any]
) -> None:
    """Merge `extra` into the run's trigger_metadata. Best-effort —
    a failure here only loses an audit annotation, not the run."""
    try:
        merged = {**base_metadata, **extra}
        (
            get_client()
            .table("agent_runs")
            .update({"trigger_metadata": merged})
            .eq("id", run_id)
            .execute()
        )
    except Exception as exc:
        logger.warning(
            "passive_dispatch: metadata stamp failed run_id=%s: %s",
            run_id,
            exc,
        )


# ---------------------------------------------------------------------------
# pending_ella_responses insert (Sonnet path)
# ---------------------------------------------------------------------------


def _insert_pending(*, run_id: str, payload, decision) -> str | None:
    """Insert one pending_ella_responses row for the Sonnet path.

    `haiku_decision` is written as `respond_substantive` so the
    unchanged per-minute cron drains it through the Sonnet generation
    path. Returns the new id, or None if the unique constraint fires
    (duplicate same-message re-fire — defense in depth)."""
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


# ---------------------------------------------------------------------------
# pending_digest_items insert (daily digest queue)
# ---------------------------------------------------------------------------


def _insert_pending_digest_item(
    *,
    run_id: str,
    payload,
    evaluation: PassiveEvaluation,
    ella_responded: bool,
) -> str | None:
    """Passive-path adapter over `insert_digest_item` — unpacks the
    PassiveEvaluation into the explicit-field shape the reactive path
    (agent.py) also uses."""
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
    fires (re-processed message — the digest entry stays as-is rather
    than mutating, which is correct per spec § What could go wrong).

    Public so the reactive path (`agents.ella.agent`) writes digest
    items through exactly the same insert as the passive path."""
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
