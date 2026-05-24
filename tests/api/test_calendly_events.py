"""Unit tests for the Calendly webhook receiver.

Security boundary tests for signature verification + replay window +
synthesized dedup key + event-type routing. Mirrors the shape of
tests/api/test_close_events.py.
"""

from __future__ import annotations

import hashlib
import hmac
import time
from unittest.mock import MagicMock, patch

import pytest

from api.calendly_events import (
    _check_replay_window,
    _parse_signature_header,
    _route_event,
    _sanitize_headers,
    _synthesize_webhook_id,
    _verify_signature,
)


# ---------------------------------------------------------------------------
# Signature parsing + verification — security boundary
# ---------------------------------------------------------------------------


def test_parse_signature_header_happy_path():
    ts, sig = _parse_signature_header("t=1700000000,v1=abcdef")
    assert ts == "1700000000"
    assert sig == "abcdef"


def test_parse_signature_header_with_spaces():
    ts, sig = _parse_signature_header("t=1700000000, v1=abcdef")
    assert ts == "1700000000"
    assert sig == "abcdef"


def test_parse_signature_header_empty_returns_empty_tuple():
    assert _parse_signature_header("") == ("", "")


def test_parse_signature_header_malformed_returns_empty():
    ts, sig = _parse_signature_header("garbage")
    assert ts == "" and sig == ""


def _compute_sig(body: bytes, ts: str, secret: str) -> str:
    """Mirror the receiver's HMAC scheme for fixtures."""
    signed = ts.encode("utf-8") + b"." + body
    return hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()


def test_verify_signature_happy_path():
    body = b'{"event":"invitee.created","payload":{}}'
    ts = "1700000000"
    secret = "calendly-signing-key"
    sig = _compute_sig(body, ts, secret)
    assert _verify_signature(body, ts, sig, secret) is True


def test_verify_signature_tampered_body_rejected():
    body = b'{"event":"invitee.created"}'
    ts = "1700000000"
    secret = "k"
    sig = _compute_sig(body, ts, secret)
    assert _verify_signature(body + b"!", ts, sig, secret) is False


def test_verify_signature_wrong_timestamp_rejected():
    body = b'{"x":1}'
    secret = "k"
    sig = _compute_sig(body, "1700000000", secret)
    assert _verify_signature(body, "1700000001", sig, secret) is False


def test_verify_signature_wrong_secret_rejected():
    body = b'{"x":1}'
    ts = "1700000000"
    sig = _compute_sig(body, ts, "right")
    assert _verify_signature(body, ts, sig, "wrong") is False


def test_verify_signature_empty_inputs_rejected():
    body = b'{"x":1}'
    sig = _compute_sig(body, "1700000000", "k")
    assert _verify_signature(body, "", sig, "k") is False
    assert _verify_signature(body, "1700000000", "", "k") is False
    assert _verify_signature(body, "1700000000", sig, "") is False


# ---------------------------------------------------------------------------
# Replay-window check
# ---------------------------------------------------------------------------


def test_replay_window_now_accepted():
    assert _check_replay_window(str(int(time.time()))) is True


def test_replay_window_inside_accepted():
    assert _check_replay_window(str(int(time.time()) - 240)) is True


def test_replay_window_outside_rejected():
    assert _check_replay_window(str(int(time.time()) - 3600)) is False


def test_replay_window_future_skew_rejected():
    assert _check_replay_window(str(int(time.time()) + 3600)) is False


def test_replay_window_non_numeric_rejected():
    assert _check_replay_window("not-a-number") is False


# ---------------------------------------------------------------------------
# Synthesized webhook_id — dedup key
# ---------------------------------------------------------------------------


def test_synthesize_webhook_id_stable():
    a = _synthesize_webhook_id("1700000000", b'{"x":1}')
    b = _synthesize_webhook_id("1700000000", b'{"x":1}')
    assert a == b


def test_synthesize_webhook_id_differs_by_body():
    a = _synthesize_webhook_id("1700000000", b'{"x":1}')
    b = _synthesize_webhook_id("1700000000", b'{"x":2}')
    assert a != b


def test_synthesize_webhook_id_differs_by_timestamp():
    a = _synthesize_webhook_id("1700000000", b'{"x":1}')
    b = _synthesize_webhook_id("1700000001", b'{"x":1}')
    assert a != b


