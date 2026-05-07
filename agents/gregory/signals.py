"""Gregory brain — signal computations.

Pure functions, one per signal. Each takes a Supabase client + client_id
and returns a Signal dict matching the `factors.signals[]` slot of the
client_health_scores jsonb shape.

The shape is consumed by scoring.py (combines into a 0-100 score) and
written verbatim into the factors jsonb. The dashboard renders it as
raw JSON in the "Why this score" expand.

Signal dict shape:

    {
      "name": str,
      "weight": float,        # 0.0 to 1.0
      "value": str | None,    # human-readable raw measurement
      "contribution": int,    # 0-100 internal score for this signal
      "note": str,            # explanation, especially for missing-data cases
    }

When data is missing, the contribution is the "neutral" value 50 and
the note explains why. Scoring rolls these up; the dashboard surfaces
the note next to the contribution.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, TypedDict


class Signal(TypedDict):
    name: str
    weight: float
    value: str | None
    contribution: int
    note: str


# Module-level weight constants. Total weights sum to 1.0 (V2 rubric).
# Heavy-but-balanced: AI call signal dominates at 0.50, deterministic
# signals fill the remaining 0.50 weighted toward cadence + NPS over
# action item recency.
#
# V1.1 had open_action_items as its own 0.20 signal. Retired in V2 —
# overdue items are still a signal at 0.10; the "open but not yet due"
# count was double-counting the same data and not adding signal.
WEIGHT_AI_CALL_SIGNAL = 0.50
WEIGHT_CALL_CADENCE = 0.20
WEIGHT_OVERDUE_ACTION_ITEMS = 0.10
WEIGHT_LATEST_NPS = 0.20

# Neutral contribution for missing data. Combined with the "default to
# yellow when nothing is known" stance in scoring.py — never green by
# accident.
NEUTRAL_CONTRIBUTION = 50


# ---------------------------------------------------------------------------
# Call cadence
# ---------------------------------------------------------------------------


def compute_call_cadence(db: Any, client_id: str) -> Signal:
    """Days since the most recent calls.started_at where
    primary_client_id = client. Higher contribution = more recent call.

    Bands:
      <14 days  → 100
      14–30 days → 50
      >30 days  → 0
      no calls → neutral (50) with explanatory note

    Reason for the bands: 14 days is the implicit "regular cadence"
    threshold the dashboard's CallCadenceIndicator already uses for its
    color treatment. Keeping the brain's score consistent with the
    indicator avoids visual disagreement.
    """
    resp = (
        db.table("calls")
        .select("started_at")
        .eq("primary_client_id", client_id)
        .order("started_at", desc=True)
        .limit(1)
        .execute()
    )
    rows = resp.data or []
    if not rows:
        return Signal(
            name="call_cadence",
            weight=WEIGHT_CALL_CADENCE,
            value=None,
            contribution=NEUTRAL_CONTRIBUTION,
            note="No calls on record for this client.",
        )

    latest = datetime.fromisoformat(rows[0]["started_at"].replace("Z", "+00:00"))
    days = (datetime.now(timezone.utc) - latest).days

    if days < 14:
        contribution = 100
    elif days <= 30:
        contribution = 50
    else:
        contribution = 0

    label = (
        "today"
        if days == 0
        else ("1 day ago" if days == 1 else f"{days} days ago")
    )
    return Signal(
        name="call_cadence",
        weight=WEIGHT_CALL_CADENCE,
        value=label,
        contribution=contribution,
        note=f"Most recent call {label}.",
    )


# ---------------------------------------------------------------------------
# Overdue action items count
# ---------------------------------------------------------------------------


def compute_overdue_action_items(db: Any, client_id: str) -> Signal:
    """Count of call_action_items where owner_client_id=client AND
    status='open' AND due_date < today. Worse than open-but-not-yet-due.
    Subtracts 15 per item from a 100 baseline; floor at 0.

    No overdue → 100. Not neutral — having no overdue items is good.
    """
    today_iso = datetime.now(timezone.utc).date().isoformat()
    resp = (
        db.table("call_action_items")
        .select("id", count="exact", head=True)
        .eq("owner_client_id", client_id)
        .eq("status", "open")
        .lt("due_date", today_iso)
        .execute()
    )
    count = resp.count or 0
    contribution = max(0, 100 - 15 * count)
    return Signal(
        name="overdue_action_items",
        weight=WEIGHT_OVERDUE_ACTION_ITEMS,
        value=str(count),
        contribution=contribution,
        note=f"{count} overdue action item{'s' if count != 1 else ''}.",
    )


# ---------------------------------------------------------------------------
# Latest NPS
# ---------------------------------------------------------------------------


def compute_latest_nps(db: Any, client_id: str) -> Signal:
    """Most recent nps_submissions.score for this client, scaled 0-10
    onto 0-100. No NPS data → neutral (50) with note. nps_submissions
    is empty in cloud as of M3.4 ship; this signal reads as neutral
    for every client until NPS ingestion lands.
    """
    resp = (
        db.table("nps_submissions")
        .select("score, submitted_at")
        .eq("client_id", client_id)
        .order("submitted_at", desc=True)
        .limit(1)
        .execute()
    )
    rows = resp.data or []
    if not rows:
        return Signal(
            name="latest_nps",
            weight=WEIGHT_LATEST_NPS,
            value=None,
            contribution=NEUTRAL_CONTRIBUTION,
            note="No NPS submissions on record (NPS ingestion not yet built).",
        )

    raw = int(rows[0]["score"])
    contribution = max(0, min(100, raw * 10))
    return Signal(
        name="latest_nps",
        weight=WEIGHT_LATEST_NPS,
        value=str(raw),
        contribution=contribution,
        note=f"Latest NPS score: {raw}/10.",
    )


# ---------------------------------------------------------------------------
# Convenience: compute all signals
# ---------------------------------------------------------------------------


def compute_all_signals(db: Any, client_id: str) -> list[Signal]:
    """Compute the V2 deterministic signals for one client.

    The AI call signal (the dominant V2 contributor) is NOT computed
    here — it's its own module (`ai_call_signal.py`) because it makes
    a Claude call and returns concerns alongside the Signal. agent.py
    composes the AI signal + this list into the final factors.signals[]
    array (with AI signal sorted first per the V2 dashboard order).

    Slack engagement is still omitted — slack_messages cloud table is
    empty (local-only ingestion per docs/future-ideas.md). Add it as
    a fourth deterministic signal once cloud Slack ingestion lands.
    """
    return [
        compute_call_cadence(db, client_id),
        compute_overdue_action_items(db, client_id),
        compute_latest_nps(db, client_id),
    ]
