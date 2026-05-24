"""Wistia REST API client — Bearer auth + the three endpoints we use.

Read-only. Never POSTs/PUTs. Stdlib urllib only, no SDK dep
(matches `ingestion/close/client.py`, `ingestion/meta/sheets_client.py`,
`shared/google_oauth.py`).

Auth: `Authorization: Bearer <WISTIA_API_TOKEN>`.

Rate limit: 600 req/min per account; Wistia returns HTTP 503 (NOT 429)
on violation, with no Retry-After header. Retry with exponential
back-off. Discovery + the rolling-window cron stay well under quota.

Two API base paths:
  - https://api.wistia.com/v1     — long-standing Data API (medias,
    projects, lifetime stats)
  - https://api.wistia.com/modern — newer endpoints (per-day stats);
    requires `X-Wistia-API-Version` header.

Confirmed working against the live account during discovery
(docs/reports/wistia-discovery.md).
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

logger = logging.getLogger("ai_enablement.wistia.client")

BASE_V1 = "https://api.wistia.com/v1"
BASE_MODERN = "https://api.wistia.com/modern"

# X-Wistia-API-Version pinned at the version we tested against during
# discovery. Wistia may default to a newer version if omitted; pinning
# protects against silent payload-shape drift on the modern endpoints.
MODERN_API_VERSION = "2026-03"

DEFAULT_TIMEOUT_S = 30.0
MAX_RETRIES = 3
# Hard cap on /medias.json pagination depth. 50 pages × 100 per page =
# 5000 medias — far above the current 80; a runaway loop bug would hit
# this before exhausting Wistia's quota.
PAGINATION_SAFETY_MAX_PAGES = 50


class WistiaAPIError(RuntimeError):
    """Raised for any non-2xx / non-handled-retry HTTP response."""


class WistiaClient:
    """Thin wrapper around the Wistia Data + Stats APIs."""

    def __init__(self, api_token: str, timeout_s: float = DEFAULT_TIMEOUT_S):
        if not api_token:
            raise RuntimeError(
                "WistiaClient requires a non-empty api_token. Set "
                "WISTIA_API_TOKEN in .env.local (or in Vercel env for the "
                "deployed cron). Token page is Account-Owner-only — Nabeel "
                "regenerates if rotated; require 'Read detailed stats' "
                "permission."
            )
        self._token = api_token
        self._timeout = timeout_s

    @classmethod
    def from_env(cls) -> WistiaClient:
        token = os.getenv("WISTIA_API_TOKEN")
        if not token:
            raise RuntimeError("WISTIA_API_TOKEN not set in environment.")
        return cls(api_token=token)

    # ------------------------------------------------------------------
    # Low-level request
    # ------------------------------------------------------------------

    def _request(
        self,
        path: str,
        *,
        base: str = BASE_V1,
        params: dict[str, Any] | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> Any:
        url = f"{base}{path}"
        if params:
            url = f"{url}?{urlencode(params)}"
        headers = {
            "Authorization": f"Bearer {self._token}",
            "Accept": "application/json",
        }
        if extra_headers:
            headers.update(extra_headers)

        last_exc: Exception | None = None
        for attempt in range(MAX_RETRIES):
            req = urllib.request.Request(url, method="GET", headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                    body = resp.read().decode("utf-8")
                    return json.loads(body) if body else {}
            except urllib.error.HTTPError as e:
                if e.code in (401, 403):
                    # Hard fail — surface immediately. Wistia token page is
                    # Account-Owner-only; auth failure usually means Nabeel
                    # must regenerate.
                    err_body = ""
                    try:
                        err_body = e.read().decode("utf-8")[:500]
                    except Exception:
                        pass
                    raise WistiaAPIError(
                        f"wistia auth failed: HTTP {e.code} on {path}. "
                        f"Body: {err_body}"
                    ) from e
                if e.code == 503 and attempt < MAX_RETRIES - 1:
                    # Wistia rate-limit signal. No Retry-After — back off
                    # exponentially.
                    wait_s = 5 * (attempt + 1)
                    logger.warning(
                        "wistia.rate_limited path=%s wait_s=%d attempt=%d",
                        path, wait_s, attempt + 1,
                    )
                    time.sleep(wait_s)
                    continue
                err_body = ""
                try:
                    err_body = e.read().decode("utf-8")[:1000]
                except Exception:
                    pass
                raise WistiaAPIError(
                    f"HTTP {e.code} on {path}: {err_body}"
                ) from e
            except (urllib.error.URLError, TimeoutError) as e:
                last_exc = e
                if attempt < MAX_RETRIES - 1:
                    logger.warning(
                        "wistia.timeout path=%s attempt=%d err=%s",
                        path, attempt + 1, e,
                    )
                    time.sleep(2 + attempt * 2)
                    continue
                raise WistiaAPIError(
                    f"timeout/network on {path} after {MAX_RETRIES} attempts: {e}"
                ) from e

        raise WistiaAPIError(f"exhausted retries on {path}: {last_exc}")

    # ------------------------------------------------------------------
    # Endpoints
    # ------------------------------------------------------------------

    def iter_medias(self, page_size: int = 100) -> Iterator[dict[str, Any]]:
        """Yield every media. Paginated via `page` + `per_page` (max 100).

        Wistia returns an empty list when there are no more pages — no
        explicit `has_more` flag.
        """
        page = 1
        while True:
            chunk = self._request(
                "/medias.json",
                params={"page": page, "per_page": page_size},
            )
            if not isinstance(chunk, list) or not chunk:
                return
            for m in chunk:
                yield m
            page += 1
            if page > PAGINATION_SAFETY_MAX_PAGES:
                logger.warning(
                    "wistia.pagination_safety_hit page=%d", page,
                )
                return

    def iter_projects(self, page_size: int = 100) -> Iterator[dict[str, Any]]:
        page = 1
        while True:
            chunk = self._request(
                "/projects.json",
                params={"page": page, "per_page": page_size},
            )
            if not isinstance(chunk, list) or not chunk:
                return
            for p in chunk:
                yield p
            page += 1
            if page > PAGINATION_SAFETY_MAX_PAGES:
                return

    def fetch_lifetime_stats(self, hashed_id: str) -> dict[str, Any]:
        """GET /v1/medias/{hashed_id}/stats.json — lifetime aggregates.

        Returns the full response (we extract the `stats` sub-object
        in the parser). Caller handles errors per-media (fail-soft).
        """
        return self._request(f"/medias/{hashed_id}/stats.json")

    def fetch_by_date(
        self,
        hashed_id: str,
        *,
        start_date: str,
        end_date: str,
    ) -> list[dict[str, Any]]:
        """DEPRECATED post-2026-05-24 cutover. Use `fetch_timeseries` instead.

        GET /modern/stats/medias/{id}/by_date — per-day stats.

        Returns a list of {date, load_count, play_count, hours_watched},
        one entry per calendar day in [start_date, end_date] inclusive.
        Zero-activity days return zeros, not nulls.

        **Why deprecated:** verification (docs/reports/wistia-watchtime-verify.md)
        proved this endpoint synthesizes `hours_watched = play_count ×
        per-media constant` — daily engagement-rate derivations come out
        flat (fake). Method retained for reference + ad-hoc legacy queries;
        pipeline + cron now use `fetch_timeseries`.

        REQUIRES `X-Wistia-API-Version` header — pinned to MODERN_API_VERSION.
        """
        result = self._request(
            f"/stats/medias/{hashed_id}/by_date",
            base=BASE_MODERN,
            params={"start_date": start_date, "end_date": end_date},
            extra_headers={"X-Wistia-API-Version": MODERN_API_VERSION},
        )
        if isinstance(result, list):
            return result
        # Defensive — if Wistia ever changes shape, surface loudly rather
        # than silently treating as zero.
        raise WistiaAPIError(
            f"by_date for {hashed_id} returned non-list: {type(result).__name__}"
        )

    def fetch_timeseries(
        self,
        hashed_id: str,
        *,
        start_date: str,
        end_date: str,
        granularity: str = "daily",
    ) -> list[dict[str, Any]]:
        """GET /modern/analytics/medias/{id}/timeseries — REAL per-day stats.

        Post-2026-05-24 cutover from `fetch_by_date`. Returns a list of
        per-bucket metric objects with REAL daily variance (vs the
        synthesized values from by_date — see
        docs/reports/wistia-watchtime-verify.md).

        Per-bucket fields (granularity=daily):
            timestamp (ISO8601 — date portion is the calendar day),
            plays, unique_plays, unique_loads, unique_visitors,
            played_time (SECONDS as integer), engagement_rate (0-1
            float), play_rate (0-1 float), cta_impressions,
            cta_conversions, cta_conversion_rate, form_conversions.

        **CRITICAL date semantics — different from `fetch_by_date`:**
        the new endpoint takes `end_date` as EXCLUSIVE. Callers pass
        an INCLUSIVE end_date (matching the by_date convention they're
        used to) and this method adds +1 day internally. Get this
        wrong and you silently drop the latest day.

        REQUIRES `X-Wistia-API-Version` header — pinned to MODERN_API_VERSION.
        `granularity` accepts daily | weekly | monthly; we default to daily.
        """
        # Spec footgun: end_date is EXCLUSIVE on the new endpoint. Add
        # a day so callers can keep passing an INCLUSIVE end_date (the
        # convention every other source in this codebase uses).
        from datetime import date as _date, timedelta as _td
        inclusive_end = _date.fromisoformat(end_date)
        exclusive_end_iso = (inclusive_end + _td(days=1)).isoformat()

        result = self._request(
            f"/analytics/medias/{hashed_id}/timeseries",
            base=BASE_MODERN,
            params={
                "start_date": start_date,
                "end_date": exclusive_end_iso,
                "granularity": granularity,
            },
            extra_headers={"X-Wistia-API-Version": MODERN_API_VERSION},
        )
        if isinstance(result, list):
            return result
        raise WistiaAPIError(
            f"timeseries for {hashed_id} returned non-list: {type(result).__name__}"
        )
