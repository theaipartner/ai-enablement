"""Unit tests for `agents.ella.identity.resolve_speaker_identity`."""

from __future__ import annotations

from types import SimpleNamespace

from agents.ella import identity


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

    def execute(self):
        rows = self.parent.responses.get(self.table, [])
        return SimpleNamespace(data=rows)


class _FakeDB:
    def __init__(self, responses):
        self.responses = responses

    def table(self, name):
        return _FakeQuery(self, name)


def _patch_db(mocker, responses):
    mocker.patch("agents.ella.identity.get_client", return_value=_FakeDB(responses))


def test_resolve_returns_client_when_slack_user_id_matches_client(mocker):
    _patch_db(
        mocker,
        {"clients": [{"id": "c-1", "full_name": "Javi Pena"}], "team_members": []},
    )

    result = identity.resolve_speaker_identity("U_CLIENT_1")

    assert result.slack_user_id == "U_CLIENT_1"
    assert result.role == "client"
    assert result.display_name == "Javi Pena"
    assert result.client_id == "c-1"
    assert result.team_member_id is None


def test_resolve_returns_advisor_when_slack_user_id_matches_team_member(mocker):
    _patch_db(
        mocker,
        {
            "clients": [],
            "team_members": [{"id": "tm-1", "full_name": "Drake"}],
        },
    )

    result = identity.resolve_speaker_identity("U_DRAKE")

    assert result.role == "advisor"
    assert result.display_name == "Drake"
    assert result.team_member_id == "tm-1"
    assert result.client_id is None


def test_resolve_client_match_wins_over_team_member(mocker):
    """If a slack_user_id is somehow in both tables, the client match
    is returned first (lookup order: clients → team_members)."""
    _patch_db(
        mocker,
        {
            "clients": [{"id": "c-1", "full_name": "Javi Pena"}],
            "team_members": [{"id": "tm-1", "full_name": "(shouldn't match)"}],
        },
    )

    result = identity.resolve_speaker_identity("U_CLIENT_1")

    assert result.role == "client"
    assert result.display_name == "Javi Pena"


def test_resolve_returns_unresolvable_when_no_match(mocker):
    _patch_db(mocker, {"clients": [], "team_members": []})

    result = identity.resolve_speaker_identity("U_UNKNOWN")

    assert result.role == "unresolvable"
    assert result.display_name == "(unverified)"
    assert result.client_id is None
    assert result.team_member_id is None


def test_resolve_returns_unresolvable_when_slack_user_id_missing(mocker):
    _patch_db(mocker, {})

    for empty in (None, ""):
        result = identity.resolve_speaker_identity(empty)
        assert result.role == "unresolvable"
        assert result.slack_user_id == ""
        assert result.display_name == "(unverified)"
