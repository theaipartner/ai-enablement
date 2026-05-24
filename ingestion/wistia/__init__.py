"""Wistia video analytics ingestion.

Mirrors Wistia's media inventory + per-day stats into Supabase. The
source for the Engine sheet's FUNNELS section (VSL/TYP engagement +
view-duration metrics — derived in the aggregation layer, not here).

Pattern mirrors `ingestion/meta/`: thin client + parser + pipeline
orchestrator. All upserts idempotent (`(hashed_id, day)` for the
time-series mirror, `hashed_id` for the reference table).

Spec: docs/specs/wistia-ingestion.md
Discovery: docs/reports/wistia-discovery.md
"""
