"""Thin HTTP client for the Meta Marketing (Graph) API insights endpoint.

Uses stdlib urllib (no new dependency — same discipline as the rest of the
repo's ingestion clients). Scoped to one ad account.

Endpoint: GET /{version}/act_<id>/insights
  - `level`           account | campaign | adset | ad
  - `time_increment=1` one row per day (bucketed in the AD ACCOUNT's
    timezone — see the timezone caveat in the runbook).
  - `time_range`      {"since":"YYYY-MM-DD","until":"YYYY-MM-DD"} — one call
    returns every day in the window per entity (no per-day fan-out).
  - results paginate via `paging.next` (a full URL we just follow).

Auth: `Authorization: Bearer <access_token>`. The token in use today is a
60-day USER token, NOT a permanent System User token — it expires (and is
tied to a person). See docs/runbooks/meta_ads_ingestion.md § Token.
"""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

logger = logging.getLogger("ai_enablement.meta_ads.client")

_DEFAULT_VERSION = "v23.0"

# A normal UA — graph.facebook.com has no Cloudflare bot-shield (unlike
# Cortana), but a UA is polite and avoids any default-client heuristics.
_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

VALID_LEVELS = ("account", "campaign", "adset", "ad")

# Fields requested at every level. Names confirmed against the live API on
# 2026-06-30 (see docs/runbooks/meta_ads_ingestion.md § Field map).
_BASE_FIELDS: tuple[str, ...] = (
    "date_start",
    "date_stop",
    "spend",
    "impressions",
    "reach",
    "frequency",
    "clicks",
    "inline_link_clicks",
    "unique_clicks",
    "unique_inline_link_clicks",
    "cpm",
    "ctr",
    "inline_link_click_ctr",
    "unique_ctr",
    "cost_per_inline_link_click",
    "cost_per_unique_inline_link_click",
)

# Per-level identity fields (id + name) appended to _BASE_FIELDS.
_LEVEL_FIELDS: dict[str, tuple[str, ...]] = {
    "account": (),
    "campaign": ("campaign_id", "campaign_name"),
    "adset": ("adset_id", "adset_name", "campaign_id"),
    "ad": ("ad_id", "ad_name", "adset_id", "campaign_id"),
}

# Meta transient/throttle error codes — safe to retry with backoff.
# 4 app-level throttle, 17 user-level throttle, 613 custom-rate, 80000/80004
# ads-insights throttle, 1/2 transient unknown.
_TRANSIENT_META_CODES = {1, 2, 4, 17, 613, 80000, 80004}
# Auth failure — token expired/invalid/revoked. Fail fast with a clear msg.
_AUTH_CODE = 190


class MetaAdsAPIError(RuntimeError):
    """Raised when the Meta API returns a non-2xx after retries."""


class MetaAdsAuthError(MetaAdsAPIError):
    """Token expired / invalid / revoked (Meta error code 190).

    Surfaced distinctly because this is the failure mode of the 60-day USER
    token: when it expires the cron starts raising this every tick and ad
    spend silently freezes until a fresh token is set. The cron logs it as a
    credentials problem, not a generic API error.
    """


class MetaAdsClient:
    """Minimal Marketing-API insights client scoped to one ad account."""

    def __init__(
        self,
        access_token: str,
        account_id: str,
        *,
        api_version: str = _DEFAULT_VERSION,
        timeout: int = 90,
        max_retries: int = 3,
        page_limit: int = 500,
    ) -> None:
        if not access_token or not account_id:
            raise ValueError("MetaAdsClient requires access_token and account_id")
        self._token = access_token
        # Accept "act_123" or bare "123".
        acct = str(account_id)
        self._account = acct if acct.startswith("act_") else f"act_{acct}"
        self._version = api_version
        self._timeout = timeout
        self._max_retries = max_retries
        self._page_limit = page_limit
        self._base = f"https://graph.facebook.com/{api_version}"

    # -- public --------------------------------------------------------

    def insights(
        self,
        level: str,
        since: str,
        until: str,
        *,
        time_increment: int = 1,
    ) -> list[dict[str, Any]]:
        """GET /act_<id>/insights for one window + level, all pages.

        `since`/`until` are `YYYY-MM-DD` (inclusive). Returns the flat list
        of daily per-entity rows (each carries `date_start`). Raises
        MetaAdsAuthError on an expired/invalid token, MetaAdsAPIError on
        other persistent failure.
        """
        if level not in VALID_LEVELS:
            raise ValueError(f"level must be one of {VALID_LEVELS}")
        fields = _BASE_FIELDS + _LEVEL_FIELDS[level]
        params = {
            "level": level,
            "time_increment": str(time_increment),
            "fields": ",".join(fields),
            "time_range": json.dumps({"since": since, "until": until}),
            "limit": str(self._page_limit),
        }
        url = f"{self._base}/{self._account}/insights?{urllib.parse.urlencode(params)}"
        rows: list[dict[str, Any]] = []
        page = 0
        while url:
            body = self._get(url)
            rows.extend(body.get("data", []))
            # paging.next is a full URL with the cursor + token embedded.
            url = (body.get("paging") or {}).get("next")
            page += 1
            if page > 1000:  # runaway guard — no real window paginates this far
                logger.warning("meta insights %s: stopped after 1000 pages", level)
                break
        return rows

    # -- internal ------------------------------------------------------

    def _get(self, url: str) -> dict[str, Any]:
        # Token rides the Authorization header on our constructed request;
        # Meta's `paging.next` URLs also embed it (we never log full URLs).
        req = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {self._token}",
                "User-Agent": _UA,
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
                    detail = exc.read().decode("utf-8")[:800]
                except Exception:  # noqa: BLE001 - best-effort body read
                    pass
                code = _meta_error_code(detail)
                if code == _AUTH_CODE:
                    raise MetaAdsAuthError(
                        f"Meta token rejected (code 190) — expired/invalid/"
                        f"revoked. Set a fresh META_ACCESS_TOKEN. Detail: {detail}"
                    ) from exc
                transient = (
                    exc.code in (429, 500, 502, 503) or code in _TRANSIENT_META_CODES
                )
                if not transient and 400 <= exc.code < 500:
                    raise MetaAdsAPIError(
                        f"Meta {exc.code} (code {code}): {detail}"
                    ) from exc
                last_exc = exc
                logger.warning(
                    "meta insights attempt %d/%d: HTTP %d code=%s %s",
                    attempt + 1,
                    self._max_retries,
                    exc.code,
                    code,
                    detail,
                )
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                last_exc = exc
                logger.warning(
                    "meta insights attempt %d/%d: %s",
                    attempt + 1,
                    self._max_retries,
                    exc,
                )
            if attempt < self._max_retries - 1:
                time.sleep(2 * (attempt + 1))
        raise MetaAdsAPIError(f"Meta insights request failed: {last_exc}")


def _meta_error_code(detail: str) -> int | None:
    """Pull `error.code` out of a Meta JSON error body (best-effort)."""
    try:
        return int(((json.loads(detail) or {}).get("error") or {}).get("code"))
    except (ValueError, TypeError):
        return None
