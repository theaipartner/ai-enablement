"""One-shot backfill: ingest Slack history for every client channel.

Thin orchestrator around `ingestion.slack.pipeline.run_ingest`. Pulls
the list of client-mapped Slack channels (`slack_channels.client_id IS
NOT NULL AND is_archived = false`) from cloud DB and runs the existing
per-channel pipeline against each.

Default mode is dry-run — fetches Slack history (READ-only) and
reports per-channel counts WITHOUT inserting. `--smoke` is the same
as default but limited to one channel; `--apply` actually upserts to
`slack_messages`.

Hard-stops if any channel returns `bot_not_in_channel` — the bot needs
to be a member before history can be fetched. Run
`scripts/invite_ella_and_bot_to_client_channels.py --apply` first.

Usage:
    .venv/bin/python scripts/backfill_slack_client_channels.py            # dry-run, all channels
    .venv/bin/python scripts/backfill_slack_client_channels.py --smoke    # dry-run, FIRST channel only
    .venv/bin/python scripts/backfill_slack_client_channels.py --apply    # real upsert, all channels
    .venv/bin/python scripts/backfill_slack_client_channels.py --apply --limit 5
    .venv/bin/python scripts/backfill_slack_client_channels.py --apply --channel-id C0123ABCDEF
    .venv/bin/python scripts/backfill_slack_client_channels.py --apply --days 30

Env vars (loaded from .env.local):
  SLACK_BOT_TOKEN              — channel reads via conversations.history
  SLACK_USER_TOKEN             — optional; resolves Ella's user_id so her
                                 messages tag as author_type='ella'
  SUPABASE_URL                 — cloud DB
  SUPABASE_SERVICE_ROLE_KEY    — cloud DB
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(_REPO / ".env.local")

from ingestion.slack.client import SlackClient  # noqa: E402
from ingestion.slack.pipeline import run_ingest  # noqa: E402
from shared.db import get_client  # noqa: E402


def _fetch_client_channels(
    db,
    *,
    channel_id_filter: str | None = None,
) -> list[dict]:
    """Return [{slack_channel_id, name, client_id, full_name}]. Joins
    slack_channels → clients so we can show client names in the report."""
    q = (
        db.table("slack_channels")
        .select("slack_channel_id,name,client_id,clients(full_name)")
        .not_.is_("client_id", "null")
        .eq("is_archived", False)
    )
    if channel_id_filter:
        q = q.eq("slack_channel_id", channel_id_filter)
    resp = q.execute()
    rows = resp.data or []
    flattened: list[dict] = []
    for r in rows:
        clients = r.get("clients") or {}
        flattened.append({
            "slack_channel_id": r.get("slack_channel_id"),
            "name": r.get("name"),
            "client_id": r.get("client_id"),
            "full_name": clients.get("full_name") if isinstance(clients, dict) else None,
        })
    return flattened


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--smoke",
        action="store_true",
        help="Dry-run, single channel (the first client channel returned). "
             "Use to verify the pipeline end-to-end against the real Slack "
             "API before --apply (per CLAUDE.md backfill discipline).",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually upsert into slack_messages. Default is dry-run.",
    )
    parser.add_argument(
        "--days", type=int, default=90, help="Lookback window in days (default 90)"
    )
    parser.add_argument(
        "--limit", type=int, default=None, help="Cap channel count after filtering"
    )
    parser.add_argument(
        "--channel-id",
        default=None,
        help="Run against a single Slack channel id (debugging escape hatch)",
    )
    args = parser.parse_args()

    if args.smoke and args.apply:
        print("error: --smoke and --apply are mutually exclusive")
        return 2

    dry_run = not args.apply
    mode = "smoke" if args.smoke else ("apply" if args.apply else "dry-run")

    db = get_client()
    channels = _fetch_client_channels(db, channel_id_filter=args.channel_id)

    if args.smoke:
        # Smoke: pick the first channel only.
        channels = channels[:1]
    elif args.limit is not None:
        channels = channels[: args.limit]

    if not channels:
        print("No client channels resolved. Nothing to do.")
        return 0

    if len(channels) > 250:
        print(
            f"HARD-STOP: {len(channels)} channels exceeds the 250 sanity-check "
            "ceiling from the spec. Refusing to proceed — review the "
            "slack_channels.client_id mapping before running again."
        )
        return 3

    # Build the list of client_full_names to drive run_ingest. The
    # pipeline's existing entrypoint takes client names rather than
    # channel ids, so we leverage it as-is for parity.
    client_names = [c["full_name"] for c in channels if c.get("full_name")]
    missing = [c for c in channels if not c.get("full_name")]
    if missing:
        print(
            f"warning: {len(missing)} channel(s) had a client_id but no "
            "client.full_name match (likely orphaned). Skipping those: "
            + ", ".join(c.get("slack_channel_id", "?") for c in missing[:10])
        )

    slack = SlackClient()
    print(f"Mode: {mode}. Channels in scope: {len(client_names)}. Lookback: {args.days} days.")
    print()

    report = run_ingest(
        db,
        slack,
        client_full_names=client_names,
        extra_channel_names=[],
        days=args.days,
        dry_run=dry_run,
    )

    not_in_channel = [
        o for o in report.outcomes if o.error == "bot_not_in_channel"
    ]
    if not_in_channel:
        # Hard-stop: bot needs to be invited before we can fetch history.
        # Surface explicitly so the operator runs the invite script.
        print()
        print(
            f"HARD-STOP: {len(not_in_channel)} channel(s) returned "
            "bot_not_in_channel. Run "
            "`scripts/invite_ella_and_bot_to_client_channels.py --apply` "
            "before proceeding."
        )
        for o in not_in_channel[:10]:
            t = o.resolved
            print(f"  - {t.client_name or '?'} ({t.slack_channel_id})")
        if not args.smoke:
            return 4

    # Per-channel report.
    print()
    print("=" * 72)
    print(f"Backfill report ({mode})")
    print("=" * 72)
    total_msgs = 0
    total_inserts = 0
    total_updates = 0
    errors: list[tuple[str, str]] = []
    for outcome in report.outcomes:
        t = outcome.resolved
        label = f"{t.client_name or '?'} ({t.slack_channel_id or '?'})"
        if outcome.error:
            errors.append((label, outcome.error))
            print(f"  [ERROR] {label}: {outcome.error}")
            continue
        total_msgs += outcome.messages_in_window
        total_inserts += outcome.messages_inserted
        total_updates += outcome.messages_updated
        print(
            f"  {label}: messages={outcome.messages_in_window} "
            f"threads={outcome.threads_followed} "
            f"inserts={outcome.messages_inserted} "
            f"updates={outcome.messages_updated} "
            f"authors={dict(outcome.author_breakdown)}"
        )

    print()
    print(f"Totals: messages_in_window={total_msgs} "
          f"inserts={total_inserts} updates={total_updates}")
    print(f"Slack API calls: {report.total_api_calls}")
    if errors:
        print(f"Errors: {len(errors)}")
    if dry_run:
        print()
        print("(dry-run — no slack_messages rows written)")
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
