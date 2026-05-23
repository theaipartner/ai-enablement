"""Close CRM backfill — bulk-mirror lead + activity + opportunity history.

Spec: docs/specs/close-ingestion-v1.md.
Runbook: docs/runbooks/close_ingestion.md.

Three modes:

    .venv/bin/python scripts/backfill_close.py                # dry-run
    .venv/bin/python scripts/backfill_close.py --smoke        # 1 lead end-to-end
    .venv/bin/python scripts/backfill_close.py --apply
    .venv/bin/python scripts/backfill_close.py --apply --limit 50

**Dry-run (default)** — `GET /me/` + first page of `/lead/` + first page of
`/opportunity/` only. Prints what would be done, makes ZERO upserts.

**`--smoke`** — pulls ONE real lead (the first returned from /lead/),
syncs its full data + activities + custom-field definitions, prints
outcome. Idempotent; safe to re-run. Per CLAUDE.md § Operational
patterns, run this BEFORE any bulk `--apply` to surface real-API
shape bugs against the live DB.

**`--apply`** — bulk backfill. Walks every lead (or `--limit N`),
syncs each end-to-end, then syncs all opportunities. Drake's
hard-stop gate (a) applies — smoke must pass and Drake must confirm
before this is invoked at full scope.

Env vars (loaded from .env.local):
  CLOSE_API_KEY                — Close REST API (HTTP Basic, key-as-username)
  SUPABASE_URL                 — db
  SUPABASE_SERVICE_ROLE_KEY    — db
"""

from __future__ import annotations

import argparse
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
    sync_all_leads,
    sync_all_opportunities,
    sync_custom_field_definitions,
    sync_lead,
)


def _print_outcome(label: str, outcome: SyncOutcome) -> None:
    print(f"\n=== {label} ===")
    print(f"  cf_definitions_synced:   {outcome.cf_definitions_synced}")
    print(f"  leads_synced:            {outcome.leads_synced}")
    print(f"  leads_failed:            {outcome.leads_failed}")
    print(f"  status_changes_synced:   {outcome.status_changes_synced}")
    print(f"  calls_synced:            {outcome.calls_synced}")
    print(f"  sms_synced:              {outcome.sms_synced}")
    print(f"  opportunities_synced:    {outcome.opportunities_synced}")
    if outcome.errors:
        print(f"  errors ({len(outcome.errors)}):")
        for e in outcome.errors[:20]:
            print(f"    - {e}")
        if len(outcome.errors) > 20:
            print(f"    ... and {len(outcome.errors) - 20} more")


def dry_run(client: CloseClient) -> int:
    me = client.me()
    print(f"Auth OK. User: {me.get('first_name')} {me.get('last_name')} "
          f"<{me.get('email')}>")
    orgs = me.get("organizations") or []
    for o in orgs:
        print(f"  Org: {o.get('id')}  {o.get('name')}")

    # Sample one page of leads + opportunities for visibility.
    first_page_leads = []
    for lead in client.iter_leads(page_size=10, max_pages=1):
        first_page_leads.append(lead)
        if len(first_page_leads) >= 10:
            break
    print(f"\nFirst 10 leads (sample):")
    for lead in first_page_leads:
        print(f"  {lead.get('id')}  {(lead.get('display_name') or '<?>')[:40]:40}  "
              f"{lead.get('status_label')}")

    first_page_opps = []
    for opp in client.iter_opportunities(page_size=10, max_pages=1):
        first_page_opps.append(opp)
        if len(first_page_opps) >= 10:
            break
    print(f"\nFirst 10 opportunities (sample):")
    for opp in first_page_opps:
        print(f"  {opp.get('id')}  status={opp.get('status_label')}  "
              f"value={opp.get('value')} {opp.get('value_currency')}")

    print("\n[dry-run] Zero upserts performed. Use --smoke or --apply.")
    return 0


def smoke(client: CloseClient, db) -> int:
    """One-lead end-to-end against real Close + real DB."""
    print("Smoke mode: cf defs + 1 lead end-to-end.")
    outcome = SyncOutcome()

    print("\nStep 1/3: sync custom-field definitions")
    cf_id_to_name = sync_custom_field_definitions(client, db, outcome)
    print(f"  cf_id_to_name: {len(cf_id_to_name)} lead-cf names mapped")

    print("\nStep 2/3: pick one lead from /lead/")
    lead_id = None
    for lead in client.iter_leads(page_size=1, max_pages=1):
        lead_id = lead.get("id")
        print(f"  using lead: {lead_id}  '{(lead.get('display_name') or '?')[:40]}'")
        break
    if not lead_id:
        print("  ERROR: no leads returned from /lead/ — cannot smoke")
        _print_outcome("Smoke (FAILED — no leads)", outcome)
        return 2

    print(f"\nStep 3/3: sync_lead({lead_id})")
    sync_lead(client, db, lead_id, cf_id_to_name, outcome=outcome)

    _print_outcome("Smoke outcome", outcome)

    if outcome.leads_failed > 0 or outcome.errors:
        print("\nSMOKE FAILED — do NOT proceed to --apply. Surface errors above.")
        return 3
    print("\nSmoke OK. Re-run with --apply (Drake-gated) for the bulk backfill.")
    return 0


def apply_bulk(client: CloseClient, db, *, max_leads: int | None) -> int:
    """Bulk backfill — Drake-gated (smoke must pass + Drake confirms)."""
    print(f"Bulk backfill: max_leads={max_leads}")

    print("\nStep 1/3: sync custom-field definitions")
    outcome = SyncOutcome()
    cf_id_to_name = sync_custom_field_definitions(client, db, outcome)
    print(f"  cf_id_to_name: {len(cf_id_to_name)} lead-cf names mapped")

    def _progress(n: int, lead_id: str) -> None:
        if n % 25 == 0 or n == 1:
            print(f"  [{n}] synced through lead {lead_id}")

    print("\nStep 2/3: walk all leads + per-lead activities")
    leads_outcome = sync_all_leads(
        client, db, cf_id_to_name,
        max_leads=max_leads,
        progress_callback=_progress,
    )
    # Merge cf-definitions count from step 1 into the leads outcome.
    leads_outcome.cf_definitions_synced += outcome.cf_definitions_synced
    leads_outcome.errors = outcome.errors + leads_outcome.errors

    print("\nStep 3/3: walk all opportunities")
    sync_all_opportunities(client, db, outcome=leads_outcome)

    _print_outcome("Bulk apply outcome", leads_outcome)

    if leads_outcome.errors:
        print(f"\nApply completed WITH {len(leads_outcome.errors)} errors — review above.")
        return 1
    print("\nApply OK.")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Close CRM backfill")
    p.add_argument("--smoke", action="store_true",
                   help="One-lead end-to-end against real DB. Idempotent.")
    p.add_argument("--apply", action="store_true",
                   help="Bulk backfill (Drake-gated; smoke first).")
    p.add_argument("--limit", type=int, default=None,
                   help="Cap leads processed in --apply mode.")
    args = p.parse_args()

    if args.smoke and args.apply:
        print("--smoke and --apply are mutually exclusive.", file=sys.stderr)
        return 2

    try:
        client = CloseClient.from_env()
    except RuntimeError as e:
        print(f"HARD STOP: {e}", file=sys.stderr)
        return 2

    if args.smoke:
        db = get_client()
        return smoke(client, db)
    if args.apply:
        db = get_client()
        return apply_bulk(client, db, max_leads=args.limit)

    return dry_run(client)


if __name__ == "__main__":
    sys.exit(main())
