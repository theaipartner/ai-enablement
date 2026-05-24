"""Unit tests for the Close webhook receiver.

Focused on the security boundary (signature verification) + event-type
routing dispatch — the two parts where a bug has the worst blast radius.

The HTTP-handler integration path is covered implicitly through tests
of the helpers it calls; a full BaseHTTPRequestHandler smoke is out of
scope (would need a live HTTP harness; not worth the complexity for a
thin Vercel adapter).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from unittest.mock import MagicMock, patch

import pytest

from api.close_events import (
    _check_replay_window,
    _route_event,
    _synthesize_webhook_id,
    _verify_signature,
)


# ---------------------------------------------------------------------------
# Signature verification — the security boundary
# ---------------------------------------------------------------------------

# Verbatim from Close's docs (fetched 2026-05-23) — paste-and-rederive
# style so the test breaks loudly if our verifier drifts from the docs.
DOCS_SECRET = "058bfb6a3d8cfdc4da7c3be5901b16ae11da982b46a25fb2cd7016e97a140a1c"


def _compute_sig(body: bytes, ts: str, secret_hex: str) -> str:
    """Mirror Close's algorithm for test fixtures."""
    data = ts.encode("utf-8") + body
    return hmac.new(bytes.fromhex(secret_hex), data, hashlib.sha256).hexdigest()


def test_verify_signature_happy_path():
    body = b'{"event":{"object_type":"lead","action":"created"}}'
    ts = "1700000000"
    sig = _compute_sig(body, ts, DOCS_SECRET)
    assert _verify_signature(body, ts, sig, DOCS_SECRET) is True


def test_verify_signature_tampered_body_rejected():
    body = b'{"event":{"object_type":"lead","action":"created"}}'
    ts = "1700000000"
    sig = _compute_sig(body, ts, DOCS_SECRET)
    tampered = body + b"!"
    assert _verify_signature(tampered, ts, sig, DOCS_SECRET) is False


def test_verify_signature_wrong_timestamp_rejected():
    body = b'{"x":1}'
    ts = "1700000000"
    sig = _compute_sig(body, ts, DOCS_SECRET)
    assert _verify_signature(body, "1700000001", sig, DOCS_SECRET) is False


def test_verify_signature_wrong_secret_rejected():
    body = b'{"x":1}'
    ts = "1700000000"
    sig = _compute_sig(body, ts, DOCS_SECRET)
    other_secret = "deadbeef" * 8  # different hex
    assert _verify_signature(body, ts, sig, other_secret) is False


def test_verify_signature_non_hex_secret_rejected():
    body = b'{"x":1}'
    ts = "1700000000"
    sig = _compute_sig(body, ts, DOCS_SECRET)
    assert _verify_signature(body, ts, sig, "not-hex-at-all") is False


def test_verify_signature_empty_headers_rejected():
    body = b'{"x":1}'
    assert _verify_signature(body, "", "", DOCS_SECRET) is False
    assert _verify_signature(body, "1700000000", "", DOCS_SECRET) is False
    assert _verify_signature(body, "", "abc", DOCS_SECRET) is False


def test_verify_signature_empty_secret_rejected():
    body = b'{"x":1}'
    ts = "1700000000"
    sig = _compute_sig(body, ts, DOCS_SECRET)
    assert _verify_signature(body, ts, sig, "") is False


# ---------------------------------------------------------------------------
# Replay-window check
# ---------------------------------------------------------------------------


def test_replay_window_now_accepted():
    now = str(int(time.time()))
    assert _check_replay_window(now) is True


def test_replay_window_just_inside_accepted():
    # 4 minutes ago — inside the 5-minute window.
    ts = str(int(time.time()) - 240)
    assert _check_replay_window(ts) is True


def test_replay_window_outside_rejected():
    # 1 hour ago — outside 5-minute window.
    ts = str(int(time.time()) - 3600)
    assert _check_replay_window(ts) is False


def test_replay_window_future_outside_rejected():
    # 1 hour in the future (clock-skew attack) — outside window.
    ts = str(int(time.time()) + 3600)
    assert _check_replay_window(ts) is False


def test_replay_window_non_numeric_rejected():
    assert _check_replay_window("not-a-number") is False
    assert _check_replay_window("") is False


# ---------------------------------------------------------------------------
# Synthesized webhook_id — dedup key
# ---------------------------------------------------------------------------


def test_synthesize_webhook_id_stable_across_identical_inputs():
    body = b'{"x":1}'
    ts = "1700000000"
    assert _synthesize_webhook_id(ts, body) == _synthesize_webhook_id(ts, body)


def test_synthesize_webhook_id_differs_by_body():
    ts = "1700000000"
    a = _synthesize_webhook_id(ts, b'{"x":1}')
    b = _synthesize_webhook_id(ts, b'{"x":2}')
    assert a != b


def test_synthesize_webhook_id_differs_by_timestamp():
    body = b'{"x":1}'
    a = _synthesize_webhook_id("1700000000", body)
    b = _synthesize_webhook_id("1700000001", body)
    assert a != b


