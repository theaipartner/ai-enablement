"""Register the Close webhook subscription against our deployed receiver.

ONE-SHOT setup script. **Drake runs this** — gate (d) territory because
it creates real Close-side state + needs the deployed receiver URL to
exist first.

Usage:
    .venv/bin/python scripts/register_close_webhook.py            # list existing
    .venv/bin/python scripts/register_close_webhook.py --dry-run --url https://...   # show what would be created
    .venv/bin/python scripts/register_close_webhook.py --register --url https://ai-enablement-sigma.vercel.app/api/close_events
    .venv/bin/python scripts/register_close_webhook.py --delete whsub_<id>

Flow per docs/runbooks/close_ingestion.md § Live activation:

    1. Builder merges + deploys close_events.py (auto-deploy via main push).
    2. Drake confirms https://ai-enablement-sigma.vercel.app/api/close_events
       responds 200 on GET (browser hit or curl).
    3. Drake runs THIS script with `--register --url <URL>`.
    4. Script prints the signing secret returned by Close (one-time output).
    5. Drake puts the secret in Vercel as `CLOSE_WEBHOOK_SECRET`. Redeploy
       to pick up the env var.
    6. Verify a real event flows end-to-end (change a lead in Close, watch
       `webhook_deliveries.source='close_webhook'` for a new row).

The script subscribes to the in-scope event types per
docs/specs/close-live-webhooks.md (plus Drake's 2026-05-23 opportunity
override). Edit `EVENTS_IN_SCOPE` to add/remove later.

Env vars (loaded from .env.local):
  CLOSE_API_KEY   — HTTP Basic key-as-username; same key used by the
                    ingestion module and discovery probes.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlencode

import urllib.error
import urllib.request

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(_REPO / ".env.local")


BASE_URL = "https://api.close.com/api/v1"

# Event subscription set. Per docs/specs/close-live-webhooks.md § Scope
# + Drake's 2026-05-23 opportunity-override.
EVENTS_IN_SCOPE: list[dict[str, str]] = [
    # Leads — full create/update/merge lifecycle.
    {"object_type": "lead", "action": "created"},
    {"object_type": "lead", "action": "updated"},
    {"object_type": "lead", "action": "merged"},
    # Opportunities — Drake override 2026-05-23. Mirror everything Close
    # emits; the $1-placeholder caveat for `value` stays in the schema doc.
    {"object_type": "opportunity", "action": "created"},
    {"object_type": "opportunity", "action": "updated"},
    # Call activities — lifecycle events refresh status/duration.
    {"object_type": "activity.call", "action": "created"},
    {"object_type": "activity.call", "action": "updated"},
    {"object_type": "activity.call", "action": "answered"},
    {"object_type": "activity.call", "action": "completed"},
    # SMS activities.
    {"object_type": "activity.sms", "action": "created"},
    {"object_type": "activity.sms", "action": "updated"},
    {"object_type": "activity.sms", "action": "sent"},
    # Lead status changes — the funnel-spine event stream.
    {"object_type": "activity.lead_status_change", "action": "created"},
    {"object_type": "activity.lead_status_change", "action": "updated"},
]


def _auth_header(api_key: str) -> str:
    token = base64.b64encode(f"{api_key}:".encode()).decode()
    return f"Basic {token}"


def _request(method: str, path: str, api_key: str, *, body: dict | None = None) -> dict:
    url = f"{BASE_URL}{path}"
    data = json.dumps(body).encode() if body is not None else None
    headers = {
        "Authorization": _auth_header(api_key),
        "Accept": "application/json",
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


def list_subscriptions(api_key: str) -> None:
    resp = _request("GET", "/webhook/", api_key)
    subs = resp.get("data", [])
    print(f"Existing Close webhook subscriptions ({len(subs)}):")
    for s in subs:
        url = s.get("url")
        sid = s.get("id")
        status = s.get("status")
        events = s.get("events", [])
        print(f"\n  {sid}")
        print(f"    url:    {url}")
        print(f"    status: {status}")
        print(f"    events ({len(events)}):")
        for ev in events:
            print(f"      - {ev.get('object_type')}.{ev.get('action')}")


def register_subscription(api_key: str, url: str, dry_run: bool) -> None:
    body = {
        "url": url,
        "events": EVENTS_IN_SCOPE,
        "verify_ssl": True,
    }
    print(f"Subscription target: {url}")
    print(f"Events ({len(EVENTS_IN_SCOPE)}):")
    for ev in EVENTS_IN_SCOPE:
        print(f"  - {ev['object_type']}.{ev['action']}")

    if dry_run:
        print("\n[dry-run] No POST issued. Re-run with --register to create.")
        return

    print("\nPOST /api/v1/webhook/ ...")
    resp = _request("POST", "/webhook/", api_key, body=body)
    print("\nSUCCESS — subscription created. Response:\n")
    print(json.dumps(resp, indent=2))

    sig_key = resp.get("signature_key") or resp.get("secret") or resp.get("signing_key")
    if sig_key:
        print(
            "\n" + "=" * 70
            + f"\nSIGNING SECRET (set as CLOSE_WEBHOOK_SECRET in Vercel):\n\n  {sig_key}\n\n"
            + "Add to Vercel project env vars, then redeploy to pick it up.\n"
            + "Close's signing-secret IS shown only once; copy it now.\n"
            + "=" * 70
        )
    else:
        print(
            "\nWARN: response had no obvious signature-key field. Inspect the JSON "
            "above to find the signing secret (Close may use a different field name)."
        )


def delete_subscription(api_key: str, sub_id: str) -> None:
    print(f"DELETE /webhook/{sub_id}/ ...")
    _request("DELETE", f"/webhook/{sub_id}/", api_key)
    print("Deleted.")


def main() -> int:
    p = argparse.ArgumentParser(description="Register Close webhook subscription")
    p.add_argument("--register", action="store_true", help="Create subscription")
    p.add_argument("--dry-run", action="store_true", help="Show what would be created")
    p.add_argument("--delete", metavar="SUB_ID",
                   help="Delete an existing subscription by whsub_* id")
    p.add_argument("--url", help="Receiver URL (required for --register / --dry-run)")
    args = p.parse_args()

    api_key = os.environ.get("CLOSE_API_KEY")
    if not api_key:
        print("HARD STOP: CLOSE_API_KEY not in .env.local", file=sys.stderr)
        return 2

    if args.delete:
        delete_subscription(api_key, args.delete)
        return 0

    if args.register or args.dry_run:
        if not args.url:
            print("--url required with --register / --dry-run", file=sys.stderr)
            return 2
        register_subscription(api_key, args.url, dry_run=args.dry_run and not args.register)
        return 0

    # Default: list.
    list_subscriptions(api_key)
    return 0


if __name__ == "__main__":
    sys.exit(main())
