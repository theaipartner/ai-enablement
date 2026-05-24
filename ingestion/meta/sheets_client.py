"""Google Sheets API v4 reader for the Meta ad-spend pipeline.

Auth is Drake's existing Google OAuth token (the one the Teams
calendar-sync cron uses) — see `shared/google_oauth.get_valid_access_token`.
Caller passes the resolved access token; this module is a pure HTTP
adapter with no auth concerns of its own.

Sheets API v4 endpoints used:
  GET /v4/spreadsheets/{id}?fields=sheets.properties
      → discover tab title (don't hardcode "Sheet1" — the tab name
        could change in a future export config; cheap one-time fetch
        per cron tick)
  GET /v4/spreadsheets/{id}/values/{range}
      → fetch row arrays for parsing

No SDK dependency — `urllib.request` only, same posture as
`shared/slack_post.py` + `shared/google_oauth.py` + the Close client.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

logger = logging.getLogger("ai_enablement.meta.sheets_client")

_SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets"
_TIMEOUT_SECONDS = 15.0


class SheetsAPIError(RuntimeError):
    """Raised on any non-2xx response from the Sheets API. Caller
    audits + skips this tick rather than crashing the whole cron."""


def fetch_first_tab_title(spreadsheet_id: str, access_token: str) -> str:
    """Return the first tab's title (e.g. 'Sheet1') for the given spreadsheet.

    Cheap discovery call so the cron doesn't hardcode "Sheet1" — if the
    tab is renamed in Cortana's export config, this still works.
    """
    url = (
        f"{_SHEETS_API_BASE}/{spreadsheet_id}"
        f"?fields=sheets.properties"
    )
    body = _get(url, access_token)
    sheets = body.get("sheets") or []
    if not sheets:
        raise SheetsAPIError(f"spreadsheet {spreadsheet_id!r} has no sheets")
    props = sheets[0].get("properties") or {}
    title = props.get("title")
    if not title:
        raise SheetsAPIError(
            f"spreadsheet {spreadsheet_id!r} first sheet has no title"
        )
    return title


def fetch_values(
    spreadsheet_id: str,
    access_token: str,
    range_a1: str,
) -> list[list[str]]:
    """Fetch a range from the spreadsheet. Returns the `values` array
    of row arrays (header is row 0; data starts row 1).

    `range_a1` examples: `Sheet1!A:J`, `Sheet1!A1:J100`. URL-encoded
    by this function.
    """
    range_enc = urllib.parse.quote(range_a1)
    url = f"{_SHEETS_API_BASE}/{spreadsheet_id}/values/{range_enc}"
    body = _get(url, access_token)
    return body.get("values") or []


def _get(url: str, access_token: str) -> dict[str, Any]:
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_SECONDS) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        # Body may include the spreadsheet id but no credentials —
        # surface trimmed body for diagnosis (Sheets API errors are
        # informative: "Google Sheets API has not been used in project N
        # before or it is disabled", "Insufficient Permission", etc.)
        body_text = ""
        try:
            body_text = exc.read().decode("utf-8")[:500]
        except Exception:
            pass
        raise SheetsAPIError(
            f"sheets api http {exc.code} on {url}: {body_text}"
        ) from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise SheetsAPIError(
            f"sheets api transport error on {url}: {type(exc).__name__}"
        ) from exc
