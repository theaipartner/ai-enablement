"""Unit tests for shared.slack_identity.

The cache is the load-bearing piece — second call with the same token
must NOT hit auth.test again. Failure modes (auth.test ok=false,
transport exception) must return None, not raise.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from shared import slack_identity


@pytest.fixture(autouse=True)
def _clear_cache():
    """Each test starts with a clean module cache so cache-hit tests
    don't accidentally pass because a prior test populated the entry."""
    slack_identity._clear_cache_for_tests()
    yield
    slack_identity._clear_cache_for_tests()


# ---------------------------------------------------------------------------
# Resolution + cache
# ---------------------------------------------------------------------------


def test_resolve_returns_user_id_on_success():
    with patch(
        "shared.slack_identity.SlackClient"
    ) as fake_client_cls:
        fake_client_cls.return_value.auth_test.return_value = {
            "ok": True,
            "user_id": "U123ELLA",
            "user": "ella",
        }
        result = slack_identity.get_user_id_for_token("xoxp-token")
    assert result == "U123ELLA"


def test_second_call_uses_cache_no_extra_auth_test():
    """Cache hit must not re-call auth.test. The whole point of the
    module is to avoid a Slack API call per request."""
    with patch(
        "shared.slack_identity.SlackClient"
    ) as fake_client_cls:
        fake_client_cls.return_value.auth_test.return_value = {
            "ok": True,
            "user_id": "U123ELLA",
        }
        first = slack_identity.get_user_id_for_token("xoxp-token")
        second = slack_identity.get_user_id_for_token("xoxp-token")

    assert first == second == "U123ELLA"
    # SlackClient should be instantiated exactly once; the second call
    # is served from cache before any client construction.
    assert fake_client_cls.call_count == 1


def test_different_tokens_cached_independently():
    """Two tokens, two cached entries. Don't accidentally collapse them."""
    call_log = []

    def _factory(*, token=None, **kwargs):
        from unittest.mock import MagicMock

        call_log.append(token)
        m = MagicMock()
        m.auth_test.return_value = {
            "ok": True,
            "user_id": f"U_FOR_{token}",
        }
        return m

    with patch(
        "shared.slack_identity.SlackClient", side_effect=_factory
    ):
        u1 = slack_identity.get_user_id_for_token("xoxp-USER")
        u2 = slack_identity.get_user_id_for_token("xoxb-BOT")
        u3 = slack_identity.get_user_id_for_token("xoxp-USER")  # cache hit

    assert u1 == "U_FOR_xoxp-USER"
    assert u2 == "U_FOR_xoxb-BOT"
    assert u3 == "U_FOR_xoxp-USER"
    # Two distinct token values → two SlackClient constructions; the
    # third call (same token as first) hits cache.
    assert call_log == ["xoxp-USER", "xoxb-BOT"]


# ---------------------------------------------------------------------------
# Failure modes — never raise, always return None
# ---------------------------------------------------------------------------


def test_returns_none_on_empty_token():
    assert slack_identity.get_user_id_for_token("") is None


def test_returns_none_on_none_token():
    assert slack_identity.get_user_id_for_token(None) is None


def test_returns_none_on_auth_test_api_error():
    """auth.test ok=false (invalid_auth, account_inactive) raises
    SlackAPIError from SlackClient. We must catch + return None, not
    propagate to the caller."""
    from ingestion.slack.client import SlackAPIError

    with patch(
        "shared.slack_identity.SlackClient"
    ) as fake_client_cls:
        fake_client_cls.return_value.auth_test.side_effect = SlackAPIError(
            "auth.test", "invalid_auth", {"ok": False, "error": "invalid_auth"}
        )
        result = slack_identity.get_user_id_for_token("xoxp-bad")
    assert result is None


def test_returns_none_on_transport_exception():
    with patch(
        "shared.slack_identity.SlackClient"
    ) as fake_client_cls:
        fake_client_cls.return_value.auth_test.side_effect = (
            RuntimeError("network down")
        )
        result = slack_identity.get_user_id_for_token("xoxp-flaky")
    assert result is None


def test_returns_none_when_auth_test_has_no_user_id():
    """Defensive: if Slack returned ok=true but somehow no user_id
    field (would never happen, but the call site assumes a string)."""
    with patch(
        "shared.slack_identity.SlackClient"
    ) as fake_client_cls:
        fake_client_cls.return_value.auth_test.return_value = {
            "ok": True,
            "team_id": "T1",
        }
        result = slack_identity.get_user_id_for_token("xoxp-token")
    assert result is None


def test_failed_resolution_is_not_cached():
    """If auth.test fails, a subsequent call should retry — caching
    a None would lock in transient failures."""
    from ingestion.slack.client import SlackAPIError

    call_log = []

    def _factory(**kwargs):
        from unittest.mock import MagicMock

        call_log.append(1)
        m = MagicMock()
        if len(call_log) == 1:
            m.auth_test.side_effect = SlackAPIError(
                "auth.test", "rate_limited", {"ok": False, "error": "rate_limited"}
            )
        else:
            m.auth_test.return_value = {"ok": True, "user_id": "URECOVERED"}
        return m

    with patch(
        "shared.slack_identity.SlackClient", side_effect=_factory
    ):
        first = slack_identity.get_user_id_for_token("xoxp-flaky")
        second = slack_identity.get_user_id_for_token("xoxp-flaky")

    assert first is None
    assert second == "URECOVERED"
    assert len(call_log) == 2
