"""Register the Airtable webhook subscription on base appCWa6TV6p7EBarC.

ONE-SHOT setup script. **Drake runs this** — gate (d):
  * Requires `webhook:manage` scope on the PAT (the existing
    `AIRTABLE_SALES_PAT` does NOT have this scope per discovery; Drake
    either grants it OR mints a separate webhook-mgmt PAT).
  * Creates real Airtable-side state (a subscription that fires for
    every change on the base).
  * Returns `macSecretBase64` ONCE — Drake stores it as
    `AIRTABLE_WEBHOOK_MAC_SECRET` in Vercel + the webhook id as
    `AIRTABLE_WEBHOOK_ID`. The receiver verifies notification pings
    against the MAC secret and pulls payloads using the webhook id.

Usage:
    .venv/bin/python scripts/register_airtable_webhook.py --list
    .venv/bin/python scripts/register_airtable_webhook.py --dry-run --url https://...
    .venv/bin/python scripts/register_airtable_webhook.py --apply --url https://ai-enablement-sigma.vercel.app/api/airtable_events
    .venv/bin/python scripts/register_airtable_webhook.py --delete ach<webhookId>

What gets registered:
  * notificationUrl: the receiver URL (--url arg)
  * specification.options.filters.dataTypes: ["tableData"]
  * specification.options.filters.recordChangeScope: NOT scoped per-table —
    one webhook covers all 3 target tables. The receiver filters to
    TARGET_TABLES per payload (other tables in the base could fire
    too; they're silently dropped). This keeps the subscription
    durable against adding more target tables later.

Why a single base-level webhook (not 3 per-table):
  * Airtable webhooks are per-BASE (per-table scoping is a `specification`
    filter, but the webhook itself sits on the base). Multiple webhooks
    for the same base burns subscription budget for no benefit.
  * The receiver's `changedTablesById` dispatch handles the per-table
    routing cleanly.

The subscription EXPIRES after 7 days of inactivity unless refreshed.
The cron (`api/airtable_sync_cron.py`) calls `refresh_webhook()` each
tick to keep it alive — make sure AIRTABLE_WEBHOOK_ID is set in Vercel
post-registration so the refresh actually fires.

Env vars (loaded from .env.local):
  AIRTABLE_SALES_PAT  (needs webhook:manage for --apply / --list / --delete)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(_REPO / ".env.local")

from ingestion.airtable import BASE_ID, TARGET_TABLES  # noqa: E402
from ingestion.airtable.client import AirtableAPIError, AirtableClient  # noqa: E402


# The specification: subscribe to record-data changes on the base. The
# receiver filters to TARGET_TABLES per payload, so we don't need
# per-table scoping in the spec.
def _build_specification() -> dict:
    return {
        "options": {
            "filters": {
                "dataTypes": ["tableData"],
            },
        },
    }


def list_webhooks(client: AirtableClient) -> int:
    print(f"GET /v0/bases/{BASE_ID}/webhooks ...")
    try:
        webhooks = client.list_webhooks()
    except AirtableAPIError as e:
        print(f"HARD STOP: {e}", file=sys.stderr)
        return 2
    print(f"  → {len(webhooks)} existing webhook(s)")
    for w in webhooks:
        print(f"\n  id:                 {w.get('id')}")
        print(f"    notificationUrl:  {w.get('notificationUrl')}")
        print(f"    isHookEnabled:    {w.get('isHookEnabled')}")
        print(f"    areNotificationsEnabled: {w.get('areNotificationsEnabled')}")
        print(f"    expirationTime:   {w.get('expirationTime')}")
        print(f"    cursorForNextPayload: {w.get('cursorForNextPayload')}")
        spec = w.get("specification") or {}
        print(f"    specification:    {json.dumps(spec)[:200]}")
    return 0


def register(client: AirtableClient, url: str, dry_run: bool) -> int:
    spec = _build_specification()
    print(f"Base:             {BASE_ID}")
    print(f"Notification URL: {url}")
    print(f"Target tables ({len(TARGET_TABLES)}):")
    for tid, (label, region, target) in TARGET_TABLES.items():
        r = f", region={region}" if region else ""
        print(f"  {tid}  '{label}'{r}  → {target}")
    print(f"Specification:    {json.dumps(spec)}")

    if dry_run:
        print("\n[dry-run] No POST issued. Re-run with --apply to create.")
        return 0

    print("\nPOST /v0/bases/{base}/webhooks ...")
    try:
        resp = client.create_webhook(notification_url=url, specification=spec)
    except AirtableAPIError as e:
        print(f"\nHARD STOP: {e}", file=sys.stderr)
        if "403" in str(e):
            print(
                "\n→ Likely cause: AIRTABLE_SALES_PAT lacks `webhook:manage` scope.\n"
                "  Add it at airtable.com/create/tokens (edit the PAT), THEN re-run.\n"
                "  Discovery confirmed this scope is NOT yet granted.",
                file=sys.stderr,
            )
        return 2

    webhook_id = resp.get("id", "")
    mac_secret = resp.get("macSecretBase64", "")
    expiration = resp.get("expirationTime", "")

    # BIG BOX FIRST — the values Drake needs in Vercel.
    box_width = 78
    print("\n" + "█" * box_width)
    print("█" + " " * (box_width - 2) + "█")
    print(("█  AIRTABLE WEBHOOK CREATED — set these env vars in Vercel").ljust(box_width - 1) + "█")
    print("█" + " " * (box_width - 2) + "█")
    print(("█  expirationTime: " + expiration).ljust(box_width - 1) + "█")
    print("█" + " " * (box_width - 2) + "█")
    print("█" * box_width)
    print()
    print(f"  AIRTABLE_WEBHOOK_ID={webhook_id}")
    print()
    print(f"  AIRTABLE_WEBHOOK_MAC_SECRET={mac_secret}")
    print()
    print("█" * box_width)
    print("█" + " " * (box_width - 2) + "█")
    print(("█  COPY BOTH NOW. macSecretBase64 is returned ONCE.").ljust(box_width - 1) + "█")
    print(("█  If lost: delete + re-register the subscription.").ljust(box_width - 1) + "█")
    print("█" + " " * (box_width - 2) + "█")
    print("█" * box_width)
    print()

    print("─" * box_width)
    print("Full response (pretty-printed):")
    print(json.dumps(resp, indent=2))
    print("─" * box_width)

    # Repeat the secret at the very bottom so whichever direction the
    # user scrolls they hit it.
    print(f"\n>>> AIRTABLE_WEBHOOK_ID={webhook_id}")
    print(f">>> AIRTABLE_WEBHOOK_MAC_SECRET={mac_secret}")
    return 0


def delete(client: AirtableClient, webhook_id: str) -> int:
    print(f"DELETE /v0/bases/{BASE_ID}/webhooks/{webhook_id} ...")
    try:
        client.delete_webhook(webhook_id)
    except AirtableAPIError as e:
        print(f"HARD STOP: {e}", file=sys.stderr)
        return 2
    print("Deleted.")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Airtable webhook registration helper")
    p.add_argument("--list", action="store_true", help="List existing webhooks on the base")
    p.add_argument("--dry-run", action="store_true", help="Show what would be created")
    p.add_argument("--apply", action="store_true", help="Create the subscription")
    p.add_argument("--delete", metavar="WEBHOOK_ID", help="Delete an existing webhook")
    p.add_argument("--url", help="Receiver URL (required for --apply / --dry-run)")
    args = p.parse_args()

    try:
        client = AirtableClient.from_env()
    except RuntimeError as exc:
        print(f"HARD STOP: {exc}", file=sys.stderr)
        return 2

    if args.delete:
        return delete(client, args.delete)
    if args.list:
        return list_webhooks(client)
    if args.apply or args.dry_run:
        if not args.url:
            print("--url required with --apply / --dry-run", file=sys.stderr)
            return 2
        return register(client, args.url, dry_run=args.dry_run and not args.apply)

    # No mode → default to list (cheap, helps discover what's there)
    return list_webhooks(client)


if __name__ == "__main__":
    sys.exit(main())
