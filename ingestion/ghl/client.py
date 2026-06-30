"""GoHighLevel (LeadConnector) v2 REST client — auth + paginated reads.

Read-only — never POSTs/PUTs to GHL (Principles 1-2: our DB is the source of
truth; the mirror only reads). Uses stdlib `urllib` (same pattern as the Close
client) to avoid a new dependency.

Auth (verified in discovery against sub-account "Digital College"):
  * Base URL: https://services.leadconnectorhq.com
  * Header `Authorization: Bearer <GHL_PRIVATE_TOKEN>` — a Private Integration
    Token (PIT), location-scoped, read-only scopes only.
  * Header `Version: 2021-07-28` (required by every v2 endpoint).
  * Most endpoints require the `locationId` as a query/path param even with a
    location-scoped token — hence GHL_LOCATION_ID.

GOTCHA (cost us a discovery detour): GHL's WAF returns **403 Forbidden** to
requests with no `User-Agent` (stdlib urllib's default UA is blocked). We always
send a UA. With the UA set, a 403 is a *genuine* scope/permission error (raise,
don't retry); a 429 is rate limiting (retry with backoff).

Env vars (loaded from .env.local via shared.db's dotenv side-effect):
  GHL_PRIVATE_TOKEN   — the Private Integration Token (read-only scopes)
  GHL_LOCATION_ID     — the sub-account / location id
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any, Iterator
from urllib.parse import urlencode

from shared.logging import logger

BASE_URL = "https://services.leadconnectorhq.com"
API_VERSION = "2021-07-28"
USER_AGENT = "ai-enablement-ghl-mirror/1.0"

DEFAULT_TIMEOUT_S = 60.0
MAX_RETRIES = 4

# Top-level /contacts/ paginator safety ceiling (100/page). 1.2k contacts today;
# 300 pages = 30k leaves ample headroom before the search API is the better tool.
PAGINATION_SAFETY_MAX_PAGES = 300


class GHLAPIError(RuntimeError):
    """Raised for any non-2xx, non-handled-retry HTTP response."""


class GHLClient:
    """Thin wrapper around the GHL v2 REST API (read-only).

    Use `from_env()` in the pipeline and tests.
    """

    def __init__(
        self, token: str, location_id: str, timeout_s: float = DEFAULT_TIMEOUT_S
    ):
        if not token:
            raise RuntimeError(
                "GHLClient requires a non-empty token. Set GHL_PRIVATE_TOKEN in "
                ".env.local (a read-only Private Integration Token)."
            )
        if not location_id:
            raise RuntimeError(
                "GHLClient requires a location_id. Set GHL_LOCATION_ID in "
                ".env.local (the sub-account id, e.g. from the GHL URL /location/<id>/)."
            )
        self._token = token
        self.location_id = location_id
        self._timeout = timeout_s

    @classmethod
    def from_env(cls) -> "GHLClient":
        token = os.getenv("GHL_PRIVATE_TOKEN")
        loc = os.getenv("GHL_LOCATION_ID")
        if not token or not loc:
            missing = [
                n
                for n, v in (("GHL_PRIVATE_TOKEN", token), ("GHL_LOCATION_ID", loc))
                if not v
            ]
            raise RuntimeError(
                f"GHL env vars missing: {', '.join(missing)}. Set them in .env.local "
                "(Private Integration token + sub-account location id)."
            )
        return cls(token=token, location_id=loc)

    # ------------------------------------------------------------------
    # Low-level request
    # ------------------------------------------------------------------

    def _request(
        self, path: str, *, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        url = f"{BASE_URL}{path}"
        if params:
            url = f"{url}?{urlencode(params)}"
        headers = {
            "Authorization": f"Bearer {self._token}",
            "Version": API_VERSION,
            "Accept": "application/json",
            "User-Agent": USER_AGENT,  # WAF blocks empty/default UA -> 403
        }

        last_exc: Exception | None = None
        for attempt in range(MAX_RETRIES):
            req = urllib.request.Request(url, method="GET", headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                    payload = resp.read().decode()
                    return json.loads(payload) if payload else {}
            except urllib.error.HTTPError as e:
                if e.code in (401, 403):
                    # Genuine auth/scope failure (UA is always set, so a 403 here
                    # is a missing scope, not the WAF). Surface immediately.
                    err_body = _read_err(e)
                    raise GHLAPIError(
                        f"GHL auth/scope failed: HTTP {e.code} on GET {path}. "
                        f"Check the Private Integration scopes. Body: {err_body}"
                    ) from e
                if e.code == 429 and attempt < MAX_RETRIES - 1:
                    retry_after = int(e.headers.get("Retry-After", "0") or "0") or (
                        2 * (attempt + 1)
                    )
                    logger.warning(
                        "ghl.rate_limited path=%s retry_after_s=%d attempt=%d",
                        path,
                        retry_after,
                        attempt + 1,
                    )
                    time.sleep(retry_after)
                    continue
                if e.code >= 500 and attempt < MAX_RETRIES - 1:
                    time.sleep(2 + attempt * 2)
                    continue
                raise GHLAPIError(f"HTTP {e.code} on GET {path}: {_read_err(e)}") from e
            except (urllib.error.URLError, TimeoutError) as e:
                last_exc = e
                if attempt < MAX_RETRIES - 1:
                    logger.warning(
                        "ghl.timeout_or_network path=%s attempt=%d err=%s",
                        path,
                        attempt + 1,
                        e,
                    )
                    time.sleep(2 + attempt * 2)
                    continue
                raise GHLAPIError(
                    f"Timeout/network on GET {path} after {MAX_RETRIES} attempts: {e}"
                ) from e

        raise GHLAPIError(f"Exhausted retries on GET {path}: {last_exc}")

    # ------------------------------------------------------------------
    # Endpoints used by the pipeline
    # ------------------------------------------------------------------

    def get_location(self) -> dict[str, Any]:
        """Auth check + sub-account metadata. Confirms token + location id are live."""
        return self._request(f"/locations/{self.location_id}")

    def list_custom_fields(self) -> list[dict[str, Any]]:
        """Custom-field definitions (id -> name/fieldKey). Identifies the 'EOC From' field."""
        resp = self._request(f"/locations/{self.location_id}/customFields")
        return resp.get("customFields") or []

    def list_users(self) -> list[dict[str, Any]]:
        """All users on the location (id/name/email) for rep -> team_members mapping."""
        resp = self._request("/users/", params={"locationId": self.location_id})
        return resp.get("users") or []

    def iter_contacts(
        self, *, page_size: int = 100, max_pages: int | None = None
    ) -> Iterator[dict[str, Any]]:
        """Yield every contact, paginating via meta.startAfter / meta.startAfterId."""
        params: dict[str, Any] = {"locationId": self.location_id, "limit": page_size}
        page_count = 0
        while True:
            resp = self._request("/contacts/", params=params)
            contacts = resp.get("contacts") or []
            for c in contacts:
                yield c
            page_count += 1
            meta = resp.get("meta") or {}
            start_after = meta.get("startAfter")
            start_after_id = meta.get("startAfterId")
            if not contacts or not meta.get("nextPageUrl") or not start_after_id:
                return
            if max_pages is not None and page_count >= max_pages:
                return
            if page_count >= PAGINATION_SAFETY_MAX_PAGES:
                logger.warning(
                    "ghl.contacts_pagination_safety_hit page_count=%d", page_count
                )
                return
            params["startAfter"] = start_after
            params["startAfterId"] = start_after_id

    def iter_conversations(
        self, *, page_size: int = 100, max_pages: int | None = None
    ) -> Iterator[dict[str, Any]]:
        """Yield every conversation. Paginates via the last item's `sort` -> startAfterDate."""
        params: dict[str, Any] = {"locationId": self.location_id, "limit": page_size}
        page_count = 0
        seen: set[str] = set()
        while True:
            resp = self._request("/conversations/search", params=params)
            convos = resp.get("conversations") or []
            fresh = [c for c in convos if c.get("id") not in seen]
            for c in fresh:
                seen.add(c["id"])
                yield c
            page_count += 1
            if not convos or len(convos) < page_size or not fresh:
                return
            if max_pages is not None and page_count >= max_pages:
                return
            if page_count >= PAGINATION_SAFETY_MAX_PAGES:
                logger.warning(
                    "ghl.conversations_pagination_safety_hit page_count=%d", page_count
                )
                return
            last_sort = convos[-1].get("sort")
            # `sort` is the cursor for keyset pagination on this endpoint.
            if isinstance(last_sort, list) and last_sort:
                params["startAfterDate"] = last_sort[0]
            elif last_sort is not None:
                params["startAfterDate"] = last_sort
            else:
                return

    def iter_messages(
        self, conversation_id: str, *, page_size: int = 100
    ) -> Iterator[dict[str, Any]]:
        """Yield every message in a conversation, paginating via lastMessageId."""
        params: dict[str, Any] = {"limit": page_size}
        page_count = 0
        while True:
            resp = self._request(
                f"/conversations/{conversation_id}/messages", params=params
            )
            block = resp.get("messages") or {}
            msgs = block.get("messages") if isinstance(block, dict) else block
            msgs = msgs or []
            for m in msgs:
                yield m
            page_count += 1
            has_next = isinstance(block, dict) and block.get("nextPage")
            last_id = isinstance(block, dict) and block.get("lastMessageId")
            if not msgs or not has_next or not last_id:
                return
            if page_count >= PAGINATION_SAFETY_MAX_PAGES:
                logger.warning(
                    "ghl.messages_pagination_safety_hit conversation_id=%s",
                    conversation_id,
                )
                return
            params["lastMessageId"] = last_id


def _read_err(e: urllib.error.HTTPError) -> str:
    try:
        return e.read().decode()[:800]
    except Exception:
        return ""
