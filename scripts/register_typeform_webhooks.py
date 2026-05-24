"""Register Typeform webhooks against our deployed receiver.

ONE-SHOT setup script. **Drake runs this** — gate (a)/(d) territory
because it creates real Typeform-side state pointing at production +
needs the deployed receiver URL to exist first.

Selection rule: webhooks register only on **currently-active forms**,
defined as forms with a submission within the last
ACTIVE_WINDOW_DAYS days (default 30). NOT a hardcoded id list — funnels
rotate as Drake spins up new variants, and this script must keep up
without code edits. Dead/archived forms still mirror via the cron
backstop (which walks all forms), they just don't get real-time pings.

Usage:
    .venv/bin/python scripts/register_typeform_webhooks.py                          # list existing + show would-register
    .venv/bin/python scripts/register_typeform_webhooks.py --dry-run --url <URL>    # show plan
    .venv/bin/python scripts/register_typeform_webhooks.py --apply --url <URL>      # register
    .venv/bin/python scripts/register_typeform_webhooks.py --delete --url <URL>     # remove (cleanup)

Flow per docs/runbooks/typeform_ingestion.md § Live activation:

    1. Builder merges + deploys typeform_events.py (auto-deploy via push).
    2. Drake confirms https://<deploy-host>/api/typeform_events responds
       200 on GET.
    3. Drake generates TYPEFORM_WEBHOOK_SECRET (e.g. `openssl rand -hex 32`),
       adds to Vercel env vars, redeploys to pick up.
    4. Drake exports TYPEFORM_WEBHOOK_SECRET locally (matching Vercel) +
       runs THIS script with `--apply --url <RECEIVER_URL>`.
    5. Verify one real submission flows end-to-end.

Env vars (loaded from .env.local):
  TYPEFORM_API_KEY            — PAT; required.
  TYPEFORM_WEBHOOK_SECRET     — caller-supplied shared secret used in
                                the PUT body. MUST match the same env
                                var on the deployed receiver. Required
                                for --apply.

Tag: `ai-enablement-prod` — per-form webhook tag. PUT is idempotent on
(form_id, tag), so re-running is safe.
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(_REPO / ".env.local")

from ingestion.typeform.client import TypeformAPIError, TypeformClient  # noqa: E402


WEBHOOK_TAG = "ai-enablement-prod"
ACTIVE_WINDOW_DAYS = 30


def _select_active_forms(
    client: TypeformClient,
    window_days: int = ACTIVE_WINDOW_DAYS,
) -> list[tuple[str, str, str | None, int]]:
    """Return [(form_id, title, last_submitted_iso, total_items), ...]
    for forms with at least one submission in the last `window_days`.

    Uses the live API (no Supabase dependency) so this script can run
    before the mirror is fully populated.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=window_days)
    active: list[tuple[str, str, str | None, int]] = []
    for form in client.list_forms():
        form_id = form.get("id")
        title = form.get("title") or ""
        if not form_id:
            continue
        try:
            resp = client.list_responses(form_id, page_size=1)
        except TypeformAPIError as e:
            print(f"  WARN: list_responses({form_id}) failed — skip ({e})")
            continue
        items = resp.get("items", []) or []
        total = resp.get("total_items", 0)
        last_submitted_iso = items[0].get("submitted_at") if items else None
        if not last_submitted_iso:
            continue
        try:
            last = datetime.fromisoformat(last_submitted_iso.replace("Z", "+00:00"))
        except ValueError:
            continue
        if last >= cutoff:
            active.append((form_id, title, last_submitted_iso, total))
    active.sort(key=lambda r: r[2] or "", reverse=True)
    return active


def list_existing(client: TypeformClient, form_ids: list[str]) -> None:
    print("\nExisting webhook subscriptions:")
    for form_id in form_ids:
        try:
            hooks = client.list_webhooks(form_id)
        except TypeformAPIError as e:
            print(f"  [{form_id}] error listing: {e}")
            continue
        if not hooks:
            print(f"  [{form_id}] (none)")
            continue
        for h in hooks:
            url = h.get("url") or ""
            tag = h.get("tag") or ""
            enabled = h.get("enabled")
            print(f"  [{form_id}] tag={tag!r} url={url} enabled={enabled}")


