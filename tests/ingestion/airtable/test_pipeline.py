"""Pipeline tests — orchestration + idempotency + webhook path.

In-memory fake of supabase-py upsert chain + stub AirtableClient.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from ingestion.airtable.pipeline import (
    SyncOutcome,
    sync_all,
    sync_table,
    upsert_changed_records,
)


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


@dataclass
class _FakeResponse:
    data: list[dict[str, Any]] = field(default_factory=list)


class _FakeUpsertChain:
    """Accepts both single-dict upsert and list-of-dicts batch upsert
    (mirrors supabase-py's real surface)."""

    def __init__(self, table_name: str, store: dict[tuple, dict]):
        self._table_name = table_name
        self._store = store
        self._rows: list[dict] | None = None
        self._on_conflict: str | None = None

    def upsert(self, row_or_rows, *, on_conflict: str | None = None):
        if isinstance(row_or_rows, list):
            self._rows = list(row_or_rows)
        else:
            self._rows = [row_or_rows]
        self._on_conflict = on_conflict
        return self

    def execute(self):
        assert self._rows is not None
        assert self._on_conflict is not None
        cols = [c.strip() for c in self._on_conflict.split(",")]
        written = []
        for r in self._rows:
            key = (self._table_name, *(r[c] for c in cols))
            self._store[key] = dict(r)
            written.append(r)
        return _FakeResponse(data=written)


class FakeDB:
    def __init__(self):
        self.store: dict[tuple, dict] = {}
        self.upsert_calls = 0

    def table(self, name: str):
        chain = _FakeUpsertChain(name, self.store)
        original_execute = chain.execute

        def counted():
            self.upsert_calls += 1
            return original_execute()

        chain.execute = counted  # type: ignore[assignment]
        return chain


class StubAirtableClient:
    """Returns the records the test seeds it with, keyed by table id."""

    def __init__(self, records_by_table: dict[str, list[dict]] | None = None):
        self.records_by_table = records_by_table or {}
        self.iter_calls: list[tuple[str, str | None]] = []
        self.get_calls: list[tuple[str, str]] = []

    def iter_records(self, table_id, *, filter_by_formula=None, page_size=100):
        self.iter_calls.append((table_id, filter_by_formula))
        for r in self.records_by_table.get(table_id, []):
            yield r

    def get_record(self, table_id, record_id):
        self.get_calls.append((table_id, record_id))
        for r in self.records_by_table.get(table_id, []):
            if r.get("id") == record_id:
                return r
        # If not seeded, simulate Airtable returning some current state
        return {
            "id": record_id,
            "createdTime": "2026-05-23T00:00:00.000Z",
            "fields": {"_fetched_for_webhook": True},
        }


def _mk_setter_record(rec_id: str, outcome: str = "Show") -> dict:
    return {
        "id": rec_id,
        "createdTime": "2026-05-23T00:00:00.000Z",
        "fields": {
            "Outcome": outcome,
            "Booking Status": "Confirmed Booked with Closer",
            "Lead ID": "<lead>",
            "Setter Name": ["recSetter"],
        },
    }


def _mk_closer_record(rec_id: str, closed: str = "Yes",
                      setter_ids: list[str] | None = None) -> dict:
    fields: dict[str, Any] = {
        "Lead ID": "<lead>",
        "Call Type": "Consultation Call",
        "Date & Time of Call": "2026-05-23T15:00:00.000Z",
        "Showed?": "Yes",
        "Closed?": closed,
        "Deposit?": 2000,
    }
    if setter_ids is not None:
        fields["Setter Name"] = setter_ids
    return {
        "id": rec_id,
        "createdTime": "2026-05-23T00:00:00.000Z",
        "fields": fields,
    }


# ---------------------------------------------------------------------------
# sync_table happy path + idempotency
# ---------------------------------------------------------------------------


def test_sync_table_setter_triage_writes_to_correct_mirror():
    db = FakeDB()
    client = StubAirtableClient(records_by_table={
        "tblaoMsiE3FSkHjQt": [
            _mk_setter_record("recS1"),
            _mk_setter_record("recS2"),
        ],
    })
    outcome = sync_table(client, db, "tblaoMsiE3FSkHjQt")

    assert outcome.records_parsed == 2
    assert outcome.records_upserted == 2
    assert outcome.records_failed == 0

    # Both upserts landed in the setter-triage mirror
    keys = [k for k in db.store.keys() if k[0] == "airtable_setter_triage_calls"]
    assert len(keys) == 2


def test_sync_table_full_closer_us_writes_with_region_us():
    db = FakeDB()
    client = StubAirtableClient(records_by_table={
        "tblYsh3fxTpXuPdIW": [_mk_closer_record("recC1")],
    })
    outcome = sync_table(client, db, "tblYsh3fxTpXuPdIW")

    assert outcome.records_upserted == 1
    keys = list(db.store.keys())
    assert keys[0] == ("airtable_full_closer_report", "recC1")
    stored = db.store[keys[0]]
    assert stored["region"] == "US"


def test_sync_table_full_closer_aus_writes_with_region_aus():
    db = FakeDB()
    client = StubAirtableClient(records_by_table={
        "tblcC25y6lMrtgcty": [_mk_closer_record("recAUS1")],
    })
    sync_table(client, db, "tblcC25y6lMrtgcty")

    stored = db.store[("airtable_full_closer_report", "recAUS1")]
    assert stored["region"] == "AUS"


def test_sync_table_idempotent_re_run_overwrites_no_duplicates():
    db = FakeDB()
    client = StubAirtableClient(records_by_table={
        "tblaoMsiE3FSkHjQt": [_mk_setter_record("recS1", outcome="Show")],
    })

    sync_table(client, db, "tblaoMsiE3FSkHjQt")
    assert len(db.store) == 1
    first_calls = db.upsert_calls

    # Re-run — same record id, last-write-wins.
    client2 = StubAirtableClient(records_by_table={
        "tblaoMsiE3FSkHjQt": [_mk_setter_record("recS1", outcome="No Show")],
    })
    sync_table(client2, db, "tblaoMsiE3FSkHjQt")

    assert len(db.store) == 1  # still one row
    # One batch call per sync_table run = first_calls + 1 total.
    assert db.upsert_calls == first_calls + 1
    stored = db.store[("airtable_setter_triage_calls", "recS1")]
    assert stored["outcome"] == "No Show"   # later value wins


def test_sync_table_uses_batch_upsert_single_call_for_multiple_rows():
    """Multiple rows from one table = ONE batch upsert call (not N).
    This is the HTTP/2 ConnectionTerminated mitigation per Clarity
    precedent. If anyone refactors to per-row, this test will fail."""
    db = FakeDB()
    client = StubAirtableClient(records_by_table={
        "tblaoMsiE3FSkHjQt": [_mk_setter_record(f"recS{i}") for i in range(5)],
    })
    sync_table(client, db, "tblaoMsiE3FSkHjQt")
    # 5 records → exactly 1 batch upsert call
    assert db.upsert_calls == 1
    assert len(db.store) == 5


def test_sync_table_since_filter_translates_to_filter_by_formula():
    db = FakeDB()
    client = StubAirtableClient()
    sync_table(client, db, "tblaoMsiE3FSkHjQt", since="2026-05-23T00:00:00.000Z")

    assert len(client.iter_calls) == 1
    table_id, formula = client.iter_calls[0]
    assert table_id == "tblaoMsiE3FSkHjQt"
    assert formula is not None
    assert "IS_AFTER(CREATED_TIME()" in formula
    assert "2026-05-23T00:00:00.000Z" in formula


def test_sync_table_limit_caps_records_processed():
    db = FakeDB()
    client = StubAirtableClient(records_by_table={
        "tblaoMsiE3FSkHjQt": [_mk_setter_record(f"recS{i}") for i in range(5)],
    })
    outcome = sync_table(client, db, "tblaoMsiE3FSkHjQt", limit=2)
    assert outcome.records_parsed == 2
    assert outcome.records_upserted == 2
    assert len(db.store) == 2


def test_sync_table_unknown_table_id_records_error():
    db = FakeDB()
    client = StubAirtableClient()
    outcome = sync_table(client, db, "tblUNKNOWN")
    assert outcome.records_upserted == 0
    assert any("not in TARGET_TABLES" in e for e in outcome.errors)


# ---------------------------------------------------------------------------
# sync_all walks all 3 target sources
# ---------------------------------------------------------------------------


def test_sync_all_walks_all_three_target_sources():
    db = FakeDB()
    client = StubAirtableClient(records_by_table={
        "tblaoMsiE3FSkHjQt": [_mk_setter_record("recS1")],
        "tblYsh3fxTpXuPdIW": [_mk_closer_record("recC1")],
        "tblcC25y6lMrtgcty": [_mk_closer_record("recAUS1")],
    })
    outcome = sync_all(client, db)

    assert outcome.tables_walked == 4
    assert outcome.records_parsed == 3
    assert outcome.records_upserted == 3
    # 1 setter triage + 2 closer (1 US + 1 AUS) in the closer table
    setter_rows = [k for k in db.store if k[0] == "airtable_setter_triage_calls"]
    closer_rows = [k for k in db.store if k[0] == "airtable_full_closer_report"]
    assert len(setter_rows) == 1
    assert len(closer_rows) == 2


def test_setter_name_fill_rate_observation_counts_full_closer_only():
    """The smoke run wants to observe setter name fill rate on Full
    Closer — counters increment ONLY for closer records."""
    db = FakeDB()
    client = StubAirtableClient(records_by_table={
        "tblaoMsiE3FSkHjQt": [_mk_setter_record("recS1")],  # setter has Setter Name; doesn't count
        "tblYsh3fxTpXuPdIW": [
            _mk_closer_record("recC1", setter_ids=["recSetter"]),       # filled
            _mk_closer_record("recC2", setter_ids=None),                # absent → is_setter_led=None, NOT counted
            _mk_closer_record("recC3", setter_ids=[]),                   # empty list collapses to None
        ],
    })
    outcome = sync_all(client, db)
    assert outcome.full_closer_records_seen == 3
    assert outcome.setter_name_fill_count == 1   # only recC1


# ---------------------------------------------------------------------------
# upsert_changed_records — the webhook path
# ---------------------------------------------------------------------------


def test_upsert_changed_records_fetches_each_record_and_upserts():
    db = FakeDB()
    client = StubAirtableClient(records_by_table={
        "tblYsh3fxTpXuPdIW": [_mk_closer_record("recC1")],
        "tblaoMsiE3FSkHjQt": [_mk_setter_record("recS1")],
    })
    changes = {
        "tblYsh3fxTpXuPdIW": {"recC1"},
        "tblaoMsiE3FSkHjQt": {"recS1"},
    }
    outcome = upsert_changed_records(client, db, changes)

    assert outcome.records_upserted == 2
    assert ("airtable_full_closer_report", "recC1") in db.store
    assert ("airtable_setter_triage_calls", "recS1") in db.store

    # get_record was called once per changed record (NOT iter_records)
    assert ("tblYsh3fxTpXuPdIW", "recC1") in client.get_calls
    assert ("tblaoMsiE3FSkHjQt", "recS1") in client.get_calls
    assert client.iter_calls == []


def test_upsert_changed_records_drops_non_target_tables_with_audit():
    db = FakeDB()
    client = StubAirtableClient(records_by_table={
        "tblYsh3fxTpXuPdIW": [_mk_closer_record("recC1")],
    })
    changes = {
        "tblYsh3fxTpXuPdIW": {"recC1"},
        "tblOTHER123":       {"recOther"},   # not in TARGET_TABLES
    }
    outcome = upsert_changed_records(client, db, changes)

    assert outcome.records_upserted == 1
    # Error mentions the non-target table for audit visibility
    assert any("tblOTHER123" in e for e in outcome.errors)


def test_upsert_changed_records_idempotent_with_sync_table():
    """The webhook path and the sync_table path produce identical rows."""
    # First land via sync_table
    db = FakeDB()
    client = StubAirtableClient(records_by_table={
        "tblYsh3fxTpXuPdIW": [_mk_closer_record("recSAME")],
    })
    sync_table(client, db, "tblYsh3fxTpXuPdIW")
    via_sync = dict(db.store[("airtable_full_closer_report", "recSAME")])

    # Now re-land via the webhook path on a fresh DB; should produce
    # the same row (minus the synced_at/created_at/updated_at columns
    # which the DB defaults populate — we don't set them in the parser).
    db2 = FakeDB()
    upsert_changed_records(
        client, db2, {"tblYsh3fxTpXuPdIW": {"recSAME"}},
    )
    via_webhook = dict(db2.store[("airtable_full_closer_report", "recSAME")])

    assert via_sync == via_webhook
