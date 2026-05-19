"""Shared Slack chat.postMessage helpers.

Two public surfaces:

  - `call_chat_post_message(token, body)` — low-level transport.
    Single POST to https://slack.com/api/chat.postMessage with the
    given token + body. Returns `(ok, slack_error, ts)` on Slack-side
    success/non-error (`ts` is the posted message's Slack timestamp on
    success, else None), raises on transport-level failure (HTTP
    non-2xx, network timeout, JSON decode error). Tokens are held
    only in the Authorization header — never logged, never returned.
    Used by api/slack_events.py's two-token Ella post path AND by
    `post_message` below.

  - `post_message(channel_id, text, *, thread_ts=None, blocks=None)`
    — high-level helper for internal-CS Slack posts (per-call
    summaries, daily accountability notifications, future cron
    alerts). Uses `SLACK_BOT_TOKEN` only; no user-token fallback
    because internal channels don't need APP-tag suppression. Returns
    a dict `{"ok": bool, "slack_error": str | None, "ts": str | None}`
    so callers can log + continue without try/except wrapping each
    call. `ts` is the posted message's Slack timestamp on success
    (used for audit trails / future post-edit features), else None.

Why two surfaces? Ella's M1.4 two-token strategy (try user token,
fall back to bot) is specifically about client-channel rendering —
internal CS bot channels don't need it. Forcing the new code paths
through the two-token logic would couple them to env-var-presence
behavior that's irrelevant to their use case. The low-level helper
stays shared; the high-level wrappers diverge by concern.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.request
from typing import Any


# Match the existing Ella post path's timeout. 5 seconds is short
# enough to surface transport problems quickly and long enough for
# a single chat.postMessage call to land at p99.
_SLACK_POST_TIMEOUT_SECONDS = 5.0

logger = logging.getLogger("ai_enablement.slack_post")


# ---------------------------------------------------------------------------
# Low-level transport
# ---------------------------------------------------------------------------


def call_chat_post_message(
    token: str, body: dict[str, Any]
) -> tuple[bool, str | None, str | None]:
    """Make one POST to chat.postMessage with the given token.

    Returns `(ok, slack_error, ts)`:
      - `ok=True, slack_error=None, ts=<message ts>` on Slack-side
        success (`ts` is the posted message's Slack timestamp).
      - `ok=False, slack_error=<code>, ts=None` on HTTP 200 with
        `ok=false` (e.g., `missing_scope`, `not_in_channel`,
        `channel_not_found`).
      - Raises on transport-level failure (HTTP non-2xx, network
        timeout, JSON decode error). The caller decides whether to
        fall through to a different token.

    The token is held only in the Authorization header sent to Slack;
    never logged, never appears in any returned value.
    """
    req = urllib.request.Request(
        "https://slack.com/api/chat.postMessage",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=_SLACK_POST_TIMEOUT_SECONDS) as resp:
        response_body = resp.read().decode("utf-8")
    parsed = json.loads(response_body)
    return bool(parsed.get("ok")), parsed.get("error"), parsed.get("ts")


# ---------------------------------------------------------------------------
# High-level helper for internal-CS posts (CS call summary, accountability
# cron, future alerts)
# ---------------------------------------------------------------------------


def post_message(
    channel_id: str,
    text: str,
    *,
    thread_ts: str | None = None,
    blocks: list | None = None,
) -> dict[str, Any]:
    """Post a message to a Slack channel via chat.postMessage with
    `SLACK_BOT_TOKEN`. Catches all transport-level exceptions and
    returns a structured result so callers can log + continue without
    wrapping every call in try/except.

    Returns:
      `{"ok": True, "slack_error": None, "ts": "<ts>"}` on Slack-side
      success.
      `{"ok": False, "slack_error": "<code>", "ts": None}` on
      `ok=false` from Slack (missing_scope, not_in_channel,
      channel_not_found, etc.) OR on transport-level failure (where
      slack_error is the exception type name + message).
      `{"ok": False, "slack_error": "missing_bot_token", "ts": None}`
      when env var is unset.

    NEVER raises. Callers can rely on this for fire-and-forget posts
    where a failure shouldn't propagate up the call stack.
    """
    bot_token = os.environ.get("SLACK_BOT_TOKEN")
    if not bot_token:
        logger.error("slack_post: SLACK_BOT_TOKEN not configured")
        return {"ok": False, "slack_error": "missing_bot_token", "ts": None}

    body: dict[str, Any] = {"channel": channel_id, "text": text}
    if thread_ts:
        body["thread_ts"] = thread_ts
    if blocks:
        body["blocks"] = blocks

    try:
        ok, slack_error, ts = call_chat_post_message(bot_token, body)
        if ok:
            logger.info("slack_post: ok channel=%s thread_ts=%s", channel_id, thread_ts)
            return {"ok": True, "slack_error": None, "ts": ts}
        logger.warning(
            "slack_post: ok=false channel=%s slack_error=%s",
            channel_id,
            slack_error,
        )
        return {"ok": False, "slack_error": slack_error, "ts": None}
    except Exception as exc:
        # Transport-level failure: HTTP non-2xx, timeout, JSON decode
        # error. Log + return — never propagate. Per the contract this
        # function is fire-and-forget safe.
        logger.warning(
            "slack_post: transport failure channel=%s exc_type=%s exc=%s",
            channel_id,
            type(exc).__name__,
            exc,
        )
        return {
            "ok": False,
            "slack_error": f"{type(exc).__name__}: {exc}",
            "ts": None,
        }
