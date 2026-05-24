"""Meta ad-spend ingestion from the Cortana → Google Sheet.

Sheet ID `1XX6MV7dqAsjlWOiwkuKe9d1uWc1qFR4Dt1CfCVfK8d4`, first tab.
Cortana writes one row per day. This module reads the Sheet via the
Google Sheets API v4, derives CTR (the Sheet's source column is broken),
and upserts into `meta_ad_daily` keyed on `day`.

Pattern mirrors `ingestion/close/` + `ingestion/fathom/`: thin
sheets_client + parser + pipeline orchestrator. Same idempotency
contract — re-running is a no-op-equivalent.

Spec: docs/specs/meta-sheet-ingestion.md
"""
