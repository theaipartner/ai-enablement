"""Unit tests for `shared.slack_post.post_message_as_user_first` — the
M1.4 user-token reply path with bot-token fallback, re-homed from the
deleted `api/slack_events.py:_post_to_slack` per spec
`ella-reply-as-human`.

Coverage shape mirrors the prior `test_slack_events_post.py` cases
(adapted for the new helper's fire-and-forget contract — it returns a
dict instead of raising on transport failure):
  1. user token present + Slack returns 200 ok=true → user path used,
     bot path NOT attempted, returns ok=True
  2. user token present + Slack returns 4xx → fallback to bot, returns ok=True
  3. user token present + Slack returns 5xx → fallback to bot, returns ok=True
  4. user token present + Slack returns 200 ok=false (missing_scope,
     not_in_channel) → fallback to bot, returns ok=True
  5. user token present + transport exception → fallback to bot, returns ok=True
  6. user token unset OR empty string → bot path directly, returns ok=True
  7. user token + bot token unset → returns {"ok": False, "slack_error":
     "missing_bot_token"} — never raises (fire-and-forget contract)
  8. both paths fail → returns {"ok": False, ...} — never raises
  9. token never appears in log output

Tests mock `shared.slack_post.urllib.request.urlopen` so no real Slack
calls fire. Each test asserts which token's Authorization header
reached the mock to confirm the routing decision.
"""

from __future__ import annotations

import io
import json
import logging
import urllib.error
from unittest.mock import MagicMock, patch

from shared.slack_post import post_message_as_user_first


# ---------------------------------------------------------------------------
# Mock urlopen helpers
# ---------------------------------------------------------------------------


def _slack_ok_response(body: dict | None = None) -> MagicMock:
    """Mock context-manager urlopen response returning HTTP 200 + JSON body."""
    body = body if body is not None else {"ok": True}
    response = MagicMock()
    response.read.return_value = json.dumps(body).encode("utf-8")
    cm = MagicMock()
    cm.__enter__.return_value = response
    cm.__exit__.return_value = False
    return cm


def _capture_token(req) -> str:
    """Extract the bearer token from an outbound urllib Request."""
    auth = req.headers.get("Authorization") or ""
    return auth.removeprefix("Bearer ")


# ---------------------------------------------------------------------------
# Path 1 — user-token success, no fallback
# ---------------------------------------------------------------------------


def test_user_token_success_does_not_fall_back(monkeypatch):
    monkeypatch.setenv("SLACK_USER_TOKEN", "xoxp-USER-TEST")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-BOT-TEST")

    seen = []

    def fake_urlopen(req, timeout=None):
        seen.append(_capture_token(req))
        return _slack_ok_response({"ok": True, "ts": "1234.5678"})

    with patch("shared.slack_post.urllib.request.urlopen", side_effect=fake_urlopen):
        result = post_message_as_user_first("C1", "hi")

    assert seen == ["xoxp-USER-TEST"]
    assert result == {"ok": True, "slack_error": None, "ts": "1234.5678"}


# ---------------------------------------------------------------------------
# Path 2 — user-token HTTP 4xx → bot fallback
# ---------------------------------------------------------------------------


def test_user_token_http_4xx_falls_back_to_bot(monkeypatch):
    monkeypatch.setenv("SLACK_USER_TOKEN", "xoxp-USER-TEST")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-BOT-TEST")

    seen = []
    n = {"n": 0}

    def fake_urlopen(req, timeout=None):
        seen.append(_capture_token(req))
        n["n"] += 1
        if n["n"] == 1:
            raise urllib.error.HTTPError(
                url=req.full_url, code=401, msg="Unauthorized",
                hdrs=None, fp=io.BytesIO(b'{"ok":false,"error":"invalid_auth"}'),
            )
        return _slack_ok_response({"ok": True, "ts": "9.9"})

    with patch("shared.slack_post.urllib.request.urlopen", side_effect=fake_urlopen):
        result = post_message_as_user_first("C1", "hi")

    assert seen == ["xoxp-USER-TEST", "xoxb-BOT-TEST"]
    assert result["ok"] is True
    assert result["ts"] == "9.9"


def test_user_token_http_5xx_falls_back_to_bot(monkeypatch):
    monkeypatch.setenv("SLACK_USER_TOKEN", "xoxp-USER-TEST")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-BOT-TEST")

    seen = []
    n = {"n": 0}

    def fake_urlopen(req, timeout=None):
        seen.append(_capture_token(req))
        n["n"] += 1
        if n["n"] == 1:
            raise urllib.error.HTTPError(
                url=req.full_url, code=503, msg="Service Unavailable",
                hdrs=None, fp=io.BytesIO(b""),
            )
        return _slack_ok_response({"ok": True})

    with patch("shared.slack_post.urllib.request.urlopen", side_effect=fake_urlopen):
        result = post_message_as_user_first("C1", "hi")

    assert seen == ["xoxp-USER-TEST", "xoxb-BOT-TEST"]
    assert result["ok"] is True


# ---------------------------------------------------------------------------
# Path 3 — user-token Slack ok=false → bot fallback
# ---------------------------------------------------------------------------


