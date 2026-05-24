"""Typeform REST API client — auth + paginated requests.

Read-only against Typeform's data endpoints. Uses stdlib `urllib` (same
posture as `ingestion/close/client.py` and `scripts/explore_typeform_api.py`)
to avoid pulling a new dependency.

Auth pattern (verified in discovery): `Authorization: Bearer <PAT>` where
PAT is a Typeform Personal Access Token. Base URL `https://api.typeform.com`
(no `/v1` segment — paths are top-level).

Env var: `TYPEFORM_API_KEY` (NOT `_TOKEN` — discovery §4(a); accept both
for robustness, prefer `_KEY` since that's what's set in .env.local).

Pagination quirks (verified in discovery, load-bearing):
  - `/forms/{form_id}/responses` cursor pagination uses `before`/`after`
    on the response `token`. Default sort is `submitted_at desc`.
  - **CRITICAL: `before`/`after` returns HTTP 400 when combined with the
    `sort` param.** Documented inline because someone "tidying up" the
    client by adding `sort=submitted_at,desc` will break the backfill.
    The cursor backfill walks newest→oldest via `before=<oldest_token>`
    without a `sort` param — the default sort is what we want anyway.
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

BASE_URL = "https://api.typeform.com"

DEFAULT_TIMEOUT_S = 60.0
MAX_RETRIES = 3

# Forms endpoint accepts up to 200 per page.
FORMS_PAGE_SIZE = 200
# Responses endpoint accepts up to 1000 per page.
RESPONSES_PAGE_SIZE = 1000

# Safety cap on the response-cursor walk — at page_size=1000 this allows
# 200k responses per form, well above the ~10k peak observed in discovery.
PAGINATION_SAFETY_MAX_PAGES = 200


class TypeformAPIError(RuntimeError):
    """Raised on any non-2xx that wasn't a handled retry."""


