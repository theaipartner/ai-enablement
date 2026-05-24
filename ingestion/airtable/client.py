"""Airtable REST API client — Bearer PAT auth + retry on 429.

Stdlib urllib only (matches close/typeform/calendly/clarity precedent —
no SDK dependency for the ingestion clients).

Auth: `Authorization: Bearer <PAT>`. The PAT is loaded via
`AIRTABLE_SALES_PAT` env var. Discovery confirmed scopes:
  * `schema.bases:read`  — needed for `get_base_schema()` (rarely used)
  * `data.records:read`  — needed for ALL record reads (load-bearing)
  * `webhook:manage`     — NOT yet granted; needed for the registration
                            helper to create the live webhook. Read-path
                            (records + payloads-fetch) works without it.

Rate limit: 5 req/sec per base. The 429 path includes a `Retry-After`
header which we honor.

Endpoint paths:
  * Records:  `GET  /v0/{baseId}/{tableId}`             (data.records:read)
  * Records:  `GET  /v0/{baseId}/{tableId}/{recordId}`  (data.records:read)
  * Meta:     `GET  /v0/meta/bases/{baseId}/tables`     (schema.bases:read)
  * Webhooks: `GET  /v0/bases/{baseId}/webhooks`        (webhook:manage)
  * Webhooks: `POST /v0/bases/{baseId}/webhooks`        (webhook:manage)
  * Webhooks: `POST /v0/bases/{baseId}/webhooks/{webhookId}/refresh`  (webhook:manage)
  * Webhooks: `DELETE /v0/bases/{baseId}/webhooks/{webhookId}`        (webhook:manage)
  * Payloads: `GET  /v0/bases/{baseId}/webhooks/{webhookId}/payloads`
               (data.records:read — does NOT need webhook:manage to FETCH,
                only to CREATE)

**Don't confuse records vs Meta paths.** Records is `/v0/{baseId}/...`;
Meta is `/v0/meta/bases/{baseId}/...`. Easy 404.
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

from ingestion.airtable import BASE_ID

logger = logging.getLogger("ai_enablement.airtable.client")

BASE_URL = "https://api.airtable.com"

DEFAULT_TIMEOUT_S = 30.0
MAX_RETRIES = 3
PAGINATION_SAFETY_MAX_PAGES = 200

USER_AGENT = "ai-enablement/1.0 (+drake@theaipartner.io)"


class AirtableAPIError(RuntimeError):
    """Raised for any non-2xx response we don't handle as a retry."""


