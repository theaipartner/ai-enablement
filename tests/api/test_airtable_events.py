"""Webhook receiver tests — MAC verify + cursor advance + table routing + fail-soft.

Avoids spinning up the full BaseHTTPRequestHandler; tests the pure
functions directly (MAC verify, cursor load/save, change extraction)
and uses a stub client for the payload-pull loop.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
from typing import Any

import pytest

from api.airtable_events import (
    _cursor_row_key,
    _extract_changes,
    _load_cursor,
    _pull_and_process_payloads,
    _save_cursor,
    _verify_mac,
)


# ---------------------------------------------------------------------------
# MAC verification
# ---------------------------------------------------------------------------


def _sign(body: bytes, secret_b64: str) -> str:
    """Mirror Airtable's actual MAC scheme:
        digest = HMAC-SHA256(raw_body, base64_decode(macSecretBase64))
        header value = HEX(digest)
    See `test_verify_mac_locks_airtable_wire_format` for the
    independent hardcoded-vector regression test that ensures the
    scheme matches Airtable's docs (not just this helper)."""
    secret_bytes = base64.b64decode(secret_b64)
    return hmac.new(secret_bytes, body, hashlib.sha256).hexdigest()


def test_verify_mac_accepts_correct_signature_with_prefix():
    body = b'{"webhook":{"id":"ach1"},"timestamp":"2026-05-24T00:00:00Z"}'
    secret_b64 = base64.b64encode(b"my-mac-secret-bytes").decode("ascii")
    sig = _sign(body, secret_b64)
    assert _verify_mac(body, f"hmac-sha256={sig}", secret_b64) is True


def test_verify_mac_accepts_bare_signature_no_prefix():
    """Defensive — some receivers strip the prefix."""
    body = b'{"webhook":{"id":"ach1"}}'
    secret_b64 = base64.b64encode(b"my-mac-secret-bytes").decode("ascii")
    sig = _sign(body, secret_b64)
    assert _verify_mac(body, sig, secret_b64) is True


def test_verify_mac_rejects_wrong_signature():
    body = b'{"webhook":{"id":"ach1"}}'
    secret_b64 = base64.b64encode(b"my-mac-secret-bytes").decode("ascii")
    assert _verify_mac(body, "hmac-sha256=wrong-sig", secret_b64) is False


def test_verify_mac_rejects_tampered_body():
    body = b'{"webhook":{"id":"ach1"}}'
    secret_b64 = base64.b64encode(b"my-mac-secret-bytes").decode("ascii")
    sig = _sign(body, secret_b64)
    tampered = b'{"webhook":{"id":"achOTHER"}}'
    assert _verify_mac(tampered, f"hmac-sha256={sig}", secret_b64) is False


def test_verify_mac_rejects_wrong_secret():
    body = b'{"webhook":{"id":"ach1"}}'
    real_secret_b64 = base64.b64encode(b"real").decode("ascii")
    wrong_secret_b64 = base64.b64encode(b"wrong").decode("ascii")
    sig = _sign(body, real_secret_b64)
    assert _verify_mac(body, f"hmac-sha256={sig}", wrong_secret_b64) is False


def test_verify_mac_empty_inputs_reject():
    assert _verify_mac(b"", "", "") is False
    assert _verify_mac(b"body", "", "secret") is False
    assert _verify_mac(b"body", "sig", "") is False


def test_verify_mac_rejects_invalid_base64_secret():
    body = b'{"webhook":{"id":"ach1"}}'
    # Not valid base64 → returns False, doesn't crash
    assert _verify_mac(body, "hmac-sha256=any", "not-valid-base64!@#$%") is False


# ---------------------------------------------------------------------------
# Wire-format regression — locks Airtable's actual MAC scheme
# ---------------------------------------------------------------------------
# These tests are deliberately INDEPENDENT of the `_sign` helper above.
# They compute the MAC using std-lib primitives directly per the formula
# Airtable's webhooks-overview docs prescribe, then assert _verify_mac
# accepts it. Catches regressions where someone "tidies up" _verify_mac
# back to base64 — which is what shipped originally and silently 401'd
# every real ping for 24 hours (the airtable-webhook-mac-fix spec).


def test_verify_mac_locks_airtable_wire_format():
    """Independent computation per Airtable's documented scheme:
        digest_bytes = HMAC-SHA256(base64_decode(macSecretBase64), raw_body)
        header_value = "hmac-sha256=" + hex(digest_bytes)  (lowercase)
    """
    # Deterministic synthetic vector — never a real secret/payload.
    key_bytes = b"airtable-test-key-32-bytes-long!"
    secret_b64 = base64.b64encode(key_bytes).decode("ascii")
    body = b'{"webhook":{"id":"achTEST"},"timestamp":"2026-05-24T22:00:00Z"}'

    # Compute exactly as Airtable's reference JS does:
    #   crypto.createHmac('sha256', Buffer.from(macSecretBase64, 'base64'))
    #     .update(body, 'utf8').digest('hex')
    expected_hex = hmac.new(
        key_bytes,  # already-decoded; equivalent to base64.b64decode(secret_b64)
        body,
        hashlib.sha256,
    ).hexdigest()

    # Sanity: a SHA-256 hex digest is exactly 64 lowercase-hex chars.
    assert len(expected_hex) == 64
    assert all(c in "0123456789abcdef" for c in expected_hex)

    # The receiver must accept this format.
    assert _verify_mac(body, f"hmac-sha256={expected_hex}", secret_b64) is True


