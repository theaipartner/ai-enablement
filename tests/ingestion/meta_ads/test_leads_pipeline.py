"""leads_pipeline: dedup + campaign-row derivation (pure functions)."""

from ingestion.meta_ads.leads_pipeline import _dedup_by


def test_dedup_by_collapses_duplicate_keys_last_wins():
    rows = [
        {"lead_id": "1", "full_name": "First"},
        {"lead_id": "2", "full_name": "Other"},
        {"lead_id": "1", "full_name": "Refetched"},
    ]
    out = _dedup_by(rows, "lead_id")
    assert len(out) == 2
    assert {r["lead_id"]: r["full_name"] for r in out}["1"] == "Refetched"


def test_dedup_by_drops_rows_missing_the_key():
    rows = [{"campaign_id": "c1"}, {"campaign_id": None}, {}]
    assert _dedup_by(rows, "campaign_id") == [{"campaign_id": "c1"}]
