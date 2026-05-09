"""Unit tests for ingestion.slack.parser."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from ingestion.slack import parser


CHANNEL = "C12345"
CLIENT_USERS = {"UCLIENT1", "UCLIENT2"}
TEAM_USERS = {"UTEAM1", "UTEAM2"}


def _parse(event, *, clients=CLIENT_USERS, teams=TEAM_USERS):
    return parser.parse_message(
        event,
        channel_id=CHANNEL,
        client_user_ids=clients,
        team_user_ids=teams,
    )


# ---------------------------------------------------------------------------
# Shape variations
# ---------------------------------------------------------------------------


def test_parse_top_level_user_message_from_client():
    event = {
        "type": "message",
        "user": "UCLIENT1",
        "text": "Hey team, quick question on module 3",
        "ts": "1745500000.000100",
    }
    record = _parse(event)
    assert record is not None
    assert record.slack_user_id == "UCLIENT1"
    assert record.author_type == "client"
    assert record.message_type == "message"
    assert record.message_subtype is None
    assert record.slack_thread_ts is None
    assert record.is_thread_parent is False
    assert record.sent_at == datetime.fromtimestamp(1745500000.0001, tz=timezone.utc)


def test_parse_thread_reply_picks_thread_type_and_preserves_parent_ts():
    event = {
        "type": "message",
        "user": "UTEAM1",
        "text": "re: sure",
        "ts": "1745500100.000200",
        "thread_ts": "1745500000.000100",
    }
    record = _parse(event)
    assert record is not None
    assert record.author_type == "team_member"
    assert record.message_type == "thread_reply"
    assert record.slack_thread_ts == "1745500000.000100"


def test_parse_thread_parent_keeps_thread_ts_null_but_flags_parent():
    """When thread_ts == ts, the event is the parent of a thread, not
    a reply. slack_thread_ts stays null (the reply-view query is
    `WHERE slack_thread_ts IS NULL`); but is_thread_parent flags it
    so the pipeline follows into conversations.replies."""
    event = {
        "type": "message",
        "user": "UCLIENT1",
        "text": "starting a thread",
        "ts": "1745500000.000100",
        "thread_ts": "1745500000.000100",
        "reply_count": 3,
    }
    record = _parse(event)
    assert record is not None
    assert record.slack_thread_ts is None
    assert record.is_thread_parent is True


def test_parse_bot_message_sets_author_type_bot():
    event = {
        "type": "message",
        "subtype": "bot_message",
        "bot_id": "B998",
        "text": "📢 channel announcement",
        "ts": "1745500300.000100",
    }
    record = _parse(event)
    assert record is not None
    assert record.author_type == "bot"
    assert record.slack_user_id == "B998"
    assert record.message_type == "bot_message"


def test_parse_workflow_submission_marks_type_and_handles_missing_user():
    event = {
        "type": "message",
        "subtype": "workflow_step",
        "bot_id": "BWORKFLOW",
        "text": "Form submission: weekly accountability — completed",
        "ts": "1745500400.000100",
    }
    record = _parse(event)
    assert record is not None
    assert record.author_type == "workflow"
    assert record.message_type == "workflow_submission"
    # Subtype tagging fires on the text content
    assert record.message_subtype == "accountability_submission"


def test_parse_returns_none_for_system_messages():
    for subtype in ("channel_join", "channel_leave", "channel_topic", "pinned_item"):
        event = {
            "type": "message",
            "subtype": subtype,
            "user": "UCLIENT1",
            "text": "some system text",
            "ts": "1745500500.000100",
        }
        assert _parse(event) is None, f"expected None for subtype {subtype}"


def test_parse_returns_none_for_message_deleted_subtype():
    """Delete events are intentionally ignored to preserve audit trail.
    Original ingestion of the message stays; the delete is a no-op."""
    event = {
        "type": "message",
        "subtype": "message_deleted",
        "deleted_ts": "1745500000.000100",
        "previous_message": {"text": "original text"},
        "ts": "1745500900.000100",
    }
    assert _parse(event) is None


def test_parse_returns_none_for_non_message_event_types():
    assert _parse({"type": "reaction_added", "ts": "1.1"}) is None


def test_parse_returns_none_when_ts_missing():
    assert _parse({"type": "message", "user": "UCLIENT1", "text": "hi"}) is None


# ---------------------------------------------------------------------------
# Author resolution branches
# ---------------------------------------------------------------------------


def test_unknown_user_gets_author_type_unknown():
    event = {
        "type": "message",
        "user": "UUNKNOWN",
        "text": "hello",
        "ts": "1745500600.000100",
    }
    record = _parse(event)
    assert record is not None
    assert record.slack_user_id == "UUNKNOWN"
    assert record.author_type == "unknown"


def test_team_member_resolution_works_when_id_in_team_set():
    event = {
        "type": "message",
        "user": "UTEAM2",
        "text": "team post",
        "ts": "1745500700.000100",
    }
    record = _parse(event)
    assert record is not None
    assert record.author_type == "team_member"


def test_message_with_no_user_no_bot_id_falls_back_to_unknown():
    event = {
        "type": "message",
        "text": "orphan",
        "ts": "1745500800.000100",
    }
    record = _parse(event)
    assert record is not None
    assert record.author_type == "unknown"
    assert record.slack_user_id == "__no_author__"


# ---------------------------------------------------------------------------
# Ella author resolution (V2 Batch 1)
# ---------------------------------------------------------------------------


def test_ella_user_id_resolves_to_ella_author_type():
    """When ella_user_id is set and matches the message's user, the
    author_type is 'ella' regardless of any team_member overlap."""
    event = {
        "type": "message",
        "user": "UELLA",
        "text": "Hi from Ella",
        "ts": "1745500000.000100",
    }
    record = parser.parse_message(
        event,
        channel_id=CHANNEL,
        client_user_ids=CLIENT_USERS,
        team_user_ids=TEAM_USERS,
        ella_user_id="UELLA",
    )
    assert record is not None
    assert record.author_type == "ella"
    assert record.slack_user_id == "UELLA"


def test_ella_check_takes_precedence_over_team_member_membership():
    """If Ella's user_id is also in team_user_ids (e.g., she's
    seeded as a team_members row), Ella wins."""
    event = {
        "type": "message",
        "user": "UELLA",
        "text": "still Ella",
        "ts": "1745500001.000100",
    }
    record = parser.parse_message(
        event,
        channel_id=CHANNEL,
        client_user_ids=CLIENT_USERS,
        team_user_ids=TEAM_USERS | {"UELLA"},
        ella_user_id="UELLA",
    )
    assert record is not None
    assert record.author_type == "ella"


def test_ella_user_id_none_does_not_affect_resolution():
    """Backwards compat: existing callers that don't pass ella_user_id
    see no behavioral change."""
    event = {
        "type": "message",
        "user": "UCLIENT1",
        "text": "hello",
        "ts": "1745500002.000100",
    }
    record = _parse(event)
    assert record is not None
    assert record.author_type == "client"


def test_other_users_not_misclassified_when_ella_user_id_set():
    """Setting ella_user_id should only affect the matching id."""
    event = {
        "type": "message",
        "user": "UCLIENT1",
        "text": "hello",
        "ts": "1745500003.000100",
    }
    record = parser.parse_message(
        event,
        channel_id=CHANNEL,
        client_user_ids=CLIENT_USERS,
        team_user_ids=TEAM_USERS,
        ella_user_id="UELLA",
    )
    assert record is not None
    assert record.author_type == "client"


# ---------------------------------------------------------------------------
# Subtype tagging
# ---------------------------------------------------------------------------


def test_accountability_submission_tagged():
    event = {
        "type": "message",
        "user": "UCLIENT1",
        "text": "Accountability submission for this week: done with module 2",
        "ts": "1745500900.000100",
    }
    assert _parse(event).message_subtype == "accountability_submission"


def test_nps_submission_by_phrase():
    event = {
        "type": "message",
        "user": "UCLIENT1",
        "text": "NPS survey — how likely are you to recommend? 9/10, going well",
        "ts": "1745501000.000100",
    }
    assert _parse(event).message_subtype == "nps_submission"


def test_nps_score_alone_not_enough_without_phrase():
    """Just a score like 9/10 without survey context is just a number
    in chat. Don't false-positive-tag."""
    event = {
        "type": "message",
        "user": "UCLIENT1",
        "text": "I'd give this product 9/10 for sure",
        "ts": "1745501100.000100",
    }
    assert _parse(event).message_subtype is None


def test_ordinary_message_has_no_subtype():
    event = {
        "type": "message",
        "user": "UCLIENT1",
        "text": "just a note, thanks",
        "ts": "1745501200.000100",
    }
    assert _parse(event).message_subtype is None
