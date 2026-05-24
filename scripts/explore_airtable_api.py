"""Read-only Airtable discovery probe — four sales-funnel tables.

Spec: docs/specs/airtable-discovery.md. Throwaway investigation; no
ingestion-module decisions in here.

NEVER writes to Airtable. NEVER writes to Supabase. Reads PATs from
.env.local (.env.local is .gitignored).

Target base + tables (Drake-provided, all in ONE base):

    appCWa6TV6p7EBarC
      tblaoMsiE3FSkHjQt  Setter Triage Calls
      tblYsh3fxTpXuPdIW  Full Closer Report (EOC)
      tbla3benxdsq4n0kP  Closer Booked Calls
      tblRNhANZ7OGqjlrM  Setter Direct Bookings

Probe shape (one HTTP call per step, ~7 total against the target base
+ 1 whoami; well under Airtable's 5/sec/base limit):

  1. /v0/meta/whoami         — confirm token works (returns user id;
                               scopes only for OAuth so PATs report
                               nothing useful here — empirical scope
                               check happens in step 2/3).
  2. /v0/meta/bases/{baseId}/tables — Meta API schema for ALL tables
     in the base. If 403, the token lacks schema.bases:read OR
     base-access; try next candidate PAT.
  3. /v0/{baseId}/{tableId}?pageSize=3 (per table, 4 calls)
     — record sample. Empty fields are OMITTED from `fields{}` so
     Meta API is authoritative for the field set.
  4. /v0/bases/{baseId}/webhooks (optional, may 403 — webhook:manage
     not required for ingestion's read path, just a docs-confirmation
     probe).

Outputs land under .probe-out/airtable/ (git-ignored via .probe-out/).
PII is NOT stripped from raw dumps (raw is a local-only artifact);
the report at docs/reports/airtable-discovery.md masks all PII.

Run from the repo root:

    .venv/bin/python scripts/explore_airtable_api.py
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode


REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = REPO_ROOT / ".env.local"
OUT_DIR = REPO_ROOT / ".probe-out" / "airtable"

BASE_URL = "https://api.airtable.com"
TARGET_BASE_ID = "appCWa6TV6p7EBarC"

TARGET_TABLES: dict[str, str] = {
    # Airtable table id → human label (the labels are NOT used as
    # identifiers; only for report-side readability)
    # Resume-spec scope narrowing 2026-05-24: dropped Closer Booked
    # Calls (tbla3benxdsq4n0kP) + Setter Direct Bookings
    # (tblRNhANZ7OGqjlrM) per Drake. Only Setter Triage + Full Closer
    # Report are probed for records/semantics; the base-level schema
    # call still returns ALL tables in the base for context.
    "tblaoMsiE3FSkHjQt": "Setter Triage Calls",
    "tblYsh3fxTpXuPdIW": "Full Closer Report",
}

# Token walk order matters: first to 200 on the schema call wins.
# AIRTABLE_SALES_PAT minted by Drake 2026-05-24 with schema.bases:read
# + data.records:read + base appCWa6TV6p7EBarC access — primary
# candidate. The other two stay as fallbacks (they 403 on the schema
# call per the PARTIAL report; harmless to attempt).
CANDIDATE_TOKEN_VARS: list[str] = [
    "AIRTABLE_SALES_PAT",
    "AIRTABLE_ACCOUNTABILITY_PAT",
    "AIRTABLE_API_KEY",
]

USER_AGENT = "ai-enablement/1.0 (+drake@theaipartner.io)"
DEFAULT_TIMEOUT_S = 30.0


def _load_env() -> dict[str, str]:
    if not ENV_PATH.exists():
        raise SystemExit(f"HARD STOP: {ENV_PATH} not found")
    env: dict[str, str] = {}
    for raw in ENV_PATH.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip().strip("'").strip('"')
    return env


def _request(
    path_or_url: str,
    token: str,
    *,
    params: dict[str, Any] | None = None,
    timeout: float = DEFAULT_TIMEOUT_S,
) -> tuple[int, dict, Any]:
    """GET. Returns (status, response_headers, body).
    Body is parsed JSON on 2xx, error envelope on non-2xx."""
    if path_or_url.startswith("http"):
        url = path_or_url
    else:
        url = f"{BASE_URL}{path_or_url}"
    if params:
        url = f"{url}?{urlencode(params)}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    }
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            resp_headers = {k.lower(): v for k, v in resp.headers.items()}
            try:
                parsed = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                parsed = {"_raw_text": raw}
            return resp.status, resp_headers, parsed
    except urllib.error.HTTPError as e:
        body_text = ""
        try:
            body_text = e.read().decode()[:2000]
        except Exception:
            pass
        try:
            err_parsed = json.loads(body_text)
        except json.JSONDecodeError:
            err_parsed = {"_raw_error_text": body_text}
        return e.code, dict(e.headers or {}), {"_error": err_parsed}


def _save(name: str, obj: Any) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    p = OUT_DIR / name
    p.write_text(json.dumps(obj, indent=2, default=str))
    return p


# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------


def _try_token_against_meta_api(token: str, token_var_name: str) -> tuple[bool, dict]:
    """Returns (works, diagnostic). `works` = True iff the token can
    read the target base's schema (the load-bearing scope). The
    diagnostic dict is dumped to the probe output regardless."""
    print(f"  Testing {token_var_name}...")
    diag: dict[str, Any] = {"token_var": token_var_name}

    # whoami first (cheapest, no scope needed)
    status, _, body = _request("/v0/meta/whoami", token)
    diag["whoami"] = {"status": status, "body": body}
    print(f"    whoami: HTTP {status}")
    if status != 200:
        print(f"    → token rejected by /meta/whoami; skipping rest")
        return False, diag

    user_id = body.get("id") if isinstance(body, dict) else None
    print(f"    user id: {user_id!r}")

    # meta-schema-on-the-target-base (load-bearing)
    status, _, body = _request(
        f"/v0/meta/bases/{TARGET_BASE_ID}/tables", token
    )
    diag["meta_schema"] = {"status": status, "body": body}
    print(f"    meta /tables on {TARGET_BASE_ID}: HTTP {status}")
    if status == 200:
        tables = body.get("tables", []) if isinstance(body, dict) else []
        print(f"    → SUCCESS — base accessible, {len(tables)} tables visible")
        return True, diag
    if status == 403:
        print(f"    → 403: token lacks schema.bases:read OR no access to this base")
    elif status == 404:
        print(f"    → 404: base not found (token may be valid but scoped elsewhere)")
    elif status == 401:
        print(f"    → 401: token invalid / expired")
    return False, diag


def auth_and_scope_check(env: dict[str, str]) -> tuple[str | None, str | None, dict]:
    """Walk the candidate PATs; return (winning_token, winning_var, all_diagnostics)."""
    print("\n=== Step 1: token + scope viability ===")
    all_diags: dict[str, Any] = {"candidates": []}

    for var in CANDIDATE_TOKEN_VARS:
        token = env.get(var, "")
        if not token:
            print(f"  {var}: not set in .env.local — skipping")
            all_diags["candidates"].append(
                {"token_var": var, "_skipped": "not set"}
            )
            continue
        works, diag = _try_token_against_meta_api(token, var)
        all_diags["candidates"].append(diag)
        if works:
            all_diags["winner"] = var
            return token, var, all_diags

    all_diags["winner"] = None
    return None, None, all_diags


def pull_base_schema(token: str) -> dict:
    """Pull and inspect the full base schema."""
    print(f"\n=== Step 2: base schema (Meta API) ===")
    status, _, body = _request(
        f"/v0/meta/bases/{TARGET_BASE_ID}/tables", token
    )
    if status != 200:
        print(f"HARD STOP: Meta API returned HTTP {status}")
        return {"_error": body, "_status": status}

    tables = body.get("tables", [])
    print(f"  base {TARGET_BASE_ID}: {len(tables)} tables total")

    # Per-table summary
    table_summaries: list[dict[str, Any]] = []
    for t in tables:
        tid = t.get("id")
        is_target = tid in TARGET_TABLES
        marker = "★" if is_target else " "
        fields = t.get("fields", [])
        types_seen = sorted({f.get("type", "?") for f in fields})
        # Incremental-key candidates
        ts_fields = [
            f for f in fields
            if f.get("type") in {"lastModifiedTime", "createdTime", "autoNumber"}
        ]
        print(
            f"  {marker} {tid}  '{t.get('name')}'  "
            f"fields={len(fields)} types={','.join(types_seen)[:80]}"
        )
        if is_target:
            print(f"      primaryFieldId: {t.get('primaryFieldId')!r}")
            print(f"      timestamp-shaped fields ({len(ts_fields)}):")
            for f in ts_fields:
                print(f"        - {f.get('name')!r} ({f.get('type')}) id={f.get('id')}")
            if not ts_fields:
                print("        (none — incremental will need record-level createdTime metadata)")
        table_summaries.append({
            "id": tid,
            "name": t.get("name"),
            "field_count": len(fields),
            "primary_field_id": t.get("primaryFieldId"),
            "timestamp_field_candidates": [
                {"id": f.get("id"), "name": f.get("name"), "type": f.get("type")}
                for f in ts_fields
            ],
            "is_target_table": is_target,
        })

    return {
        "raw_response": body,
        "summary": {
            "total_tables_in_base": len(tables),
            "target_tables_found": sum(
                1 for t in tables if t.get("id") in TARGET_TABLES
            ),
            "table_list": table_summaries,
        },
    }


def pull_records_per_table(token: str) -> dict[str, dict]:
    """Pull 3 records from each target table. Empty fields are omitted by
    the API — cross-reference Meta API for the complete field set."""
    print(f"\n=== Step 3: record samples (3 per table) ===")
    samples: dict[str, dict[str, Any]] = {}
    for table_id, label in TARGET_TABLES.items():
        print(f"  GET {label} ({table_id}) ...")
        status, _, body = _request(
            f"/v0/{TARGET_BASE_ID}/{table_id}",
            token,
            params={"pageSize": "3"},
        )
        if status != 200:
            print(f"    HTTP {status} — {body}")
            samples[table_id] = {
                "_status": status, "_error": body, "_label": label
            }
            continue
        records = body.get("records", [])
        print(f"    → {len(records)} records returned")

        # Field presence counter — which fields appeared in ANY of the 3 records
        fields_present: set[str] = set()
        for r in records:
            fields_present.update((r.get("fields") or {}).keys())
        print(f"    → {len(fields_present)} distinct fields present in sample")

        samples[table_id] = {
            "label": label,
            "raw_response": body,
            "fields_present_in_sample": sorted(fields_present),
            "record_count": len(records),
        }
    return samples


def list_webhooks(token: str) -> dict:
    """Optional probe — confirms the webhook pull model docs. May 403 if
    webhook:manage scope isn't granted; that's not a problem for the
    discovery, just a note for the future ingestion spec."""
    print(f"\n=== Step 4: webhook list (optional; webhook:manage scope) ===")
    status, _, body = _request(
        f"/v0/bases/{TARGET_BASE_ID}/webhooks", token
    )
    print(f"  HTTP {status}")
    if status == 200:
        webhooks = body.get("webhooks", []) if isinstance(body, dict) else []
        print(f"  → {len(webhooks)} existing webhooks on this base")
        for w in webhooks:
            print(
                f"    id={w.get('id')} "
                f"enabled={w.get('isHookEnabled')} "
                f"notifications={w.get('areNotificationsEnabled')} "
                f"notificationUrl={w.get('notificationUrl', '<none>')[:60]}"
            )
    elif status == 403:
        print("  → 403: webhook:manage scope not granted on this PAT")
        print("    (not a blocker for record/schema reads; flag for ingestion spec)")
    return {"status": status, "body": body}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    env = _load_env()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    started = datetime.now(timezone.utc).isoformat()

    out: dict[str, Any] = {
        "started_utc": started,
        "target_base_id": TARGET_BASE_ID,
        "target_tables": TARGET_TABLES,
    }

    token, token_var, auth_diag = auth_and_scope_check(env)
    out["auth"] = auth_diag

    if token is None:
        out["_halt_reason"] = (
            "no candidate PAT reached the target base with schema.bases:read"
        )
        _save("probe.json", out)
        print("\nHARD STOP: no PAT works against this base. Drake mints a PAT")
        print(f"  scoped to base {TARGET_BASE_ID} with:")
        print(f"    - schema.bases:read")
        print(f"    - data.records:read")
        print(f"  (and optionally webhook:manage for the future ingestion spec).")
        print(f"\nProbe artifacts: .probe-out/airtable/probe.json")
        return 2

    print(f"\nWINNER: {token_var}")

    schema_out = pull_base_schema(token)
    out["schema"] = schema_out
    if schema_out.get("_error"):
        out["_halt_reason"] = "schema pull failed despite winning token"
        _save("probe.json", out)
        return 2

    record_samples = pull_records_per_table(token)
    out["record_samples"] = record_samples

    webhooks = list_webhooks(token)
    out["webhooks"] = webhooks

    p = _save("probe.json", out)
    print(f"\nProbe artifacts: {p.relative_to(REPO_ROOT)}")
    print(f"  + schema details on stdout above")
    return 0


if __name__ == "__main__":
    sys.exit(main())
