"""Tests for `agents.ella.retrieval.fetch_recent_channel_context` (Task 5)."""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

from agents.ella import retrieval


class _FakeQuery:
    def __init__(self, parent, table):
        self.parent = parent
        self.table = table

    def select(self, _cols):
        return self

    def eq(self, _col, _val):
        return self

    def is_(self, _col, _val):
        return self

    def lt(self, _col, _val):
        return self

    def in_(self, _col, _vals):
        return self

    def order(self, _col, **_kwargs):
        return self

    def limit(self, _n):
        return self

    def execute(self):
        rows = self.parent.responses.get(self.table, [])
        return SimpleNamespace(data=rows)


class _FakeDB:
    def __init__(self, responses):
        self.responses = responses

    def table(self, name):
        return _FakeQuery(self, name)


def _patch_db(mocker, responses):
    mocker.patch("agents.ella.retrieval.get_client", return_value=_FakeDB(responses))


def test_fetch_recent_returns_empty_string_when_no_args():
    assert retrieval.fetch_recent_channel_context("", before_ts="1.0") == ""
    assert retrieval.fetch_recent_channel_context("C1", before_ts="") == ""


def test_fetch_recent_returns_empty_when_no_messages(mocker):
    _patch_db(mocker, {"slack_messages": [], "clients": [], "team_members": []})
    assert retrieval.fetch_recent_channel_context("C1", before_ts="1.0") == ""


def test_fetch_recent_renders_lines_oldest_first(mocker):
    _patch_db(
        mocker,
        {
            "slack_messages": [
                # Returned desc → script reverses to oldest-first.
                {
                    "slack_ts": "100.2",
                    "slack_user_id": "U2",
                    "author_type": "ella",
                    "text": "second message",
                    "sent_at": "2026-05-08T14:24:00+00:00",
                },
                {
                    "slack_ts": "100.1",
                    "slack_user_id": "U1",
                    "author_type": "team_member",
                    "text": "first message",
                    "sent_at": "2026-05-08T14:23:00+00:00",
                },
            ],
            "clients": [],
            "team_members": [
                {"slack_user_id": "U1", "full_name": "Drake"},
                {"slack_user_id": "U2", "full_name": "Ella"},
            ],
        },
    )

    # Fixed relative_to so the time-ago deltas are deterministic:
    # 14:25 UTC → first(14:23)=120s="2 minutes ago", second(14:24)=60s.
    rel = datetime(2026, 5, 8, 14, 25, 0, tzinfo=timezone.utc)
    out = retrieval.fetch_recent_channel_context(
        "C1", before_ts="200.0", relative_to=rel
    )
    # Oldest first; ET timestamps (14:23 UTC on 2026-05-08 = 10:23 EDT)
    # + pre-computed time-ago delta; team_member → 'advisor', name in
    # parens, Ella included.
    lines = out.split("\n")
    assert len(lines) == 2
    assert (
        lines[0]
        == "[2026-05-08 10:23 ET — 2 minutes ago] advisor (Drake): first message"
    )
    assert (
        lines[1] == "[2026-05-08 10:24 ET — 1 minutes ago] ella (Ella): second message"
    )


def test_fetch_recent_renders_unknown_users_with_raw_id(mocker):
    _patch_db(
        mocker,
        {
            "slack_messages": [
                {
                    "slack_ts": "100.1",
                    "slack_user_id": "U_UNKNOWN",
                    "author_type": "bot",
                    "text": "hi",
                    "sent_at": "2026-05-08T14:23:00+00:00",
                },
            ],
            "clients": [],
            "team_members": [],
        },
    )

    rel = datetime(2026, 5, 8, 14, 23, 0, tzinfo=timezone.utc)  # same instant → <1 min
    out = retrieval.fetch_recent_channel_context(
        "C1", before_ts="200.0", relative_to=rel
    )
    assert out == "[2026-05-08 10:23 ET — <1 minute ago] bot (U_UNKNOWN): hi"


