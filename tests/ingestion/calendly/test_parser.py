"""Unit tests for ingestion.calendly.parser.

Pure projection — tests focus on field mapping correctness, especially:
- event_created_at vs start_time (the Engine sheet keys on the former)
- rescheduled / old_invitee / new_invitee lineage
- canceled-event cancellation jsonb
- host fields from first event_membership
- name field preservation (load-bearing: aggregation matches by name,
  not event_type URI, because 58% of historical URIs are retired)
"""

from __future__ import annotations

import pytest

from ingestion.calendly.parser import (
    parse_event_type,
    parse_invitee,
    parse_scheduled_event,
)


# ---------------------------------------------------------------------------
# parse_event_type
# ---------------------------------------------------------------------------


def test_parse_event_type_happy_path():
    payload = {
        "uri": "https://api.calendly.com/event_types/a596a1b1-160e-4ebd-b820-53092036c2c5",
        "name": "AI Partner Strategy Call",
        "duration": 45,
        "kind": "solo",
        "active": True,
        "scheduling_url": "https://calendly.com/aman/strategy",
    }
    row = parse_event_type(payload)
    assert row["uri"].endswith("a596a1b1-160e-4ebd-b820-53092036c2c5")
    assert row["name"] == "AI Partner Strategy Call"
    assert row["duration_minutes"] == 45
    assert row["kind"] == "solo"
    assert row["active"] is True
    assert row["scheduling_url"] == "https://calendly.com/aman/strategy"
    assert row["raw_payload"] == payload


def test_parse_event_type_missing_uri_returns_empty():
    assert parse_event_type({"name": "X"}) == {}


# ---------------------------------------------------------------------------
# parse_scheduled_event
# ---------------------------------------------------------------------------


def _make_event_payload(**overrides):
    base = {
        "uri": "https://api.calendly.com/scheduled_events/9495a10b",
        "name": "Ai Partner Strategy Call",
        "status": "active",
        "start_time": "2026-05-25T21:00:00.000000Z",
        "end_time": "2026-05-25T21:45:00.000000Z",
        "created_at": "2026-05-24T10:34:53.863549Z",
        "updated_at": "2026-05-24T10:34:55.758912Z",
        "event_type": "https://api.calendly.com/event_types/8f6795d3-retired",
        "location": {"location": None, "type": "custom"},
        "invitees_counter": {"active": 1, "limit": 1, "total": 1},
        "event_memberships": [{
            "user": "https://api.calendly.com/users/aman-uuid",
            "user_email": "aman@theaipartner.io",
            "user_name": "Aman Ali",
            "buffered_start_time": "2026-05-25T21:00:00.000000Z",
            "buffered_end_time": "2026-05-25T21:45:00.000000Z",
        }],
    }
    base.update(overrides)
    return base


def test_parse_scheduled_event_happy_path():
    payload = _make_event_payload()
    row = parse_scheduled_event(payload)
    assert row["uri"] == "https://api.calendly.com/scheduled_events/9495a10b"
    assert row["name"] == "Ai Partner Strategy Call"
    assert row["status"] == "active"
    assert row["start_time"] == "2026-05-25T21:00:00.000000Z"
    # event_created_at = when the BOOKING was made in Calendly. The
    # Engine sheet's "New Scheduled Meetings" bucketing key.
    assert row["event_created_at"] == "2026-05-24T10:34:53.863549Z"
    assert row["event_type_uri"] == "https://api.calendly.com/event_types/8f6795d3-retired"
    assert row["host_user_email"] == "aman@theaipartner.io"
    assert row["host_user_name"] == "Aman Ali"
    assert row["cancellation"] is None
    assert row["raw_payload"] == payload


def test_parse_scheduled_event_preserves_name_for_retired_event_type_uri():
    """Load-bearing: aggregation filters by NAME, not event_type URI.
    Verify the name lands cleanly even when the URI points to a
    retired event-type that won't be in the catalog."""
    payload = _make_event_payload(
        event_type="https://api.calendly.com/event_types/abc123-retired-no-longer-in-catalog",
        name="AI Partner Strategy Call",
    )
    row = parse_scheduled_event(payload)
    # The name lands intact (case can drift between Ai/AI; aggregation
    # matches case-insensitively).
    assert row["name"] == "AI Partner Strategy Call"
    # URI lands too but is the "retired" one; aggregation shouldn't
    # join on this.
    assert "retired-no-longer-in-catalog" in row["event_type_uri"]


def test_parse_scheduled_event_canceled_carries_cancellation():
    payload = _make_event_payload(
        status="canceled",
        cancellation={
            "canceled_by": "Aman Ali",
            "canceler_type": "host",
            "created_at": "2026-05-23T15:24:15.317362Z",
            "reason": "",
        },
    )
    row = parse_scheduled_event(payload)
    assert row["status"] == "canceled"
    assert row["cancellation"]["canceler_type"] == "host"
    assert row["cancellation"]["canceled_by"] == "Aman Ali"


