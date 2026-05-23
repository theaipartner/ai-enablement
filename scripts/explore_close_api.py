"""Read-only discovery probe against the Close CRM REST API.

Throwaway investigation per docs/specs/close-smartview-discovery.md.
NEVER writes to Close, NEVER writes to Supabase. Reads CLOSE_API_KEY from
.env.local at the repo root.

Run from the repo root:

    python3 scripts/explore_close_api.py

Outputs land under .probe-out/close/ (git-ignored — added below) so the
findings report can fold raw JSON in by reference rather than via memory.

Why a flat script (vs a module under ingestion/close/): the spec is
explicit that the eventual ingestion module's shape is unknown and
seeding one now pre-commits a design. This file is reconnaissance only.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import urllib.request
import urllib.error


REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = REPO_ROOT / ".env.local"
OUT_DIR = REPO_ROOT / ".probe-out" / "close"

BASE_URL = "https://api.close.com/api/v1"

# Names whose Smartview is in scope for deep s_query analysis. Substring
# match, case-insensitive. Drawn from the daily-tracker "Overall Engine"
# sheet vocab the spec calls out: first-message responses, triages, dials,
# hand-downs/offs, DQs, downsells, booked meetings, setter/closer.
RELEVANT_NAME_TOKENS = (
    "triage",
    "dial",
    "hand-down",
    "hand down",
    "handdown",
    "hand-off",
    "hand off",
    "handoff",
    "dq",
    "disqual",
    "downsell",
    "down-sell",
    "booked",
    "meeting",
    "setter",
    "closer",
    "tier 1",
    "tier 2",
    "first message",
    "first-message",
    "first response",
    "response",
    "deposit",
    "cash",
)


def load_close_key() -> str:
    """Read CLOSE_API_KEY from .env.local. Hard-stop if missing.

    Bare-minimum parser — no python-dotenv dep needed for one key.
    """
    if not ENV_PATH.exists():
        raise SystemExit(f"HARD STOP: {ENV_PATH} not found")
    for raw in ENV_PATH.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, _, v = line.partition("=")
        if k.strip() == "CLOSE_API_KEY":
            return v.strip().strip("'").strip('"')
    raise SystemExit(
        "HARD STOP: CLOSE_API_KEY not found in .env.local. "
        "Spec requires that exact name — do not guess alternates."
    )


def _basic_auth_header(api_key: str) -> str:
    # Close: api key is the username, password is empty (trailing colon).
    token = base64.b64encode(f"{api_key}:".encode()).decode()
    return f"Basic {token}"


def _request(
    method: str,
    path: str,
    api_key: str,
    *,
    params: dict[str, Any] | None = None,
    body: dict[str, Any] | None = None,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """Single HTTP call. Returns parsed JSON. Surfaces status code in errors.

    Raises SystemExit on 401/403 per spec hard-stop rule (no auth-variant
    brute-forcing). Retries once on 429 after Retry-After backoff.
    """
    url = f"{BASE_URL}{path}"
    if params:
        url = f"{url}?{urlencode(params)}"
    data = None
    headers = {
        "Authorization": _basic_auth_header(api_key),
        "Accept": "application/json",
    }
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"

    for attempt in range(2):
        req = urllib.request.Request(url, method=method, data=data, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                payload = resp.read().decode()
                return json.loads(payload) if payload else {}
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise SystemExit(
                    f"HARD STOP: {e.code} on {method} {path}. "
                    f"Confirm CLOSE_API_KEY is current and Basic-auth "
                    f"is api_key:''. Response body: {e.read().decode()[:500]}"
                )
            if e.code == 429 and attempt == 0:
                retry_after = int(e.headers.get("Retry-After", "5"))
                print(f"  [429] backing off {retry_after}s")
                time.sleep(retry_after)
                continue
            err_body = ""
            try:
                err_body = e.read().decode()[:1000]
            except Exception:
                pass
            raise RuntimeError(
                f"HTTP {e.code} on {method} {path}: {err_body}"
            ) from e
        except urllib.error.URLError as e:
            raise RuntimeError(f"Network error on {method} {path}: {e}") from e

    raise RuntimeError(f"Exhausted retries on {method} {path}")


def _write_json(name: str, payload: Any) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    target = OUT_DIR / name
    target.write_text(json.dumps(payload, indent=2, sort_keys=True))
    return target


def is_relevant_smartview(name: str) -> bool:
    n = name.lower()
    return any(tok in n for tok in RELEVANT_NAME_TOKENS)


def classify_s_query_shape(s_query: dict[str, Any] | None) -> str:
    """Heuristic activity-driven vs status-driven classifier.

    The Close advanced-filter s_query is a tree of typed nodes. We walk
    it and look for tell-tale leaf types. This is a first-pass label —
    a human (or Director) should review the dumped query for borderline
    cases. We emit one of:
        activity      — references activity_type / has_activity / date_created on activities
        status        — references lead.status_id / opportunity.status_id (point-in-time membership)
        mixed         — both signals present
        custom_field  — references custom field id without an activity/status leaf
        unknown       — couldn't classify
    """
    if not s_query:
        return "unknown (empty query)"
    text = json.dumps(s_query).lower()

    activity_signals = (
        '"activity_type"',
        '"has_activity"',
        '"call"',
        '"email"',
        '"meeting"',
        '"sms"',
        '"task_completed"',
        '"date_completed"',
    )
    status_signals = (
        '"status_id"',
        '"lead_status"',
        '"opportunity_status"',
        '"status_label"',
        '"status_type"',
    )
    custom_field_signals = ('"custom_field"', '"cf_"', '"custom."',)

    has_activity = any(s in text for s in activity_signals)
    has_status = any(s in text for s in status_signals)
    has_cf = any(s in text for s in custom_field_signals)

    if has_activity and has_status:
        return "mixed (activity + status leaves)"
    if has_activity:
        return "activity"
    if has_status:
        return "status"
    if has_cf:
        return "custom_field"
    return "unknown"


def extract_custom_field_ids(s_query: dict[str, Any] | None) -> list[str]:
    """Pull custom-field IDs referenced in an s_query, if any.

    Close custom-field IDs look like 'cf_xxxxxxxxxxxx'. We collect any
    string token that starts with cf_ from the JSON-serialized form.
    """
    if not s_query:
        return []
    text = json.dumps(s_query)
    out: set[str] = set()
    i = 0
    while True:
        idx = text.find('"cf_', i)
        if idx == -1:
            break
        end = text.find('"', idx + 1)
        if end == -1:
            break
        out.add(text[idx + 1:end])
        i = end + 1
    return sorted(out)


def list_all_smartviews(api_key: str) -> list[dict[str, Any]]:
    """Paginate /saved_search/ and return every entry."""
    results: list[dict[str, Any]] = []
    skip = 0
    limit = 100
    while True:
        page = _request(
            "GET",
            "/saved_search/",
            api_key,
            params={"_skip": skip, "_limit": limit},
        )
        chunk = page.get("data", [])
        results.extend(chunk)
        if not page.get("has_more"):
            break
        if not chunk:
            break
        skip += len(chunk)
        if skip > 5000:
            # Safety net — the org should not have 5000+ smart views; if it
            # does, this is a bug in our loop or in pagination.
            print(f"  WARN: skipping out at _skip={skip} (>5000) — investigate")
            break
    return results


def main() -> int:
    print("=" * 70)
    print("Close CRM discovery probe — read-only")
    print("=" * 70)

    api_key = load_close_key()
    print(f"Loaded CLOSE_API_KEY (len={len(api_key)}) from {ENV_PATH}")

    # ---- 1. Auth check ----------------------------------------------------
    print("\n[1] GET /me/ — auth check")
    me = _request("GET", "/me/", api_key)
    _write_json("01_me.json", me)
    print(f"    User: {me.get('first_name')} {me.get('last_name')} "
          f"<{me.get('email')}>")
    orgs = me.get("organizations") or []
    print(f"    Orgs: {len(orgs)}")
    for o in orgs:
        print(f"      - {o.get('id')}  {o.get('name')}")
    primary_org_id = orgs[0]["id"] if orgs else None

    # ---- 2. Smartview inventory ------------------------------------------
    print("\n[2] GET /saved_search/ — list all Smart Views")
    smartviews = list_all_smartviews(api_key)
    _write_json("02_smartviews_full.json", smartviews)
    print(f"    Total Smart Views: {len(smartviews)}")

    # Compact inventory
    compact = [
        {
            "id": sv.get("id"),
            "name": sv.get("name"),
            "type": sv.get("type"),
            "is_shared": sv.get("is_shared"),
            "user_id": sv.get("user_id"),
            "has_s_query": bool(sv.get("s_query")),
            "has_legacy_query": bool(sv.get("query")),
        }
        for sv in smartviews
    ]
    _write_json("02_smartviews_compact.json", compact)

    # Type breakdown
    by_type: dict[str, int] = {}
    by_shared: dict[bool | None, int] = {}
    for sv in smartviews:
        by_type[sv.get("type", "<none>")] = by_type.get(sv.get("type", "<none>"), 0) + 1
        by_shared[sv.get("is_shared")] = by_shared.get(sv.get("is_shared"), 0) + 1
    print(f"    Type breakdown: {by_type}")
    print(f"    Shared breakdown: {by_shared}")

    # ---- 3. Deep-analyze relevant subset ---------------------------------
    print("\n[3] Deep-analyze sales-funnel-relevant Smart Views")
    relevant = [sv for sv in smartviews if is_relevant_smartview(sv.get("name", ""))]
    print(f"    Relevant by name keyword: {len(relevant)} / {len(smartviews)}")

    deep: list[dict[str, Any]] = []
    shape_counts: dict[str, int] = {}
    cf_ids_referenced: set[str] = set()
    for sv in relevant:
        shape = classify_s_query_shape(sv.get("s_query"))
        cf_ids = extract_custom_field_ids(sv.get("s_query"))
        cf_ids_referenced.update(cf_ids)
        deep.append({
            "id": sv.get("id"),
            "name": sv.get("name"),
            "type": sv.get("type"),
            "is_shared": sv.get("is_shared"),
            "shape": shape,
            "custom_field_ids": cf_ids,
            "s_query": sv.get("s_query"),
            "legacy_query": sv.get("query"),
        })
        shape_counts[shape] = shape_counts.get(shape, 0) + 1
    _write_json("03_relevant_deep.json", deep)
    print(f"    Shape classification: {shape_counts}")
    print(f"    Distinct custom-field IDs referenced: {len(cf_ids_referenced)}")

    # ---- 4. Custom-field schemas ----------------------------------------
    print("\n[4] Custom-field schemas (lead, opportunity, contact, activity)")
    schemas: dict[str, Any] = {}
    for obj_type in ("lead", "opportunity", "contact", "activity"):
        try:
            schema = _request("GET", f"/custom_field_schema/{obj_type}/", api_key)
            schemas[obj_type] = schema
            n = len((schema.get("fields") or []))
            print(f"    {obj_type}: {n} fields")
        except RuntimeError as e:
            schemas[obj_type] = {"_error": str(e)}
            print(f"    {obj_type}: ERROR {e}")
    _write_json("04_custom_field_schemas.json", schemas)

    # Resolve each referenced cf_id to its definition for the report.
    resolved_cfs: dict[str, dict[str, Any] | None] = {}
    for obj_type, schema in schemas.items():
        if not isinstance(schema, dict):
            continue
        for f in (schema.get("fields") or []):
            fid = f.get("id")
            if fid in cf_ids_referenced:
                resolved_cfs[fid] = {
                    "object_type": obj_type,
                    "name": f.get("name"),
                    "type": f.get("type"),
                    "choices": f.get("choices"),
                    "accepts_multiple_values": f.get("accepts_multiple_values"),
                    "is_shared": f.get("is_shared"),
                    "description": f.get("description"),
                }
    for cf in sorted(cf_ids_referenced):
        if cf not in resolved_cfs:
            resolved_cfs[cf] = None  # referenced but not resolved
    _write_json("04b_resolved_referenced_cfs.json", resolved_cfs)
    unresolved = sum(1 for v in resolved_cfs.values() if v is None)
    print(f"    Resolved {len(resolved_cfs) - unresolved}/{len(resolved_cfs)} "
          f"referenced cf_* IDs against custom-field schemas")

    # ---- 5. Activity-report metric list ---------------------------------
    print("\n[5] GET /report/activity/metrics/ — predefined metrics list")
    try:
        metrics_resp = _request("GET", "/report/activity/metrics/", api_key)
        _write_json("05_activity_metrics.json", metrics_resp)
        # Response shape unclear; surface whatever top-level keys exist.
        if isinstance(metrics_resp, dict):
            print(f"    Top-level keys: {list(metrics_resp.keys())}")
            data = metrics_resp.get("data")
            if isinstance(data, list):
                print(f"    Metric count: {len(data)}")
                for m in data[:5]:
                    print(f"      example: {m}")
        elif isinstance(metrics_resp, list):
            print(f"    Metrics: {len(metrics_resp)}")
    except RuntimeError as e:
        print(f"    ERROR: {e}")

    # ---- 6. Reporting API test against one Smartview --------------------
    print("\n[6] POST /report/activity/ — test against one Smartview")
    sample = None
    # Prefer activity-shape relevant smartviews (Reporting / Activity report
    # is the natural fit there).
    for d in deep:
        if d["shape"].startswith("activity") and d["type"] == "lead":
            sample = d
            break
    if sample is None:
        for d in deep:
            if d["type"] == "lead":
                sample = d
                break
    if sample is None and smartviews:
        sample = {
            "id": smartviews[0]["id"],
            "name": smartviews[0]["name"],
            "type": smartviews[0].get("type"),
            "shape": "fallback (no relevant lead smartview found)",
        }

    if sample is None:
        print("    Skipped — no Smart Views to test against")
    else:
        print(f"    Using: {sample['name']} (id={sample['id']}, "
              f"type={sample['type']}, shape={sample['shape']})")
        body = {
            "type": "overview",
            "relative_range": "last-week",
            "query": {"type": "saved_search", "saved_search_id": sample["id"]},
        }
        # If we have a known activity metric, include it; otherwise omit
        # `metrics` and see whether the API defaults / errors informatively.
        # We capture the raw shape either way.
        try:
            report = _request("POST", "/report/activity/", api_key, body=body)
            _write_json("06_report_activity_sample.json", {
                "request": body,
                "smartview_used": sample,
                "response": report,
            })
            keys = list(report.keys()) if isinstance(report, dict) else type(report).__name__
            print(f"    Response top-level keys/type: {keys}")
        except RuntimeError as e:
            _write_json("06_report_activity_sample.json", {
                "request": body,
                "smartview_used": sample,
                "error": str(e),
            })
            print(f"    Error (captured to file): {e}")

    # ---- 7. Status report (point-in-time) test, if org id available -----
    if primary_org_id:
        print("\n[7] GET /report/statuses/lead/{org_id}/ — status snapshot")
        try:
            status_report = _request(
                "GET",
                f"/report/statuses/lead/{primary_org_id}/",
                api_key,
                params={
                    # Last 14 days, ISO.
                    "date_start": _iso_days_ago(14),
                    "date_end": _iso_days_ago(0),
                },
            )
            _write_json("07_status_report_lead.json", status_report)
            keys = (list(status_report.keys())
                    if isinstance(status_report, dict) else type(status_report).__name__)
            print(f"    Response top-level keys: {keys}")
        except RuntimeError as e:
            print(f"    ERROR: {e}")
    else:
        print("\n[7] Skipped status report — no primary org id")

    # ---- 8. Lead-status definitions (for status-driven smartview context) -
    print("\n[8] GET /status/lead/ — lead-status definitions")
    try:
        statuses = _request("GET", "/status/lead/", api_key)
        _write_json("08_lead_statuses.json", statuses)
        data = statuses.get("data", []) if isinstance(statuses, dict) else []
        print(f"    Lead statuses: {len(data)}")
        for s in data:
            print(f"      - {s.get('id')}  {s.get('label')}")
    except RuntimeError as e:
        print(f"    ERROR: {e}")

    print("\n" + "=" * 70)
    print(f"Done. Outputs under: {OUT_DIR}")
    print("=" * 70)
    return 0


def _iso_days_ago(n: int) -> str:
    from datetime import datetime, timedelta, timezone as _tz
    return (datetime.now(_tz.utc) - timedelta(days=n)).date().isoformat()


if __name__ == "__main__":
    sys.exit(main())
