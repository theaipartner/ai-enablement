"""Adapter: Fathom `new-meeting-content-ready` webhook payload → FathomCallRecord.

Used by `api/fathom_events.py` (F2.4) so both the TXT backlog and the live
webhook feed converge on the same `FathomCallRecord` shape and then the same
`ingestion.fathom.pipeline.ingest_call`.

Payload shape follows Fathom's OpenAPI `Meeting` component —
see https://developers.fathom.ai/api-reference/openapi.yaml and the
field-by-field mapping table in docs/archive/historical/fathom_webhook.md §d.1.

Design notes:
  - Missing REQUIRED top-level fields raise `AdapterError`. The handler
    translates that to an HTTP 400; Fathom does not retry on 4xx, and the
    payload won't heal on its own.
  - Missing OPTIONAL fields become `None` / empty lists. The pipeline
    handles the no-transcript / no-summary / no-action_items cases.
  - The full raw JSON is preserved in `FathomCallRecord.raw_text` as a
    JSON string so `calls.raw_payload.raw_text` retains the exact delivery
    for replay or re-parse if the adapter evolves.
  - Emails are lowercased at the boundary — matches the rest of the
    pipeline (`ClientResolver.lookup` and `_upsert_participants` both
    lowercase; doing it here means every downstream comparison is
    already normalized).
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from ingestion.fathom.parser import (
    ActionItem,
    FathomCallRecord,
    Participant,
    Utterance,
)


class AdapterError(ValueError):
    """Raised when a required field is missing from the webhook payload.

    Caller (api/fathom_events.py) converts this to HTTP 400 — Fathom will
    not retry on 4xx, which is the correct outcome for "the payload itself
    is bad." The problem needs human intervention, not another delivery.
    """


# Top-level fields that must be present on every delivery. Aligned with the
# OpenAPI `Meeting` component's `required` list (as of F2.1 spec read).
_REQUIRED_TOP_LEVEL: tuple[str, ...] = (
    "recording_id",
    "title",
    "url",
    "share_url",
    "recording_start_time",
    "recording_end_time",
    "calendar_invitees",
    "recorded_by",
)


# ---------------------------------------------------------------------------
# Public surface
# ---------------------------------------------------------------------------


def record_from_webhook(payload: dict[str, Any]) -> FathomCallRecord:
    """Convert a Fathom webhook payload into a FathomCallRecord.

    Raises:
        AdapterError: when any required top-level field is missing or the
            timestamp format is unparseable.
    """
    _require_top_level(payload)

    started_at = _parse_iso(payload["recording_start_time"])
    recording_end = _parse_iso(payload["recording_end_time"])
    duration_s = max(0, int((recording_end - started_at).total_seconds()))

    utterances = _build_utterances(payload.get("transcript"))
    participants = _build_participants(payload.get("calendar_invitees") or [])
    recorded_by = _build_recorded_by(payload.get("recorded_by"))

    raw_action_items = payload.get("action_items")
    action_items = _build_action_items(raw_action_items)

    summary_text = _extract_summary_text(payload.get("default_summary"))

    return FathomCallRecord(
        external_id=str(payload["recording_id"]),
        title=payload.get("title") or "",
        started_at=started_at,
        scheduled_start=_parse_iso_opt(payload.get("scheduled_start_time")),
        scheduled_end=_parse_iso_opt(payload.get("scheduled_end_time")),
        recording_start=started_at,
        recording_end=recording_end,
        duration_seconds=duration_s,
        language=payload.get("transcript_language"),
        recording_url=payload.get("url"),
        share_link=payload.get("share_url"),
        participants=participants,
        recorded_by=recorded_by,
        utterances=utterances,
        transcript=_render_transcript(utterances),
        raw_text=json.dumps(payload, ensure_ascii=False, sort_keys=True),
        source_path=None,
        parse_warnings=[],
        summary_text=summary_text,
        action_items=action_items,
        source_format="fathom_webhook",
    )


# ---------------------------------------------------------------------------
# Required-field check
# ---------------------------------------------------------------------------


def _require_top_level(payload: dict[str, Any]) -> None:
    missing = [k for k in _REQUIRED_TOP_LEVEL if k not in payload]
    if missing:
        raise AdapterError(
            f"webhook payload missing required fields: {missing}. "
            "See docs/archive/historical/fathom_webhook.md §d.1."
        )


# ---------------------------------------------------------------------------
# Timestamp parsing
# ---------------------------------------------------------------------------


def _parse_iso(value: str) -> datetime:
    """Parse an ISO 8601 timestamp, forcing timezone-aware UTC.

    Fathom's OpenAPI uses `format: date-time` everywhere, which per the
    spec is ISO 8601 with offset. Python 3.11+ handles the `Z` suffix
    natively; older versions would need a swap. Naive timestamps (no
    offset) are coerced to UTC rather than rejected — matches how the
    TXT parser treats its `Date:` line.
    """
    if not isinstance(value, str) or not value:
        raise AdapterError(f"expected ISO 8601 timestamp string, got {value!r}")
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise AdapterError(f"unparseable timestamp {value!r}: {exc}")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _parse_iso_opt(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    return _parse_iso(value)


# ---------------------------------------------------------------------------
# Participants + recorded_by
# ---------------------------------------------------------------------------


def _build_participants(invitees: list[Any]) -> list[Participant]:
    """Map Fathom `calendar_invitees[]` to `Participant[]`.

    Invitees with no email are skipped — downstream pipeline keys on email
    for dedup (call_participants unique on (call_id, email)) and resolver
    lookup. A name-only invitee can't participate in either path today.
    """
    out: list[Participant] = []
    for raw in invitees or []:
        if not isinstance(raw, dict):
            continue
        email = raw.get("email")
        if not email:
            continue
        display = (
            raw.get("name")
            or raw.get("matched_speaker_display_name")
            or email.split("@", 1)[0]
        )
        out.append(
            Participant(display_name=str(display), email=str(email).lower())
        )
    return out


def _build_recorded_by(recorded: Any) -> Participant | None:
    if not isinstance(recorded, dict):
        return None
    email = recorded.get("email")
    if not email:
        return None
    display = recorded.get("name") or email.split("@", 1)[0]
    return Participant(display_name=str(display), email=str(email).lower())


# ---------------------------------------------------------------------------
# Transcript utterances
# ---------------------------------------------------------------------------


def _build_utterances(transcript: Any) -> list[Utterance]:
    """Flatten Fathom's structured transcript to our Utterance shape.

    Fathom shape (per OpenAPI `TranscriptItem`):
        [{ speaker: { display_name, matched_calendar_invitee_email? },
           text, timestamp: "HH:MM:SS" }, ...]

    Maps 1:1 to our `Utterance(timestamp, speaker, text)`. The matched
    calendar invitee email is available but we don't carry it through —
    chunker / classifier already resolve speaker identity via display_name
    matching against participants, and preserving the raw mapping is a
    premature refactor we don't need for V1.
    """
    if not isinstance(transcript, list):
        return []
    out: list[Utterance] = []
    for item in transcript:
        if not isinstance(item, dict):
            continue
        speaker_obj = item.get("speaker") or {}
        speaker = (
            speaker_obj.get("display_name")
            if isinstance(speaker_obj, dict) else None
        ) or ""
        out.append(
            Utterance(
                timestamp=str(item.get("timestamp") or "00:00:00"),
                speaker=str(speaker),
                text=str(item.get("text") or ""),
            )
        )
    return out


def _render_transcript(utterances: list[Utterance]) -> str:
    """Reconstruct a text-shaped transcript matching the TXT-backlog field.

    Backlog sets `FathomCallRecord.transcript` to the text between
    `--- TRANSCRIPT ---` and EOF. For webhook records we render an
    equivalent for the `calls.transcript` column so downstream consumers
    that read that column see the same shape regardless of source.
    """
    return "\n".join(f"[{u.timestamp}] {u.speaker}: {u.text}" for u in utterances)


# ---------------------------------------------------------------------------
# Action items
# ---------------------------------------------------------------------------


def _build_action_items(raw: Any) -> list[ActionItem] | None:
    """Convert Fathom's action_items array to ActionItem[].

    Returns None when the field is missing from the payload (contract:
    None means "no info from this source" and the pipeline leaves the
    call_action_items table untouched). Returns [] when the field is
    present but empty (contract: "this call has zero action items" — the
    pipeline deletes any existing rows for this call and writes nothing).
    """
    if raw is None:
        return None
    if not isinstance(raw, list):
        return None
    out: list[ActionItem] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        assignee = item.get("assignee") or {}
        assignee_email = (
            assignee.get("email") if isinstance(assignee, dict) else None
        )
        assignee_display = (
            assignee.get("name") if isinstance(assignee, dict) else None
        ) or (
            assignee.get("display_name") if isinstance(assignee, dict) else None
        )
        out.append(
            ActionItem(
                description=str(item.get("description") or ""),
                user_generated=bool(item.get("user_generated", False)),
                completed=bool(item.get("completed", False)),
                recording_timestamp=item.get("recording_timestamp"),
                recording_playback_url=item.get("recording_playback_url"),
                assignee_email=(
                    str(assignee_email).lower() if assignee_email else None
                ),
                assignee_display_name=(
                    str(assignee_display) if assignee_display else None
                ),
            )
        )
    return out


# ---------------------------------------------------------------------------
# Summary extraction
# ---------------------------------------------------------------------------


def _extract_summary_text(summary_obj: Any) -> str | None:
    """Pull a plain-text summary from Fathom's `default_summary` field.

    Real-world shape (verified 2026-04-27 against M1.2.5 cron sweep
    payloads): Fathom delivers `default_summary` as
    `{"markdown_formatted": "## Customer:\\n\\n...", "template_name":
    "Customer Success"}`. The `markdown_formatted` key is canonical
    today; the others below are defensive fallbacks for spec drift /
    older account configurations.

    F2.1 doc read missed `markdown_formatted` (the OpenAPI spec was
    silent on `MeetingSummary`'s field names) so M1.2.5's first real
    sweep produced 0 summary docs across 15 client calls. The fix —
    adding `markdown_formatted` to the priority list — is what closes
    that gap.

    Returns:
      - The first non-empty string found at one of the recognized keys.
      - None if the input is missing, empty, or has no recognized key.
    """
    if summary_obj is None:
        return None
    if isinstance(summary_obj, str):
        return summary_obj.strip() or None
    if isinstance(summary_obj, dict):
        # `markdown_formatted` is what Fathom actually sends today;
        # `markdown` / `text` / `content` / `body` / `summary` cover
        # spec-documented or convention-shaped fallbacks.
        for key in (
            "markdown_formatted",
            "markdown",
            "text",
            "content",
            "body",
            "summary",
        ):
            val = summary_obj.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
    return None
