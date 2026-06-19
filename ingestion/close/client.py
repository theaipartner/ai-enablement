"""Close REST API client — auth + paginated requests.

Read-only — never POSTs/PUTs to Close. Uses stdlib `urllib` (same as
`scripts/explore_close_api.py`) to avoid pulling a new dependency for
six endpoints.

Auth pattern (verified in discovery): HTTP Basic where the API key is
the *username* and the password is *empty*. A 401 here is almost always
the trailing-colon detail; check that before troubleshooting anything
else.

Env var: `CLOSE_API_KEY` (loaded from `.env.local` per shared/db.py
convention). The pipeline asserts presence at construction time.
"""

from __future__ import annotations

import base64
import json
import os
import time
import urllib.error
import urllib.request
from typing import Any, Iterator
from urllib.parse import urlencode

from shared.logging import logger

BASE_URL = "https://api.close.com/api/v1"

# Per-request defaults. The discovery probe hit one read-timeout on a
# heavy /activity/?lead_id= call; 60s + 3-try retry covered it cleanly.
DEFAULT_TIMEOUT_S = 60.0
MAX_RETRIES = 3

# Soft sanity limit on pagination depth — Close documents a `_skip`
# ceiling that varies by resource. We chunk per-lead activity pulls so
# this only matters for the top-level /lead/ paginator; 200 pages × 100
# = 20000 leads should be enough for the foreseeable backfill scope. If
# the org grows past that the Export API is the documented alternative
# (flagged in docs/runbooks/close_ingestion.md).
PAGINATION_SAFETY_MAX_PAGES = 200


class CloseAPIError(RuntimeError):
    """Raised for any non-2xx, non-handled-retry HTTP response."""


def _basic_auth_header(api_key: str) -> str:
    """Username = api_key, password = empty (trailing colon)."""
    token = base64.b64encode(f"{api_key}:".encode()).decode()
    return f"Basic {token}"


