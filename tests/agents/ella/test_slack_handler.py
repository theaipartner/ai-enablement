"""Wiring tests for `agents.ella.slack_handler` (post-Batch-1.5).

Mocks the database, the speaker resolver, and the agent core so no
Supabase / no Claude. Verifies the routing rules from the handler
module docstring:

  - non-app_mention events are dropped
  - channels not mapped to a client are dropped
  - client / advisor / unresolvable speakers all pass through; the
    real `user` field is preserved (Batch 1.5 fix — V1 rewrote it to
    the channel-mapped client's slack_user_id and lost the real author)
  - advisor (team_member) speakers get `is_team_test=True` stamped
  - mention tokens are stripped from text before hand-off

The agent core (`respond_to_mention`) and the identity resolver are
the seams we mock — we assert on what the handler hands the agent,
since that's the contract.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from agents.ella import slack_handler
from agents.ella.agent import EllaResponse
from agents.ella.identity import SpeakerIdentity


# ---------------------------------------------------------------------------
# Test doubles for the supabase client (slack_channels lookup only)
# ---------------------------------------------------------------------------


class _FakeQuery:
    def __init__(self, parent: "_FakeDB", table: str):
        self.parent = parent
        self.table = table

    def select(self, _cols):
        return self

    def eq(self, _col, _val):
        return self

    def is_(self, _col, _val):
        return self

    def execute(self):
        rows = self.parent.responses.get(self.table, [])
        return SimpleNamespace(data=rows)


class _FakeDB:
    def __init__(self, responses: dict[str, list[dict]]):
        self.responses = responses

    def table(self, name: str) -> _FakeQuery:
        return _FakeQuery(self, name)


def _patch_db(mocker, responses: dict[str, list[dict]]):
    db = _FakeDB(responses)
    mocker.patch("agents.ella.slack_handler.get_client", return_value=db)
    return db


def _patch_agent(mocker, *, escalated: bool = False):
    response = EllaResponse(
        response_text="here's the answer",
        confidence=1.0,
        escalated=escalated,
        escalation_reason="ella_escalated" if escalated else None,
        escalation_id="esc-xyz" if escalated else None,
        agent_run_id="run-abc",
    )
    mock = mocker.patch(
        "agents.ella.slack_handler.respond_to_mention", return_value=response
    )
    return mock


def _patch_identity(mocker, identity: SpeakerIdentity):
    return mocker.patch(
        "agents.ella.slack_handler.resolve_speaker_identity",
        return_value=identity,
    )


def _event_callback(
    *,
    event_type: str = "app_mention",
    user: str = "U_CLIENT_1",
    channel: str = "C_CHAN_1",
    text: str = "<@UBOT> how do I cold call?",
    ts: str = "1745000000.000100",
    thread_ts: str | None = "1745000000.000100",
) -> dict:
    inner = {
        "type": event_type,
        "user": user,
        "channel": channel,
        "text": text,
        "ts": ts,
        "event_ts": ts,
    }
    if thread_ts is not None:
        inner["thread_ts"] = thread_ts
    return {"type": "event_callback", "event": inner}


# ---------------------------------------------------------------------------
# Routing: drop conditions
# ---------------------------------------------------------------------------


def test_handler_ignores_non_app_mention_events(mocker):
    agent_mock = _patch_agent(mocker)
    _patch_db(mocker, {})

    payload = _event_callback(event_type="message")
    result = slack_handler.handle_slack_event(payload)

    assert result["responded"] is False
    assert result["reason"] == "not_app_mention"
    agent_mock.assert_not_called()


def test_handler_ignores_when_channel_not_mapped_to_client(mocker):
    agent_mock = _patch_agent(mocker)
    _patch_db(
        mocker,
        {
            "slack_channels": [
                {"slack_channel_id": "C_CHAN_1", "client_id": None},
            ],
        },
    )

    result = slack_handler.handle_slack_event(_event_callback())

    assert result["responded"] is False
    assert result["reason"] == "channel_not_client_mapped"
    agent_mock.assert_not_called()


def test_handler_ignores_when_channel_row_missing(mocker):
    agent_mock = _patch_agent(mocker)
    _patch_db(mocker, {"slack_channels": []})

    result = slack_handler.handle_slack_event(_event_callback())

    assert result["responded"] is False
    assert result["reason"] == "channel_not_client_mapped"
    agent_mock.assert_not_called()


# ---------------------------------------------------------------------------
# Routing: client / advisor / unresolvable speakers all pass through
# ---------------------------------------------------------------------------


def test_handler_routes_client_mention_to_agent(mocker):
    agent_mock = _patch_agent(mocker)
    _patch_db(
        mocker,
        {
            "slack_channels": [
                {"slack_channel_id": "C_CHAN_1", "client_id": "client-uuid-1"},
            ],
        },
    )
    _patch_identity(
        mocker,
        SpeakerIdentity(
            slack_user_id="U_CLIENT_1",
            display_name="Javi Pena",
            role="client",
            client_id="client-uuid-1",
        ),
    )

    result = slack_handler.handle_slack_event(
        _event_callback(user="U_CLIENT_1", text="<@UBOT> how do I cold call?")
    )

    agent_mock.assert_called_once()
    agent_event = agent_mock.call_args.args[0]
    # Real user_id flows through unchanged — no impersonation.
    assert agent_event["user"] == "U_CLIENT_1"
    assert agent_event["text"] == "how do I cold call?"
    assert agent_event["channel"] == "C_CHAN_1"
    assert "is_team_test" not in agent_event

    assert result["responded"] is True
    assert result["text"] == "here's the answer"
    assert result["channel_id"] == "C_CHAN_1"
    assert result["thread_ts"] == "1745000000.000100"
    assert result["escalated"] is False
    assert result["agent_run_id"] == "run-abc"
    assert result["is_team_test"] is False


def test_handler_uses_ts_when_thread_ts_absent(mocker):
    """A top-level mention has no thread_ts; we thread under its ts."""
    agent_mock = _patch_agent(mocker)
    _patch_db(
        mocker,
        {
            "slack_channels": [
                {"slack_channel_id": "C_CHAN_1", "client_id": "client-uuid-1"},
            ],
        },
    )
    _patch_identity(
        mocker,
        SpeakerIdentity(
            slack_user_id="U_CLIENT_1",
            display_name="Javi Pena",
            role="client",
            client_id="client-uuid-1",
        ),
    )

    payload = _event_callback(thread_ts=None, ts="1745000000.000999")
    result = slack_handler.handle_slack_event(payload)

    assert result["thread_ts"] == "1745000000.000999"
    agent_event = agent_mock.call_args.args[0]
    assert agent_event["thread_ts"] == "1745000000.000999"


def test_handler_advisor_passes_through_with_is_team_test(mocker):
    """Batch 1.5: advisor's user_id flows through verbatim. V1 impersonation removed."""
    agent_mock = _patch_agent(mocker)
    _patch_db(
        mocker,
        {
            "slack_channels": [
                {"slack_channel_id": "C_CHAN_1", "client_id": "client-uuid-1"},
            ],
        },
    )
    _patch_identity(
        mocker,
        SpeakerIdentity(
            slack_user_id="U_DRAKE",
            display_name="Drake",
            role="advisor",
            team_member_id="tm-uuid-drake",
        ),
    )

    result = slack_handler.handle_slack_event(
        _event_callback(user="U_DRAKE", text="<@UBOT> testing")
    )

    agent_mock.assert_called_once()
    agent_event = agent_mock.call_args.args[0]
    # Real user_id preserved — no rewrite to channel-mapped client.
    assert agent_event["user"] == "U_DRAKE"
    assert agent_event["is_team_test"] is True
    assert agent_event["text"] == "testing"

    assert result["responded"] is True
    assert result["is_team_test"] is True


