"""Unit tests for ingestion.calendly.pipeline.

Pipeline is a thin orchestrator — most logic in parser. Focused tests
on the load-bearing contracts: idempotency, reschedule no-double-count,
fail-soft per record, the webhook orchestration that fetches the
parent event alongside an invitee.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from ingestion.calendly.client import CalendlyAPIError
from ingestion.calendly.pipeline import (
    SyncOutcome,
    sync_event_types,
    sync_invitee_and_event,
    sync_recent_events_with_invitees,
    upsert_event_from_payload,
    upsert_event_type_from_payload,
    upsert_invitee_from_payload,
)


@pytest.fixture
def mock_db():
    db = MagicMock()
    db.table.return_value.upsert.return_value.execute.return_value = MagicMock(data=[])
    return db


@pytest.fixture
def mock_client():
    c = MagicMock()
    c.iter_event_types.return_value = iter([])
    c.iter_scheduled_events.return_value = iter([])
    c.iter_invitees_for_event.return_value = iter([])
    return c


def _ev(uri: str = "https://api.calendly.com/scheduled_events/ev1",
        name: str = "Ai Partner Strategy Call",
        status: str = "active") -> dict:
    return {
        "uri": uri, "name": name, "status": status,
        "start_time": "2026-05-25T21:00:00.000000Z",
        "end_time": "2026-05-25T21:45:00.000000Z",
        "created_at": "2026-05-24T10:00:00Z",
        "updated_at": "2026-05-24T10:00:00Z",
        "event_type": "https://api.calendly.com/event_types/strategy",
        "event_memberships": [
            {"user": "https://api.calendly.com/users/aman",
             "user_email": "aman@x.com", "user_name": "Aman"},
        ],
    }


def _inv(uri: str = "https://api.calendly.com/scheduled_events/ev1/invitees/inv1",
         event_uri: str = "https://api.calendly.com/scheduled_events/ev1",
         **overrides) -> dict:
    base = {
        "uri": uri, "event": event_uri,
        "email": "x@y.com", "name": "X Y",
        "status": "active",
        "created_at": "2026-05-24T10:00:00Z",
        "updated_at": "2026-05-24T10:00:00Z",
        "rescheduled": False,
        "old_invitee": None, "new_invitee": None,
        "no_show": False, "timezone": "America/New_York",
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# Per-row upsert helpers
# ---------------------------------------------------------------------------


def test_upsert_event_from_payload_targets_correct_table(mock_db):
    uri = upsert_event_from_payload(mock_db, _ev())
    assert uri == "https://api.calendly.com/scheduled_events/ev1"
    mock_db.table.assert_called_with("calendly_scheduled_events")


def test_upsert_event_missing_uri_returns_none(mock_db):
    payload = _ev()
    payload.pop("uri")
    assert upsert_event_from_payload(mock_db, payload) is None
    mock_db.table.return_value.upsert.assert_not_called()


def test_upsert_invitee_from_payload_targets_correct_table(mock_db):
    uri = upsert_invitee_from_payload(mock_db, _inv())
    assert uri == "https://api.calendly.com/scheduled_events/ev1/invitees/inv1"
    mock_db.table.assert_called_with("calendly_invitees")


def test_upsert_invitee_missing_event_returns_none(mock_db):
    """Loose-FK guard: invitee with no event_uri can't join back."""
    payload = _inv()
    payload.pop("event")
    assert upsert_invitee_from_payload(mock_db, payload) is None


def test_upsert_event_type_from_payload(mock_db):
    payload = {"uri": "https://api.calendly.com/event_types/strategy",
               "name": "AI Partner Strategy Call", "duration": 45,
               "kind": "solo", "active": True}
    uri = upsert_event_type_from_payload(mock_db, payload)
    assert uri == "https://api.calendly.com/event_types/strategy"
    mock_db.table.assert_called_with("calendly_event_types")


# ---------------------------------------------------------------------------
# sync_event_types
# ---------------------------------------------------------------------------


