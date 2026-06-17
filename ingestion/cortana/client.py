"""Thin HTTP client for the Cortana Attribution API.

Uses stdlib urllib (no new dependency — same discipline as the rest of
the repo's ingestion clients). Two non-obvious details, both discovered
against the live API on 2026-05-29:

  1. **Cloudflare blocks the default `Python-urllib` User-Agent**
     (HTTP 403, body `error code: 1010` = banned browser signature).
     A normal browser UA string sails through. This is a bot-shield
     quirk, not auth — the Authorization header is fine.

  2. **Datetimes must be `...Z`-suffixed with no microseconds.** The
     API validates with a strict Zod `.datetime()` that rejects the
     `+00:00` offset Python's `.isoformat()` emits.

Auth: `Authorization: Bearer sk-ak-...` (the API key) — see
docs/runbooks/cortana_ingestion.md.
"""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

logger = logging.getLogger("ai_enablement.cortana.client")

_BASE_URL = "https://app.usecortana.ai/api/v1"

# Cloudflare rejects the stdlib UA; a browser UA passes. Not a secret,
# not auth — purely a bot-shield workaround.
_BROWSER_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

# Strict ISO-8601 with Z suffix, no microseconds (Zod .datetime()).
CORTANA_DT_FORMAT = "%Y-%m-%dT%H:%M:%SZ"

VALID_GROUP_BY = ("source", "campaign", "medium", "ad")
# groupBy=medium is how we get the ad-set grain: Meta's URL template puts the
# ad-set name in utm_medium, and Cortana keys each medium row to the real Meta
# ad-set id via platformEntityId (the API has no native ad-set grouping). See
# ingestion/cortana/pipeline.py + migration 0089_cortana_adset_daily.sql.


class CortanaAPIError(RuntimeError):
    """Raised when the Cortana API returns a non-2xx after retries."""


class CortanaClient:
    """Minimal Attribution-API client scoped to one business."""

    def __init__(
        self,
        api_key: str,
        business_id: str,
        *,
        timeout: int = 90,
        max_retries: int = 3,
    ) -> None:
        if not api_key or not business_id:
            raise ValueError("CortanaClient requires api_key and business_id")
        self._api_key = api_key
        self._business_id = business_id
        self._timeout = timeout
        self._max_retries = max_retries

    # -- public --------------------------------------------------------

    def attribution_data(
        self,
        start: str,
        end: str,
        *,
        group_by: str = "source",
        attribution_model: str = "last_click",
        timezone: str = "America/New_York",
        currency: str = "USD",
    ) -> dict[str, Any]:
        """GET /attribution/data for one window + grouping.

        `start`/`end` are `...Z` ISO strings (use CORTANA_DT_FORMAT).
        Returns the parsed `data` sub-object: {data, dailySummary,
        globalTotals}. Raises CortanaAPIError on persistent failure.
        """
        if group_by not in VALID_GROUP_BY:
            raise ValueError(f"group_by must be one of {VALID_GROUP_BY}")
        params = {
            "startDate": start,
            "endDate": end,
            "groupBy": group_by,
            "attributionModel": attribution_model,
            "timezone": timezone,
            "currency": currency,
        }
        path = f"/businesses/{self._business_id}/attribution/data"
        body = self._get(path, params)
        # Endpoint wraps everything under `data`; surface that directly.
        return body.get("data", {}) if isinstance(body, dict) else {}

    # -- internal ------------------------------------------------------

    def _get(self, path: str, params: dict[str, str]) -> dict[str, Any]:
        url = f"{_BASE_URL}{path}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "User-Agent": _BROWSER_UA,
                "Accept": "application/json",
            },
        )
        last_exc: Exception | None = None
        for attempt in range(self._max_retries):
            try:
                with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                detail = ""
                try:
                    detail = exc.read().decode("utf-8")[:500]
                except Exception:  # noqa: BLE001 - best-effort body read
                    pass
                # 4xx (except 429) won't fix on retry — fail fast.
                if exc.code != 429 and 400 <= exc.code < 500:
                    raise CortanaAPIError(
                        f"Cortana {exc.code} on {path}: {detail}"
                    ) from exc
                last_exc = exc
                logger.warning(
                    "cortana %s attempt %d/%d: HTTP %d %s",
                    path, attempt + 1, self._max_retries, exc.code, detail,
                )
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                last_exc = exc
                logger.warning(
                    "cortana %s attempt %d/%d: %s",
                    path, attempt + 1, self._max_retries, exc,
                )
            if attempt < self._max_retries - 1:
                time.sleep(2 * (attempt + 1))
        raise CortanaAPIError(f"Cortana request failed on {path}: {last_exc}")