class AirtableClient:
    """Thin wrapper around the Airtable REST API.

    Use `from_env()` to construct in pipeline + script + cron contexts.
    """

    def __init__(self, api_key: str, timeout_s: float = DEFAULT_TIMEOUT_S):
        if not api_key:
            raise RuntimeError(
                "AirtableClient requires a non-empty api_key. Set "
                "AIRTABLE_SALES_PAT in .env.local (Personal Access Token, "
                "minted at airtable.com/create/tokens with schema.bases:read "
                "+ data.records:read + optionally webhook:manage)."
            )
        self._api_key = api_key
        self._timeout_s = timeout_s

    @classmethod
    def from_env(cls) -> "AirtableClient":
        key = os.environ.get("AIRTABLE_SALES_PAT")
        if not key:
            raise RuntimeError(
                "AIRTABLE_SALES_PAT not set. Required in .env.local for "
                "local runs AND in Vercel env vars for the deployed cron + "
                "webhook receiver."
            )
        return cls(api_key=key)

    # ------------------------------------------------------------------
    # Low-level request — retry on 429 with Retry-After, hard error on
    # 401/403, raise typed exception on other non-2xx.
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
            "User-Agent": USER_AGENT,
        }
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        last_exc: Exception | None = None
        for attempt in range(MAX_RETRIES):
            req = urllib.request.Request(
                url, method=method, data=data, headers=headers,
            )
            try:
                with urllib.request.urlopen(req, timeout=self._timeout_s) as resp:
                    payload = resp.read().decode("utf-8")
                    return json.loads(payload) if payload else {}
            except urllib.error.HTTPError as e:
                if e.code in (401, 403):
                    body_text = ""
                    try:
                        body_text = e.read().decode()[:500]
                    except Exception:
                        pass
                    raise AirtableAPIError(
                        f"Airtable auth/scope failed: HTTP {e.code} on "
                        f"{method} {path}. Body: {body_text!r}"
                    ) from e
                if e.code == 429 and attempt < MAX_RETRIES - 1:
                    retry_after = int(e.headers.get("Retry-After", "5"))
                    logger.warning(
                        "airtable.rate_limited path=%s retry_after=%ds attempt=%d",
                        path, retry_after, attempt + 1,
                    )
                    time.sleep(retry_after)
                    continue
                body_text = ""
                try:
                    body_text = e.read().decode()[:1000]
                except Exception:
                    pass
                raise AirtableAPIError(
                    f"Airtable HTTP {e.code} on {method} {path}: {body_text!r}"
                ) from e
            except (urllib.error.URLError, TimeoutError) as e:
                last_exc = e
                if attempt < MAX_RETRIES - 1:
                    logger.warning(
                        "airtable.transport_error path=%s attempt=%d err=%s",
                        path, attempt + 1, e,
                    )
                    time.sleep(2 + attempt * 2)
                    continue
                raise AirtableAPIError(
                    f"Airtable transport failure on {method} {path}: {e}"
                ) from e
        raise AirtableAPIError(
            f"Exhausted retries on {method} {path}: {last_exc}"
        )

    # ------------------------------------------------------------------
    # Records — read path
    # ------------------------------------------------------------------

    def list_records(
        self,
        table_id: str,
        *,
        filter_by_formula: str | None = None,
        page_size: int = 100,
        offset: str | None = None,
        fields: list[str] | None = None,
    ) -> dict[str, Any]:
        """One page of records. Caller drives offset-pagination via
        the `offset` token in the response.

        `filter_by_formula` is the Airtable formula string (e.g.
        `IS_AFTER(CREATED_TIME(), DATETIME_PARSE('2026-05-23T00:00:00.000Z'))`).
        """
        params: dict[str, Any] = {"pageSize": page_size}
        if filter_by_formula:
            params["filterByFormula"] = filter_by_formula
        if offset:
            params["offset"] = offset
        if fields:
            # Airtable wants `fields[]` repeated (urllib's urlencode
            # handles list-valued tuples). Build manually for clarity.
            params["fields[]"] = fields
        return self._request("GET", f"/v0/{BASE_ID}/{table_id}", params=params)

    def iter_records(
        self,
        table_id: str,
        *,
        filter_by_formula: str | None = None,
        page_size: int = 100,
    ) -> Iterator[dict[str, Any]]:
        """Yield every record (offset-paginate). Used by backfill + cron."""
        offset: str | None = None
        page_count = 0
        while page_count < PAGINATION_SAFETY_MAX_PAGES:
            resp = self.list_records(
                table_id,
                filter_by_formula=filter_by_formula,
                page_size=page_size,
                offset=offset,
            )
            for r in resp.get("records") or []:
                yield r
            page_count += 1
            offset = resp.get("offset")
            if not offset:
                return
        logger.warning(
            "airtable.pagination_safety_hit table=%s pages=%d",
            table_id, page_count,
        )

    def get_record(self, table_id: str, record_id: str) -> dict[str, Any]:
        """Single-record fetch. Used by the webhook payload path —
        the payloads endpoint gives us the changed record IDs, then we
        fetch each record's current state for the upsert."""
        return self._request(
            "GET", f"/v0/{BASE_ID}/{table_id}/{record_id}",
        )

    # ------------------------------------------------------------------
    # Meta API — schema (used by the discovery probe, not the runtime path)
    # ------------------------------------------------------------------

    def get_base_schema(self) -> dict[str, Any]:
        """Pull the full base schema (all tables + their fields).
        Requires `schema.bases:read`. Not used in the live ingestion
        path — kept for diagnostic/operational scripts."""
        return self._request("GET", f"/v0/meta/bases/{BASE_ID}/tables")

    # ------------------------------------------------------------------
    # Webhooks — registration + payloads pull
    # ------------------------------------------------------------------
    # The webhook model:
    #   1. POST /v0/bases/{baseId}/webhooks creates a subscription with
    #      a `specification` filter (which tables / change types) and
    #      returns the webhook id + macSecretBase64 (the secret used
    #      to sign notification pings).
    #   2. Airtable POSTs a bare notification ping to the receiver
    #      whenever the base changes. The ping body does NOT contain
    #      the changed data — just a notification with a base id +
    #      webhook id.
    #   3. The receiver verifies the ping's MAC against macSecretBase64
    #      then calls GET .../webhooks/{webhookId}/payloads?cursor=N
    #      to fetch what changed since cursor N. The response includes
    #      a `cursor` field for the next call.
    #   4. The webhook expires after 7 days of inactivity unless
    #      refreshed via POST .../webhooks/{webhookId}/refresh.

    def list_webhooks(self) -> list[dict[str, Any]]:
        """Existing webhooks on the base. Requires `webhook:manage`."""
        resp = self._request("GET", f"/v0/bases/{BASE_ID}/webhooks")
        return resp.get("webhooks") or []

    def create_webhook(
        self,
        notification_url: str,
        *,
        specification: dict[str, Any],
    ) -> dict[str, Any]:
        """Create a base-level webhook subscription.

        Returns the full response including `id` (webhook id) and
        `macSecretBase64` (one-shot — Airtable only shows it here;
        Drake stores it as AIRTABLE_WEBHOOK_MAC_SECRET in Vercel).

        Requires `webhook:manage`.

        The `specification.options.filters` selects which tables /
        change types fire the webhook — typically:
            {"options": {"filters": {
                "dataTypes": ["tableData"],
                "recordChangeScope": "<tableId>"  -- or no scope to cover all tables
            }}}
        Airtable also supports per-table filters via fromSources / watchDataInFieldIds.
        """
        return self._request(
            "POST",
            f"/v0/bases/{BASE_ID}/webhooks",
            body={
                "notificationUrl": notification_url,
                "specification": specification,
            },
        )

    def delete_webhook(self, webhook_id: str) -> None:
        """Remove a webhook subscription. Returns nothing meaningful."""
        self._request(
            "DELETE", f"/v0/bases/{BASE_ID}/webhooks/{webhook_id}",
        )

    def get_webhook_payloads(
        self,
        webhook_id: str,
        *,
        cursor: int | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        """Fetch payloads since the given cursor (default cursor=1 for
        first call). Response carries `payloads[]`, `cursor` (the next
        cursor to use), and `mightHaveMore` (boolean — true means more
        pages).

        Requires `data.records:read` only (NOT webhook:manage). This is
        the load-bearing read in the webhook receiver path."""
        params: dict[str, Any] = {}
        if cursor is not None:
            params["cursor"] = cursor
        if limit is not None:
            params["limit"] = limit
        return self._request(
            "GET",
            f"/v0/bases/{BASE_ID}/webhooks/{webhook_id}/payloads",
            params=params,
        )

    def refresh_webhook(self, webhook_id: str) -> dict[str, Any]:
        """Extend the webhook's 7-day idle expiry. Cron calls this on
        every tick as cheap insurance against silent webhook death.
        Requires `webhook:manage`."""
        return self._request(
            "POST",
            f"/v0/bases/{BASE_ID}/webhooks/{webhook_id}/refresh",
        )