class CloseClient:
    """Thin wrapper around the Close REST API.

    Constructor reads `CLOSE_API_KEY` from the environment. Use
    `from_env()` factory in tests and the pipeline.
    """

    def __init__(self, api_key: str, timeout_s: float = DEFAULT_TIMEOUT_S):
        if not api_key:
            raise RuntimeError(
                "CloseClient requires a non-empty api_key. Set CLOSE_API_KEY "
                "in .env.local (HTTP Basic key-as-username, empty password)."
            )
        self._auth = _basic_auth_header(api_key)
        self._timeout = timeout_s

    @classmethod
    def from_env(cls) -> CloseClient:
        key = os.getenv("CLOSE_API_KEY")
        if not key:
            raise RuntimeError(
                "CLOSE_API_KEY not set in environment. Confirm .env.local has "
                "the key (Settings → Developer → API Keys in Close)."
            )
        return cls(api_key=key)

    # ------------------------------------------------------------------
    # Low-level request
    # ------------------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        url = f"{BASE_URL}{path}"
        if params:
            url = f"{url}?{urlencode(params)}"
        data = None
        headers = {
            "Authorization": self._auth,
            "Accept": "application/json",
        }
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"

        last_exc: Exception | None = None
        for attempt in range(MAX_RETRIES):
            req = urllib.request.Request(url, method=method, data=data, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                    payload = resp.read().decode()
                    return json.loads(payload) if payload else {}
            except urllib.error.HTTPError as e:
                if e.code in (401, 403):
                    # Hard failure — auth setup wrong. Surface immediately
                    # rather than retrying with stale headers.
                    err_body = ""
                    try:
                        err_body = e.read().decode()[:500]
                    except Exception:
                        pass
                    raise CloseAPIError(
                        f"Close auth failed: HTTP {e.code} on {method} {path}. "
                        f"Body: {err_body}"
                    ) from e
                if e.code == 429 and attempt < MAX_RETRIES - 1:
                    retry_after = int(e.headers.get("Retry-After", "5"))
                    logger.warning(
                        "close.rate_limited path=%s retry_after_s=%d attempt=%d",
                        path, retry_after, attempt + 1,
                    )
                    time.sleep(retry_after)
                    continue
                err_body = ""
                try:
                    err_body = e.read().decode()[:1000]
                except Exception:
                    pass
                raise CloseAPIError(
                    f"HTTP {e.code} on {method} {path}: {err_body}"
                ) from e
            except (urllib.error.URLError, TimeoutError) as e:
                last_exc = e
                if attempt < MAX_RETRIES - 1:
                    logger.warning(
                        "close.timeout_or_network path=%s attempt=%d err=%s",
                        path, attempt + 1, e,
                    )
                    time.sleep(2 + attempt * 2)
                    continue
                raise CloseAPIError(
                    f"Timeout/network on {method} {path} after {MAX_RETRIES} attempts: {e}"
                ) from e

        # Should be unreachable.
        raise CloseAPIError(
            f"Exhausted retries on {method} {path}: {last_exc}"
        )

    # ------------------------------------------------------------------
    # Endpoints used by the pipeline
    # ------------------------------------------------------------------

    def me(self) -> dict[str, Any]:
        """Auth check + org info. Use to confirm CLOSE_API_KEY is live."""
        return self._request("GET", "/me/")

    def iter_leads(
        self,
        *,
        page_size: int = 100,
        max_pages: int | None = None,
        query: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        """Yield every lead, paginating via _skip/_limit.

        `query` accepts Close's text-DSL (e.g. `date_updated > "2026-05-20"`).
        Pass None for full-org backfill; pass a window for incremental
        polling.
        """
        skip = 0
        page_count = 0
        while True:
            params: dict[str, Any] = {"_skip": skip, "_limit": page_size}
            if query:
                params["query"] = query
            resp = self._request("GET", "/lead/", params=params)
            data = resp.get("data", [])
            for lead in data:
                yield lead
            page_count += 1
            if not resp.get("has_more"):
                return
            if not data:
                return
            if max_pages is not None and page_count >= max_pages:
                return
            if page_count >= PAGINATION_SAFETY_MAX_PAGES:
                logger.warning(
                    "close.pagination_safety_hit page_count=%d skip=%d",
                    page_count, skip,
                )
                return
            skip += len(data)

    def get_lead(self, lead_id: str) -> dict[str, Any]:
        """Full lead object including all `custom.cf_*` keys."""
        return self._request("GET", f"/lead/{lead_id}/")

    def get_user(self, user_id: str) -> dict[str, Any]:
        """Full Close user object (`first_name`, `last_name`, `email`).

        Used as a display fallback to resolve a rep's name when they're not
        in `team_members` yet (see the setter-call reviewer)."""
        return self._request("GET", f"/user/{user_id}/")

    def iter_users(
        self,
        *,
        page_size: int = 100,
        max_pages: int | None = None,
    ) -> Iterator[dict[str, Any]]:
        """Yield every Close user in the org, paginating via _skip/_limit.

        Used by the daily Close-users sync cron to populate
        `team_members.close_user_id` by email match.
        """
        skip = 0
        page_count = 0
        while True:
            params: dict[str, Any] = {"_skip": skip, "_limit": page_size}
            resp = self._request("GET", "/user/", params=params)
            data = resp.get("data", [])
            for user in data:
                yield user
            page_count += 1
            if not resp.get("has_more"):
                return
            if not data:
                return
            if max_pages is not None and page_count >= max_pages:
                return
            if page_count >= PAGINATION_SAFETY_MAX_PAGES:
                logger.warning(
                    "close.users_pagination_safety_hit page_count=%d skip=%d",
                    page_count, skip,
                )
                return
            skip += len(data)

    def iter_activities_for_lead(
        self,
        lead_id: str,
        *,
        types: list[str] | None = None,
        page_size: int = 100,
    ) -> Iterator[dict[str, Any]]:
        """Yield activities for a single lead, optionally filtered by _type__in.

        `types` examples: `['Call']`, `['SMS']`, `['LeadStatusChange']`,
        or `['Call', 'SMS', 'LeadStatusChange']` for one bundled call.
        """
        skip = 0
        page_count = 0
        while True:
            params: dict[str, Any] = {
                "lead_id": lead_id,
                "_skip": skip,
                "_limit": page_size,
            }
            if types:
                params["_type__in"] = ",".join(types)
            resp = self._request("GET", "/activity/", params=params)
            data = resp.get("data", [])
            for activity in data:
                yield activity
            page_count += 1
            if not resp.get("has_more"):
                return
            if not data:
                return
            if page_count >= PAGINATION_SAFETY_MAX_PAGES:
                logger.warning(
                    "close.activity_pagination_safety_hit lead_id=%s page_count=%d",
                    lead_id, page_count,
                )
                return
            skip += len(data)

    def iter_opportunities(
        self,
        *,
        page_size: int = 100,
        max_pages: int | None = None,
    ) -> Iterator[dict[str, Any]]:
        skip = 0
        page_count = 0
        while True:
            resp = self._request(
                "GET",
                "/opportunity/",
                params={"_skip": skip, "_limit": page_size},
            )
            data = resp.get("data", [])
            for opp in data:
                yield opp
            page_count += 1
            if not resp.get("has_more") or not data:
                return
            if max_pages is not None and page_count >= max_pages:
                return
            if page_count >= PAGINATION_SAFETY_MAX_PAGES:
                logger.warning(
                    "close.opportunity_pagination_safety_hit page_count=%d",
                    page_count,
                )
                return
            skip += len(data)

    def custom_field_schema(self, object_type: str) -> dict[str, Any]:
        """Recommended endpoint per docs — returns {fields: [...]}.

        `object_type` ∈ {'lead', 'opportunity', 'contact', 'activity'}.
        The 'activity' schema 404s if the org has no Custom Activity
        Types (the case for AI Partner today); caller handles 404.
        """
        return self._request("GET", f"/custom_field_schema/{object_type}/")