def test_sync_event_types_iterates_and_upserts(mock_db, mock_client):
    mock_client.iter_event_types.return_value = iter([
        {"uri": "https://api.calendly.com/event_types/a", "name": "A", "kind": "solo", "active": True},
        {"uri": "https://api.calendly.com/event_types/b", "name": "B", "kind": "solo", "active": False},
    ])
    outcome = sync_event_types(mock_client, mock_db, "org-uri")
    assert outcome.event_types_synced == 2


def test_sync_event_types_iter_failure_records_error(mock_db, mock_client):
    mock_client.iter_event_types.side_effect = CalendlyAPIError("boom")
    outcome = sync_event_types(mock_client, mock_db, "org-uri")
    assert outcome.event_types_synced == 0
    assert any("iter_event_types" in e for e in outcome.errors)


# ---------------------------------------------------------------------------
# sync_invitee_and_event — webhook orchestration
# ---------------------------------------------------------------------------


def test_sync_invitee_and_event_happy_path(mock_db, mock_client):
    """invitee.created webhook → upsert invitee + fetch + upsert event."""
    inv_payload = _inv()
    event_payload = _ev()
    mock_client.get_scheduled_event.return_value = event_payload

    outcome = sync_invitee_and_event(mock_client, mock_db, inv_payload)
    assert outcome.invitees_synced == 1
    assert outcome.events_synced == 1
    assert outcome.errors == []
    mock_client.get_scheduled_event.assert_called_once_with(
        "https://api.calendly.com/scheduled_events/ev1",
    )


def test_sync_invitee_and_event_event_fetch_failure_invitee_still_lands(mock_db, mock_client):
    """Fail-soft: parent event fetch failure → invitee still upserted,
    error recorded. The next webhook tick / backfill heals."""
    mock_client.get_scheduled_event.side_effect = CalendlyAPIError("event 500")
    outcome = sync_invitee_and_event(mock_client, mock_db, _inv())
    assert outcome.invitees_synced == 1
    assert outcome.events_synced == 0
    assert any("get_event" in e for e in outcome.errors)


def test_sync_invitee_and_event_invitee_without_event_uri_warns(mock_db, mock_client):
    """An invitee payload with no `event` field is unusable — warn,
    don't try to fetch."""
    payload = _inv()
    payload.pop("event")
    outcome = sync_invitee_and_event(mock_client, mock_db, payload)
    assert outcome.invitees_synced == 0
    assert outcome.invitees_failed == 1
    mock_client.get_scheduled_event.assert_not_called()


def test_sync_invitee_and_event_reschedule_pair_no_double_count(mock_db, mock_client):
    """Reschedule fires as TWO webhook events (invitee.canceled on old,
    invitee.created on new). Each call independently upserts its own
    invitee row. NEITHER call upserts the OTHER row — lineage is
    carried by the old_invitee/new_invitee URIs on the rows themselves.
    Validates that calling sync_invitee_and_event twice does NOT
    create extra rows for the other invitee."""
    mock_client.get_scheduled_event.return_value = _ev()

    # First call: canceled OLD invitee, with new_invitee pointing at new
    old_payload = _inv(
        uri="https://api.calendly.com/scheduled_events/ev1/invitees/old-inv",
        status="canceled",
        new_invitee="https://api.calendly.com/scheduled_events/ev2/invitees/new-inv",
    )
    o1 = sync_invitee_and_event(mock_client, mock_db, old_payload)
    assert o1.invitees_synced == 1

    # Second call: created NEW invitee, with rescheduled=true + old_invitee
    new_payload = _inv(
        uri="https://api.calendly.com/scheduled_events/ev2/invitees/new-inv",
        event_uri="https://api.calendly.com/scheduled_events/ev2",
        rescheduled=True,
        old_invitee="https://api.calendly.com/scheduled_events/ev1/invitees/old-inv",
    )
    o2 = sync_invitee_and_event(mock_client, mock_db, new_payload)
    assert o2.invitees_synced == 1

    # Verify each call upserted exactly ONE invitee row (the one in its
    # own payload), not both. Count upsert calls on calendly_invitees.
    invitee_upsert_calls = [
        c for c in mock_db.table.return_value.upsert.call_args_list
        if isinstance(c.args[0], dict)
        and c.args[0].get("uri", "").endswith(("/old-inv", "/new-inv"))
    ]
    # 2 invitee upserts total (one per call), not 4.
    assert len(invitee_upsert_calls) == 2


