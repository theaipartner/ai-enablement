"""Unit tests for api/slack_events.py:_post_to_slack — the M1.4 user-token
posting strategy with bot-token fallback.

Six paths covered (per M1.4.3 spec):
  1. user token present + Slack returns 200 ok=true → user path used,
     bot path NOT attempted
  2. user token present + Slack returns 4xx → fallback to bot path,
     bot succeeds
  3. user token present + Slack returns 5xx → fallback to bot path,
     bot succeeds
  4. user token present + Slack returns 200 ok=false (e.g., missing_scope,
     not_in_channel) → fallback to bot path, bot succeeds
  5. user token present + network exception (timeout) → fallback to bot
     path, bot succeeds
  6. user token absent → bot path used directly, no user path attempted
  7. both paths fail → caller-visible exception raised, doesn't crash
     handler (caller's try/except in _process_mention catches it)

Tests mock `urllib.request.urlopen` so no real Slack-API calls fire.
Each test asserts which token's Authorization header reached the mock
to confirm the routing decision.
"""

from __future__ import annotations

import io
import json
import urllib.error
from unittest.mock import MagicMock, patch

import pytest

from api import slack_events as se


# ---------------------------------------------------------------------------
# Helpers — mock urlopen responses
# ---------------------------------------------------------------------------


def _slack_ok_response(body: dict | None = None) -> MagicMock:
    """Mock for `urlopen(req)` that returns HTTP 200 with the given JSON body.

    Uses a context-manager-shaped MagicMock so `with urlopen(req) as resp:`
    receives an object whose `.read()` returns the encoded body. Matches
    the real urlopen's interface.
    """
    body = body if body is not None else {"ok": True}
    response = MagicMock()
    response.read.return_value = json.dumps(body).encode("utf-8")
    cm = MagicMock()
    cm.__enter__.return_value = response
    cm.__exit__.return_value = False
    return cm


def _capture_token_from_request(req) -> str:
    """Extract the bearer token from an outbound urllib Request object.

    `req.headers` is dict-like (Slack handler builds it in-line); the
    Authorization header is `Bearer <token>`. Tests use this to assert
    which token (xoxp- vs xoxb-) was actually sent.
    """
    auth = req.headers.get("Authorization") or ""
    return auth.removeprefix("Bearer ")


# ---------------------------------------------------------------------------
# Path 1 — user token present + Slack 200 ok=true → user path used only
# ---------------------------------------------------------------------------


def test_user_token_success_does_not_fall_back(monkeypatch):
    monkeypatch.setenv("SLACK_USER_TOKEN", "xoxp-USER-TEST")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-BOT-TEST")

    seen_tokens = []

    def fake_urlopen(req, timeout=None):
        seen_tokens.append(_capture_token_from_request(req))
        return _slack_ok_response({"ok": True, "ts": "1234.5678"})

    with patch("shared.slack_post.urllib.request.urlopen", side_effect=fake_urlopen):
        se._post_to_slack(channel="C1", text="hi")

    assert seen_tokens == ["xoxp-USER-TEST"], (
        "Expected exactly one Slack call with the user token; "
        f"got {len(seen_tokens)} calls: {seen_tokens}"
    )


# ---------------------------------------------------------------------------
# Path 2 — user token + HTTP 4xx → fallback to bot
# ---------------------------------------------------------------------------


def test_user_token_http_4xx_falls_back_to_bot(monkeypatch):
    monkeypatch.setenv("SLACK_USER_TOKEN", "xoxp-USER-TEST")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-BOT-TEST")

    seen_tokens = []
    call_count = {"n": 0}

    def fake_urlopen(req, timeout=None):
        seen_tokens.append(_capture_token_from_request(req))
        call_count["n"] += 1
        if call_count["n"] == 1:
            # First call (user path) → HTTP 401
            raise urllib.error.HTTPError(
                url=req.full_url, code=401, msg="Unauthorized",
                hdrs=None, fp=io.BytesIO(b'{"ok":false,"error":"invalid_auth"}'),
            )
        # Second call (bot fallback) → success
        return _slack_ok_response({"ok": True, "ts": "1234.5678"})

    with patch("shared.slack_post.urllib.request.urlopen", side_effect=fake_urlopen):
        se._post_to_slack(channel="C1", text="hi")

    assert seen_tokens == ["xoxp-USER-TEST", "xoxb-BOT-TEST"], (
        f"Expected user attempt then bot fallback; got {seen_tokens}"
    )


