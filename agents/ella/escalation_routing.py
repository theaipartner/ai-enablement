"""Shared escalation-DM fan-out for Ella's reactive and passive paths.

Both Ella escalation paths now route DMs to the same recipient set: the
channel's primary CSM PLUS a configured head-CSM recipient (Scott today,
identified by env var `ESCALATION_RECIPIENT_SLACK_USER_ID`). Pulling the
fan-out into a shared module is the only way the two paths can stay
truly identical going forward — the body, the audit-row pattern, and the
recipient list all live here.

Public surface:

  - `resolve_escalation_recipients(primary_csm)` → deduplicated list of
    recipients to DM. Order: Scott first when configured, primary CSM
    second. De-duplicates when Scott IS the primary CSM (one DM, not two).

  - `fire_escalation_dms(recipients, slack_channel_id, ...)` → fires one
    DM per recipient and writes one `webhook_deliveries` audit row per
    recipient under `source='ella_escalation_dm'`.

Audit source rename: pre-2026-05-14 passive escalations landed under
`'ella_passive_escalation_dm'`; the unified source label is
`'ella_escalation_dm'`. Historical rows under the old label remain
queryable — the dashboard's `lib/db/ella-runs.ts:fetchEscalationBodies`
accepts both during the transition.
"""

from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any

from shared.db import get_client
from shared.slack_post import post_message

logger = logging.getLogger("ai_enablement.ella.escalation_routing")

# Env var carrying Scott's slack_user_id. Unset → only primary_csm is
# DMed; escalations still fire, Scott is silently not CC'd. Safer
# fallback per the spec — never raise on missing env var.
_RECIPIENT_ENV_VAR = "ESCALATION_RECIPIENT_SLACK_USER_ID"

# Unified audit-ledger source label used for both reactive and passive
# escalation DMs. Renamed from `ella_passive_escalation_dm` on
# 2026-05-14; the dashboard's escalation-body fetcher accepts both
# labels so historical rows continue to render.
_ESCALATION_DM_SOURCE = "ella_escalation_dm"

# Truncation cap on the reasoning section of the DM body. Matches the
# pre-existing passive-DM cap so cross-path DMs stay visually identical.
_DM_REASONING_TRUNC = 200


def resolve_escalation_recipients(
    primary_csm: dict[str, Any] | None,
) -> list[dict[str, str]]:
    """Build the deduplicated recipient list for an escalation DM.

    Each returned dict carries:
      - `slack_user_id`: the Slack user_id to DM
      - `label`: a human-readable name for log lines and audit rows
      - `source`: `"scott"` or `"primary_csm"` so audit rows can split
        head-CSM coverage from primary-CSM coverage

    Order: Scott first when configured, primary CSM second. Deduplicates
    when Scott IS the channel's primary CSM (one DM with `source="scott"`
    wins; the primary_csm entry is dropped).

    Edge cases:
      - Scott env unset, primary_csm present → `[primary_csm]`
      - Scott env set, primary_csm None → `[scott]`
      - Scott env unset, primary_csm None → `[]` (logs warning; caller
        must tolerate an empty recipient list — escalations row still
        gets written, but no one is DMed)
    """
    recipients: list[dict[str, str]] = []

    scott_id = (os.environ.get(_RECIPIENT_ENV_VAR) or "").strip()
    if scott_id:
        # Best-effort name lookup for the audit-row label. Falls back to
        # "Scott" on any error so a slow / missing team_members row
        # doesn't break the fan-out.
        scott_label = _lookup_team_member_label(scott_id) or "Scott"
        recipients.append(
            {
                "slack_user_id": scott_id,
                "label": scott_label,
                "source": "scott",
            }
        )

    primary_csm_id = (primary_csm or {}).get("slack_user_id")
    if primary_csm_id and primary_csm_id != scott_id:
        recipients.append(
            {
                "slack_user_id": primary_csm_id,
                "label": (primary_csm or {}).get("full_name") or "primary CSM",
                "source": "primary_csm",
            }
        )

    if not recipients:
        logger.warning(
            "escalation_routing: no recipients resolved — env var %s unset "
            "and primary_csm missing slack_user_id",
            _RECIPIENT_ENV_VAR,
        )

    return recipients


