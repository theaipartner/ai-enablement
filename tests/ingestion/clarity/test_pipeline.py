"""Pipeline tests — orchestration + idempotency, no real DB / API.

Uses a tiny in-memory fake of the Supabase client surface
(`db.table(...).upsert(row, on_conflict=...).execute()`) so we can
assert on the upsert call sequence + dedup behavior.

Uses a stub ClarityClient so no real API calls fire.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any

import pytest

from ingestion.clarity.pipeline import sync_clarity_metrics_daily


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


@dataclass
class _FakeResponse:
    data: list[dict[str, Any]] = field(default_factory=list)


class _FakeUpsertChain:
    """Mimics the supabase-py `.upsert(row_or_list, on_conflict=...).execute()`
    chain. Accepts either a single dict OR a list of dicts (batch upsert,
    matching how the real client handles arrays). Stores each natural-key
    row last-wins."""

    def __init__(self, table_name: str, store: dict[tuple, dict]):
        self._table_name = table_name
        self._store = store
        self._rows: list[dict] | None = None
        self._on_conflict: str | None = None

    def upsert(
        self,
        row_or_list,
        *,
        on_conflict: str | None = None,
    ) -> "_FakeUpsertChain":
        if isinstance(row_or_list, list):
            self._rows = list(row_or_list)
        else:
            self._rows = [row_or_list]
        self._on_conflict = on_conflict
        return self

    def execute(self) -> _FakeResponse:
        assert self._rows is not None
        assert self._on_conflict is not None
        cols = [c.strip() for c in self._on_conflict.split(",")]
        written = []
        for row in self._rows:
            key = tuple(row[c] for c in cols)
            self._store[key] = dict(row)
            written.append(row)
        return _FakeResponse(data=written)


class FakeDB:
    """Stand-in for shared.db.get_client()."""

    def __init__(self) -> None:
        self.store: dict[tuple, dict] = {}
        self.upsert_calls: int = 0

    def table(self, name: str) -> _FakeUpsertChain:
        chain = _FakeUpsertChain(name, self.store)
        # Wrap execute to bump the call counter (the test cares about
        # how many UPSERTs were issued, not just the unique-key cardinality).
        original_execute = chain.execute

        def counted_execute():
            self.upsert_calls += 1
            return original_execute()

        chain.execute = counted_execute  # type: ignore[assignment]
        return chain


class StubClarityClient:
    """Stand-in for ingestion.clarity.client.ClarityClient. Returns the
    blocks the test hands it; raises if instructed."""

    def __init__(self, blocks: list[dict] | None = None, *, raise_with=None):
        self._blocks = blocks or []
        self._raise = raise_with
        self.calls: list[int] = []

    def fetch_url_segmented(self, num_of_days: int = 3) -> list[dict]:
        self.calls.append(num_of_days)
        if self._raise is not None:
            raise self._raise
        return self._blocks


SAMPLE_BLOCKS = [
    {"metricName": "Traffic", "information": [
        {"totalSessionCount": "15", "distinctUserCount": "18",
         "Url": "https://go.theaipartner.io/lp?utm=x"},
        {"totalSessionCount": "2", "distinctUserCount": "3",
         "Url": "https://go.theaipartner.io/confirmation?event_id=a"},
        {"totalSessionCount": "0", "distinctUserCount": "2", "Url": None},
    ]},
    {"metricName": "EngagementTime", "information": [
        {"totalTime": "551", "activeTime": "79",
         "Url": "https://go.theaipartner.io/lp?utm=x"},
        {"totalTime": "66", "activeTime": "63",
         "Url": "https://go.theaipartner.io/confirmation?event_id=a"},
    ]},
]


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_sync_happy_path_records_outcome_summary():
    db = FakeDB()
    client = StubClarityClient(blocks=SAMPLE_BLOCKS)

    outcome = sync_clarity_metrics_daily(
        db, client, num_of_days=3, snapshot_date=date(2026, 5, 24),
    )

    assert outcome.snapshot_date == "2026-05-24"
    assert outcome.metric_blocks_seen == 2
    assert outcome.rows_parsed == 5
    assert outcome.rows_upserted == 5
    assert outcome.rows_failed == 0
    assert outcome.errors == []

    # Distinct paths surface for the audit
    assert "/lp" in outcome.distinct_paths
    assert "/confirmation" in outcome.distinct_paths
    assert "__total__" in outcome.distinct_paths

    # Client was called exactly once with num_of_days=3 (no retry storms)
    assert client.calls == [3]


# ---------------------------------------------------------------------------
# Idempotency — re-pulling the same 3 days overwrites cleanly
# ---------------------------------------------------------------------------


def test_re_pull_overwrites_same_keys_no_duplicates():
    db = FakeDB()
    client = StubClarityClient(blocks=SAMPLE_BLOCKS)

    # First pull
    outcome1 = sync_clarity_metrics_daily(
        db, client, snapshot_date=date(2026, 5, 24),
    )
    assert outcome1.rows_upserted == 5
    first_call_count = db.upsert_calls
    keys_after_first = set(db.store.keys())

    # Second pull — same blocks, same snapshot_date, same on_conflict key.
    # Should call upsert ONCE more (batched), and the natural-key set in
    # the store stays identical (no duplicates).
    outcome2 = sync_clarity_metrics_daily(
        db, client, snapshot_date=date(2026, 5, 24),
    )
    assert outcome2.rows_upserted == 5
    assert db.upsert_calls == first_call_count + 1  # ONE batch call per sync
    assert set(db.store.keys()) == keys_after_first
    # Each key has exactly one row (last-write-wins).
    assert len(db.store) == 5


def test_re_pull_with_refined_values_overwrites_with_new_data():
    """Clarity may refine recent-day aggregates between pulls — the
    later pull's values should overwrite the earlier ones."""
    db = FakeDB()

    # First pull: 15 sessions on /lp
    client_v1 = StubClarityClient(blocks=[{
        "metricName": "Traffic",
        "information": [{
            "totalSessionCount": "15",
            "Url": "https://go.theaipartner.io/lp",
        }],
    }])
    sync_clarity_metrics_daily(db, client_v1, snapshot_date=date(2026, 5, 24))

    # Second pull: Clarity refines to 17 sessions (typical day-of restatement)
    client_v2 = StubClarityClient(blocks=[{
        "metricName": "Traffic",
        "information": [{
            "totalSessionCount": "17",
            "Url": "https://go.theaipartner.io/lp",
        }],
    }])
    sync_clarity_metrics_daily(db, client_v2, snapshot_date=date(2026, 5, 24))

    # One row in the store with the LATER value
    assert len(db.store) == 1
    stored = next(iter(db.store.values()))
    assert stored["total_session_count"] == 17


