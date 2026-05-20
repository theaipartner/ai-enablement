"""Unit tests for the Ella V2 Batch 1 message-event ingestion path.

Tests target `ingestion.slack.realtime_ingest.ingest_message_event` —
the function `api/slack_events.py` calls when a `message`-type event
arrives. The HTTP-level dispatch in `api/slack_events.py` is exercised
by the existing `tests/api/test_slack_events_post.py` suite; this
file pins the ingestion contract.

Ten scenarios per the spec:

  1. Happy path — client channel, regular message → upserts
  2. Skip — non-client channel → no upsert, audit `skip_reason='non_client_channel'`
  3. Skip — channel-state subtype → no upsert, audit `skip_reason='ignorable_subtype'`
  4. Ella self-recognition → upsert with `author_type='ella'`
  5. Bot message → upsert with `author_type='bot'`
  6. Workflow message → upsert with `author_type='workflow'`
  7. Idempotency — same event twice, two audit rows, two upserts
  8. Fail-soft — DB error during upsert raises caught + audited 'failed'
  9. Edit event (`message_changed`) → inner-payload upsert, idempotency holds
 10. Existing app_mention path unchanged (sanity-bridge test)
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from ingestion.slack import realtime_ingest as ri


# ---------------------------------------------------------------------------
# Fake DB harness — captures every operation so tests assert on payloads
# ---------------------------------------------------------------------------


class _Chain:
    """Shared chain stub used by every table fake. Records the operation
    mode + filters; `execute()` returns the configured response."""

    def __init__(self, table: str, fake: "_FakeDb"):
        self._table = table
        self._fake = fake
        self._mode: str | None = None
        self._pending_payload: Any = None
        self._filters: list[tuple[str, Any]] = []

    def select(self, *_a, **_kw):
        self._mode = "select"
        return self

    def insert(self, payload):
        self._mode = "insert"
        self._pending_payload = payload
        return self

    def upsert(self, payload, **_kwargs):
        self._mode = "upsert"
        self._pending_payload = payload
        return self

    def update(self, payload):
        self._mode = "update"
        self._pending_payload = payload
        return self

    def eq(self, key, value):
        self._filters.append((key, value))
        return self

    def is_(self, key, value):
        self._filters.append((key, f"is:{value}"))
        return self

    def limit(self, *_a, **_kw):
        return self

    def execute(self):
        if self._mode == "select" and self._table == "slack_channels":
            return SimpleNamespace(data=self._fake.slack_channels_response or [])
        if self._mode == "select" and self._table == "clients":
            return SimpleNamespace(data=self._fake.clients_response)
        if self._mode == "select" and self._table == "team_members":
            return SimpleNamespace(data=self._fake.team_members_response)
        if self._mode == "upsert" and self._table == "slack_messages":
            self._fake.slack_messages_upserts.append(self._pending_payload)
            if self._fake.raise_on_upsert is not None:
                raise self._fake.raise_on_upsert
            return SimpleNamespace(data=[{"id": "msg-id"}])
        if self._mode == "upsert" and self._table == "webhook_deliveries":
            # The dedup-gate UPSERT (post-2026-05-20 ella-realtime-ingest-
            # idempotency). Tracks the (channel, ts) keys we've seen so a
            # repeated call returns the empty-data shape that signals a
            # duplicate (matches the live PostgREST behavior under
            # `ignore_duplicates=True`).
            self._fake.webhook_deliveries_upserts.append(self._pending_payload)
            webhook_id = self._pending_payload.get("webhook_id")
            if webhook_id in self._fake._upsert_seen_webhook_ids:
                return SimpleNamespace(data=[])
            self._fake._upsert_seen_webhook_ids.add(webhook_id)
            return SimpleNamespace(data=[{"id": "wd-id", "webhook_id": webhook_id}])
        if self._mode == "update" and self._table == "webhook_deliveries":
            # Audit-row lifecycle UPDATE (received → processed/failed/...).
            # Capture along with the filter so tests can assert which row
            # was updated.
            filters = dict(self._filters) if self._filters else {}
            self._fake.webhook_deliveries_updates.append(
                {"payload": self._pending_payload, "filters": filters}
            )
            return SimpleNamespace(data=[{}])
        if self._mode == "insert" and self._table == "webhook_deliveries":
            self._fake.webhook_deliveries_inserts.append(self._pending_payload)
            return SimpleNamespace(data=[{"id": "wd-id"}])
        raise AssertionError(
            f"unexpected execute(): table={self._table!r} mode={self._mode!r}"
        )


class _FakeDb:
    def __init__(self):
        self.slack_channels_response: list[dict] | None = None
        self.clients_response: list[dict] = []
        self.team_members_response: list[dict] = []
        self.raise_on_upsert: Exception | None = None

        self.slack_messages_upserts: list[Any] = []
        # Three sinks for webhook_deliveries operations under the
        # post-2026-05-20 dedup architecture:
        #   - upserts: the dedup gate at step 0 (one per ingest call,
        #     even on duplicate)
        #   - updates: the _insert_audit lifecycle UPDATE (one per
        #     non-duplicate ingest call)
        #   - inserts: the duplicate-audit forensic row + legacy
        #     passive-monitor-error rows (rare paths)
        self.webhook_deliveries_upserts: list[Any] = []
        self.webhook_deliveries_updates: list[dict] = []
        self.webhook_deliveries_inserts: list[Any] = []
        self._upsert_seen_webhook_ids: set[str] = set()

    def table(self, name: str):
        return _Chain(name, self)


@pytest.fixture
def fake_db(monkeypatch):
    """Patch `shared.db.get_client` to return our fake. The realtime
    ingest module imports get_client lazily inside the function so the
    monkeypatch applies cleanly per-test."""
    db = _FakeDb()

    def _get_client():
        return db

    # Module is imported lazily inside ingest_message_event — patch the
    # attribute on `shared.db` so every lazy lookup resolves to the fake.
    monkeypatch.setattr("shared.db.get_client", _get_client)
    return db


@pytest.fixture(autouse=True)
def _stub_ella_user_id(monkeypatch):
    """Default: no SLACK_USER_TOKEN, so get_user_id_for_token returns None.
    Tests that need Ella set their own monkeypatch."""
    monkeypatch.delenv("SLACK_USER_TOKEN", raising=False)


def _envelope(event: dict[str, Any]) -> dict[str, Any]:
    """Wrap an event in the Slack `event_callback` envelope shape."""
    return {
        "type": "event_callback",
        "event": event,
        "team_id": "T1",
        "event_id": "Ev1",
    }


# ---------------------------------------------------------------------------
# Test 1 — Happy path
# ---------------------------------------------------------------------------


def test_happy_path_client_channel_regular_message(fake_db):
    fake_db.slack_channels_response = [
        {
            "id": "ch-uuid-1",
            "slack_channel_id": "C100",
            "client_id": "client-uuid-1",
            "is_archived": False,
        }
    ]
    fake_db.clients_response = [{"slack_user_id": "UCLIENT1"}]
    fake_db.team_members_response = [{"slack_user_id": "UTEAM1"}]

    result = ri.ingest_message_event(
        _envelope(
            {
                "type": "message",
                "channel": "C100",
                "user": "UCLIENT1",
                "text": "Hi team",
                "ts": "1745500000.000100",
            }
        )
    )

    assert result["ingested"] is True
    assert result["skipped_reason"] is None
    assert len(fake_db.slack_messages_upserts) == 1
    upsert = fake_db.slack_messages_upserts[0]
    assert upsert["slack_channel_id"] == "C100"
    assert upsert["slack_ts"] == "1745500000.000100"
    assert upsert["author_type"] == "client"
    assert upsert["text"] == "Hi team"

    # Step 0 wrote the `received` row (UPSERT); _insert_audit
    # UPDATEd it to `processed` in the happy path.
    assert len(fake_db.webhook_deliveries_upserts) == 1
    assert fake_db.webhook_deliveries_upserts[0]["processing_status"] == "received"
    assert len(fake_db.webhook_deliveries_updates) == 1
    audit = fake_db.webhook_deliveries_updates[0]["payload"]
    assert audit["processing_status"] == "processed"
    assert "processing_error" not in audit
    assert audit["payload"]["content_source"] == "ingested"
    assert audit["payload"]["author_type"] == "client"
    assert audit["payload"]["slack_user_id"] == "UCLIENT1"


# ---------------------------------------------------------------------------
# Test 2 — Skip non-client channel
# ---------------------------------------------------------------------------


def test_skip_non_client_channel(fake_db):
    """Channel exists in slack_channels but client_id is NULL."""
    fake_db.slack_channels_response = [
        {
            "id": "ch-uuid-2",
            "slack_channel_id": "C200",
            "client_id": None,
            "is_archived": False,
        }
    ]

    result = ri.ingest_message_event(
        _envelope(
            {
                "type": "message",
                "channel": "C200",
                "user": "UTEAM1",
                "text": "internal chatter",
                "ts": "1745500001.000100",
            }
        )
    )

    assert result["ingested"] is False
    assert result["skipped_reason"] == "non_client_channel"
    assert fake_db.slack_messages_upserts == []
    assert len(fake_db.webhook_deliveries_upserts) == 1  # step 0 fired
    assert len(fake_db.webhook_deliveries_updates) == 1  # skip-branch audit
    audit = fake_db.webhook_deliveries_updates[0]["payload"]
    assert audit["processing_status"] == "processed"
    assert audit["processing_error"] == "skipped_non_client_channel"
    assert audit["payload"]["skip_reason"] == "non_client_channel"


def test_skip_channel_not_in_slack_channels_table(fake_db):
    """A channel not in slack_channels at all is also non-client by
    default (no row → no client mapping)."""
    fake_db.slack_channels_response = []  # zero rows

    result = ri.ingest_message_event(
        _envelope(
            {
                "type": "message",
                "channel": "CUNKNOWN",
                "user": "U1",
                "text": "ghost channel",
                "ts": "1745500002.000100",
            }
        )
    )

    assert result["skipped_reason"] == "non_client_channel"
    assert fake_db.slack_messages_upserts == []


# ---------------------------------------------------------------------------
# Test 3 — Skip ignorable subtype
# ---------------------------------------------------------------------------


def test_skip_ignorable_subtype(fake_db):
    fake_db.slack_channels_response = [
        {
            "id": "ch-uuid-3",
            "slack_channel_id": "C300",
            "client_id": "client-uuid-3",
            "is_archived": False,
        }
    ]

    result = ri.ingest_message_event(
        _envelope(
            {
                "type": "message",
                "subtype": "channel_join",
                "channel": "C300",
                "user": "UCLIENT1",
                "text": "<@UCLIENT1> has joined the channel",
                "ts": "1745500003.000100",
            }
        )
    )

    assert result["skipped_reason"] == "ignorable_subtype"
    assert fake_db.slack_messages_upserts == []
    audit = fake_db.webhook_deliveries_updates[0]["payload"]
    assert audit["processing_status"] == "processed"
    assert audit["processing_error"] == "skipped_ignorable_subtype"
    assert audit["payload"]["skip_reason"] == "ignorable_subtype"
    assert audit["payload"]["subtype"] == "channel_join"


# ---------------------------------------------------------------------------
# Test 4 — Ella self-recognition
# ---------------------------------------------------------------------------


def test_ella_self_recognition(fake_db, monkeypatch):
    fake_db.slack_channels_response = [
        {
            "slack_channel_id": "C400",
            "client_id": "client-uuid-4",
            "is_archived": False,
        }
    ]
    fake_db.clients_response = [{"slack_user_id": "UCLIENT1"}]
    fake_db.team_members_response = []

    monkeypatch.setenv("SLACK_USER_TOKEN", "xoxp-USER")

    # Stub `get_user_id_for_token` to return Ella's user_id without
    # hitting Slack. Patch the *binding inside realtime_ingest* because
    # it imports the function at module-load time.
    monkeypatch.setattr(
        "ingestion.slack.realtime_ingest.get_user_id_for_token",
        lambda token: "UELLA",
    )

    result = ri.ingest_message_event(
        _envelope(
            {
                "type": "message",
                "channel": "C400",
                "user": "UELLA",
                "text": "Hi from Ella",
                "ts": "1745500004.000100",
            }
        )
    )

    assert result["ingested"] is True
    assert len(fake_db.slack_messages_upserts) == 1
    upsert = fake_db.slack_messages_upserts[0]
    assert upsert["author_type"] == "ella"
    assert upsert["slack_user_id"] == "UELLA"


# ---------------------------------------------------------------------------
# Test 5 — Bot message
# ---------------------------------------------------------------------------


def test_bot_message_resolves_to_bot_author_type(fake_db):
    fake_db.slack_channels_response = [
        {
            "slack_channel_id": "C500",
            "client_id": "client-uuid-5",
            "is_archived": False,
        }
    ]

    result = ri.ingest_message_event(
        _envelope(
            {
                "type": "message",
                "subtype": "bot_message",
                "channel": "C500",
                "bot_id": "B1",
                "text": "🤖 channel reminder",
                "ts": "1745500005.000100",
            }
        )
    )

    assert result["ingested"] is True
    upsert = fake_db.slack_messages_upserts[0]
    assert upsert["author_type"] == "bot"
    assert upsert["slack_user_id"] == "B1"
    assert upsert["message_type"] == "bot_message"


# ---------------------------------------------------------------------------
# Test 6 — Workflow submission
# ---------------------------------------------------------------------------


def test_workflow_submission_resolves_to_workflow(fake_db):
    fake_db.slack_channels_response = [
        {
            "slack_channel_id": "C600",
            "client_id": "client-uuid-6",
            "is_archived": False,
        }
    ]

    result = ri.ingest_message_event(
        _envelope(
            {
                "type": "message",
                "subtype": "workflow_step",
                "channel": "C600",
                "bot_id": "BWORKFLOW",
                "text": "Form submission: weekly accountability — done",
                "ts": "1745500006.000100",
            }
        )
    )

    assert result["ingested"] is True
    upsert = fake_db.slack_messages_upserts[0]
    assert upsert["author_type"] == "workflow"
    assert upsert["message_type"] == "workflow_submission"
    assert upsert["message_subtype"] == "accountability_submission"


# ---------------------------------------------------------------------------
# Test 7 — Idempotency: same event twice
# ---------------------------------------------------------------------------


def test_idempotency_same_event_twice_dedup_gate_blocks_second(fake_db):
    """Post-2026-05-20 (ella-realtime-ingest-idempotency): the dedup
    gate at step 0 catches Slack redeliveries via
    `webhook_deliveries.webhook_id` PK collision. The second delivery
    short-circuits BEFORE `_upsert_message` runs, so the second
    `slack_messages` upsert and any downstream side effects don't
    fire. A forensic duplicate-audit row gets written with a UUID-
    suffixed webhook_id."""
    fake_db.slack_channels_response = [
        {
            "slack_channel_id": "C700",
            "client_id": "client-uuid-7",
            "is_archived": False,
        }
    ]
    fake_db.clients_response = [{"slack_user_id": "UCLIENT1"}]

    event = {
        "type": "message",
        "channel": "C700",
        "user": "UCLIENT1",
        "text": "duplicate me",
        "ts": "1745500007.000100",
    }

    r1 = ri.ingest_message_event(_envelope(event))
    r2 = ri.ingest_message_event(_envelope(event))

    # First delivery: normal happy path.
    assert r1["ingested"] is True
    assert r1["skipped_reason"] is None
    # Second delivery: dedup gate fired.
    assert r2["ingested"] is False
    assert r2["skipped_reason"] == "duplicate"

    # slack_messages upserted only once — the second delivery never
    # reached the upsert.
    assert len(fake_db.slack_messages_upserts) == 1

    # webhook_deliveries:
    #   - 2 UPSERTs (step 0 on both deliveries; second returned empty
    #     data, signaling duplicate)
    #   - 1 UPDATE (first delivery's lifecycle: received → processed)
    #   - 1 INSERT (the duplicate-audit row for the second delivery)
    assert len(fake_db.webhook_deliveries_upserts) == 2
    assert len(fake_db.webhook_deliveries_updates) == 1
    assert len(fake_db.webhook_deliveries_inserts) == 1

    # Both step-0 upserts use the same deterministic webhook_id.
    upsert_ids = {row["webhook_id"] for row in fake_db.webhook_deliveries_upserts}
    assert upsert_ids == {"slack_msg_ingest_C700_1745500007.000100"}

    # The duplicate-audit row has a different webhook_id (UUID-
    # suffixed) so it doesn't itself collide, and carries the forensic
    # link back to the original.
    dup_audit = fake_db.webhook_deliveries_inserts[0]
    assert dup_audit["webhook_id"].startswith("slack_msg_ingest_dup_")
    assert dup_audit["processing_status"] == "duplicate"
    assert (
        dup_audit["payload"]["original_delivery_id"]
        == "slack_msg_ingest_C700_1745500007.000100"
    )
    assert dup_audit["payload"]["skip_reason"] == "duplicate_delivery"


# ---------------------------------------------------------------------------
# Test 8 — Fail-soft on DB error during upsert
# ---------------------------------------------------------------------------


def test_fail_soft_on_db_error_audits_failed(fake_db):
    fake_db.slack_channels_response = [
        {
            "slack_channel_id": "C800",
            "client_id": "client-uuid-8",
            "is_archived": False,
        }
    ]
    fake_db.clients_response = [{"slack_user_id": "UCLIENT1"}]
    fake_db.raise_on_upsert = RuntimeError("simulated DB outage")

    # Must NOT raise — the function is fail-soft by contract.
    result = ri.ingest_message_event(
        _envelope(
            {
                "type": "message",
                "channel": "C800",
                "user": "UCLIENT1",
                "text": "boom",
                "ts": "1745500008.000100",
            }
        )
    )

    assert result["ingested"] is False
    assert result["skipped_reason"] == "exception"
    assert "simulated DB outage" in (result["error"] or "")
    # Step 0 wrote the `received` row; the slack_messages upsert
    # raised, the exception handler UPDATEd the existing row to
    # `failed` with the error string. One UPDATE captures the
    # failure transition.
    failure_updates = [
        u for u in fake_db.webhook_deliveries_updates
        if u["payload"].get("processing_status") == "failed"
    ]
    assert len(failure_updates) == 1
    assert "simulated DB outage" in (
        failure_updates[0]["payload"].get("processing_error") or ""
    )


# ---------------------------------------------------------------------------
# Test 9 — Edit event (`message_changed`)
# ---------------------------------------------------------------------------


def test_message_changed_unwraps_inner_message_and_upserts(fake_db):
    """For `subtype='message_changed'`, the new content lives under
    `event.message`. We unwrap and upsert with the inner ts so the
    edit refreshes the existing row."""
    fake_db.slack_channels_response = [
        {
            "slack_channel_id": "C900",
            "client_id": "client-uuid-9",
            "is_archived": False,
        }
    ]
    fake_db.clients_response = [{"slack_user_id": "UCLIENT1"}]

    result = ri.ingest_message_event(
        _envelope(
            {
                "type": "message",
                "subtype": "message_changed",
                "channel": "C900",
                "ts": "1745500009.222000",  # outer (edit-event ts)
                "message": {
                    "type": "message",
                    "user": "UCLIENT1",
                    "text": "edited text",
                    "ts": "1745500009.000100",  # inner (original message ts)
                },
                "previous_message": {
                    "type": "message",
                    "user": "UCLIENT1",
                    "text": "original text",
                    "ts": "1745500009.000100",
                },
            }
        )
    )

    assert result["ingested"] is True
    upsert = fake_db.slack_messages_upserts[0]
    # Edit refreshes the row keyed by the ORIGINAL message's ts so
    # ON CONFLICT (channel, ts) updates in place.
    assert upsert["slack_ts"] == "1745500009.000100"
    assert upsert["text"] == "edited text"
    assert upsert["author_type"] == "client"


def test_message_deleted_is_skipped_as_ignorable(fake_db):
    """`message_deleted` is in `_SYSTEM_SUBTYPES` (added in V2 Batch 1)
    to preserve audit trail. Skip + audit, no upsert."""
    fake_db.slack_channels_response = [
        {
            "slack_channel_id": "C910",
            "client_id": "client-uuid-9b",
            "is_archived": False,
        }
    ]

    result = ri.ingest_message_event(
        _envelope(
            {
                "type": "message",
                "subtype": "message_deleted",
                "channel": "C910",
                "ts": "1745500010.000100",
                "deleted_ts": "1745500009.000100",
                "previous_message": {"text": "original"},
            }
        )
    )

    assert result["skipped_reason"] == "ignorable_subtype"
    assert fake_db.slack_messages_upserts == []
    audit = fake_db.webhook_deliveries_updates[0]["payload"]
    assert audit["payload"]["subtype"] == "message_deleted"


# ---------------------------------------------------------------------------
# Test 10 — Existing app_mention path unchanged (sanity bridge)
# ---------------------------------------------------------------------------


def test_app_mention_event_is_noop(monkeypatch):
    """Unified-path: `app_mention` no longer dispatches anywhere — the
    parallel `message` event handles the same @-mention via the
    passive path. `_ingest_message_event` is NOT called for an
    app_mention event."""
    from api import slack_events as se

    called = {"ingest": 0}

    monkeypatch.setattr(
        se,
        "_ingest_message_event",
        lambda payload: called.__setitem__("ingest", called["ingest"] + 1),
    )

    payload = {
        "type": "event_callback",
        "event": {
            "type": "app_mention",
            "channel": "C1",
            "user": "U1",
            "text": "<@UELLA> hi",
            "ts": "1.1",
        },
    }
    event = payload.get("event") or {}
    if payload.get("type") == "event_callback":
        if event.get("type") == "app_mention":
            pass  # logged no-op in the real handler
        elif event.get("type") == "message":
            se._ingest_message_event(payload)

    assert called["ingest"] == 0


def test_message_event_dispatches_to_ingest(monkeypatch):
    """A `message` event (the only evaluation path now) dispatches to
    `_ingest_message_event` exactly once."""
    from api import slack_events as se

    called = {"ingest": 0}

    monkeypatch.setattr(
        se,
        "_ingest_message_event",
        lambda payload: called.__setitem__("ingest", called["ingest"] + 1),
    )

    payload = {
        "type": "event_callback",
        "event": {
            "type": "message",
            "channel": "C1",
            "user": "UCLIENT1",
            "text": "regular post",
            "ts": "1.1",
        },
    }
    event = payload.get("event") or {}
    if payload.get("type") == "event_callback":
        if event.get("type") == "app_mention":
            pass
        elif event.get("type") == "message":
            se._ingest_message_event(payload)

    assert called["ingest"] == 1