class TypeformClient:
    """Thin wrapper around Typeform's REST API.

    Use `from_env()` to construct in pipeline + script + cron contexts.
    """

    def __init__(self, api_key: str, timeout_s: float = DEFAULT_TIMEOUT_S):
        if not api_key:
            raise RuntimeError(
                "TypeformClient requires a non-empty api_key. Set "
                "TYPEFORM_API_KEY in .env.local (Typeform Personal Access "
                "Token; Settings → Personal Tokens in Typeform Admin)."
            )
        self._api_key = api_key
        self._timeout = timeout_s

    @classmethod
    def from_env(cls) -> TypeformClient:
        # Accept either name; prefer the actually-set value. Spec writer
        # used `_TOKEN`; the env file has `_KEY`. Either is fine.
        key = os.getenv("TYPEFORM_API_KEY") or os.getenv("TYPEFORM_API_TOKEN")
        if not key:
            raise RuntimeError(
                "TYPEFORM_API_KEY (or TYPEFORM_API_TOKEN) not set. "
                "Confirm .env.local has the PAT."
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
            "Authorization": f"Bearer {self._api_key}",
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
                    err_body = ""
                    try:
                        err_body = e.read().decode()[:500]
                    except Exception:
                        pass
                    raise TypeformAPIError(
                        f"Typeform auth failed: HTTP {e.code} on {method} {path}. "
                        f"Body: {err_body}"
                    ) from e
                if e.code == 429 and attempt < MAX_RETRIES - 1:
                    retry_after = int(e.headers.get("Retry-After", "5"))
                    logger.warning(
                        "typeform.rate_limited path=%s retry_after_s=%d attempt=%d",
                        path, retry_after, attempt + 1,
                    )
                    time.sleep(retry_after)
                    continue
                err_body = ""
                try:
                    err_body = e.read().decode()[:1000]
                except Exception:
                    pass
                raise TypeformAPIError(
                    f"HTTP {e.code} on {method} {path}: {err_body}"
                ) from e
            except (urllib.error.URLError, TimeoutError) as e:
                last_exc = e
                if attempt < MAX_RETRIES - 1:
                    logger.warning(
                        "typeform.timeout_or_network path=%s attempt=%d err=%s",
                        path, attempt + 1, e,
                    )
                    time.sleep(2 + attempt * 2)
                    continue
                raise TypeformAPIError(
                    f"Timeout/network on {method} {path} after {MAX_RETRIES} attempts: {e}"
                ) from e

        raise TypeformAPIError(
            f"Exhausted retries on {method} {path}: {last_exc}"
        )

    # ------------------------------------------------------------------
    # Data endpoints
    # ------------------------------------------------------------------

    def get_me(self) -> dict[str, Any]:
        """Auth check + account identity."""
        return self._request("GET", "/me")

    def list_forms(self) -> Iterator[dict[str, Any]]:
        """Yield every form (paginate). Cheap — ~31 in this account today."""
        page = 1
        while page <= PAGINATION_SAFETY_MAX_PAGES:
            resp = self._request(
                "GET",
                "/forms",
                params={"page": page, "page_size": FORMS_PAGE_SIZE},
            )
            items = resp.get("items", []) or []
            for item in items:
                yield item
            page_count = resp.get("page_count") or 1
            if page >= page_count or not items:
                return
            page += 1

    def get_form(self, form_id: str) -> dict[str, Any]:
        """Full form definition: fields[], hidden[], welcome/thankyou screens,
        logic[]. The question-ref dictionary lives here."""
        return self._request("GET", f"/forms/{form_id}")

    def list_responses(
        self,
        form_id: str,
        *,
        since: str | None = None,
        until: str | None = None,
        before: str | None = None,
        page_size: int = RESPONSES_PAGE_SIZE,
    ) -> dict[str, Any]:
        """One page of responses. Caller drives the loop (typical: cursor
        backfill via `before=<oldest_token_from_previous_page>`).

        CRITICAL: do NOT pass a `sort` param. Typeform returns HTTP 400
        when `before`/`after` is combined with `sort`. Default sort is
        `submitted_at desc` — which is what cursor backfill wants.
        Verified in discovery (§3, §4(b)).

        `since` / `until` are ISO-8601 strings (e.g. '2026-04-24T00:00:00').
        `before` is a Typeform response token (the cursor).
        """
        params: dict[str, Any] = {"page_size": page_size}
        if since:
            params["since"] = since
        if until:
            params["until"] = until
        if before:
            params["before"] = before
        return self._request("GET", f"/forms/{form_id}/responses", params=params)

    def iter_responses(
        self,
        form_id: str,
        *,
        since: str | None = None,
        page_size: int = RESPONSES_PAGE_SIZE,
    ) -> Iterator[dict[str, Any]]:
        """Yield every response on a form, walking newest→oldest via
        cursor. `since` filters to submissions at-or-after the timestamp
        (used by the incremental sync). Without `since`, the full history
        is walked (used by the backfill).

        Idempotency note: each response carries a stable `token` /
        `response_id`. Upserts on response_id make re-walks safe.
        """
        cursor: str | None = None
        page_count = 0
        while page_count < PAGINATION_SAFETY_MAX_PAGES:
            resp = self.list_responses(
                form_id,
                since=since,
                before=cursor,
                page_size=page_size,
            )
            items = resp.get("items", []) or []
            for item in items:
                yield item
            page_count += 1
            if not items:
                return
            # Default sort = submitted_at desc, so items[-1] is the
            # oldest on this page → use its token as the cursor for
            # the next page.
            next_cursor = items[-1].get("token")
            if not next_cursor or next_cursor == cursor:
                return
            cursor = next_cursor
            # The since-window naturally caps the walk; the safety max
            # only fires on a full-history walk against an unexpectedly
            # large form (>200k responses at page_size=1000).
        logger.warning(
            "typeform.pagination_safety_hit form_id=%s page_count=%d",
            form_id, page_count,
        )

    # ------------------------------------------------------------------
    # Webhook subscription endpoints (used by scripts/register_typeform_webhooks.py)
    # ------------------------------------------------------------------

    def list_webhooks(self, form_id: str) -> list[dict[str, Any]]:
        """Existing webhook subscriptions on this form."""
        resp = self._request("GET", f"/forms/{form_id}/webhooks")
        return resp.get("items", []) or []

    def put_webhook(
        self,
        form_id: str,
        tag: str,
        *,
        url: str,
        secret: str,
        enabled: bool = True,
        verify_ssl: bool = True,
    ) -> dict[str, Any]:
        """Create or update a per-form webhook subscription.

        Idempotent on (form_id, tag) — re-running with the same tag
        updates rather than duplicates.
        """
        return self._request(
            "PUT",
            f"/forms/{form_id}/webhooks/{tag}",
            body={
                "url": url,
                "enabled": enabled,
                "verify_ssl": verify_ssl,
                "secret": secret,
            },
        )

    def delete_webhook(self, form_id: str, tag: str) -> None:
        """Remove a webhook subscription. 204 on success."""
        self._request("DELETE", f"/forms/{form_id}/webhooks/{tag}")