def test_fetch_recent_truncates_at_max_chars(mocker):
    """When the assembled context exceeds the cap, drop the oldest lines
    and prepend a truncation marker."""
    long_text = "x" * 200
    rows = [
        {
            "slack_ts": f"100.{i}",
            "slack_user_id": "U1",
            "author_type": "team_member",
            "text": long_text,
            "sent_at": f"2026-05-08T14:{i:02d}:00+00:00",
        }
        for i in range(15)
    ]
    _patch_db(
        mocker,
        {
            "slack_messages": rows,
            "team_members": [{"slack_user_id": "U1", "full_name": "Drake"}],
            "clients": [],
        },
    )

    # max_chars=500 will fit ~2 lines.
    out = retrieval.fetch_recent_channel_context("C1", before_ts="200.0", max_chars=500)
    assert out.startswith("[...earlier messages truncated...]")
    # At least one full message line preserved (new format).
    assert "(Drake): " in out


def test_build_kb_query_weights_triggering_2x():
    q = retrieval.build_kb_query_from_conversation(
        "the actual question",
        [{"text": "prior one"}, {"text": "prior two"}],
    )
    assert q == "prior one\nprior two\nthe actual question\nthe actual question"


def test_build_kb_query_empty_context_just_trigger_2x():
    q = retrieval.build_kb_query_from_conversation("solo", [])
    assert q == "solo\nsolo"


def test_build_kb_query_skips_blank_messages():
    q = retrieval.build_kb_query_from_conversation(
        "Q", [{"text": ""}, {"text": "  "}, {"text": "real"}]
    )
    assert q == "real\nQ\nQ"


def test_fetch_recent_messages_returns_rows_oldest_first(mocker):
    _patch_db(
        mocker,
        {
            "slack_messages": [
                {
                    "slack_ts": "100.2",
                    "slack_user_id": "U2",
                    "author_type": "ella",
                    "text": "newer",
                    "sent_at": "2026-05-08T14:24:00+00:00",
                },
                {
                    "slack_ts": "100.1",
                    "slack_user_id": "U1",
                    "author_type": "client",
                    "text": "older",
                    "sent_at": "2026-05-08T14:23:00+00:00",
                },
            ],
        },
    )
    rows = retrieval.fetch_recent_channel_messages("C1", before_ts="200.0")
    assert [r["text"] for r in rows] == ["older", "newer"]
    # Ella's own post is included (no author_type filter).
    assert any(r["author_type"] == "ella" for r in rows)


# --- prompt-sharpening spec: time-ago delta -----------------------------


def test_format_time_ago_bands():
    f = retrieval._format_time_ago
    assert f(0) == "<1 minute ago"
    assert f(45) == "<1 minute ago"
    assert f(60) == "1 minutes ago"
    assert f(59 * 60) == "59 minutes ago"
    assert f(3600) == "1h ago"  # exact hour, no minutes
    assert f(2 * 3600 + 15 * 60) == "2h 15m ago"
    assert f(23 * 3600) == "23h ago"
    assert f(86400) == "1d ago"
    assert f(86400 * 9) == "9d ago"
    # negative (defensive clamp)
    assert f(-100) == "<1 minute ago"


def test_delta_is_relative_to_param_not_wall_clock(mocker):
    _patch_db(
        mocker,
        {
            "slack_messages": [
                {
                    "slack_ts": "100.1",
                    "slack_user_id": "U1",
                    "author_type": "client",
                    "text": "q",
                    "sent_at": "2026-05-08T14:00:00+00:00",
                },
            ],
            "clients": [],
            "team_members": [],
        },
    )
    # relative_to 22h after the message → "22h ago", regardless of now.
    rel = datetime(2026, 5, 9, 12, 0, 0, tzinfo=timezone.utc)
    out = retrieval.fetch_recent_channel_context(
        "C1", before_ts="200.0", relative_to=rel
    )
    assert "— 22h ago]" in out


def test_default_relative_to_falls_back_to_now(mocker):
    """No relative_to → measured against now(UTC); a very old message
    renders a large day-delta (proves the fallback path runs, not the
    exact value)."""
    _patch_db(
        mocker,
        {
            "slack_messages": [
                {
                    "slack_ts": "100.1",
                    "slack_user_id": "U1",
                    "author_type": "client",
                    "text": "ancient",
                    "sent_at": "2020-01-01T00:00:00+00:00",
                },
            ],
            "clients": [],
            "team_members": [],
        },
    )
    out = retrieval.fetch_recent_channel_context("C1", before_ts="200.0")
    assert "d ago]" in out  # years old → "<N>d ago"
