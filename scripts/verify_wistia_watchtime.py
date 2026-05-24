"""Verification probe for Wistia per-day watch-time.

Spec: docs/specs/wistia-watchtime-verify.md.

Question to answer definitively: is hours_watched on Wistia's
/modern/stats/medias/{id}/by_date endpoint a TRUE per-day figure, or a
synthesized value smeared across days? And: does a true-daily source
exist anywhere in the Wistia API?

Read-only. No writes to Wistia. No writes to Supabase.

Run from the repo root:

    python3 scripts/verify_wistia_watchtime.py

Outputs to .probe-out/wistia-verify/ (git-ignored via .probe-out/).
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
OUT_DIR = REPO_ROOT / ".probe-out" / "wistia-verify"

BASE_V1 = "https://api.wistia.com/v1"
BASE_MODERN = "https://api.wistia.com/modern"
API_VERSION = "2026-03"

# High-traffic VSL surfaced in discovery + shipped backfill (Direct
# Closer Funnel variant; the dominant of the two active VSLs).
PROBE_MEDIA = "i1173gx76b"
PROBE_MEDIA_NAME = "VSL Vídeo Motion - Nabeel (Horizontal) Direct Closer Funnel"


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
                raise SystemExit("HARD STOP: WISTIA_API_TOKEN empty in .env.local")
            return val
    raise SystemExit("HARD STOP: WISTIA_API_TOKEN not in .env.local")


def _request(
    path: str,
    token: str,
    *,
    base: str = BASE_V1,
    params: dict[str, Any] | None = None,
    extra_headers: dict[str, str] | None = None,
) -> Any:
    url = f"{base}{path}"
    if params:
        url = f"{url}?{urlencode(params)}"
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if extra_headers:
        headers.update(extra_headers)
    for attempt in range(3):
        req = urllib.request.Request(url, method="GET", headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise SystemExit(
                    f"HARD STOP: {e.code} on {path}. Body: {e.read().decode()[:500]}"
                )
            if e.code == 503 and attempt < 2:
                wait = 5 * (attempt + 1)
                print(f"  [503] back off {wait}s")
                time.sleep(wait)
                continue
            body = ""
            try:
                body = e.read().decode()[:1000]
            except Exception:
                pass
            return {"_http_error": e.code, "_body": body, "_path": path}
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < 2:
                time.sleep(2 + attempt * 2)
                continue
            return {"_error": str(e), "_path": path}
    return {"_error": "exhausted retries", "_path": path}


def _write_json(name: str, payload: Any) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    p = OUT_DIR / name
    p.write_text(json.dumps(payload, indent=2, sort_keys=True, default=str))
    return p


def main() -> int:
    print("=" * 70)
    print("Wistia by_date watch-time verification probe (read-only)")
    print(f"Probe media: {PROBE_MEDIA}  '{PROBE_MEDIA_NAME}'")
    print("=" * 70)
    token = load_token()
    today = date.today()

    # ------------------------------------------------------------------
    # STEP 1 — Ratio constancy across 30 days on legacy by_date endpoint
    # ------------------------------------------------------------------
    print("\n[1] Ratio constancy: pull 30-day by_date on probe media")
    print("    expect hours_watched / play_count flat to 6+ decimals if artifact")
    end = today
    start = today - timedelta(days=29)
    daily_30 = _request(
        f"/stats/medias/{PROBE_MEDIA}/by_date",
        token,
        base=BASE_MODERN,
        params={"start_date": start.isoformat(), "end_date": end.isoformat()},
        extra_headers={"X-Wistia-API-Version": API_VERSION},
    )
    _write_json("01_by_date_30d.json", daily_30)
    if not isinstance(daily_30, list):
        print(f"    ERROR: {daily_30}")
        return 2
    print(f"\n    {'date':12} {'plays':>8} {'hours':>14} {'h/p ratio':>16} {'sec/play':>10}")
    ratios: list[float] = []
    for entry in daily_30:
        d = entry.get("date")
        pc = entry.get("play_count") or 0
        hw = entry.get("hours_watched") or 0
        if pc > 0:
            ratio = hw / pc
            sec_per_play = ratio * 3600
            ratios.append(ratio)
            print(f"    {d:12} {pc:8d} {hw:14.10f} {ratio:16.10f} {sec_per_play:10.4f}")
        else:
            print(f"    {d:12} {pc:8d} {hw:14.10f} {'(no plays)':>16} {'-':>10}")
    if ratios:
        distinct = sorted(set(round(r, 10) for r in ratios))
        print(f"\n    Distinct ratio values (10dp): {len(distinct)}  values={distinct}")
        if len(distinct) <= 2:
            print(f"    >>> ARTIFACT CONFIRMED: ratio is constant across {len(ratios)} active days")
        else:
            print(f"    >>> Ratio VARIES across days — by_date is real per-day")

    # ------------------------------------------------------------------
    # STEP 2 — Window dependence: same single day via 1d, 14d, 90d
    # ------------------------------------------------------------------
    print("\n[2] Window dependence: fetch a single recent day via 3 windows")
    # Pick a day ~7 days ago (likely to have plays + outside the most-
    # recent 14d boundary effect)
    target_day = today - timedelta(days=7)
    print(f"    target day: {target_day}")
    windows = {
        "1d": (target_day, target_day),
        "14d": (target_day - timedelta(days=6), target_day + timedelta(days=6)),
        "90d": (target_day - timedelta(days=45), target_day + timedelta(days=44)),
    }
    window_results: dict[str, Any] = {}
    print(f"\n    {'window':>6} {'start':12} {'end':12} {'plays':>8} {'hours':>14} {'h/p':>16}")
    for label, (s, e) in windows.items():
        resp = _request(
            f"/stats/medias/{PROBE_MEDIA}/by_date",
            token,
            base=BASE_MODERN,
            params={"start_date": s.isoformat(), "end_date": e.isoformat()},
            extra_headers={"X-Wistia-API-Version": API_VERSION},
        )
        target_entry = None
        if isinstance(resp, list):
            for entry in resp:
                if entry.get("date") == target_day.isoformat():
                    target_entry = entry
                    break
        if target_entry:
            pc = target_entry.get("play_count") or 0
            hw = target_entry.get("hours_watched") or 0
            ratio = (hw / pc) if pc > 0 else None
            print(f"    {label:>6} {s.isoformat():12} {e.isoformat():12} "
                  f"{pc:8d} {hw:14.10f} {(ratio if ratio is not None else '-'):16}")
            window_results[label] = {
                "window_start": s.isoformat(),
                "window_end": e.isoformat(),
                "target_day_entry": target_entry,
            }
        else:
            print(f"    {label:>6}  target day not found in response")
            window_results[label] = {"window_start": s.isoformat(),
                                     "window_end": e.isoformat(),
                                     "target_day_entry": None,
                                     "raw_response_excerpt": str(resp)[:200]}
    _write_json("02_window_dependence.json", {
        "target_day": target_day.isoformat(),
        "windows": window_results,
    })

    # ------------------------------------------------------------------
    # STEP 3 — Lifetime cross-check
    # ------------------------------------------------------------------
    print("\n[3] Lifetime cross-check vs the flat per-day ratio")
    lifetime = _request(f"/medias/{PROBE_MEDIA}/stats.json", token)
    media_inv = _request(f"/medias/{PROBE_MEDIA}.json", token)
    _write_json("03_lifetime_and_inventory.json", {
        "lifetime_stats": lifetime,
        "media": media_inv,
    })
    duration_s = (media_inv or {}).get("duration")
    avg_pct = ((lifetime or {}).get("stats") or {}).get("averagePercentWatched")
    if duration_s and avg_pct is not None:
        lifetime_avg_seconds = (avg_pct / 100.0) * duration_s
        print(f"    duration:               {duration_s}s")
        print(f"    lifetime avgPctWatched: {avg_pct}%")
        print(f"    lifetime avg-seconds:   {lifetime_avg_seconds:.4f}s")
        if ratios:
            flat_sec_per_play = ratios[0] * 3600
            diff = abs(flat_sec_per_play - lifetime_avg_seconds)
            pct_diff = (diff / lifetime_avg_seconds) * 100 if lifetime_avg_seconds else 0
            print(f"    by_date flat sec/play:  {flat_sec_per_play:.4f}s")
            print(f"    diff:                   {diff:.4f}s  ({pct_diff:.2f}%)")
            if pct_diff < 5:
                print(f"    >>> MATCH: by_date hours_watched is back-computed from lifetime average")
            else:
                print(f"    >>> DIVERGE: by_date may use a different (windowed) average")

    # ------------------------------------------------------------------
    # STEP 4 — Hunt for true-daily source: the NEW /modern/analytics/ timeseries endpoint
    # ------------------------------------------------------------------
    print("\n[4] NEW endpoint test: /modern/analytics/medias/{id}/timeseries?granularity=daily")
    # Docs say end_date is EXCLUSIVE on this newer endpoint (vs by_date
    # which is inclusive on both). Use today+1 to include today.
    start = today - timedelta(days=29)
    end_exclusive = today + timedelta(days=1)
    timeseries = _request(
        f"/analytics/medias/{PROBE_MEDIA}/timeseries",
        token,
        base=BASE_MODERN,
        params={
            "start_date": start.isoformat(),
            "end_date": end_exclusive.isoformat(),
            "granularity": "daily",
        },
        extra_headers={"X-Wistia-API-Version": API_VERSION},
    )
    _write_json("04_timeseries_30d.json", timeseries)
    print(f"    response top-level type: {type(timeseries).__name__}")
    if isinstance(timeseries, dict):
        print(f"    response keys: {sorted(timeseries.keys())[:15]}")
        # Some endpoints wrap in {data: [...]} or similar
        data = timeseries.get("data") or timeseries.get("timeseries") or timeseries.get("buckets")
        if isinstance(data, list):
            print(f"    inner list len: {len(data)}")
            if data:
                print(f"    sample bucket keys: {sorted(data[0].keys()) if isinstance(data[0], dict) else type(data[0]).__name__}")
                print(f"    first 3 buckets:")
                for b in data[:3]:
                    print(f"      {json.dumps(b)[:200]}")
        elif "_http_error" in timeseries:
            print(f"    HTTP {timeseries['_http_error']}: {timeseries.get('_body', '')[:300]}")
    elif isinstance(timeseries, list):
        print(f"    list len: {len(timeseries)}")
        if timeseries:
            print(f"    sample bucket keys: {sorted(timeseries[0].keys()) if isinstance(timeseries[0], dict) else type(timeseries[0]).__name__}")
            print(f"    first 5 active days:")
            active = [b for b in timeseries if (b.get('plays') or 0) > 0][:5]
            for b in active:
                print(f"      {json.dumps(b)[:250]}")
            # Compute per-day engagement variance to confirm it's not flat
            engagements = [b.get('engagement_rate') for b in timeseries if b.get('engagement_rate') is not None]
            played_times = [b.get('played_time') for b in timeseries if b.get('played_time') is not None]
            if len(engagements) > 1:
                distinct = sorted(set(round(e, 6) for e in engagements))
                print(f"\n    Engagement rate values across {len(engagements)} buckets:")
                print(f"      distinct (6dp): {len(distinct)} — min={min(distinct):.6f} max={max(distinct):.6f}")
                if len(distinct) > 3:
                    print(f"      >>> VARIES — true per-day engagement available")
                else:
                    print(f"      >>> Suspiciously flat — may also be an artifact")
            if len(played_times) > 1:
                distinct_pt = sorted(set(played_times))
                print(f"    played_time values across {len(played_times)} buckets:")
                print(f"      distinct: {len(distinct_pt)} — min={min(distinct_pt)} max={max(distinct_pt)}")

    # ------------------------------------------------------------------
    # STEP 5 — NEW endpoint: aggregate analytics (single number over range)
    # ------------------------------------------------------------------
    print("\n[5] NEW endpoint test: /modern/analytics/medias/{id} (aggregate over range)")
    agg = _request(
        f"/analytics/medias/{PROBE_MEDIA}",
        token,
        base=BASE_MODERN,
        params={
            "start_date": start.isoformat(),
            "end_date": end_exclusive.isoformat(),
        },
        extra_headers={"X-Wistia-API-Version": API_VERSION},
    )
    _write_json("05_aggregate_30d.json", agg)
    if isinstance(agg, dict):
        print(f"    keys: {sorted(agg.keys())}")
        for k in ("engagement_rate", "play_rate", "plays", "unique_plays",
                  "played_time", "unique_visitors", "unique_loads"):
            if k in agg:
                print(f"      {k}: {agg[k]}")
        if "_http_error" in agg:
            print(f"    HTTP {agg['_http_error']}: {agg.get('_body', '')[:300]}")

    # ------------------------------------------------------------------
    # STEP 6 — Cross-check timeseries vs by_date for the SAME days
    # ------------------------------------------------------------------
    print("\n[6] Side-by-side compare: by_date vs timeseries on same days")
    if isinstance(timeseries, list) and isinstance(daily_30, list):
        by_date_lookup = {e["date"]: e for e in daily_30 if e.get("date")}
        print(f"\n    {'date':12} | by_date: {'plays':>6} {'hours':>10} {'sec/play':>10} "
              f"| timeseries: {'plays':>6} {'played_time':>12} {'engagement':>11}")
        for b in timeseries:
            ts = b.get("timestamp", "")
            day_key = ts[:10] if ts else ""
            bd = by_date_lookup.get(day_key)
            bd_plays = bd.get("play_count", 0) if bd else None
            bd_hours = bd.get("hours_watched", 0) if bd else None
            bd_secpp = (bd_hours / bd_plays * 3600) if bd and bd_plays else None
            ts_plays = b.get("plays")
            ts_pt = b.get("played_time")
            ts_er = b.get("engagement_rate")
            if ts_plays and ts_plays > 0:
                print(f"    {day_key:12} | "
                      f"{bd_plays if bd_plays is not None else '-':>6} "
                      f"{bd_hours if bd_hours is not None else '-':>10} "
                      f"{(bd_secpp if bd_secpp is not None else '-'):>10} | "
                      f"{ts_plays:>6} {ts_pt if ts_pt is not None else '-':>12} "
                      f"{(round(ts_er, 4) if ts_er is not None else '-'):>11}")

    print("\n" + "=" * 70)
    print(f"Done. Outputs under: {OUT_DIR}")
    print("=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())