def do_apply(
    client: TypeformClient,
    active_forms: list[tuple[str, str, str | None, int]],
    *,
    receiver_url: str,
    secret: str,
    dry_run: bool,
) -> None:
    print(f"\n{'[DRY-RUN] ' if dry_run else ''}Registering {len(active_forms)} active form(s):")
    print(f"  receiver: {receiver_url}")
    print(f"  tag:      {WEBHOOK_TAG}")
    print(f"  secret:   <{len(secret)} chars>")
    print()
    for form_id, title, last, total in active_forms:
        print(f"  [{form_id}] last={last[:19] if last else '—'} total={total} title={title[:60]!r}")
        if dry_run:
            continue
        try:
            resp = client.put_webhook(
                form_id,
                WEBHOOK_TAG,
                url=receiver_url,
                secret=secret,
                enabled=True,
                verify_ssl=True,
            )
            print(f"      → enabled={resp.get('enabled')} id={resp.get('id')}")
        except TypeformAPIError as e:
            print(f"      → FAILED: {e}")
    if dry_run:
        print("\n[dry-run] No PUTs issued. Re-run with --apply to register.")


def do_delete(
    client: TypeformClient,
    form_ids: list[str],
    *,
    dry_run: bool,
) -> None:
    """Remove the ai-enablement-prod tag from the given forms. Useful
    for cleanup / migration to a new tag scheme."""
    print(f"\n{'[DRY-RUN] ' if dry_run else ''}Deleting tag {WEBHOOK_TAG!r} from {len(form_ids)} form(s):")
    for form_id in form_ids:
        print(f"  [{form_id}] DELETE tag={WEBHOOK_TAG}")
        if dry_run:
            continue
        try:
            client.delete_webhook(form_id, WEBHOOK_TAG)
            print("      → ok")
        except TypeformAPIError as e:
            print(f"      → FAILED: {e}")


def main() -> int:
    p = argparse.ArgumentParser(description="Register Typeform webhook subscriptions")
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true", help="PUT subscriptions on all active forms")
    mode.add_argument("--dry-run", action="store_true", help="Show the plan without writing")
    mode.add_argument(
        "--delete", action="store_true",
        help="DELETE the ai-enablement-prod tag from all active forms",
    )
    p.add_argument("--url", help="Receiver URL (required for --apply / --dry-run)")
    p.add_argument(
        "--window-days", type=int, default=ACTIVE_WINDOW_DAYS,
        help=f"Active-form recency window (default {ACTIVE_WINDOW_DAYS}d)",
    )
    args = p.parse_args()

    try:
        client = TypeformClient.from_env()
    except RuntimeError as exc:
        print(f"HARD STOP: {exc}", file=sys.stderr)
        return 2

    # Always print the active-form inventory — it's the "what would
    # happen" view that's safe regardless of mode.
    print("Pulling active-form inventory (this may take ~30s)...")
    active = _select_active_forms(client, window_days=args.window_days)
    print(f"\nActive forms ({len(active)} with submission in last {args.window_days}d):")
    for form_id, title, last, total in active:
        print(
            f"  [{form_id}] last={last[:19] if last else '—'} "
            f"total={total:>6}  {title[:80]!r}"
        )

    if not active:
        print("\nNo active forms — nothing to register.")
        return 0

    list_existing(client, [f[0] for f in active])

    if args.delete:
        do_delete(client, [f[0] for f in active], dry_run=False)
        return 0

    if args.apply or args.dry_run:
        if not args.url:
            print("\n--url is required with --apply / --dry-run", file=sys.stderr)
            return 2
        secret = os.environ.get("TYPEFORM_WEBHOOK_SECRET") or ""
        if args.apply and not secret:
            print(
                "\nHARD STOP: TYPEFORM_WEBHOOK_SECRET not in environment. "
                "Export it (matching the value set in Vercel) and re-run.",
                file=sys.stderr,
            )
            return 2
        if args.dry_run and not secret:
            secret = "<unset — set TYPEFORM_WEBHOOK_SECRET before --apply>"
        do_apply(
            client, active,
            receiver_url=args.url, secret=secret,
            dry_run=args.dry_run and not args.apply,
        )
        return 0

    # Default: just show inventory + existing subs (already printed).
    print("\n(default listing — pass --dry-run / --apply / --delete to act)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
