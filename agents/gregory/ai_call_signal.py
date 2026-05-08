"""Gregory brain V2 — AI-driven call review signal.

Reads the last N days of `documents` rows where `document_type='call_review'`
for one client, sends them to Sonnet, and returns a Signal dict ready
to plug into `factors.signals[]` plus a list of concerns ready to plug
into `factors.concerns[]`.

This is the dominant signal in the V2 rubric (weight 0.50). The
deterministic signals (call_cadence, overdue, NPS) provide the
baseline; this signal supplies the qualitative "how is this client
actually doing?" read that a CSM would form by reading the same
call reviews themselves.

Failure semantics: this function NEVER raises. The brain is on the
critical weekly-cron path; an LLM blip or a DB blip on this signal
must not take down the entire sweep. Both failure surfaces (documents
fetch and Claude call) get their own try/except so the resulting
neutral-50 note can identify which surface tripped, which makes
operational diagnosis cheap.

Concerns: the prompt asks Sonnet for the existing dashboard-rendered
shape `{text, severity, source_call_ids}`. The parser defensively
filters source_call_ids against the input call_id set so a
hallucinated UUID can't land in factors.concerns[].
"""

from __future__ import annotations

import json
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any, TypedDict

from agents.gregory.prompts import AI_CALL_SIGNAL_SYSTEM_PROMPT
from agents.gregory.signals import (
    NEUTRAL_CONTRIBUTION,
    Signal,
    WEIGHT_AI_CALL_SIGNAL,
)
from shared.claude_client import complete
from shared.logging import end_agent_run, logger, start_agent_run


# Default lookback window. Matches the May-2026 backfill cadence
# (monthly review window) and the existing `meetings_this_month`
# 30-day inactivity threshold used elsewhere in the dashboard.
DEFAULT_LOOKBACK_DAYS = 30

# Output cap. Per-client review reasoning + up to 3 concerns lands
# well under 1k output tokens; 2048 is generous headroom against
# truncated JSON on detail-heavy multi-call clients.
_MAX_OUTPUT_TOKENS = 2048

# Trigger type for the agent_runs telemetry rows this module opens.
# Used by both the actual-compute path AND the freshness-skip path so
# cost rollups can split the two via output_summary (compute path
# starts with "contribution=" / "no recent reviews"; skip path starts
# with "skipped"). Renamed from "weekly_brain" when the cron switched
# to daily — name is cadence-agnostic now.
_SCHEDULED_BRAIN_TRIGGER = "scheduled_brain"

# Output-summary prefix used by the freshness-skip path. Stays grep-
# friendly so cost rollups can do `WHERE output_summary LIKE 'skipped%'`.
_SKIP_OUTPUT_PREFIX = "skipped"


class AiCallSignalConcern(TypedDict, total=False):
    """Same shape as agents.gregory.concerns.Concern — kept identical
    so the dashboard's existing renderer (text + severity pill + linked
    source calls) works without UI changes."""
    text: str
    severity: str
    source_call_ids: list[str]


