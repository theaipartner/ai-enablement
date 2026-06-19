"""Register OUR OnceHub webhook subscription -> /api/oncehub_events.

Run AFTER the receiver is deployed (the destination URL must exist first).
Creates a NEW subscription alongside any existing one (Zain's make.com webhook
is left untouched). The response carries the per-endpoint signing `secret` —
copy it into Vercel as ONCEHUB_WEBHOOK_SECRET (Drake gate (d)).

Usage:
  .venv/bin/python -m scripts.register_oncehub_webhook --list
  .venv/bin/python -m scripts.register_oncehub_webhook \
      --url https://<deploy>/api/oncehub_events --apply

Reads ONCEHUB_API_KEY from the environment.
"""

from __future__ import annotations

import argparse
import json
import sys

from ingestion.oncehub.client import OnceHubClient

# The booking lifecycle we care about. Excludes conversation.* (chatbot) noise.
BOOKING_EVENTS = [
    "booking.scheduled",
    "booking.rescheduled",
    "booking.reassigned",
    "booking.canceled_then_rescheduled",
    "booking.canceled_reschedule_requested",
    "booking.canceled",
    "booking.completed",
    "booking.no_show",
]


def _redact_secret(wh: dict) -> dict:
    out = dict(wh)
    if out.get("secret"):
        out["secret"] = out["secret"][:4] + "…(redacted — copy from --apply output)"
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Register OnceHub webhook.")
    parser.add_argument("--url", help="Destination URL (our deployed /api/oncehub_events).")
    parser.add_argument("--list", action="store_true", help="List existing webhooks and exit.")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually create the subscription (otherwise dry-run prints intent).",
    )
    args = parser.parse_args()

    client = OnceHubClient.from_env()

    if args.list:
        for wh in client.list_webhooks():
            print(json.dumps(_redact_secret(wh), indent=2))
        return 0

    if not args.url:
        parser.error("--url is required unless --list")

    if not args.apply:
        print("DRY RUN — would create webhook:")
        print(json.dumps({"url": args.url, "events": BOOKING_EVENTS}, indent=2))
        print("\nRe-run with --apply to create it.")
        return 0

    created = client.create_webhook(url=args.url, events=BOOKING_EVENTS)
    secret = created.get("secret")
    print("Created webhook:")
    print(json.dumps(_redact_secret(created), indent=2))
    if secret:
        print("\n*** SIGNING SECRET (set ONCEHUB_WEBHOOK_SECRET in Vercel) ***")
        print(secret)
    return 0


if __name__ == "__main__":
    sys.exit(main())