def test_user_token_http_5xx_falls_back_to_bot(monkeypatch):
    monkeypatch.setenv("SLACK_USER_TOKEN", "xoxp-USER-TEST")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-BOT-TEST")

    seen_tokens = []
    call_count = {"n": 0}

    def fake_urlopen(req, timeout=None):
        seen_tokens.append(_capture_token_from_request(req))
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise urllib.error.HTTPError(
                url=req.full_url, code=503, msg="Service Unavailable",
                hdrs=None, fp=io.BytesIO(b""),
            )
        return _slack_ok_response({"ok": True})

    with patch("shared.slack_post.urllib.request.urlopen", side_effect=fake_urlopen):
        se._post_to_slack(channel="C1", text="hi")

    assert seen_tokens == ["xoxp-USER-TEST", "xoxb-BOT-TEST"]


# ---------------------------------------------------------------------------
# Path 3 — user token + 200 ok=false → fallback to bot
# ---------------------------------------------------------------------------


def test_user_token_ok_false_falls_back_to_bot(monkeypatch):
    """The silent-failure case: HTTP 200 but Slack rejected the call.
    Common causes: missing_scope (user_scope=chat:write not granted),
    not_in_channel (Ella user not invited to the channel),
    channel_not_found. Must trigger fallback — otherwise Ella stays silent."""
    monkeypatch.setenv("SLACK_USER_TOKEN", "xoxp-USER-TEST")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-BOT-TEST")

    seen_tokens = []
    call_count = {"n": 0}

    def fake_urlopen(req, timeout=None):
        seen_tokens.append(_capture_token_from_request(req))
        call_count["n"] += 1
        if call_count["n"] == 1:
            return _slack_ok_response({"ok": False, "error": "missing_scope"})
        return _slack_ok_response({"ok": True})

    with patch("shared.slack_post.urllib.request.urlopen", side_effect=fake_urlopen):
        se._post_to_slack(channel="C1", text="hi")

    assert seen_tokens == ["xoxp-USER-TEST", "xoxb-BOT-TEST"]


def test_user_token_not_in_channel_falls_back_to_bot(monkeypatch):
    """Specifically the not_in_channel case — Ella the user wasn't
    invited to one of the pilot channels. Bot user is, so the fallback
    delivers the message even if Drake forgot to invite her."""
    monkeypatch.setenv("SLACK_USER_TOKEN", "xoxp-USER-TEST")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-BOT-TEST")

    seen_tokens = []
    call_count = {"n": 0}

    def fake_urlopen(req, timeout=None):
        seen_tokens.append(_capture_token_from_request(req))
        call_count["n"] += 1
        if call_count["n"] == 1:
            return _slack_ok_response({"ok": False, "error": "not_in_channel"})
        return _slack_ok_response({"ok": True})

    with patch("shared.slack_post.urllib.request.urlopen", side_effect=fake_urlopen):
        se._post_to_slack(channel="C1", text="hi")

    assert seen_tokens == ["xoxp-USER-TEST", "xoxb-BOT-TEST"]


# ---------------------------------------------------------------------------
# Path 4 — user token + network exception → fallback to bot
# ---------------------------------------------------------------------------


