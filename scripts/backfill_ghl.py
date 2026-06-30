"""GHL mirror backfill — full sync of contacts + conversations + messages.

Run this ONCE after applying migration 0114 (and before the cron is relied on),
to populate ghl_contacts / ghl_conversations / ghl_messages from the live GHL
sub-account. Real-API `--smoke` first, then `--apply` (per the repo's
discovery-before-bulk discipline).

Usage:
    .venv/bin/python scripts/backfill_ghl.py --smoke     # 1 contact + 1 convo end-to-end
    .venv/bin/python scripts/backfill_ghl.py --apply     # full backfill (full=True)

`--smoke` exercises auth, the location call, one contact upsert and one
conversation's messages — surfacing real-API shape/column drift before the bulk
run. `--apply` walks every contact and conversation (full message re-pull).

Env vars (.env.local): GHL_PRIVATE_TOKEN, GHL_LOCATION_ID, SUPABASE_URL,
SUPABASE_SERVICE_ROLE_KEY.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from shared.db import get_client  # noqa: E402
from ingestion.ghl.client import GHLClient  # noqa: E402
from ingestion.ghl.pipeline import (  # noqa: E402
    SyncOutcome,
    parse_contact,
    parse_conversation,
    parse_message,
    run_sync,
    sync_contacts,
    sync_conversations_and_messages,
)


def smoke() -> int:
    """One contact + one conversation's messages, end-to-end against real API + DB."""
    client = GHLClient.from_env()
    db = get_client()

    loc = client.get_location()
    loc_obj = loc.get("location") or loc
    print(f"[smoke] auth OK — location: {loc_obj.get('name')} ({client.location_id})")

    # One contact end-to-end.
    outcome = SyncOutcome()
    sync_contacts(client, db, outcome, max_pages=1)
    print(
        f"[smoke] contacts page upserted: {outcome.contacts_synced} ok / "
        f"{outcome.contacts_failed} failed"
    )
    if outcome.errors:
        print("[smoke] contact errors:", outcome.errors[:5])

    # Show a parsed contact (incl. the EOC lead-id extraction).
    first = next(client.iter_contacts(max_pages=1), None)
    if first:
        row = parse_contact(first)
        print(
            f"[smoke] sample contact: id={row['id']} source={row['source']!r} "
            f"eoc_lead_id={row['eoc_lead_id']!r} tags={row['tags']}"
        )

    # One conversation + its messages end-to-end.
    conv_raw = next(client.iter_conversations(max_pages=1), None)
    if conv_raw:
        conv = parse_conversation(conv_raw)
        print(
            f"[smoke] sample conversation: id={conv['id']} "
            f"last_type={conv['last_message_type']} last_date={conv['last_message_date']}"
        )
        mtypes: dict[str, int] = {}
        calls = 0
        for m in client.iter_messages(conv["id"]):
            mrow = parse_message(m)
            mtypes[mrow["message_type"]] = mtypes.get(mrow["message_type"], 0) + 1
            if mrow["message_type"] == "TYPE_CALL":
                calls += 1
                print(
                    f"[smoke]   call: dir={mrow['direction']} status={mrow['call_status']} "
                    f"dur={mrow['call_duration']} user={mrow['user_id']}"
                )
        print(f"[smoke] message types in convo: {mtypes}")

    # Round-trip one conversation's messages through the DB upsert.
    co2 = SyncOutcome()
    sync_conversations_and_messages(client, db, co2, full=True, max_conv_pages=1)
    print(
        f"[smoke] DB round-trip: convos={co2.conversations_synced} "
        f"messages={co2.messages_synced} (failed {co2.messages_failed})"
    )
    if co2.errors:
        print("[smoke] convo/message errors:", co2.errors[:5])
        return 1
    print("[smoke] OK ✅  — shapes round-trip cleanly. Safe to --apply.")
    return 0


def apply() -> int:
    client = GHLClient.from_env()
    db = get_client()
    outcome = run_sync(client, db, full=True)
    print(
        f"[apply] contacts={outcome.contacts_synced} (failed {outcome.contacts_failed}) "
        f"conversations={outcome.conversations_synced} "
        f"message_pulls={outcome.conversations_scanned_for_messages} "
        f"messages={outcome.messages_synced} (failed {outcome.messages_failed}) "
        f"errors={len(outcome.errors)}"
    )
    if outcome.errors:
        print("[apply] first errors:", outcome.errors[:10])
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Backfill the GHL mirror.")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument(
        "--smoke", action="store_true", help="One contact + one convo, end-to-end."
    )
    g.add_argument("--apply", action="store_true", help="Full backfill.")
    args = ap.parse_args()
    return smoke() if args.smoke else apply()


if __name__ == "__main__":
    raise SystemExit(main())
