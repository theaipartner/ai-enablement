"""Tests for `_should_dual_trigger` and `_build_app_mention_from_message`.

Batch 1.5 Task 7 — message events that @-mention Ella's human user_id
get routed through `_process_mention` as if they were app_mentions.
"""

from __future__ import annotations

import api.slack_events as se


BOT_UID = "U_BOT"
HUMAN_UID = "U_HUMAN_ELLA"


def _patch_identities(monkeypatch, *, bot=BOT_UID, human=HUMAN_UID):
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test")
    monkeypatch.setenv("SLACK_USER_TOKEN", "xoxp-test")
    cache = {"xoxb-test": bot, "xoxp-test": human}
    monkeypatch.setattr(
        "api.slack_events.get_user_id_for_token",
        lambda token: cache.get(token),
    )


def test_dual_trigger_fires_on_human_mention_alone(monkeypatch):
    _patch_identities(monkeypatch)
    event = {
        "type": "message",
        "user": "U_CLIENT_1",
        "channel": "C1",
        "text": f"hey <@{HUMAN_UID}>, can you help with module 3?",
        "ts": "1.1",
    }
    assert se._should_dual_trigger(event) is True


def test_dual_trigger_skips_when_bot_also_mentioned(monkeypatch):
    """A message with both mentions also fires an app_mention event Slack-side;
    skip the dual-trigger to avoid double-response."""
    _patch_identities(monkeypatch)
    event = {
        "type": "message",
        "user": "U_CLIENT_1",
        "channel": "C1",
        "text": f"<@{BOT_UID}> <@{HUMAN_UID}> help me",
        "ts": "1.1",
    }
    assert se._should_dual_trigger(event) is False


def test_dual_trigger_skips_when_no_human_mention(monkeypatch):
    _patch_identities(monkeypatch)
    event = {
        "type": "message",
        "user": "U_CLIENT_1",
        "channel": "C1",
        "text": "just chatting, no Ella mention here",
        "ts": "1.1",
    }
    assert se._should_dual_trigger(event) is False


def test_dual_trigger_skips_when_author_is_human_ella(monkeypatch):
    """Don't self-respond to Ella's own posts."""
    _patch_identities(monkeypatch)
    event = {
        "type": "message",
        "user": HUMAN_UID,
        "channel": "C1",
        "text": f"<@{HUMAN_UID}> talking to myself",
        "ts": "1.1",
    }
    assert se._should_dual_trigger(event) is False


def test_dual_trigger_skips_when_author_is_bot(monkeypatch):
    _patch_identities(monkeypatch)
    event = {
        "type": "message",
        "user": BOT_UID,
        "channel": "C1",
        "text": f"<@{HUMAN_UID}> bot mentioning human",
        "ts": "1.1",
    }
    assert se._should_dual_trigger(event) is False


def test_dual_trigger_skips_when_human_token_unresolved(monkeypatch):
    """If SLACK_USER_TOKEN isn't set or auth.test fails, fail-soft False."""
    _patch_identities(monkeypatch, human=None)
    event = {
        "type": "message",
        "user": "U_CLIENT_1",
        "channel": "C1",
        "text": "<@U_HUMAN_ELLA> hi",
        "ts": "1.1",
    }
    assert se._should_dual_trigger(event) is False


def test_build_app_mention_payload_flips_type():
    payload = {
        "type": "event_callback",
        "event": {
            "type": "message",
            "user": "U_CLIENT_1",
            "channel": "C1",
            "text": f"<@{HUMAN_UID}> help me",
            "ts": "1.1",
            "thread_ts": "1.0",
        },
    }
    out = se._build_app_mention_from_message(payload)
    assert out["event"]["type"] == "app_mention"
    # Other fields preserved.
    assert out["event"]["user"] == "U_CLIENT_1"
    assert out["event"]["channel"] == "C1"
    assert out["event"]["text"] == f"<@{HUMAN_UID}> help me"
    assert out["event"]["thread_ts"] == "1.0"
    # Original payload not mutated.
    assert payload["event"]["type"] == "message"