def test_handler_unresolvable_speaker_still_responds(mocker):
    """Unresolvable speakers no longer get dropped — the agent uses a
    safer-fallback prompt path (Task 2). Handler just hands off."""
    agent_mock = _patch_agent(mocker)
    _patch_db(
        mocker,
        {
            "slack_channels": [
                {"slack_channel_id": "C_CHAN_1", "client_id": "client-uuid-1"},
            ],
        },
    )
    _patch_identity(
        mocker,
        SpeakerIdentity(
            slack_user_id="U_RANDOM",
            display_name="(unverified)",
            role="unresolvable",
        ),
    )

    result = slack_handler.handle_slack_event(_event_callback(user="U_RANDOM"))

    agent_mock.assert_called_once()
    agent_event = agent_mock.call_args.args[0]
    assert agent_event["user"] == "U_RANDOM"
    assert "is_team_test" not in agent_event

    assert result["responded"] is True
    assert result["is_team_test"] is False


# ---------------------------------------------------------------------------
# Mention-stripping
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("<@UBOT> hello", "hello"),
        ("<@UBOT|ella> hello", "hello"),
        ("hey <@UBOT> what's up", "hey what's up"),
        ("<@UBOT>   spaced   out   ", "spaced out"),
        ("no mention here", "no mention here"),
    ],
)
def test_strip_mentions(raw, expected):
    assert slack_handler._strip_mentions(raw) == expected


# ---------------------------------------------------------------------------
# Unwrapping: accept both wrapped and bare event dicts
# ---------------------------------------------------------------------------


def test_handler_accepts_bare_event_dict(mocker):
    agent_mock = _patch_agent(mocker)
    _patch_db(
        mocker,
        {
            "slack_channels": [
                {"slack_channel_id": "C_CHAN_1", "client_id": "client-uuid-1"},
            ],
        },
    )
    _patch_identity(
        mocker,
        SpeakerIdentity(
            slack_user_id="U_CLIENT_1",
            display_name="Javi Pena",
            role="client",
            client_id="client-uuid-1",
        ),
    )

    bare = _event_callback()["event"]
    result = slack_handler.handle_slack_event(bare)

    assert result["responded"] is True
    agent_mock.assert_called_once()