# ---------------------------------------------------------------------------
# sync_recent_events_with_invitees — backfill
# ---------------------------------------------------------------------------


def test_sync_recent_events_iterates_both_statuses(mock_db, mock_client):
    """Backfill loops per status because Calendly's status param is
    single-valued. Both active + canceled should be pulled."""
    mock_client.iter_scheduled_events.side_effect = [
        iter([_ev(status="active")]),     # active call
        iter([_ev(uri="https://api.calendly.com/scheduled_events/ev2",
                  status="canceled")]),    # canceled call
    ]
    outcome = sync_recent_events_with_invitees(
        mock_client, mock_db, "org-uri",
        lookback_days=7, future_days=60,
        statuses=("active", "canceled"),
    )
    assert mock_client.iter_scheduled_events.call_count == 2
    assert outcome.events_synced == 2


def test_sync_recent_events_dedups_across_status_iterations(mock_db, mock_client):
    """If the same event appears in both status iterations (rare but
    theoretically possible if a status flips mid-pull), dedup by URI."""
    same_event = _ev(uri="https://api.calendly.com/scheduled_events/dup")
    mock_client.iter_scheduled_events.side_effect = [
        iter([same_event]),
        iter([same_event]),
    ]
    outcome = sync_recent_events_with_invitees(
        mock_client, mock_db, "org-uri",
        statuses=("active", "canceled"),
    )
    # Upserted once, not twice (event_uris_seen dedup).
    assert outcome.events_synced == 1


def test_sync_recent_events_invitee_fetch_failure_per_event_continues(mock_db, mock_client):
    """One event's invitee fetch failing doesn't abort the run."""
    mock_client.iter_scheduled_events.side_effect = [
        iter([_ev(uri="https://api.calendly.com/scheduled_events/ev1"),
              _ev(uri="https://api.calendly.com/scheduled_events/ev2")]),
        iter([]),  # canceled call empty
    ]
    # First event's invitees raise; second succeeds.
    mock_client.iter_invitees_for_event.side_effect = [
        CalendlyAPIError("invitees 500"),
        iter([_inv(uri="https://api.calendly.com/scheduled_events/ev2/invitees/inv1",
                   event_uri="https://api.calendly.com/scheduled_events/ev2")]),
    ]
    outcome = sync_recent_events_with_invitees(
        mock_client, mock_db, "org-uri",
        statuses=("active",),
    )
    assert outcome.events_synced == 2
    assert outcome.invitees_synced == 1
    assert any("invitees" in e for e in outcome.errors)


def test_sync_recent_events_max_events_caps(mock_db, mock_client):
    """--smoke / --limit path."""
    events = [_ev(uri=f"https://api.calendly.com/scheduled_events/ev{i}") for i in range(5)]
    mock_client.iter_scheduled_events.side_effect = [iter(events), iter([])]
    mock_client.iter_invitees_for_event.return_value = iter([])
    outcome = sync_recent_events_with_invitees(
        mock_client, mock_db, "org-uri",
        statuses=("active",), max_events=2,
    )
    assert outcome.events_synced == 2  # capped to 2


# ---------------------------------------------------------------------------
# SyncOutcome defaults
# ---------------------------------------------------------------------------


def test_sync_outcome_defaults_sane():
    o = SyncOutcome()
    assert o.event_types_synced == 0
    assert o.events_synced == 0
    assert o.events_failed == 0
    assert o.invitees_synced == 0
    assert o.invitees_failed == 0
    assert o.warnings == []
    assert o.errors == []
