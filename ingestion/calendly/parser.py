"""Parse Calendly API payloads → row dicts for upsert.

Pure projection — denormalize hot fields, store raw_payload jsonb.
No business-logic derivations (closer-filtering / next-day math /
follow-up classification live in the future aggregation layer).
"""

from __future__ import annotations

from typing import Any


def parse_event_type(payload: dict[str, Any]) -> dict[str, Any]:
    """Project an event-type object into a calendly_event_types row.

    Source: /event_types collection entry.
    """
    if not payload.get("uri"):
        return {}
    return {
        "uri": payload.get("uri"),
        "name": payload.get("name"),
        "duration_minutes": payload.get("duration"),
        "kind": payload.get("kind"),
        "active": payload.get("active"),
        "scheduling_url": payload.get("scheduling_url"),
        "raw_payload": payload,
    }


def parse_scheduled_event(payload: dict[str, Any]) -> dict[str, Any]:
    """Project a scheduled_event object into a calendly_scheduled_events row.

    Source: /scheduled_events collection entry OR /scheduled_events/{uuid}
    (Calendly wraps the latter in {resource: ...}; caller unwraps).

    Host fields come from the FIRST event_membership (org events are
    typically single-host; group events would have multiple — for
    the Engine sheet metrics single-host is enough).
    """
    if not payload.get("uri"):
        return {}

    memberships = payload.get("event_memberships") or []
    first_host = memberships[0] if memberships else {}

    return {
        "uri": payload.get("uri"),
        "name": payload.get("name"),
        "status": payload.get("status"),
        "start_time": payload.get("start_time"),
        "end_time": payload.get("end_time"),
        # event_created_at = when the BOOKING was created in Calendly.
        # This is the Engine-sheet "New Scheduled Meetings" bucketing key.
        "event_created_at": payload.get("created_at"),
        "event_updated_at": payload.get("updated_at"),
        "event_type_uri": payload.get("event_type"),
        "host_user_uri": first_host.get("user"),
        "host_user_email": first_host.get("user_email"),
        "host_user_name": first_host.get("user_name"),
        "location": payload.get("location"),
        "invitees_counter": payload.get("invitees_counter"),
        # cancellation is None on active events, dict on canceled.
        "cancellation": payload.get("cancellation"),
        "raw_payload": payload,
    }


def parse_invitee(payload: dict[str, Any]) -> dict[str, Any]:
    """Project an invitee object into a calendly_invitees row.

    Source: /scheduled_events/{uuid}/invitees collection entry OR a
    single invitee fetched by URI (Calendly wraps the latter in
    {resource: ...}; caller unwraps).

    `event_uri` is derived from the invitee's `event` field (a URI
    pointing to the parent scheduled_event).
    """
    if not payload.get("uri"):
        return {}
    event_uri = payload.get("event")
    if not event_uri:
        return {}

    return {
        "uri": payload.get("uri"),
        "event_uri": event_uri,
        "email": payload.get("email"),
        "name": payload.get("name"),
        "first_name": payload.get("first_name"),
        "last_name": payload.get("last_name"),
        "status": payload.get("status"),
        "invitee_created_at": payload.get("created_at"),
        "invitee_updated_at": payload.get("updated_at"),
        # `rescheduled = true` when this invitee replaces a prior one
        # (the 2nd leg of a reschedule pair). Combined with old_invitee
        # → distinguishes reschedules from new bookings.
        "rescheduled": bool(payload.get("rescheduled", False)),
        "old_invitee": payload.get("old_invitee"),
        "new_invitee": payload.get("new_invitee"),
        "no_show": bool(payload.get("no_show", False) or False),
        "timezone": payload.get("timezone"),
        "cancel_url": payload.get("cancel_url"),
        "reschedule_url": payload.get("reschedule_url"),
        # Some endpoints include cancellation on the invitee too
        # (separate from the event's cancellation field).
        "cancellation": payload.get("cancellation"),
        "raw_payload": payload,
    }
