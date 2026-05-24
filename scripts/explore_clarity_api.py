"""Read-only discovery probe against the Microsoft Clarity Data Export API.

Spec: docs/specs/clarity-discovery.md. Throwaway investigation — no
ingestion-module shape decisions in here.

NEVER writes to Clarity (it's a read-only export API anyway). NEVER
writes to Supabase. Reads CLARITY_API_KEY from .env.local.

Endpoint (per official docs at learn.microsoft.com):

    GET https://www.clarity.ms/export-data/api/v1/project-live-insights
        ?numOfDays=<1|2|3>
        &dimension1=<URL|Browser|Device|OS|Source|Medium|Campaign|Channel|Country/Region>
        &dimension2=<...>
        &dimension3=<...>

    Authorization: Bearer <token>

API constraints (THE defining characteristics):

  * Max 10 requests per project per day. Hard cap. Returns 429
    "Exceeded daily limit" when surpassed.
  * Data is restricted to the last 1-3 days. NO historical backfill.
  * Up to 3 dimensions per call.
  * Response limited to 1,000 rows; no pagination.

Budget plan for this probe: ONE call. We pull `numOfDays=3` with
`dimension1=URL` — that single response serves as auth check (401s
would hard-stop us) AND yields:

  * Every metricName block Clarity returns (Traffic, Engagement Time,
    Scroll Depth, Popular Pages, etc.)
  * The full URL list segmented by per-URL breakdown of each metric
  * Definitive answer to "is engagement time per-URL filterable"
    (it'll either have a URL field per row or it won't)

Outputs land under .probe-out/clarity/ (git-ignored via .probe-out/).

Run from the repo root:

    .venv/bin/python scripts/explore_clarity_api.py
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode


REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = REPO_ROOT / ".env.local"
OUT_DIR = REPO_ROOT / ".probe-out" / "clarity"

BASE_URL = "https://www.clarity.ms/export-data/api/v1/project-live-insights"

# Cloudflare sometimes 403s default Python UAs (we saw this on Calendly).
# Use the same UA convention as ingestion/calendly/client.py:USER_AGENT.
USER_AGENT = "ai-enablement/1.0 (+drake@theaipartner.io)"


def load_token() -> str:
    if not ENV_PATH.exists():
        raise SystemExit(f"HARD STOP: {ENV_PATH} not found")
    for raw in ENV_PATH.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        if k.strip() == "CLARITY_API_KEY":
            val = v.strip().strip("'").strip('"')
            if val:
                return val
    raise SystemExit(
        "HARD STOP: CLARITY_API_KEY not in .env.local. Clarity tokens are "
        "admin-only — generate at Clarity Settings → Data Export → "
        "Generate new API token."
    )


def _request(
    params: dict[str, Any],
    token: str,
    *,
    timeout: float = 30.0,
) -> tuple[int, dict, Any]:
    """Returns (status_code, response_headers, parsed_body). Body is the
    parsed JSON on 2xx, the raw text on non-2xx (which may not be JSON
    per microsoft/clarity issue #630)."""
    url = f"{BASE_URL}?{urlencode(params)}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
    }
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            resp_headers = {k.lower(): v for k, v in resp.headers.items()}
            try:
                parsed = json.loads(raw) if raw else []
            except json.JSONDecodeError:
                parsed = {"_raw_text": raw}
            return resp.status, resp_headers, parsed
    except urllib.error.HTTPError as e:
        body_text = ""
        try:
            body_text = e.read().decode()[:2000]
        except Exception:
            pass
        return e.code, dict(e.headers or {}), {"_error": body_text}


def _save(name: str, obj: Any) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    p = OUT_DIR / name
    p.write_text(json.dumps(obj, indent=2, default=str))
    return p


