"""Pipeline tests — the dedup/guard logic. No network or DB."""

from __future__ import annotations

from ingestion.meta_ads.pipeline import _dedup_entity_rows


def test_dedup_collapses_duplicate_day_key_last_wins():
    rows = [
        {
            "day": "2026-06-15",
            "entity_key": "A|||1",
            "platform_entity_id": "1",
            "spent": 10.0,
        },
        {
            "day": "2026-06-15",
            "entity_key": "A|||1",
            "platform_entity_id": "1",
            "spent": 20.0,
        },
    ]
    out = _dedup_entity_rows(rows)
    assert len(out) == 1
    assert out[0]["spent"] == 20.0


def test_dedup_drops_rows_without_a_real_meta_id():
    rows = [
        {
            "day": "2026-06-15",
            "entity_key": "None|||None",
            "platform_entity_id": None,
            "spent": 5.0,
        },
        {
            "day": "2026-06-15",
            "entity_key": "B|||2",
            "platform_entity_id": "2",
            "spent": 5.0,
        },
    ]
    out = _dedup_entity_rows(rows)
    assert len(out) == 1
    assert out[0]["platform_entity_id"] == "2"


def test_dedup_keeps_distinct_days_and_entities():
    rows = [
        {"day": "2026-06-15", "entity_key": "A|||1", "platform_entity_id": "1"},
        {"day": "2026-06-16", "entity_key": "A|||1", "platform_entity_id": "1"},
        {"day": "2026-06-15", "entity_key": "B|||2", "platform_entity_id": "2"},
    ]
    assert len(_dedup_entity_rows(rows)) == 3
