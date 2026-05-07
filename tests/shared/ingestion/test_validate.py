"""Unit tests for shared.ingestion.validate.

Covers the happy paths, the missing-required raises, the unknown-key
warnings, and the Drive NotImplementedError. Warning assertions patch
the canonical project logger.
"""

from __future__ import annotations

import pytest

from shared.ingestion import validate as v


# ---------------------------------------------------------------------------
# validate_document_metadata — Fathom
# ---------------------------------------------------------------------------


def _fathom_summary_metadata(**overrides):
    base = {
        "client_id": "c1",
        "call_id": "call-1",
        "call_category": "client",
        "started_at": "2026-04-20T12:00:00+00:00",
    }
    base.update(overrides)
    return base


def test_fathom_call_summary_happy_path(mocker):
    warn = mocker.patch("shared.ingestion.validate.logger.warning")
    v.validate_document_metadata(
        _fathom_summary_metadata(),
        source="fathom",
        document_type="call_summary",
    )
    warn.assert_not_called()


def test_fathom_call_summary_missing_client_id_raises():
    md = _fathom_summary_metadata()
    md.pop("client_id")
    with pytest.raises(ValueError, match=r"client_id"):
        v.validate_document_metadata(md, source="fathom", document_type="call_summary")


def test_fathom_call_summary_missing_multiple_required_lists_all():
    md = {"client_id": "c1"}
    with pytest.raises(ValueError) as exc:
        v.validate_document_metadata(md, source="fathom", document_type="call_summary")
    message = str(exc.value)
    for key in ("call_category", "call_id", "started_at"):
        assert key in message


def test_fathom_call_summary_unknown_key_warns_but_passes(mocker):
    warn = mocker.patch("shared.ingestion.validate.logger.warning")
    md = _fathom_summary_metadata(exploratory_field="something")
    v.validate_document_metadata(md, source="fathom", document_type="call_summary")
    warn.assert_called_once()
    message_args = warn.call_args[0]
    assert any("exploratory_field" in str(arg) for arg in message_args)


def test_fathom_transcript_chunk_uses_same_document_spec():
    md = _fathom_summary_metadata()
    v.validate_document_metadata(
        md, source="fathom", document_type="call_transcript_chunk"
    )


def test_fathom_call_review_happy_path(mocker):
    warn = mocker.patch("shared.ingestion.validate.logger.warning")
    v.validate_document_metadata(
        _fathom_summary_metadata(),
        source="fathom",
        document_type="call_review",
    )
    warn.assert_not_called()


def test_fathom_call_review_with_optional_keys_passes_silently(mocker):
    warn = mocker.patch("shared.ingestion.validate.logger.warning")
    md = _fathom_summary_metadata(
        prompt_version="v1",
        model="claude-sonnet-4-6",
    )
    v.validate_document_metadata(
        md, source="fathom", document_type="call_review"
    )
    warn.assert_not_called()


def test_fathom_call_review_missing_required_raises():
    md = _fathom_summary_metadata()
    md.pop("call_id")
    with pytest.raises(ValueError, match=r"call_id"):
        v.validate_document_metadata(
            md, source="fathom", document_type="call_review"
        )


def test_fathom_call_summary_optional_keys_pass_silently(mocker):
    warn = mocker.patch("shared.ingestion.validate.logger.warning")
    md = _fathom_summary_metadata(
        call_type="csm_check_in",
        duration_seconds=1800,
        source_url="https://fathom.video/calls/abc",
        classification_confidence=0.92,
        classification_method="participant_match",
    )
    v.validate_document_metadata(md, source="fathom", document_type="call_summary")
    warn.assert_not_called()


# ---------------------------------------------------------------------------
# validate_document_metadata — Drive and Manual
# ---------------------------------------------------------------------------


def test_drive_raises_not_implemented():
    with pytest.raises(NotImplementedError, match=r"metadata-conventions"):
        v.validate_document_metadata({}, source="drive", document_type="course_lesson")


def test_manual_faq_with_no_metadata_passes(mocker):
    warn = mocker.patch("shared.ingestion.validate.logger.warning")
    v.validate_document_metadata({}, source="manual", document_type="faq")
    warn.assert_not_called()


def test_manual_with_optional_author_passes(mocker):
    warn = mocker.patch("shared.ingestion.validate.logger.warning")
    v.validate_document_metadata(
        {"author": "Drake", "last_reviewed_by": "Scott",
         "last_reviewed_at": "2026-04-10"},
        source="manual",
        document_type="faq",
    )
    warn.assert_not_called()


def test_manual_with_unknown_key_warns(mocker):
    warn = mocker.patch("shared.ingestion.validate.logger.warning")
    v.validate_document_metadata(
        {"author": "Drake", "unexpected": "value"},
        source="manual",
        document_type="faq",
    )
    warn.assert_called_once()


def test_unknown_source_warns_and_passes(mocker):
    """Source with no spec — we don't raise, we log and let it through."""
    warn = mocker.patch("shared.ingestion.validate.logger.warning")
    v.validate_document_metadata(
        {"arbitrary": "value"},
        source="notion",
        document_type="page",
    )
    warn.assert_called_once()


# ---------------------------------------------------------------------------
# validate_chunk_metadata
# ---------------------------------------------------------------------------


def _fathom_chunk_metadata(**overrides):
    base = {
        "chunk_start_ts": "00:00:00",
        "chunk_end_ts": "00:05:00",
        "speaker_list": ["Drake", "Scott"],
        "speaker_turn_count": 6,
    }
    base.update(overrides)
    return base


def test_chunk_metadata_fathom_chunk_happy_path(mocker):
    warn = mocker.patch("shared.ingestion.validate.logger.warning")
    v.validate_chunk_metadata(
        _fathom_chunk_metadata(),
        source="fathom",
        document_type="call_transcript_chunk",
    )
    warn.assert_not_called()


def test_chunk_metadata_fathom_chunk_missing_speaker_turn_count_raises():
    md = _fathom_chunk_metadata()
    md.pop("speaker_turn_count")
    with pytest.raises(ValueError, match=r"speaker_turn_count"):
        v.validate_chunk_metadata(
            md, source="fathom", document_type="call_transcript_chunk"
        )


def test_chunk_metadata_other_combination_passes_silently_when_empty(mocker):
    warn = mocker.patch("shared.ingestion.validate.logger.warning")
    v.validate_chunk_metadata(
        {}, source="manual", document_type="faq"
    )
    warn.assert_not_called()


def test_chunk_metadata_other_combination_warns_when_non_empty(mocker):
    warn = mocker.patch("shared.ingestion.validate.logger.warning")
    v.validate_chunk_metadata(
        {"random_key": "x"}, source="manual", document_type="faq"
    )
    warn.assert_called_once()
