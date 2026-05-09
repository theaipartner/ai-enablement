"""Per-channel Slack history backfill pipeline.

Inputs (one run):
  - Target client full names (from the `clients` table) — each maps
    to a `slack_channels` row via client_id.
  - Extra channel names (e.g. `ella-test`) — resolved via Slack's
    `conversations.list` API and materialized in `slack_channels`
    with `client_id=null` if missing.

Per resolved channel:
  1. Verify the bot is a member (`conversations.members` contains the
     bot's own user id, pulled once via `auth.test`). If not: report
     as `not_in_channel`, skip ingestion. Never silently skip.
  2. Fetch the last `days` of messages via `conversations.history`
     (auto-paginated).
  3. For every message that is a thread parent (reply_count > 0),
     follow `conversations.replies` to pull the full thread.
  4. Parse raw events into `SlackMessageRecord`s, with author type
     resolved from pre-fetched `clients.slack_user_id` and
     `team_members.slack_user_id` sets, plus an optional `ella_user_id`
     (Ella V2 Batch 1) so her own posts get `author_type='ella'` even
     if her account is also in `team_members`.
  5. On `--apply`, upsert to `slack_messages` keyed on
     `(slack_channel_id, slack_ts)`. Reports counts of new vs
     refreshed rows by pre-querying the existing ts set.

Idempotent — re-running updates existing rows (refreshes text,
raw_payload) without duplicating.

No embeddings today. Slack messages live in `slack_messages` only;
retrieval wiring via `document_chunks` is deferred to V1.1.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

from ingestion.slack.client import (
    SlackClient,
    SlackAPIError,
    SlackNotInChannel,
    find_channel_by_name,
)
from ingestion.slack.parser import SlackMessageRecord, parse_message
from shared.logging import logger
from shared.slack_identity import get_user_id_for_token


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass
class ResolvedChannel:
    """A target after DB + Slack-side resolution."""

    identifier: str                   # user-supplied target (client name or channel name)
    slack_channel_id: str | None = None
    name: str | None = None           # Slack channel name (no leading #)
    client_id: str | None = None
    client_name: str | None = None
    db_row_exists: bool = False
    bot_is_member: bool = False
    resolution_error: str | None = None

    @property
    def resolved(self) -> bool:
        return self.slack_channel_id is not None and self.resolution_error is None


@dataclass
class ChannelIngestOutcome:
    """What happened for one channel during a single run."""

    resolved: ResolvedChannel
    messages_in_window: int = 0
    threads_followed: int = 0
    author_breakdown: dict[str, int] = field(default_factory=dict)
    subtype_counts: dict[str, int] = field(default_factory=dict)
    unresolved_author_count: int = 0
    messages_inserted: int = 0
    messages_updated: int = 0
    error: str | None = None
    sample_records: list[SlackMessageRecord] = field(default_factory=list)


@dataclass
class RunReport:
    targets: list[ResolvedChannel] = field(default_factory=list)
    outcomes: list[ChannelIngestOutcome] = field(default_factory=list)
    bot_user_id: str | None = None
    total_api_calls: int = 0


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def run_ingest(
    db,
    slack_client: SlackClient,
    *,
    client_full_names: list[str],
    extra_channel_names: list[str],
    days: int = 90,
    dry_run: bool = True,
    sample_count: int = 5,
) -> RunReport:
    """End-to-end backfill run. See module docstring."""
    report = RunReport()

    auth = slack_client.auth_test()
    report.bot_user_id = auth.get("user_id")

    client_resolver, team_resolver = _load_resolvers(db)

    # Ella V2 Batch 1: resolve Ella's user_id behind SLACK_USER_TOKEN so
    # her posts ingest with author_type='ella' rather than 'team_member'.
    # Token may be unset in local-dev environments — `get_user_id_for_token`
    # returns None, which the parser already accepts.
    ella_user_id = get_user_id_for_token(os.environ.get("SLACK_USER_TOKEN"))

    # Resolve all targets upfront so the dry-run can surface
    # unresolved ones as blockers before any history fetch.
    for name in client_full_names:
        report.targets.append(_resolve_client_target(db, name))
    for channel_name in extra_channel_names:
        report.targets.append(
            _resolve_channel_name_target(db, slack_client, channel_name, dry_run=dry_run)
        )

    # Membership check — only for targets that resolved to a slack_channel_id.
    for target in report.targets:
        if not target.resolved:
            continue
        target.bot_is_member = _check_bot_membership(
            slack_client, target.slack_channel_id, report.bot_user_id
        )

    oldest_ts = _ts_n_days_ago(days)

    for target in report.targets:
        outcome = ChannelIngestOutcome(resolved=target)
        report.outcomes.append(outcome)

        if not target.resolved:
            outcome.error = target.resolution_error or "unresolved"
            continue
        if not target.bot_is_member:
            outcome.error = "bot_not_in_channel"
            continue

        try:
            records, threads_followed = _collect_messages(
                slack_client, target.slack_channel_id, oldest_ts,
                client_user_ids=client_resolver,
                team_user_ids=team_resolver,
                ella_user_id=ella_user_id,
            )
        except SlackAPIError as exc:
            outcome.error = f"slack_api_error:{exc.error}"
            continue

        outcome.messages_in_window = len(records)
        outcome.threads_followed = threads_followed
        outcome.author_breakdown = _count_author_types(records)
        outcome.subtype_counts = _count_subtypes(records)
        outcome.unresolved_author_count = outcome.author_breakdown.get("unknown", 0)
        outcome.sample_records = records[:sample_count]

        if dry_run or not records:
            continue

        inserts, updates = _upsert_messages(db, target.slack_channel_id, records)
        outcome.messages_inserted = inserts
        outcome.messages_updated = updates

    report.total_api_calls = slack_client.calls_made
    return report


# ---------------------------------------------------------------------------
# Resolvers — pre-fetch known Slack user ids
# ---------------------------------------------------------------------------


def _load_resolvers(db) -> tuple[set[str], set[str]]:
    """Return (client_user_ids, team_user_ids) sets for author resolution."""
    c = db.table("clients").select("slack_user_id").is_("archived_at", "null").execute()
    clients = {row["slack_user_id"] for row in (c.data or []) if row.get("slack_user_id")}
    t = db.table("team_members").select("slack_user_id").is_("archived_at", "null").execute()
    teams = {row["slack_user_id"] for row in (t.data or []) if row.get("slack_user_id")}
    return clients, teams


# ---------------------------------------------------------------------------
# Target resolution
# ---------------------------------------------------------------------------


def _resolve_client_target(db, client_full_name: str) -> ResolvedChannel:
    """Join clients → slack_channels for the given client full name."""
    resp = (
        db.table("clients")
        .select("id,full_name")
        .eq("full_name", client_full_name)
        .is_("archived_at", "null")
        .execute()
    )
    matches = resp.data or []
    if not matches:
        return ResolvedChannel(
            identifier=client_full_name,
            resolution_error=f"client_not_found: {client_full_name}",
        )
    client = matches[0]
    ch_resp = (
        db.table("slack_channels")
        .select("id,slack_channel_id,name,client_id")
        .eq("client_id", client["id"])
        .execute()
    )
    channels = ch_resp.data or []
    if not channels:
        return ResolvedChannel(
            identifier=client_full_name,
            client_id=client["id"],
            client_name=client["full_name"],
            resolution_error=f"no_slack_channel_for_client: {client_full_name}",
        )
    ch = channels[0]
    return ResolvedChannel(
        identifier=client_full_name,
        slack_channel_id=ch["slack_channel_id"],
        name=ch["name"],
        client_id=client["id"],
        client_name=client["full_name"],
        db_row_exists=True,
    )


def _resolve_channel_name_target(
    db, slack_client: SlackClient, channel_name: str, *, dry_run: bool
) -> ResolvedChannel:
    """Look up a channel by Slack name (e.g. `ella-test`).

    On `--apply`, materializes a minimal `slack_channels` row with
    `client_id=null` so downstream queries can join against it. On
    dry-run, reports the Slack-side ID without inserting.
    """
    name_clean = channel_name.lstrip("#")
    channel = find_channel_by_name(slack_client, name_clean)
    if channel is None:
        return ResolvedChannel(
            identifier=channel_name,
            resolution_error=f"channel_not_found_in_slack: {channel_name}",
        )

    slack_channel_id = channel["id"]
    existing = (
        db.table("slack_channels")
        .select("id")
        .eq("slack_channel_id", slack_channel_id)
        .execute()
    )
    db_row_exists = bool(existing.data)

    if not db_row_exists and not dry_run:
        db.table("slack_channels").insert({
            "slack_channel_id": slack_channel_id,
            "name": name_clean,
            "is_private": channel.get("is_private", False),
            "is_archived": channel.get("is_archived", False),
            "client_id": None,
            "ella_enabled": False,
        }).execute()
        db_row_exists = True

    return ResolvedChannel(
        identifier=channel_name,
        slack_channel_id=slack_channel_id,
        name=name_clean,
        db_row_exists=db_row_exists,
    )


# ---------------------------------------------------------------------------
# Membership
# ---------------------------------------------------------------------------


def _check_bot_membership(
    slack_client: SlackClient, channel_id: str, bot_user_id: str | None
) -> bool:
    if not bot_user_id:
        return False
    try:
        members = slack_client.conversations_members(channel_id)
    except SlackAPIError as exc:
        logger.warning(
            "Membership lookup failed for %s: %s", channel_id, exc.error
        )
        return False
    return bot_user_id in members


# ---------------------------------------------------------------------------
# Message collection (history + thread replies)
# ---------------------------------------------------------------------------


def _collect_messages(
    slack_client: SlackClient,
    channel_id: str,
    oldest_ts: str,
    *,
    client_user_ids: set[str],
    team_user_ids: set[str],
    ella_user_id: str | None = None,
) -> tuple[list[SlackMessageRecord], int]:
    """Return (all_records, threads_followed_count)."""
    records: list[SlackMessageRecord] = []
    thread_parent_tss: list[str] = []

    for event in slack_client.conversations_history(channel_id, oldest=oldest_ts):
        record = parse_message(
            event,
            channel_id=channel_id,
            client_user_ids=client_user_ids,
            team_user_ids=team_user_ids,
            ella_user_id=ella_user_id,
        )
        if record is None:
            continue
        records.append(record)
        if record.is_thread_parent:
            thread_parent_tss.append(record.slack_ts)

    threads_followed = 0
    for parent_ts in thread_parent_tss:
        try:
            for event in slack_client.conversations_replies(channel_id, parent_ts):
                if event.get("ts") == parent_ts:
                    continue
                record = parse_message(
                    event,
                    channel_id=channel_id,
                    client_user_ids=client_user_ids,
                    team_user_ids=team_user_ids,
                    ella_user_id=ella_user_id,
                )
                if record is not None:
                    records.append(record)
        except SlackAPIError as exc:
            logger.warning(
                "thread replies failed for %s ts=%s: %s",
                channel_id, parent_ts, exc.error,
            )
            continue
        threads_followed += 1

    # Dedupe by slack_ts. conversations.history can sometimes surface
    # thread replies as standalone messages in the 90-day window; then
    # conversations.replies surfaces the same reply. The upsert would
    # otherwise hit Postgres's "ON CONFLICT DO UPDATE cannot affect row
    # a second time" within a single batch. Last-occurrence wins so
    # reply-side metadata (which is more complete) beats history-side.
    deduped: dict[str, SlackMessageRecord] = {}
    for r in records:
        deduped[r.slack_ts] = r
    return list(deduped.values()), threads_followed


# ---------------------------------------------------------------------------
# Upsert
# ---------------------------------------------------------------------------


def _upsert_messages(
    db, channel_id: str, records: list[SlackMessageRecord]
) -> tuple[int, int]:
    """Upsert records; return (inserts, updates) based on pre-fetched ts set.

    The existing-ts fetch intentionally scopes by channel only (not by
    the ts list) — stuffing hundreds of ts values into an `in_()`
    filter produces URL-too-long 414s on busier channels. Fetching all
    existing ts for the channel is ~1000 rows max at V1 scale.
    """
    if not records:
        return 0, 0

    existing_resp = (
        db.table("slack_messages")
        .select("slack_ts")
        .eq("slack_channel_id", channel_id)
        .execute()
    )
    existing_ts = {row["slack_ts"] for row in (existing_resp.data or [])}

    # Upsert in batches. PostgREST has a request-size ceiling — large
    # payloads can hit the same URI-too-long / 413 Payload-Too-Large
    # issues. 250 rows/batch is comfortably under the default limit.
    payloads = [_record_to_payload(r) for r in records]
    batch_size = 250
    for start in range(0, len(payloads), batch_size):
        batch = payloads[start : start + batch_size]
        db.table("slack_messages").upsert(
            batch, on_conflict="slack_channel_id,slack_ts"
        ).execute()

    inserts = sum(1 for r in records if r.slack_ts not in existing_ts)
    updates = len(records) - inserts
    return inserts, updates


def _record_to_payload(record: SlackMessageRecord) -> dict[str, Any]:
    return {
        "slack_channel_id": record.slack_channel_id,
        "slack_ts": record.slack_ts,
        "slack_thread_ts": record.slack_thread_ts,
        "slack_user_id": record.slack_user_id,
        "author_type": record.author_type,
        "text": record.text,
        "message_type": record.message_type,
        "message_subtype": record.message_subtype,
        "raw_payload": record.raw_payload,
        "sent_at": record.sent_at.isoformat(),
    }


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _ts_n_days_ago(days: int) -> str:
    """Slack `oldest` param expects a decimal-seconds timestamp."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    return f"{cutoff.timestamp():.6f}"


def _count_author_types(records: Iterable[SlackMessageRecord]) -> dict[str, int]:
    out: dict[str, int] = {}
    for r in records:
        out[r.author_type] = out.get(r.author_type, 0) + 1
    return out


def _count_subtypes(records: Iterable[SlackMessageRecord]) -> dict[str, int]:
    out: dict[str, int] = {}
    for r in records:
        if r.message_subtype:
            out[r.message_subtype] = out.get(r.message_subtype, 0) + 1
    return out
