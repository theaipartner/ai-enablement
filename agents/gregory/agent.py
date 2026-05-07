"""Gregory brain V2 — entry point.

Computes per-client health scores by combining the dominant AI call
signal (Sonnet reasoning over recent call_review documents, weight 0.50)
with three deterministic signals (call cadence, overdue action items,
latest NPS), and writes one row per invocation to `client_health_scores`
(history preserved by design).

Two public entry points:

  - compute_health_for_client(client_id) — single-client run, used by
    the manual trigger script and tests.
  - compute_health_for_all_active() — sweeps every active client, used
    by the weekly Vercel cron and ad-hoc backfills.

Each invocation opens an `agent_runs` row, computes, writes, and closes
the run with token / cost / duration telemetry. The AI call signal
opens its own `agent_runs` row inside the per-client compute so token
+ cost accounting is attributable per-signal-per-client.

V1.1 had a separate concerns.py module gated behind GREGORY_CONCERNS_ENABLED.
Retired in V2 — the AI call signal subsumes that work (call_review
documents already contain the LLM-distilled view of pain_points + wins
+ dodged_questions + sentiment_arc that concerns.py was extracting from
raw summaries). Concerns now flow up directly from compute_ai_call_signal.

Deferred V2.1 signals: Slack engagement (slack_messages cloud table
empty). Brain handles missing data gracefully — the AI signal returns
neutral 50 when no call_review documents exist for a client, and the
deterministic signals return neutral 50 for their own missing-data cases.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from agents.gregory.ai_call_signal import compute_ai_call_signal
from agents.gregory.scoring import build_overall_reasoning, score_signals
from agents.gregory.signals import compute_all_signals
from shared.db import get_client
from shared.logging import end_agent_run, logger, start_agent_run


@dataclass
class HealthComputeResult:
    """Outcome of one compute_health_for_client call. Returned to the
    cron + manual-trigger callers so they can summarize the run
    without re-querying client_health_scores."""

    client_id: str
    score: int
    tier: str
    insufficient_data: bool
    concerns_count: int
    health_score_row_id: str
    agent_run_id: str


@dataclass
class SweepResult:
    """Outcome of compute_health_for_all_active. Per-client outcomes
    plus simple aggregates for the cron's response body.

    duration_ms tracks wall-clock for the entire sweep (start of first
    client to end of last). avg_per_client_ms is duration_ms divided by
    total_clients (or 0 if the sweep ran on zero clients). Both feed the
    cron-ceiling watchpoint logged in docs/followups.md — re-architect
    when wall-clock duration approaches 80% of the Vercel maxDuration
    ceiling (i.e. 240s of 300s on Pro plan).
    """

    total_clients: int
    succeeded: int
    failed: int
    insufficient_data: int
    duration_ms: int = 0
    avg_per_client_ms: int = 0
    per_client: list[HealthComputeResult] = field(default_factory=list)
    errors: list[dict[str, str]] = field(default_factory=list)


def compute_health_for_client(
    client_id: str,
    db: Any | None = None,
    trigger_type: str = "manual",
) -> HealthComputeResult:
    """Compute and persist a single client's health score. Opens its
    own agent_runs row; closes it with success or error.

    The shared.db.get_client() default points at cloud (service role).
    Pass an explicit db for tests or alternate routing.

    trigger_type is recorded on the agent_runs row — 'manual' for
    scripts/run_gregory_brain.py, 'cron' for the Vercel cron path.
    """
    if db is None:
        db = get_client()

    started = time.monotonic()
    run_id = start_agent_run(
        agent_name="gregory",
        trigger_type=trigger_type,
        trigger_metadata={"client_id": client_id},
        input_summary=f"compute health for client {client_id}",
    )

    try:
        # AI call signal first (dominant V2 contributor — sorted first
        # in factors.signals[] so dashboard reads it as the headline).
        # Returns (Signal, concerns) tuple; concerns flow into
        # factors.concerns[] without a separate Claude call. Never
        # raises — see compute_ai_call_signal docstring for failure
        # semantics (DB blip / LLM blip / parse failure all fall
        # through to neutral-50 with mode-specific note).
        ai_signal, concerns_list = compute_ai_call_signal(db, client_id)
        deterministic_signals = compute_all_signals(db, client_id)
        signals_list = [ai_signal, *deterministic_signals]

        scoring_result = score_signals(signals_list)
        reasoning = build_overall_reasoning(
            signals_list, scoring_result, len(concerns_list)
        )

        factors = {
            "signals": list(signals_list),
            "concerns": list(concerns_list),
            "overall_reasoning": reasoning,
        }

        insert_resp = (
            db.table("client_health_scores")
            .insert(
                {
                    "client_id": client_id,
                    "score": scoring_result["score"],
                    "tier": scoring_result["tier"],
                    "factors": factors,
                    "computed_by_run_id": run_id,
                }
            )
            .execute()
        )
        row_id = insert_resp.data[0]["id"]

        duration_ms = int((time.monotonic() - started) * 1000)
        end_agent_run(
            run_id,
            status="success",
            output_summary=(
                f"score={scoring_result['score']} tier={scoring_result['tier']} "
                f"concerns={len(concerns_list)} "
                f"{'(insufficient data)' if scoring_result['insufficient_data'] else ''}"
            ).strip(),
            duration_ms=duration_ms,
            metadata={
                "client_health_score_id": row_id,
                "insufficient_data": scoring_result["insufficient_data"],
            },
        )

        return HealthComputeResult(
            client_id=client_id,
            score=scoring_result["score"],
            tier=scoring_result["tier"],
            insufficient_data=scoring_result["insufficient_data"],
            concerns_count=len(concerns_list),
            health_score_row_id=row_id,
            agent_run_id=run_id,
        )
    except Exception as exc:
        duration_ms = int((time.monotonic() - started) * 1000)
        end_agent_run(
            run_id,
            status="error",
            error_message=str(exc),
            duration_ms=duration_ms,
        )
        raise


def compute_health_for_all_active(
    db: Any | None = None,
    trigger_type: str = "cron",
) -> SweepResult:
    """Sweep every active client; compute + persist a health row for
    each. Per-client failures are isolated — one client's exception
    doesn't stop the sweep. The sweep itself doesn't open its own
    agent_runs row; each per-client run is its own row, which keeps
    cost / duration accounting clean per client.
    """
    if db is None:
        db = get_client()

    resp = (
        db.table("clients")
        .select("id, full_name")
        .is_("archived_at", "null")
        .order("full_name")
        .execute()
    )
    clients = resp.data or []

    result = SweepResult(
        total_clients=len(clients),
        succeeded=0,
        failed=0,
        insufficient_data=0,
    )

    sweep_started = time.monotonic()
    for client in clients:
        client_id = client["id"]
        try:
            outcome = compute_health_for_client(
                client_id=client_id, db=db, trigger_type=trigger_type
            )
            result.succeeded += 1
            if outcome.insufficient_data:
                result.insufficient_data += 1
            result.per_client.append(outcome)
        except Exception as exc:
            result.failed += 1
            result.errors.append(
                {
                    "client_id": client_id,
                    "client_name": client.get("full_name") or "(unknown)",
                    "error": str(exc),
                }
            )
            logger.exception(
                "gregory.compute_health_for_client failed",
                extra={"client_id": client_id},
            )

    result.duration_ms = int((time.monotonic() - sweep_started) * 1000)
    result.avg_per_client_ms = (
        result.duration_ms // len(clients) if clients else 0
    )
    logger.info(
        "gregory.sweep finished total=%d succeeded=%d failed=%d "
        "insufficient=%d duration_ms=%d avg_per_client_ms=%d",
        result.total_clients,
        result.succeeded,
        result.failed,
        result.insufficient_data,
        result.duration_ms,
        result.avg_per_client_ms,
    )
    return result
