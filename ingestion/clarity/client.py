"""Microsoft Clarity Data Export API client.

Read-only. The Clarity API is a one-endpoint export with no write
operations available — `GET /export-data/api/v1/project-live-insights`.

Auth: Bearer (`CLARITY_API_KEY` env var; admin-only Clarity tokens).

**CRITICAL constraints** (verified in `docs/reports/clarity-discovery.md`):

  * Max 10 reqs/project/day. The daily cron uses ONE call.
  * Returns ONLY the last 1, 2, or 3 days. No historical backfill ever.
  * Up to 3 dimensions per request (`dimension1`, `dimension2`,
    `dimension3` as separate query params — NOT an array).
  * Response capped at 1000 rows; no pagination.

**Cloudflare UA gate** (defensive): we haven't seen Clarity 1010 us
during discovery, but other sources on the same fronting layer
(Calendly) do, so we send a real User-Agent — same convention as
`ingestion/calendly/client.py:USER_AGENT`. Cheap insurance.

Spec: docs/specs/clarity-ingestion.md.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import urlencode

logger = logging.getLogger("ai_enablement.clarity.client")

BASE_URL = "https://www.clarity.ms/export-data/api/v1/project-live-insights"

# Same UA convention as ingestion/calendly/client.py — Cloudflare-
# fronted endpoints can 403 default Python UAs. Discovery didn't see
# this on Clarity but the cost of setting it is zero.
USER_AGENT = "ai-enablement/1.0 (+drake@theaipartner.io)"

DEFAULT_TIMEOUT_S = 30.0


class ClarityAPIError(RuntimeError):
    """Raised for any non-2xx response or transport failure."""


class ClarityClient:
    """Thin wrapper around the single Clarity export endpoint."""

    def __init__(self, api_key: str, timeout_s: float = DEFAULT_TIMEOUT_S):
        if not api_key:
            raise RuntimeError(
                "ClarityClient requires a non-empty api_key. Set "
                "CLARITY_API_KEY in .env.local (admin-only token generated "
                "at Clarity Settings → Data Export → Generate new API token)."
            )
        self._api_key = api_key
        self._timeout_s = timeout_s

    @classmethod
    def from_env(cls) -> "ClarityClient":
        key = os.environ.get("CLARITY_API_KEY")
        if not key:
            raise RuntimeError(
                "CLARITY_API_KEY not set. Required in .env.local for local "
                "runs AND in Vercel env vars for the deployed cron."
            )
        return cls(api_key=key)

    def fetch_url_segmented(self, num_of_days: int = 3) -> list[dict[str, Any]]:
        """The single call this client ever makes: pull last 1-3 days of
        metrics segmented by URL.

        Returns the parsed list of metric blocks (each
        `{metricName, information: [rows]}`).

        Raises ClarityAPIError on non-200 / non-JSON / unexpected shape.
        Caller logs + audits; this layer just translates HTTP errors
        into a typed exception.
        """
        if num_of_days not in (1, 2, 3):
            raise ValueError(
                f"num_of_days must be 1, 2, or 3 (got {num_of_days}); "
                f"Clarity's API rejects anything else."
            )

        params = {"numOfDays": str(num_of_days), "dimension1": "URL"}
        url = f"{BASE_URL}?{urlencode(params)}"
        req = urllib.request.Request(
            url,
            method="GET",
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
            },
        )

        try:
            with urllib.request.urlopen(req, timeout=self._timeout_s) as resp:
                raw = resp.read().decode("utf-8")
                status = resp.status
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode()[:1000]
            except Exception:
                pass
            if e.code == 429:
                raise ClarityAPIError(
                    f"Clarity daily request cap (10/project/day) exceeded. "
                    f"Status 429. Body: {body!r}"
                ) from e
            if e.code in (401, 403):
                raise ClarityAPIError(
                    f"Clarity auth failed (status {e.code}). Token may be "
                    f"expired/revoked or scope insufficient. Body: {body!r}"
                ) from e
            raise ClarityAPIError(
                f"Clarity HTTP {e.code}: {body!r}"
            ) from e
        except urllib.error.URLError as e:
            raise ClarityAPIError(f"Clarity transport failure: {e}") from e

        if status != 200:
            raise ClarityAPIError(
                f"Clarity returned unexpected status {status}: {raw[:500]!r}"
            )

        try:
            body = json.loads(raw)
        except json.JSONDecodeError as e:
            raise ClarityAPIError(
                f"Clarity returned non-JSON body ({len(raw)} chars): {raw[:500]!r}"
            ) from e

        if not isinstance(body, list):
            raise ClarityAPIError(
                f"Clarity returned unexpected body shape (expected list, "
                f"got {type(body).__name__}): {str(body)[:500]!r}"
            )

        logger.info(
            "clarity.fetch_url_segmented num_of_days=%d → %d metric blocks",
            num_of_days, len(body),
        )
        return body
