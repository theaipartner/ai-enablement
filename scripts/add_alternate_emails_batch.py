"""Add alternate emails to Gregory clients in batch.

Per the M5.4 NPS backfill runbook
(`docs/runbooks/backfill_nps_from_airtable.md` § Failure modes):
when an external system's email (Airtable NPS, master sheet, etc.)
doesn't match Gregory's primary `clients.email`, the canonical fix
is to add the external email to the Gregory client's
`metadata.alternate_emails`. The receiver's resolver, the Fathom
classifier, and the master sheet reconcile all consult
`alternate_emails` after the primary lookup, so a single write
closes the gap for every downstream resolver.

The `MAPPINGS` constant below is the working batch — edit it for
each new wave of mismatches. Idempotent on re-run via case-
insensitive dedup against the existing `alternate_emails` array.

Resolution log (cumulative — entries stay here so re-running this
script remains a documented no-op for already-handled cases):

  - 2026-05-04: Cheston Nguyen + Yeshlin Singh (master sheet
    reconcile A8 surface).
  - 2026-05-04: Luis Malo + Jonathan Duran-Rojas (M5.4 NPS backfill
    404 surface; Jonathan pre-merged via `merge_clients` RPC by
    Drake out-of-band — canonical row is `Jonathan Duran` /
    `j05832952@gmail.com` with `jonathan@luxrevo.com` already
    in alternates from the merge).

The dashboard surfaces `metadata.alternate_emails` read-only by
design (M3.2 followup logged in `docs/archive/historical/known-issues.md`); this script
is the canonical write path until that affordance lands.

Usage:
    .venv/bin/python scripts/add_alternate_emails_batch.py
    .venv/bin/python scripts/add_alternate_emails_batch.py --apply
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from shared.db import get_client  # noqa: E402


# (gregory_primary_email, alternate_to_add, display_name_for_logs)
MAPPINGS: list[tuple[str, str, str]] = [
    ("cheston@395northai.com", "cheston.nguyen@gmail.com", "Cheston Nguyen"),
    ("yeshlin_singh@yahoo.com", "yeshlinp@gmail.com", "Yeshlin Singh"),
    ("luis@malova.io", "lmalo721@yahoo.com", "Luis Malo"),
    (
        "j05832952@gmail.com",
        "wetasspressurewasher04@gmail.com",
        "Jonathan Duran-Rojas",
    ),
]


def _find_client_by_email(db, email: str) -> dict | None:
    """Resolve a Gregory client by primary email (case-insensitive)."""
    resp = (
        db.table("clients")
        .select("id, full_name, email, metadata")
        .ilike("email", email)
        .is_("archived_at", "null")
        .execute()
    )
    rows = resp.data or []
    if not rows:
        return None
    return rows[0]


def _alt_email_collides_with_primary(db, alt_email: str) -> dict | None:
    """If `alt_email` is the primary email of some OTHER active client,
    return that row — the operator should investigate (potential merge
    candidate, not an alternate-email add)."""
    resp = (
        db.table("clients")
        .select("id, full_name, email")
        .ilike("email", alt_email)
        .is_("archived_at", "null")
        .execute()
    )
    rows = resp.data or []
    return rows[0] if rows else None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write changes. Default: dry-run.",
    )
    args = parser.parse_args(argv)

    db = get_client()
    print("=" * 72)
    print(f"Mode: {'APPLY' if args.apply else 'DRY-RUN'}")
    print(f"Mappings: {len(MAPPINGS)}")
    print("=" * 72)

    written = 0
    already_synced = 0
    not_found = 0
    collisions = 0

    for primary_email, alt_email, display_name in MAPPINGS:
        print(f"\n— {display_name}")
        print(f"  Gregory primary: {primary_email}")
        print(f"  alt to add:      {alt_email}")

        client = _find_client_by_email(db, primary_email)
        if client is None:
            print(f"  NOT FOUND in Gregory (primary email {primary_email!r}).")
            not_found += 1
            continue

        # Collision check: does the alt email belong to another active
        # client as a PRIMARY email? Different problem (merge candidate),
        # not an alternate-email add. Surface and skip.
        collision = _alt_email_collides_with_primary(db, alt_email)
        if collision is not None and collision["id"] != client["id"]:
            print(
                f"  WARN: {alt_email!r} is the PRIMARY email of another active "
                f"client ({collision.get('full_name')!r}, id={collision['id']}). "
                "Skipping — this is a merge candidate, not an alternate-email add."
            )
            collisions += 1
            continue

        metadata = dict(client.get("metadata") or {})
        emails = list(metadata.get("alternate_emails") or [])

        # Case-insensitive dedup. The runbook stores lowercase; the
        # alternate ladder consults case-insensitively, but a duplicate
        # entry differing only in case is redundant.
        emails_lower = {e.lower() for e in emails if isinstance(e, str)}
        if alt_email.lower() in emails_lower:
            print("  already synced — alternate_emails contains this value.")
            already_synced += 1
            continue

        emails.append(alt_email)
        metadata["alternate_emails"] = emails

        print(
            f"  before alternate_emails: {client.get('metadata', {}).get('alternate_emails') or []}"
        )
        print(f"  after  alternate_emails: {emails}")

        if not args.apply:
            print("  (dry-run — no write)")
            continue

        db.table("clients").update({"metadata": metadata}).eq(
            "id", client["id"]
        ).execute()
        print("  WROTE.")
        written += 1

    print("\n" + "=" * 72)
    print("Summary:")
    print(f"  written          {written}")
    print(f"  already synced   {already_synced}")
    print(f"  not found        {not_found}")
    print(f"  collisions       {collisions}")
    print("=" * 72)

    return 0


if __name__ == "__main__":
    sys.exit(main())
