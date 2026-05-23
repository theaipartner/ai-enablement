"""Tests for `agents.ella.retrieval.fetch_recent_at_mention_exchanges`.

Covers the @-handler's focused conversational-context fetch — the
last N @-mention exchanges (mention + Ella's reply) in a channel,
paired by Ella's user_id (not author_type — working around the open
`author_type='bot'` issue).
"""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

from agents.ella import retrieval


# ---------------------------------------------------------------------------
# Fake DB (mirrors test_retrieval_recent_context's shape)
# ---------------------------------------------------------------------------


class _FakeQuery:
    def __init__(self, parent, table):
        self.parent = parent
        self.table = table
        self.last_eq: list[tuple[str, str]] = []

    def select(self, _cols):
        return self

    def eq(self, col, val):
        self.last_eq.append((col, val))
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
        # slack_messages fetch is filtered by channel_id (the .eq call).
        # The fake supports per-channel response shaping via responses
        # keyed by channel id.
        if self.table == "slack_messages":
            channel_id = None
            for col, val in self.last_eq:
                if col == "slack_channel_id":
                    channel_id = val
            rows = self.parent.responses.get(
                f"slack_messages:{channel_id}",
                self.parent.responses.get("slack_messages", []),
            )
            return SimpleNamespace(data=rows)
        return SimpleNamespace(data=self.parent.responses.get(self.table, []))


class _FakeDB:
    def __init__(self, responses):
        self.responses = responses

    def table(self, name):
        return _FakeQuery(self, name)


def _patch_db_and_ella(mocker, responses, ella_ids=None):
    mocker.patch("agents.ella.retrieval.get_client", return_value=_FakeDB(responses))
    mocker.patch(
        "agents.ella.retrieval._resolve_ella_user_ids",
        return_value=set(ella_ids or {"UBOT0001"}),
    )


# Sample slack_messages helper — keeps tests readable.
def _msg(slack_ts, sent_at, user, text, author_type="client"):
    return {
        "slack_ts": slack_ts,
        "slack_user_id": user,
        "author_type": author_type,
        "text": text,
        "sent_at": sent_at,
    }


