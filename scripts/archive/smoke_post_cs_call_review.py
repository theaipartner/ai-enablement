"""One-shot smoke: post the most recent call_review to cs-call-summaries.

Picks the most recent `documents` row of (source='fathom',
document_type='call_review') that has a resolvable primary_csm and
client, and runs it through the live `maybe_post_cs_call_summary` to
post a single real message to `SLACK_CS_CALL_SUMMARIES_CHANNEL_ID`.

Intended for Drake's eyes-on verification of the review-shaped output
before relying on it for live calls. Each run creates one Slack
message AND one webhook_deliveries audit row tagged
`source='cs_call_summary_slack_post'`. NOT idempotent.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(_REPO / ".env.local")

from agents.gregory.cs_call_summary_post import (  # noqa: E402
    maybe_post_cs_call_summary,
)
from shared.db import get_client  # noqa: E402


def _pick_target(db):
    """Return (call_id, client_id, external_id) for the most-recent
    call_review with a resolvable primary_csm. Walks the most recent
    20 reviews, skipping any whose client has no active primary_csm."""
    resp = (
        db.table("documents")
        .select("external_id, metadata, created_at")
        .eq("source", "fathom")
        .eq("document_type", "call_review")
        .order("created_at", desc=True)
        .limit(20)
        .execute()
    )
    if not resp.data:
        return None

    for doc in resp.data:
        meta = doc.get("metadata") or {}
        client_id = meta.get("client_id")
        call_id = meta.get("call_id")
        external_id = doc.get("external_id")
        if not (client_id and call_id and external_id):
            continue
        csm = (
            db.table("client_team_assignments")
            .select("id")
            .eq("client_id", client_id)
            .eq("role", "primary_csm")
            .is_("unassigned_at", "null")
            .limit(1)
            .execute()
        )
        if not csm.data:
            continue
        return call_id, client_id, external_id

    return None


def main() -> None:
    if not os.environ.get("SLACK_CS_CALL_SUMMARIES_CHANNEL_ID"):
        print(
            "SLACK_CS_CALL_SUMMARIES_CHANNEL_ID not set in env. "
            "Check .env.local.",
            file=sys.stderr,
        )
        sys.exit(1)
    if not os.environ.get("SLACK_BOT_TOKEN"):
        print("SLACK_BOT_TOKEN not set in env. Check .env.local.", file=sys.stderr)
        sys.exit(1)

    db = get_client()
    target = _pick_target(db)
    if target is None:
        print(
            "No call_review document found with a resolvable primary_csm. "
            "Either the table is empty or the most recent reviews are for "
            "clients without active CSM assignments.",
            file=sys.stderr,
        )
        sys.exit(1)

    call_id, client_id, external_id = target
    print(f"smoke target: call_id={call_id}")
    print(f"             client_id={client_id}")
    print(f"             external_id={external_id}")
    print(f"posting to channel: {os.environ['SLACK_CS_CALL_SUMMARIES_CHANNEL_ID']}")
    print()

    result = maybe_post_cs_call_summary(
        db,
        call_id=call_id,
        call_category="client",
        primary_client_id=client_id,
        summary_text="(smoke fallback — not used because review exists)",
        fathom_external_id=external_id,
    )

    print(f"result: {result}")
    print()
    if result.get("posted") and result.get("content_source") == "call_review":
        print(
            "POSTED via review-shaped path. Check the cs-call-summaries "
            "channel to verify rendering."
        )
        sys.exit(0)
    elif result.get("posted"):
        print(
            f"POSTED via {result.get('content_source')!r} path — NOT what "
            "we wanted to verify. The review for this call may be malformed "
            "or missing despite the picker walking the table; check the "
            "documents row for external_id={external_id} manually."
        )
        sys.exit(2)
    else:
        print(
            f"NOT posted. skipped_reason={result.get('skipped_reason')} "
            f"slack_error={result.get('slack_error')}"
        )
        sys.exit(3)


if __name__ == "__main__":
    main()