def compute_ai_call_signal(
    db: Any,
    client_id: str,
    *,
    lookback_days: int = DEFAULT_LOOKBACK_DAYS,
    model: str = "claude-sonnet-4-6",
) -> tuple[Signal, list[AiCallSignalConcern]]:
    """Generate the AI-driven call review signal for one client.

    Returns:
        (Signal, concerns) tuple. Signal goes into factors.signals[];
        concerns goes into factors.concerns[]. Concerns is always a
        list (possibly empty) — never None, so callers can treat it
        as iterable unconditionally.

    Freshness filter (daily-cron architecture):
        Before fetching reviews, check whether any new call_review
        document has landed for this client since the last successful
        AI signal compute. If not, return the prior Signal + concerns
        from the most recent client_health_scores row — no LLM call,
        no documents fetch. Each daily sweep then only burns Sonnet
        tokens for clients with genuinely new input.

    Never raises. Failure paths each fall through to a neutral-50
    Signal + empty concerns:
      - documents fetch fails (DB blip)
      - Claude call fails (LLM blip / network)
      - response parse fails (model returned malformed JSON or wrong shape)
      - freshness-skip path can't locate the prior Signal (V1.1 → V2
        transition or some other gap) → falls through to recompute
    The note text identifies which surface tripped so operational
    diagnosis is cheap.

    NOTE: Freshness applies ONLY to ai_call_signal. The deterministic
    signals (call_cadence, overdue_action_items, latest_nps) always
    recompute every sweep — they're cheap and meant to reflect the
    latest day-of state. Don't extend this optimization beyond the
    AI signal without a cost-vs-staleness re-evaluation.
    """
    # ----- 0. Freshness check — skip Sonnet when input hasn't changed -----
    skip_result = _try_freshness_skip(db, client_id)
    if skip_result is not None:
        return skip_result

    # ----- 1. Fetch call_review documents -----
    try:
        reviews = _fetch_recent_reviews(db, client_id, lookback_days)
    except Exception as exc:
        logger.exception(
            "ai_call_signal documents fetch failed",
            extra={"client_id": client_id, "error": str(exc)[:200]},
        )
        return (
            _neutral_signal(
                value="db error",
                note=(
                    f"AI signal: documents fetch failed — {str(exc)[:200]}. "
                    "Returning neutral 50."
                ),
            ),
            [],
        )

    # ----- 2. Insufficient data — no Claude call -----
    if not reviews:
        return (
            _neutral_signal(
                value="no recent reviews",
                note=(
                    f"AI signal: insufficient data — no call reviews in "
                    f"last {lookback_days} days."
                ),
            ),
            [],
        )

    # ----- 3. Build prompt input -----
    user_message = _build_user_message(reviews)
    review_call_ids = {r["call_id"] for r in reviews if r.get("call_id")}

    # ----- 4. Open agent_runs row + Claude call -----
    started = time.monotonic()
    run_id = start_agent_run(
        agent_name="ai_call_signal",
        trigger_type=_SCHEDULED_BRAIN_TRIGGER,
        trigger_metadata={
            "client_id": client_id,
            "review_count": len(reviews),
            "lookback_days": lookback_days,
        },
        input_summary=f"client {client_id}, {len(reviews)} reviews",
    )

    try:
        result = complete(
            system=AI_CALL_SIGNAL_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_message}],
            model=model,
            max_tokens=_MAX_OUTPUT_TOKENS,
            run_id=run_id,
        )
    except Exception as exc:
        duration_ms = int((time.monotonic() - started) * 1000)
        logger.exception(
            "ai_call_signal Claude call failed",
            extra={"client_id": client_id, "error": str(exc)[:200]},
        )
        end_agent_run(
            run_id,
            status="error",
            error_message=f"llm_call_failed: {str(exc)[:200]}",
            duration_ms=duration_ms,
        )
        return (
            _neutral_signal(
                value=f"{len(reviews)} reviews (LLM error)",
                note=(
                    f"AI signal: Claude call failed — {str(exc)[:200]}. "
                    "Returning neutral 50."
                ),
            ),
            [],
        )

    # ----- 5. Parse + validate -----
    try:
        parsed = _parse_response(result.text)
        contribution = _coerce_contribution(parsed.get("contribution"))
        reasoning = _coerce_reasoning(parsed.get("reasoning"))
        concerns = _coerce_concerns(parsed.get("concerns"), review_call_ids)
    except Exception as exc:
        duration_ms = int((time.monotonic() - started) * 1000)
        logger.warning(
            "ai_call_signal response parse failed",
            extra={
                "client_id": client_id,
                "error": str(exc)[:200],
                "first_200": (result.text or "")[:200],
            },
        )
        end_agent_run(
            run_id,
            status="error",
            error_message=f"parse_failed: {str(exc)[:200]}",
            duration_ms=duration_ms,
        )
        return (
            _neutral_signal(
                value=f"{len(reviews)} reviews (parse error)",
                note=(
                    f"AI signal: response parse failed — {str(exc)[:200]}. "
                    "Returning neutral 50."
                ),
            ),
            [],
        )

    # ----- 6. Close run + return -----
    duration_ms = int((time.monotonic() - started) * 1000)
    end_agent_run(
        run_id,
        status="success",
        output_summary=(
            f"contribution={contribution} reviews={len(reviews)} "
            f"concerns={len(concerns)}"
        ),
        duration_ms=duration_ms,
    )

    value = _build_value_summary(reviews, contribution)
    return (
        Signal(
            name="ai_call_signal",
            weight=WEIGHT_AI_CALL_SIGNAL,
            value=value,
            contribution=contribution,
            note=reasoning,
        ),
        concerns,
    )