def test_parse_scheduled_event_no_event_memberships_leaves_host_fields_null():
    payload = _make_event_payload(event_memberships=[])
    row = parse_scheduled_event(payload)
    assert row["host_user_email"] is None
    assert row["host_user_name"] is None
    assert row["host_user_uri"] is None


def test_parse_scheduled_event_uses_first_membership_only():
    """Group events may have multiple memberships; we denormalize the
    first only. Confirmed in discovery: this org's events are single-host."""
    payload = _make_event_payload(event_memberships=[
        {"user": "https://api.calendly.com/users/host1", "user_email": "a@x.com", "user_name": "Aman"},
        {"user": "https://api.calendly.com/users/host2", "user_email": "b@x.com", "user_name": "Bob"},
    ])
    row = parse_scheduled_event(payload)
    assert row["host_user_email"] == "a@x.com"
    assert row["host_user_name"] == "Aman"


def test_parse_scheduled_event_missing_uri_returns_empty():
    assert parse_scheduled_event({"name": "X"}) == {}


# ---------------------------------------------------------------------------
# parse_invitee
# ---------------------------------------------------------------------------


def _make_invitee_payload(**overrides):
    base = {
        "uri": "https://api.calendly.com/scheduled_events/9495a10b/invitees/inv-1",
        "event": "https://api.calendly.com/scheduled_events/9495a10b",
        "email": "azrarehan2015@gmail.com",
        "name": "Azra Rehan",
        "first_name": "Azra",
        "last_name": "Rehan",
        "status": "active",
        "created_at": "2026-05-24T10:34:53.872673Z",
        "updated_at": "2026-05-24T10:34:53.872673Z",
        "rescheduled": False,
        "old_invitee": None,
        "new_invitee": None,
        "no_show": False,
        "timezone": "America/New_York",
        "cancel_url": "https://calendly.com/cancellations/d163eae9",
        "reschedule_url": "https://calendly.com/reschedulings/d163eae9",
    }
    base.update(overrides)
    return base


def test_parse_invitee_happy_path():
    payload = _make_invitee_payload()
    row = parse_invitee(payload)
    assert row["uri"] == "https://api.calendly.com/scheduled_events/9495a10b/invitees/inv-1"
    assert row["event_uri"] == "https://api.calendly.com/scheduled_events/9495a10b"
    assert row["email"] == "azrarehan2015@gmail.com"
    assert row["status"] == "active"
    assert row["invitee_created_at"] == "2026-05-24T10:34:53.872673Z"
    assert row["rescheduled"] is False
    assert row["no_show"] is False
    assert row["raw_payload"] == payload


def test_parse_invitee_rescheduled_carries_lineage():
    """Reschedule: new invitee has rescheduled=true + old_invitee set.
    Engine-sheet aggregation distinguishes rescheduled bookings from
    new ones via this flag — load-bearing."""
    payload = _make_invitee_payload(
        rescheduled=True,
        old_invitee="https://api.calendly.com/scheduled_events/old-ev/invitees/old-inv",
    )
    row = parse_invitee(payload)
    assert row["rescheduled"] is True
    assert row["old_invitee"].endswith("old-inv")


def test_parse_invitee_canceled_side_carries_new_invitee():
    """The OTHER side of a reschedule: a canceled invitee with
    new_invitee pointing at the replacing one. Lets aggregation
    reconstruct lineage from either direction."""
    payload = _make_invitee_payload(
        status="canceled",
        new_invitee="https://api.calendly.com/scheduled_events/new-ev/invitees/new-inv",
        cancellation={"canceled_by": "Aman", "canceler_type": "host",
                      "created_at": "2026-05-23T10:00:00Z", "reason": ""},
    )
    row = parse_invitee(payload)
    assert row["status"] == "canceled"
    assert row["new_invitee"].endswith("new-inv")
    assert row["cancellation"]["canceler_type"] == "host"


def test_parse_invitee_no_show_flag_preserved():
    row = parse_invitee(_make_invitee_payload(no_show=True))
    assert row["no_show"] is True


def test_parse_invitee_missing_uri_returns_empty():
    payload = _make_invitee_payload()
    payload.pop("uri")
    assert parse_invitee(payload) == {}


def test_parse_invitee_missing_event_returns_empty():
    """invitee.event is the parent-event URI; without it the row has no
    way to join back to its event. Treat as unusable."""
    payload = _make_invitee_payload()
    payload.pop("event")
    assert parse_invitee(payload) == {}


def test_parse_invitee_defaults_for_missing_booleans():
    """If Calendly omits the boolean fields, default to False (not None
    — the DB column is NOT NULL default false)."""
    payload = _make_invitee_payload()
    payload.pop("rescheduled", None)
    payload.pop("no_show", None)
    row = parse_invitee(payload)
    assert row["rescheduled"] is False
    assert row["no_show"] is False