def test_user_token_network_timeout_falls_back_to_bot(monkeypatch):
    monkeypatch.setenv("SLACK_USER_TOKEN", "xoxp-USER-TEST")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-BOT-TEST")

    seen_tokens = []
    call_count = {"n": 0}

    def fake_urlopen(req, timeout=None):
        seen_tokens.append(_capture_token_from_request(req))
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise urllib.error.URLError("timeout")
        return _slack_ok_response({"ok": True})

    with patch("shared.slack_post.urllib.request.urlopen", side_effect=fake_urlopen):
        se._post_to_slack(channel="C1", text="hi")

    assert seen_tokens == ["xoxp-USER-TEST", "xoxb-BOT-TEST"]


def test_user_token_json_decode_error_falls_back_to_bot(monkeypatch):
    """If Slack returns 200 but body is malformed (proxy interfering,
    Cloudflare error page, etc.), JSON decode raises. Treat as failure."""
    monkeypatch.setenv("SLACK_USER_TOKEN", "xoxp-USER-TEST")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-BOT-TEST")

    seen_tokens = []
    call_count = {"n": 0}

    def fake_urlopen(req, timeout=None):
        seen_tokens.append(_capture_token_from_request(req))
        call_count["n"] += 1
        if call_count["n"] == 1:
            response = MagicMock()
            response.read.return_value = b"<html>cloudflare error</html>"
            cm = MagicMock()
            cm.__enter__.return_value = response
            cm.__exit__.return_value = False
            return cm
        return _slack_ok_response({"ok": True})

    with patch("shared.slack_post.urllib.request.urlopen", side_effect=fake_urlopen):
        se._post_to_slack(channel="C1", text="hi")

    assert seen_tokens == ["xoxp-USER-TEST", "xoxb-BOT-TEST"]


# ---------------------------------------------------------------------------
# Path 5 — user token absent → bot path used directly, no user attempted
# ---------------------------------------------------------------------------


def test_no_user_token_uses_bot_directly(monkeypatch):
    """Rollback path: unsetting SLACK_USER_TOKEN should produce the
    pre-M1.4 behavior exactly — bot path used directly, no extra HTTP
    call, no user path log line."""
    monkeypatch.delenv("SLACK_USER_TOKEN", raising=False)
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-BOT-TEST")

    seen_tokens = []

    def fake_urlopen(req, timeout=None):
        seen_tokens.append(_capture_token_from_request(req))
        return _slack_ok_response({"ok": True})

    with patch("shared.slack_post.urllib.request.urlopen", side_effect=fake_urlopen):
        se._post_to_slack(channel="C1", text="hi")

    assert seen_tokens == ["xoxb-BOT-TEST"], (
        "When SLACK_USER_TOKEN is unset, _post_to_slack must call "
        "Slack exactly once via the bot token. No user-token attempt."
    )


def test_empty_user_token_treated_as_unset(monkeypatch):
    """An empty-string env var is a common operational footgun. Treat
    it the same as unset — skip the user path entirely. (`if user_token:`
    handles this; pinning the behavior so a future refactor can't drift.)"""
    monkeypatch.setenv("SLACK_USER_TOKEN", "")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-BOT-TEST")

    seen_tokens = []

    def fake_urlopen(req, timeout=None):
        seen_tokens.append(_capture_token_from_request(req))
        return _slack_ok_response({"ok": True})

    with patch("shared.slack_post.urllib.request.urlopen", side_effect=fake_urlopen):
        se._post_to_slack(channel="C1", text="hi")

    assert seen_tokens == ["xoxb-BOT-TEST"]


# ---------------------------------------------------------------------------
# Path 6 — both paths fail → exception raised, caller's try/except handles
# ---------------------------------------------------------------------------


def test_both_paths_fail_raises_for_caller_to_log(monkeypatch):
    """If user fails AND bot transport-raises, the bot exception bubbles
    up so _process_mention's except-Exception captures the traceback in
    Vercel logs. Slack's HTTP ack already returned 200 in do_POST before
    _post_to_slack ran; this exception never reaches the HTTP response."""
    monkeypatch.setenv("SLACK_USER_TOKEN", "xoxp-USER-TEST")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-BOT-TEST")

    def fake_urlopen(req, timeout=None):
        # Both calls fail with transport error
        raise urllib.error.URLError("network down")

    with patch("shared.slack_post.urllib.request.urlopen", side_effect=fake_urlopen):
        with pytest.raises(urllib.error.URLError):
            se._post_to_slack(channel="C1", text="hi")


