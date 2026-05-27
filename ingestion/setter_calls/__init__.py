"""Setter-call transcription pipeline.

Pulls Close call recordings, hands the pre-signed S3 URL to Deepgram for
URL-ingest transcription, persists the result in `setter_call_transcripts`.

Public surface:

    from ingestion.setter_calls import transcribe_call, find_pending_calls

    # Process one call
    transcribe_call(close_call_id="acti_xxx")

    # Find calls eligible-but-not-yet-transcribed (since 2026-05-24)
    for close_id in find_pending_calls():
        transcribe_call(close_call_id=close_id)

Eligibility (V1, per Drake 2026-05-27):
  - has_recording=True
  - duration >= 90 seconds
  - recording_expires_at in the future (Close deletes after 30 days)
  - any user_id (closers may set for themselves; the `sales_role='setter'`
    filter is intentionally NOT applied)

Hard isolation from CS surfaces:
  - Writes ONLY to setter_call_transcripts.
  - Does NOT touch the documents table, agent_runs, or any Ella-readable
    surface. Sales-only.
"""

from ingestion.setter_calls.pipeline import (  # noqa: F401
    EligibilityError,
    RecordingFetchError,
    find_pending_calls,
    transcribe_call,
)