def test_user_token_missing_scope_falls_back_to_bot(monkeypatch):
    """The common silent-failure case: Slack returned 200 but the user
    token lacked the necessary scope. Must trigger fallback."""
    monkeypatch.setenv("SLACK_USER_TOKEN", "xoxp-USER-TEST")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-BOT-TEST")

    seen = []
    n = {"n": 0}

    def fake_urlopen(req, timeout=None):
        seen.append(_capture_token(req))
        n["n"] += 1
        if n["n"] == 1:
            return _slack_ok_response({"ok": False, "error": "missing_scope"})
        return _slack_ok_response({"ok": True})

    with patch("shared.slack_post.urllib.request.urlopen", side_effect=fake_urlopen):
        result = post_message_as_user_first("C1", "hi")

    assert seen == ["xoxp-USER-TEST", "xoxb-BOT-TEST"]
    assert result["ok"] is True


def test_user_token_not_in_channel_falls_back_to_bot(monkeypatch):
    """Specifically the not_in_channel case — Ella the user wasn't
    invited to one of the channels. Bot IS, so the fallback delivers
    even if the human account wasn't manually invited."""
    monkeypatch.setenv("SLACK_USER_TOKEN", "xoxp-USER-TEST")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-BOT-TEST")

    seen = []
    n = {"n": 0}

    def fake_urlopen(req, timeout=None):
        seen.append(_capture_token(req))
        n["n"] += 1
        if n["n"] == 1:
            return _slack_ok_response({"ok": False, "error": "not_in_channel"})
        return _slack_ok_response({"ok": True})

    with patch("shared.slack_post.urllib.request.urlopen", side_effect=fake_urlopen):
        result = post_message_as_user_first("C1", "hi")

    assert seen == ["xoxp-USER-TEST", "xoxb-BOT-TEST"]
    assert result["ok"] is True


# ---------------------------------------------------------------------------
# Path 4 — user-token transport exception → bot fallback
# ---------------------------------------------------------------------------


def test_user_token_network_timeout_falls_back_to_bot(monkeypatch):
    monkeypatch.setenv("SLACK_USER_TOKEN", "xoxp-USER-TEST")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-BOT-TEST")

    seen = []
    n = {"n": 0}

    def fake_urlopen(req, timeout=None):
        seen.append(_capture_token(req))
        n["n"] += 1
        if n["n"] == 1:
            raise urllib.error.URLError("timeout")
        return _slack_ok_response({"ok": True})

    with patch("shared.slack_post.urllib.request.urlopen", side_effect=fake_urlopen):
        result = post_message_as_user_first("C1", "hi")

    assert seen == ["xoxp-USER-TEST", "xoxb-BOT-TEST"]
    assert result["ok"] is True


def test_user_token_json_decode_error_falls_back_to_bot(monkeypatch):
    """200 from Slack but body is malformed (proxy interfering,
    Cloudflare error page) → JSON decode raises → fallback to bot."""
    monkeypatch.setenv("SLACK_USER_TOKEN", "xoxp-USER-TEST")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-BOT-TEST")

    seen = []
    n = {"n": 0}

    def fake_urlopen(req, timeout=None):
        seen.append(_capture_token(req))
        n["n"] += 1
        if n["n"] == 1:
            response = MagicMock()
            response.read.return_value = b"<html>cloudflare error</html>"
            cm = MagicMock()
            cm.__enter__.return_value = response
            cm.__exit__.return_value = False
            return cm
        return _slack_ok_response({"ok": True})

    with patch("shared.slack_post.urllib.request.urlopen", side_effect=fake_urlopen):
        result = post_message_as_user_first("C1", "hi")

    assert seen == ["xoxp-USER-TEST", "xoxb-BOT-TEST"]
    assert result["ok"] is True


# ---------------------------------------------------------------------------
# Path 5 — user token unset / empty → bot path directly
# ---------------------------------------------------------------------------


def test_no_user_token_uses_bot_directly(monkeypatch):
    """Rollback path: unsetting SLACK_USER_TOKEN should produce the
    bot-only behavior — bot path used directly, no user-token attempt."""
    monkeypatch.delenv("SLACK_USER_TOKEN", raising=False)
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-BOT-TEST")

    seen = []

    def fake_urlopen(req, timeout=None):
        seen.append(_capture_token(req))
        return _slack_ok_response({"ok": True})

    with patch("shared.slack_post.urllib.request.urlopen", side_effect=fake_urlopen):
        result = post_message_as_user_first("C1", "hi")

    assert seen == ["xoxb-BOT-TEST"]
    assert result["ok"] is True


def test_empty_user_token_treated_as_unset(monkeypatch):
    """An empty-string env var is a common operational footgun.
    Skip the user path entirely. Pinning the behavior so a future
    refactor can't drift."""
    monkeypatch.setenv("SLACK_USER_TOKEN", "")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-BOT-TEST")

    seen = []

    def fake_urlopen(req, timeout=None):
        seen.append(_capture_token(req))
        return _slack_ok_response({"ok": True})

    with patch("shared.slack_post.urllib.request.urlopen", side_effect=fake_urlopen):
        result = post_message_as_user_first("C1", "hi")

    assert seen == ["xoxb-BOT-TEST"]
    assert result["ok"] is True


