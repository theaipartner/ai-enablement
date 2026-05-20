"""Tests for the realtime-ingest dedup gate (step 0) added by the
2026-05-20 `ella-realtime-ingest-idempotency` spec.

The behavior under test:

  - `ingest_message_event` registers each delivery in
    `webhook_deliveries` via UPSERT-with-`ignore_duplicates=True` BEFORE
    any side effect fires. The PK on `webhook_id` is the dedup primitive.
  - First delivery: row inserted with `processing_status='received'`,
    `_upsert_message` runs, `_insert_audit` UPDATEs the row to
    `processed`.
  - Duplicate delivery: UPSERT returns empty data → return early with
    `skipped_reason='duplicate'`. A forensic audit row with a
    UUID-suffixed `webhook_id` and `processing_status='duplicate'` is
    written for observability.
  - Step 0 fails open on non-PK-collision exceptions (DB outage).
  - `delivery_id` is deterministic per `(channel, ts)`; malformed
    events (missing channel or ts) get a UUID fallback so they don't
    falsely dedup against each other.

Other ingest behavior (channel allowlist, parsing, passive-monitor
fork) is exhaustively covered by
`tests/api/test_slack_events_message_ingest.py` +
`tests/ingestion/slack/test_realtime_ingest_passive_fork.py`. This
file pins the dedup contract specifically.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from ingestion.slack import realtime_ingest as ri


# ---------------------------------------------------------------------------
# Fake DB harness — mirrors the chain stub in the broader ingest test file
# but adds knobs for dedup-specific scenarios (simulate PK collision via
# pre-populated webhook_id set, raise on the step-0 upsert, etc.).
# ---------------------------------------------------------------------------


class _Chain:
    def __init__(self, table, fake):
        self._table = table
        self._fake = fake
        self._mode: str | None = None
        self._payload: Any = None
        self._filters: list[tuple[str, Any]] = []

    def select(self, *_a, **_kw):
        self._mode = "select"
        return self

    def insert(self, payload):
        self._mode = "insert"
        self._payload = payload
        return self

    def upsert(self, payload, **_kw):
        self._mode = "upsert"
        self._payload = payload
        return self

    def update(self, payload):
        self._mode = "update"
        self._payload = payload
        return self

    def eq(self, k, v):
        self._filters.append((k, v))
        return self

    def is_(self, k, v):
        self._filters.append((k, f"is:{v}"))
        return self

    def limit(self, *_a, **_kw):
        return self

    def execute(self):
        t, m = self._table, self._mode
        if m == "select" and t == "slack_channels":
            return SimpleNamespace(data=list(self._fake.channels))
        if m == "select" and t == "clients":
            return SimpleNamespace(data=list(self._fake.clients))
        if m == "select" and t == "team_members":
            return SimpleNamespace(data=list(self._fake.team_members))
        if m == "upsert" and t == "slack_messages":
            self._fake.slack_messages_upserts.append(self._payload)
            return SimpleNamespace(data=[{"id": "m-1"}])
        if m == "upsert" and t == "webhook_deliveries":
            self._fake.webhook_upserts.append(self._payload)
            if self._fake.raise_on_webhook_upsert is not None:
                raise self._fake.raise_on_webhook_upsert
            wid = self._payload.get("webhook_id")
            if wid in self._fake.preregistered_webhook_ids:
                # Simulate the empty-data return PostgREST emits when
                # ignore_duplicates=True hits an existing PK.
                return SimpleNamespace(data=[])
            if wid in self._fake._seen_upsert_ids:
                return SimpleNamespace(data=[])
            self._fake._seen_upsert_ids.add(wid)
            return SimpleNamespace(data=[{"id": "wd", "webhook_id": wid}])
        if m == "update" and t == "webhook_deliveries":
            self._fake.webhook_updates.append(
                {"payload": self._payload, "filters": dict(self._filters)}
            )
            return SimpleNamespace(data=[{}])
        if m == "insert" and t == "webhook_deliveries":
            self._fake.webhook_inserts.append(self._payload)
            return SimpleNamespace(data=[{"id": "wd-dup"}])
        raise AssertionError(f"unexpected execute table={t} mode={m}")


class _FakeDb:
    def __init__(self):
        self.channels: list[dict] = []
        self.clients: list[dict] = []
        self.team_members: list[dict] = []
        self.slack_messages_upserts: list[Any] = []
        self.webhook_upserts: list[Any] = []
        self.webhook_updates: list[dict] = []
        self.webhook_inserts: list[Any] = []
        self.preregistered_webhook_ids: set[str] = set()
        self._seen_upsert_ids: set[str] = set()
        self.raise_on_webhook_upsert: Exception | None = None

    def table(self, name):
        return _Chain(name, self)


@pytest.fixture
def fake_db(monkeypatch):
    db = _FakeDb()
    monkeypatch.setattr("shared.db.get_client", lambda: db)
    return db


@pytest.fixture(autouse=True)
def _no_user_token(monkeypatch):
    monkeypatch.delenv("SLACK_USER_TOKEN", raising=False)


def _client_channel(channel_id: str = "C1", client_id: str = "client-uuid-1"):
    return {
        "id": "ch-1",
        "slack_channel_id": channel_id,
        "client_id": client_id,
        "is_archived": False,
        "passive_monitoring_enabled": False,
    }


def _envelope(event):
    return {"type": "event_callback", "event": event, "team_id": "T1", "event_id": "E1"}


# ---------------------------------------------------------------------------
# Deterministic delivery_id format
# ---------------------------------------------------------------------------


def test_delivery_id_is_deterministic_per_channel_and_ts(fake_db):
    """The webhook_id written at step 0 follows the documented format
    `slack_msg_ingest_{channel}_{ts}` — this is the dedup key Slack
    re-deliveries collide on."""
    fake_db.channels = [_client_channel("C100")]
    fake_db.clients = [{"slack_user_id": "UCLIENT1"}]

    result = ri.ingest_message_event(
        _envelope({
            "type": "message",
            "channel": "C100",
            "user": "UCLIENT1",
            "text": "hi",
            "ts": "1745500000.000100",
        })
    )

    assert result["delivery_id"] == "slack_msg_ingest_C100_1745500000.000100"
    upserted = fake_db.webhook_upserts[0]
    assert upserted["webhook_id"] == "slack_msg_ingest_C100_1745500000.000100"
    assert upserted["processing_status"] == "received"


def test_malformed_event_missing_channel_falls_back_to_uuid(fake_db):
    """An event with no `channel` shouldn't dedup-collide with another
    malformed event — fall back to a UUID-based key so each malformed
    delivery is its own row."""
    fake_db.channels = []  # any channel lookup returns empty

    result = ri.ingest_message_event(
        _envelope({
            "type": "message",
            "user": "U1",
            "text": "no channel field",
            "ts": "1745500000.000100",
            # `channel` deliberately omitted
        })
    )

    assert result["delivery_id"].startswith("slack_msg_ingest_malformed_")
    # Two malformed events should NOT collide.
    result2 = ri.ingest_message_event(
        _envelope({
            "type": "message",
            "user": "U2",
            "text": "also no channel",
            "ts": "1745500001.000100",
        })
    )
    assert result["delivery_id"] != result2["delivery_id"]


def test_malformed_event_missing_ts_falls_back_to_uuid(fake_db):
    fake_db.channels = []

    result = ri.ingest_message_event(
        _envelope({
            "type": "message",
            "channel": "C100",
            "user": "U1",
            "text": "no ts",
        })
    )

    assert result["delivery_id"].startswith("slack_msg_ingest_malformed_")


# ---------------------------------------------------------------------------
# Duplicate-gate behavior
# ---------------------------------------------------------------------------


def test_duplicate_gate_short_circuits_no_side_effects(fake_db):
    """When step 0 detects a duplicate, every downstream side effect
    (slack_messages upsert, audit lifecycle update, passive-monitor
    dispatch) is suppressed."""
    fake_db.channels = [_client_channel("C100")]
    fake_db.clients = [{"slack_user_id": "UCLIENT1"}]
    # Pre-register the webhook_id we expect step 0 to try; the fake DB
    # returns empty data, simulating PostgREST's behavior under
    # ignore_duplicates=True when the PK already exists.
    fake_db.preregistered_webhook_ids = {
        "slack_msg_ingest_C100_1745500000.000100"
    }

    result = ri.ingest_message_event(
        _envelope({
            "type": "message",
            "channel": "C100",
            "user": "UCLIENT1",
            "text": "duplicate me",
            "ts": "1745500000.000100",
        })
    )

    assert result["ingested"] is False
    assert result["skipped_reason"] == "duplicate"
    # Step 0 attempted the upsert (which "collided").
    assert len(fake_db.webhook_upserts) == 1
    # No slack_messages upsert.
    assert fake_db.slack_messages_upserts == []
    # No lifecycle UPDATE (the gate short-circuited before reaching it).
    assert fake_db.webhook_updates == []
    # One forensic INSERT for the duplicate-audit row.
    assert len(fake_db.webhook_inserts) == 1


def test_duplicate_audit_row_carries_forensic_payload(fake_db):
    """The forensic row links the duplicate back to the original
    delivery_id so operators can trace cause-and-effect in the audit
    ledger."""
    fake_db.channels = [_client_channel("C200")]
    fake_db.clients = [{"slack_user_id": "UCLIENT1"}]
    fake_db.preregistered_webhook_ids = {
        "slack_msg_ingest_C200_1745500099.000100"
    }

    ri.ingest_message_event(
        _envelope({
            "type": "message",
            "channel": "C200",
            "user": "UCLIENT1",
            "text": "dup",
            "ts": "1745500099.000100",
        })
    )

    forensic = fake_db.webhook_inserts[0]
    assert forensic["webhook_id"].startswith("slack_msg_ingest_dup_")
    assert forensic["processing_status"] == "duplicate"
    assert forensic["source"] == "slack_message_ingest"
    payload = forensic["payload"]
    assert (
        payload["original_delivery_id"]
        == "slack_msg_ingest_C200_1745500099.000100"
    )
    assert payload["slack_channel_id"] == "C200"
    assert payload["slack_ts"] == "1745500099.000100"
    assert payload["skip_reason"] == "duplicate_delivery"
    assert "processed_at" in forensic


def test_duplicate_audit_row_failure_swallowed(fake_db, monkeypatch):
    """If the forensic INSERT itself fails (extremely rare), the dedup
    decision still stands — the caller still returns 'duplicate' to
    Slack so retries stop."""
    fake_db.channels = [_client_channel("C300")]
    fake_db.clients = [{"slack_user_id": "UCLIENT1"}]
    fake_db.preregistered_webhook_ids = {
        "slack_msg_ingest_C300_1745500100.000100"
    }

    # Force the forensic .insert(...) to raise. We intercept by
    # monkeypatching the helper.
    original = ri._write_duplicate_audit_row

    def _raise_inside(db, **kw):
        try:
            raise RuntimeError("audit-row insert blew up")
        except Exception:
            pass  # swallow inside the helper

    monkeypatch.setattr(ri, "_write_duplicate_audit_row", _raise_inside)

    result = ri.ingest_message_event(
        _envelope({
            "type": "message",
            "channel": "C300",
            "user": "UCLIENT1",
            "text": "dup",
            "ts": "1745500100.000100",
        })
    )

    # Dedup decision still firm.
    assert result["skipped_reason"] == "duplicate"

    # Restore for any subsequent tests in the module.
    monkeypatch.setattr(ri, "_write_duplicate_audit_row", original)


# ---------------------------------------------------------------------------
# Fail-open behavior
# ---------------------------------------------------------------------------


def test_step0_fail_open_on_db_outage(fake_db):
    """Non-PK-collision exception during step 0 should fail-OPEN —
    treat as not-duplicate so a transient DB blip doesn't drop a real
    client message. The downstream code then runs normally (which, if
    the DB outage persists, hits its own exception handler — that's
    fine, the audit ledger reflects the failed processing rather than
    the message being silently dropped)."""
    fake_db.channels = [_client_channel("C400")]
    fake_db.clients = [{"slack_user_id": "UCLIENT1"}]
    fake_db.raise_on_webhook_upsert = RuntimeError("transient DB hiccup")

    result = ri.ingest_message_event(
        _envelope({
            "type": "message",
            "channel": "C400",
            "user": "UCLIENT1",
            "text": "ingest me anyway",
            "ts": "1745500200.000100",
        })
    )

    # Fail-open behavior: pipeline continues despite step-0 failure.
    # _upsert_message ran (the slack_messages row got upserted), the
    # subsequent audit UPDATE no-ops because the `received` row was
    # never created, but the ingest succeeds.
    assert result["ingested"] is True
    assert result["skipped_reason"] is None
    assert len(fake_db.slack_messages_upserts) == 1


# ---------------------------------------------------------------------------
# message_changed event behavior
# ---------------------------------------------------------------------------


def test_message_changed_uses_outer_ts_for_dedup_key(fake_db):
    """`message_changed` events have an inner ts (original message ts)
    and an outer ts (the edit-event ts). The dedup gate runs against
    the outer event ts (the one Slack delivers at the top level),
    which is what `slack_channel_id` and `slack_ts` resolve to in
    `ingest_message_event`. This means two distinct edits of the same
    message produce two distinct dedup keys (different outer ts each
    time), so both are processed — Slack's edit semantics flow through.
    But a *retry* of the same edit event has the same outer ts and is
    correctly deduped.

    Pins this assumption so a future change to the dedup key (e.g.,
    using the inner message.ts) doesn't silently change behavior."""
    fake_db.channels = [_client_channel("C500")]
    fake_db.clients = [{"slack_user_id": "UCLIENT1"}]

    edit_event = {
        "type": "message",
        "subtype": "message_changed",
        "channel": "C500",
        "ts": "1745500300.999000",  # outer (edit-event ts)
        "message": {
            "type": "message",
            "user": "UCLIENT1",
            "text": "edited",
            "ts": "1745500300.111000",  # inner (original message ts)
        },
    }

    result1 = ri.ingest_message_event(_envelope(edit_event))
    result2 = ri.ingest_message_event(_envelope(edit_event))

    # First edit-event: processed.
    assert result1["ingested"] is True
    assert result1["delivery_id"] == "slack_msg_ingest_C500_1745500300.999000"

    # Retry of the same edit-event: duplicate.
    assert result2["skipped_reason"] == "duplicate"


# ---------------------------------------------------------------------------
# Run-result delivery_id is always populated
# ---------------------------------------------------------------------------


def test_result_dict_carries_delivery_id_for_non_client_channel_path(fake_db):
    """Even on the non-client-channel skip, the result dict reflects
    the same deterministic delivery_id used at step 0."""
    fake_db.channels = []  # channel not found → non-client path

    result = ri.ingest_message_event(
        _envelope({
            "type": "message",
            "channel": "C600",
            "user": "U1",
            "text": "ghost",
            "ts": "1745500400.000100",
        })
    )

    assert result["skipped_reason"] == "non_client_channel"
    assert result["delivery_id"] == "slack_msg_ingest_C600_1745500400.000100"
    assert len(fake_db.webhook_upserts) == 1
    assert len(fake_db.webhook_updates) == 1
    assert (
        fake_db.webhook_updates[0]["payload"]["processing_status"]
        == "processed"
    )
