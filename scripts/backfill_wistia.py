"""Wistia full-history backfill — bulk-mirror media inventory + per-day stats.

Spec: docs/specs/wistia-ingestion.md.
Runbook: docs/runbooks/wistia_ingestion.md.

Three modes per CLAUDE.md § Operational patterns:

    .venv/bin/python scripts/backfill_wistia.py             # dry-run
    .venv/bin/python scripts/backfill_wistia.py --smoke     # 1 media end-to-end
    .venv/bin/python scripts/backfill_wistia.py --apply
    .venv/bin/python scripts/backfill_wistia.py --apply --limit 10

**Dry-run** (default) — auth check + a peek at inventory + 1 sample
by_date call against ONE media to confirm shape. ZERO upserts.

**`--smoke`** — full inventory upsert + per-day stats for ONE media
over the wide window. Idempotent; safe to re-run. Required before any
bulk `--apply` per the working norm.

**`--apply [--limit N]`** — full inventory + per-day stats for every
media (or first N) over the wide window. Drake-gated for the first
invocation at full scope. Volume: 80 medias × ~500 days max = ~40k
rows; quick run.

Env vars (loaded from .env.local):
  WISTIA_API_TOKEN             — Wistia Data + Stats APIs
  SUPABASE_URL                 — db
  SUPABASE_SERVICE_ROLE_KEY    — db
"""

from __future__ import annotations

import argparse
import sys
from datetime import date
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(_REPO / ".env.local")

from shared.db import get_client  # noqa: E402
from ingestion.wistia.client import WistiaClient  # noqa: E402
from ingestion.wistia.pipeline import SyncOutcome, sync_wistia  # noqa: E402

# Backfill floor — no documented Wistia API ceiling, but pick a sane
# account-creation-era floor rather than literally infinite.
# Engine-sheet history needs months back, not years, so 2024-01-01
# generously covers everything currently of interest while keeping the
# per-media call (which Wistia computes by walking events) fast.
BACKFILL_START = date(2024, 1, 1)


def _print_outcome(label: str, outcome: SyncOutcome) -> None:
    print(f"\n=== {label} ===")
    print(f"  window:                  {outcome.window}")
    print(f"  days_in_window:          {outcome.days_in_window}")
    print(f"  medias_synced:           {outcome.medias_synced}")
    print(f"  medias_failed:           {outcome.medias_failed}")
    print(f"  daily_rows_upserted:     {outcome.daily_rows_upserted}")
    print(f"  daily_rows_failed:       {outcome.daily_rows_failed}")
    if outcome.warnings:
        print(f"  warnings ({len(outcome.warnings)}):")
        for w in outcome.warnings[:10]:
            print(f"    - {w}")
        if len(outcome.warnings) > 10:
            print(f"    ... and {len(outcome.warnings) - 10} more")
    if outcome.errors:
        print(f"  errors ({len(outcome.errors)}):")
        for e in outcome.errors[:20]:
            print(f"    - {e}")
        if len(outcome.errors) > 20:
            print(f"    ... and {len(outcome.errors) - 20} more")


def dry_run(client: WistiaClient) -> int:
    print("Dry-run: auth + sample inventory + 1 sample by_date call.")
    first_media = None
    media_count = 0
    for m in client.iter_medias():
        media_count += 1
        if first_media is None:
            first_media = m
        if media_count >= 10:
            break  # cap dry-run inventory peek
    print(f"\n  iter_medias: peeked at first {media_count} medias")
    if first_media:
        print(f"  first media: hashed_id={first_media.get('hashed_id')!r} "
              f"name={first_media.get('name')!r} duration={first_media.get('duration')}")
        sample_hid = first_media["hashed_id"]
        sample = client.fetch_by_date(
            sample_hid,
            start_date=BACKFILL_START.isoformat(),
            end_date=date.today().isoformat(),
        )
        print(f"  by_date {sample_hid} {BACKFILL_START} .. today: {len(sample)} days")
        if sample:
            print(f"    first day: {sample[0]}")
            print(f"    last day:  {sample[-1]}")
    print("\n[dry-run] Zero upserts performed. Use --smoke or --apply.")
    return 0


def smoke(client: WistiaClient, db) -> int:
    """One-media end-to-end against real DB; full inventory upsert.

    Note: full inventory is upserted in smoke mode so the FK-loose
    reference table reflects reality even with --smoke. Only the
    per-day stats stage is scoped to 1 media via max_medias=1.
    """
    print("Smoke mode: full inventory + per-day stats for ONE media.")
    outcome = sync_wistia(
        client, db,
        start_date=BACKFILL_START,
        end_date=date.today(),
        max_medias=1,
    )
    _print_outcome("Smoke outcome", outcome)
    if outcome.medias_failed > 0 or outcome.errors:
        print("\nSMOKE FAILED — do NOT proceed to --apply. Review errors above.")
        return 3
    print("\nSmoke OK. Re-run with --apply (Drake-gated) for the bulk backfill.")
    return 0


def apply_bulk(client: WistiaClient, db, *, max_medias: int | None) -> int:
    print(f"Bulk backfill: max_medias={max_medias}")
    outcome = sync_wistia(
        client, db,
        start_date=BACKFILL_START,
        end_date=date.today(),
        max_medias=max_medias,
    )
    _print_outcome("Bulk apply outcome", outcome)
    if outcome.errors:
        print(f"\nApply completed WITH {len(outcome.errors)} errors — review above.")
        return 1
    print("\nApply OK.")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Wistia analytics backfill")
    p.add_argument("--smoke", action="store_true",
                   help="One-media end-to-end against real DB. Idempotent.")
    p.add_argument("--apply", action="store_true",
                   help="Bulk backfill (Drake-gated; smoke first).")
    p.add_argument("--limit", type=int, default=None,
                   help="Cap medias processed in --apply mode.")
    args = p.parse_args()

    if args.smoke and args.apply:
        print("--smoke and --apply are mutually exclusive.", file=sys.stderr)
        return 2

    try:
        client = WistiaClient.from_env()
    except RuntimeError as e:
        print(f"HARD STOP: {e}", file=sys.stderr)
        return 2

    if args.smoke:
        return smoke(client, get_client())
    if args.apply:
        return apply_bulk(client, get_client(), max_medias=args.limit)
    return dry_run(client)


if __name__ == "__main__":
    sys.exit(main())
