"""Register the Calendly webhook subscription against our deployed receiver.

ONE-SHOT setup script. **Drake runs this** — gate (d) territory:
creates real Calendly-side state + needs the deployed receiver URL to
exist first + ships the signing secret Drake puts in Vercel env.

Usage:
    .venv/bin/python scripts/register_calendly_webhook.py            # list existing
    .venv/bin/python scripts/register_calendly_webhook.py --dry-run --url https://...
    .venv/bin/python scripts/register_calendly_webhook.py --register --url https://ai-enablement-sigma.vercel.app/api/calendly_events
    .venv/bin/python scripts/register_calendly_webhook.py --register --url https://... --signing-key <preexisting_secret>
    .venv/bin/python scripts/register_calendly_webhook.py --delete <subscription_uri>

How Calendly signing works (verified 2026-05-24):

  Calendly does NOT auto-generate a signing key on subscription
  creation. The empirical 201 response is just `{resource: {...}}`
  with no `signing_key` in body or headers. Webhooks delivered to a
  subscription created without a key arrive UNSIGNED.

  To get signed deliveries you must include `signing_key` in the POST
  body at create time. Calendly then HMAC-SHA256-signs every webhook
  using THAT key. The kashew/calendly-v2-sdk WebhookPayloadClient
  source confirms the verification scheme:
      [t, v1] = header.split(',')          # "t=<ts>,v1=<hex>"
      data    = ts + '.' + body            # period separator, UTF-8
      sig     = hmac_sha256(key_utf8, data).hexdigest()
  Our api/calendly_events.py `_verify_signature` already implements
  this exactly. The only missing piece was supplying the key at create.

This script's default: generate a cryptographically strong random
secret (`secrets.token_urlsafe(48)` → ~64 URL-safe chars),
send it to Calendly as `signing_key`, print it in a big box so
Drake can paste it into Vercel as CALENDLY_WEBHOOK_SECRET.

Pass `--signing-key <value>` to use an existing secret instead
(useful for rotation or paste-from-Bitwarden).

Per docs/runbooks/calendly_ingestion.md § Live activation runbook:

    1. Builder commits + pushes api/calendly_events.py to main.
       Vercel auto-deploys.
    2. Drake confirms the deploy:
         curl https://ai-enablement-sigma.vercel.app/api/calendly_events
         → {"status":"ok","endpoint":"calendly_events","accepts":"POST"}
    3. Drake runs THIS script with --register --url <URL>.
       Script generates a secret, POSTs it to Calendly, prints it.
       **Copy it now** — only this script and Calendly hold it.
    4. Drake adds CALENDLY_WEBHOOK_SECRET=<signing_key> to Vercel env
       vars. Redeploy to pick it up.
    5. Verify end-to-end: book a real meeting in Calendly, watch for
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
import secrets
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
    """Convenience wrapper that returns parsed JSON body only.
    Use _request_full when response headers also matter (e.g. when
    hunting for a one-shot signing_key that might live in a header)."""
    payload, _headers, _status = _request_full(method, path, body=body)
    return payload


def _request_full(
    method: str,
    path: str,
    *,
    body: dict | None = None,
) -> tuple[dict, dict, int]:
    """Like _request but also returns response headers + status.
    Used by the --register flow so the signing_key search can scan
    headers as well as body (Calendly's docs portal is SPA-locked and
    we can't read the exact response shape from there; empirically
    the key may live in either)."""
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
            parsed = json.loads(payload) if payload else {}
            resp_headers = {k.lower(): v for k, v in resp.headers.items()}
            return parsed, resp_headers, resp.status
    except urllib.error.HTTPError as e:
        body_text = ""
        try:
            body_text = e.read().decode()[:1000]
        except Exception:
            pass
        print(f"\nERROR HTTP {e.code} on {method} {path}", file=sys.stderr)
        print(f"Body: {body_text}", file=sys.stderr)
        raise SystemExit(2)


# ---------------------------------------------------------------------------
# Signing-key extraction — hunts in every plausible location.
# ---------------------------------------------------------------------------
#
# Drake reported (after a failed first registration) that the signing_key
# wasn't visibly captured. Two failure-mode hypotheses we defend against:
#   1. The key IS in the response body but at a path we didn't print
#      prominently enough — the user missed it scrolling past the JSON.
#   2. The key is at a different field name OR in a response header.
# Solution: print everything loudly, search exhaustively, surface the
# winner in a HUGE BOX that's the FIRST thing printed post-POST so it
# doesn't scroll away.

# Candidate field names — order doesn't matter; we check all.
_SIGNING_KEY_FIELDS: tuple[str, ...] = (
    "signing_key",
    "signature_key",
    "webhook_signing_key",
    "secret",
    "key",
)

# Response headers Calendly *might* use for one-shot secret delivery.
_SIGNING_KEY_HEADERS: tuple[str, ...] = (
    "x-signing-key",
    "x-webhook-signing-key",
    "calendly-signing-key",
    "x-calendly-signing-key",
)


def _find_signing_key(
    body: dict,
    resp_headers: dict,
) -> tuple[str | None, str | None]:
    """Walk body + headers exhaustively. Returns (key, where_found_path)
    or (None, None) if not located. `path` is human-readable for
    debugging output."""
    # 1. Top-level body keys.
    for f in _SIGNING_KEY_FIELDS:
        v = body.get(f)
        if isinstance(v, str) and v:
            return v, f"body.{f}"

    # 2. Nested in 'resource' (the conventional Calendly v2 wrapper).
    resource = body.get("resource")
    if isinstance(resource, dict):
        for f in _SIGNING_KEY_FIELDS:
            v = resource.get(f)
            if isinstance(v, str) and v:
                return v, f"body.resource.{f}"

    # 3. Headers (sometimes APIs ship one-shot secrets in headers).
    for h in _SIGNING_KEY_HEADERS:
        v = resp_headers.get(h)
        if isinstance(v, str) and v:
            return v, f"header.{h}"

    # 4. Recursive scan as a last resort — any field name containing
    #    'sign' or 'secret' at any depth.
    def _walk(node, path: str = "body"):
        if isinstance(node, dict):
            for k, v in node.items():
                lo = k.lower()
                if isinstance(v, str) and v and (
                    "sign" in lo or "secret" in lo or lo == "key"
                ):
                    return v, f"{path}.{k}"
                if isinstance(v, (dict, list)):
                    hit = _walk(v, f"{path}.{k}")
                    if hit:
                        return hit
        elif isinstance(node, list):
            for i, item in enumerate(node):
                hit = _walk(item, f"{path}[{i}]")
                if hit:
                    return hit
        return None

    hit = _walk(body)
    if hit:
        return hit
    return None, None


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


def register_subscription(
    callback_url: str,
    dry_run: bool,
    signing_key_override: str | None = None,
) -> None:
    me = _request("GET", "/users/me")
    me_resource = me.get("resource") or me
    org_uri = me_resource.get("current_organization")
    user_uri = me_resource.get("uri")

    # Generate the signing key locally if Drake didn't pass one. Calendly
    # does NOT auto-generate (empirically confirmed 2026-05-24: the 201
    # response was just {resource: {...}} with no key). We MUST supply it
    # at create-time or webhook deliveries arrive unsigned.
    if signing_key_override:
        signing_key = signing_key_override
        key_origin = "user-supplied (--signing-key)"
    else:
        # token_urlsafe(48) → 64 URL-safe base64 chars. ~288 bits of entropy.
        # Calendly treats the key as a plain UTF-8 string for HMAC
        # (per kashew/calendly-v2-sdk WebhookPayloadClient source); the
        # URL-safe charset stays safe across copy/paste boundaries
        # (env var values, JSON literals, terminal selection).
        signing_key = secrets.token_urlsafe(48)
        key_origin = "generated locally (secrets.token_urlsafe(48))"

    print(f"Organization: {org_uri}")
    print(f"User (will be the subscription creator): {user_uri}")
    print(f"Callback URL: {callback_url}")
    print(f"Signing key origin: {key_origin}")
    print(f"Events ({len(EVENTS_IN_SCOPE)}):")
    for ev in EVENTS_IN_SCOPE:
        print(f"  - {ev}")

    body = {
        "url": callback_url,
        "events": EVENTS_IN_SCOPE,
        "organization": org_uri,
        "user": user_uri,
        "scope": "organization",
        "signing_key": signing_key,
    }

    if dry_run:
        print("\n[dry-run] No POST issued. Re-run with --register to create.")
        # Show the body shape we WOULD send, with the signing_key
        # redacted so a dry-run doesn't leak the secret into terminal
        # scrollback / Loom recordings.
        preview = {**body, "signing_key": f"<{len(signing_key)}-char secret, redacted>"}
        print(f"Would POST body: {json.dumps(preview, indent=2)}")
        return

    print("\nPOST /webhook_subscriptions ...")
    resp_body, resp_headers, resp_status = _request_full(
        "POST", "/webhook_subscriptions", body=body,
    )

    # BIG BOX FIRST — the secret Drake needs. We know what it is
    # because we generated (or were handed) it; Calendly's POST response
    # does NOT echo signing_key back, so we print the value we sent.
    box_width = 78
    print("\n" + "█" * box_width)
    print("█" + " " * (box_width - 2) + "█")
    label = "  CALENDLY_WEBHOOK_SECRET — paste this into Vercel env vars"
    print(("█" + label).ljust(box_width - 1) + "█")
    print("█" + " " * (box_width - 2) + "█")
    print(("█  Origin: " + key_origin).ljust(box_width - 1) + "█")
    print("█" + " " * (box_width - 2) + "█")
    print("█" * box_width)
    # Print the key on its own clean line, no border interference,
    # so terminal triple-click selects exactly the key.
    print()
    print(f"  {signing_key}")
    print()
    print("█" * box_width)
    print("█" + " " * (box_width - 2) + "█")
    print("█  This is the ONLY copy printed. Calendly does not echo it back.".ljust(box_width - 1) + "█")
    print("█  If lost: delete + re-register the subscription with a new key.".ljust(box_width - 1) + "█")
    print("█" + " " * (box_width - 2) + "█")
    print("█" * box_width)

    # Defensive cross-check: scan the response in case Calendly DOES
    # echo a key back (e.g., a newer API version or different field
    # name than expected). If found and it matches what we sent, great.
    # If found and differs, surface it loudly — Calendly may have
    # rejected our key and substituted its own.
    echoed_key, echoed_path = _find_signing_key(resp_body, resp_headers)
    if echoed_key:
        if echoed_key == signing_key:
            print(f"\n[ok] Calendly echoed the signing_key back at {echoed_path} — matches what we sent.")
        else:
            print("\n" + "!" * box_width)
            print("! WARNING: Calendly returned a signing_key that DIFFERS from what we sent. !")
            print(f"! Sent:    {signing_key}")
            print(f"! Got at {echoed_path}: {echoed_key}")
            print("! Use the value Calendly returned (above) — that's what they'll sign with. !")
            print("!" * box_width)

    # Diagnostic dump — full body + headers. Useful if a future Calendly
    # API shift changes the response shape and we need to debug.
    print("\n" + "─" * 78)
    print("DIAGNOSTIC DUMP — full POST response")
    print("─" * 78)
    print(f"HTTP status: {resp_status}")
    print(f"\nResponse headers ({len(resp_headers)} entries):")
    for k, v in sorted(resp_headers.items()):
        print(f"  {k}: {v}")
    print(f"\nResponse body top-level keys: {list(resp_body.keys())}")
    if isinstance(resp_body.get("resource"), dict):
        print(f"Response body resource keys: {list(resp_body['resource'].keys())}")
    print("\nFull response body (pretty-printed):")
    print(json.dumps(resp_body, indent=2))
    print("─" * 78)

    # Repeat the key one more time at the very bottom of output, so
    # whichever direction the user scrolls they hit it.
    print(f"\n>>> CALENDLY_WEBHOOK_SECRET = {signing_key}\n")


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
    p.add_argument(
        "--signing-key",
        metavar="SECRET",
        help=("Use a specific signing key instead of generating a fresh one. "
              "Useful for rotation or restoring from Bitwarden. Omit to "
              "auto-generate a strong random secret."),
    )
    args = p.parse_args()

    if args.delete:
        delete_subscription(args.delete)
        return 0

    if args.register or args.dry_run:
        if not args.url:
            print("--url required with --register / --dry-run", file=sys.stderr)
            return 2
        register_subscription(
            args.url,
            dry_run=args.dry_run and not args.register,
            signing_key_override=args.signing_key,
        )
        return 0

    list_subscriptions()
    return 0


if __name__ == "__main__":
    sys.exit(main())