def test_different_snapshot_dates_produce_distinct_rows():
    db = FakeDB()
    client = StubClarityClient(blocks=SAMPLE_BLOCKS)
    sync_clarity_metrics_daily(db, client, snapshot_date=date(2026, 5, 23))
    sync_clarity_metrics_daily(db, client, snapshot_date=date(2026, 5, 24))
    # 5 rows per snapshot, two snapshots = 10 distinct keys
    assert len(db.store) == 10


# ---------------------------------------------------------------------------
# On_conflict target includes all three natural-key columns
# ---------------------------------------------------------------------------


def test_upsert_uses_full_natural_key_for_on_conflict():
    """Reading: the pipeline's `on_conflict='snapshot_date,metric_name,url'`
    must match the migration's PK exactly; if anyone narrows it, the
    idempotency guarantee breaks silently."""
    captured = {}

    class _Capture(FakeDB):
        def table(self, name: str):
            chain = super().table(name)
            original_upsert = chain.upsert

            def capture_upsert(row, *, on_conflict=None):
                captured["on_conflict"] = on_conflict
                return original_upsert(row, on_conflict=on_conflict)

            chain.upsert = capture_upsert  # type: ignore[assignment]
            return chain

    db = _Capture()
    client = StubClarityClient(blocks=[{
        "metricName": "Traffic",
        "information": [{"totalSessionCount": "1", "Url": "https://go/lp"}],
    }])
    sync_clarity_metrics_daily(db, client)

    # Order matters for ON CONFLICT — must match the PK declaration.
    assert captured["on_conflict"] == "snapshot_date,metric_name,url"


# ---------------------------------------------------------------------------
# Error paths
# ---------------------------------------------------------------------------


def test_client_error_records_in_outcome_no_upserts():
    from ingestion.clarity.client import ClarityAPIError
    db = FakeDB()
    client = StubClarityClient(raise_with=ClarityAPIError("rate cap hit"))
    outcome = sync_clarity_metrics_daily(db, client)
    assert outcome.errors and "rate cap hit" in outcome.errors[0]
    assert outcome.rows_upserted == 0
    assert db.upsert_calls == 0


def test_batch_upsert_failure_marks_all_rows_failed():
    """The pipeline batches upserts into a single API call (one PostgREST
    array body), so a transport-level failure fails the whole batch.
    This is the right trade vs per-row: dramatically faster + avoids the
    HTTP/2 ConnectionTerminated issue we hit in production with 191
    sequential per-row calls. If reliability ever needs partial-success
    within a batch, the move is chunked-batches (e.g. 100 per call), not
    back to per-row."""
    blocks = [{
        "metricName": "Traffic",
        "information": [
            {"totalSessionCount": "1", "Url": "https://go/lp"},
            {"totalSessionCount": "2", "Url": "https://go/confirmation"},
            {"totalSessionCount": "3", "Url": "https://go/course-success"},
        ],
    }]

    real_table = FakeDB.table

    class _Flaky(FakeDB):
        def table(self, name):
            chain = real_table(self, name)

            def boom_execute():
                raise RuntimeError("boom")

            chain.execute = boom_execute  # type: ignore[assignment]
            return chain

    db = _Flaky()
    client = StubClarityClient(blocks=blocks)
    outcome = sync_clarity_metrics_daily(db, client)

    assert outcome.rows_parsed == 3
    assert outcome.rows_upserted == 0
    assert outcome.rows_failed == 3
    assert any("boom" in e for e in outcome.errors)
    assert any("batch upsert" in e for e in outcome.errors)


# ---------------------------------------------------------------------------
# Snapshot date default — when caller omits, pipeline uses today UTC
# ---------------------------------------------------------------------------


def test_snapshot_date_defaults_to_today_utc(monkeypatch):
    from ingestion.clarity import pipeline as pipeline_module

    class _FixedDatetime:
        @classmethod
        def now(cls, tz=None):
            from datetime import datetime, timezone
            return datetime(2026, 5, 24, 18, 30, tzinfo=timezone.utc)

    monkeypatch.setattr(pipeline_module, "datetime", _FixedDatetime)
    db = FakeDB()
    client = StubClarityClient(blocks=SAMPLE_BLOCKS)
    outcome = sync_clarity_metrics_daily(db, client)
    assert outcome.snapshot_date == "2026-05-24"
