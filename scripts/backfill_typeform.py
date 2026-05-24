"""Typeform backfill — bulk-mirror all forms + response history.

Spec: docs/specs/typeform-ingestion.md.
Runbook: docs/runbooks/typeform_ingestion.md.

Modes:

    .venv/bin/python scripts/backfill_typeform.py                       # dry-run (lists forms only)
    .venv/bin/python scripts/backfill_typeform.py --smoke               # 1 form, 1 page, real upsert
    .venv/bin/python scripts/backfill_typeform.py --apply               # all forms, full history
    .venv/bin/python scripts/backfill_typeform.py --apply --form <id>   # one form's full history
    .venv/bin/python scripts/backfill_typeform.py --apply --limit 50    # cap responses per form

**Dry-run (default)** — GET /me + list forms only. Zero upserts.

**`--smoke`** — pulls the top form (highest total_items) and upserts
ONE page of responses (default page size). Idempotent; safe to re-run.
Per CLAUDE.md § Operational patterns, run this BEFORE `--apply` to
surface real-API shape bugs against the live DB.

**`--apply`** — bulk backfill. Walks all forms (or `--form <id>`),
cursor-paginates from newest via `before=<oldest_token>` until exhausted,
upserts each response. Drake's hard-stop gate (a) applies — smoke must
pass before bulk runs.

Env vars (loaded from .env.local):
  TYPEFORM_API_KEY            — PAT
  SUPABASE_URL                — db
  SUPABASE_SERVICE_ROLE_KEY   — db
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
from ingestion.typeform.client import TypeformAPIError, TypeformClient  # noqa: E402
from ingestion.typeform.pipeline import (  # noqa: E402
    SyncOutcome,
    sync_all_form_definitions,
    sync_all_responses,
    sync_form_definition,
    sync_responses,
)


def main() -> int:
    p = argparse.ArgumentParser(description="Backfill Typeform forms + responses")
    p.add_argument("--smoke", action="store_true",
                   help="One form, one page, real upsert. Idempotent.")
    p.add_argument("--apply", action="store_true",
                   help="Full backfill. ALL forms, ALL history (or use --form / --limit).")
    p.add_argument("--form", metavar="FORM_ID",
                   help="Restrict --apply / --smoke to one form_id")
    p.add_argument("--limit", type=int, default=None,
                   help="Cap responses processed per form")
    p.add_argument("--since", default=None,
                   help="ISO-8601 cutoff — only process submissions at-or-after this time")
    args = p.parse_args()

    try:
        client = TypeformClient.from_env()
    except RuntimeError as exc:
        print(f"HARD STOP: {exc}", file=sys.stderr)
        return 2

    db = get_client()

    # Always print the inventory — same for every mode.
    print("Pulling form inventory...")
    try:
        forms = list(client.list_forms())
    except TypeformAPIError as e:
        print(f"HARD STOP: list_forms failed: {e}", file=sys.stderr)
        return 2

    print(f"  {len(forms)} forms total")

    if args.smoke:
        return _run_smoke(client, db, forms, target_form=args.form)

    if args.apply:
        return _run_apply(
            client, db, forms,
            target_form=args.form,
            limit_per_form=args.limit,
            since=args.since,
        )

    # Default: dry-run.
    print("\n[dry-run] Forms inventory only — pass --smoke or --apply to act.")
    for form in forms[:20]:
        print(
            f"  [{form.get('id')}] "
            f"last_updated_at={(form.get('last_updated_at') or '')[:19]}  "
            f"{(form.get('title') or '')[:60]!r}"
        )
    if len(forms) > 20:
        print(f"  … {len(forms) - 20} more")
    return 0


def _run_smoke(
    client: TypeformClient,
    db,
    forms: list,
    *,
    target_form: str | None,
) -> int:
    """Pick the highest-volume form (or target_form), upsert its first
    page (default size). Tests the real-API+DB path end-to-end."""
    if target_form:
        candidate_id = target_form
    else:
        # Pick the highest-volume form via one quick total_items probe per form.
        # Keep it tight — at most 6 probes (cheap), and stop early if we find
        # a >100-response form.
        candidate_id = None
        best_total = -1
        for form in forms[:10]:
            fid = form.get("id")
            if not fid:
                continue
            try:
                resp = client.list_responses(fid, page_size=1)
            except TypeformAPIError:
                continue
            total = resp.get("total_items", 0)
            if total > best_total:
                best_total = total
                candidate_id = fid
                if total > 100:
                    break
        if not candidate_id:
            print("HARD STOP: no candidate form found for smoke", file=sys.stderr)
            return 2

    print(f"\n[smoke] form_id={candidate_id} — sync definition + first page of responses")
    outcome = SyncOutcome()
    sync_form_definition(client, db, candidate_id, outcome)
    sync_responses(client, db, candidate_id, limit=10, outcome=outcome)
    _print_outcome(outcome)
    print("\n[smoke] PASS — re-running is idempotent (safe).")
    return 0 if not outcome.errors else 1


def _run_apply(
    client: TypeformClient,
    db,
    forms: list,
    *,
    target_form: str | None,
    limit_per_form: int | None,
    since: str | None,
) -> int:
    print(f"\n[apply] target_form={target_form or 'ALL'} limit_per_form={limit_per_form} since={since}")
    outcome = SyncOutcome()
    if target_form:
        sync_form_definition(client, db, target_form, outcome)
        sync_responses(
            client, db, target_form,
            since=since, limit=limit_per_form, outcome=outcome,
        )
    else:
        print("  syncing all form definitions...")
        sync_all_form_definitions(client, db, outcome)
        print(
            f"  forms_synced={outcome.forms_synced}, "
            f"forms_failed={outcome.forms_failed}"
        )
        print("  syncing all responses...")
        sync_all_responses(
            client, db,
            since=since, limit_per_form=limit_per_form, outcome=outcome,
        )
    _print_outcome(outcome)
    return 0 if not outcome.errors else 1


def _print_outcome(outcome: SyncOutcome) -> None:
    print()
    print(f"  forms_synced:     {outcome.forms_synced}")
    print(f"  forms_failed:     {outcome.forms_failed}")
    print(f"  responses_synced: {outcome.responses_synced}")
    print(f"  responses_failed: {outcome.responses_failed}")
    print(f"  forms_walked:     {outcome.forms_walked}")
    print(f"  errors:           {len(outcome.errors)}")
    for err in outcome.errors[:20]:
        print(f"    - {err}")
    if len(outcome.errors) > 20:
        print(f"    … ({len(outcome.errors) - 20} more)")


if __name__ == "__main__":
    sys.exit(main())