def _summarize_url_block(metric_block: dict) -> dict:
    """For a metric block whose `information` rows include a URL field,
    extract the URL list + top entries by whichever numeric field looks
    most session-count-like."""
    info = metric_block.get("information", [])
    if not isinstance(info, list) or not info:
        return {"row_count": 0, "url_field_present": False}

    sample = info[0]
    url_field = None
    for cand in ("URL", "Url", "url", "PageUrl", "PageURL"):
        if cand in sample:
            url_field = cand
            break

    if url_field is None:
        return {
            "row_count": len(info),
            "url_field_present": False,
            "sample_row_keys": list(sample.keys()),
            "sample_row": sample,
        }

    urls = [r.get(url_field) for r in info if r.get(url_field)]
    # Pick the field most likely to be a session/visit count for ranking.
    rank_field = None
    for cand in (
        "totalSessionCount",
        "sessionCount",
        "visitCount",
        "Visits",
        "PageViews",
    ):
        if cand in sample:
            rank_field = cand
            break

    top = []
    if rank_field:
        def _key(row):
            v = row.get(rank_field)
            try:
                return float(v)
            except (TypeError, ValueError):
                return 0.0
        top = sorted(info, key=_key, reverse=True)[:20]

    return {
        "row_count": len(info),
        "url_field_present": True,
        "url_field_name": url_field,
        "rank_field_used": rank_field,
        "unique_url_count": len(set(urls)),
        "sample_row_keys": list(sample.keys()),
        "top_20_by_rank": top,
        "all_urls": sorted(set(urls)),
    }


def main() -> int:
    token = load_token()
    print(f"Token loaded ({len(token)} chars). Endpoint: {BASE_URL}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    started = datetime.now(timezone.utc).isoformat()

    # SINGLE probe call — URL-segmented, 3-day window. This burns 1 of
    # the 10 daily reqs. If it 401s we hard-stop without burning more.
    params = {"numOfDays": "3", "dimension1": "URL"}
    print(f"\nGET project-live-insights {params} ...")
    status, headers, body = _request(params, token)
    print(f"  → HTTP {status}")
    print(f"  → response headers (lowercased): {sorted(headers.keys())}")

    raw_dump = {
        "started_utc": started,
        "request": {"url": BASE_URL, "params": params},
        "response": {
            "status": status,
            "headers": headers,
            "body": body,
        },
    }
    raw_path = _save("url-segmented-3d.json", raw_dump)
    print(f"  → raw dump: {raw_path.relative_to(REPO_ROOT)}")

    if status == 401 or status == 403:
        print("\nHARD STOP: auth failed.")
        print(f"  Status: {status}")
        print(f"  Body excerpt: {str(body)[:500]}")
        print("  Likely: token expired/revoked, or scope insufficient.")
        print("  Action: admin regenerates at Clarity Settings → Data Export.")
        return 2

    if status == 429:
        print("\nHARD STOP: daily request cap (10/project/day) exceeded.")
        print(f"  Body excerpt: {str(body)[:500]}")
        print("  Action: wait 24h, then re-probe. Do NOT retry today.")
        return 2

    if status != 200:
        print(f"\nHARD STOP: unexpected status {status}.")
        print(f"  Body excerpt: {str(body)[:500]}")
        return 2

    if not isinstance(body, list):
        print(f"\nUnexpected body shape — expected list, got {type(body).__name__}")
        print(f"  Body excerpt: {str(body)[:500]}")
        return 1

    print(f"\n200 OK — body is a list of {len(body)} metric block(s).")

    # Summary
    summary = {
        "request_count": 1,
        "metric_blocks": [],
        "url_field_per_metric": {},
    }
    print("\nMetric blocks returned:")
    for i, block in enumerate(body):
        name = block.get("metricName", f"<unnamed-{i}>")
        info = block.get("information", [])
        row_count = len(info) if isinstance(info, list) else 0
        print(f"  [{i}] metricName={name!r}  rows={row_count}")
        summary["metric_blocks"].append({"index": i, "name": name, "row_count": row_count})

        url_info = _summarize_url_block(block)
        summary["url_field_per_metric"][name] = url_info
        if url_info.get("url_field_present"):
            print(
                f"      url_field={url_info['url_field_name']!r}, "
                f"unique URLs={url_info['unique_url_count']}, "
                f"rank_field={url_info.get('rank_field_used')!r}"
            )
        else:
            print(
                f"      NO URL field on rows — keys: {url_info.get('sample_row_keys')}"
            )

    # Save the digest
    digest_path = _save("digest.json", summary)
    print(f"\nDigest: {digest_path.relative_to(REPO_ROOT)}")

    # All URLs Clarity sees across metrics — union'd
    all_urls: set[str] = set()
    for k, v in summary["url_field_per_metric"].items():
        if v.get("url_field_present"):
            all_urls.update(v.get("all_urls", []))
    print(f"\nDistinct URLs across all per-URL metric blocks: {len(all_urls)}")
    for u in sorted(all_urls)[:50]:
        print(f"  - {u}")
    if len(all_urls) > 50:
        print(f"  ... (+{len(all_urls) - 50} more — see digest.json)")

    print(f"\nBudget burned: 1 / 10 req today. 9 remaining for re-probes if needed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
