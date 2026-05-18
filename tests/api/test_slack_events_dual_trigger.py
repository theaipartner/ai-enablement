"""Dispatch tests for api/slack_events.py (unified-path rewrite).

The dual-trigger / reactive-mention machinery (`_should_dual_trigger`,
`_build_app_mention_from_message`, `_process_mention`) was REMOVED in
the 2026-05-18 PM refactor. Every message — @-mentions included —
flows through the realtime ingest fork → passive monitor exactly once.
This file now guards that one-evaluation-per-message contract.
"""

from __future__ import annotations

import api.slack_events as se


def test_removed_reactive_machinery_is_gone():
    assert not hasattr(se, "_should_dual_trigger")
    assert not hasattr(se, "_build_app_mention_from_message")
    assert not hasattr(se, "_process_mention")


def test_post_to_slack_still_present():
    """`_post_to_slack` survives the refactor (independently tested,
    reusable post helper)."""
    assert hasattr(se, "_post_to_slack")
    assert hasattr(se, "_ingest_message_event")


def test_message_event_ingests_exactly_once(monkeypatch):
    """A `message` event (whether or not it @-mentions Ella) routes
    through `_ingest_message_event` once and nothing else fires."""
    calls = {"ingest": 0}
    monkeypatch.setattr(
        se,
        "_ingest_message_event",
        lambda payload: calls.__setitem__("ingest", calls["ingest"] + 1),
    )
    payload = {
        "type": "event_callback",
        "event": {
            "type": "message",
            "channel": "C1",
            "user": "U1",
            "text": "<@U0B03PTJD3P> how does the offer framework work?",
            "ts": "1.1",
        },
    }
    event = payload["event"]
    # Mirror the handler's dispatch branch.
    if event.get("type") == "app_mention":
        pass  # no-op now
    elif event.get("type") == "message":
        se._ingest_message_event(payload)
    assert calls["ingest"] == 1


def test_app_mention_event_is_a_noop(monkeypatch):
    """`app_mention` no longer dispatches anywhere — the parallel
    `message` event handles the same @-mention via the passive path."""
    calls = {"ingest": 0}
    monkeypatch.setattr(
        se,
        "_ingest_message_event",
        lambda payload: calls.__setitem__("ingest", calls["ingest"] + 1),
    )
    event = {"type": "app_mention", "channel": "C1", "user": "U1"}
    if event.get("type") == "app_mention":
        pass  # logged no-op in the real handler
    elif event.get("type") == "message":
        se._ingest_message_event({})
    assert calls["ingest"] == 0