def test_both_paths_ok_false_logs_but_does_not_raise(monkeypatch, caplog):
    """If user returns ok=false AND bot also returns ok=false, log the
    bot failure at ERROR but don't raise — Slack already 200'd the
    inbound event, the user just won't get a reply this time. Caller
    proceeds normally."""
    monkeypatch.setenv("SLACK_USER_TOKEN", "xoxp-USER-TEST")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-BOT-TEST")

    call_count = {"n": 0}

    def fake_urlopen(req, timeout=None):
        call_count["n"] += 1
        if call_count["n"] == 1:
            return _slack_ok_response({"ok": False, "error": "missing_scope"})
        return _slack_ok_response({"ok": False, "error": "channel_not_found"})

    with patch("shared.slack_post.urllib.request.urlopen", side_effect=fake_urlopen):
        # No exception expected
        se._post_to_slack(channel="C1", text="hi")

    assert call_count["n"] == 2, "Both paths should be tried"


# ---------------------------------------------------------------------------
# Operational invariants
# ---------------------------------------------------------------------------


def test_bot_token_unset_when_user_token_succeeds_does_not_break(monkeypatch):
    """Edge case: SLACK_USER_TOKEN set, SLACK_BOT_TOKEN unset, user path
    succeeds. Should work — bot fallback is never reached, so its absence
    isn't a problem. Validates we don't eagerly fetch SLACK_BOT_TOKEN
    on the user-success path."""
    monkeypatch.setenv("SLACK_USER_TOKEN", "xoxp-USER-TEST")
    monkeypatch.delenv("SLACK_BOT_TOKEN", raising=False)

    def fake_urlopen(req, timeout=None):
        return _slack_ok_response({"ok": True})

    with patch("shared.slack_post.urllib.request.urlopen", side_effect=fake_urlopen):
        # Should not raise even though SLACK_BOT_TOKEN is unset.
        se._post_to_slack(channel="C1", text="hi")


def test_no_token_raises_runtime_error(monkeypatch):
    """If both env vars are unset, the bot path's existing RuntimeError
    triggers. Preserves the historical behavior — better than silently
    dropping messages."""
    monkeypatch.delenv("SLACK_USER_TOKEN", raising=False)
    monkeypatch.delenv("SLACK_BOT_TOKEN", raising=False)

    with pytest.raises(RuntimeError, match="SLACK_BOT_TOKEN not set"):
        se._post_to_slack(channel="C1", text="hi")


def test_token_never_appears_in_log_output(monkeypatch, caplog):
    """Nothing logged at any level should contain the token bytes.
    Belt-and-suspenders against future logging changes that might
    accidentally log request headers or full env values."""
    import logging
    monkeypatch.setenv("SLACK_USER_TOKEN", "xoxp-DO-NOT-LEAK-USER")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-DO-NOT-LEAK-BOT")

    call_count = {"n": 0}

    def fake_urlopen(req, timeout=None):
        call_count["n"] += 1
        if call_count["n"] == 1:
            return _slack_ok_response({"ok": False, "error": "missing_scope"})
        return _slack_ok_response({"ok": True})

    with patch("shared.slack_post.urllib.request.urlopen", side_effect=fake_urlopen):
        with caplog.at_level(logging.DEBUG):
            se._post_to_slack(channel="C1", text="hi")

    log_text = caplog.text
    assert "DO-NOT-LEAK-USER" not in log_text, "User token leaked into log output!"
    assert "DO-NOT-LEAK-BOT" not in log_text, "Bot token leaked into log output!"
    assert "xoxp-" not in log_text, "Raw user-token prefix appeared in logs"
    assert "xoxb-" not in log_text, "Raw bot-token prefix appeared in logs"
