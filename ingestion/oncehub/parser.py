"""Parse OnceHub v2 booking objects -> oncehub_bookings row dicts.

Pure projection — denormalize hot fields, keep the full object in raw_payload.
No business-logic derivations (lead resolution, booking_cycles lifecycle, the
closer funnel) — those live in the future aggregation/spine layer that reads
this mirror.

The SAME booking object shape arrives from two places, so one parser serves
both:
  - the webhook envelope's `data` object (api/oncehub_events.py), and
  - the /v2/bookings list/detail entries (scripts/backfill_oncehub.py).

Verified against the live v2 payload (2026-06-19 discovery). The one thing not
yet seen on a real form booking is a populated `form_submission` + a hidden-field
`custom_fields` entry — `_extract_*` are written defensively for when they land.
"""

from __future__ import annotations

from typing import Any

# Field names we accept for the Close lead_id hidden field, case-insensitive.
# The exact label depends on what Zain names the hidden field in OnceHub; accept
# the obvious variants so a naming choice there doesn't silently drop the link.
_LEAD_ID_KEYS = {"lead_id", "close_lead_id", "leadid", "lead", "close_id"}


def _extract_custom_fields(booking: dict[str, Any]) -> list[dict[str, Any]]:
    """Collect custom_fields from both possible locations.

    OnceHub surfaces custom fields at the top level of the booking object AND
    inside `form_submission` depending on how the booking was made. Merge both;
    de-dupe is unnecessary for a faithful mirror.
    """
    out: list[dict[str, Any]] = []
    top = booking.get("custom_fields")
    if isinstance(top, list):
        out.extend(cf for cf in top if isinstance(cf, dict))
    fs = booking.get("form_submission")
    if isinstance(fs, dict):
        nested = fs.get("custom_fields")
        if isinstance(nested, list):
            out.extend(cf for cf in nested if isinstance(cf, dict))
    return out


def _extract_lead_id(custom_fields: list[dict[str, Any]]) -> str | None:
    """Pull the Close lead_id out of the custom_fields array, if present.

    Each entry is roughly {"name": <label>, "value": <value>}. Match the name
    case-insensitively against the accepted keys. Returns the first non-empty
    value found. Null until the hidden field is configured in OnceHub.

    NOTE: the hidden field is tamperable in the booking URL — treat this as a
    HINT. The lead-resolution layer must validate it against close_leads before
    trusting it (booking-to-close.md § Matching priority).
    """
    for cf in custom_fields:
        name = str(cf.get("name") or "").strip().lower()
        if name in _LEAD_ID_KEYS:
            value = cf.get("value")
            if value not in (None, ""):
                return str(value).strip()
    return None


def parse_booking(booking: dict[str, Any], *, event_type: str | None = None) -> dict[str, Any]:
    """Project a v2 booking object into an oncehub_bookings row.

    `event_type` is the webhook event name (e.g. "booking.no_show") when called
    from the webhook receiver — stored as last_event_type so a no-show / cancel
    is captured even if the booking's own `status` doesn't move. None on backfill.

    Returns {} if the object has no usable id (caller skips).
    """
    booking_id = booking.get("id") or booking.get("tracking_id")
    if not booking_id:
        return {}

    form = booking.get("form_submission") if isinstance(booking.get("form_submission"), dict) else {}
    cancel = booking.get("cancel_reschedule_information")
    cancel = cancel if isinstance(cancel, dict) else {}
    vc = booking.get("virtual_conferencing")
    vc = vc if isinstance(vc, dict) else {}

    custom_fields = _extract_custom_fields(booking)

    return {
        "booking_id": booking_id,
        "tracking_id": booking.get("tracking_id"),
        "subject": booking.get("subject"),
        "status": booking.get("status"),
        "in_trash": bool(booking.get("in_trash", False)),
        "scheduled_at": booking.get("starting_time"),
        "duration_minutes": booking.get("duration_minutes"),
        "booked_at": booking.get("creation_time"),
        "last_updated_time": booking.get("last_updated_time"),
        "customer_timezone": booking.get("customer_timezone"),
        "join_url": vc.get("join_url"),
        "owner_user_id": booking.get("owner"),
        "booking_calendar_id": booking.get("booking_calendar"),
        "booking_page_id": booking.get("booking_page"),
        "master_page_id": booking.get("master_page"),
        "event_type_id": booking.get("event_type"),
        "contact_id": booking.get("contact"),
        "conversation_id": booking.get("conversation"),
        "invitee_name": form.get("name"),
        "invitee_email": form.get("email"),
        "invitee_phone": form.get("phone") or form.get("mobile_phone"),
        "lead_id": _extract_lead_id(custom_fields),
        "custom_fields": custom_fields,
        "utm_params": booking.get("utm_params"),
        "rescheduled_booking_id": booking.get("rescheduled_booking_id"),
        "canceled_by": cancel.get("actioned_by"),
        "cancel_user_id": cancel.get("user_id"),
        "cancel_reason": cancel.get("reason"),
        "source": "oncehub",
        "last_event_type": event_type,
        "raw_payload": booking,
        # excluded_at is creator-only — never written by the parser.
    }
