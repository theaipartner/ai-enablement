"""Close CRM ingestion module.

Mirrors Close raw objects (leads, lead-status changes, calls, SMS,
opportunities, custom-field definitions) into Supabase. Idempotent on
Close's stable IDs. Pattern mirrors `ingestion/fathom/`: thin client +
parser + pipeline orchestrator. Backfill via `scripts/backfill_close.py`;
ongoing ingestion via the polling cron (see docs/runbooks/close_ingestion.md).

Spec: docs/specs/close-ingestion-v1.md
"""
