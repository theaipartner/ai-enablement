"""End-to-end orchestration for setter-call transcription.

The public entry point is `transcribe_call(close_call_id)`. It:

  1. Loads the close_calls row.
  2. Verifies the call is eligible (has recording, >= 90s, not expired).
  3. Resolves the Close API URL to a pre-signed S3 URL (a 302).
  4. Posts that S3 URL to Deepgram's URL-ingest endpoint.
  5. Persists the transcript + diarized words + cost into
     setter_call_transcripts (upsert on close_call_id).

Audio never touches our infrastructure — Deepgram fetches the S3 URL
directly. Saves on storage, egress, and the entire Supabase Pro cost
tier. The trade-off is we cannot re-transcribe a call after Close's
30-day recording-expiry deletes it.

Idempotent on close_call_id. By default we skip re-transcribing calls
that already have a row; pass `force=True` to override (use when
swapping models or after a bug fix).

The pipeline runs synchronously in process. A ~2-minute call takes
roughly 2 seconds end-to-end (~125s of audio → Deepgram returns in
~2s); a Vercel function with the default 60s budget handles single
calls comfortably and a small batch in one invocation. The cron-sweep
caller should batch in groups of ~20 to stay well under the limit.
"""

from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any

from ingestion.setter_calls.deepgram import (
    DeepgramError,
    compute_cost_usd,
    extract_speaker_count,
    transcribe_url,
)
from shared.db import get_client
from shared.logging import logger

# Eligibility threshold — anything under 90s is voicemail / hang-up
# territory and not worth a Deepgram call. See Drake's 2026-05-27 spec.
MIN_DURATION_S = 90

# Earliest call we'll process in the backfill. Calls before this date
# either have expired recordings or are out of scope for V1.
EARLIEST_BACKFILL_DATE = "2026-05-24"

# Close's pre-signed URLs are returned via a 302 from the recording
# endpoint. We never follow the redirect ourselves — we just need the
# Location header, which is what Deepgram fetches.
CLOSE_RECORDING_URL_TEMPLATE = "https://api.close.com/call/{acti_id}/recording/"
CLOSE_RECORDING_TIMEOUT_S = 30.0


class EligibilityError(RuntimeError):
    """Raised when a call doesn't meet the V1 eligibility bar."""


class RecordingFetchError(RuntimeError):
    """Raised when the Close API doesn't hand us an S3 URL we can use."""


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def transcribe_call(
    close_call_id: str,
    *,
    db: Any | None = None,
    force: bool = False,
) -> dict[str, Any]:
    """Transcribe one Close call end-to-end.

    Returns the upserted setter_call_transcripts row as a dict.

    Raises:
        EligibilityError: call ineligible (no recording, <90s, expired).
        RecordingFetchError: Close didn't give us an S3 URL.
        DeepgramError: Deepgram API failure.
    """
    db = db or get_client()

    call = _load_close_call(db, close_call_id)
    _assert_eligible(call)

    if not force:
        existing = _load_existing_transcript(db, close_call_id)
        if existing:
            logger.info(
                "setter_calls.skip_existing close_call_id=%s",
                close_call_id,
            )
            return existing

    s3_url = _resolve_s3_url(close_call_id)
    logger.info(
        "setter_calls.deepgram_request close_call_id=%s duration_s=%s",
        close_call_id, call.get("duration"),
    )
    dg = transcribe_url(s3_url)

    row = _build_row(close_call_id, dg)
    return _upsert(db, row)


def find_pending_calls(
    db: Any | None = None,
    *,
    since: str = EARLIEST_BACKFILL_DATE,
    limit: int | None = None,
) -> list[str]:
    """Return close_call_ids that are eligible but lack a transcript.

    `since` defaults to the backfill horizon (2026-05-24). Pass a
    later date for incremental sweeps. `limit` caps the result for
    batched processing in serverless contexts.

    The query is a NOT-EXISTS rather than a LEFT JOIN: we need calls
    that are eligible *and* haven't been transcribed yet. Filters
    here mirror `_assert_eligible` exactly — any drift between these
    and the per-call check is a bug.
    """
    db = db or get_client()

    # We can't express `raw_payload->>has_recording = 'true'` in
    # PostgREST's `not.is.null` family cleanly, so rely on the
    # `recording_url IS NOT NULL` column condition — set by the same
    # webhook event whenever has_recording flips true.
    query = (
        db.table("close_calls")
        .select("close_id")
        .gte("duration", MIN_DURATION_S)
        .not_.is_("recording_url", "null")
        .gte("activity_at", since)
        .order("activity_at", desc=False)
    )
    if limit is not None:
        query = query.limit(limit)
    candidates = [r["close_id"] for r in query.execute().data]

    if not candidates:
        return []

    # Exclude those already transcribed in one round-trip.
    done = (
        db.table("setter_call_transcripts")
        .select("close_call_id")
        .in_("close_call_id", candidates)
        .execute()
    )
    done_ids = {r["close_call_id"] for r in done.data}
    return [c for c in candidates if c not in done_ids]


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _load_close_call(db: Any, close_call_id: str) -> dict[str, Any]:
    # Use maybe_single (returns None on zero rows) instead of single
    # (raises). EligibilityError is the right signal here; we'd rather
    # propagate it through the standard error path than via APIError.
    resp = (
        db.table("close_calls")
        .select("close_id, duration, recording_url, activity_at, raw_payload")
        .eq("close_id", close_call_id)
        .maybe_single()
        .execute()
    )
    if not resp or not resp.data:
        raise EligibilityError(f"close_calls row not found: {close_call_id}")
    return resp.data


