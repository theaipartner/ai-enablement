"""Calendly REST API client.

Read-only for everything except subscription creation (POST
/webhook_subscriptions — Drake-gated via scripts/register_calendly_webhook.py,
not exposed here).

Auth: Bearer (`CALENDLY_API_KEY` env var).

**CRITICAL — User-Agent header is mandatory.** Calendly sits behind
Cloudflare which 403s the default `Python-urllib/3.12` UA with
error 1010 (browser_signature_banned). First source in this codebase
to require this. Discovery proved this empirically.

Rate limit: ~60 req/min (lower plans) / 120 (Enterprise). Returns
429 with `Retry-After` header. Client backs off + retries 3×.

Resource IDs are full URIs, NOT bare UUIDs — pass URIs in path
params where appropriate.

Discovery: docs/reports/calendly-discovery.md.
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

logger = logging.getLogger("ai_enablement.calendly.client")

BASE_URL = "https://api.calendly.com"

# MANDATORY — without a custom UA, Calendly 403s every request behind
# Cloudflare (error 1010). See discovery report § Surprises.
USER_AGENT = "ai-enablement/1.0 (+drake@theaipartner.io)"

DEFAULT_TIMEOUT_S = 30.0
MAX_RETRIES = 3
PAGINATION_SAFETY_MAX_PAGES = 100


class CalendlyAPIError(RuntimeError):
    """Raised for any non-2xx / non-handled-retry HTTP response."""


class CalendlyClient:
    """Thin wrapper around the Calendly Data API."""

    def __init__(self, api_key: str, timeout_s: float = DEFAULT_TIMEOUT_S):
        if not api_key:
            raise RuntimeError(
                "CalendlyClient requires a non-empty api_key. Set "
                "CALENDLY_API_KEY in .env.local (or in Vercel env for the "
                "deployed webhook receiver)."
            )
        self._key = api_key
        self._timeout = timeout_s

    @classmethod
    def from_env(cls) -> CalendlyClient:
        # Accept either the canonical CALENDLY_API_KEY or the old
        # CALENDLY_API_TOKEN name the spec used by mistake.
        key = os.getenv("CALENDLY_API_KEY") or os.getenv("CALENDLY_API_TOKEN")
        if not key:
            raise RuntimeError(
                "CALENDLY_API_KEY (or CALENDLY_API_TOKEN) not set in environment."
            )
        return cls(api_key=key)

    # ------------------------------------------------------------------
    # Low-level request
    # ------------------------------------------------------------------

    def _request(
        self,
        path_or_url: str,
        *,
        params: dict[str, Any] | None = None,
    ) -> Any:
        if path_or_url.startswith("http"):
            url = path_or_url
        else:
            url = f"{BASE_URL}{path_or_url}"
        if params:
            url = f"{url}?{urlencode(params)}"
        headers = {
            "Authorization": f"Bearer {self._key}",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,  # MANDATORY — see module docstring
        }
        last_exc: Exception | None = None
        for attempt in range(MAX_RETRIES):
            req = urllib.request.Request(url, method="GET", headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                    body = resp.read().decode()
                    return json.loads(body) if body else {}
            except urllib.error.HTTPError as e:
                if e.code in (401, 403):
                    err_body = ""
                    try:
                        err_body = e.read().decode()[:500]
                    except Exception:
                        pass
                    raise CalendlyAPIError(
                        f"calendly auth/forbidden: HTTP {e.code} on {path_or_url}. "
                        f"Body: {err_body}"
                    ) from e
                if e.code == 429 and attempt < MAX_RETRIES - 1:
                    retry_after = int(e.headers.get("Retry-After", "5"))
                    logger.warning(
                        "calendly.rate_limited path=%s retry_after_s=%d attempt=%d",
                        path_or_url, retry_after, attempt + 1,
                    )
                    time.sleep(retry_after)
                    continue
                err_body = ""
                try:
                    err_body = e.read().decode()[:1000]
                except Exception:
                    pass
                raise CalendlyAPIError(
                    f"HTTP {e.code} on {path_or_url}: {err_body}"
                ) from e
            except (urllib.error.URLError, TimeoutError) as e:
                last_exc = e
                if attempt < MAX_RETRIES - 1:
                    logger.warning(
                        "calendly.timeout path=%s attempt=%d err=%s",
                        path_or_url, attempt + 1, e,
                    )
                    time.sleep(2 + attempt * 2)
                    continue
                raise CalendlyAPIError(
                    f"timeout/network on {path_or_url} after {MAX_RETRIES} attempts: {e}"
                ) from e
        raise CalendlyAPIError(f"exhausted retries on {path_or_url}: {last_exc}")

    # ------------------------------------------------------------------
    # Endpoints
    # ------------------------------------------------------------------

    def me(self) -> dict[str, Any]:
        """GET /users/me — returns {resource: {uri, email, name, current_organization, ...}}."""
        return self._request("/users/me")

    def get_organization_uri(self) -> str:
        """Convenience: extract current_organization from /users/me."""
        me = self.me()
        resource = me.get("resource") or me
        org = resource.get("current_organization")
        if not org:
            raise CalendlyAPIError("no current_organization on /users/me")
        return org

    def iter_event_types(
        self,
        organization_uri: str,
        page_size: int = 100,
    ) -> Iterator[dict[str, Any]]:
        """Paginate /event_types?organization=<uri>."""
        next_url: str | None = None
        page = 0
        while True:
            if next_url:
                resp = self._request(next_url)
            else:
                resp = self._request("/event_types", params={
                    "organization": organization_uri,
                    "count": page_size,
                })
            for et in resp.get("collection") or []:
                yield et
            next_url = (resp.get("pagination") or {}).get("next_page")
            page += 1
            if not next_url or page >= PAGINATION_SAFETY_MAX_PAGES:
                return

    def iter_scheduled_events(
        self,
        organization_uri: str,
        *,
        min_start_time: str | None = None,
        max_start_time: str | None = None,
        status: str | None = None,
        page_size: int = 100,
        max_pages: int | None = None,
    ) -> Iterator[dict[str, Any]]:
        """Paginate /scheduled_events?organization=<uri>...

        `min_start_time` / `max_start_time` filter by EVENT start time
        (when the meeting happens), NOT by booking-creation time. To
        capture events booked recently (regardless of meeting date),
        pass a generous future max_start_time.
        """
        params: dict[str, Any] = {
            "organization": organization_uri,
            "count": page_size,
            "sort": "start_time:desc",
        }
        if min_start_time:
            params["min_start_time"] = min_start_time
        if max_start_time:
            params["max_start_time"] = max_start_time
        if status:
            params["status"] = status

        next_url: str | None = None
        page = 0
        while True:
            if next_url:
                resp = self._request(next_url)
            else:
                resp = self._request("/scheduled_events", params=params)
            for ev in resp.get("collection") or []:
                yield ev
            next_url = (resp.get("pagination") or {}).get("next_page")
            page += 1
            if not next_url:
                return
            if max_pages is not None and page >= max_pages:
                return
            if page >= PAGINATION_SAFETY_MAX_PAGES:
                logger.warning(
                    "calendly.events_pagination_safety_hit page=%d", page,
                )
                return

    def get_scheduled_event(self, event_uri: str) -> dict[str, Any]:
        """GET /scheduled_events/{uuid} — single-event fetch. event_uri
        is the full URI; we extract the uuid for the path."""
        uuid = event_uri.rsplit("/", 1)[-1]
        resp = self._request(f"/scheduled_events/{uuid}")
        # Calendly wraps in {resource: ...}
        return resp.get("resource") or resp

    def iter_invitees_for_event(
        self,
        event_uri: str,
        page_size: int = 100,
    ) -> Iterator[dict[str, Any]]:
        """GET /scheduled_events/{uuid}/invitees — typically 1 invitee
        per event in this org (verified in discovery), but Calendly
        supports multi-invitee group events."""
        uuid = event_uri.rsplit("/", 1)[-1]
        next_url: str | None = None
        page = 0
        while True:
            if next_url:
                resp = self._request(next_url)
            else:
                resp = self._request(
                    f"/scheduled_events/{uuid}/invitees",
                    params={"count": page_size},
                )
            for inv in resp.get("collection") or []:
                yield inv
            next_url = (resp.get("pagination") or {}).get("next_page")
            page += 1
            if not next_url or page >= PAGINATION_SAFETY_MAX_PAGES:
                return

    def get_invitee(self, invitee_uri: str) -> dict[str, Any]:
        """GET a single invitee by full URI (webhook payloads sometimes
        carry only the URI; this fetches the full object).

        URI format: https://api.calendly.com/scheduled_events/{event_uuid}/invitees/{invitee_uuid}
        """
        # Strip base URL if present; the _request handles full URLs.
        resp = self._request(invitee_uri)
        return resp.get("resource") or resp
