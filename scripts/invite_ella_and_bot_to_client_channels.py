"""Invite Ella's user account + the Slack bot to every client channel.

Slack's `conversations.invite` is needed for both the bot (so
`conversations.history` returns messages) and Ella's user account
(so the M1.4 user-token post path renders as a regular user message
rather than the bot tag).

Default mode is `--dry-run` — lists current membership without
inviting. `--apply` performs invites. Failures don't abort the run;
they're reported per-channel.

Auth:
  - `SLACK_USER_TOKEN` (xoxp-) — preferred for inviting because user
    tokens have broader invite permissions than bot tokens, especially
    for private channels.
  - `SLACK_BOT_TOKEN` (xoxb-) — used to derive the bot's own user_id
    via auth.test, so we know which user_id to invite.

Usage:
    .venv/bin/python scripts/invite_ella_and_bot_to_client_channels.py
    .venv/bin/python scripts/invite_ella_and_bot_to_client_channels.py --apply
    .venv/bin/python scripts/invite_ella_and_bot_to_client_channels.py --apply --users U0123ELLA,U0123BOT
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(_REPO / ".env.local")

from ingestion.slack.client import SlackAPIError, SlackClient  # noqa: E402
from shared.db import get_client  # noqa: E402
from shared.slack_identity import get_user_id_for_token  # noqa: E402


def _resolve_target_user_ids(users_arg: str | None) -> list[str]:
    """Resolve the list of user_ids to invite.

    If --users is provided, use that comma-separated list verbatim.
    Otherwise derive Ella's user_id from SLACK_USER_TOKEN and the bot's
    user_id from SLACK_BOT_TOKEN via auth.test.
    """
    if users_arg:
        return [u.strip() for u in users_arg.split(",") if u.strip()]
    target_ids: list[str] = []
    user_token = os.environ.get("SLACK_USER_TOKEN")
    bot_token = os.environ.get("SLACK_BOT_TOKEN")
    ella_id = get_user_id_for_token(user_token)
    bot_id = get_user_id_for_token(bot_token)
    if ella_id:
        target_ids.append(ella_id)
    if bot_id:
        target_ids.append(bot_id)
    return target_ids


def _fetch_client_channels(db) -> list[dict]:
    resp = (
        db.table("slack_channels")
        .select("slack_channel_id,name,client_id,clients(full_name)")
        .not_.is_("client_id", "null")
        .eq("is_archived", False)
        .execute()
    )
    rows = resp.data or []
    out: list[dict] = []
    for r in rows:
        clients = r.get("clients") or {}
        out.append({
            "slack_channel_id": r.get("slack_channel_id"),
            "name": r.get("name"),
            "full_name": clients.get("full_name") if isinstance(clients, dict) else None,
        })
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually invite users. Default is dry-run (list memberships only).",
    )
    parser.add_argument(
        "--users",
        default=None,
        help="Comma-separated user ids to invite. Defaults to Ella + bot "
             "user ids derived from env tokens.",
    )
    args = parser.parse_args()

    target_user_ids = _resolve_target_user_ids(args.users)
    if not target_user_ids:
        print(
            "error: no target user_ids resolved. Set SLACK_USER_TOKEN + "
            "SLACK_BOT_TOKEN in .env.local or pass --users."
        )
        return 2

    print(f"Target user_ids to ensure-membership-of: {target_user_ids}")

    # Use the user token for invite calls if available; falls back to
    # bot. SlackClient auto-pulls SLACK_BOT_TOKEN from env when token=None.
    invite_token = os.environ.get("SLACK_USER_TOKEN") or os.environ.get("SLACK_BOT_TOKEN")
    if not invite_token:
        print("error: neither SLACK_USER_TOKEN nor SLACK_BOT_TOKEN set")
        return 2
    invite_client = SlackClient(token=invite_token)

    # Use the bot token for read-side calls (membership lookup); same
    # rationale as the local backfill — bot scopes already cover this.
    read_client = SlackClient()

    db = get_client()
    channels = _fetch_client_channels(db)
    print(f"Client channels resolved: {len(channels)}")
    print()

    invited_count = 0
    already_in_count = 0
    failed_count = 0
    skipped_dryrun = 0

    for ch in channels:
        chan_id = ch["slack_channel_id"]
        label = f"{ch.get('full_name') or '?'} ({chan_id})"
        try:
            members = read_client.conversations_members(chan_id)
        except SlackAPIError as exc:
            print(f"  [ERR] {label}: membership lookup failed: {exc.error}")
            failed_count += 1
            continue

        for uid in target_user_ids:
            if uid in members:
                print(f"  [in]  {label}: {uid} already member")
                already_in_count += 1
                continue
            if not args.apply:
                print(f"  [DRY] {label}: would invite {uid}")
                skipped_dryrun += 1
                continue
            try:
                invite_client._call(
                    "conversations.invite",
                    method="POST",
                    params={"channel": chan_id, "users": uid},
                )
                print(f"  [OK]  {label}: invited {uid}")
                invited_count += 1
            except SlackAPIError as exc:
                # `already_in_channel` is benign — race between
                # membership lookup and invite. Don't count as failure.
                if exc.error == "already_in_channel":
                    print(f"  [in]  {label}: {uid} already_in_channel")
                    already_in_count += 1
                else:
                    print(f"  [ERR] {label}: invite {uid} failed: {exc.error}")
                    failed_count += 1

    print()
    print("=" * 72)
    if args.apply:
        print(f"Invited: {invited_count}")
    else:
        print(f"Would invite: {skipped_dryrun}")
    print(f"Already member: {already_in_count}")
    print(f"Failed: {failed_count}")
    if not args.apply:
        print()
        print("(dry-run — no invites sent)")
    return 0 if not failed_count else 1


if __name__ == "__main__":
    raise SystemExit(main())