def test_synthesize_webhook_id_format():
    key = _synthesize_webhook_id("1700000000", b"hello")
    assert key.startswith("calendly:1700000000:")


# ---------------------------------------------------------------------------
# Header sanitization — signature redaction
# ---------------------------------------------------------------------------


def test_sanitize_headers_redacts_signature_v1():
    """Audit row should keep the timestamp but redact the signature
    bytes — never persist the actual signature for forensic safety."""
    fake_headers = {
        "calendly-webhook-signature": "t=1700000000,v1=secretsignaturehex",
        "content-type": "application/json",
    }
    out = _sanitize_headers(_DictAsHeaders(fake_headers))
    assert out["calendly-webhook-signature"].startswith("t=1700000000")
    assert "v1=<REDACTED>" in out["calendly-webhook-signature"]
    assert "secretsignaturehex" not in out["calendly-webhook-signature"]
    assert out["content-type"] == "application/json"


class _DictAsHeaders:
    """Stand-in for BaseHTTPRequestHandler.headers which has a .get()
    that returns None on missing keys (vs dict's default behavior)."""
    def __init__(self, d): self._d = d
    def get(self, key, default=None): return self._d.get(key, default)


# ---------------------------------------------------------------------------
# Event-type routing
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_db():
    return MagicMock()


def test_route_invitee_created_triggers_invitee_and_event_sync(mock_db):
    payload = {
        "uri": "https://api.calendly.com/scheduled_events/ev1/invitees/inv1",
        "event": "https://api.calendly.com/scheduled_events/ev1",
    }
    with patch("api.calendly_events.CalendlyClient.from_env") as mock_factory, \
         patch("api.calendly_events.sync_invitee_and_event") as mock_sync:
        mock_factory.return_value = MagicMock()
        mock_sync.return_value = MagicMock()
        upserted_id, route = _route_event(mock_db, "invitee.created", payload)
    assert route == "invitee+event"
    assert upserted_id == payload["uri"]
    mock_sync.assert_called_once()


def test_route_invitee_canceled_same_path(mock_db):
    payload = {
        "uri": "https://api.calendly.com/scheduled_events/ev1/invitees/inv1",
        "event": "https://api.calendly.com/scheduled_events/ev1",
    }
    with patch("api.calendly_events.CalendlyClient.from_env") as mock_factory, \
         patch("api.calendly_events.sync_invitee_and_event") as mock_sync:
        mock_factory.return_value = MagicMock()
        upserted_id, route = _route_event(mock_db, "invitee.canceled", payload)
    assert route == "invitee+event"
    assert upserted_id == payload["uri"]


def test_route_invitee_no_show_created_upserts_invitee_only(mock_db):
    payload = {
        "uri": "https://api.calendly.com/scheduled_events/ev1/invitees/inv1",
        "event": "https://api.calendly.com/scheduled_events/ev1",
        "no_show": True,
    }
    with patch("api.calendly_events.upsert_invitee_from_payload") as mock_upsert:
        mock_upsert.return_value = payload["uri"]
        upserted_id, route = _route_event(mock_db, "invitee_no_show.created", payload)
    assert route == "invitee (no_show)"
    assert upserted_id == payload["uri"]


def test_route_invitee_no_show_deleted_same_path(mock_db):
    payload = {
        "uri": "https://api.calendly.com/scheduled_events/ev1/invitees/inv1",
        "event": "https://api.calendly.com/scheduled_events/ev1",
        "no_show": False,
    }
    with patch("api.calendly_events.upsert_invitee_from_payload") as mock_upsert:
        mock_upsert.return_value = payload["uri"]
        upserted_id, route = _route_event(mock_db, "invitee_no_show.deleted", payload)
    assert route == "invitee (no_show)"


def test_route_unknown_event_audits_but_no_upsert(mock_db):
    """Drake's principle: mirror everything Calendly sends. Unknown
    events get the audit row written (by caller) but no routing."""
    upserted_id, route = _route_event(mock_db, "totally.fake", {"uri": "x"})
    assert upserted_id is None
    assert route.startswith("unknown:")
    assert "totally.fake" in route


def test_route_empty_event_name(mock_db):
    upserted_id, route = _route_event(mock_db, "", {})
    assert upserted_id is None
    assert route.startswith("unknown:")
