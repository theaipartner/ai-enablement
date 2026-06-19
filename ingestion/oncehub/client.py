"""OnceHub v2 REST API client.

Read + webhook-management surface only. The scheduling-config surface (booking
calendars, resource pools, hidden fields, round-robin distribution) is UI-only —
not exposed by the API — so it is NOT modeled here; that stays Zain's OnceHub
admin work.

Auth: a custom header `API-Key: <ONCEHUB_API_KEY>` (NOT Authorization/Bearer).
Base: https://api.oncehub.com/v2 (the v2 "Booking Calendars" surface — gates
signed webhooks + the custom_fields payload).

Rate limits: 5 req/sec per account, 200 req / 5 min per IP -> 429 with backoff.

Verified live 2026-06-19: /v2/users, /v2/teams, /v2/booking-calendars,
/v2/booking-pages, /v2/master-pages, /v2/bookings, /v2/webhooks all 200 with the
API-Key header.
"""

from __future__ import annotations

import json
import logging
import os
import time
import urllib.error
import urllib.request
from typing import Any, Iterator
from urllib.parse import urlencode

logger = logging.getLogger("ai_enablement.oncehub.client")

BASE_URL = "https://api.oncehub.com/v2"

DEFAULT_TIMEOUT_S = 30.0
MAX_RETRIES = 3
PAGINATION_SAFETY_MAX_PAGES = 200


class OnceHubAPIError(RuntimeError):
    """Raised for any non-2xx / non-handled-retry HTTP response."""


class OnceHubClient:
    """Thin wrapper around the OnceHub v2 API."""

    def __init__(self, api_key: str, timeout_s: float = DEFAULT_TIMEOUT_S):
        if not api_key:
            raise RuntimeError(
                "OnceHubClient requires a non-empty api_key. Set ONCEHUB_API_KEY "
                "in .env.local (or in Vercel env for the deployed receiver)."
            )
        self._key = api_key
        self._timeout = timeout_s

    @classmethod
    def from_env(cls) -> "OnceHubClient":
        key = os.getenv("ONCEHUB_API_KEY")
        if not key:
            raise RuntimeError("ONCEHUB_API_KEY not set in environment.")
        return cls(api_key=key)

    # ------------------------------------------------------------------
    # Low-level request
    # ------------------------------------------------------------------

    def _request(
        self,
        path_or_url: str,
        *,
        method: str = "GET",
        params: dict[str, Any] | None = None,
        body: dict[str, Any] | None = None,
    ) -> Any:
        if path_or_url.startswith("http"):
            url = path_or_url
        else:
            url = f"{BASE_URL}{path_or_url}"
        if params:
            url = f"{url}?{urlencode(params)}"
        headers = {
            "API-Key": self._key,
            "Accept": "application/json",
        }
        data: bytes | None = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        last_exc: Exception | None = None
        for attempt in range(MAX_RETRIES):
            req = urllib.request.Request(url, method=method, headers=headers, data=data)
            try:
                with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                    raw = resp.read().decode()
                    return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as e:
                if e.code in (401, 403):
                    err_body = ""
                    try:
                        err_body = e.read().decode()[:500]
                    except Exception:
                        pass
                    raise OnceHubAPIError(
                        f"oncehub auth/forbidden: HTTP {e.code} on {path_or_url}. "
                        f"Body: {err_body}"
                    ) from e
                if e.code == 429 and attempt < MAX_RETRIES - 1:
                    retry_after = int(e.headers.get("Retry-After", "5"))
                    logger.warning(
                        "oncehub.rate_limited path=%s retry_after_s=%d attempt=%d",
                        path_or_url, retry_after, attempt + 1,
                    )
                    time.sleep(retry_after)
                    continue
                err_body = ""
                try:
                    err_body = e.read().decode()[:1000]
                except Exception:
                    pass
                raise OnceHubAPIError(f"HTTP {e.code} on {path_or_url}: {err_body}") from e
            except (urllib.error.URLError, TimeoutError) as e:
                last_exc = e
                if attempt < MAX_RETRIES - 1:
                    logger.warning(
                        "oncehub.timeout path=%s attempt=%d err=%s",
                        path_or_url, attempt + 1, e,
                    )
                    time.sleep(2 + attempt * 2)
                    continue
                raise OnceHubAPIError(
                    f"timeout/network on {path_or_url} after {MAX_RETRIES} attempts: {e}"
                ) from e
        raise OnceHubAPIError(f"exhausted retries on {path_or_url}: {last_exc}")

    # ------------------------------------------------------------------
    # List pagination
    # ------------------------------------------------------------------

    def _iter_list(self, path: str, *, params: dict[str, Any] | None = None) -> Iterator[dict[str, Any]]:
        """Iterate a `{"object":"list","data":[...]}` collection.

        OnceHub v2 list responses are cursor-paginated when large. We follow a
        continuation token if the response carries one (`next` / `after` /
        `next_cursor` have all been observed across ReadMe-documented endpoints;
        accept whichever appears), and stop when absent. Small collections
        (users, teams, calendars) return a single page.
        """
        page = 0
        cursor: str | None = None
        while True:
            call_params = dict(params or {})
            if cursor:
                call_params["after"] = cursor
            resp = self._request(path, params=call_params or None)
            for item in resp.get("data") or []:
                yield item
            cursor = resp.get("next") or resp.get("after") or resp.get("next_cursor")
            # Some shapes nest under "pagination".
            if not cursor and isinstance(resp.get("pagination"), dict):
                cursor = resp["pagination"].get("next") or resp["pagination"].get("after")
            page += 1
            if not cursor or page >= PAGINATION_SAFETY_MAX_PAGES:
                return

    # ------------------------------------------------------------------
    # Endpoints — read
    # ------------------------------------------------------------------

    def list_users(self) -> list[dict[str, Any]]:
        return list(self._iter_list("/users"))

    def list_teams(self) -> list[dict[str, Any]]:
        return list(self._iter_list("/teams"))

    def list_booking_calendars(self) -> list[dict[str, Any]]:
        return list(self._iter_list("/booking-calendars"))

    def list_master_pages(self) -> list[dict[str, Any]]:
        return list(self._iter_list("/master-pages"))

    def iter_bookings(self, *, params: dict[str, Any] | None = None) -> Iterator[dict[str, Any]]:
        """Iterate /bookings (the API backstop / backfill source)."""
        yield from self._iter_list("/bookings", params=params)

    def get_booking(self, booking_id: str) -> dict[str, Any]:
        resp = self._request(f"/bookings/{booking_id}")
        return resp.get("data") or resp

    # ------------------------------------------------------------------
    # Endpoints — webhook management
    # ------------------------------------------------------------------

    def list_webhooks(self) -> list[dict[str, Any]]:
        return list(self._iter_list("/webhooks"))

    def create_webhook(
        self,
        *,
        url: str,
        events: list[str],
        name: str = "ai-enablement$oncehub",
    ) -> dict[str, Any]:
        """POST /webhooks — register a subscription pointing at OUR endpoint.

        Coexists with any existing subscription (Zain's make.com one stays).
        The response carries the per-endpoint signing `secret` — capture it for
        ONCEHUB_WEBHOOK_SECRET (Drake gate (d), Vercel env).
        """
        return self._request(
            "/webhooks",
            method="POST",
            body={"name": name, "url": url, "events": events},
        )

    def delete_webhook(self, webhook_id: str) -> Any:
        return self._request(f"/webhooks/{webhook_id}", method="DELETE")