def test_verify_mac_rejects_legacy_base64_digest_format():
    """The pre-fix implementation base64-encoded the digest. If anyone
    ever regresses, this test catches it: a base64-format MAC over the
    same body+key MUST be rejected."""
    key_bytes = b"airtable-test-key-32-bytes-long!"
    secret_b64 = base64.b64encode(key_bytes).decode("ascii")
    body = b'{"webhook":{"id":"achTEST"}}'

    # The OLD (broken) format: base64-encoded digest
    digest_bytes = hmac.new(key_bytes, body, hashlib.sha256).digest()
    legacy_base64_mac = base64.b64encode(digest_bytes).decode("ascii")

    # The base64 form is NOT what Airtable sends — must reject.
    assert _verify_mac(body, f"hmac-sha256={legacy_base64_mac}", secret_b64) is False


def test_verify_mac_accepts_uppercase_hex_defensively():
    """Airtable sends lowercase hex per `hmac.digest('hex')` semantics,
    but we normalize both sides via .lower() to survive a hypothetical
    case-flip on either side."""
    key_bytes = b"k" * 32
    secret_b64 = base64.b64encode(key_bytes).decode("ascii")
    body = b'{"any":"body"}'

    expected_hex = hmac.new(key_bytes, body, hashlib.sha256).hexdigest()
    assert _verify_mac(body, f"hmac-sha256={expected_hex.upper()}", secret_b64) is True
    assert _verify_mac(body, f"HMAC-SHA256={expected_hex}", secret_b64) is False  # prefix is case-sensitive — only the digest is normalized


# ---------------------------------------------------------------------------
# Change extraction from webhook payload
# ---------------------------------------------------------------------------


def test_extract_changes_picks_up_changed_and_created_records():
    payload = {
        "changedTablesById": {
            "tblYsh3fxTpXuPdIW": {
                "changedRecordsById": {"recC1": {}, "recC2": {}},
                "createdRecordsById": {"recC3": {}},
            },
        },
    }
    changes = _extract_changes(payload)
    assert changes == {"tblYsh3fxTpXuPdIW": {"recC1", "recC2", "recC3"}}


def test_extract_changes_filters_to_target_tables():
    payload = {
        "changedTablesById": {
            "tblYsh3fxTpXuPdIW": {"changedRecordsById": {"recC1": {}}},
            "tblNOT_IN_SCOPE": {"changedRecordsById": {"recX1": {}}},
        },
    }
    changes = _extract_changes(payload)
    assert "tblYsh3fxTpXuPdIW" in changes
    assert "tblNOT_IN_SCOPE" not in changes


def test_extract_changes_handles_empty_payload():
    assert _extract_changes({}) == {}
    assert _extract_changes({"changedTablesById": {}}) == {}


def test_extract_changes_handles_all_three_target_tables():
    payload = {
        "changedTablesById": {
            "tblaoMsiE3FSkHjQt": {"changedRecordsById": {"recS1": {}}},
            "tblYsh3fxTpXuPdIW": {"createdRecordsById": {"recC1": {}}},
            "tblcC25y6lMrtgcty": {"createdRecordsById": {"recA1": {}}},
        },
    }
    changes = _extract_changes(payload)
    assert set(changes.keys()) == {
        "tblaoMsiE3FSkHjQt", "tblYsh3fxTpXuPdIW", "tblcC25y6lMrtgcty",
    }


# ---------------------------------------------------------------------------
# Cursor persistence
# ---------------------------------------------------------------------------


class _CursorFakeDB:
    def __init__(self, seeded_cursor: int | None = None):
        self.seeded_cursor = seeded_cursor
        self.last_upsert: dict[str, Any] | None = None

    def table(self, name):
        return _CursorFakeChain(self)


class _CursorFakeChain:
    def __init__(self, db: _CursorFakeDB):
        self.db = db
        self._eq_key = None

    def select(self, *cols):
        return self

    def eq(self, col, val):
        self._eq_key = val
        return self

    def limit(self, n):
        return self

    def upsert(self, row, *, on_conflict=None):
        self.db.last_upsert = dict(row)
        self._eq_key = row.get("webhook_id")
        return self

    def execute(self):
        if self.db.last_upsert is not None and self._eq_key == self.db.last_upsert.get("webhook_id"):
            # An upsert just landed — return the new row on select
            payload = self.db.last_upsert.get("payload") or {}
            return _CursorFakeResp([{"payload": payload}])
        if self.db.seeded_cursor is not None:
            return _CursorFakeResp([{"payload": {"cursor": self.db.seeded_cursor}}])
        return _CursorFakeResp([])