def fire_escalation_dms(
    *,
    recipients: list[dict[str, str]],
    slack_channel_id: str,
    triggering_message_ts: str,
    reasoning: str,
    path: str,  # "reactive" | "passive"
    channel_client_id: str | None = None,
) -> list[dict[str, Any]]:
    """Fire one DM per recipient and write per-recipient audit rows.

    Returns a list of per-recipient result dicts:
      {"slack_user_id", "label", "source", "dm_ok", "slack_error",
       "delivery_id"}

    A failure on one recipient (Slack returns ok=False, bot not in DM,
    etc.) doesn't short-circuit the others — each recipient gets its
    own audit row + own DM attempt so a partial failure stays visible.

    `path` is persisted on the audit row's payload so post-hoc queries
    can separate reactive escalations from passive ones without having
    to join back to `agent_runs.trigger_type`.

    Empty `recipients` returns `[]` with no audit rows and no errors —
    callers (passive_dispatch.py's escalate branch with no env var and
    no primary_csm) get a clean no-op rather than an exception.
    """
    if not recipients:
        return []

    link = _build_message_permalink(slack_channel_id, triggering_message_ts)
    body = _build_dm_body(link, reasoning)

    db = get_client()
    results: list[dict[str, Any]] = []
    for recipient in recipients:
        delivery_id = f"ella_escalation_{uuid.uuid4()}"
        audit_payload: dict[str, Any] = {
            "slack_channel_id": slack_channel_id,
            "triggering_message_ts": triggering_message_ts,
            "recipient_slack_user_id": recipient["slack_user_id"],
            "recipient_label": recipient["label"],
            "recipient_source": recipient["source"],
            "path": path,
            "reasoning": reasoning,
            "body": body,
        }
        if channel_client_id is not None:
            audit_payload["channel_client_id"] = channel_client_id
        _insert_dm_audit(db, delivery_id, audit_payload, status="received")

        result = post_message(recipient["slack_user_id"], body)
        _mark_dm_audit(
            db,
            delivery_id,
            status="processed" if result["ok"] else "failed",
            error=(
                None
                if result["ok"]
                else f"slack_post_failed: {result.get('slack_error')}"
            ),
        )
        results.append(
            {
                "slack_user_id": recipient["slack_user_id"],
                "label": recipient["label"],
                "source": recipient["source"],
                "dm_ok": bool(result["ok"]),
                "slack_error": result.get("slack_error"),
                "delivery_id": delivery_id,
            }
        )

    return results


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _lookup_team_member_label(slack_user_id: str) -> str | None:
    """Look up `team_members.full_name` for the audit-row label.

    Best-effort — any exception (network blip, missing row) returns None
    and the caller falls back to a sensible default. This is purely a
    label resolution, never load-bearing for delivery.
    """
    try:
        db = get_client()
        resp = (
            db.table("team_members")
            .select("full_name")
            .eq("slack_user_id", slack_user_id)
            .limit(1)
            .execute()
        )
        rows = resp.data or []
        return rows[0].get("full_name") if rows else None
    except Exception as exc:
        logger.warning(
            "escalation_routing: team_members lookup failed for %s: %s",
            slack_user_id,
            exc,
        )
        return None


def _build_message_permalink(slack_channel_id: str, slack_ts: str) -> str:
    """Slack permalink: `https://<workspace>.slack.com/archives/<ch>/p<ts>`.

    Mirrors `passive_dispatch._build_message_permalink` so DMs across
    paths render visually identical links. Workspace subdomain is
    optional; omitting it still resolves when clicked from inside a
    logged-in Slack workspace.
    """
    workspace = os.environ.get("SLACK_WORKSPACE") or ""
    ts_compact = slack_ts.replace(".", "")
    subdomain = f"{workspace}." if workspace else ""
    return f"https://{subdomain}slack.com/archives/{slack_channel_id}/p{ts_compact}"


def _build_dm_body(permalink: str, reasoning: str) -> str:
    """Single canonical DM body used for every escalation DM.

    Matches the pre-existing passive-path body shape so the rename to a
    unified source label is a no-op for the dashboard's body renderer.
    """
    truncated = (reasoning or "")[:_DM_REASONING_TRUNC]
    return (
        f":eyes: Worth a look — <{permalink}>\n"
        f"_Ella escalated this. Reasoning: {truncated}_"
    )


def _insert_dm_audit(
    db, delivery_id: str, payload: dict[str, Any], *, status: str
) -> None:
    try:
        row: dict[str, Any] = {
            "webhook_id": delivery_id,
            "source": _ESCALATION_DM_SOURCE,
            "processing_status": status,
            "payload": payload,
            "headers": {},
        }
        if status != "received":
            row["processed_at"] = datetime.now(timezone.utc).isoformat()
        db.table("webhook_deliveries").insert(row).execute()
    except Exception as exc:
        logger.warning(
            "escalation_routing: audit insert failed delivery_id=%s: %s",
            delivery_id,
            exc,
        )


def _mark_dm_audit(
    db,
    delivery_id: str,
    *,
    status: str,
    error: str | None,
) -> None:
    try:
        update: dict[str, Any] = {
            "processing_status": status,
            "processed_at": datetime.now(timezone.utc).isoformat(),
        }
        if error is not None:
            update["processing_error"] = error[:2000]
        db.table("webhook_deliveries").update(update).eq(
            "webhook_id", delivery_id
        ).execute()
    except Exception as exc:
        logger.warning(
            "escalation_routing: audit update failed delivery_id=%s: %s",
            delivery_id,
            exc,
        )