# ---------------------------------------------------------------------------
# Freshness-skip path
# ---------------------------------------------------------------------------


def _try_freshness_skip(
    db: Any, client_id: str
) -> tuple[Signal, list[AiCallSignalConcern]] | None:
    """Return (Signal, concerns) when the prior AI signal can be
    reused; return None when a fresh compute is required.

    Decision rule:
      1. Find the most recent successful ai_call_signal agent_runs row
         for this client (Option B — derive freshness state from
         agent_runs telemetry, no separate column to maintain).
      2. If no such row exists → fresh compute required (None).
      3. Find the max created_at on call_review documents for this
         client.
      4. If a call_review exists with created_at > the prior compute's
         started_at → fresh compute required (None).
      5. Otherwise → reuse prior Signal. Read the most recent
         client_health_scores row's factors.signals[] for this client,
         find the ai_call_signal entry, return it verbatim with the
         note rewritten to indicate the skip.

    Defensive fallback: if step 5 can't locate the prior Signal (e.g.
    the V1.1 → V2 transition where prior rows had open_action_items
    instead of ai_call_signal), return None so the caller falls through
    to a real compute. Never raises.

    Side effect: opens an agent_runs row with status=success and an
    output_summary starting with "skipped" so cost rollups can split
    skip rate from compute rate via WHERE output_summary LIKE 'skipped%'.

    Failure semantics: any exception in the freshness-check queries
    falls through to None (i.e., recompute). Catching here keeps the
    skip path strictly opportunistic — a DB blip on the freshness
    check shouldn't leave the brain in a worse state than it was
    pre-freshness-filter.
    """
    try:
        last_compute_iso = _last_successful_compute_iso(db, client_id)
    except Exception as exc:
        logger.warning(
            "ai_call_signal freshness check (last-compute) failed; "
            "falling through to recompute",
            extra={"client_id": client_id, "error": str(exc)[:200]},
        )
        return None

    if last_compute_iso is None:
        # No prior compute on record — first time we see this client
        # or the V1.1→V2 transition. Recompute.
        return None

    try:
        latest_review_iso = _latest_call_review_created_at(db, client_id)
    except Exception as exc:
        logger.warning(
            "ai_call_signal freshness check (latest-review) failed; "
            "falling through to recompute",
            extra={"client_id": client_id, "error": str(exc)[:200]},
        )
        return None

    # If a new call_review has landed since the last compute → recompute.
    if latest_review_iso is not None and latest_review_iso > last_compute_iso:
        return None

    # Inputs unchanged since last compute. Locate the prior Signal.
    try:
        prior = _read_prior_ai_signal(db, client_id)
    except Exception as exc:
        logger.warning(
            "ai_call_signal freshness skip: prior signal lookup failed; "
            "falling through to recompute",
            extra={"client_id": client_id, "error": str(exc)[:200]},
        )
        return None
    if prior is None:
        # Defensive: prior client_health_scores row exists per the
        # last-compute lookup, but its factors.signals[] doesn't
        # contain an ai_call_signal entry. V1.1→V2 transition shape
        # is the most likely cause. Recompute to land V2 shape.
        return None

    prior_signal, prior_concerns = prior

    # Open an agent_runs row for telemetry. Same trigger_type as the
    # compute path so the run shows up in standard "ai_call_signal
    # activity since X" queries; output_summary distinguishes skip
    # from compute for cost rollups.
    started = time.monotonic()
    run_id = start_agent_run(
        agent_name="ai_call_signal",
        trigger_type=_SCHEDULED_BRAIN_TRIGGER,
        trigger_metadata={
            "client_id": client_id,
            "skipped": True,
            "last_compute_at": last_compute_iso,
            "latest_review_at": latest_review_iso,
        },
        input_summary=f"client {client_id} (skipped — fresh)",
    )
    duration_ms = int((time.monotonic() - started) * 1000)
    end_agent_run(
        run_id,
        status="success",
        output_summary=(
            f"{_SKIP_OUTPUT_PREFIX} — fresh "
            f"(last_compute={last_compute_iso[:19]}; "
            f"latest_review={(latest_review_iso or 'none')[:19]})"
        ),
        duration_ms=duration_ms,
    )

    # Rewrite the note so the dashboard surfaces the skip provenance
    # without losing the original LLM-judged reasoning. Original
    # reasoning is preserved verbatim after a separator.
    skip_note = (
        f"AI signal: reused — no new call_review documents since "
        f"{last_compute_iso[:19]}. Prior reasoning: "
        f"{prior_signal.get('note', '(no note)')}"
    )
    refreshed_signal: Signal = Signal(
        name=prior_signal["name"],
        weight=prior_signal["weight"],
        value=prior_signal.get("value"),
        contribution=prior_signal["contribution"],
        note=skip_note,
    )
    return (refreshed_signal, prior_concerns)