_REL = datetime(2026, 5, 23, 18, 0, 0, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# Empty-input guards
# ---------------------------------------------------------------------------


def test_no_channel_or_ts_returns_empty():
    assert retrieval.fetch_recent_at_mention_exchanges("", before_ts="1.0") == ""
    assert retrieval.fetch_recent_at_mention_exchanges("C1", before_ts="") == ""


def test_no_messages_returns_empty(mocker):
    _patch_db_and_ella(
        mocker,
        {"slack_messages:C1": [], "clients": [], "team_members": []},
    )
    assert retrieval.fetch_recent_at_mention_exchanges("C1", before_ts="1.0") == ""


def test_no_mentions_in_window_returns_empty(mocker):
    """Window has messages but none mention Ella — empty result, not crash."""
    _patch_db_and_ella(
        mocker,
        {
            # fetch_recent_channel_messages reverses desc→chronological;
            # the fake returns rows in whatever order we provide. Real
            # query orders desc, so feed in desc order to mirror prod.
            "slack_messages:C1": [
                _msg("200.2", "2026-05-23T17:50:00+00:00", "U1", "second"),
                _msg("200.1", "2026-05-23T17:49:00+00:00", "U1", "first"),
            ],
            "clients": [{"slack_user_id": "U1", "full_name": "Drake"}],
            "team_members": [],
        },
    )
    out = retrieval.fetch_recent_at_mention_exchanges(
        "C1", before_ts="300.0", relative_to=_REL
    )
    assert out == ""


# ---------------------------------------------------------------------------
# Core: last 3 exchanges paired by user_id
# ---------------------------------------------------------------------------


def test_pairs_mention_with_ella_reply_by_user_id(mocker):
    """The pairing IS by user_id, not author_type — Ella's reply is
    tagged author_type='bot' here (the open known issue), and we
    still pair correctly."""
    _patch_db_and_ella(
        mocker,
        {
            "slack_messages:C1": [
                # desc → script reverses to oldest-first.
                _msg(
                    "100.2",
                    "2026-05-23T17:31:00+00:00",
                    "UBOT0001",
                    "Sure — module 3 covers sales fundamentals.",
                    author_type="bot",  # ← the bug; author_type is 'bot'
                ),
                _msg(
                    "100.1",
                    "2026-05-23T17:30:00+00:00",
                    "U1",
                    "<@UBOT0001> what's in module 3",
                ),
            ],
            "clients": [{"slack_user_id": "U1", "full_name": "Drake"}],
            "team_members": [],
        },
    )
    out = retrieval.fetch_recent_at_mention_exchanges(
        "C1", before_ts="200.0", relative_to=_REL
    )
    # One exchange — mention + reply, both lines present.
    assert "user (Drake): <@UBOT0001> what's in module 3" in out
    assert "ella (Ella): Sure — module 3 covers sales fundamentals." in out
    # Reply paired despite author_type='bot' — no "(no reply yet)" placeholder.
    assert "(no reply yet)" not in out


def test_mention_without_reply_included_alone(mocker):
    """A trailing mention with no Ella reply yet — include the mention,
    mark the reply as '(no reply yet)'."""
    _patch_db_and_ella(
        mocker,
        {
            "slack_messages:C1": [
                _msg(
                    "100.1",
                    "2026-05-23T17:55:00+00:00",
                    "U1",
                    "<@UBOT0001> what's in module 3",
                ),
            ],
            "clients": [{"slack_user_id": "U1", "full_name": "Drake"}],
            "team_members": [],
        },
    )
    out = retrieval.fetch_recent_at_mention_exchanges(
        "C1", before_ts="200.0", relative_to=_REL
    )
    assert "user (Drake): <@UBOT0001> what's in module 3" in out
    assert "ella: (no reply yet)" in out


def test_returns_only_last_n_exchanges(mocker):
    """Five exchanges in the window — only the LAST 3 should be returned."""
    rows = []
    # Build 5 mention+reply pairs at increasing ts. desc order for the
    # fake fetch (script reverses).
    for i in range(5, 0, -1):
        # Reply (newer ts)
        rows.append(
            _msg(
                f"{100 + i}.2",
                f"2026-05-23T17:{30 + i}:30+00:00",
                "UBOT0001",
                f"reply-{i}",
                author_type="bot",
            )
        )
        # Mention (older ts)
        rows.append(
            _msg(
                f"{100 + i}.1",
                f"2026-05-23T17:{30 + i}:00+00:00",
                "U1",
                f"<@UBOT0001> q-{i}",
            )
        )
    _patch_db_and_ella(
        mocker,
        {
            "slack_messages:C1": rows,
            "clients": [{"slack_user_id": "U1", "full_name": "Drake"}],
            "team_members": [],
        },
    )
    out = retrieval.fetch_recent_at_mention_exchanges(
        "C1", before_ts="200.0", relative_to=_REL, n_exchanges=3
    )
    # The 3 most recent (q-3, q-4, q-5) appear; the 2 oldest (q-1, q-2) don't.
    assert "q-3" in out
    assert "q-4" in out
    assert "q-5" in out
    assert "q-1" not in out
    assert "q-2" not in out
    # And reply pairing maintained.
    assert "reply-5" in out
    assert "reply-4" in out
    assert "reply-3" in out
    # Three blocks separated by '----' dividers (2 separators).
    assert out.count("----") == 2


def test_fewer_than_n_returns_what_exists(mocker):
    """Only 2 exchanges available — return both, no padding."""
    _patch_db_and_ella(
        mocker,
        {
            "slack_messages:C1": [
                _msg(
                    "200.4",
                    "2026-05-23T17:40:00+00:00",
                    "UBOT0001",
                    "answer-2",
                    author_type="bot",
                ),
                _msg(
                    "200.3",
                    "2026-05-23T17:39:00+00:00",
                    "U1",
                    "<@UBOT0001> q2",
                ),
                _msg(
                    "200.2",
                    "2026-05-23T17:31:00+00:00",
                    "UBOT0001",
                    "answer-1",
                    author_type="bot",
                ),
                _msg(
                    "200.1",
                    "2026-05-23T17:30:00+00:00",
                    "U1",
                    "<@UBOT0001> q1",
                ),
            ],
            "clients": [{"slack_user_id": "U1", "full_name": "Drake"}],
            "team_members": [],
        },
    )
    out = retrieval.fetch_recent_at_mention_exchanges(
        "C1", before_ts="300.0", relative_to=_REL, n_exchanges=3
    )
    assert "q1" in out and "q2" in out
    assert out.count("----") == 1  # 2 blocks → 1 divider


# ---------------------------------------------------------------------------
# Privacy invariant — channel-scoped only
# ---------------------------------------------------------------------------


def test_cross_channel_messages_not_returned(mocker):
    """Hard privacy invariant: a fetch for channel C1 must never
    return messages from channel C2 even if both exist in the fake
    DB. The fake DB shapes responses by channel id; the real fetch
    filters by `.eq('slack_channel_id', ...)` on the underlying
    slack_messages query."""
    _patch_db_and_ella(
        mocker,
        {
            "slack_messages:C1": [
                _msg(
                    "100.2",
                    "2026-05-23T17:31:00+00:00",
                    "UBOT0001",
                    "C1-reply",
                    author_type="bot",
                ),
                _msg("100.1", "2026-05-23T17:30:00+00:00", "U1", "<@UBOT0001> C1-q"),
            ],
            "slack_messages:C2": [
                _msg(
                    "100.2",
                    "2026-05-23T17:31:00+00:00",
                    "UBOT0001",
                    "C2-secret-reply",
                    author_type="bot",
                ),
                _msg("100.1", "2026-05-23T17:30:00+00:00", "U2", "<@UBOT0001> C2-q"),
            ],
            "clients": [
                {"slack_user_id": "U1", "full_name": "Drake"},
                {"slack_user_id": "U2", "full_name": "Other"},
            ],
            "team_members": [],
        },
    )
    out = retrieval.fetch_recent_at_mention_exchanges(
        "C1", before_ts="200.0", relative_to=_REL
    )
    assert "C1-q" in out
    assert "C1-reply" in out
    # NEVER pull from the other channel.
    assert "C2-q" not in out
    assert "C2-secret-reply" not in out
    assert "Other" not in out


# ---------------------------------------------------------------------------
# Both Ella user_ids (bot + human) trigger the mention recognition
# ---------------------------------------------------------------------------


def test_human_user_id_mention_recognized_as_ella_mention(mocker):
    """Mention-detection uses the SAME both-user-ids definition as the
    live trigger — a mention of Ella's HUMAN user_id (via
    SLACK_USER_TOKEN) is a prior exchange too."""
    _patch_db_and_ella(
        mocker,
        {
            "slack_messages:C1": [
                _msg(
                    "100.2",
                    "2026-05-23T17:31:00+00:00",
                    "UBOT0001",  # Ella replies as bot user
                    "human-mention-answer",
                    author_type="bot",
                ),
                _msg(
                    "100.1",
                    "2026-05-23T17:30:00+00:00",
                    "U1",
                    "<@UHUMAN001> ping",  # mention of the HUMAN id
                ),
            ],
            "clients": [{"slack_user_id": "U1", "full_name": "Drake"}],
            "team_members": [],
        },
        ella_ids={"UBOT0001", "UHUMAN001"},
    )
    out = retrieval.fetch_recent_at_mention_exchanges(
        "C1", before_ts="200.0", relative_to=_REL
    )
    assert "<@UHUMAN001> ping" in out
    assert "human-mention-answer" in out