def test_synthesize_webhook_id_format():
    key = _synthesize_webhook_id("1700000000", b"hello")
    assert key.startswith("close:1700000000:")
    # body_hash is sha256 hex[:16] — always 16 lowercase hex chars
    suffix = key.split(":", 2)[2]
    assert len(suffix) == 16
    assert all(c in "0123456789abcdef" for c in suffix)


# ---------------------------------------------------------------------------
# Event-type routing
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_db():
    db = MagicMock()
    # `load_lead_cf_id_to_name` queries close_custom_field_definitions —
    # patched directly in each test that needs it.
    return db


def test_route_lead_created(mock_db):
    with patch("api.close_events.load_lead_cf_id_to_name", return_value={}), \
         patch("api.close_events.upsert_lead_from_payload", return_value="lead_123") as up:
        upserted_id, route = _route_event(
            mock_db, "lead.created", {"id": "lead_123", "display_name": "X"}
        )
    assert upserted_id == "lead_123"
    assert route == "close_leads"
    up.assert_called_once()


def test_route_lead_updated(mock_db):
    with patch("api.close_events.load_lead_cf_id_to_name", return_value={}), \
         patch("api.close_events.upsert_lead_from_payload", return_value="lead_abc") as up:
        upserted_id, route = _route_event(
            mock_db, "lead.updated", {"id": "lead_abc"}
        )
    assert upserted_id == "lead_abc"
    assert route == "close_leads"
    up.assert_called_once()


def test_route_lead_merged_routes_to_lead_upsert(mock_db):
    with patch("api.close_events.load_lead_cf_id_to_name", return_value={}), \
         patch("api.close_events.upsert_lead_from_payload", return_value="lead_z") as up:
        upserted_id, route = _route_event(
            mock_db, "lead.merged", {"id": "lead_z"}
        )
    assert upserted_id == "lead_z"
    assert route == "close_leads"
    up.assert_called_once()


def test_route_opportunity_created_drake_override(mock_db):
    # Drake's 2026-05-23 override: opportunities are IN scope.
    with patch(
        "api.close_events.upsert_opportunity_from_payload", return_value="oppo_1"
    ) as up:
        upserted_id, route = _route_event(
            mock_db, "opportunity.created", {"id": "oppo_1", "lead_id": "lead_1"}
        )
    assert upserted_id == "oppo_1"
    assert route == "close_opportunities"
    up.assert_called_once_with(mock_db, {"id": "oppo_1", "lead_id": "lead_1"})


def test_route_opportunity_updated(mock_db):
    with patch(
        "api.close_events.upsert_opportunity_from_payload", return_value="oppo_2"
    ) as up:
        upserted_id, route = _route_event(
            mock_db, "opportunity.updated", {"id": "oppo_2", "lead_id": "lead_1"}
        )
    assert upserted_id == "oppo_2"
    assert route == "close_opportunities"
    up.assert_called_once()


def test_route_activity_call_created(mock_db):
    with patch("api.close_events.upsert_call_from_payload", return_value="acti_call_1") as up:
        upserted_id, route = _route_event(
            mock_db, "activity.call.created", {"id": "acti_call_1", "lead_id": "lead_1"}
        )
    assert upserted_id == "acti_call_1"
    assert route == "close_calls"
    up.assert_called_once()


def test_route_activity_call_lifecycle_variants(mock_db):
    """answered/completed/updated all reuse the same call upsert."""
    for action in ("answered", "completed", "updated"):
        with patch(
            "api.close_events.upsert_call_from_payload", return_value="acti_call_x"
        ) as up:
            upserted_id, route = _route_event(
                mock_db, f"activity.call.{action}",
                {"id": "acti_call_x", "lead_id": "lead_1"},
            )
        assert route == "close_calls", f"action={action} routed wrong"
        up.assert_called_once()


def test_route_activity_sms_created(mock_db):
    with patch("api.close_events.upsert_sms_from_payload", return_value="acti_sms_1") as up:
        upserted_id, route = _route_event(
            mock_db, "activity.sms.created", {"id": "acti_sms_1", "lead_id": "lead_1"}
        )
    assert upserted_id == "acti_sms_1"
    assert route == "close_sms"
    up.assert_called_once()


def test_route_activity_lead_status_change(mock_db):
    with patch(
        "api.close_events.upsert_lead_status_change_from_payload",
        return_value="acti_lsc_1",
    ) as up:
        upserted_id, route = _route_event(
            mock_db,
            "activity.lead_status_change.created",
            {"id": "acti_lsc_1", "lead_id": "lead_1",
             "new_status_id": "stat_X"},
        )
    assert upserted_id == "acti_lsc_1"
    assert route == "close_lead_status_changes"
    up.assert_called_once()


def test_route_unknown_event_type_returns_unknown_label(mock_db):
    """Unknown types are audited (caller handles) but not routed.

    Drake's principle: mirror everything Close sends. Unknown event types
    get the webhook_deliveries row written (caller's responsibility) so
    we can decide later what to do — but no upsert dispatched here.
    """
    upserted_id, route = _route_event(
        mock_db, "totally.fake.event", {"id": "x"}
    )
    assert upserted_id is None
    assert route.startswith("unknown:")
    assert "totally.fake.event" in route


def test_route_empty_event_type(mock_db):
    upserted_id, route = _route_event(mock_db, "", {})
    assert upserted_id is None
    assert route.startswith("unknown:")
