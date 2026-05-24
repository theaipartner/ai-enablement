"""Read-only discovery probe against the Wistia Data + Stats API.

Throwaway investigation per docs/specs/wistia-discovery.md. NEVER writes
to Wistia, NEVER writes to Supabase. Reads WISTIA_API_TOKEN from
.env.local at the repo root.

Run from the repo root:

    python3 scripts/explore_wistia_api.py

Outputs land under .probe-out/wistia/ (git-ignored — added via the
existing .probe-out/ rule) so the findings report can fold raw JSON
in by reference rather than re-running the probe.

Why a flat script (vs an ingestion/wistia/ module): same reason as the
Close discovery probes — the spec is explicit that ingestion shape is
unknown and seeding it now pre-commits a design.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlencode


REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = REPO_ROOT / ".env.local"
OUT_DIR = REPO_ROOT / ".probe-out" / "wistia"

# Wistia API has two host paths:
#   v1   — the long-standing Data API
#   modern — newer endpoints (e.g. /modern/stats/medias/{id}/by_date)
BASE_V1 = "https://api.wistia.com/v1"
BASE_MODERN = "https://api.wistia.com/modern"

# Name keywords the spec gave Drake's best-guess on. Substring matching;
# probe surfaces the closest candidates so Drake confirms.
VSL_NAME_HINTS = ("sell ai services", "vsl")
TYP_PROJECT_HINTS = ("confirmation page", "thank you", "thank-you", "typ")

# Per-day stats window for the viability probe.
BY_DATE_WINDOW_DAYS = 14


def load_token() -> str:
    if not ENV_PATH.exists():
        raise SystemExit(f"HARD STOP: {ENV_PATH} not found")
    for raw in ENV_PATH.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        if k.strip() == "WISTIA_API_TOKEN":
            val = v.strip().strip("'").strip('"')
            if not val:
                raise SystemExit(
                    "HARD STOP: WISTIA_API_TOKEN is empty in .env.local. "
                    "Token page is Account-Owner-only — Nabeel may need "
                    "to mint one with 'Read detailed stats' permission."
                )
            return val
    raise SystemExit(
        "HARD STOP: WISTIA_API_TOKEN not present in .env.local"
    )


def _request(
    path: str,
    token: str,
    *,
    base: str = BASE_V1,
    params: dict[str, Any] | None = None,
    extra_headers: dict[str, str] | None = None,
    timeout: float = 30.0,
) -> dict[str, Any] | list[Any]:
    url = f"{base}{path}"
    if params:
        url = f"{url}?{urlencode(params)}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }
    if extra_headers:
        headers.update(extra_headers)

    for attempt in range(3):
        req = urllib.request.Request(url, method="GET", headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read().decode()
                return json.loads(body) if body else {}
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise SystemExit(
                    f"HARD STOP: {e.code} on GET {path}. "
                    f"Token page is Account-Owner-only — Nabeel may need to "
                    f"regenerate WISTIA_API_TOKEN with 'Read detailed stats' "
                    f"permission. Body: {e.read().decode()[:500]}"
                )
            if e.code == 503 and attempt < 2:
                # Wistia returns 503 (not 429) on rate-limit. No Retry-After.
                wait_s = 5 * (attempt + 1)
                print(f"  [503] back off {wait_s}s (attempt {attempt + 1})")
                time.sleep(wait_s)
                continue
            err_body = ""
            try:
                err_body = e.read().decode()[:1000]
            except Exception:
                pass
            raise RuntimeError(
                f"HTTP {e.code} on GET {url}: {err_body}"
            ) from e
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < 2:
                print(f"  [timeout/network] retry {attempt + 1}: {e}")
                time.sleep(2 + attempt * 2)
                continue
            raise RuntimeError(f"Network: {e}") from e
    raise RuntimeError(f"Exhausted retries on {path}")


def _write_json(name: str, payload: Any) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    p = OUT_DIR / name
    p.write_text(json.dumps(payload, indent=2, sort_keys=True, default=str))
    return p


def paginate_medias(token: str) -> list[dict[str, Any]]:
    """Walk /v1/medias.json — page until empty page returned."""
    results: list[dict[str, Any]] = []
    page = 1
    while True:
        chunk = _request("/medias.json", token, params={"page": page, "per_page": 100})
        if not isinstance(chunk, list):
            print(f"  WARN: unexpected non-list response on page {page}: {type(chunk).__name__}")
            break
        if not chunk:
            break
        results.extend(chunk)
        page += 1
        if page > 50:
            print(f"  WARN: safety break at page {page} (>5000 medias) — investigate")
            break
    return results


def paginate_projects(token: str) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    page = 1
    while True:
        chunk = _request("/projects.json", token, params={"page": page, "per_page": 100})
        if not isinstance(chunk, list) or not chunk:
            break
        results.extend(chunk)
        page += 1
        if page > 20:
            break
    return results


def main() -> int:
    print("=" * 70)
    print("Wistia discovery probe — read-only")
    print("=" * 70)
    token = load_token()
    print(f"Loaded WISTIA_API_TOKEN (len={len(token)}) from {ENV_PATH}")

    # ---- 1. Auth check via cheap call -------------------------------------
    print("\n[1] Auth check — GET /medias.json?per_page=1")
    probe = _request("/medias.json", token, params={"per_page": 1})
    if not isinstance(probe, list):
        print(f"  WARN: unexpected shape: {type(probe).__name__}")
    else:
        print(f"  OK — got {len(probe)} media row")
        if probe:
            sample = probe[0]
            print(f"  sample keys: {sorted(sample.keys())}")
            print(f"  sample: hashed_id={sample.get('hashed_id')!r} name={sample.get('name')!r}")

    # ---- 2. Full media inventory ------------------------------------------
    print("\n[2] Full media inventory — paginate /medias.json")
    medias = paginate_medias(token)
    _write_json("01_medias_full.json", medias)
    print(f"  total medias: {len(medias)}")
    type_counts: dict[str, int] = {}
    for m in medias:
        t = m.get("type", "<none>")
        type_counts[t] = type_counts.get(t, 0) + 1
    print(f"  type breakdown: {type_counts}")

    compact = [
        {
            "hashed_id": m.get("hashed_id"),
            "name": m.get("name"),
            "type": m.get("type"),
            "duration_seconds": m.get("duration"),
            "project_id": (m.get("project") or {}).get("id"),
            "project_name": (m.get("project") or {}).get("name"),
            "created": m.get("created"),
            "updated": m.get("updated"),
        }
        for m in medias
    ]
    _write_json("02_medias_compact.json", compact)

    # ---- 3. Projects ------------------------------------------------------
    print("\n[3] Projects — GET /projects.json")
    projects = paginate_projects(token)
    _write_json("03_projects_full.json", projects)
    print(f"  total projects: {len(projects)}")
    for p in projects:
        name = p.get("name") or "<?>"
        print(f"    - {p.get('id'):>10}  {name}  (medias={p.get('mediaCount', '?')})")

    # ---- 4. Locate VSL + TYP candidates ----------------------------------
    print("\n[4] VSL + thank-you candidates")
    vsl_candidates = [
        m for m in medias
        if any(h in (m.get("name") or "").lower() for h in VSL_NAME_HINTS)
    ]
    print(f"  VSL name-match candidates ({len(vsl_candidates)}):")
    for m in vsl_candidates:
        print(f"    - hashed_id={m.get('hashed_id')!r}  name={m.get('name')!r}  "
              f"type={m.get('type')!r}  duration={m.get('duration')}  "
              f"project={(m.get('project') or {}).get('name')!r}")

    typ_projects = [
        p for p in projects
        if any(h in (p.get("name") or "").lower() for h in TYP_PROJECT_HINTS)
    ]
    print(f"\n  Thank-you-related projects ({len(typ_projects)}):")
    typ_project_medias: dict[str, list[dict[str, Any]]] = {}
    for p in typ_projects:
        pname = p.get("name", "")
        pid = p.get("id")
        in_project = [m for m in medias if (m.get("project") or {}).get("id") == pid]
        typ_project_medias[pname] = in_project
        print(f"    - {pid}  {pname}  ({len(in_project)} medias)")
        for m in in_project:
            print(f"        · hashed_id={m.get('hashed_id')!r}  name={m.get('name')!r}  "
                  f"type={m.get('type')!r}  duration={m.get('duration')}")
    _write_json("04_targets.json", {
        "vsl_candidates": vsl_candidates,
        "typ_projects": typ_projects,
        "typ_project_medias": {k: v for k, v in typ_project_medias.items()},
    })

    # Pick the canonical VSL + TYP candidate for the deep stats probes.
    # If multiple, the first match by inventory order — the report will
    # call out all candidates so Drake can confirm.
    vsl_pick = vsl_candidates[0] if vsl_candidates else None
    typ_pick = None
    for pname, in_project in typ_project_medias.items():
        if in_project:
            typ_pick = in_project[0]
            break

    # ---- 5. Lifetime stats — VSL + TYP -----------------------------------
    print("\n[5] Lifetime stats — /v1/medias/{id}/stats.json")
    lifetime: dict[str, Any] = {}
    for label, pick in (("vsl", vsl_pick), ("typ", typ_pick)):
        if not pick:
            print(f"  {label}: skipped (no candidate found)")
            continue
        hid = pick["hashed_id"]
        print(f"  {label}: {pick.get('name')!r} ({hid})")
        try:
            stats = _request(f"/medias/{hid}/stats.json", token)
        except RuntimeError as e:
            stats = {"_error": str(e)}
            print(f"    ERROR: {e}")
        else:
            print(f"    keys: {sorted(stats.keys()) if isinstance(stats, dict) else type(stats).__name__}")
            if isinstance(stats, dict):
                for k, v in stats.items():
                    print(f"      {k}: {v}")
        lifetime[label] = {"pick": pick, "stats": stats}
    _write_json("05_lifetime_stats.json", lifetime)

    # ---- 6. Engagement endpoint (if exists) -------------------------------
    print("\n[6] Engagement endpoint — /v1/medias/{id}/engagement (if exposed)")
    engagement: dict[str, Any] = {}
    for label, pick in (("vsl", vsl_pick), ("typ", typ_pick)):
        if not pick:
            continue
        hid = pick["hashed_id"]
        try:
            eng = _request(f"/medias/{hid}/engagement", token)
        except RuntimeError as e:
            eng = {"_error": str(e)}
            print(f"  {label} ({hid}): ERROR {e}")
            continue
        print(f"  {label} ({hid}): keys = {sorted(eng.keys()) if isinstance(eng, dict) else type(eng).__name__}")
        if isinstance(eng, dict):
            # Engagement responses can be large (per-second arrays). Print
            # top-level + truncated array previews only.
            for k, v in eng.items():
                if isinstance(v, list):
                    print(f"    {k}: list len={len(v)} sample={v[:5]}")
                else:
                    print(f"    {k}: {v}")
        engagement[label] = eng
    _write_json("06_engagement.json", engagement)

    # ---- 7. THE key question: per-day stats via /modern/stats/medias/{id}/by_date
    print(f"\n[7] PER-DAY stats — /modern/stats/medias/{{id}}/by_date "
          f"(last {BY_DATE_WINDOW_DAYS}d)")
    by_date: dict[str, Any] = {}
    end_date = date.today()
    start_date = end_date - timedelta(days=BY_DATE_WINDOW_DAYS - 1)
    for label, pick in (("vsl", vsl_pick), ("typ", typ_pick)):
        if not pick:
            continue
        hid = pick["hashed_id"]
        print(f"  {label}: {hid}  window {start_date} -> {end_date}")
        try:
            daily = _request(
                f"/stats/medias/{hid}/by_date",
                token,
                base=BASE_MODERN,
                params={
                    "start_date": start_date.isoformat(),
                    "end_date": end_date.isoformat(),
                },
                extra_headers={"X-Wistia-API-Version": "2026-03"},
            )
        except RuntimeError as e:
            daily = {"_error": str(e)}
            print(f"    ERROR: {e}")
        else:
            if isinstance(daily, dict):
                print(f"    response keys: {sorted(daily.keys())}")
                # Common shape candidates: 'data', 'stats', list-by-day
                for k in ("data", "stats", "days", "by_date"):
                    if k in daily:
                        v = daily[k]
                        if isinstance(v, list) and v:
                            print(f"    {k!r}: list of {len(v)} entries; sample[0] keys={sorted(v[0].keys()) if isinstance(v[0], dict) else type(v[0]).__name__}")
                            print(f"      first entry: {json.dumps(v[0], indent=2)[:500]}")
                            print(f"      last entry: {json.dumps(v[-1], indent=2)[:500]}")
            elif isinstance(daily, list):
                print(f"    list len={len(daily)}")
                if daily:
                    print(f"      first: {json.dumps(daily[0], indent=2)[:500]}")
                    print(f"      last:  {json.dumps(daily[-1], indent=2)[:500]}")
            else:
                print(f"    unexpected shape: {type(daily).__name__}")
        by_date[label] = {
            "pick": pick,
            "window": {"start_date": start_date.isoformat(), "end_date": end_date.isoformat()},
            "response": daily,
        }
    _write_json("07_by_date.json", by_date)

    print("\n" + "=" * 70)
    print(f"Done. Outputs under: {OUT_DIR}")
    print("=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())