def _load_existing_transcript(db: Any, close_call_id: str) -> dict[str, Any] | None:
    resp = (
        db.table("setter_call_transcripts")
        .select("*")
        .eq("close_call_id", close_call_id)
        .execute()
    )
    return resp.data[0] if resp.data else None


def _assert_eligible(call: dict[str, Any]) -> None:
    """Raise EligibilityError if the call shouldn't be transcribed.

    Mirror this exactly in `find_pending_calls`. Any divergence
    means the sweep enqueues calls the per-call path then rejects.
    """
    duration = call.get("duration") or 0
    if duration < MIN_DURATION_S:
        raise EligibilityError(
            f"duration {duration}s < {MIN_DURATION_S}s threshold"
        )

    if not call.get("recording_url"):
        raise EligibilityError("recording_url is NULL")

    raw = call.get("raw_payload") or {}
    if not raw.get("has_recording"):
        raise EligibilityError("raw_payload.has_recording is False")

    expiry_str = raw.get("recording_expires_at")
    if expiry_str:
        try:
            expiry = datetime.fromisoformat(expiry_str.replace("Z", "+00:00"))
        except ValueError:
            # Bad timestamp from Close — skip the check rather than guess.
            return
        if expiry <= datetime.now(timezone.utc):
            raise EligibilityError(
                f"recording expired at {expiry_str} — Close has deleted the audio"
            )


def _resolve_s3_url(close_call_id: str) -> str:
    """Hit Close's recording endpoint with auth, capture the 302 Location.

    Close returns a 302 to a pre-signed S3 URL (Signature + Expires
    query params). We don't follow the redirect — we want the S3 URL
    itself, which Deepgram fetches unauthenticated within the expiry
    window (~24h based on probe).
    """
    api_key = os.getenv("CLOSE_API_KEY")
    if not api_key:
        raise RecordingFetchError(
            "CLOSE_API_KEY not set. Required to resolve Close recording URLs."
        )

    auth = base64.b64encode(f"{api_key}:".encode()).decode()
    url = CLOSE_RECORDING_URL_TEMPLATE.format(acti_id=close_call_id)
    req = urllib.request.Request(
        url,
        method="GET",
        headers={"Authorization": f"Basic {auth}"},
    )

    # We need to capture the 302 before urllib auto-follows it. Subclass
    # the redirect handler to short-circuit.
    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):  # type: ignore[override]
            return None

    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(req, timeout=CLOSE_RECORDING_TIMEOUT_S):
            # We expected a 302 — a 2xx here means the endpoint shape
            # changed and we got something we don't know how to handle.
            raise RecordingFetchError(
                f"Close /recording/ returned 2xx (expected 302) for {close_call_id}"
            )
    except urllib.error.HTTPError as e:
        if e.code == 302:
            s3_url = e.headers.get("Location")
            if not s3_url:
                raise RecordingFetchError(
                    f"Close 302 missing Location header for {close_call_id}"
                ) from e
            return s3_url
        body = ""
        try:
            body = e.read().decode()[:300]
        except Exception:
            pass
        raise RecordingFetchError(
            f"Close /recording/ {close_call_id} → HTTP {e.code}: {body}"
        ) from e


def _build_row(close_call_id: str, dg: dict[str, Any]) -> dict[str, Any]:
    """Project a Deepgram response into a setter_call_transcripts row.

    Defensive on shape — Deepgram has occasionally added/renamed fields,
    so we read with `.get` and tolerate missing optionals.
    """
    metadata = dg.get("metadata") or {}
    channels = (dg.get("results") or {}).get("channels") or []
    if not channels:
        raise DeepgramError(
            f"Deepgram response has no channels for {close_call_id}"
        )
    alt = (channels[0].get("alternatives") or [{}])[0]

    transcript_text = alt.get("transcript") or ""
    words = alt.get("words") or []
    confidence = alt.get("confidence")
    duration_s = metadata.get("duration") or 0.0
    request_id = metadata.get("request_id") or ""
    model = metadata.get("model_info") or metadata.get("models", [None])[0] or "nova-3"
    # `model_info` is a dict keyed by some internal id; collapse to "nova-3"
    # (or whichever model we asked for). Deepgram doesn't echo our exact
    # query param, just internal identifiers, so we trust our request.
    model_name = "nova-3"

    cost_usd = compute_cost_usd(duration_s, model=model_name)
    speaker_count = extract_speaker_count(words)

    return {
        "close_call_id": close_call_id,
        "deepgram_request_id": request_id,
        "model": model_name,
        "duration_s": duration_s,
        "confidence": confidence,
        "transcript_text": transcript_text,
        "words": words,
        "speaker_count": speaker_count,
        "deepgram_cost_usd": cost_usd,
        "raw_response": dg,
    }


def _upsert(db: Any, row: dict[str, Any]) -> dict[str, Any]:
    """Upsert by close_call_id PK; return the persisted row."""
    resp = (
        db.table("setter_call_transcripts")
        .upsert(row, on_conflict="close_call_id", returning="representation")
        .execute()
    )
    if not resp.data:
        raise RuntimeError(
            f"setter_call_transcripts upsert returned no row for {row['close_call_id']}"
        )
    logger.info(
        "setter_calls.persisted close_call_id=%s duration_s=%s cost_usd=%s",
        row["close_call_id"], row["duration_s"], row["deepgram_cost_usd"],
    )
    return resp.data[0]
