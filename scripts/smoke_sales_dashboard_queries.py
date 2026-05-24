"""Smoke probe for /sales-dashboard LIVE metric queries.

Mirrors the column + filter shapes in `lib/db/sales-dashboard.ts` against
cloud, table by table. Lets Builder validate the live-metric query plan
against the real schema WITHOUT having to spin up a deploy or run
Playwright. Validates two things per table:

  1. The filter columns exist (no PostgREST 42703 "column does not exist").
  2. The query returns a result (count, sum, or row sample) — proves the
     filter logic returns sane shapes even when the 7-day window has 0
     rows for some metric.

Output is verbose so a failure is obviously human-readable. Exits non-zero
if any check fails.

Invoke:
    .venv/bin/python scripts/smoke_sales_dashboard_queries.py

Designed to be repeatable. Read-only; no writes.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone

from shared.db import get_client

WINDOW_DAYS = 7
NOW_UTC = datetime.now(timezone.utc)
WINDOW_START = NOW_UTC - timedelta(days=WINDOW_DAYS)
WINDOW_START_ISO = WINDOW_START.isoformat().replace("+00:00", "Z")
WINDOW_START_DATE = WINDOW_START.date().isoformat()

# Mirrors of the TS constants. Source of truth lives in
# ingestion/calendly/__init__.py + ingestion/clarity/__init__.py +
# docs/schema/*.md; the values are duplicated here so the smoke is
# standalone.
# Typeform: NO form-id filter — "Typeform Submits ('Leads')" counts all
# opt-ins across all active funnels. The historical Setter Funnel
# (PWSNd0h2) went dormant; SFedWelr is the current active funnel.
VSL_HASHED_IDS = ["i1173gx76b", "nbump1crwb"]
TYP_HASHED_ID = "fbgjxwe62y"
CLOSER_EVENT_NAMES_LOWER = ["ai partner strategy call"]


def _print_header(name: str) -> None:
    print(f"\n--- {name} ---")


def check(name: str, fn) -> tuple[bool, str]:
    """Run `fn` and report. Returns (ok, message)."""
    try:
        result = fn()
        return True, f"[OK]   {name}: {result}"
    except Exception as e:  # noqa: BLE001
        return False, f"[FAIL] {name}: {e}"


def main() -> int:
    sb = get_client()
    failures: list[str] = []

    _print_header(f"Window: {WINDOW_START_ISO} → now")

    # meta_ad_daily — date-keyed
    _print_header("meta_ad_daily")
    rows = (
        sb.table("meta_ad_daily")
        .select(
            "day, amount_spent, frequency, impressions, "
            "unique_link_clicks, cpm, cost_per_unique_link_click, ctr"
        )
        .gte("day", WINDOW_START_DATE)
        .execute()
        .data
    )
    spend = sum(float(r["amount_spent"] or 0) for r in rows)
    impressions = sum(int(r["impressions"] or 0) for r in rows)
    print(f"  rows={len(rows)}  spend=${spend:,.2f}  impressions={impressions:,}")
    if impressions > 0:
        print(f"  derived cost_per_impression=${spend / impressions:.4f}")

    # clarity_metrics_daily — latest snapshot per path
    _print_header("clarity_metrics_daily")
    for url_path, metric_name in [
        ("/lp", "Traffic"),
        ("/lp", "EngagementTime"),
        ("/confirmation", "EngagementTime"),
    ]:
        rows = (
            sb.table("clarity_metrics_daily")
            .select(
                "snapshot_date, metric_name, url_path, total_session_count, active_time"
            )
            .eq("metric_name", metric_name)
            .eq("url_path", url_path)
            .order("snapshot_date", desc=True)
            .limit(50)
            .execute()
            .data
        )
        if rows:
            latest = rows[0]["snapshot_date"]
            latest_rows = [r for r in rows if r["snapshot_date"] == latest]
            sessions = sum(int(r["total_session_count"] or 0) for r in latest_rows)
            active = sum(int(r["active_time"] or 0) for r in latest_rows)
            print(
                f"  {metric_name}@{url_path} latest={latest} rows={len(latest_rows)} "
                f"sessions={sessions} active_time={active}s"
            )
        else:
            print(f"  {metric_name}@{url_path}: no rows")

    # wistia_media_daily — 7d window per media id set
    _print_header("wistia_media_daily")
    for label, ids in [("VSL", VSL_HASHED_IDS), ("TYP", [TYP_HASHED_ID])]:
        rows = (
            sb.table("wistia_media_daily")
            .select(
                "hashed_id, day, played_time_seconds, plays_filtered, engagement_rate"
            )
            .in_("hashed_id", ids)
            .gte("day", WINDOW_START_DATE)
            .execute()
            .data
        )
        played = sum(int(r["played_time_seconds"] or 0) for r in rows)
        plays = sum(int(r["plays_filtered"] or 0) for r in rows)
        engagement_rates = [
            float(r["engagement_rate"])
            for r in rows
            if r["engagement_rate"] is not None
        ]
        avg_engagement = (
            sum(engagement_rates) / len(engagement_rates) if engagement_rates else None
        )
        print(
            f"  {label} rows={len(rows)} plays_filtered={plays} "
            f"played_time={played}s "
            f"avg_engagement_rate={avg_engagement and f'{avg_engagement * 100:.2f}%' or '—'}"
        )

    # typeform_responses — Setter Funnel count
    _print_header("typeform_responses")
    count = (
        sb.table("typeform_responses")
        .select("response_id", count="exact", head=True)
        .gte("submitted_at", WINDOW_START_ISO)
        .execute()
        .count
    )
    print(f"  all funnel submits (7d): {count}")

    # calendly_scheduled_events + invitees — TWO queries (no FK on
    # event_uri means PostgREST embedded-relation syntax errors out).
    # Mirrors the TS data layer's partitionBookings().
    _print_header("calendly_scheduled_events + calendly_invitees")
    events = (
        sb.table("calendly_scheduled_events")
        .select("uri, name, status, start_time, event_created_at")
        .eq("status", "active")
        .gte("event_created_at", WINDOW_START_ISO)
        .execute()
        .data
    )
    event_uris = [e["uri"] for e in events]
    if event_uris:
        invitees = (
            sb.table("calendly_invitees")
            .select("event_uri, status, rescheduled")
            .in_("event_uri", event_uris)
            .eq("status", "active")
            .execute()
            .data
        )
    else:
        invitees = []
    new_by_uri = {i["event_uri"] for i in invitees if i["rescheduled"] is False}
    resch_by_uri = {i["event_uri"] for i in invitees if i["rescheduled"] is True}
    all_new = sum(1 for e in events if e["uri"] in new_by_uri)
    all_resch = sum(1 for e in events if e["uri"] in resch_by_uri)
    closer_new = sum(
        1
        for e in events
        if e["uri"] in new_by_uri
        and (e.get("name") or "").lower() in CLOSER_EVENT_NAMES_LOWER
    )
    print(f"  events (active, 7d): {len(events)}  invitees pulled: {len(invitees)}")
    print(f"  new scheduled (active+!rescheduled): {all_new}")
    print(f"  rescheduled (active+rescheduled): {all_resch}")
    print(f"  closer bookings (closer name + active+!rescheduled): {closer_new}")

    # airtable_setter_triage_calls — counts by booking_status. Time-axis
    # is `airtable_created_at` to match the TS data layer's choice (the
    # user-entered `booked_at` is sparsely populated today — see the
    # runbook for the rationale).
    _print_header("airtable_setter_triage_calls")
    base = (
        sb.table("airtable_setter_triage_calls")
        .select("record_id", count="exact", head=True)
        .gte("airtable_created_at", WINDOW_START_ISO)
    )
    total = base.execute().count
    print(f"  total setter triages (7d, by airtable_created_at): {total}")
    for status in (
        "Disqualified Lead",
        "Downsell",
        "Confirmed Booked with Closer",
    ):
        n = (
            sb.table("airtable_setter_triage_calls")
            .select("record_id", count="exact", head=True)
            .gte("airtable_created_at", WINDOW_START_ISO)
            .eq("booking_status", status)
            .execute()
            .count
        )
        print(f"  booking_status='{status}': {n}")

    # close_calls — outbound dials count
    _print_header("close_calls")
    n = (
        sb.table("close_calls")
        .select("close_id", count="exact", head=True)
        .eq("direction", "outbound")
        .gte("date_created", WINDOW_START_ISO)
        .execute()
        .count
    )
    print(f"  outbound dials (7d): {n}")

    # airtable_full_closer_report — counts by predicate
    _print_header("airtable_full_closer_report")
    cases = [
        ({"call_type": "Consultation Call", "showed": "Yes"}, "Showed (new)"),
        ({"call_type": "Consultation Call", "no_show_reason": "Ghost - NoShow"}, "No Shows / Ghosts"),
        ({"call_type": "Consultation Call", "no_show_reason": "Rescheduled"}, "Reschedules"),
        ({"call_type": "Consultation Call", "closed": "Yes"}, "Closed - New"),
        ({"call_type": "Follow Up Call", "closed": "Yes"}, "Closed - Follow Up"),
        ({"closed": "Yes"}, "Total closed"),
    ]
    for preds, label in cases:
        q = (
            sb.table("airtable_full_closer_report")
            .select("record_id", count="exact", head=True)
            .gte("date_time_of_call", WINDOW_START_ISO)
        )
        for k, v in preds.items():
            q = q.eq(k, v)
        n = q.execute().count
        print(f"  {label} ({preds}): {n}")

    # Cancelled (two no_show_reason values via .in_)
    n = (
        sb.table("airtable_full_closer_report")
        .select("record_id", count="exact", head=True)
        .gte("date_time_of_call", WINDOW_START_ISO)
        .eq("call_type", "Consultation Call")
        .in_("no_show_reason", ["Closer Cancelled Call", "Client Cancelled Call"])
        .execute()
        .count
    )
    print(f"  Cancelled (Consultation Call): {n}")

    # calls (Fathom)
    _print_header("calls")
    rows = (
        sb.table("calls")
        .select("id, duration_seconds, call_category")
        .eq("call_category", "client")
        .gte("started_at", WINDOW_START_ISO)
        .execute()
        .data
    )
    durations = [int(r["duration_seconds"]) for r in rows if r.get("duration_seconds") is not None]
    avg = sum(durations) / len(durations) if durations else None
    print(f"  client calls (7d): {len(rows)}  avg duration: {avg and f'{avg:.0f}s' or '—'}")

    if failures:
        print("\nFAILURES:")
        for f in failures:
            print(f"  {f}")
        return 1
    print("\nAll smoke probes returned (read-only; no writes).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
