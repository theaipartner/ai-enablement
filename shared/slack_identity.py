"""Resolve and cache Slack user_ids behind tokens via auth.test.

Both the realtime ingestion handler and the invite helper need to know
"what user_id does this token authenticate as?" — Ella's user account
behind `SLACK_USER_TOKEN`, and the bot user behind `SLACK_BOT_TOKEN`.
Slack exposes this via `auth.test`. We call it once per token per
process and cache the result.

Cache scope: per-process, not cross-cold-start. Vercel function cold
starts re-resolve via auth.test (~100-200ms one-time cost per cold
start per token). Real cross-request caching would require a
persistent store (env var, DB, KV); not load-bearing at our volume
because each cold start makes one extra Slack API call before the
cache fills, and warm invocations skip the call entirely.

Reuses `ingestion.slack.client.SlackClient` for transport so retry +
backoff parity holds with the rest of the Slack ingestion stack.
"""

from __future__ import annotations

from ingestion.slack.client import SlackAPIError, SlackClient

# Module-scope cache. Keys are tokens (the secret); values are the
# resolved user_id. Tokens stay in memory only — never logged, never
# written to any persistent surface.
_USER_ID_CACHE: dict[str, str] = {}


def get_user_id_for_token(token: str | None) -> str | None:
    """Return the Slack user_id behind `token`, or None if unresolvable.

    Returns None on:
      - missing/empty token (caller passed None or "")
      - auth.test returns ok=false (invalid token, revoked, etc.)
      - any transport-level failure (network, timeout)

    Never raises. Caller treats None as "couldn't resolve" and falls
    through to whatever default behavior makes sense (parser passes
    None ella_user_id → no `'ella'` author_type tagging, fine; invite
    script bails with an explicit error).
    """
    if not token:
        return None
    cached = _USER_ID_CACHE.get(token)
    if cached is not None:
        return cached
    try:
        client = SlackClient(token=token)
    except RuntimeError:
        # Token validation in SlackClient.__init__ — only triggers when
        # token is None/empty, which we already handled above. Defensive.
        return None
    try:
        result = client.auth_test()
    except SlackAPIError:
        return None
    except Exception:
        return None
    finally:
        try:
            client.close()
        except Exception:
            pass
    user_id = result.get("user_id")
    if not user_id:
        return None
    _USER_ID_CACHE[token] = user_id
    return user_id


def _clear_cache_for_tests() -> None:
    """Clear the module cache. Test-only utility — the production code
    has no need to flush since tokens don't change at runtime."""
    _USER_ID_CACHE.clear()