class _CursorFakeResp:
    def __init__(self, data):
        self.data = data


def test_load_cursor_returns_one_when_no_row():
    db = _CursorFakeDB(seeded_cursor=None)
    assert _load_cursor(db, "ach1") == 1


def test_load_cursor_returns_stored_value():
    db = _CursorFakeDB(seeded_cursor=42)
    assert _load_cursor(db, "ach1") == 42


def test_load_cursor_defends_against_bad_value():
    """Stored cursor is non-int or negative → fall back to 1."""
    db = _CursorFakeDB(seeded_cursor=-5)
    assert _load_cursor(db, "ach1") == 1


def test_save_cursor_writes_payload_with_cursor_int():
    db = _CursorFakeDB()
    _save_cursor(db, "ach1", 99)
    assert db.last_upsert is not None
    assert db.last_upsert["webhook_id"] == _cursor_row_key("ach1")
    assert db.last_upsert["source"] == "airtable_webhook_cursor"
    assert db.last_upsert["payload"]["cursor"] == 99


def test_cursor_row_key_format():
    assert _cursor_row_key("ach123") == "airtable_webhook_cursor:ach123"


# ---------------------------------------------------------------------------
# _pull_and_process_payloads — the loop
# ---------------------------------------------------------------------------


class _PullStubClient:
    """Returns a scripted sequence of payload responses + serves
    get_record from a small fixture."""

    def __init__(self, payload_responses, records=None):
        self.payload_responses = list(payload_responses)
        self.records = records or {}
        self.get_payloads_calls = []
        self.get_record_calls = []

    def get_webhook_payloads(self, webhook_id, *, cursor=None, limit=None):
        self.get_payloads_calls.append((webhook_id, cursor))
        if not self.payload_responses:
            return {"payloads": [], "cursor": cursor or 1, "mightHaveMore": False}
        return self.payload_responses.pop(0)

    def get_record(self, table_id, record_id):
        self.get_record_calls.append((table_id, record_id))
        for r in self.records.get(table_id, []):
            if r.get("id") == record_id:
                return r
        return {
            "id": record_id,
            "createdTime": "2026-05-23T00:00:00.000Z",
            "fields": {},
        }


def test_pull_loop_advances_cursor_through_pagination():
    """`mightHaveMore=True` → another get_webhook_payloads call with
    the response cursor. Loop exits when mightHaveMore=False."""
    db = _CursorFakeDB(seeded_cursor=1)
    client = _PullStubClient(
        payload_responses=[
            {
                "payloads": [
                    {"changedTablesById": {"tblYsh3fxTpXuPdIW": {"createdRecordsById": {"recA": {}}}}},
                ],
                "cursor": 5,
                "mightHaveMore": True,
            },
            {
                "payloads": [
                    {"changedTablesById": {"tblYsh3fxTpXuPdIW": {"createdRecordsById": {"recB": {}}}}},
                ],
                "cursor": 8,
                "mightHaveMore": False,
            },
        ],
        records={
            "tblYsh3fxTpXuPdIW": [
                {"id": "recA", "createdTime": "2026-05-23T00:00:00.000Z", "fields": {"Closed?": "Yes"}},
                {"id": "recB", "createdTime": "2026-05-23T00:00:00.000Z", "fields": {"Closed?": "No"}},
            ],
        },
    )
    # Need a DB that responds to upserts from pipeline.upsert_changed_records;
    # piggyback our cursor fake by returning a richer fake. Easiest: use
    # the FakeDB from test_pipeline-style for the per-record upserts,
    # but cursor-track separately. Here we just confirm the cursor saves.

    # For this test we only care about pagination + cursor advance;
    # the records-upsert path is exercised in test_pipeline.
    from tests.ingestion.airtable.test_pipeline import FakeDB
    full_db = FakeDB()
    # Splice cursor-load into full_db: not stored, so _load_cursor
    # returns 1 (no row). After process, _save_cursor writes the
    # cursor sentinel — we read it back from full_db.store.

    outcome, new_cursor, payload_count = _pull_and_process_payloads(
        client, full_db, "ach1",
    )

    assert payload_count == 2
    assert new_cursor == 8
    assert outcome.records_upserted == 2

    # Two GET /payloads calls — first at cursor=1, second at cursor=5
    assert client.get_payloads_calls == [("ach1", 1), ("ach1", 5)]


def test_pull_loop_empty_payloads_no_records_upserted():
    """No payloads → no records, cursor unchanged."""
    client = _PullStubClient(payload_responses=[
        {"payloads": [], "cursor": 1, "mightHaveMore": False},
    ])
    from tests.ingestion.airtable.test_pipeline import FakeDB
    db = FakeDB()
    outcome, cursor, count = _pull_and_process_payloads(client, db, "ach1")
    assert count == 0
    assert outcome.records_upserted == 0