def _last_successful_compute_iso(db: Any, client_id: str) -> str | None:
    """Most recent successful ai_call_signal agent_runs.started_at for
    this client. Excludes skip-path rows (their output_summary starts
    with the skip prefix) so a long string of skips can't trick the
    freshness check into thinking a real compute happened more recently
    than it did."""
    resp = (
        db.table("agent_runs")
        .select("started_at, output_summary")
        .eq("agent_name", "ai_call_signal")
        .eq("status", "success")
        .filter("trigger_metadata->>client_id", "eq", client_id)
        .order("started_at", desc=True)
        .limit(20)
        .execute()
    )
    rows = resp.data or []
    for row in rows:
        summary = row.get("output_summary") or ""
        if summary.startswith(_SKIP_OUTPUT_PREFIX):
            continue
        return row.get("started_at")
    return None


def _latest_call_review_created_at(db: Any, client_id: str) -> str | None:
    """Most recent created_at on a call_review document for this client.
    Returns the ISO string from the row directly (no parse) — string
    comparison works for ISO timestamps, which is all the caller needs."""
    resp = (
        db.table("documents")
        .select("created_at")
        .eq("source", "fathom")
        .eq("document_type", "call_review")
        .filter("metadata->>client_id", "eq", client_id)
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    rows = resp.data or []
    if not rows:
        return None
    return rows[0].get("created_at")


def _read_prior_ai_signal(
    db: Any, client_id: str
) -> tuple[Signal, list[AiCallSignalConcern]] | None:
    """Read the most recent client_health_scores row for this client,
    extract the ai_call_signal entry from factors.signals[] + the
    factors.concerns[] array, return as (Signal, concerns).

    Returns None when the most recent row is V1.1-shaped (no
    ai_call_signal entry) or the lookup fails to find a row.
    """
    resp = (
        db.table("client_health_scores")
        .select("factors")
        .eq("client_id", client_id)
        .order("computed_at", desc=True)
        .limit(1)
        .execute()
    )
    rows = resp.data or []
    if not rows:
        return None
    factors = rows[0].get("factors") or {}
    signals = factors.get("signals") or []
    ai_entry = next(
        (s for s in signals if isinstance(s, dict) and s.get("name") == "ai_call_signal"),
        None,
    )
    if ai_entry is None:
        return None
    # Concerns are stored at the factors level, not per-signal. The
    # concerns array on the prior row is whatever the prior compute
    # produced (could be from this same AI signal, could be empty).
    prior_concerns_raw = factors.get("concerns") or []
    prior_concerns: list[AiCallSignalConcern] = [
        c for c in prior_concerns_raw if isinstance(c, dict)
    ]
    prior_signal: Signal = Signal(
        name=ai_entry["name"],
        weight=ai_entry["weight"],
        value=ai_entry.get("value"),
        contribution=ai_entry["contribution"],
        note=ai_entry.get("note") or "",
    )
    return (prior_signal, prior_concerns)


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _neutral_signal(*, value: str, note: str) -> Signal:
    return Signal(
        name="ai_call_signal",
        weight=WEIGHT_AI_CALL_SIGNAL,
        value=value,
        contribution=NEUTRAL_CONTRIBUTION,
        note=note,
    )


def _fetch_recent_reviews(
    db: Any, client_id: str, lookback_days: int
) -> list[dict[str, Any]]:
    """Pull all call_review documents for this client whose call's
    started_at is within the lookback window.

    Filters on metadata->>started_at (jsonb-string comparison; ISO
    strings sort lexicographically so >= just works). Returns parsed
    review content + call_id + started_at + title.

    Skips rows whose content isn't valid JSON — corrupt rows are
    logged but don't fail the whole fetch.
    """
    cutoff_iso = (
        datetime.now(timezone.utc) - timedelta(days=lookback_days)
    ).isoformat()
    resp = (
        db.table("documents")
        .select("title, content, metadata, created_at")
        .eq("document_type", "call_review")
        .filter("metadata->>client_id", "eq", client_id)
        .filter("metadata->>started_at", "gte", cutoff_iso)
        .order("created_at", desc=True)
        .execute()
    )
    rows = resp.data or []
    out: list[dict[str, Any]] = []
    for row in rows:
        meta = row.get("metadata") or {}
        try:
            review = json.loads(row.get("content") or "{}")
        except (json.JSONDecodeError, TypeError) as exc:
            logger.warning(
                "ai_call_signal: skipping unparseable review document",
                extra={
                    "call_id": meta.get("call_id"),
                    "error": str(exc)[:120],
                },
            )
            continue
        if not isinstance(review, dict):
            continue
        out.append(
            {
                "call_id": meta.get("call_id"),
                "started_at": meta.get("started_at"),
                "title": row.get("title") or "(untitled)",
                "review": review,
            }
        )
    return out


def _build_user_message(reviews: list[dict[str, Any]]) -> str:
    """Format the reviews as readable prose for Sonnet.

    Each block: call header (started_at + title + call_id) followed by
    the four review fields rendered as labeled sections. Sonnet
    reasons better over prose-like inputs than raw JSON dumps.
    Reviews are oldest-first so the trajectory reads naturally
    chronologically (the fetch returns desc; we reverse here).
    """
    sorted_reviews = sorted(
        reviews,
        key=lambda r: r.get("started_at") or "",
    )
    blocks: list[str] = [
        f"You are reviewing {len(sorted_reviews)} recent call review(s) "
        "for a single coaching client, ordered oldest to newest. Use the "
        "trajectory across calls when scoring.",
        "",
    ]
    for index, item in enumerate(sorted_reviews, start=1):
        review = item["review"]
        blocks.append(
            f"=== Call {index}/{len(sorted_reviews)} === "
            f"started_at={item.get('started_at') or '?'} | "
            f"call_id={item.get('call_id') or '?'} | "
            f"title={item.get('title')}"
        )
        blocks.append("")
        blocks.append("Sentiment arc:")
        blocks.append(_safe_str(review.get("sentiment_arc")) or "(none)")
        blocks.append("")
        blocks.append("Pain points:")
        blocks.append(_format_items(review.get("pain_points")))
        blocks.append("")
        blocks.append("Wins:")
        blocks.append(_format_items(review.get("wins")))
        blocks.append("")
        blocks.append("Conversation pivots / dodged questions:")
        blocks.append(_format_items(review.get("dodged_questions"), include_who=True))
        blocks.append("")
    blocks.append(
        "Return STRICT JSON only with keys: contribution (int 0-100), "
        "reasoning (1-3 sentences), concerns (array, may be empty). "
        "Each concern: {text, severity (low|medium|high), source_call_ids}."
    )
    return "\n".join(blocks)


def _format_items(
    items: Any, *, include_who: bool = False
) -> str:
    if not isinstance(items, list) or not items:
        return "  (none)"
    lines: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        desc = _safe_str(item.get("description"))
        evidence = _safe_str(item.get("evidence"))
        prefix = "- "
        if include_who:
            who = _safe_str(item.get("who")) or "?"
            prefix = f"- ({who}) "
        lines.append(f"{prefix}{desc}")
        if evidence:
            lines.append(f"    evidence: {evidence}")
    return "\n".join(lines) if lines else "  (none)"


def _safe_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


_MARKDOWN_FENCE_RE = re.compile(
    r"^```(?:json)?\s*\n(.*?)\n```\s*$", re.DOTALL
)


def _parse_response(text: str) -> dict[str, Any]:
    """Parse Sonnet's response. Defensive against the same three
    stray-output patterns the call_reviewer's parser handles
    (markdown fences, leading/trailing prose, bare JSON)."""
    cleaned = (text or "").strip()
    fence_match = _MARKDOWN_FENCE_RE.match(cleaned)
    if fence_match:
        cleaned = fence_match.group(1).strip()
    first_brace = cleaned.find("{")
    last_brace = cleaned.rfind("}")
    if first_brace == -1 or last_brace == -1 or last_brace <= first_brace:
        raise ValueError(
            f"response did not contain a JSON object; "
            f"first 200 chars: {(text or '')[:200]!r}"
        )
    candidate = cleaned[first_brace : last_brace + 1]
    parsed = json.loads(candidate)
    if not isinstance(parsed, dict):
        raise ValueError(
            f"response was JSON but not an object (got {type(parsed).__name__})"
        )
    return parsed


def _coerce_contribution(value: Any) -> int:
    if not isinstance(value, (int, float)):
        raise ValueError(
            f"contribution must be a number, got {type(value).__name__}"
        )
    coerced = int(round(value))
    # Defensive clamp. The prompt says 0-100 but the model occasionally
    # surfaces 105 or -5 on edge inputs. Log-without-raise so the brain
    # doesn't fail on a contribution that was within an obvious tolerance.
    if coerced < 0 or coerced > 100:
        logger.warning(
            "ai_call_signal contribution out of bounds; clamping",
            extra={"raw": coerced},
        )
        coerced = max(0, min(100, coerced))
    return coerced


def _coerce_reasoning(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("reasoning must be a non-empty string")
    return value.strip()


def _coerce_concerns(
    raw: Any, allowed_call_ids: set[str]
) -> list[AiCallSignalConcern]:
    """Coerce the model's concerns array into the dashboard-expected
    `{text, severity, source_call_ids}` shape.

    Defensive on every field:
      - non-list raw → empty list
      - non-dict items → skip
      - missing/empty text → skip
      - severity not in {low, medium, high} → drop the severity key
      - source_call_ids filtered against allowed_call_ids — hallucinated
        UUIDs are silently dropped rather than written into factors.concerns[]
    """
    if not isinstance(raw, list):
        return []
    out: list[AiCallSignalConcern] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        text_value = item.get("text")
        if not isinstance(text_value, str) or not text_value.strip():
            continue
        concern: AiCallSignalConcern = {"text": text_value.strip()}
        severity = item.get("severity")
        if isinstance(severity, str) and severity in {"low", "medium", "high"}:
            concern["severity"] = severity
        source_ids = item.get("source_call_ids")
        if isinstance(source_ids, list):
            concern["source_call_ids"] = [
                sid
                for sid in source_ids
                if isinstance(sid, str) and sid in allowed_call_ids
            ]
        out.append(concern)
    return out


def _build_value_summary(
    reviews: list[dict[str, Any]], contribution: int
) -> str:
    """Short human-readable value field for the dashboard's Signal
    summary view. The full reasoning lives in `note`."""
    label = (
        "strong"
        if contribution >= 75
        else "watch" if contribution >= 40 else "concern"
    )
    return f"{len(reviews)} review{'s' if len(reviews) != 1 else ''}, {label}"
