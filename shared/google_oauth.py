"""Google OAuth token refresh + valid-access-token resolution for the
Python side (the Teams calendar-sync cron). Mirrors the TypeScript
helpers in `lib/google/oauth.ts` so the OAuth-token row written by the
Next.js callback route is consumable from the Python cron without an
extra round trip through a TS endpoint.

The Next.js connect / callback routes mint and persist tokens; the
Python cron reads + refreshes them. Single canonical token row per
(team_member_id, provider) keyed by the unique index from migration
0033.

No SDK dependency — `urllib.request` directly, matching
`shared/slack_post.py`'s deliberate posture. The Google token endpoint
is a single form-encoded POST.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any

from shared.db import get_client

logger = logging.getLogger("ai_enablement.google_oauth")

_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly"

# Refresh tokens this many seconds BEFORE the stored access_token's
# nominal expiry. Absorbs cron-tick latency so the token doesn't
# expire mid-sync.
_ACCESS_TOKEN_REFRESH_BUFFER_SECONDS = 60

# HTTP timeout for the token refresh round trip. Generous; Google's
# token endpoint is reliable but the cron should fail fast if it stalls.
_TOKEN_REFRESH_TIMEOUT_SECONDS = 10.0


class GoogleOAuthError(Exception):
    """Raised when the cron can't get a usable access token. Caller
    audits the failure and skips this tick — does not crash the whole
    sync."""


def get_valid_access_token(team_member_id: str) -> str:
    """Read the stored token row, refresh if expired, return a live
    access_token string.

    Raises `GoogleOAuthError` when:
      - no oauth_tokens row exists for (team_member_id, 'google')
      - the refresh fails (Google returned non-2xx, token revoked, etc.)
      - the DB update after a successful refresh fails

    The cron catches this exception, audits, and stops the sync for the
    tick; the /teams page surfaces a reconnect banner so Drake can
    re-OAuth.
    """
    db = get_client()
    resp = (
        db.table("oauth_tokens")
        .select("access_token,refresh_token,access_token_expires_at")
        .eq("team_member_id", team_member_id)
        .eq("provider", "google")
        .limit(1)
        .execute()
    )
    rows = resp.data or []
    if not rows:
        raise GoogleOAuthError(
            f"no oauth_tokens row for team_member_id={team_member_id} provider=google"
        )
    row = rows[0]

    expires_at = _parse_iso(row["access_token_expires_at"])
    now = datetime.now(timezone.utc)
    if (expires_at - now).total_seconds() > _ACCESS_TOKEN_REFRESH_BUFFER_SECONDS:
        return row["access_token"]

    refreshed = _refresh_access_token(row["refresh_token"])
    new_expires_at = (
        now + timedelta(seconds=refreshed["expires_in"])
    ).isoformat()
    try:
        (
            db.table("oauth_tokens")
            .update(
                {
                    "access_token": refreshed["access_token"],
                    "access_token_expires_at": new_expires_at,
                    "scope": refreshed.get("scope") or _CALENDAR_SCOPE,
                    "updated_at": now.isoformat(),
                }
            )
            .eq("team_member_id", team_member_id)
            .eq("provider", "google")
            .execute()
        )
    except Exception as exc:
        raise GoogleOAuthError(
            f"oauth_tokens update after refresh failed: {exc}"
        ) from exc
    return refreshed["access_token"]


def _refresh_access_token(refresh_token: str) -> dict[str, Any]:
    """POST refresh_token to Google's /token endpoint. Returns the
    parsed JSON body. Raises `GoogleOAuthError` on any non-2xx or
    transport-level failure."""
    client_id = os.environ.get("GOOGLE_OAUTH_CLIENT_ID")
    client_secret = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise GoogleOAuthError(
            "GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET not configured"
        )

    body = urllib.parse.urlencode(
        {
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        _GOOGLE_TOKEN_URL,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=_TOKEN_REFRESH_TIMEOUT_SECONDS) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        # Read the body for context but DON'T log it — could contain a
        # client_secret echo on misconfiguration. Surface only the
        # status code.
        raise GoogleOAuthError(
            f"google token refresh returned http {exc.code}"
        ) from exc
    except Exception as exc:
        raise GoogleOAuthError(
            f"google token refresh transport error: {type(exc).__name__}"
        ) from exc

    if "access_token" not in payload or "expires_in" not in payload:
        raise GoogleOAuthError(
            "google token refresh response missing access_token or expires_in"
        )
    return payload


def _parse_iso(s: str) -> datetime:
    """Parse a Postgres timestamptz ISO string into an aware datetime.
    Postgres emits e.g. '2026-05-14T12:34:56.789+00:00' which
    `fromisoformat` accepts since Python 3.11."""
    return datetime.fromisoformat(s)
