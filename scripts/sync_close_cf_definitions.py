"""Refresh the `close_custom_field_definitions` mirror table from Close.

Quick ad-hoc helper for the spec's "keep custom-field-definitions fresh"
goal. Run whenever a Close admin adds or renames a custom field — the
webhook receiver reads cf_id → name from this table to project
denormalized typed columns on `close_leads`. Until refreshed, a new cf
lands in `custom_fields_raw` jsonb only (graceful degradation; no row
loss, just no typed-column projection).

Wrap into a daily cron later if drift becomes a real ops problem; for
V1 manual re-run is fine since cf creation in Close is rare.

Usage:
    .venv/bin/python scripts/sync_close_cf_definitions.py

Env vars (loaded from .env.local):
  CLOSE_API_KEY                — Close REST API
  SUPABASE_URL                 — db
  SUPABASE_SERVICE_ROLE_KEY    — db
"""

from __future__ import annotations

import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(_REPO / ".env.local")

from shared.db import get_client  # noqa: E402
from ingestion.close.client import CloseClient  # noqa: E402
from ingestion.close.pipeline import (  # noqa: E402
    SyncOutcome,
    sync_custom_field_definitions,
)


def main() -> int:
    client = CloseClient.from_env()
    db = get_client()
    outcome = SyncOutcome()
    cf_id_to_name = sync_custom_field_definitions(client, db, outcome)
    print(f"Synced {outcome.cf_definitions_synced} custom-field definitions")
    print(f"Lead-scoped cf-name map: {len(cf_id_to_name)} entries")
    if outcome.errors:
        print(f"Errors ({len(outcome.errors)}):")
        for e in outcome.errors:
            print(f"  - {e}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
