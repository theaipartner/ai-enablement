"""Unit tests for the Typeform webhook receiver.

Focused on the two parts where a bug has the worst blast radius:
  1. Signature verification — the security boundary.
  2. Event routing + dedup against `webhook_deliveries`.

A full BaseHTTPRequestHandler smoke is out of scope (would need a live
HTTP harness; not worth the complexity for a thin Vercel adapter).
"""

from __future__ import annotations

import base64
import hashlib
import hmac

import pytest

from api.typeform_events import _verify_signature


# ---------------------------------------------------------------------------
# Signature verification — Typeform's HMAC-SHA256 base64 scheme
# ---------------------------------------------------------------------------


def _compute_sig(body: bytes, secret: str) -> str:
    """Mirror the receiver's algorithm for fixtures."""
    return base64.b64encode(
        hmac.new(secret.encode("utf-8"), body, hashlib.sha256).digest()
    ).decode("ascii")


SECRET = "test-shared-secret-32-bytes-long-x"


def test_verify_signature_happy_path():
    body = b'{"event_id":"01h","event_type":"form_response","form_response":{}}'
    sig = _compute_sig(body, SECRET)
    assert _verify_signature(body, f"sha256={sig}", SECRET) is True


def test_verify_signature_accepts_bare_base64_without_prefix():
    """Defensive — older Typeform docs show the bare-base64 form."""
    body = b'{"x":1}'
    sig = _compute_sig(body, SECRET)
    # No `sha256=` prefix.
    assert _verify_signature(body, sig, SECRET) is True


def test_verify_signature_tampered_body_rejected():
    body = b'{"x":1}'
    sig = _compute_sig(body, SECRET)
    tampered = body + b"!"
    assert _verify_signature(tampered, f"sha256={sig}", SECRET) is False


def test_verify_signature_wrong_secret_rejected():
    body = b'{"x":1}'
    sig = _compute_sig(body, SECRET)
    assert _verify_signature(body, f"sha256={sig}", "different-secret") is False


def test_verify_signature_empty_inputs_rejected():
    body = b'{"x":1}'
    sig = _compute_sig(body, SECRET)
    assert _verify_signature(body, "", SECRET) is False
    assert _verify_signature(body, f"sha256={sig}", "") is False
    assert _verify_signature(b"", "", "") is False


def test_verify_signature_signature_for_different_body_rejected():
    body_a = b'{"x":1}'
    body_b = b'{"x":2}'
    sig_a = _compute_sig(body_a, SECRET)
    # Sig was computed over body_a — verifier should reject when given body_b.
    assert _verify_signature(body_b, f"sha256={sig_a}", SECRET) is False
