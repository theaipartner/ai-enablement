"""Register the Calendly webhook subscription against our deployed receiver.

ONE-SHOT setup script. **Drake runs this** — gate (d) territory:
creates real Calendly-side state + needs the deployed receiver URL to
exist first + returns the signing secret to put in Vercel env.

Usage:
    .venv/bin/python scripts/register_calendly_webhook.py            # list existing
    .venv/bin/python scripts/register_calendly_webhook.py --dry-run --url https://...
    .venv/bin/python scripts/register_calendly_webhook.py --register --url https://ai-enablement-sigma.vercel.app/api/calendly_events
    .venv/bin/python scripts/register_calendly_webhook.py --delete <subscription_uri>

Per docs/runbooks/calendly_ingestion.md § Live activation runbook:

    1. Builder commits + pushes api/calendly_events.py to main.
       Vercel auto-deploys.
    2. Drake confirms the deploy:
         curl https://ai-enablement-sigma.vercel.app/api/calendly_events
         → {"status":"ok","endpoint":"calendly_events","accepts":"POST"}
    3. Drake runs THIS script with --register --url <URL>.
    4. Script prints the signing key from Calendly's response.
       **Copy it now** — Calendly may only show it once.
    5. Drake adds CALENDLY_WEBHOOK_SECRET=<signing_key> to Vercel env
       vars. Redeploy to pick it up.
    6. Verify end-to-end: book a real meeting in Calendly, watch for
       a row in webhook_deliveries with source='calendly_webhook' +
       a corresponding upsert in calendly_invitees + calendly_scheduled_events.

The org has 10 existing webhook subscriptions pointing at Make.com
hooks. Adding an 11th doesn't disrupt those — Calendly fans out to
every active subscription.

Env vars (loaded from .env.local):
  CALENDLY_API_KEY  (or CALENDLY_API_TOKEN, accepted as fallback)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(_REPO / ".env.local")

import urllib.error  # noqa: E402
import urllib.request  # noqa: E402


BASE_URL = "https://api.calendly.com"
USER_AGENT = "ai-enablement/1.0 (+drake@theaipartner.io)"


# Events to subscribe to. Per spec scope:
#   - invitee.created / invitee.canceled — primary signals for the
#     6 Engine-sheet metrics
#   - invitee_no_show.created / .deleted — keep no_show flag fresh
EVENTS_IN_SCOPE: list[str] = [
    "invitee.created",
    "invitee.canceled",
    "invitee_no_show.created",
    "invitee_no_show.deleted",
]


def _get_token() -> str:
    key = os.environ.get("CALENDLY_API_KEY") or os.environ.get("CALENDLY_API_TOKEN")
    if not key:
        print("HARD STOP: CALENDLY_API_KEY not in environment", file=sys.stderr)
        raise SystemExit(2)
    return key


def _request(method: str, path: str, *, body: dict | None = None) -> dict:
    url = f"{BASE_URL}{path}"
    data = json.dumps(body).encode() if body is not None else None
    headers = {
        "Authorization": f"Bearer {_get_token()}",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, method=method, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = resp.read().decode()
            return json.loads(payload) if payload else {}
    except urllib.error.HTTPError as e:
        body_text = ""
        try:
            body_text = e.read().decode()[:1000]
        except Exception:
            pass
        print(f"\nERROR HTTP {e.code} on {method} {path}", file=sys.stderr)
        print(f"Body: {body_text}", file=sys.stderr)
        raise SystemExit(2)


def list_subscriptions() -> None:
    # Need org URI first.
    me = _request("GET", "/users/me")
    org_uri = (me.get("resource") or me).get("current_organization")
    print(f"Organization: {org_uri}\n")

    resp = _request(
        "GET",
        f"/webhook_subscriptions?organization={org_uri}&scope=organization&count=100",
    )
    subs = resp.get("collection", [])
    print(f"Existing Calendly webhook subscriptions ({len(subs)}):")
    for s in subs:
        print(f"\n  {s.get('uri')}")
        print(f"    callback_url: {s.get('callback_url')}")
        print(f"    state:        {s.get('state')}")
        print(f"    events:       {s.get('events')}")
        print(f"    scope:        {s.get('scope')}")


def register_subscription(callback_url: str, dry_run: bool) -> None:
    me = _request("GET", "/users/me")
    me_resource = me.get("resource") or me
    org_uri = me_resource.get("current_organization")
    user_uri = me_resource.get("uri")
    print(f"Organization: {org_uri}")
    print(f"User (will be the subscription creator): {user_uri}")
    print(f"Callback URL: {callback_url}")
    print(f"Events ({len(EVENTS_IN_SCOPE)}):")
    for ev in EVENTS_IN_SCOPE:
        print(f"  - {ev}")

    body = {
        "url": callback_url,
        "events": EVENTS_IN_SCOPE,
        "organization": org_uri,
        "user": user_uri,
        "scope": "organization",
    }

    if dry_run:
        print("\n[dry-run] No POST issued. Re-run with --register to create.")
        return

    print("\nPOST /api/v1/webhook_subscriptions ...")
    resp = _request("POST", "/webhook_subscriptions", body=body)
    print("\nSUCCESS — subscription created. Response:\n")
    print(json.dumps(resp, indent=2))

    # Calendly returns the signing key under various field names depending
    # on the API version — try the common ones.
    resource = resp.get("resource") or resp
    sig_key = (
        resource.get("signing_key")
        or resource.get("signature_key")
        or resource.get("secret")
        or resp.get("signing_key")
        or resp.get("signature_key")
    )
    if sig_key:
        print(
            "\n" + "=" * 70
            + f"\nSIGNING KEY (set as CALENDLY_WEBHOOK_SECRET in Vercel):\n\n  {sig_key}\n\n"
            + "Add to Vercel project env vars, then redeploy to pick it up.\n"
            + "Calendly's signing-key field may only be returned on create —\n"
            + "copy it now. If you lose it, delete + recreate the subscription.\n"
            + "=" * 70
        )
    else:
        print(
            "\nWARN: response had no obvious signing_key field. Inspect the JSON "
            "above; the signing key may be under a different name. If absent, "
            "Calendly may require fetching it via a separate endpoint — check "
            "https://developer.calendly.com/api-docs/4c305798a61d3-webhook-signatures"
        )


def delete_subscription(sub_uri: str) -> None:
    # sub_uri is a full URI; extract uuid.
    sub_uuid = sub_uri.rsplit("/", 1)[-1]
    print(f"DELETE /webhook_subscriptions/{sub_uuid} ...")
    _request("DELETE", f"/webhook_subscriptions/{sub_uuid}")
    print("Deleted.")


def main() -> int:
    p = argparse.ArgumentParser(description="Register Calendly webhook subscription")
    p.add_argument("--register", action="store_true", help="Create subscription")
    p.add_argument("--dry-run", action="store_true", help="Show what would be created")
    p.add_argument("--delete", metavar="SUB_URI",
                   help="Delete an existing subscription by full URI")
    p.add_argument("--url", help="Receiver URL (required for --register / --dry-run)")
    args = p.parse_args()

    if args.delete:
        delete_subscription(args.delete)
        return 0

    if args.register or args.dry_run:
        if not args.url:
            print("--url required with --register / --dry-run", file=sys.stderr)
            return 2
        register_subscription(args.url, dry_run=args.dry_run and not args.register)
        return 0

    list_subscriptions()
    return 0


if __name__ == "__main__":
    sys.exit(main())