# ---------------------------------------------------------------------------
# Path 6 — both paths fail / bot unset → no raise (fire-and-forget)
# ---------------------------------------------------------------------------


def test_both_tokens_unset_returns_missing_bot_token(monkeypatch):
    """Both env vars unset → return {"ok": False, "slack_error":
    "missing_bot_token"}. NEVER raises — this is the fire-and-forget
    contract that matches `post_message`'s shape."""
    monkeypatch.delenv("SLACK_USER_TOKEN", raising=False)
    monkeypatch.delenv("SLACK_BOT_TOKEN", raising=False)

    result = post_message_as_user_first("C1", "hi")
    assert result == {"ok": False, "slack_error": "missing_bot_token", "ts": None}


def test_both_paths_fail_returns_ok_false_does_not_raise(monkeypatch):
    """User fails AND bot transport-raises → returns {"ok": False, ...}
    with the bot exception captured in slack_error. Never raises."""
    monkeypatch.setenv("SLACK_USER_TOKEN", "xoxp-USER-TEST")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-BOT-TEST")

    def fake_urlopen(req, timeout=None):
        raise urllib.error.URLError("network down")

    with patch("shared.slack_post.urllib.request.urlopen", side_effect=fake_urlopen):
        # No exception expected.
        result = post_message_as_user_first("C1", "hi")

    assert result["ok"] is False
    assert "URLError" in result["slack_error"]


def test_both_paths_ok_false_returns_bot_error(monkeypatch):
    """User returns ok=false AND bot returns ok=false → return the
    bot's slack_error; do not raise."""
    monkeypatch.setenv("SLACK_USER_TOKEN", "xoxp-USER-TEST")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-BOT-TEST")

    n = {"n": 0}

    def fake_urlopen(req, timeout=None):
        n["n"] += 1
        if n["n"] == 1:
            return _slack_ok_response({"ok": False, "error": "missing_scope"})
        return _slack_ok_response({"ok": False, "error": "channel_not_found"})

    with patch("shared.slack_post.urllib.request.urlopen", side_effect=fake_urlopen):
        result = post_message_as_user_first("C1", "hi")

    assert n["n"] == 2  # Both paths tried
    assert result["ok"] is False
    assert result["slack_error"] == "channel_not_found"


# ---------------------------------------------------------------------------
# Operational invariants
# ---------------------------------------------------------------------------


def test_thread_ts_kwarg_threaded_through(monkeypatch):
    """The helper passes `thread_ts` into the request body so callers
    that thread (none today, but signature-compat for future) work."""
    monkeypatch.setenv("SLACK_USER_TOKEN", "xoxp-USER-TEST")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-BOT-TEST")

    sent_body = {}

    def fake_urlopen(req, timeout=None):
        sent_body.update(json.loads(req.data.decode("utf-8")))
        return _slack_ok_response({"ok": True, "ts": "1.0"})

    with patch("shared.slack_post.urllib.request.urlopen", side_effect=fake_urlopen):
        post_message_as_user_first("C1", "hi", thread_ts="555.0")

    assert sent_body.get("thread_ts") == "555.0"


def test_blocks_kwarg_threaded_through(monkeypatch):
    """Same — `blocks` is signature-compatible with `post_message`."""
    monkeypatch.setenv("SLACK_USER_TOKEN", "xoxp-USER-TEST")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-BOT-TEST")

    sent_body = {}

    def fake_urlopen(req, timeout=None):
        sent_body.update(json.loads(req.data.decode("utf-8")))
        return _slack_ok_response({"ok": True, "ts": "1.0"})

    blocks = [{"type": "section", "text": {"type": "mrkdwn", "text": "hi"}}]
    with patch("shared.slack_post.urllib.request.urlopen", side_effect=fake_urlopen):
        post_message_as_user_first("C1", "hi", blocks=blocks)

    assert sent_body.get("blocks") == blocks


def test_token_never_appears_in_log_output(monkeypatch, caplog):
    """Nothing at any log level should contain the token bytes. Belt-
    and-suspenders against a future logging change that might leak
    request headers or full env values."""
    monkeypatch.setenv("SLACK_USER_TOKEN", "xoxp-DO-NOT-LEAK-USER")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-DO-NOT-LEAK-BOT")

    n = {"n": 0}

    def fake_urlopen(req, timeout=None):
        n["n"] += 1
        if n["n"] == 1:
            return _slack_ok_response({"ok": False, "error": "missing_scope"})
        return _slack_ok_response({"ok": True})

    with patch("shared.slack_post.urllib.request.urlopen", side_effect=fake_urlopen):
        with caplog.at_level(logging.DEBUG):
            post_message_as_user_first("C1", "hi")

    log_text = caplog.text
    assert "DO-NOT-LEAK-USER" not in log_text
    assert "DO-NOT-LEAK-BOT" not in log_text
    assert "xoxp-" not in log_text
    assert "xoxb-" not in log_text
